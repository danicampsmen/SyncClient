import fs from 'fs/promises';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { CoreSyncLogic } from '../shared/CoreSyncLogic';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
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

  constructor() {
    this.init();
  }

  private async init() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
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
        if (parsed.manifests) this.manifests = parsed.manifests;
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

            console.log(`[SyncEngine/Chokidar] Evento '${event}' en: ${filePath}`);

            // Debounce de 3 segundos para evitar ejecuciones múltiples continuas
            if (this.debounceTimers[pair.id]) {
              clearTimeout(this.debounceTimers[pair.id]);
            }
            this.debounceTimers[pair.id] = setTimeout(() => {
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
        this.intervalRefs[pair.id] = setInterval(() => {
          this.triggerSync(pair.id);
        }, 30000); // Polling automático cada 30s
      } else if (!isWatchable && this.intervalRefs[pair.id]) {
        clearInterval(this.intervalRefs[pair.id]);
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

      // 3. Inicializar manifiesto del par si no existe
      if (!this.manifests[pair.id]) {
        this.manifests[pair.id] = {};
      }

      // 4. Iniciar sincronización recursiva de todo el árbol de directorios
      await this.syncDirectoryTree(pair.localPath, remoteFolderId, pair, '');

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
      // Solo disparar sincronización pendiente si proviene de cambios reales del usuario durante el proceso
      if (this.pendingSyncs.has(pairId)) {
        this.pendingSyncs.delete(pairId);
        setTimeout(() => this.triggerSync(pairId), 5000);
      }
    }
  }

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
    if (!this.accessToken) return;
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });
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
              await fs.unlink(possibleStub).catch(() => null);

              const targetDownloadPath = (localEntry && this.settings.conflictResolution === 'rename')
                ? path.join(localDir, `(Remote) ${remoteFile.name}`)
                : fullLocalPath;

              await this.downloadDriveBinary(remoteFile.id, targetDownloadPath, remoteFile.modifiedTime);

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

  // --- GOOGLE DRIVE API IMPLEMENTATION ---

  private async handleDriveResponse(res: Response) {
    if (!res.ok) {
      if (res.status === 401) {
        console.warn('[SyncEngine] Token de Google Drive expirado o inválido (401).');
        this.accessToken = null;
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      const text = await res.text();
      throw new Error(`Drive API error (${res.status}): ${text}`);
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
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)');
      url.searchParams.append('orderBy', 'folder,name');
      url.searchParams.append('pageSize', '1000');
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await fetch(url.toString(), {
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

    const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
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
    if (!this.accessToken) return;
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      await this.handleDriveResponse(res);
    } catch (err: any) {
      console.error(`[Drive/Backend] Error eliminando archivo ID ${fileId}:`, err.message || err);
    }
  }

  private async downloadDriveBinary(fileId: string, destPath: string, modifiedTime: string): Promise<void> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    await this.handleDriveResponse(res);
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, buffer);

    if (modifiedTime) {
      const mtime = new Date(modifiedTime);
      try {
        await fs.utimes(destPath, mtime, mtime);
      } catch (e) {
        // Ignore utimes error
      }
    }
  }

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string): Promise<DriveFile> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    this.driveFolderCache.delete(parentId);
    const name = targetName || path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);

    let mimeType = 'application/octet-stream';
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.zip') mimeType = 'application/zip';
    else if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.json') mimeType = 'application/json';

    const metadata = existingFileId ? { name } : { name, parents: [parentId] };

    try {
      const initUrl = existingFileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,webViewLink';

      const initRes = await fetch(initUrl, {
        method: existingFileId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': fileBuffer.length.toString()
        },
        body: JSON.stringify(metadata)
      });

      if (initRes.ok) {
        const sessionUri = initRes.headers.get('Location');
        if (sessionUri) {
          const uploadRes = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              'Content-Type': mimeType,
              'Content-Length': fileBuffer.length.toString()
            },
            body: fileBuffer as any
          });
          if (uploadRes.ok) return (await uploadRes.json()) as DriveFile;
        }
      }
    } catch (e: any) {
      console.warn('[SyncEngine/Backend] Fallback a subida multipart tras reintentar resumable:', e.message);
    }

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
    const method = existingFileId ? 'PATCH' : 'POST';

    const res = await fetch(url, {
      method,
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