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
  [key: string]: any;
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
  }>;
  conflicts: Array<{
    localPath: string;
    remoteFile: RemoteEntry;
    localVc: string;
    remoteVc: string;
  }>;
}

export interface SyncStateSnapshot {
  localMtime: number;
  remoteMtime: number;
  remoteId: string;
  fileSize: number | null;
  vectorClock?: string | null;
}

export class CoreSyncLogic {
  /**
   * Patrones de exclusión por defecto para archivos temporales, ocultos y bloqueos de edición
   * (StarNote en Android, LaTeX/LibreOffice en Linux).
   */
  public static readonly DEFAULT_IGNORE_PATTERNS: string[] = [
    '*.tmp',
    '*.temp',
    '.*',
    '~*',
    '*.lock',
    '*.swp',
    '*.aux',
    '*.log',
    '*.out',
    '.*-SAVE-ERROR*'
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
   * Por defecto exige 2000 ms (2 segundos) de inactividad de modificación sobre el disco.
   */
  public static isReadyForSync(mtimeMs: number, bufferMs: number = 2000, now?: number): boolean {
    if (!mtimeMs || mtimeMs <= 0) return true;
    const currentTime = now || Date.now();
    return Math.abs(currentTime - mtimeMs) >= bufferMs;
  }

  /**
   * Extrae información de numeración de archivos duplicados automáticos como "rotman(8).pdf" o "apuntes (1).txt".
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
   * Agrupa una lista de archivos del sistema por su nombre base y los ordena
   * situando al "ganador" en el índice 0 (mayor mtime con margen de 2s, o versión de número más alta).
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
        // Orden descendente por mtime (más reciente primero).
        const timeDiff = b.mtime - a.mtime;
        // Si hay diferencia de timestamp, prevalece el mtime (siempre).
        if (timeDiff !== 0) return timeDiff;
        // Desempate: si timestamps son exactamente iguales (writes en cadena),
        // gana la versión con mayor número de exportación.
        return b.version - a.version;
      });
    }

    return groups;
  }

  /**
   * Estandariza las rutas remotas de Google Drive a la jerarquía oficial:
   * GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote
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
   * THREE-WAY MERGE: Computa el plan de sincronización comparando
   * Local vs Remote vs Estado Base (DB).
   *
   * FUNCIÓN PURA: sin I/O, sin DB, sin Drive. 100% testeable.
   *
   * @param localSnapshot  Mapa de archivos locales (mutado post-dedup)
   * @param remoteSnapshot Mapa de archivos remotos (mutado post-dedup)
   * @param dbState        Estado base desde SQLite
   * @param deviceId       UUID del dispositivo actual
   */
  public static computeSyncPlan(
    localSnapshot: ReadonlyMap<string, { name: string; mtime: number; size: number }>,
    remoteSnapshot: ReadonlyMap<string, RemoteEntry>,
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

    // Índice case-insensitive para Drive
    const remoteByLowerName = new Map<string, RemoteEntry>();
    for (const [_, entry] of remoteSnapshot) {
      remoteByLowerName.set(entry.name.toLowerCase(), entry);
    }

    // Índice case-insensitive para local
    const localByLowerName = new Map<string, { name: string; mtime: number; size: number }>();
    for (const [relPath, entry] of localSnapshot) {
      localByLowerName.set(entry.name.toLowerCase(), entry);
    }

    const processedRemotes = new Set<string>();
    const parseClock = (clock: string | null | undefined): VectorClock =>
      VectorClockManager.fromString(clock || '{}');
    const remoteClock = (entry: RemoteEntry, fallback: VectorClock): VectorClock =>
      VectorClockManager.fromAppProperties(entry.appProperties || {}) || fallback;

    // Procesar archivos locales
    for (const [relPath, localEntry] of localSnapshot) {
      const lowerName = localEntry.name.toLowerCase();
      const dbEntry = dbState.get(relPath);
      const remoteEntry = remoteByLowerName.get(lowerName);

      if (remoteEntry) processedRemotes.add(lowerName);

      if (!dbEntry) {
        // Nuevo archivo local — subir
        plan.uploads.push({
          localPath: relPath,
          remoteName: localEntry.name,
          remoteId: remoteEntry?.id,
          vectorClock: JSON.stringify({ [deviceId]: 1 })
        });
        continue;
      }

      // Archivo ya conocido — ¿cambió?
      const mtimeChanged = Math.abs(localEntry.mtime - dbEntry.localMtime) > 3000;
      const sizeChanged = dbEntry.fileSize !== null && localEntry.size !== dbEntry.fileSize;

      if (!mtimeChanged && !sizeChanged) {
        // A remote-only change must not be hidden by the local snapshot loop.
        if (remoteEntry) {
          const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
          if (Math.abs(remoteMtime - dbEntry.remoteMtime) > 3000) {
            const baseClock = parseClock(dbEntry.vectorClock);
            plan.downloads.push({
              remoteFile: remoteEntry,
              localPath: relPath,
              vectorClock: JSON.stringify(remoteClock(remoteEntry, baseClock))
            });
          }
        }
        continue; // Sin cambios
      }

      if (remoteEntry) {
        // Existe en ambos lados — three-way merge
        const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
        const remoteChanged = Math.abs(remoteMtime - dbEntry.remoteMtime) > 3000;

        if (remoteChanged) {
          // Ambos cambiaron — conflicto legítimo
          const baseClock = parseClock(dbEntry.vectorClock);
          const localVc = VectorClockManager.increment(baseClock, deviceId);
          plan.conflicts.push({
            localPath: relPath,
            remoteFile: remoteEntry,
            localVc: JSON.stringify(localVc),
            remoteVc: JSON.stringify(remoteClock(remoteEntry, baseClock))
          });
        } else {
          // Solo local cambió — upload
          const localVc = VectorClockManager.increment(parseClock(dbEntry.vectorClock), deviceId);
          plan.uploads.push({
            localPath: relPath,
            remoteName: localEntry.name,
            remoteId: dbEntry.remoteId,
            vectorClock: JSON.stringify(localVc)
          });
        }
      } else {
        // Solo existe localmente — upload
        plan.uploads.push({
          localPath: relPath,
          remoteName: localEntry.name,
          remoteId: dbEntry.remoteId,
          vectorClock: JSON.stringify(VectorClockManager.increment(parseClock(dbEntry.vectorClock), deviceId))
        });
      }
    }

    // Procesar archivos remotos no cubiertos por el loop local
    for (const [_, remoteEntry] of remoteSnapshot) {
      const lowerName = remoteEntry.name.toLowerCase();
      if (processedRemotes.has(lowerName)) continue;

      const localEntry = localByLowerName.get(lowerName);
      const dbEntry = Array.from(dbState.entries()).find(([k, v]) => k.toLowerCase() === lowerName)?.[1];

      if (!localEntry) {
        const remoteMtime = new Date(remoteEntry.modifiedTime).getTime();
        const remoteChanged = Boolean(dbEntry) &&
          Number.isFinite(remoteMtime) &&
          Math.abs(remoteMtime - dbEntry!.remoteMtime) > 3000;
        const remoteSize = remoteEntry.size === undefined ? undefined : Number.parseInt(remoteEntry.size, 10);
        const sizeChanged = Boolean(dbEntry) &&
          remoteSize !== undefined &&
          Number.isFinite(remoteSize) &&
          remoteSize !== dbEntry!.fileSize;

        if (!dbEntry || dbEntry.remoteId !== remoteEntry.id || remoteChanged || sizeChanged) {
          // Archivo remoto nuevo o actualizado — descargar
          plan.downloads.push({
            remoteFile: remoteEntry,
            localPath: remoteEntry.name,
            vectorClock: JSON.stringify(remoteClock(remoteEntry, { remote: 1 }))
          });
        }
      }
    }

    // Detectar eliminaciones: en DB pero no en filesystem ni en remote
    for (const [relPath, dbEntry] of dbState) {
      if (!localSnapshot.has(relPath) && !Array.from(remoteSnapshot.values()).some(r => r.name.toLowerCase() === relPath.toLowerCase())) {
        if (dbEntry.remoteId) {
          plan.deleteRemote.push({ remoteId: dbEntry.remoteId });
        } else {
          plan.deleteLocal.push({ localPath: relPath });
        }
      }
    }

    return plan;
  }

  /**
   * Merge de vector clocks para archivos sobrevivientes en deduplicación.
   * Toma el MAX por cada dimensión de todos los clocks del grupo,
   * luego incrementa el contador del dispositivo actual.
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
