import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { IFileSystem } from '../utils/fileSystem';
import { CoreSyncLogic, ANDROID_STARNOTE_BASE, ANDROID_STARNOTE_EXPORT, DEFAULT_REMOTE_PATH, RemoteEntry, SyncPlan, SyncStateSnapshot } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, SyncJournalEntry } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager, VectorClock } from '../shared/VectorClock';
import { scanChanges, computeBlockHashes, lazyHashBatch, isMtimeChanged, hasContentChanged, verifyReadWriteAccess, LocalEntry, ScanResult } from '../shared/Scanner';
import { Md5 } from '../shared/md5';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  md5Checksum?: string;
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
  private rateLimitQueue: Promise<void> = Promise.resolve();

  // --- v2: Database-backed state ---
  private db: IStorageBackend | null = null;
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
      const mtime = typeof parsed.remoteMtime === 'number' && Number.isFinite(parsed.remoteMtime)
        ? parsed.remoteMtime
        : null;
      if (mtime !== null) this.syncmetaCache.set(filePath, mtime);
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
      this.markSelfWritten(metaPath);
      await this.fs.writeFile(metaPath, JSON.stringify({ remoteMtime }));
    } catch {
      // Ignorar errores de escritura de metadata
    }
  }

  private async removeSyncmeta(filePath: string): Promise<void> {
    this.syncmetaCache.delete(filePath);
    const metaPath = filePath + '.syncmeta';
    this.markSelfWritten(metaPath);
    await this.fs.rm(metaPath).catch(() => { });
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
    if (typeof document !== 'undefined') {
      try {
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
        console.warn('[SyncEngine] No se pudo verificar permisos de almacenamiento:', permErr?.message || permErr);
      }

      await this.fs.mkdir(this.configDir);

      // v2: Inicializar DB backend (solo en Capacitor/Android, no en navegador)
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          this.db = await createBackend(this.configDir, this.fs);
          if (this.db) {
            // v2: Usar getOrCreateDeviceId() en lugar de crypto.randomUUID()
            const deviceResult = await getOrCreateDeviceId(this.db);
            this.DEVICE_ID = deviceResult.deviceId;
            console.log(`[SyncEngine] v2 DB initialized, device: ${this.DEVICE_ID}`);

            // Migrar manifests a DB si existen
            try {
              const data = await this.fs.readFile(this.configFile);
              if (data) {
                const parsed = JSON.parse(data);
                const jsonManifests = parsed.manifests as Record<string, Record<string, ManifestEntry>> | undefined;
                if (jsonManifests && Object.keys(jsonManifests).length > 0) {
                  let hasDbData = false;
                  for (const pairId of Object.keys(jsonManifests)) {
                    const folderState = this.db.getFolderState(pairId);
                    if (folderState.size > 0) {
                      hasDbData = true;
                      break;
                    }
                  }
                  if (!hasDbData) {
                    for (const [pairId, entries] of Object.entries(jsonManifests)) {
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
                    console.log(`[SyncEngine] Migrated ${Object.keys(jsonManifests).length} pairs from JSON to SQLite`);
                  }
                }
              }
            } catch { /* no config file yet */ }
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
          if (parsed.manifests && !this.db) this.manifests = parsed.manifests;
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
    this.saveState();
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

  // Fix #11: Comprobación recursiva que detecta cambios en subcarpetas
  private async hasLocalFolderChanged(pair: SyncPair): Promise<boolean> {
    const pairManifest = this.manifests[pair.id] || {};

    const scanDir = async (dirPath: string, relPrefix: string): Promise<boolean> => {
      try {
        const entries = await this.fs.readdir(dirPath);
        if (!entries) return false;

        for (const entry of entries) {
          const relPath = this.fs.join(relPrefix, entry.name);
          if (entry.isDirectory) {
            const subDir = this.fs.join(dirPath, entry.name);
            const changed = await scanDir(subDir, relPath);
            if (changed) return true;
          } else {
            const manifestEntry = pairManifest[relPath] || pairManifest[entry.name];
            if (!manifestEntry) return true;
            const stat = await this.fs.stat(this.fs.join(dirPath, entry.name));
            const localMtime = stat?.mtime ?? 0;
            if (localMtime && Math.abs(localMtime - manifestEntry.localMtime) > 2000) {
              return true;
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

      if (Object.keys(pairManifest).length === 0 && fileEntries.length > 0) return true;

      return await scanDir(pair.localPath, '');
    } catch {
      return false;
    }
  }

  // B1/B6: Polling adaptativo
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

      // v2: Usar feature flag para elegir implementación
      if (USE_V2_SYNC && this.db && this.DEVICE_ID) {
        await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
      } else {
        if (!this.manifests[pair.id]) {
          this.manifests[pair.id] = {};
        }
        await this.syncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
      }

      if ((pair.status as string) === 'paused') {
        console.log(`[SyncEngine] Sincronización pausada por el usuario durante el ciclo para ${pair.localPath}. Abortando.`);
        pair.progress = null;
        await this.saveState();
        return;
      }

      pair.lastSynced = Date.now();
      pair.status = 'idle';

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

  // ─── v2: SyncDirectoryTree con 5 fases ─────────────────────────

  private async v2SyncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = '') {
    if (!this.db || !this.DEVICE_ID) return;

    // FASE 0: Reconciliación HTTP 304 (optimistic locking)
    await this.reconcileWithHttp304(pair.id, remoteFolderId);

    // FASE 1: Tomar fotografías
    const dbState = this.db.getFolderState(pair.id);

    // 1a. Escaneo local incremental
    const scanResult = await scanChanges(localDir, dbState, this.fs, pair.id);
    if (scanResult === 'PERMISSION_DENIED') {
      console.error(`[v2Sync] Permission denied in ${localDir}, aborting sync`);
      pair.status = 'error' as any;
      return;
    }

    // 1b. Listar archivos remotos con appProperties
    const remoteFiles = await this.listDriveFiles(remoteFolderId, true);

    // Construir snapshots
    const localSnapshot = new Map<string, { name: string; mtime: number; size: number }>();
    for (const [relPath, entry] of scanResult.changed) {
      localSnapshot.set(relPath, { name: entry.name, mtime: entry.mtime, size: entry.size });
    }
    for (const [relPath, entry] of scanResult.created) {
      localSnapshot.set(relPath, { name: entry.name, mtime: entry.mtime, size: entry.size });
    }

    const remoteSnapshot = new Map<string, RemoteEntry>();
    for (const file of remoteFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      remoteSnapshot.set(file.name, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        size: file.size,
        md5Checksum: file.md5Checksum,
        appProperties: file.appProperties,
        etag: undefined
      });
    }

    // FASE 3: Computar plan con three-way merge
    const dbStateForPlan = new Map<string, SyncStateSnapshot>();
    for (const [relPath, state] of dbState) {
      dbStateForPlan.set(relPath, {
        localMtime: state.local_mtime || 0,
        remoteMtime: state.remote_mtime || 0,
        remoteId: state.remote_id || '',
        fileSize: state.file_size,
        vectorClock: state.vector_clock
      });
    }
    const plan = CoreSyncLogic.computeSyncPlan(localSnapshot, remoteSnapshot, dbStateForPlan, this.DEVICE_ID);

    // FASE 4: Ejecutar plan con WAL journal
    // 4a. Uploads
    for (const upload of plan.uploads) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = this.fs.join(localDir, upload.localPath);
      const journalId = this.db.journalStart(pair.id, 'upload_start', upload.localPath, upload.remoteId);
      try {
        const stats = await this.fs.stat(fullLocalPath);
        if (!stats) {
          this.db.journalFail(journalId);
          continue;
        }
        const fileSize = stats.size || 0;
        if (pair.progress) {
          pair.progress = {
            currentFile: upload.remoteName,
            totalFiles: (pair.progress.totalFiles || 0) + 1,
            currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
            bytesTransferred: (pair.progress.bytesTransferred || 0),
            totalBytes: (pair.progress.totalBytes || 0) + fileSize,
            percentage: 50,
            action: 'subiendo'
          };
        }
        await this.uploadDriveFile(remoteFolderId, fullLocalPath, upload.remoteName, upload.remoteId, undefined, upload.vectorClock);
        this.db.journalDone(journalId);
        if (pair.progress) {
          pair.progress.bytesTransferred = (pair.progress.bytesTransferred || 0) + fileSize;
        }
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: upload.remoteName,
          action: 'uploaded',
          timestamp: Date.now(),
          details: `Subido (${formatBytes(fileSize)})`
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
        console.error(`[v2Sync] Upload failed: ${upload.remoteName}`, e.message || e);
      }
    }

    // 4b. Downloads
    const downloadedLocalMtimes = new Map<string, number>();
    for (const download of plan.downloads) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = this.fs.join(localDir, download.localPath);
      const journalId = this.db.journalStart(pair.id, 'download_start', download.localPath, download.remoteFile.id);
      try {
        const fileSize = parseInt(download.remoteFile.size || '0', 10);
        if (pair.progress) {
          pair.progress = {
            currentFile: download.remoteFile.name,
            totalFiles: (pair.progress.totalFiles || 0) + 1,
            currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
            bytesTransferred: (pair.progress.bytesTransferred || 0),
            totalBytes: (pair.progress.totalBytes || 0) + fileSize,
            percentage: 50,
            action: 'descargando'
          };
        }
        const remoteTime = new Date(download.remoteFile.modifiedTime).getTime();
        await this.downloadDriveFile(download.remoteFile.id, fullLocalPath, undefined, download.remoteFile.md5Checksum);
        this.markSelfWritten(fullLocalPath);
        await this.writeSyncmeta(fullLocalPath, remoteTime);
        const downloadedStats = await this.fs.stat(fullLocalPath);
        downloadedLocalMtimes.set(download.localPath, downloadedStats?.mtime ?? Date.now());
        this.db.journalDone(journalId);
        if (pair.progress) {
          pair.progress.bytesTransferred = (pair.progress.bytesTransferred || 0) + fileSize;
        }
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: download.remoteFile.name,
          action: 'downloaded',
          timestamp: Date.now(),
          details: `Descargado (${formatBytes(fileSize)})`
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
        console.error(`[v2Sync] Download failed: ${download.remoteFile.name}`, e.message || e);
      }
    }

    // 4c. Deletes
    for (const del of plan.deleteLocal) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = this.fs.join(localDir, del.localPath);
      const journalId = this.db.journalStart(pair.id, 'delete_local_start', del.localPath);
      try {
        this.markSelfWritten(fullLocalPath);
        await this.fs.rm(fullLocalPath).catch(() => { });
        await this.removeSyncmeta(fullLocalPath);
        this.db.journalDone(journalId);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: del.localPath,
          action: 'deleted',
          timestamp: Date.now(),
          details: 'Eliminado localmente'
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
      }
    }

    for (const del of plan.deleteRemote) {
      if ((pair.status as string) === 'paused') return;
      const journalId = this.db.journalStart(pair.id, 'delete_remote_start', del.remoteId, del.remoteId);
      try {
        await this.deleteDriveFile(del.remoteId, remoteFolderId);
        this.db.journalDone(journalId);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: del.remoteId,
          action: 'deleted',
          timestamp: Date.now(),
          details: 'Eliminado en Drive'
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        console.error(`[v2Sync] Remote delete failed: ${del.remoteId}`, e.message || e);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: del.remoteId,
          action: 'info',
          timestamp: Date.now(),
          details: `No se pudo eliminar en Drive: ${e.message || e}`
        }, true);
      }
    }

    // FASE 5: Actualizar DB (atómico)
    const updates = new Map<string, FileState>();
    const now = Date.now();

    for (const upload of plan.uploads) {
      updates.set(upload.localPath, {
        pair_id: pair.id, rel_path: upload.localPath,
        remote_id: upload.remoteId || null, local_mtime: now, remote_mtime: now,
        file_size: null, md5_hash: null, block_hashes: null,
        vector_clock: upload.vectorClock,
        device_id: this.DEVICE_ID, etag: null,
        updated_at: now, is_tombstone: 0
      });
    }

    for (const download of plan.downloads) {
      updates.set(download.localPath, {
        pair_id: pair.id, rel_path: download.localPath,
        remote_id: download.remoteFile.id, local_mtime: downloadedLocalMtimes.get(download.localPath) ?? now, remote_mtime: new Date(download.remoteFile.modifiedTime).getTime(),
        file_size: download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : null,
        md5_hash: download.remoteFile.md5Checksum || null, block_hashes: null,
        vector_clock: download.vectorClock,
        device_id: this.DEVICE_ID, etag: null,
        updated_at: now, is_tombstone: 0
      });
    }

    for (const del of plan.deleteLocal) {
      updates.set(del.localPath, {
        pair_id: pair.id, rel_path: del.localPath,
        remote_id: del.remoteId || null, local_mtime: null, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null,
        vector_clock: '{}', device_id: this.DEVICE_ID, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    // Procesar subcarpetas recursivamente
    const subDirs = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const localDirs = await this.fs.readdir(localDir).catch(() => [] as any[]);
    const dirNames = new Set<string>();
    if (Array.isArray(localDirs)) {
      for (const dir of localDirs) {
        const name = typeof dir === 'string' ? dir : dir?.name;
        if (name) dirNames.add(name);
      }
    }
    for (const dir of remoteFiles) {
      if (dir.mimeType === 'application/vnd.google-apps.folder') dirNames.add(dir.name);
    }

    for (const dirName of dirNames) {
      if ((pair.status as string) === 'paused') return;
      const subDir = this.fs.join(localDir, dirName);
      const subPrefix = this.fs.join(relativePrefix, dirName);
      const subRemoteFolder = subDirs.find(d => d.name === dirName);
      if (subRemoteFolder) {
        await this.fs.mkdir(subDir).catch(() => { });
        await this.v2SyncDirectoryTree(subDir, subRemoteFolder.id, pair, subPrefix);
      }
    }

    // Guardar en DB
    if (updates.size > 0) {
      this.db.updateBatch(pair.id, updates);
    }

    // Limpiar sync_journal de operaciones completadas
    this.db.vacuum();
  }

  /**
   * Fase 0: Reconciliación HTTP 304.
   * Usa If-Modified-Since (etag no disponible en list de Drive API v3)
   */
  private async reconcileWithHttp304(pairId: string, remoteFolderId: string): Promise<void> {
    if (!this.db || !this.accessToken) return;

    const dbState = this.db.getFolderState(pairId);
    const pendingDeletes: string[] = [];

    for (const [relPath, state] of dbState) {
      if (!state.remote_id) continue;
      if (state.is_tombstone) continue;

      try {
        const modifiedSince = state.remote_mtime
          ? new Date(state.remote_mtime).toUTCString()
          : undefined;

        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.accessToken}`
        };
        if (modifiedSince) {
          headers['If-Modified-Since'] = modifiedSince;
        }

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${state.remote_id}?fields=modifiedTime,md5Checksum,size`, {
          method: 'GET',
          headers
        });

        if (res.status === 304) {
          continue;
        }

        if (res.status === 404) {
          pendingDeletes.push(relPath);
          continue;
        }

        if (res.status === 401) {
          throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
        }

        if (res.ok) {
          const data = await res.json();
          const updatedState: FileState = {
            ...state,
            remote_mtime: new Date(data.modifiedTime).getTime(),
            md5_hash: data.md5Checksum || state.md5_hash,
            file_size: data.size ? parseInt(data.size, 10) : state.file_size,
            updated_at: Date.now()
          };
          this.db.setFileState(pairId, relPath, updatedState);
        }
      } catch (e: any) {
        if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
        console.warn(`[HTTP 304] Error reconciliando ${relPath}:`, e.message || e);
      }
    }

    for (const relPath of pendingDeletes) {
      const state = this.db.getFileState(pairId, relPath);
      if (state) {
        state.is_tombstone = 1;
        state.updated_at = Date.now();
        this.db.setFileState(pairId, relPath, state);
      }
    }
  }

  // ─── Legacy syncDirectoryTree ────────────────────────────────────

  /**
   * Deduplica exportaciones automáticas (ej. de StarNote)
   */
  private async deduplicateLocalFolder(localDir: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> {
    let deleted = 0;
    let renamed = 0;
    try {
      const entries = await this.fs.readdir(localDir);
      if (!entries) return { deleted, renamed };
      const files = entries.filter(e => !e.isDirectory);
      if (files.length === 0) return { deleted, renamed };

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
            this.markSelfWritten(filePath);
            await this.fs.rm(filePath).catch(() => { });
            await this.removeSyncmeta(filePath);
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
          this.markSelfWritten(oldPath);
          this.markSelfWritten(newPath);
          await this.fs.rename(oldPath, newPath).catch(err => console.error(`Error renombrando ${oldPath}:`, err));
          const oldMeta = oldPath + '.syncmeta';
          const newMeta = newPath + '.syncmeta';
          const cachedMeta = this.syncmetaCache.get(oldPath);
          this.syncmetaCache.delete(oldPath);
          if (cachedMeta !== undefined) this.syncmetaCache.set(newPath, cachedMeta);
          this.markSelfWritten(oldMeta);
          this.markSelfWritten(newMeta);
          await this.fs.rename(oldMeta, newMeta).catch(() => { });
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

  // B4 Fix: Usar driveFetch para rate limiting y retry 5xx/429
  private async deleteDriveFile(fileId: string, parentId: string): Promise<void> {
    this.driveFolderCache.delete(parentId);
    if (!this.accessToken) throw new Error('No OAuth access token set');
    await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
  }

  // B4 Fix: Usar driveFetch para rate limiting y retry 5xx/429
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

    // 1. UPLOAD / LOCAL CHANGES
    if (pair.direction === 'upload' || pair.direction === 'bidirectional') {
      const dirEntries = localEntries.filter(e => e.isDirectory && !matchesIgnorePattern(e.name, this.settings.ignoredPatterns));
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
        const stats = entry;
        if (!stats) return;

        const numberedMatch = entry.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
        const effectiveName = numberedMatch ? `${numberedMatch[1].trim()}.${numberedMatch[3]}` : entry.name;
        const isNumbered = !!numberedMatch;

        const relPath = this.fs.join(relativePrefix, effectiveName);
        const remoteFile = remoteFiles.find(f => f.name === effectiveName && f.mimeType !== 'application/vnd.google-apps.folder');
        const manifestEntry = pairManifest[relPath];

        const localMtime = stats.mtime;
        const remoteMtime = remoteFile ? new Date(remoteFile.modifiedTime).getTime() : 0;

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
          if (isSizeIdentical && Math.abs(remoteMtime - manifestEntry.remoteMtime) <= 2000) {
            pairManifest[relPath] = { ...manifestEntry, localMtime };
            shouldUpload = false;
          } else {
            shouldUpload = true;
          }
        } else if (!manifestEntry) {
          if (isSizeIdentical) {
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
          const localStats = localEntry;
          if (localStats) {
            const remoteTime = new Date(remoteFile.modifiedTime).getTime();
            const manifestEntry = pairManifest[relPath];
            const remoteSize = parseInt((remoteFile as any).size || '0', 10);
            const isSizeIdentical = localStats.size === remoteSize || remoteFile.mimeType.startsWith('application/vnd.google-apps.');

            const sidecarRemoteTime = manifestEntry ? null : await this.readSyncmeta(fullLocalPath);
            const remoteBaseline = manifestEntry?.remoteMtime ?? sidecarRemoteTime ?? localStats.mtime;
            if (Math.abs(remoteTime - remoteBaseline) > 2000) {
              shouldDownload = true;
            } else if (!manifestEntry) {
              if (isSizeIdentical) {
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
            pairManifest[relPath] = {
              localMtime: updatedStats.mtime,
              remoteMtime: remoteTime,
              remoteId: remoteFile.id
            };
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

  private async rateLimit(): Promise<void> {
    let release!: () => void;
    const previous = this.rateLimitQueue;
    this.rateLimitQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const elapsed = Date.now() - this.rateLimiter.lastRequest;
      if (elapsed < this.rateLimiter.minInterval) {
        await new Promise(r => setTimeout(r, this.rateLimiter.minInterval - elapsed));
      }
      this.rateLimiter.lastRequest = Date.now();
    } finally {
      release();
    }
  }

  private async handleDriveResponse(res: Response, retryCount = 0): Promise<Response> {
    if (!res.ok) {
      if (res.status === 401) {
        console.warn('[SyncEngine] Token de Google Drive expirado o inválido (401).');
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      // v2: Manejar 412 (Precondition Failed) — conflicto de versión
      if (res.status === 412) {
        console.warn('[SyncEngine] Precondition Failed (412) — conflicto de versión detectado.');
        throw new Error('DRIVE_PRECONDITION_FAILED_412');
      }
      // v2: Manejar 304 (Not Modified) — no es error
      if (res.status === 304) {
        return res;
      }
      if (res.status === 429 || res.status === 403) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
        const waitMs = Math.min(retryAfter * 1000, 32000);
        console.warn(`[SyncEngine] Rate limit (${res.status}). Esperando ${waitMs}ms antes de reintentar...`);
        await new Promise(r => setTimeout(r, waitMs));
        throw new Error('RATE_LIMITED_RETRY');
      }
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

  private async driveFetch(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.rateLimit();
        const res = await fetch(url, options);
        return await this.handleDriveResponse(res, attempt);
      } catch (err: any) {
        const retryable = err.message === 'RATE_LIMITED_RETRY' ||
          err.message === 'SERVER_ERROR_RETRY' ||
          /(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed)/i.test(err.message || '');
        if (retryable) {
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
      // v2: etag no es un campo seleccionable de Drive API v3 — usar appProperties para vector clocks
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink, appProperties)');
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

  private async downloadDriveFile(
    fileId: string,
    destPath: string,
    onProgress?: (loaded: number, total: number) => void,
    expectedMd5?: string
  ): Promise<void> {
    const toBase64 = (bytes: Uint8Array): string => {
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    };
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const temporaryPath = `${destPath}.syncclient-download`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.markSelfWritten(temporaryPath);
        await this.fs.rm(temporaryPath).catch(() => { });
        const res = await this.driveFetch(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` }
        }, 0);
        const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
        const hasher = expectedMd5 ? new Md5() : null;
        let loaded = 0;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.length === 0) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            hasher?.update(chunk);
            this.markSelfWritten(temporaryPath);
            await this.fs.appendFile(temporaryPath, toBase64(chunk), true);
            loaded += chunk.length;
            if (onProgress) onProgress(loaded, totalBytes);
          }
        } else {
          // Older WebViews may not expose ReadableStream; keep this bounded to
          // one response only and use the normal streaming path when available.
          const bytes = new Uint8Array(await res.arrayBuffer());
          hasher?.update(bytes);
          this.markSelfWritten(temporaryPath);
          await this.fs.appendFile(temporaryPath, toBase64(bytes), true);
          loaded = bytes.length;
          if (onProgress) onProgress(loaded, totalBytes || loaded);
        }
        if (hasher && hasher.digest().toLowerCase() !== expectedMd5!.toLowerCase()) {
          throw new Error('DOWNLOAD_CHECKSUM_MISMATCH');
        }
        this.markSelfWritten(destPath);
        await this.fs.rm(destPath).catch(() => { });
        await this.fs.rename(temporaryPath, destPath);
        this.markSelfWritten(destPath);
        return;
      } catch (error: any) {
        this.markSelfWritten(temporaryPath);
        await this.fs.rm(temporaryPath).catch(() => { });
        if (error.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw error;
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  private async uploadDriveFile(
    parentId: string,
    filePath: string,
    name: string,
    existingId?: string,
    onProgress?: (loaded: number, total: number) => void,
    vectorClock?: string
  ): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    const stats = await this.fs.stat(filePath);
    if (!stats) throw new Error(`Unable to stat upload source: ${filePath}`);
    const fileSize = stats.size || 0;
    const mimeType = 'application/octet-stream';
    const chunkSize = 8 * 1024 * 1024;
    const appProperties = vectorClock
      ? VectorClockManager.toAppProperties(VectorClockManager.fromString(vectorClock))
      : undefined;
    const metadata = existingId
      ? { name, ...(appProperties ? { appProperties } : {}) }
      : { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
    const initUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink,md5Checksum`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink,md5Checksum';
    const initRes = await this.driveFetch(initUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': fileSize.toString()
      },
      body: JSON.stringify(metadata)
    });
    const sessionUri = initRes.headers.get('Location');
    if (!sessionUri) throw new Error('Drive resumable upload did not return a session');

    let contentBase64: string | null = null;
    if (!this.fs.readFileChunk && fileSize > 5 * 1024 * 1024) {
      throw new Error('Streaming file reader unavailable for large Android upload');
    }
    const decodeBase64 = (encoded: string): Uint8Array => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
    const readChunk = async (offset: number, length: number): Promise<Uint8Array> => {
      if (this.fs.readFileChunk) {
        const chunk = await this.fs.readFileChunk(filePath, offset, length);
        return decodeBase64(chunk.data);
      }
      contentBase64 ??= await this.fs.readFile(filePath, true);
      const encodedStart = Math.floor(offset / 3) * 4;
      const encodedEnd = Math.min(contentBase64.length, Math.ceil((offset + length) / 3) * 4);
      const decoded = decodeBase64(contentBase64.slice(encodedStart, encodedEnd));
      const startInDecoded = offset - Math.floor(offset / 3) * 3;
      return decoded.subarray(startInDecoded, startInDecoded + Math.min(length, fileSize - offset));
    };
    let offset = 0;
    if (fileSize === 0) {
      await this.rateLimit();
      const result = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': mimeType,
          'Content-Length': '0',
          'Content-Range': 'bytes */0'
        },
        body: new Uint8Array(0) as any
      });
      if (!result.ok) throw new Error(`Resumable upload failed HTTP ${result.status}`);
      return await result.json() as DriveFile;
    }
    while (offset < fileSize) {
      const bytes = await readChunk(offset, Math.min(chunkSize, fileSize - offset));
      if (bytes.length === 0) throw new Error('Upload source returned an empty chunk');
      const end = offset + bytes.length - 1;
      let completed = false;
      for (let attempt = 0; attempt < 4 && !completed; attempt++) {
        try {
          await this.rateLimit();
          const response = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': mimeType,
              'Content-Length': bytes.length.toString(),
              'Content-Range': `bytes ${offset}-${end}/${fileSize}`
            },
            body: bytes as any
          });
          if (response.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
          if (response.status === 308) {
            const range = response.headers.get('Range')?.match(/bytes=0-(\d+)/);
            offset = range ? parseInt(range[1], 10) + 1 : end + 1;
            completed = true;
          } else if (response.ok) {
            onProgress?.(fileSize, fileSize);
            contentBase64 = null;
            return await response.json() as DriveFile;
          } else if (response.status === 429 || response.status === 403 || response.status >= 500) {
            if (attempt === 3) throw new Error(`Resumable upload failed HTTP ${response.status}`);
            const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
            const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 32000) : Math.min(1000 * Math.pow(2, attempt), 32000);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw new Error(`Resumable upload failed HTTP ${response.status}`);
          }
        } catch (error: any) {
          if (error.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw error;
          if (attempt === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 32000)));
        }
      }
      onProgress?.(offset, fileSize);
    }
    throw new Error('Resumable upload ended without a Drive response');
  }
}