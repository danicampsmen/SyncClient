/**
 * CoreSyncLogic - Módulo Universal de Lógica de Sincronización
 * Extrae y centraliza las reglas de negocio, algoritmos y heurísticas
 * compartidas entre Ubuntu Linux (Node.js/Backend) y Android (Capacitor/Nativo).
 * Principio DRY (Don't Repeat Yourself).
 */

import { VectorClockManager, VectorClock } from './VectorClock';

export interface NumberedFileInfo {
  isNumbered: boolean;
  baseName: string;
  version: number;
  extension: string;
}

export interface FileGroupItem {
  name: string;
  mtime: number;
  version?: number;
}

// --- Constantes centralizadas de rutas (evitan hardcoded paths dispersos) ---
/** Nombre base de la carpeta local de apuntes sincronizados */
export const DEFAULT_LOCAL_DIR_NAME = 'Apuntes_Tablet_StarNote';
/** Ruta remota por defecto en Google Drive */
export const DEFAULT_REMOTE_PATH = 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote';
/** Ruta base de StarNote en Android */
export const ANDROID_STARNOTE_BASE = '/storage/emulated/0/Documents/StarNote';
/** Subcarpeta de exportación de StarNote en Android */
export const ANDROID_STARNOTE_EXPORT = '/storage/emulated/0/Documents/StarNote/export';

export interface RemoteEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  md5Checksum?: string;
  etag?: string;
  appProperties?: Record<string, string>;
}

export interface SyncPlan {
  uploads: Array<{
    localPath: string;
    remoteName: string;
    remoteId?: string;
    vectorClock: string;
  }>;
  downloads: Array<{
    remoteFile: RemoteEntry;
    localPath: string;
    vectorClock: string;
  }>;
  deleteLocal: Array<{
    localPath: string;
    remoteId?: string;
  }>;
  deleteRemote: Array<{
    remoteId: string;
    localPath: string; // <-- AÑADIDO: Permite mostrar el nombre real en la interfaz
  }>;
  conflicts: Array<{
    localPath: string;
    remoteFile: RemoteEntry;
    localVc: string;
    remoteVc: string;
    localHash?: string | null;
    remoteHash?: string | null;
    baseHash?: string | null;
    reason?: 'both_modified' | 'delete_vs_modify';
  }>;
}

export interface SyncStateSnapshot {
  localMtime: number;
  remoteMtime: number;
  remoteId: string;
  fileSize: number | null;
  baseHash?: string | null;
  vectorClock?: string | null;
  rawName?: string; // The exact string from disk (NFD etc)
  isTombstone?: boolean; // <-- AÑADIDO: Flag para identificar archivos borrados en Drive
}

export class CoreSyncLogic {
  /**
   * Patrones de exclusión por defecto para archivos temporales, ocultos y bloqueos de edición
   * (StarNote en Android, LaTeX/LibreOffice en Linux).
   */
  public static readonly DEFAULT_IGNORE_PATTERNS: string[] = [
    '*.tmp',
    '*.temp',
    '*.syncclient-download-*',
    '*.syncclient-tmp-*',
    '.*',
    '~*',
    '*~',
    '*.lock',
    '*.swp',
    '*.aux',
    '*.log',
    '*.out',
    '.*-SAVE-ERROR*',
    '*.toc',
    '*.synctex.gz',
    '*.synctex(busy)',
    '*.run.xml',
    '*.bcf*',
    '*.bbl*',
    '*.blg',
    '*.ind',
    '*.ilg',
    '*.idx',
    'auto',
    '*.minted',
    '_minted-*',
    '*.snm',
    '*.nav',
    '*.cwl',
    '*.conflict*',
    '__MACOSX',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '*.pyc',
    '__pycache__',
    '*.pyi',
    '.ttxfolder',
    '.venv',
    'venv',
    'env'
  ];

  /**
   * Comprueba si un nombre de archivo coincide con algún patrón de exclusión
   */
  public static matchesIgnorePattern(name: string, patterns: string[] = CoreSyncLogic.DEFAULT_IGNORE_PATTERNS): boolean {
    if (!name) return false;
    // Si la lista no contiene patrones, usar defaults
    const activePatterns = patterns.length > 0 ? patterns : CoreSyncLogic.DEFAULT_IGNORE_PATTERNS;

    for (const pattern of activePatterns) {
      if (!pattern) continue;
      if (pattern.startsWith('*.') && pattern.indexOf('*', 2) === -1) {
        const ext = pattern.slice(1).toLowerCase();
        if (name.toLowerCase().endsWith(ext)) return true;
      } else if (pattern.startsWith('.*') && name.startsWith('.')) {
        return true;
      } else if (pattern.startsWith('~') && name.startsWith('~')) {
        return true;
      } else {
        try {
          // Reemplazar comodines '*' por regex '.*' con escape del punto
          const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
          const regex = new RegExp(regexStr, 'i');
          if (regex.test(name)) return true;
        } catch {
          if (name.toLowerCase() === pattern.toLowerCase()) return true;
        }
      }
    }
    return false;
  }

  /**
   * Temporizador de estabilización de escritura (Settle Timer / Debounce Buffer).
   * Determina si un archivo ha terminado de guardarse antes de iniciar su transmisión por red.
   */
  public static isReadyForSync(mtimeMs: number, bufferMs: number = 2000, now?: number): boolean {
    if (!mtimeMs || mtimeMs <= 0) return true;
    const currentTime = now || Date.now();
    return Math.abs(currentTime - mtimeMs) >= bufferMs;
  }

  /**
   * Extrae información de numeración de archivos duplicados automáticos como "rotman(8).pdf".
   */
  public static parseNumberedFilename(filename: string): NumberedFileInfo {
    const numberedMatch = filename.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
    if (numberedMatch) {
      const baseName = `${numberedMatch[1].trim()}.${numberedMatch[3]}`;
      const version = parseInt(numberedMatch[2], 10);
      return { isNumbered: true, baseName, version, extension: numberedMatch[3] };
    }
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex !== -1 ? filename.slice(dotIndex + 1) : '';
    return { isNumbered: false, baseName: filename, version: 0, extension: ext };
  }

  /**
   * Agrupa archivos duplicados por nombre base y devuelve al "ganador" en la posición 0.
   */
  public static groupAndSortDuplicates<T extends FileGroupItem>(files: T[]): Map<string, Array<T & { version: number; baseName: string }>> {
    const groups = new Map<string, Array<T & { version: number; baseName: string }>>();

    for (const file of files) {
      const parsed = CoreSyncLogic.parseNumberedFilename(file.name);
      const enriched = { ...file, version: parsed.version, baseName: parsed.baseName };
      if (!groups.has(parsed.baseName)) {
        groups.set(parsed.baseName, []);
      }
      groups.get(parsed.baseName)!.push(enriched);
    }

    for (const [_, versions] of groups.entries()) {
      versions.sort((a, b) => {
        const timeDiff = b.mtime - a.mtime;
        if (timeDiff !== 0) return timeDiff;
        return b.version - a.version;
      });
    }

    return groups;
  }

  /**
   * Estandariza rutas de Drive a la jerarquía oficial.
   */
  public static normalizeRemotePath(remotePath: string | undefined): string {
    if (!remotePath) {
      return DEFAULT_REMOTE_PATH;
    }
    let norm = remotePath.replace(/^(RemoteServer|Drive):/, 'GoogleDrive:');
    if (!norm.startsWith('GoogleDrive:')) {
      norm = 'GoogleDrive:' + (norm.startsWith('/') ? norm : '/' + norm);
    }
    if (norm.includes('Documentos-Ubuntu') && !norm.includes('Documentos-Ubuntu-Fayfer')) {
      norm = norm.replace('Documentos-Ubuntu', 'Documentos-Ubuntu-Fayfer');
    }
    if (norm.includes('Apuntes en pdf - tablet')) {
      norm = DEFAULT_REMOTE_PATH;
    }
    return norm;
  }

  /**
   * THREE-WAY MERGE: Computa el plan de sincronización comparando Local vs Remote vs DB.
   * FUNCIÓN PURA: sin I/O, sin DB, sin Drive. 100% testeable.
   */
  public static computeSyncPlan(
    localSnapshot: Map<string, { name: string; mtime: number; size: number; hash?: string | null; rawName?: string }>,
    remoteSnapshot: Map<string, RemoteEntry>,
    dbState: ReadonlyMap<string, SyncStateSnapshot>,
    deviceId: string
  ): SyncPlan {
    const plan: SyncPlan = {
      uploads: [],
      downloads: [],
      deleteLocal: [],
      deleteRemote: [],
      conflicts: []
    };

    // Índice case-sensitive para Drive (conservar casing exacto)
    const remoteByName = new Map<string, RemoteEntry>();
    for (const [_, entry] of remoteSnapshot) {
      remoteByName.set(entry.name, entry);
    }

    // Índice case-insensitive para local
    const localByLowerName = new Map<string, { name: string; mtime: number; size: number; hash?: string | null; rawName?: string }>();
    for (const [relPath, entry] of localSnapshot) {
      localByLowerName.set(entry.name.toLowerCase(), entry);
    }

    const processedRemotes = new Set<string>();
    const parseClock = (clock: string | null | undefined): VectorClock =>
      VectorClockManager.fromString(clock || '{}');
    const remoteClock = (entry: RemoteEntry, fallback: VectorClock): VectorClock =>
      VectorClockManager.fromAppProperties(entry.appProperties || {}) || fallback;

    // 1. Procesar archivos locales (Cambios locales o conflictos)
    for (const [relPath, localEntry] of localSnapshot) {
      const dbEntry = dbState.get(relPath);
      const remoteEntry = remoteByName.get(localEntry.name);

      if (remoteEntry) processedRemotes.add(localEntry.name);

      if (!dbEntry) {
        if (remoteEntry) {
          // Archivo nuevo localmente pero ya existe remotamente — subir preservando el remoteId
          plan.uploads.push({
            localPath: localEntry.rawName || relPath,
            remoteName: localEntry.name,
            remoteId: remoteEntry.id,
            vectorClock: JSON.stringify({ [deviceId]: 1 })
          });
        } else {
          // Nuevo archivo local — subir sin remoteId
          plan.uploads.push({
            localPath: localEntry.rawName || relPath,
            remoteName: localEntry.name,
            remoteId: undefined,
            vectorClock: JSON.stringify({ [deviceId]: 1 })
          });
        }
        continue;
      }

      // Archivo ya conocido — ¿cambió localmente?
      const mtimeChanged = Math.abs(localEntry.mtime - dbEntry.localMtime) > 3000;
      const sizeChanged = dbEntry.fileSize !== null && localEntry.size !== dbEntry.fileSize;
      const localHashChanged = localEntry.hash != null && dbEntry.baseHash != null
        && localEntry.hash.toLowerCase() !== dbEntry.baseHash.toLowerCase();
      const localChanged = localHashChanged || mtimeChanged || sizeChanged;

      if (!localChanged) {
        // Si no cambió local, revisamos si cambió remoto
        if (remoteEntry) {
          const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
          const remoteHashChanged = remoteEntry.md5Checksum != null && dbEntry.baseHash != null
            && remoteEntry.md5Checksum.toLowerCase() !== dbEntry.baseHash.toLowerCase();
          if (remoteHashChanged || Math.abs(remoteMtime - dbEntry.remoteMtime) > 3000) {
            const baseClock = parseClock(dbEntry.vectorClock);
            plan.downloads.push({
              remoteFile: remoteEntry,
              localPath: relPath,
              vectorClock: JSON.stringify(remoteClock(remoteEntry, baseClock))
            });
          }
        }
        continue;
      }

      if (remoteEntry) {
        // Existe en ambos lados y cambió localmente — validamos si también cambió remotamente
        const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
        const remoteHashChanged = remoteEntry.md5Checksum != null && dbEntry.baseHash != null
          && remoteEntry.md5Checksum.toLowerCase() !== dbEntry.baseHash.toLowerCase();
        const remoteChanged = remoteHashChanged || Math.abs(remoteMtime - dbEntry.remoteMtime) > 3000;

        if (remoteChanged) {
          // Ambos cambiaron — conflicto legítimo
          const baseClock = parseClock(dbEntry.vectorClock);
          const localVc = VectorClockManager.increment(baseClock, deviceId);
          plan.conflicts.push({
            localPath: relPath,
            remoteFile: remoteEntry,
            localVc: JSON.stringify(localVc),
            remoteVc: JSON.stringify(remoteClock(remoteEntry, baseClock)),
            localHash: localEntry.hash ?? null,
            remoteHash: remoteEntry.md5Checksum ?? null,
            baseHash: dbEntry.baseHash ?? null,
            reason: 'both_modified',
          });
        } else {
          // Solo local cambió — upload
          const localVc = VectorClockManager.increment(parseClock(dbEntry.vectorClock), deviceId);
          plan.uploads.push({
            localPath: localEntry.rawName || relPath,
            remoteName: localEntry.name,
            remoteId: dbEntry.remoteId,
            vectorClock: JSON.stringify(localVc)
          });
        }
      } else {
        // Solo existe localmente pero ha sido modificado — upload (sobreescribiendo si aplica)
        plan.uploads.push({
          localPath: localEntry.rawName || relPath,
          remoteName: localEntry.name,
          remoteId: dbEntry.remoteId,
          vectorClock: JSON.stringify(VectorClockManager.increment(parseClock(dbEntry.vectorClock), deviceId))
        });
      }
    }

    // 2. Procesar archivos remotos no cubiertos por el loop local (Descargas)
    for (const [_, remoteEntry] of remoteSnapshot) {
      const lowerName = remoteEntry.name.toLowerCase();
      if (processedRemotes.has(remoteEntry.name)) continue;

      const localEntry = localByLowerName.get(lowerName);
      const dbEntry = Array.from(dbState.entries()).find(([k, v]) => k.toLowerCase() === lowerName)?.[1];

      if (!localEntry) {
        const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
        const remoteChanged = Boolean(dbEntry) &&
          Number.isFinite(remoteMtime) &&
          Math.abs(remoteMtime - dbEntry!.remoteMtime) > 3000;
        const remoteSize = remoteEntry.size === undefined ? undefined : Number.parseInt(remoteEntry.size, 10);
        const remoteHashChanged = remoteEntry.md5Checksum != null && dbEntry?.baseHash != null
          && remoteEntry.md5Checksum.toLowerCase() !== dbEntry.baseHash.toLowerCase();
        const sizeChanged = Boolean(dbEntry) &&
          remoteSize !== undefined &&
          Number.isFinite(remoteSize) &&
          remoteSize !== dbEntry!.fileSize;

        if (dbEntry && dbEntry.baseHash != null && dbEntry.remoteId === remoteEntry.id
          && (remoteChanged || sizeChanged || remoteHashChanged)) {
          const baseClock = parseClock(dbEntry.vectorClock);
          plan.conflicts.push({
            localPath: remoteEntry.name,
            remoteFile: remoteEntry,
            localVc: JSON.stringify(baseClock),
            remoteVc: JSON.stringify(remoteClock(remoteEntry, baseClock)),
            localHash: null,
            remoteHash: remoteEntry.md5Checksum ?? null,
            baseHash: dbEntry.baseHash ?? null,
            reason: 'delete_vs_modify',
          });
        } else if (!dbEntry || dbEntry.remoteId !== remoteEntry.id || remoteChanged || sizeChanged || remoteHashChanged) {
          // Archivo remoto nuevo o actualizado remotamente — descargar
          plan.downloads.push({
            remoteFile: remoteEntry,
            localPath: remoteEntry.name,
            vectorClock: JSON.stringify(remoteClock(remoteEntry, { remote: 1 }))
          });
        }
      }
    }

    // --- 3. Detectar Eliminaciones Cruzadas ---
    for (const [relPath, dbEntry] of dbState) {
      const existsLocally = localSnapshot.has(relPath);

      if (dbEntry.isTombstone) {
        // El archivo fue borrado en Drive (confirmado por HTTP 404 o fase 0).
        // Si aún existe físicamente en el PC, hay que borrarlo en el PC para mantener sincronía.
        if (existsLocally) {
          plan.deleteLocal.push({ localPath: relPath });
        }
        continue;
      }

      if (!existsLocally) {
        // El archivo desapareció físicamente del disco local (el usuario lo borró).

        // Evitamos enviar orden de borrar en remoto si detectamos que justo
        // ese mismo archivo está programado para descargarse (porque alguien lo editó online).
        const isDownloading = plan.downloads.some(d => d.localPath.toLowerCase() === relPath.toLowerCase());
        const isConflicting = plan.conflicts.some(c => c.localPath.toLowerCase() === relPath.toLowerCase());

        if (!isDownloading && !isConflicting) {
          if (dbEntry.remoteId) {
            const remoteEntry = Array.from(remoteSnapshot.values()).find(entry => entry.id === dbEntry.remoteId);
            const remoteChanged = dbEntry.baseHash != null && remoteEntry != null && (
              (remoteEntry.md5Checksum != null && dbEntry.baseHash != null
                && remoteEntry.md5Checksum.toLowerCase() !== dbEntry.baseHash.toLowerCase())
              || (remoteEntry.size != null && dbEntry.fileSize != null
                && Number.parseInt(remoteEntry.size, 10) !== dbEntry.fileSize)
              || Math.abs(new Date(remoteEntry?.modifiedTime ?? 0).getTime() - dbEntry.remoteMtime) > 3000
            );
            if (remoteChanged && remoteEntry) {
              const baseClock = parseClock(dbEntry.vectorClock);
              plan.conflicts.push({
                localPath: relPath,
                remoteFile: remoteEntry,
                localVc: JSON.stringify(baseClock),
                remoteVc: JSON.stringify(remoteClock(remoteEntry, baseClock)),
                localHash: null,
                remoteHash: remoteEntry.md5Checksum ?? null,
                baseHash: dbEntry.baseHash ?? null,
                reason: 'delete_vs_modify',
              });
            } else {
              plan.deleteRemote.push({ remoteId: dbEntry.remoteId, localPath: relPath });
            }
          } else {
            plan.deleteLocal.push({ localPath: relPath }); // Solo limpiar de la DB
          }
        }
      }
    }

    return plan;
  }

  /**
   * Merge de vector clocks para archivos sobrevivientes en deduplicación.
   */
  public static mergeClocksForDedup(
    winnerVcStr: string,
    loserVcStrs: string[],
    deviceId: string
  ): string {
    const winner: Record<string, number> = JSON.parse(winnerVcStr || '{}');
    const merged = { ...winner };

    for (const loserStr of loserVcStrs) {
      try {
        const loser: Record<string, number> = JSON.parse(loserStr);
        for (const [id, count] of Object.entries(loser)) {
          merged[id] = Math.max(merged[id] || 0, count);
        }
      } catch { /* ignorar clocks corruptos */ }
    }

    // Incrementar nuestro contador porque ESTE dispositivo hizo el merge
    merged[deviceId] = (merged[deviceId] || 0) + 1;

    return JSON.stringify(merged);
  }
}