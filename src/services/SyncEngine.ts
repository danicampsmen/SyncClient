import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { IFileSystem } from '../utils/fileSystem';
import { CoreSyncLogic, ANDROID_STARNOTE_BASE, ANDROID_STARNOTE_EXPORT, DEFAULT_REMOTE_PATH, RemoteEntry, SyncPlan } from '../shared/CoreSyncLogic';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  etag?: string;
  appProperties?: Record<string, string>;
}

function matchesIgnorePattern(name: string, patterns?: string[]): boolean {
  return CoreSyncLogic.matchesIgnorePattern(name, patterns || CoreSyncLogic.DEFAULT_IGNORE_PATTERNS);
}


function formatBytes(bytes: number, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

interface ManifestEntry {
  localMtime: number;
  remoteMtime: number;
  remoteId: string;
}

export class SyncEngine {
  private pairs: SyncPair[] = [];
  private events: SyncEvent[] = [];
  private settings: SyncSettings = {
    maxDownloadSpeed: 0,
    maxUploadSpeed: 0,
    conflictResolution: 'prompt',
    ignoredPatterns: ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.bcf*', '*.bbl*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp'],
    autoStart: false,
    desktopNotifications: true
  };
  private manifests: Record<string, Record<string, ManifestEntry>> = {};
  private pendingConflicts: PendingConflict[] = [];
  private accessToken: string | null = null;
  private configDir: string;
  private configFile: string;
  private isSavingState = false;
  private needsSaveState = false;

  private activeSyncs = new Set<string>();
  private pendingSyncs = new Set<string>();
  private intervalRefs: Record<string, any> = {};
  private detectedExternalDrives: ExternalDriveAlert[] = [];
  private driveFolderCache = new Map<string, { timestamp: number; files: DriveFile[] }>();

  // B1/B6: Anti-bucle — portado del motor desktop para prevenir bucles en Android
  private selfWrittenFiles = new Map<string, number>();
  private lastSyncCompleted: Record<string, number> = {};
  private syncBackoff: Record<string, number> = {};
  private syncTriggerSource: Record<string, 'fs-event' | 'poll' | 'manual'> = {};
  private readonly SYNC_COOLDOWN_MS = 60000;
  private readonly MAX_POLL_INTERVAL_MS = 900000;
  private readonly INITIAL_POLL_MS = 30000;
  // Fix #3: Rate limiter local para Android — máximo 5 requests/segundo
  private rateLimiter = { lastRequest: 0, minInterval: 200 };

  // --- v2: Database-backed state ---
  private db: any = null;
  private DEVICE_ID: string | null = null;

  // B10: Caché de .syncmeta — evita leer el sistema de archivos en cada comprobación
  private syncmetaCache = new Map<string, number>();

  private markSelfWritten(filePath: string) {
    if (!filePath) return;
    this.selfWrittenFiles.set(filePath, Date.now());
    if (this.selfWrittenFiles.size > 200) {
      const now = Date.now();
      for (const [key, timestamp] of this.selfWrittenFiles.entries()) {
        if (now - timestamp > 30000) {
          this.selfWrittenFiles.delete(key);
        }
      }
    }
  }

  private isSelfWritten(filePath: string): boolean {
    if (!filePath) return false;
    const timestamp = this.selfWrittenFiles.get(filePath);
    if (!timestamp) return false;
    if (Date.now() - timestamp < 15000) {
      return true;
    }
    this.selfWrittenFiles.delete(filePath);
    return false;
  }

  // B10: Leer mtime remoto desde archivo sidecar .syncmeta
  // Capacitor no soporta utimes, así que almacenamos el mtime remoto en un archivo JSON
  private async readSyncmeta(filePath: string): Promise<number | null> {
    const cached = this.syncmetaCache.get(filePath);
    if (cached !== undefined) return cached;

    const metaPath = filePath + '.syncmeta';
    try {
      const data = await this.fs.readFile(metaPath);
      const parsed = JSON.parse(data);
      const mtime = parsed.remoteMtime || null;
      if (mtime) this.syncmetaCache.set(filePath, mtime);
      return mtime;
    } catch {
      return null;
    }
  }

  // B10: Escribir mtime remoto en archivo sidecar .syncmeta
  private async writeSyncmeta(filePath: string, remoteMtime: number): Promise<void> {
    const metaPath = filePath + '.syncmeta';
    this.syncmetaCache.set(filePath, remoteMtime);
    try {
      await this.fs.writeFile(metaPath, JSON.stringify({ remoteMtime }));
    } catch {
      // Ignorar errores de escritura de metadata
    }
  }

  // B10: Obtener el mtime lógico de un archivo (syncmeta si existe, sino el real del sistema)
  private async getLogicalMtime(filePath: string): Promise<number | null> {
    const syncmetaMtime = await this.readSyncmeta(filePath);
    if (syncmetaMtime !== null) return syncmetaMtime;
    const stat = await this.fs.stat(filePath);
    return stat?.mtime ?? null;
  }

  private async runInPool<T>(tasks: (() => Promise<T>)[], concurrency = 3): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err: any) {
          console.error(`[SyncEngine/Pool] Error en tarea concurrente:`, err.message || err);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  constructor(private fs: IFileSystem) {
    this.configDir = this.fs.join(this.fs.getHomeDir(), '.config', 'syncclient');
    this.configFile = this.fs.join(this.configDir, 'sync_data.json');
    this.init();

    // CORRECCIÓN: Solo registrar listeners de Capacitor en entorno nativo (Android/iOS).
    // En Electron/Node.js, import('@capacitor/app') falla y el catch anterior intentaba
    // usar document.addEventListener('visibilitychange', ...) donde document no existe
    // en el contexto de Node.js, causando un ReferenceError silencioso.
    if (typeof document !== 'undefined') {
      try {
        // Capacitor App plugin (Android/iOS)
        import('@capacitor/app').then(({ App }) => {
          App.addListener('appStateChange', ({ isActive }) => {
            if (isActive) {
              console.log('[SyncEngine] App vuelve a primer plano — reanudando sincronizaciones pendientes');
              this.activeSyncs.forEach(pairId => {
                const pair = this.pairs.find(p => p.id === pairId);
                if (pair && (pair.status as string) !== 'paused') {
                  pair.status = 'idle';
                  pair.progress = null;
                }
              });
              this.activeSyncs.clear();
              this.pendingSyncs.clear();
              setTimeout(() => this.triggerAllActive(), 1500);
            }
          });
        }).catch(() => {
          // Capacitor no disponible (Electron/web) — usar visibilitychange como fallback
          // Solo si document existe (no es Node.js backend)
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
              if (!document.hidden) {
                console.log('[SyncEngine] Página visible de nuevo — reanudando sincronizaciones');
                this.activeSyncs.forEach(pairId => {
                  const pair = this.pairs.find(p => p.id === pairId);
                  if (pair && (pair.status as string) !== 'paused') { pair.status = 'idle'; pair.progress = null; }
                });
                this.activeSyncs.clear();
                this.pendingSyncs.clear();
                setTimeout(() => this.triggerAllActive(), 1500);
              }
            });
          }
        });
      } catch {
        // Ignorar errores de entorno
      }
    }
  }

  private async init() {
    try {
      // Solicitar permisos de almacenamiento externo al inicio (Android)
      // Sin estos permisos, readdir de /storage/emulated/0/... devuelve [] silenciosamente
      try {
        const { Filesystem: FS } = await import('@capacitor/filesystem');
        const permStatus = await FS.checkPermissions();
        if (permStatus.publicStorage !== 'granted') {
          console.log('[SyncEngine] Solicitando permiso de almacenamiento externo...');
          const result = await FS.requestPermissions();
          if (result.publicStorage !== 'granted') {
            console.error('[SyncEngine] PERMISO DE ALMACENAMIENTO DENEGADO — la sincronización no podrá leer los archivos del usuario');
          } else {
            console.log('[SyncEngine] Permiso de almacenamiento externo concedido.');
          }
        }
      } catch (permErr: any) {
        // En Electron/web no hay permisos de Capacitor — ignorar
        console.warn('[SyncEngine] No se pudo verificar permisos de almacenamiento:', permErr?.message || permErr);
      }

      await this.fs.mkdir(this.configDir);

      // v2: Inicializar DB backend (solo en Capacitor/Android, no en navegador)
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          const { createBackend } = await import('../shared/StorageBackend');
          this.db = await createBackend(this.configDir, this.fs);
          this.DEVICE_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'dev-' + Math.random().toString(36).substr(2, 9);
          // Migrar manifests a DB si existen
          if (this.manifests && Object.keys(this.manifests).length > 0 && this.db) {
            for (const [pairId, entries] of Object.entries(this.manifests)) {
              for (const [relPath, entry] of Object.entries(entries)) {
                this.db.setFileState(pairId, relPath, {
                  pair_id: pairId, rel_path: relPath,
                  remote_id: entry.remoteId, local_mtime: entry.localMtime,
                  remote_mtime: entry.remoteMtime, file_size: null, md5_hash: null,
                  block_hashes: null,
                  vector_clock: JSON.stringify({ [this.DEVICE_ID!]: 1 }),
                  device_id: this.DEVICE_ID!, etag: null,
                  updated_at: Date.now(), is_tombstone: 0
                });
              }
            }
            console.log(`[SyncEngine] Migrated ${Object.keys(this.manifests).length} pairs from JSON to SQLite`);
          }
        }
      } catch (e: any) {
        console.warn('[SyncEngine] DB init skipped (not native):', e?.message || e);
      }

      try {
        const data = await this.fs.readFile(this.configFile);
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed.pairs) this.pairs = parsed.pairs;
          if (parsed.events) this.events = parsed.events.slice(0, 200);
          if (parsed.settings) {
            this.settings = parsed.settings;
            const defaultPatterns = ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.bcf*', '*.bbl*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp'];
            const current = new Set(this.settings.ignoredPatterns || []);
            defaultPatterns.forEach(p => current.add(p));
            this.settings.ignoredPatterns = Array.from(current);
          }
          if (parsed.manifests) this.manifests = parsed.manifests;
          if (parsed.pendingConflicts) this.pendingConflicts = parsed.pendingConflicts;
          console.log(`[SyncEngine] Config loaded from ${this.configFile}`);
        }
      } catch (e: any) {
        console.warn('[SyncEngine] No config found or error reading it:', e?.message || String(e));
      }
      if (this.pairs.length > 0) {
        let modified = false;
        this.pairs.forEach(p => {
          if (p.localPath === ANDROID_STARNOTE_BASE) {
            p.localPath = ANDROID_STARNOTE_EXPORT;
            modified = true;
          }
          if (p.remotePath === 'GoogleDrive:/Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:/Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:/Documentos-Ubuntu/Apuntes_Tablet_StarNote') {
            p.remotePath = DEFAULT_REMOTE_PATH;
            modified = true;
          }
        });
        if (modified) await this.saveState();
      }
      this.refreshIntervals();
    } catch (err: any) {
      console.error('[SyncEngine] Init error:', err?.message || String(err));
    }
  }

  private async saveState() {
    if (this.isSavingState) {
      this.needsSaveState = true;
      return;
    }
    this.isSavingState = true;
    try {
      await this.fs.mkdir(this.configDir);
      const data = {
        pairs: this.pairs,
        events: this.events.slice(0, 200),
        settings: this.settings,
        manifests: this.manifests,
        pendingConflicts: this.pendingConflicts
      };
      const tmpFile = `${this.configFile}.tmp.${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      await this.fs.writeFile(tmpFile, JSON.stringify(data));
      await this.fs.rename(tmpFile, this.configFile);
    } catch (err) {
      console.error('[SyncEngine] Save state error:', err);
    } finally {
      this.isSavingState = false;
      if (this.needsSaveState) {
        this.needsSaveState = false;
        this.saveState();
      }
    }
  }

  public setToken(token: string | null) {
    const prev = this.accessToken;
    this.accessToken = token;
    if (token && prev !== token) {
      console.log('[SyncEngine] Google Drive Access Token updated.');
      this.pairs.forEach(p => {
        if (p.status === 'unauthenticated') p.status = 'idle';
      });
      this.triggerAllActive();
    }
  }

  public getToken(): string | null {
    return this.accessToken;
  }

  public getStatus() {
    return {
      pairs: this.pairs,
      events: this.events,
      settings: this.settings,
      pendingConflicts: this.pendingConflicts,
      authenticated: !!this.accessToken,
      detectedExternalDrives: this.detectedExternalDrives
    };
  }

  public async setPairs(pairs: SyncPair[]) {
    this.pairs = pairs;
    await this.saveState();
    this.refreshIntervals();
  }

  public async updateSettings(settings: SyncSettings) {
    this.settings = settings;
    await this.saveState();
  }

  public async togglePairSync(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return;
    if (pair.status === 'idle' || pair.status === 'error' || pair.status === 'unauthenticated') {
      pair.status = 'syncing';
      setTimeout(() => this.triggerSync(pair.id), 10);
    } else if (pair.status === 'syncing') {
      pair.status = 'idle';
    } else if ((pair.status as string) === 'paused') {
      pair.status = 'idle';
    }
    this.refreshIntervals();
    this.saveState(); // No bloqueante
  }

  public async forceSync(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return;

    if (!this.accessToken) {
      pair.status = 'unauthenticated';
      pair.progress = {
        currentFile: 'No autenticado: Por favor re-conecta tu cuenta de Google Drive',
        totalFiles: 0,
        currentFileIndex: 0,
        bytesTransferred: 0,
        totalBytes: 0,
        percentage: 0,
        action: 'comprobando'
      };
      this.saveState();
      return;
    }

    // Al pulsar "Sincronizar" manualmente, liberar cualquier candado previo bloqueado o atascado
    this.activeSyncs.delete(pairId);
    pair.status = 'syncing';
    this.refreshIntervals();
    setTimeout(() => this.triggerSync(pair.id), 10);
    this.saveState();
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };

    console.log(`[SyncEngine] Iniciando limpieza total de duplicados en local y Google Drive para: ${pair.localPath}`);
    const localRes = await this.deduplicateLocalFolder(pair.localPath, pair.id, '');
    let remoteRes = { deleted: 0, renamed: 0 };

    if (this.accessToken) {
      try {
        let remoteFolderId = 'root';
        const remotePathParts = pair.remotePath.replace(/^(RemoteServer|GoogleDrive|Drive):/, '').replace(/^[\/\\]+/, '').split('/').filter(Boolean);
        for (const part of remotePathParts) {
          const files = await this.listDriveFiles(remoteFolderId);
          const folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
          if (!folder) break;
          remoteFolderId = folder.id;
        }
        if (remoteFolderId && remoteFolderId !== 'root') {
          remoteRes = await this.deduplicateDriveFolder(remoteFolderId, pair.id, '');
        }
      } catch (e) {
        console.error('[SyncEngine] Error deduplicando Google Drive:', e);
      }
    }

    return {
      localDeleted: localRes.deleted,
      localRenamed: localRes.renamed,
      remoteDeleted: remoteRes.deleted,
      remoteRenamed: remoteRes.renamed
    };
  }

  public async pausePair(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return;
    if ((pair.status as string) === 'paused') {
      pair.status = 'idle';
      setTimeout(() => this.triggerSync(pair.id), 10);
    } else {
      pair.status = 'paused';
      pair.progress = null;
      this.activeSyncs.delete(pairId);
      this.pendingSyncs.delete(pairId);
    }
    this.refreshIntervals();
    await this.saveState();
  }

  public async removePair(pairId: string) {
    if (this.intervalRefs[pairId]) {
      clearInterval(this.intervalRefs[pairId]);
      delete this.intervalRefs[pairId];
    }
    this.pairs = this.pairs.filter(p => p.id !== pairId);
    delete this.manifests[pairId];
    this.pendingConflicts = this.pendingConflicts.filter(c => c.pairId !== pairId);
    await this.saveState();
  }

  // Fix #11: Comprobación recursiva que detecta cambios en subcarpetas (no solo archivos directos)
  private async hasLocalFolderChanged(pair: SyncPair): Promise<boolean> {
    const pairManifest = this.manifests[pair.id] || {};

    const scanDir = async (dirPath: string, relPrefix: string): Promise<boolean> => {
      try {
        const entries = await this.fs.readdir(dirPath);
        if (!entries) return false;

        for (const entry of entries) {
          const relPath = this.fs.join(relPrefix, entry.name);
          if (entry.isDirectory) {
            // Recurrir en subcarpetas
            const subDir = this.fs.join(dirPath, entry.name);
            const changed = await scanDir(subDir, relPath);
            if (changed) return true;
          } else {
            // B10: Usar mtime lógico (syncmeta si existe, sino el real)
            const manifestEntry = pairManifest[relPath] || pairManifest[entry.name];
            if (!manifestEntry) return true; // Nuevo archivo sin registro
            const logicalMtime = await this.getLogicalMtime(this.fs.join(dirPath, entry.name));
            if (logicalMtime && Math.abs(logicalMtime - manifestEntry.localMtime) > 2000) {
              return true; // Modificado
            }
          }
        }
        return false;
      } catch {
        return false;
      }
    };

    try {
      const entries = await this.fs.readdir(pair.localPath);
      if (!entries) return false;
      const fileEntries = entries.filter(e => !e.isDirectory);

      // Si el manifiesto está vacío pero hay archivos, hay cambios
      if (Object.keys(pairManifest).length === 0 && fileEntries.length > 0) return true;

      // Escaneo recursivo
      return await scanDir(pair.localPath, '');
    } catch {
      return false;
    }
  }

  // B1/B6: Polling adaptativo — portado del motor desktop
  private refreshIntervals() {
    this.pairs.forEach(pair => {
      const isWatchable = pair.status === 'syncing' || pair.status === 'idle';
      if (isWatchable && !this.intervalRefs[pair.id]) {
        const getAdaptiveInterval = () => {
          const backoff = this.syncBackoff[pair.id] || this.INITIAL_POLL_MS;
          return Math.min(backoff, this.MAX_POLL_INTERVAL_MS);
        };

        const scheduleNext = () => {
          const interval = getAdaptiveInterval();
          this.intervalRefs[pair.id] = setTimeout(async () => {
            if (await this.hasLocalFolderChanged(pair)) {
              console.log(`[SyncEngine] Cambio detectado en ${pair.localPath}. Ejecutando autosincronización...`);
              this.syncTriggerSource[pair.id] = 'poll';
              this.triggerSync(pair.id);
            }
            scheduleNext();
          }, interval);
        };
        scheduleNext();
      } else if (!isWatchable && this.intervalRefs[pair.id]) {
        clearTimeout(this.intervalRefs[pair.id]);
        delete this.intervalRefs[pair.id];
      }
    });
  }

  private triggerAllActive() {
    this.pairs.forEach(p => {
      if (p.status === 'syncing' || p.status === 'idle') {
        this.triggerSync(p.id);
      }
    });
  }

  public async triggerSync(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || (pair.status as string) === 'paused') return;

    if (!this.accessToken) {
      if (pair.status === 'syncing') {
        pair.status = 'unauthenticated';
        pair.progress = {
          currentFile: 'Sesión expirada: Por favor re-conecta tu cuenta',
          totalFiles: 0,
          currentFileIndex: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          percentage: 0,
          action: 'comprobando'
        };
        this.saveState();
      }
      return;
    }

    // B1/B6: Anti-bucle — cooldown post-sincronización para triggers por polling
    const lastCompleted = this.lastSyncCompleted[pairId] || 0;
    const elapsedSinceLastSync = Date.now() - lastCompleted;
    const triggerSource = this.syncTriggerSource[pairId] || 'manual';

    if (triggerSource === 'poll' && elapsedSinceLastSync < this.SYNC_COOLDOWN_MS) {
      console.log(`[SyncEngine/AntiBucle] Polling saltado para ${pairId}: cooldown activo (${Math.round((this.SYNC_COOLDOWN_MS - elapsedSinceLastSync) / 1000)}s restantes).`);
      this.syncTriggerSource[pairId] = 'manual';
      return;
    }

    if (this.activeSyncs.has(pairId)) {
      this.pendingSyncs.add(pairId);
      return;
    }

    this.activeSyncs.add(pairId);
    pair.status = 'syncing';
    pair.progress = {
      currentFile: 'Iniciando inspección y verificación...',
      totalFiles: 0,
      currentFileIndex: 0,
      bytesTransferred: 0,
      totalBytes: 0,
      percentage: 0,
      action: 'comprobando'
    };
    this.addEvent({
      id: Math.random().toString(36).substr(2, 9),
      pairId: pair.id,
      filename: pair.localPath,
      action: 'sync_start',
      timestamp: Date.now(),
      details: 'Iniciando ciclo automático de sincronización'
    }, true);
    console.log(`[SyncEngine] Iniciando sincronización nativa para par: ${pair.localPath}`);

    // Watchdog de seguridad: liberación forzada si el ciclo excede 60 segundos por bloqueo de red
    const watchdogTimer = setTimeout(() => {
      if (this.activeSyncs.has(pairId)) {
        console.warn(`[SyncEngine Watchdog] Sincronización excedió el tiempo máximo (60s) para ${pair.localPath}. Liberando estado.`);
        this.activeSyncs.delete(pairId);
        if (pair.status === 'syncing') {
          pair.status = 'error';
          pair.progress = {
            currentFile: 'Tiempo de espera de red agotado (Timeout)',
            totalFiles: pair.progress?.totalFiles || 0,
            currentFileIndex: pair.progress?.currentFileIndex || 0,
            bytesTransferred: pair.progress?.bytesTransferred || 0,
            totalBytes: pair.progress?.totalBytes || 0,
            percentage: pair.progress?.percentage || 0,
            action: 'completado'
          };
          this.saveState();
        }
      }
    }, 60000);

    try {
      let remoteFolderId = 'root';
      let remotePathParts = pair.remotePath.replace(/^(RemoteServer|GoogleDrive|Drive):/, '').replace(/^[\/\\]+/, '').split('/').filter(Boolean);

      for (const part of remotePathParts) {
        const files = await this.listDriveFiles(remoteFolderId);
        let folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
        if (!folder) {
          folder = await this.createDriveFolder(remoteFolderId, part);
        }
        remoteFolderId = folder.id;
      }

      await this.fs.mkdir(pair.localPath);
      if (!this.manifests[pair.id]) {
        this.manifests[pair.id] = {};
      }

      await this.syncDirectoryTree(pair.localPath, remoteFolderId, pair, '');

      if ((pair.status as string) === 'paused') {
        console.log(`[SyncEngine] Sincronización pausada por el usuario durante el ciclo para ${pair.localPath}. Abortando.`);
        pair.progress = null;
        await this.saveState();
        return;
      }

      pair.lastSynced = Date.now();
      pair.status = 'idle';

      // Capturar resumen antes de sobreescribir el progreso
      const finalTotalFiles = pair.progress?.totalFiles ?? 0;
      const finalFilesProcessed = pair.progress?.currentFileIndex ?? 0;
      const finalBytesTransferred = pair.progress?.bytesTransferred ?? 0;
      const finalTotalBytes = pair.progress?.totalBytes ?? 0;

      pair.progress = {
        currentFile: finalBytesTransferred > 0
          ? `${finalFilesProcessed} archivo(s) sincronizado(s) — ${formatBytes(finalBytesTransferred)}`
          : 'Todo al día — sin cambios pendientes',
        totalFiles: finalTotalFiles,
        currentFileIndex: finalFilesProcessed,
        bytesTransferred: finalBytesTransferred,
        totalBytes: finalTotalBytes > 0 ? finalTotalBytes : finalBytesTransferred,
        percentage: 100,
        action: 'completado'
      };
      this.addEvent({
        id: Math.random().toString(36).substr(2, 9),
        pairId: pair.id,
        filename: pair.localPath,
        action: 'sync_end',
        timestamp: Date.now(),
        details: finalBytesTransferred > 0
          ? `Ciclo finalizado: ${finalFilesProcessed} archivo(s), ${formatBytes(finalBytesTransferred)} transferidos`
          : 'Ciclo finalizado: todo estaba sincronizado, sin transferencias necesarias'
      }, true);
      setTimeout(() => {
        if (pair && pair.status === 'idle') {
          pair.progress = null;
          this.saveState();
        }
      }, 4000);
      await this.saveState();
    } catch (err: any) {
      if (err.message === 'UNAUTHORIZED_EXPIRED_TOKEN') {
        pair.status = 'unauthenticated';
      } else if ((pair.status as string) !== 'paused') {
        console.error(`[SyncEngine] Error sincronización:`, err.message);
        pair.status = 'error';
      }
      pair.progress = null;
      await this.saveState();
    } finally {
      clearTimeout(watchdogTimer);
      this.activeSyncs.delete(pairId);
      this.driveFolderCache.clear();

      // B1/B6: Anti-bucle — registrar timestamp y ajustar backoff adaptativo
      this.lastSyncCompleted[pairId] = Date.now();
      const filesProcessed = pair.progress?.currentFileIndex ?? 0;
      const bytesTransferred = pair.progress?.bytesTransferred ?? 0;

      if (filesProcessed === 0 && bytesTransferred === 0) {
        const currentBackoff = this.syncBackoff[pairId] || this.INITIAL_POLL_MS;
        this.syncBackoff[pairId] = Math.min(currentBackoff * 2, this.MAX_POLL_INTERVAL_MS);
        console.log(`[SyncEngine/AntiBucle] Sin cambios en ${pairId}. Backoff aumentado a ${this.syncBackoff[pairId] / 1000}s.`);
      } else {
        this.syncBackoff[pairId] = this.INITIAL_POLL_MS;
        console.log(`[SyncEngine/AntiBucle] ${filesProcessed} archivo(s) procesados. Backoff reseteado a ${this.INITIAL_POLL_MS / 1000}s.`);
      }
      this.syncTriggerSource[pairId] = 'manual';

      if (this.pendingSyncs.has(pairId) && (pair?.status as string) !== 'paused') {
        this.pendingSyncs.delete(pairId);
        setTimeout(() => this.triggerSync(pairId), 5000);
      }
    }
  }

  /**
   * Deduplica exportaciones automáticas (ej. de StarNote) que generan archivos como Nota(1).pdf, Nota(2).pdf.
   * Conserva únicamente la última versión modificada/exportada y la renombra a su nombre base (Nota.pdf).
   */
  private async deduplicateLocalFolder(localDir: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> {
    let deleted = 0;
    let renamed = 0;
    try {
      const entries = await this.fs.readdir(localDir);
      if (!entries) return { deleted, renamed };
      const files = entries.filter(e => !e.isDirectory);
      if (files.length === 0) return { deleted, renamed };

      // Optimización Ultra-Rápida Capacitor (Sin viajes por el puente IPC para stat):
      // Aprovechamos los metadatos cacheados por readdir y agrupamos con CoreSyncLogic
      const fileItems = files.map(e => ({
        name: e.name,
        mtime: e.mtime || 0,
        entry: e
      }));
      const groups = CoreSyncLogic.groupAndSortDuplicates(fileItems);

      const manifest = (pairId && this.manifests[pairId]) ? this.manifests[pairId] : null;

      for (const [baseName, versions] of groups.entries()) {
        if (versions.length <= 1 && versions[0].entry.name === baseName) continue;

        const winner = versions[0];
        const losers = versions.slice(1);

        if (losers.length > 0) {
          console.log(`[Deduplicador Local] Grupo "${baseName}": Manteniendo última versión ${winner.entry.name} (v${winner.version}), eliminando ${losers.length} copias obsoletas.`);
          for (const loser of losers) {
            const filePath = this.fs.join(localDir, loser.entry.name);
            await this.fs.rm(filePath).catch(() => { });
            deleted++;
            if (manifest) {
              const loserRelPath = this.fs.join(relativePrefix, loser.entry.name);
              delete manifest[loserRelPath];
              delete manifest[loser.entry.name];
            }
          }
        }


        if (winner.entry.name !== baseName && this.fs.rename) {
          const oldPath = this.fs.join(localDir, winner.entry.name);
          const newPath = this.fs.join(localDir, baseName);
          console.log(`[Deduplicador Local] Renombrando última exportación al nombre base: ${winner.entry.name} -> ${baseName}`);
          await this.fs.rename(oldPath, newPath).catch(err => console.error(`Error renombrando ${oldPath}:`, err));
          renamed++;
          if (manifest) {
            const oldRelPath = this.fs.join(relativePrefix, winner.entry.name);
            const newRelPath = this.fs.join(relativePrefix, baseName);
            if (manifest[oldRelPath]) {
              manifest[newRelPath] = manifest[oldRelPath];
              delete manifest[oldRelPath];
            } else {
              delete manifest[newRelPath];
            }
            delete manifest[winner.entry.name];
          }
        }
      }
      if (deleted > 0 || renamed > 0) {
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pairId || 'general',
          filename: 'Almacenamiento Local Tablet',
          action: 'cleaned',
          timestamp: Date.now(),
          details: `Eliminadas ${deleted} copias obsoletas (${renamed} renombrado a versión base)`
        }, true);
        if (manifest) await this.saveState();
      }
    } catch (e) {
      console.warn(`[Deduplicador Local] Error en ${localDir}:`, e);
    }
    return { deleted, renamed };
  }

  private async deduplicateDriveFolder(remoteFolderId: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> {
    let deleted = 0;
    let renamed = 0;
    if (!this.accessToken) return { deleted, renamed };
    try {
      const files = await this.listDriveFiles(remoteFolderId, true);
      const regularFiles = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
      if (regularFiles.length === 0) return { deleted, renamed };

      const groups = new Map<string, Array<{ file: DriveFile; version: number }>>();

      for (const file of regularFiles) {
        const match = file.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
        if (match) {
          const baseName = `${match[1].trim()}.${match[3]}`;
          const ver = parseInt(match[2], 10);
          if (!groups.has(baseName)) groups.set(baseName, []);
          groups.get(baseName)!.push({ file, version: ver });
        } else {
          if (!groups.has(file.name)) groups.set(file.name, []);
          groups.get(file.name)!.push({ file, version: 0 });
        }
      }

      const manifest = (pairId && this.manifests[pairId]) ? this.manifests[pairId] : null;

      for (const [baseName, versions] of groups.entries()) {
        if (versions.length <= 1 && versions[0].file.name === baseName) continue;

        versions.sort((a, b) => {
          const timeA = new Date(a.file.modifiedTime || 0).getTime();
          const timeB = new Date(b.file.modifiedTime || 0).getTime();
          const timeDiff = timeB - timeA;
          if (Math.abs(timeDiff) > 2000) {
            return timeDiff;
          }
          return b.version - a.version;
        });

        const winner = versions[0];
        const losers = versions.slice(1);

        if (losers.length > 0) {
          console.log(`[Deduplicador Drive] Grupo "${baseName}": Manteniendo última versión ${winner.file.name} (v${winner.version}), eliminando ${losers.length} copias obsoletas en Google Drive.`);
          for (const loser of losers) {
            await this.deleteDriveFile(loser.file.id, remoteFolderId);
            deleted++;
            if (manifest) {
              const loserRelPath = this.fs.join(relativePrefix, loser.file.name);
              delete manifest[loserRelPath];
              delete manifest[loser.file.name];
            }
          }
        }

        if (winner.file.name !== baseName) {
          console.log(`[Deduplicador Drive] Renombrando en Google Drive: ${winner.file.name} -> ${baseName}`);
          await this.renameDriveFile(winner.file.id, baseName, remoteFolderId);
          winner.file.name = baseName;
          renamed++;
          if (manifest) {
            const oldRelPath = this.fs.join(relativePrefix, winner.file.name);
            const newRelPath = this.fs.join(relativePrefix, baseName);
            if (manifest[oldRelPath]) {
              manifest[newRelPath] = manifest[oldRelPath];
              delete manifest[oldRelPath];
            } else {
              delete manifest[newRelPath];
            }
          }
        }
      }
      if (deleted > 0 || renamed > 0) {
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pairId || 'general',
          filename: 'Google Drive',
          action: 'cleaned',
          timestamp: Date.now(),
          details: `Eliminados ${deleted} duplicados remotos en Google Drive`
        }, true);
        if (manifest) await this.saveState();
      }
    } catch (e) {
      console.warn(`[Deduplicador Drive] Error en carpeta remota ${remoteFolderId}:`, e);
    }
    return { deleted, renamed };
  }

  // B4 Fix: Usar driveFetch para rate limiting y retry 5xx/429 (igual que Desktop)
  private async deleteDriveFile(fileId: string, parentId: string): Promise<void> {
    this.driveFolderCache.delete(parentId);
    if (!this.accessToken) return;
    try {
      await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
    } catch (err: any) {
      console.error(`[Drive] Error eliminando archivo ID ${fileId}:`, err.message || err);
    }
  }

  // B4 Fix: Usar driveFetch para rate limiting y retry 5xx/429 (igual que Desktop)
  private async renameDriveFile(fileId: string, newName: string, parentId: string): Promise<void> {
    this.driveFolderCache.delete(parentId);
    if (!this.accessToken) return;
    try {
      await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });
    } catch (err: any) {
      console.error(`[Drive] Error renombrando archivo ID ${fileId}:`, err.message || err);
    }
  }

  private async syncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = '') {
    if ((pair.status as string) === 'paused') return;

    // 0. PASO PREVIO: Deduplicar ANTES de listar y sincronizar.
    // Limpia copias intermedias y conserva únicamente la última versión renombrándola al nombre base,
    // evitando subir o descargar por la red todas las ediciones parciales anteriores.
    await this.deduplicateLocalFolder(localDir, pair.id, relativePrefix);
    await this.deduplicateDriveFolder(remoteFolderId, pair.id, relativePrefix);

    if ((pair.status as string) === 'paused') return;

    const remoteFiles = await this.listDriveFiles(remoteFolderId, true);
    let localEntries = await this.fs.readdir(localDir);

    console.log(`[SyncEngine/readdir] ${localDir}: ${localEntries.length} entradas encontradas (remoto: ${remoteFiles.length})`);
    if (localEntries.length === 0 && relativePrefix === '') {
      console.warn(`[SyncEngine] ¡ADVERTENCIA! La carpeta raíz local "${localDir}" está vacía o no se pudo leer. Verificar permisos de almacenamiento externo.`);
    }

    const pairManifest = this.manifests[pair.id] || {};

    // 1. UPLOAD / LOCAL CHANGES (Concurrencia y procesamiento por lotes)
    if (pair.direction === 'upload' || pair.direction === 'bidirectional') {
      const dirEntries = localEntries.filter(e => e.isDirectory && !matchesIgnorePattern(e.name, this.settings.ignoredPatterns));
      // Fix #7: Excluir stubs .vstream y placeholders de Google Docs para no subirlos a Drive
      const fileEntries = localEntries.filter(e => !e.isDirectory && !matchesIgnorePattern(e.name, this.settings.ignoredPatterns) && !e.name.endsWith('.vstream') && !e.name.endsWith('.gdoc') && !e.name.endsWith('.gsheet') && !e.name.endsWith('.gslides') && !e.name.endsWith('.syncmeta'));

      for (const entry of dirEntries) {
        if ((pair.status as string) === 'paused') return;
        const fullLocalPath = this.fs.join(localDir, entry.name);
        const relPath = this.fs.join(relativePrefix, entry.name);
        let remoteSubFolder = remoteFiles.find(f => f.name === entry.name && f.mimeType === 'application/vnd.google-apps.folder');
        if (!remoteSubFolder) {
          remoteSubFolder = await this.createDriveFolder(remoteFolderId, entry.name);
        }
        await this.syncDirectoryTree(fullLocalPath, remoteSubFolder.id, pair, relPath);
      }

      const uploadTasks = fileEntries.map(entry => async () => {
        if ((pair.status as string) === 'paused') return;
        const fullLocalPath = this.fs.join(localDir, entry.name);
        const stats = entry; // Optimización Capacitor: evitar IPC bridge stat redundante
        if (!stats) return;

        // --- Detectar si es un archivo numerado (rotman(8).pdf) ---
        // Si lo es, lo subimos como actualización del nombre base (rotman.pdf)
        const numberedMatch = entry.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
        const effectiveName = numberedMatch ? `${numberedMatch[1].trim()}.${numberedMatch[3]}` : entry.name;
        const isNumbered = !!numberedMatch;

        const relPath = this.fs.join(relativePrefix, effectiveName);
        const remoteFile = remoteFiles.find(f => f.name === effectiveName && f.mimeType !== 'application/vnd.google-apps.folder');
        const manifestEntry = pairManifest[relPath];

        const localMtime = stats.mtime;
        const remoteMtime = remoteFile ? new Date(remoteFile.modifiedTime).getTime() : 0;

        // Conflicto bilateral: ambos cambiaron desde la última sync → esperar intervención manual
        if (!isNumbered && manifestEntry && remoteFile &&
          localMtime > manifestEntry.localMtime + 5000 &&
          remoteMtime > manifestEntry.remoteMtime + 5000 &&
          this.settings.conflictResolution === 'prompt') {
          return;
        }

        let shouldUpload = false;
        const remoteSize = remoteFile ? parseInt((remoteFile as any).size || '0', 10) : -1;
        const isSizeIdentical = remoteFile && (stats.size === remoteSize || remoteFile.mimeType.startsWith('application/vnd.google-apps.'));

        if (isNumbered) {
          if (manifestEntry && Math.abs(localMtime - manifestEntry.localMtime) <= 3000) {
            shouldUpload = false;
          } else {
            shouldUpload = true;
          }
        } else if (!remoteFile) {
          shouldUpload = true;
        } else if (manifestEntry && Math.abs(localMtime - manifestEntry.localMtime) > 2000) {
          // Anti-bucle: si el manifest registra que el remoteMtime coincide con el actual
          // de Drive, significa que fuimos nosotros quienes subimos o sincronizamos este archivo
          // recientemente. No re-subir a menos que el contenido haya cambiado de tamaño.
          if (isSizeIdentical && Math.abs(remoteMtime - manifestEntry.remoteMtime) <= 2000) {
            // El archivo local cambió su mtime (p.ej. al ser escrito por una descarga previa)
            // pero el remoto es idéntico en tamaño y fecha. Actualizar localMtime en manifest
            // para no volver a detectarlo como cambio.
            pairManifest[relPath] = { ...manifestEntry, localMtime };
            shouldUpload = false;
          } else {
            shouldUpload = true;
          }
        } else if (!manifestEntry) {
          if (isSizeIdentical) {
            // Reenlace inteligente: el archivo ya existe en Drive con idéntico tamaño. No re-subir.
            pairManifest[relPath] = {
              localMtime,
              remoteMtime,
              remoteId: remoteFile.id
            };
            shouldUpload = false;
          } else if (localMtime > remoteMtime + 5000) {
            shouldUpload = true;
          }
        }

        if (shouldUpload) {
          const fileSize = stats.size || 0;
          const initialBytes = pair.progress?.bytesTransferred || 0;
          if (pair.progress) {
            pair.progress = {
              currentFile: isNumbered ? `${effectiveName} (nueva versión desde ${entry.name})` : entry.name,
              totalFiles: (pair.progress.totalFiles || 0) + 1,
              currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
              bytesTransferred: initialBytes,
              totalBytes: (pair.progress.totalBytes || 0) + fileSize,
              percentage: pair.progress.totalBytes > 0 ? Math.min(99, Math.round((initialBytes / (pair.progress.totalBytes + fileSize)) * 100)) : 0,
              action: 'subiendo'
            };
          }
          // Subir con el nombre efectivo (base), reportando el progreso en tiempo real por cada bloque de bytes
          const uploadedFile = await this.uploadDriveFile(
            remoteFolderId,
            fullLocalPath,
            effectiveName,
            remoteFile?.id,
            (loaded) => {
              if (pair.progress) {
                const currentTransferred = initialBytes + loaded;
                const tot = Math.max(pair.progress.totalBytes || 1, currentTransferred);
                pair.progress.bytesTransferred = currentTransferred;
                pair.progress.percentage = Math.min(99, Math.round((currentTransferred / tot) * 100));
              }
            }
          );
          if (pair.progress) {
            pair.progress.bytesTransferred = initialBytes + fileSize;
            pair.progress.percentage = pair.progress.totalBytes > 0 ? Math.min(100, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100)) : 100;
          }
          pairManifest[relPath] = {
            localMtime,
            remoteMtime: new Date(uploadedFile.modifiedTime).getTime(),
            remoteId: uploadedFile.id
          };
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: effectiveName,
            action: 'uploaded',
            timestamp: Date.now(),
            details: isNumbered
              ? `Nueva versión exportada (${formatBytes(fileSize)}) — ${entry.name} → ${effectiveName}`
              : `Subido (${formatBytes(fileSize)}) hacia Google Drive`
          }, true);
        }
      });
      // En móvil ejecutamos de 1 en 1 para evitar excesivo consumo de RAM en WebView (OOM crash)
      await this.runInPool(uploadTasks, 1);
    }

    // 2. DOWNLOAD / REMOTE CHANGES
    if (pair.direction === 'download' || pair.direction === 'bidirectional') {
      const remoteDirs = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder' && !matchesIgnorePattern(f.name, this.settings.ignoredPatterns));
      const remoteRegularFiles = remoteFiles.filter(f => f.mimeType !== 'application/vnd.google-apps.folder' && !matchesIgnorePattern(f.name, this.settings.ignoredPatterns));

      for (const remoteFile of remoteDirs) {
        if ((pair.status as string) === 'paused') return;
        const fullLocalPath = this.fs.join(localDir, remoteFile.name);
        const relPath = this.fs.join(relativePrefix, remoteFile.name);
        await this.fs.mkdir(fullLocalPath);
        if (pair.direction === 'download') {
          await this.syncDirectoryTree(fullLocalPath, remoteFile.id, pair, relPath);
        }
      }

      const downloadTasks = remoteRegularFiles.map(remoteFile => async () => {
        if ((pair.status as string) === 'paused') return;
        const fullLocalPath = this.fs.join(localDir, remoteFile.name);
        const relPath = this.fs.join(relativePrefix, remoteFile.name);
        const localEntry = localEntries.find(e => e.name === remoteFile.name);

        let shouldDownload = false;
        if (!localEntry) {
          shouldDownload = true;
        } else {
          const localStats = localEntry; // Optimización Capacitor: usar metadatos devueltos por readdir
          if (localStats) {
            const remoteTime = new Date(remoteFile.modifiedTime).getTime();
            const manifestEntry = pairManifest[relPath];
            const remoteSize = parseInt((remoteFile as any).size || '0', 10);
            const isSizeIdentical = localStats.size === remoteSize || remoteFile.mimeType.startsWith('application/vnd.google-apps.');

            if (manifestEntry && Math.abs(remoteTime - manifestEntry.remoteMtime) > 2000) {
              shouldDownload = true;
            } else if (!manifestEntry) {
              if (isSizeIdentical) {
                // Reenlace inteligente: el archivo ya existe localmente con idéntico tamaño. No descargar.
                pairManifest[relPath] = {
                  localMtime: localStats.mtime,
                  remoteMtime: remoteTime,
                  remoteId: remoteFile.id
                };
                shouldDownload = false;
              } else if (remoteTime > localStats.mtime + 5000) {
                shouldDownload = true;
              }
            }
          }
        }

        if (shouldDownload) {
          const fileSize = parseInt((remoteFile as any).size || '0', 10);
          const initialBytes = pair.progress?.bytesTransferred || 0;
          if (pair.progress) {
            pair.progress = {
              currentFile: remoteFile.name,
              totalFiles: (pair.progress.totalFiles || 0) + 1,
              currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
              bytesTransferred: initialBytes,
              totalBytes: (pair.progress.totalBytes || 0) + fileSize,
              percentage: pair.progress.totalBytes > 0 ? Math.min(99, Math.round((initialBytes / (pair.progress.totalBytes + fileSize)) * 100)) : 0,
              action: 'descargando'
            };
          }
          // B8 Fix: Pasar md5Checksum para verificación de integridad
          await this.downloadDriveFile(
            remoteFile.id,
            fullLocalPath,
            (loaded) => {
              if (pair.progress) {
                const currentTransferred = initialBytes + loaded;
                const tot = Math.max(pair.progress.totalBytes || 1, currentTransferred);
                pair.progress.bytesTransferred = currentTransferred;
                pair.progress.percentage = Math.min(99, Math.round((currentTransferred / tot) * 100));
              }
            },
            (remoteFile as any).md5Checksum
          );
          const updatedStats = await this.fs.stat(fullLocalPath);
          if (updatedStats) {
            const realSize = updatedStats.size || fileSize;
            if (pair.progress) {
              pair.progress.bytesTransferred = initialBytes + realSize;
              pair.progress.percentage = pair.progress.totalBytes > 0 ? Math.min(100, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100)) : 100;
            }
            const remoteTime = new Date(remoteFile.modifiedTime).getTime();
            // Anti-bucle: guardamos localMtime = remoteTime para que en el siguiente ciclo
            // de upload, el archivo recién descargado NO sea detectado como cambio local.
            // El mtime real del sistema de archivos puede diferir del remoto, pero son el mismo
            // contenido. Esto rompe el ciclo descarga→subida→descarga.
            pairManifest[relPath] = {
              localMtime: remoteTime,
              remoteMtime: remoteTime,
              remoteId: remoteFile.id
            };
            // B10 Fix #2: Escribir .syncmeta con el mtime remoto para que hasLocalFolderChanged
            // use el mtime lógico en lugar del mtime real del sistema de archivos (utimes no disponible en Capacitor).
            // Sin esto, el siguiente ciclo de polling detecta un falso cambio y re-dispara la descarga.
            await this.writeSyncmeta(fullLocalPath, remoteTime);
            this.addEvent({
              id: Math.random().toString(36).substr(2, 9),
              pairId: pair.id,
              filename: remoteFile.name,
              action: 'downloaded',
              timestamp: Date.now(),
              details: `Descargado (${formatBytes(realSize)}) hacia dispositivo`
            }, true);
          }
        }
      });
      await this.runInPool(downloadTasks, 1);
    }

    this.manifests[pair.id] = pairManifest;
    await this.saveState();
  }

  private addEvent(ev: SyncEvent, skipSave = false) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.pop();
    if (!skipSave) this.saveState();
  }

  // --- DRIVE API ---

  // Fix #3: Rate limiter — máximo 5 requests/segundo para respetar cuota de Google Drive
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.rateLimiter.lastRequest;
    if (elapsed < this.rateLimiter.minInterval) {
      await new Promise(r => setTimeout(r, this.rateLimiter.minInterval - elapsed));
    }
    this.rateLimiter.lastRequest = Date.now();
  }

  // Fix #3: Manejo de respuesta con retry para 429 (rate limit) y 5xx (errores de servidor)
  private async handleDriveResponse(res: Response, retryCount = 0): Promise<Response> {
    if (!res.ok) {
      if (res.status === 401) {
        console.warn('[SyncEngine] Token de Google Drive expirado o inválido (401).');
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      // Manejar 429 (rate limit) con exponential backoff
      if (res.status === 429 || res.status === 403) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
        const waitMs = Math.min(retryAfter * 1000, 32000);
        console.warn(`[SyncEngine] Rate limit (${res.status}). Esperando ${waitMs}ms antes de reintentar...`);
        await new Promise(r => setTimeout(r, waitMs));
        throw new Error('RATE_LIMITED_RETRY');
      }
      // Reintentar errores 5xx hasta 3 veces
      if (res.status >= 500 && retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.warn(`[SyncEngine] Error ${res.status} del servidor. Reintentando en ${delay}ms (intento ${retryCount + 1}/3)...`);
        await new Promise(r => setTimeout(r, delay));
        throw new Error('SERVER_ERROR_RETRY');
      }
      const text = await res.text();
      throw new Error(`Drive API error (${res.status}): ${text}`);
    }
    return res;
  }

  // Fix #3: Wrapper con rate limiting para llamadas fetch a Drive API
  private async driveFetch(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.rateLimit();
      const res = await fetch(url, options);
      try {
        return await this.handleDriveResponse(res, attempt);
      } catch (err: any) {
        if (err.message === 'RATE_LIMITED_RETRY' || err.message === 'SERVER_ERROR_RETRY') {
          if (attempt < maxRetries) continue;
          throw new Error(`Drive API: máximo de reintentos (${maxRetries}) alcanzado para ${url}`);
        }
        throw err;
      }
    }
    throw new Error(`Drive API: fallo inesperado en ${url}`);
  }

  private async listDriveFiles(folderId: string, forceRefresh = false): Promise<DriveFile[]> {
    const cached = this.driveFolderCache.get(folderId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp < 60000)) {
      return cached.files;
    }

    let files: DriveFile[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('q', `'${folderId}' in parents and trashed = false`);
      // B3 Fix: Incluir md5Checksum para verificación de integridad de descargas (violaba R6)
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink, etag, appProperties)');
      url.searchParams.append('pageSize', '1000');
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await this.driveFetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      const data: any = await res.json();
      if (data.files) files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);

    this.driveFolderCache.set(folderId, { timestamp: Date.now(), files });
    return files;
  }

  // B4 Fix: Usar driveFetch para rate limiting y retry 5xx/429 (igual que Desktop)
  private async createDriveFolder(parentId: string, name: string): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };

    const res = await this.driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    });
    return await res.json() as DriveFile;
  }

  // B8 Fix: Aceptar expectedMd5 para verificación de integridad (opcional)
  private async downloadDriveFile(
    fileId: string,
    destPath: string,
    onProgress?: (loaded: number, total: number) => void,
    expectedMd5?: string
  ): Promise<void> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    // Fix #8: Distinguir error 401 en downloadDriveFile para marcar sesión expirada
    if (res.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
    if (!res.ok) throw new Error(`Download failed HTTP ${res.status}`);

    const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);

    // --- Anti-OOM: streaming base64 sin acumular Blob ni DataURL en RAM ---
    // Convertimos cada chunk directamente a base64 sin pasar por Blob/FileReader.
    // Esto elimina el patrón de triple-copia (chunks[] + Blob + DataURL)
    // que causaba OutOfMemoryError en Android para archivos grandes.
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const base64Parts: string[] = [];
      let leftover: Uint8Array | null = null; // bytes sobrantes para alineación de 3 en 3
      let loaded = 0;

      const uint8ToBase64 = (bytes: Uint8Array): string => {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        loaded += value.length;
        if (onProgress && totalBytes > 0) onProgress(loaded, totalBytes);

        // Combinar sobrante anterior con el nuevo chunk
        let chunk: Uint8Array;
        if (leftover && leftover.length > 0) {
          const combined = new Uint8Array(leftover.length + value.length);
          combined.set(leftover);
          combined.set(value, leftover.length);
          chunk = combined;
          leftover = null;
        } else {
          chunk = value;
        }

        // Codificar solo múltiplos de 3 bytes para evitar padding incorrecto entre chunks
        const remainder = chunk.length % 3;
        const alignedEnd = chunk.length - remainder;
        if (alignedEnd > 0) {
          base64Parts.push(uint8ToBase64(chunk.slice(0, alignedEnd)));
        }
        if (remainder > 0) {
          leftover = chunk.slice(alignedEnd);
        }
      }

      // Codificar los bytes sobrantes finales (con padding correcto)
      if (leftover && leftover.length > 0) {
        base64Parts.push(uint8ToBase64(leftover));
      }

      const base64 = base64Parts.join('');
      // B1/B6: Marcar archivo como auto-escrito para que hasLocalFolderChanged lo ignore
      this.markSelfWritten(destPath);
      await this.fs.writeFile(destPath, base64, true);
      // B10: Escribir .syncmeta con el mtime remoto del archivo (utimes no disponible en Capacitor)
      // El caller (syncDirectoryTree) ya conoce el remoteTime y lo escribe en el manifiesto.
      // Aquí no tenemos acceso al remoteTime, así que el caller debe llamar writeSyncmeta.
    } else {
      // Fallback para entornos sin ReadableStream (raro en Android moderno)
      let blob: Blob | null = await res.blob();
      const dataUrl: string = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob!);
      });
      blob = null;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx !== -1 ? dataUrl.substring(commaIdx + 1) : dataUrl;
      this.markSelfWritten(destPath);
      await this.fs.writeFile(destPath, base64, true);
    }
  }

  private async uploadDriveFile(
    parentId: string,
    filePath: string,
    name: string,
    existingId?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    let contentBase64: string | null = await this.fs.readFile(filePath, true);

    // Optimización RAM y Red: convertir de Base64 a datos binarios puros (Blob)
    const binaryString = atob(contentBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    if (blob.size > 50 * 1024 * 1024) {
      console.warn(`[Anti-OOM/Android] Subiendo archivo masivo (${Math.round(blob.size / 1024 / 1024)} MB) vía Resumable Upload.`);
    }
    const metadata = existingId ? { name } : { name, parents: [parentId] };

    // Protocolo Resumable Upload con XHR (permite seguimiento de progreso continuo en % de red)
    try {
      const initUrl = existingId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink';

      const initRes = await fetch(initUrl, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': blob.size.toString()
        },
        body: JSON.stringify(metadata)
      });

      if (initRes.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      const sessionUri = initRes.headers.get('Location');

      if (sessionUri && initRes.ok) {
        contentBase64 = null; // Liberar string Base64 inmediatamente

        return await new Promise<DriveFile>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', sessionUri);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');

          if (onProgress && blob.size > 0) {
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                onProgress(e.loaded, e.total);
              }
            };
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText) as DriveFile);
              } catch (err) {
                reject(err);
              }
            } else {
              reject(new Error(`Resumable upload failed HTTP ${xhr.status}`));
            }
          };

          xhr.onerror = () => reject(new Error('Network error during file upload'));
          xhr.send(blob);
        });
      }
    } catch (e: any) {
      if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
      console.warn('[SyncEngine] Fallback a multipart upload tras intento resumable:', e.message);
    }

    // Fallback a multipart para compatibilidad si el resumable falló
    if (!contentBase64) contentBase64 = await this.fs.readFile(filePath, true);
    const boundary = '-------SyncClientBoundary' + Math.random().toString(36);
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${contentBase64}\r\n`,
      `--${boundary}--\r\n`
    ].join('');
    contentBase64 = null;

    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

    const res = await fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
    // Fix #5: Verificar res.ok en fallback multipart para detectar 401/403/429/5xx
    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unable to read error body');
      if (res.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      if (res.status === 429 || res.status === 403) {
        console.warn(`[SyncEngine] Rate limit (${res.status}) en multipart upload.`);
        throw new Error('RATE_LIMITED_RETRY');
      }
      throw new Error(`Multipart upload failed HTTP ${res.status}: ${errText}`);
    }
    return await res.json();
  }
}
