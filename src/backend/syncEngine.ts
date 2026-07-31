import fs from 'fs/promises';
import fsSync from 'fs';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import chokidar, { FSWatcher } from 'chokidar';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { CoreSyncLogic, RemoteEntry, SyncPlan, SyncStateSnapshot } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, SyncJournalEntry } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager, VectorClock } from '../shared/VectorClock';
import { scanChanges, computeBlockHashes, lazyHashBatch, isMtimeChanged, hasContentChanged, verifyReadWriteAccess, LocalEntry, ScanResult } from '../shared/Scanner';

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

class SyncEngine {
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
  private configDir = path.join(os.homedir(), '.config', 'syncclient');
  private configFile = path.join(this.configDir, 'sync_data.json');

  private watchers: Record<string, FSWatcher> = {};
  private activeSyncs = new Set<string>();
  private pendingSyncs = new Set<string>();
  private debounceTimers: Record<string, NodeJS.Timeout> = {};
  private intervalRefs: Record<string, NodeJS.Timeout> = {};
  private detectedExternalDrives: ExternalDriveAlert[] = [];
  private externalMonitorInterval: NodeJS.Timeout | null = null;
  private driveFolderCache = new Map<string, { timestamp: number; files: DriveFile[] }>();

  // --- v2: Database-backed state ---
  private db: IStorageBackend | null = null;
  private DEVICE_ID: string | null = null;

  // B1/B6: Anti-bucle — portado del motor Android
  private selfWrittenFiles = new Map<string, number>();
  private lastSyncCompleted: Record<string, number> = {};
  private syncBackoff: Record<string, number> = {};
  private syncTriggerSource: Record<string, 'fs-event' | 'poll' | 'manual'> = {};
  private readonly SYNC_COOLDOWN_MS = 60000;
  private readonly MAX_POLL_INTERVAL_MS = 900000;
  private readonly INITIAL_POLL_MS = 30000;
  private readonly DRIVE_MAX_ATTEMPTS = 3;
  private readonly DRIVE_MIN_REQUEST_INTERVAL_MS = 200;
  private driveRequestTail: Promise<void> = Promise.resolve();
  private nextDriveRequestAt = 0;

  private async runInPool<T>(tasks: (() => Promise<T>)[], concurrency = 3): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err: any) {
          console.error(`[SyncEngine/BackendPool] Error en tarea concurrente:`, err.message || err);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async waitForDriveSlot(): Promise<void> {
    let release!: () => void;
    const previous = this.driveRequestTail;
    this.driveRequestTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, this.nextDriveRequestAt - Date.now());
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.nextDriveRequestAt = Date.now() + this.DRIVE_MIN_REQUEST_INTERVAL_MS;
    } finally {
      release();
    }
  }

  private isTransientDriveStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async driveRequest(
    url: string,
    init: RequestInit & { duplex?: 'half' },
    maxAttempts = this.DRIVE_MAX_ATTEMPTS
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = Math.min(32000, 1000 * (2 ** (attempt - 2)));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        await this.waitForDriveSlot();
        const response = await fetch(url, init);
        if (!this.isTransientDriveStatus(response.status) || attempt === maxAttempts) {
          return response;
        }
        await response.body?.cancel().catch(() => { });
        lastError = new Error(`Drive API transient error (${response.status})`);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Drive API request failed');
  }

  constructor() {
    this.init();
  }

  private async init() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });

      // v2: Inicializar DB backend
      try {
        this.db = await createBackend(this.configDir);
        if (this.db) {
          // Inicializar device ID
          const deviceResult = await getOrCreateDeviceId(this.db);
          this.DEVICE_ID = deviceResult.deviceId;
          console.log(`[SyncEngine] v2 DB initialized, device: ${this.DEVICE_ID}`);

          // Migrar manifests JSON → DB si hay datos en JSON y DB está vacía
          try {
            const data = await fs.readFile(this.configFile, 'utf8');
            const parsed: any = JSON.parse(data);
            const jsonManifests = parsed.manifests as Record<string, Record<string, ManifestEntry>> | undefined;
            if (jsonManifests && Object.keys(jsonManifests).length > 0) {
              // Verificar si ya hay datos en DB
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
          } catch { /* no JSON file yet */ }
        }
      } catch (e: any) {
        console.warn('[SyncEngine] DB init failed, using JSON only:', e?.message || e);
      }

      // Cargar configuración desde JSON (siempre)
      try {
        const data = await fs.readFile(this.configFile, 'utf8');
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
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          console.error('[SyncEngine] Error reading config:', e);
        }
      }
      if (this.pairs.length > 0) {
        let modified = false;
        this.pairs.forEach(p => {
          if (p.localPath === '/home/fayfer/Documentos/Apuntes en pdf - tablet' || p.localPath.includes('Apuntes en pdf - tablet')) {
            p.localPath = path.join(os.homedir(), 'Documentos', 'Apuntes_Tablet_StarNote');
            modified = true;
          }
          if (p.localPath.startsWith('~/')) {
            p.localPath = path.join(os.homedir(), p.localPath.slice(2));
            modified = true;
          }
          if (p.remotePath === 'GoogleDrive:/Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:/Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:/Documentos-Ubuntu/Apuntes_Tablet_StarNote') {
            p.remotePath = 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote';
            modified = true;
          }
        });
        if (modified) await this.saveState();
      }
      this.refreshWatchers();
      this.refreshIntervals();
      this.startExternalDriveMonitor();
    } catch (err) {
      console.error('[SyncEngine] Init error:', err);
    }
  }

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

  private async saveState() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const data = {
        pairs: this.pairs,
        events: this.events.slice(0, 200),
        settings: this.settings,
        manifests: this.manifests,
        pendingConflicts: this.pendingConflicts
      };
      const tmpFile = `${this.configFile}.tmp.${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmpFile, this.configFile);
    } catch (err) {
      console.error('[SyncEngine] Save state error:', err);
    }
  }

  public setToken(token: string | null) {
    const prev = this.accessToken;
    this.accessToken = token;
    if (token && prev !== token) {
      console.log('[SyncEngine] Google Drive Access Token updated in backend.');
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

  public dismissExternalDriveAlert(drivePath: string) {
    this.detectedExternalDrives = this.detectedExternalDrives.filter(d => d.path !== drivePath);
  }

  private startExternalDriveMonitor() {
    if (this.externalMonitorInterval) clearInterval(this.externalMonitorInterval);
    this.externalMonitorInterval = setInterval(async () => {
      const user = process.env.USER || process.env.LOGNAME || 'usuario';
      const mediaPaths = [`/media/${user}`, `/run/media/${user}`];
      for (const base of mediaPaths) {
        try {
          const entries = await fs.readdir(base, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const drivePath = path.join(base, entry.name);
              if (!this.detectedExternalDrives.some(d => d.path === drivePath)) {
                console.log(`[SyncEngine] Nuevo dispositivo de almacenamiento detectado en Linux: ${drivePath}`);
                this.detectedExternalDrives.push({
                  path: drivePath,
                  name: entry.name,
                  detectedAt: Date.now()
                });
              }
            }
          }
        } catch {
          // El directorio no existe
        }
      }
    }, 5000);
  }

  public async setPairs(pairs: SyncPair[]) {
    this.pairs = pairs.map(p => ({
      ...p,
      localPath: p.localPath.startsWith('~/') ? path.join(os.homedir(), p.localPath.slice(2)) : p.localPath
    }));
    await this.saveState();
    this.refreshWatchers();
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
    } else if (pair.status === 'paused') {
      pair.status = 'idle';
    }
    this.refreshWatchers();
    this.refreshIntervals();
    this.saveState();
  }

  public async forceSync(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return;
    if (pair.status === 'paused' || pair.status === 'error' || pair.status === 'unauthenticated' || pair.status === 'idle') {
      pair.status = 'syncing';
    }
    this.refreshWatchers();
    this.refreshIntervals();
    setTimeout(() => this.triggerSync(pair.id), 10);
    this.saveState();
  }

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'skip'): Promise<void> {
    const conflict = this.pendingConflicts.find(c => c.id === conflictId);
    if (!conflict) return;
    if (resolution === 'local') {
      // Subir versión local → sobreescribe remoto
      const pair = this.pairs.find(p => p.id === conflict.pairId);
      if (pair) {
        try {
          await this.uploadDriveBinary(pair.localPath, conflict.localPath, conflict.remoteFileName, conflict.remoteFileId);
        } catch (e) {
          console.error('[SyncEngine] Error resolving conflict (local wins):', e);
        }
      }
    } else if (resolution === 'remote') {
      // Descargar versión remota → sobreescribe local
      const pair = this.pairs.find(p => p.id === conflict.pairId);
      if (pair) {
        try {
          let remoteFolderId = 'root';
          const remotePathParts = pair.remotePath.replace(/^(RemoteServer|GoogleDrive|Drive):/, '').replace(/^[\/\\]+/, '').split('/').filter(Boolean);
          for (const part of remotePathParts) {
            const files = await this.listDriveFiles(remoteFolderId);
            const folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
            if (!folder) break;
            remoteFolderId = folder.id;
          }
          await this.downloadDriveBinary(conflict.remoteFileId, conflict.localPath, new Date(conflict.remoteMtime).toISOString());
        } catch (e) {
          console.error('[SyncEngine] Error resolving conflict (remote wins):', e);
        }
      }
    }
    // Eliminar conflicto resuelto
    this.pendingConflicts = this.pendingConflicts.filter(c => c.id !== conflictId);
    await this.saveState();
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };

    console.log(`[SyncEngine/Backend] Iniciando limpieza total en disco y Google Drive para: ${pair.localPath}`);
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
        console.error('[SyncEngine/Backend] Error deduplicando Drive:', e);
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
    if (pair.status === 'paused') {
      pair.status = 'idle';
      setTimeout(() => this.triggerSync(pair.id), 10);
    } else {
      pair.status = 'paused';
    }
    this.refreshWatchers();
    this.refreshIntervals();
    this.saveState();
  }

  public async removePair(pairId: string) {
    if (this.watchers[pairId]) {
      await this.watchers[pairId].close();
      delete this.watchers[pairId];
    }
    if (this.intervalRefs[pairId]) {
      clearInterval(this.intervalRefs[pairId]);
      delete this.intervalRefs[pairId];
    }
    this.pairs = this.pairs.filter(p => p.id !== pairId);
    delete this.manifests[pairId];
    this.pendingConflicts = this.pendingConflicts.filter(c => c.pairId !== pairId);
    await this.saveState();
  }

  public async setPairMode(pairId: string, syncMode: 'mirror' | 'streaming', cloudCategory?: 'computers' | 'shared') {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair) return;
    pair.syncMode = syncMode;
    if (cloudCategory) pair.cloudCategory = cloudCategory;
    await this.saveState();
    if (syncMode === 'mirror') {
      await this.hydratePair(pairId);
    }
  }

  public async dehydratePair(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) return;
    console.log(`[SyncEngine/Streaming] Liberando espacio (Deshidratando a Stubs) para par: ${pair.localPath}`);

    const dehydrateDir = async (dir: string, relPrefix: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(relPrefix, entry.name);
          if (entry.isDirectory()) {
            await dehydrateDir(fullPath, relPath);
          } else if (!entry.name.endsWith('.vstream') && !entry.name.endsWith('.gdoc') && !entry.name.endsWith('.gsheet') && !entry.name.endsWith('.gslides')) {
            const manifestEntry = this.manifests[pair.id]?.[relPath];
            if (manifestEntry && manifestEntry.remoteId) {
              const stubPath = fullPath + '.vstream';
              const stubContent = JSON.stringify({
                id: manifestEntry.remoteId,
                name: entry.name,
                modifiedTime: new Date(manifestEntry.remoteMtime).toISOString(),
                streamUrl: `https://www.googleapis.com/drive/v3/files/${manifestEntry.remoteId}?alt=media`,
                isStub: true
              }, null, 2);
              await fs.writeFile(stubPath, stubContent, 'utf8');
              this.markSelfWritten(stubPath);
              this.markSelfWritten(fullPath);
              await fs.unlink(fullPath).catch(() => null);
              console.log(`[SyncEngine] Deshidratado exitosamente a stub ligero: ${entry.name}`);
            }
          }
        }
      } catch (e) {
        console.error(`[SyncEngine] Error al deshidratar ${dir}:`, e);
      }
    };

    await dehydrateDir(pair.localPath, '');
    pair.syncMode = 'streaming';
    await this.saveState();
  }

  public async hydratePair(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) return;
    console.log(`[SyncEngine/Streaming] Descargando contenido físico (Hidratando para Offline) en: ${pair.localPath}`);

    const hydrateDir = async (dir: string, relPrefix: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await hydrateDir(fullPath, path.join(relPrefix, entry.name));
          } else if (entry.name.endsWith('.vstream')) {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              const stub = JSON.parse(content);
              if (stub && stub.id) {
                const realFileName = entry.name.replace(/\.vstream$/, '');
                const targetRealPath = path.join(dir, realFileName);
                console.log(`[SyncEngine] Hidratando archivo binario desde Google Drive: ${realFileName}`);
                await this.downloadDriveBinary(stub.id, targetRealPath, stub.modifiedTime || new Date().toISOString());
                this.markSelfWritten(fullPath);
                await fs.unlink(fullPath).catch(() => null);
              }
            } catch (err) {
              console.error(`[SyncEngine] Error hidratando stub ${entry.name}:`, err);
            }
          }
        }
      } catch (e) {
        console.error(`[SyncEngine] Error al hidratar ${dir}:`, e);
      }
    };

    await hydrateDir(pair.localPath, '');
    pair.syncMode = 'mirror';
    await this.saveState();
  }

  private refreshWatchers() {
    this.pairs.forEach(pair => {
      const shouldWatch = (pair.status === 'syncing' || pair.status === 'idle') && !!pair.localPath;
      if (shouldWatch && !this.watchers[pair.id]) {
        try {
          console.log(`[SyncEngine/Chokidar] Iniciando observador Inotify para: ${pair.localPath}`);
          const watcher = chokidar.watch(pair.localPath, {
            ignored: (filePath: string) => {
              const base = path.basename(filePath);
              if (base.startsWith('.')) return true;
              return matchesIgnorePattern(base, this.settings.ignoredPatterns);
            },
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 2000,
              pollInterval: 500
            }
          });

          watcher.on('all', (event, filePath) => {
            // CORRECCIÓN CRÍTICA: Si el motor está ejecutando una sincronización activa en este par,
            // ignoramos las alertas del filesystem generadas por nuestras propias escrituras.
            if (this.activeSyncs.has(pair.id)) {
              return;
            }

            // v2: También ignorar archivos marcados como auto-escritos
            if (this.isSelfWritten(filePath)) {
              return;
            }

            console.log(`[SyncEngine/Chokidar] Evento '${event}' en: ${filePath}`);

            // Debounce de 3 segundos para evitar ejecuciones múltiples continuas
            if (this.debounceTimers[pair.id]) {
              clearTimeout(this.debounceTimers[pair.id]);
            }
            this.debounceTimers[pair.id] = setTimeout(() => {
              this.syncTriggerSource[pair.id] = 'fs-event';
              this.triggerSync(pair.id);
            }, 3000);
          });

          this.watchers[pair.id] = watcher;
        } catch (err) {
          console.error(`[SyncEngine/Chokidar] Error watching ${pair.localPath}:`, err);
        }
      } else if (!shouldWatch && this.watchers[pair.id]) {
        this.watchers[pair.id].close();
        delete this.watchers[pair.id];
      }
    });

    Object.keys(this.watchers).forEach(id => {
      if (!this.pairs.find(p => p.id === id)) {
        this.watchers[id].close();
        delete this.watchers[id];
      }
    });
  }

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
            this.syncTriggerSource[pair.id] = 'poll';
            this.triggerSync(pair.id);
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
    if (!this.accessToken) return;
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || pair.status === 'paused') return;

    // v2: Anti-bucle — cooldown post-sincronización para triggers por polling
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
      currentFile: 'Verificando carpetas y duplicados...',
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
      details: 'Inicio de verificación y sincronización'
    }, true);
    console.log(`[SyncEngine] Iniciando sincronización para par: ${pair.localPath} ↔ ${pair.remotePath}`);

    try {
      // 1. Resolver o crear la ruta remota en Google Drive
      let remoteFolderId = 'root';
      let remotePathParts = pair.remotePath.replace(/^(RemoteServer|GoogleDrive|Drive):/, '').replace(/^[\/\\]+/, '').split('/').filter(Boolean);

      if (pair.cloudCategory === 'computers' && remotePathParts[0] !== 'Ordenadores' && remotePathParts[0] !== 'Computers') {
        const deviceLabel = pair.deviceName || os.hostname() || 'Dispositivo-Linux';
        remotePathParts = ['Ordenadores', deviceLabel, ...remotePathParts];
      }

      for (const part of remotePathParts) {
        const files = await this.listDriveFiles(remoteFolderId);
        let folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
        if (!folder) {
          folder = await this.createDriveFolder(remoteFolderId, part);
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: `[Dir] ${part}`,
            action: 'uploaded',
            timestamp: Date.now(),
            details: 'Carpeta remota creada en Drive'
          });
        }
        remoteFolderId = folder.id;
      }

      // 2. Resolver carpeta local
      await fs.mkdir(pair.localPath, { recursive: true });

      // 3. v2: Usar feature flag para elegir implementación
      if (USE_V2_SYNC && this.db && this.DEVICE_ID) {
        await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
      } else {
        // 4. Inicializar manifiesto del par si no existe
        if (!this.manifests[pair.id]) {
          this.manifests[pair.id] = {};
        }

        // 5. Iniciar sincronización recursiva de todo el árbol de directorios (legacy)
        await this.syncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
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
        console.warn(`[SyncEngine] Sesión caducada durante sincronización de par ${pairId}`);
        pair.status = 'unauthenticated';
      } else {
        console.error(`[SyncEngine] Error durante sincronización de par ${pairId}:`, err.message);
        pair.status = 'error';
      }
      pair.progress = null;
      await this.saveState();
    } finally {
      this.activeSyncs.delete(pairId);
      this.driveFolderCache.clear();

      // v2: Anti-bucle — registrar timestamp y ajustar backoff adaptativo
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

      // Solo disparar sincronización pendiente si proviene de cambios reales del usuario durante el proceso
      if (this.pendingSyncs.has(pairId)) {
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
    const scanResult = await scanChanges(localDir, dbState, fs, pair.id);
    if (scanResult === 'PERMISSION_DENIED') {
      console.error(`[v2Sync] Permission denied in ${localDir}, aborting sync`);
      pair.status = 'error' as any;
      return;
    }

    // 1b. Listar archivos remotos con etag y appProperties
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

    // FASE 2: Deduplicar snapshots en RAM
    // (sin I/O adicional — ya se deduplicó en scanChanges y listDriveFiles)
    // Los archivos eliminados ya están en scanResult.deleted
    // Los archivos nuevos ya están en scanResult.created

    // FASE 3: Computar plan con three-way merge
    // Convertir dbState (Map<string, FileState>) al formato esperado por computeSyncPlan
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
      const fullLocalPath = path.join(localDir, upload.localPath);
      const journalId = this.db.journalStart(pair.id, 'upload_start', upload.localPath, upload.remoteId);
      try {
        const stats = await fs.stat(fullLocalPath).catch(() => null);
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
        await this.uploadDriveBinary(remoteFolderId, fullLocalPath, upload.remoteName, upload.remoteId, upload.vectorClock);
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
        if (e.message?.includes('412')) {
          // HTTP 412 Precondition Failed → conflicto
          plan.conflicts.push({
            localPath: upload.localPath,
            remoteFile: { id: upload.remoteId || '', name: upload.remoteName, mimeType: '', modifiedTime: '' },
            localVc: upload.vectorClock,
            remoteVc: '{}'
          });
        }
        console.error(`[v2Sync] Upload failed: ${upload.remoteName}`, e.message || e);
      }
    }

    // 4b. Downloads
    for (const download of plan.downloads) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, download.localPath);
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
        await this.downloadDriveBinary(
          download.remoteFile.id,
          fullLocalPath,
          download.remoteFile.modifiedTime,
          download.remoteFile.md5Checksum,
          download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : undefined
        );
        this.markSelfWritten(fullLocalPath);
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
      const fullLocalPath = path.join(localDir, del.localPath);
      const journalId = this.db.journalStart(pair.id, 'delete_local_start', del.localPath);
      try {
        this.markSelfWritten(fullLocalPath);
        await fs.rm(fullLocalPath, { force: true }).catch(() => { });
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
        remote_id: download.remoteFile.id, local_mtime: now, remote_mtime: new Date(download.remoteFile.modifiedTime).getTime(),
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
    const localDirs = await fs.readdir(localDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const dirNames = new Set<string>();
    for (const dir of localDirs) {
      if (dir.isDirectory()) dirNames.add(dir.name);
    }
    for (const dir of remoteFiles) {
      if (dir.mimeType === 'application/vnd.google-apps.folder') dirNames.add(dir.name);
    }

    for (const dirName of dirNames) {
      if ((pair.status as string) === 'paused') return;
      const subDir = path.join(localDir, dirName);
      const subPrefix = path.join(relativePrefix, dirName);
      const subRemoteFolder = subDirs.find(d => d.name === dirName);
      if (subRemoteFolder) {
        await fs.mkdir(subDir, { recursive: true }).catch(() => { });
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
   * Para cada archivo en dbState con remoteId y etag, hacer GET con If-None-Match.
   * HTTP 304 = sin cambios (no consume cuota). HTTP 200 = actualizar dbState.
   */
  private async reconcileWithHttp304(pairId: string, remoteFolderId: string): Promise<void> {
    if (!this.db || !this.accessToken) return;

    const dbState = this.db.getFolderState(pairId);
    const pendingDeletes: string[] = [];

    for (const [relPath, state] of dbState) {
      if (!state.remote_id) continue;
      if (state.is_tombstone) continue;

      try {
        // Usar If-Modified-Since en lugar de If-None-Match (etag no disponible en list)
        const modifiedSince = state.remote_mtime
          ? new Date(state.remote_mtime).toUTCString()
          : undefined;

        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.accessToken}`
        };
        if (modifiedSince) {
          headers['If-Modified-Since'] = modifiedSince;
        }

        const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${state.remote_id}?fields=modifiedTime,md5Checksum,size`, {
          method: 'GET',
          headers
        });

        if (res.status === 304) {
          // Sin cambios — no consume cuota
          continue;
        }

        if (res.status === 404) {
          // Archivo borrado en Drive
          pendingDeletes.push(relPath);
          continue;
        }

        if (res.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
        await this.handleDriveResponse(res);

        // HTTP 200 — archivo cambió remotamente
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
        // Ignorar errores de red para un solo archivo
        console.warn(`[HTTP 304] Error reconciliando ${relPath}:`, e.message || e);
      }
    }

    // Marcar como tombstones los archivos que ya no existen en Drive
    for (const relPath of pendingDeletes) {
      const state = this.db.getFileState(pairId, relPath);
      if (state) {
        state.is_tombstone = 1;
        state.updated_at = Date.now();
        this.db.setFileState(pairId, relPath, state);
      }
    }
  }

  // ─── Legacy syncDirectoryTree (sin cambios) ────────────────────

  private async deduplicateLocalFolder(localDir: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> {
    let deleted = 0;
    let renamed = 0;
    try {
      const entries = await fs.readdir(localDir, { withFileTypes: true });
      const files = entries.filter(e => !e.isDirectory());
      if (files.length === 0) return { deleted, renamed };

      const fileItems: Array<{ name: string; mtime: number }> = [];
      for (const file of files) {
        const fullPath = path.join(localDir, file.name);
        try {
          const st = await fs.stat(fullPath);
          fileItems.push({ name: file.name, mtime: st.mtimeMs });
        } catch { continue; }
      }

      const groups = CoreSyncLogic.groupAndSortDuplicates(fileItems);
      const manifest = (pairId && this.manifests[pairId]) ? this.manifests[pairId] : null;

      for (const [baseName, versions] of groups.entries()) {
        if (versions.length <= 1 && versions[0].name === baseName) continue;

        const winner = versions[0];
        const losers = versions.slice(1);

        if (losers.length > 0) {
          console.log(`[Deduplicador/Backend] Grupo "${baseName}": Manteniendo última versión ${winner.name} (v${winner.version}), eliminando ${losers.length} copias obsoletas.`);
          for (const loser of losers) {
            const filePath = path.join(localDir, loser.name);
            this.markSelfWritten(filePath);
            await fs.unlink(filePath).catch(() => { });
            deleted++;
            if (manifest) {
              const loserRelPath = path.join(relativePrefix, loser.name);
              delete manifest[loserRelPath];
              delete manifest[loser.name];
            }
          }
        }

        if (winner.name !== baseName) {
          const oldPath = path.join(localDir, winner.name);
          const newPath = path.join(localDir, baseName);
          console.log(`[Deduplicador/Backend] Renombrando última exportación al nombre base: ${winner.name} -> ${baseName}`);
          this.markSelfWritten(oldPath);
          this.markSelfWritten(newPath);
          await fs.rename(oldPath, newPath).catch(err => console.error(`Error renombrando ${oldPath}:`, err));
          renamed++;
          if (manifest) {
            const oldRelPath = path.join(relativePrefix, winner.name);
            const newRelPath = path.join(relativePrefix, baseName);
            if (manifest[oldRelPath]) {
              manifest[newRelPath] = manifest[oldRelPath];
              delete manifest[oldRelPath];
            } else {
              delete manifest[newRelPath];
            }
            delete manifest[winner.name];
          }
        }
      }
      if (deleted > 0 || renamed > 0) {
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pairId || 'general',
          filename: 'Almacenamiento Local PC',
          action: 'cleaned',
          timestamp: Date.now(),
          details: `Limpiadas ${deleted} versiones antiguas (${renamed} renombrado a versión base)`
        }, true);
        if (manifest) await this.saveState();
      }
    } catch (e) {
      console.warn(`[Deduplicador/Backend] Error en ${localDir}:`, e);
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
          console.log(`[Deduplicador Drive/Backend] Grupo "${baseName}": Manteniendo última versión ${winner.file.name} (v${winner.version}), eliminando ${losers.length} copias obsoletas en Google Drive.`);
          for (const loser of losers) {
            await this.deleteDriveFile(loser.file.id, remoteFolderId);
            deleted++;
            if (manifest) {
              const loserRelPath = path.join(relativePrefix, loser.file.name);
              delete manifest[loserRelPath];
              delete manifest[loser.file.name];
            }
          }
        }

        if (winner.file.name !== baseName) {
          console.log(`[Deduplicador Drive/Backend] Renombrando en Google Drive: ${winner.file.name} -> ${baseName}`);
          await this.renameDriveFile(winner.file.id, baseName, remoteFolderId);
          winner.file.name = baseName;
          renamed++;
          if (manifest) {
            const oldRelPath = path.join(relativePrefix, winner.file.name);
            const newRelPath = path.join(relativePrefix, baseName);
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
          details: `Limpiados ${deleted} duplicados remotos en Drive`
        }, true);
        if (manifest) await this.saveState();
      }
    } catch (e) {
      console.warn(`[Deduplicador Drive/Backend] Error en carpeta remota ${remoteFolderId}:`, e);
    }
    return { deleted, renamed };
  }

  private async renameDriveFile(fileId: string, newName: string, parentId: string): Promise<void> {
    this.driveFolderCache.delete(parentId);
    if (!this.accessToken) throw new Error('No OAuth access token set');
    try {
      const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });
      await this.handleDriveResponse(res);
    } catch (err) {
      console.error(`[Drive/Backend] Error renombrando archivo ID ${fileId}:`, err);
    }
  }

  private async syncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = '') {
    await Promise.all([
      this.deduplicateLocalFolder(localDir, pair.id, relativePrefix),
      this.deduplicateDriveFolder(remoteFolderId, pair.id, relativePrefix)
    ]);

    const remoteFiles = await this.listDriveFiles(remoteFolderId, true);
    let localEntries: Dirent[] = [];
    try {
      localEntries = await fs.readdir(localDir, { withFileTypes: true });
    } catch {
      localEntries = [];
    }

    const pairManifest = this.manifests[pair.id] || {};

    const delayForBandwidth = async (sizeInBytes: number, speedKBps: number) => {
      if (speedKBps > 0) {
        const delayMs = (sizeInBytes / 1024 / speedKBps) * 1000;
        if (delayMs > 0) await new Promise(r => setTimeout(r, Math.min(delayMs, 5000)));
      }
    };

    // 1. PROCESAR SUBIDAS / CONFLICTOS / MODIFICACIONES LOCALES
    if (pair.direction === 'upload' || pair.direction === 'bidirectional') {
      const dirEntries = localEntries.filter(e => e.isDirectory() && !matchesIgnorePattern(e.name, this.settings.ignoredPatterns));
      const fileEntries = localEntries.filter(e => !e.isDirectory() && !matchesIgnorePattern(e.name, this.settings.ignoredPatterns) && !e.name.endsWith('.gdoc') && !e.name.endsWith('.gsheet') && !e.name.endsWith('.gslides') && !e.name.endsWith('.vstream'));

      for (const entry of dirEntries) {
        const fullLocalPath = path.join(localDir, entry.name);
        const relPath = path.join(relativePrefix, entry.name);
        let remoteSubFolder = remoteFiles.find(f => f.name === entry.name && f.mimeType === 'application/vnd.google-apps.folder');
        if (!remoteSubFolder) {
          console.log(`[SyncEngine] Creando carpeta remota: ${entry.name}`);
          remoteSubFolder = await this.createDriveFolder(remoteFolderId, entry.name);
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: `[Dir] ${entry.name}`,
            action: 'uploaded',
            timestamp: Date.now()
          }, true);
        }
        await this.syncDirectoryTree(fullLocalPath, remoteSubFolder.id, pair, relPath);
      }

      const uploadTasks = fileEntries.map(entry => async () => {
        const fullLocalPath = path.join(localDir, entry.name);
        let stats: any = null;
        try { stats = await fs.stat(fullLocalPath); } catch { return; }

        const numberedMatch = entry.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
        const effectiveName = numberedMatch ? `${numberedMatch[1].trim()}.${numberedMatch[3]}` : entry.name;
        const isNumbered = !!numberedMatch;

        const relPath = path.join(relativePrefix, effectiveName);
        const remoteFile = remoteFiles.find(f => f.name === effectiveName && f.mimeType !== 'application/vnd.google-apps.folder');
        const manifestEntry = pairManifest[relPath];

        const localMtime = stats.mtime.getTime();
        const remoteMtime = remoteFile ? new Date(remoteFile.modifiedTime).getTime() : 0;

        if (!isNumbered && manifestEntry && remoteFile &&
          localMtime > manifestEntry.localMtime + 5000 &&
          remoteMtime > manifestEntry.remoteMtime + 5000 &&
          this.settings.conflictResolution === 'prompt') {
          if (!this.pendingConflicts.some(c => c.pairId === pair.id && c.relativePath === relPath)) {
            console.warn(`[SyncEngine] Conflicto detectado para: ${relPath}`);
            const conflictObj: PendingConflict = {
              id: Math.random().toString(36).substr(2, 9),
              pairId: pair.id,
              relativePath: relPath,
              localPath: fullLocalPath,
              localMtime,
              remoteFileId: remoteFile.id,
              remoteFileName: remoteFile.name,
              remoteMtime,
              timestamp: Date.now()
            };
            this.pendingConflicts.push(conflictObj);
            this.addEvent({
              id: Math.random().toString(36).substr(2, 9),
              pairId: pair.id,
              filename: entry.name,
              action: 'conflict',
              timestamp: Date.now()
            }, true);
          }
          return;
        }

        let shouldUpload = false;
        const remoteSize = remoteFile ? parseInt((remoteFile as any).size || '0', 10) : -1;
        const isSizeIdentical = remoteFile && (stats.size === remoteSize || remoteFile.mimeType.startsWith('application/vnd.google-apps.'));

        if (isNumbered) {
          shouldUpload = true;
        } else if (!remoteFile) {
          shouldUpload = true;
        } else if (manifestEntry && Math.abs(localMtime - manifestEntry.localMtime) > 3000) {
          shouldUpload = true;
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
          if (pair.progress) {
            pair.progress = {
              currentFile: isNumbered ? `${effectiveName} (nueva versión desde ${entry.name})` : entry.name,
              totalFiles: (pair.progress.totalFiles || 0) + 1,
              currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
              bytesTransferred: (pair.progress.bytesTransferred || 0),
              totalBytes: (pair.progress.totalBytes || 0) + fileSize,
              percentage: pair.progress.totalBytes > 0 ? Math.min(95, Math.round(((pair.progress.bytesTransferred || 0) / (pair.progress.totalBytes + fileSize)) * 100)) : 50,
              action: 'subiendo'
            };
          }
          console.log(`[SyncEngine] Subiendo: ${fullLocalPath}${isNumbered ? ` → ${effectiveName}` : ''}`);
          await delayForBandwidth(fileSize, this.settings.maxUploadSpeed);

          let uploadedFile: DriveFile;
          if (!isNumbered && remoteFile && this.settings.conflictResolution === 'rename') {
            uploadedFile = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, `(Local) ${effectiveName}`);
          } else {
            uploadedFile = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, effectiveName, remoteFile?.id);
          }
          if (pair.progress) {
            pair.progress.bytesTransferred = (pair.progress.bytesTransferred || 0) + fileSize;
            pair.progress.percentage = pair.progress.totalBytes > 0 ? Math.min(100, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100)) : 100;
          }

          // Leer stats locales frescos tras subida
          const freshLocalStats = await fs.stat(fullLocalPath).catch(() => stats);

          pairManifest[relPath] = {
            localMtime: freshLocalStats.mtime.getTime(),
            remoteMtime: new Date(uploadedFile.modifiedTime).getTime(),
            remoteId: uploadedFile.id
          };

          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: effectiveName,
            action: 'uploaded',
            timestamp: Date.now(),
            webViewLink: uploadedFile?.webViewLink || remoteFile?.webViewLink,
            details: isNumbered
              ? `Nueva versión exportada (${formatBytes(fileSize)}) — ${entry.name} → ${effectiveName}`
              : `Subido (${formatBytes(fileSize)}) hacia Google Drive`
          }, true);
        }
      });
      await this.runInPool(uploadTasks, 2);
    }

    // 2. PROCESAR DESCARGAS / MODIFICACIONES REMOTAS
    if (pair.direction === 'download' || pair.direction === 'bidirectional') {
      for (const remoteFile of remoteFiles) {
        if (matchesIgnorePattern(remoteFile.name, this.settings.ignoredPatterns)) {
          continue;
        }

        const fullLocalPath = path.join(localDir, remoteFile.name);
        const relPath = path.join(relativePrefix, remoteFile.name);
        const localEntry = localEntries.find(e => e.name === remoteFile.name || e.name.startsWith(remoteFile.name + '.g') || e.name === `${remoteFile.name}.vstream`);

        if (remoteFile.mimeType === 'application/vnd.google-apps.folder') {
          await fs.mkdir(fullLocalPath, { recursive: true });
          if (pair.direction === 'download') {
            await this.syncDirectoryTree(fullLocalPath, remoteFile.id, pair, relPath);
          }
        } else {
          if (remoteFile.mimeType.startsWith('application/vnd.google-apps.')) {
            let ext = '.gdoc';
            if (remoteFile.mimeType.includes('spreadsheet')) ext = '.gsheet';
            else if (remoteFile.mimeType.includes('presentation')) ext = '.gslides';

            const docFileName = remoteFile.name.endsWith(ext) ? remoteFile.name : (remoteFile.name + ext);
            const docPath = path.join(localDir, docFileName);
            const shortcutContent = JSON.stringify({
              url: remoteFile.webViewLink || `https://docs.google.com/document/d/${remoteFile.id}/edit`,
              id: remoteFile.id,
              name: remoteFile.name,
              type: remoteFile.mimeType
            }, null, 2);
            try {
              const fileExists = await fs.stat(docPath).catch(() => null);
              if (!fileExists) {
                console.log(`[SyncEngine/GoogleDocs] Generando archivo directo: ${docFileName}`);
                await fs.mkdir(localDir, { recursive: true });
                await fs.writeFile(docPath, shortcutContent, 'utf8');
                this.markSelfWritten(docPath);
                this.addEvent({
                  id: Math.random().toString(36).substr(2, 9),
                  pairId: pair.id,
                  filename: docFileName,
                  action: 'downloaded',
                  timestamp: Date.now(),
                  webViewLink: remoteFile.webViewLink
                });
              }
            } catch (err) {
              console.error(`[SyncEngine] Error creando shortcut de Google Docs en ${docPath}:`, err);
            }
            continue;
          }

          if (this.pendingConflicts.some(c => c.pairId === pair.id && c.relativePath === relPath)) {
            continue;
          }

          let shouldDownload = false;
          let localStats: any = null;
          if (!localEntry) {
            shouldDownload = true;
          } else {
            localStats = await fs.stat(fullLocalPath);
            const localTime = localStats.mtime.getTime();
            const remoteTime = new Date(remoteFile.modifiedTime).getTime();
            const manifestEntry = pairManifest[relPath];
            const remoteSize = parseInt((remoteFile as any).size || '0', 10);
            const isSizeIdentical = localStats.size === remoteSize || remoteFile.mimeType.startsWith('application/vnd.google-apps.');

            if (manifestEntry && Math.abs(remoteTime - manifestEntry.remoteMtime) > 3000) {
              shouldDownload = true;
            } else if (!manifestEntry) {
              if (isSizeIdentical) {
                pairManifest[relPath] = {
                  localMtime: localTime,
                  remoteMtime: remoteTime,
                  remoteId: remoteFile.id
                };
                shouldDownload = false;
              } else if (remoteTime > localTime + 5000) {
                shouldDownload = true;
              }
            }
          }

          if (shouldDownload) {
            const isExistingPhysical = localEntries.some(e => e.name === remoteFile.name);
            if (pair.syncMode === 'streaming' && !isExistingPhysical) {
              const stubPath = path.join(localDir, `${remoteFile.name}.vstream`);
              const stubContent = JSON.stringify({
                id: remoteFile.id,
                name: remoteFile.name,
                mimeType: remoteFile.mimeType,
                modifiedTime: remoteFile.modifiedTime,
                webViewLink: remoteFile.webViewLink,
                streamUrl: `https://www.googleapis.com/drive/v3/files/${remoteFile.id}?alt=media`,
                isStub: true
              }, null, 2);
              console.log(`[SyncEngine/Streaming] Creando stub virtual bajo demanda: ${stubPath}`);
              await fs.mkdir(localDir, { recursive: true });
              await fs.writeFile(stubPath, stubContent, 'utf8');
              this.markSelfWritten(stubPath);

              const stubStats = await fs.stat(stubPath);

              pairManifest[relPath] = {
                localMtime: stubStats.mtime.getTime(),
                remoteMtime: new Date(remoteFile.modifiedTime).getTime(),
                remoteId: remoteFile.id
              };

              this.addEvent({
                id: Math.random().toString(36).substr(2, 9),
                pairId: pair.id,
                filename: `${remoteFile.name} [Stub Virtual]`,
                action: 'downloaded',
                timestamp: Date.now(),
                webViewLink: remoteFile.webViewLink
              });
            } else {
              const fileSize = parseInt((remoteFile as any).size || '0', 10);
              if (pair.progress) {
                pair.progress = {
                  currentFile: remoteFile.name,
                  totalFiles: (pair.progress.totalFiles || 0) + 1,
                  currentFileIndex: (pair.progress.currentFileIndex || 0) + 1,
                  bytesTransferred: (pair.progress.bytesTransferred || 0),
                  totalBytes: (pair.progress.totalBytes || 0) + fileSize,
                  percentage: pair.progress.totalBytes > 0 ? Math.min(95, Math.round(((pair.progress.bytesTransferred || 0) / (pair.progress.totalBytes + fileSize)) * 100)) : 50,
                  action: 'descargando'
                };
              }
              console.log(`[SyncEngine] Descargando archivo binario (Modo Duplicado/Offline): ${remoteFile.name}`);
              await delayForBandwidth(fileSize || 1024 * 500, this.settings.maxDownloadSpeed);

              const possibleStub = path.join(localDir, `${remoteFile.name}.vstream`);
              this.markSelfWritten(possibleStub);
              await fs.unlink(possibleStub).catch(() => null);

              const targetDownloadPath = (localEntry && this.settings.conflictResolution === 'rename')
                ? path.join(localDir, `(Remote) ${remoteFile.name}`)
                : fullLocalPath;

              await this.downloadDriveBinary(
                remoteFile.id,
                targetDownloadPath,
                remoteFile.modifiedTime,
                remoteFile.md5Checksum,
                remoteFile.size ? parseInt(remoteFile.size, 10) : undefined
              );

              // Leer mtime real producido tras utimes
              const updatedLocalStats = await fs.stat(targetDownloadPath);
              const realSize = updatedLocalStats.size || fileSize;

              if (pair.progress) {
                pair.progress.bytesTransferred = (pair.progress.bytesTransferred || 0) + realSize;
                pair.progress.percentage = pair.progress.totalBytes > 0 ? Math.min(100, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100)) : 100;
              }

              pairManifest[relPath] = {
                localMtime: updatedLocalStats.mtime.getTime(),
                remoteMtime: new Date(remoteFile.modifiedTime).getTime(),
                remoteId: remoteFile.id
              };

              this.addEvent({
                id: Math.random().toString(36).substr(2, 9),
                pairId: pair.id,
                filename: remoteFile.name,
                action: 'downloaded',
                timestamp: Date.now(),
                webViewLink: remoteFile.webViewLink,
                details: `Descargado (${formatBytes(realSize)}) en dispositivo`
              });
            }
          }
        }
      }
    }
    // 3. PROPAGACIÓN DE ELIMINACIONES
    // Filtrar claves registradas en el manifiesto dentro de esta subcarpeta
    const manifestKeys = Object.keys(pairManifest).filter(relPath => {
      const parentDir = path.dirname(relPath);
      return parentDir === (relativePrefix || '.');
    });

    for (const relPath of manifestKeys) {
      const fileName = path.basename(relPath);
      const manifestEntry = pairManifest[relPath];
      const fullLocalPath = path.join(localDir, fileName);

      // CORRECCIÓN CLAVE: Verificar el estado físico real en disco en este instante
      // (evita falsos borrados con listas obsoletas tomadas antes de la descarga)
      const existsLocally = await fs.stat(fullLocalPath).then(() => true).catch(() => false);
      const existsRemotely = remoteFiles.some(f => f.name === fileName);

      // Si existía en el manifiesto pero SE BORRÓ LOCALMENTE (ya no existe físicamente en disco) -> borrar en remoto
      if (!existsLocally && existsRemotely && (pair.direction === 'upload' || pair.direction === 'bidirectional')) {
        console.log(`[SyncEngine] Propagando eliminación local a Google Drive: ${fileName}`);
        try {
          await this.deleteDriveFile(manifestEntry.remoteId);
          delete pairManifest[relPath];
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: fileName,
            action: 'deleted',
            timestamp: Date.now()
          });
        } catch (e) {
          console.error(`[SyncEngine] Error al eliminar en remoto ${fileName}:`, e);
        }
      }

      // Si existía en el manifiesto pero SE BORRÓ REMOTAMENTE en Drive -> borrar en local
      if (existsLocally && !existsRemotely && (pair.direction === 'download' || pair.direction === 'bidirectional')) {
        console.log(`[SyncEngine] Propagando eliminación remota a disco local: ${fileName}`);
        try {
          this.markSelfWritten(fullLocalPath);
          await fs.rm(fullLocalPath, { force: true });
          delete pairManifest[relPath];
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: fileName,
            action: 'deleted',
            timestamp: Date.now()
          });
        } catch (e) {
          console.error(`[SyncEngine] Error al eliminar en local ${fileName}:`, e);
        }
      }
    }
  }

  private addEvent(ev: SyncEvent, skipSave = false) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.pop();
    if (!skipSave) this.saveState();
  }

  // --- GOOGLE DRIVE API IMPLEMENTATION ---

  private async handleDriveResponse(res: Response): Promise<Response> {
    if (!res.ok) {
      if (res.status === 401) {
        console.warn('[SyncEngine] Token de Google Drive expirado o inválido (401).');
        this.accessToken = null;
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      if (res.status === 412) {
        console.warn('[SyncEngine] Precondition Failed (412) — conflicto de versión detectado.');
        throw new Error('DRIVE_PRECONDITION_FAILED_412');
      }
      if (res.status === 304) {
        return res; // Not Modified — no es error, no hay contenido
      }
      const text = await res.text();
      throw new Error(`Drive API error (${res.status}): ${text.slice(0, 200)}`);
    }
    return res;
  }

  private async listDriveFiles(folderId: string, forceRefresh = false): Promise<DriveFile[]> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const cached = this.driveFolderCache.get(folderId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp < 60000)) {
      return cached.files;
    }
    const query = `'${folderId}' in parents and trashed = false`;
    let files: DriveFile[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('q', query);
      // v2: Incluir appProperties para vector clocks (etag no es un campo seleccionable de Drive API v3)
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink, appProperties)');
      url.searchParams.append('orderBy', 'folder,name');
      url.searchParams.append('pageSize', '1000');
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await this.driveRequest(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      await this.handleDriveResponse(res);
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
    const metadata = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    };

    const res = await this.driveRequest('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    });
    await this.handleDriveResponse(res);
    return (await res.json()) as DriveFile;
  }

  private async deleteDriveFile(fileId: string, parentId?: string): Promise<void> {
    if (parentId) this.driveFolderCache.delete(parentId);
    if (!this.accessToken) throw new Error('No OAuth access token set');
    try {
      const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      await this.handleDriveResponse(res);
    } catch (err: any) {
      console.error(`[Drive/Backend] Error eliminando archivo ID ${fileId}:`, err.message || err);
    }
  }

  private async downloadDriveBinary(
    fileId: string,
    destPath: string,
    modifiedTime: string,
    expectedMd5?: string,
    expectedSize?: number
  ): Promise<void> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.DRIVE_MAX_ATTEMPTS; attempt++) {
      const temporaryPath = `${destPath}.syncclient-download-${process.pid}-${Date.now()}-${attempt}`;
      try {
        const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
          headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        await this.handleDriveResponse(res);
        if (!res.body) throw new Error('Drive API returned an empty download body');

        const checksum = expectedMd5 ? createHash('md5') : null;
        const hasher = new Transform({
          transform(chunk, _encoding, callback) {
            if (checksum) checksum.update(chunk);
            callback(null, chunk);
          }
        });
        this.markSelfWritten(temporaryPath);
        await pipeline(
          Readable.fromWeb(res.body as any),
          hasher,
          fsSync.createWriteStream(temporaryPath, { flags: 'wx' })
        );

        const downloadedStats = await fs.stat(temporaryPath);
        if (typeof expectedSize === 'number' && downloadedStats.size !== expectedSize) {
          throw new Error(`Downloaded size mismatch: expected ${expectedSize}, got ${downloadedStats.size}`);
        }
        if (checksum && checksum.digest('hex') !== expectedMd5!.toLowerCase()) {
          throw new Error('Downloaded MD5 checksum mismatch');
        }

        this.markSelfWritten(destPath);
        await fs.rename(temporaryPath, destPath);
        this.markSelfWritten(destPath);
        if (modifiedTime) {
          const mtime = new Date(modifiedTime);
          try {
            await fs.utimes(destPath, mtime, mtime);
          } catch {
            // Some filesystems do not allow preserving timestamps.
          }
        }
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && (
          error.message === 'UNAUTHORIZED_EXPIRED_TOKEN' ||
          error.message === 'DRIVE_PRECONDITION_FAILED_412'
        )) {
          throw error;
        }
        await fs.rm(temporaryPath, { force: true }).catch(() => { });
        if (attempt < this.DRIVE_MAX_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, Math.min(32000, 1000 * (2 ** (attempt - 1)))));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Drive download failed');
  }

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string, vectorClock?: string): Promise<DriveFile> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    this.driveFolderCache.delete(parentId);
    const name = targetName || path.basename(filePath);
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    const resumableThreshold = 5 * 1024 * 1024;

    let mimeType = 'application/octet-stream';
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.zip') mimeType = 'application/zip';
    else if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.json') mimeType = 'application/json';

    const appProperties = vectorClock
      ? VectorClockManager.toAppProperties(VectorClockManager.fromString(vectorClock))
      : undefined;
    const metadata = existingFileId
      ? { name, ...(appProperties ? { appProperties } : {}) }
      : { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
    const initUrl = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink';

    if (fileSize >= resumableThreshold) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.DRIVE_MAX_ATTEMPTS; attempt++) {
        try {
          const initRes = await this.driveRequest(initUrl, {
            method: existingFileId ? 'PATCH' : 'POST',
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': mimeType,
              'X-Upload-Content-Length': fileSize.toString()
            },
            body: JSON.stringify(metadata)
          });
          await this.handleDriveResponse(initRes);
          const sessionUri = initRes.headers.get('Location');
          if (!sessionUri) throw new Error('Drive resumable upload did not return a session URI');

          const uploadRes = await this.driveRequest(sessionUri, {
            method: 'PUT',
            headers: {
              'Content-Type': mimeType,
              'Content-Length': fileSize.toString()
            },
            body: fsSync.createReadStream(filePath) as any,
            duplex: 'half'
          }, 1);
          if (uploadRes.ok) return (await uploadRes.json()) as DriveFile;
          if (!this.isTransientDriveStatus(uploadRes.status)) {
            await this.handleDriveResponse(uploadRes);
          }
          await uploadRes.body?.cancel().catch(() => { });
          lastError = new Error(`Drive resumable upload failed (${uploadRes.status})`);
        } catch (error) {
          lastError = error;
          if (error instanceof Error && (
            error.message === 'UNAUTHORIZED_EXPIRED_TOKEN' ||
            error.message === 'DRIVE_PRECONDITION_FAILED_412'
          )) {
            throw error;
          }
        }
        if (attempt < this.DRIVE_MAX_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, Math.min(32000, 1000 * (2 ** (attempt - 1)))));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Drive resumable upload failed');
    }

    const fileBuffer = await fs.readFile(filePath);
    const boundary = '-------SyncClientBoundary' + Math.random().toString(36);
    const header = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyPayload = Buffer.concat([header, fileBuffer, footer]);
    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink';
    const res = await this.driveRequest(url, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': bodyPayload.length.toString()
      },
      body: bodyPayload as any
    });
    await this.handleDriveResponse(res);
    return (await res.json()) as DriveFile;
  }
}

export const syncEngine = new SyncEngine();