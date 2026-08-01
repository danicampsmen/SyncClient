import fs from 'fs/promises';
import fsSync from 'fs';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import chokidar, { FSWatcher } from 'chokidar';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { CoreSyncLogic, RemoteEntry, SyncPlan, SyncStateSnapshot } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, SyncJournalEntry } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager, VectorClock } from '../shared/VectorClock';
import { scanChanges, computeBlockHashes, lazyHashBatch, isMtimeChanged, hasContentChanged, verifyReadWriteAccess, LocalEntry, ScanResult } from '../shared/Scanner';
import { downloadToAtomicFile, requestTransfer, RESUMABLE_UPLOAD_THRESHOLD, uploadResumableFile, type TransferHttpClient } from './transfer';
import {
  INITIAL_POLL_INTERVAL_MS,
  SYNC_DEBOUNCE_MS,
  TRANSFER_CONCURRENCY,
  WRITE_STABILITY_POLL_INTERVAL_MS,
  WRITE_STABILITY_THRESHOLD_MS,
  nextSyncBackoff,
  pollInterval,
  shouldSkipPoll,
} from './syncPerformance';

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
  private refreshToken: string | null = null;
  private googleClientId: string = process.env.GOOGLE_CLIENT_ID || '';
  private configDir = path.join(os.homedir(), '.config', 'syncclient');
  private configFile = path.join(this.configDir, 'sync_data.json');

  private watchers: Record<string, FSWatcher> = {};
  private watcherRetryCount: Record<string, number> = {};
  private readonly watcherMaxRetries = 5;
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

  private selfWrittenFiles = new Map<string, number>();
  private lastSyncCompleted: Record<string, number> = {};
  private syncBackoff: Record<string, number> = {};
  private syncTriggerSource: Record<string, 'fs-event' | 'poll' | 'manual'> = {};
  private readonly DRIVE_MAX_ATTEMPTS = 3;
  private readonly DRIVE_MIN_REQUEST_INTERVAL_MS = 200;
  private driveRequestTail: Promise<void> = Promise.resolve();
  private nextDriveRequestAt = 0;

  private async runInPool<T>(tasks: (() => Promise<T>)[], concurrency = 3): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, TRANSFER_CONCURRENCY, tasks.length) }, async () => {
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

  private async driveRequest(url: string, init: RequestInit & { duplex?: 'half' }, maxAttempts = this.DRIVE_MAX_ATTEMPTS): Promise<Response> {
    return this.driveRequestFactory(url, () => init, maxAttempts);
  }

  private async driveRequestFactory(
    url: string,
    initFactory: () => RequestInit & { duplex?: 'half' },
    maxAttempts = this.DRIVE_MAX_ATTEMPTS,
  ): Promise<Response> {
    let lastError: unknown;
    let refreshed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = Math.min(32000, 1000 * (2 ** (attempt - 2)));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        await this.waitForDriveSlot();
        const init = initFactory();
        const headers = new Headers(init.headers);
        if (this.accessToken && headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${this.accessToken}`);
        }
        const response = await fetch(url, { ...init, headers });
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          await response.body?.cancel();
          if (await this.refreshAccessToken()) {
            attempt--;
            continue;
          }
        }
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

  private transferClient(): TransferHttpClient {
    return {
      request: (url, init) => this.driveRequest(url, init, 1),
      getAccessToken: () => this.accessToken,
      refreshAccessToken: () => this.refreshAccessToken(),
    };
  }

  constructor() {
    this.init();
  }

  private async init() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });

      try {
        this.db = await createBackend(this.configDir);
        if (this.db) {
          const deviceResult = await getOrCreateDeviceId(this.db);
          this.DEVICE_ID = deviceResult.deviceId;
          console.log(`[SyncEngine] v2 DB initialized, device: ${this.DEVICE_ID}`);

          try {
            const data = await fs.readFile(this.configFile, 'utf8');
            const parsed: any = JSON.parse(data);
            const jsonManifests = parsed.manifests as Record<string, Record<string, ManifestEntry>> | undefined;
            if (jsonManifests && Object.keys(jsonManifests).length > 0) {
              let hasDbData = false;
              for (const pairId of Object.keys(jsonManifests)) {
                const folderState = this.db.getFolderState(pairId);
                if (folderState.size > 0) { hasDbData = true; break; }
              }
              if (!hasDbData) {
                for (const [pairId, entries] of Object.entries(jsonManifests)) {
                  for (const [relPath, entry] of Object.entries(entries)) {
                    this.db.setFileState(pairId, relPath, {
                      pair_id: pairId, rel_path: relPath, remote_id: entry.remoteId, local_mtime: entry.localMtime,
                      remote_mtime: entry.remoteMtime, file_size: null, md5_hash: null, block_hashes: null,
                      vector_clock: JSON.stringify({ [this.DEVICE_ID!]: 1 }), device_id: this.DEVICE_ID!,
                      etag: null, updated_at: Date.now(), is_tombstone: 0
                    });
                  }
                }
                console.log(`[SyncEngine] Migrated ${Object.keys(jsonManifests).length} pairs from JSON to SQLite`);
              }
            }
          } catch { }
        }
      } catch (e: any) {
        console.warn('[SyncEngine] DB init failed, using JSON only:', e?.message || e);
      }

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
      } catch (e: any) { }

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
        if (now - timestamp > 30000) this.selfWrittenFiles.delete(key);
      }
    }
  }

  private isSelfWritten(filePath: string): boolean {
    if (!filePath) return false;
    const timestamp = this.selfWrittenFiles.get(filePath);
    if (!timestamp) return false;
    if (Date.now() - timestamp < 15000) return true;
    this.selfWrittenFiles.delete(filePath);
    return false;
  }

  private async saveState() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const data = { pairs: this.pairs, events: this.events.slice(0, 200), settings: this.settings, manifests: this.manifests, pendingConflicts: this.pendingConflicts };
      const tmpFile = `${this.configFile}.tmp.${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmpFile, this.configFile);
    } catch (err) { }
  }

  public setToken(accessToken: string | null, refreshToken?: string | null) {
    const prev = this.accessToken;
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;
    if (accessToken && prev !== accessToken) {
      this.pairs.forEach(p => { if (p.status === 'unauthenticated') p.status = 'idle'; });
      this.triggerAllActive();
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.googleClientId || '', refresh_token: this.refreshToken, grant_type: 'refresh_token' }).toString(),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.error === 'invalid_grant') this.refreshToken = null;
        return false;
      }
      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        return true;
      }
      return false;
    } catch { return false; }
  }

  public getToken(): string | null { return this.accessToken; }

  public getStatus() {
    return {
      pairs: this.pairs, events: this.events, settings: this.settings,
      pendingConflicts: this.pendingConflicts, authenticated: !!this.accessToken,
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
                this.detectedExternalDrives.push({ path: drivePath, name: entry.name, detectedAt: Date.now() });
              }
            }
          }
        } catch { }
      }
    }, 5000);
  }

  public async setPairs(pairs: SyncPair[]) {
    this.pairs = pairs.map(p => ({ ...p, localPath: p.localPath.startsWith('~/') ? path.join(os.homedir(), p.localPath.slice(2)) : p.localPath }));
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
    } else if (pair.status === 'syncing' || pair.status === 'paused') {
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
      const pair = this.pairs.find(p => p.id === conflict.pairId);
      if (pair) {
        const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'upload', conflict.remoteFileId);
        try {
          await this.uploadDriveBinary(pair.remotePath, conflict.localPath, conflict.remoteFileName, conflict.remoteFileId, undefined, operationId);
          if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        } catch (error) {
          if (operationId && this.db) this.db.updateOperation(operationId, {
            status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
          });
          throw error;
        }
      }
    } else if (resolution === 'remote') {
      const pair = this.pairs.find(p => p.id === conflict.pairId);
      if (pair) {
        const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'download', conflict.remoteFileId);
        try {
          await this.downloadDriveBinary(conflict.remoteFileId, conflict.localPath, new Date(conflict.remoteMtime).toISOString());
          if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        } catch (error) {
          if (operationId && this.db) this.db.updateOperation(operationId, {
            status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
          });
          throw error;
        }
      }
    }
    this.pendingConflicts = this.pendingConflicts.filter(c => c.id !== conflictId);
    if (this.db) this.db.resolveConflict(conflictId, resolution);
    await this.saveState();
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };
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
    if (syncMode === 'mirror') await this.hydratePair(pairId);
  }

  public async dehydratePair(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) return;

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
                id: manifestEntry.remoteId, name: entry.name,
                modifiedTime: new Date(manifestEntry.remoteMtime).toISOString(),
                streamUrl: `https://www.googleapis.com/drive/v3/files/${manifestEntry.remoteId}?alt=media`,
                isStub: true
              }, null, 2);
              await fs.writeFile(stubPath, stubContent, 'utf8');
              this.markSelfWritten(stubPath);
              this.markSelfWritten(fullPath);
              await fs.unlink(fullPath).catch(() => null);
            }
          }
        }
      } catch (e) { }
    };
    await dehydrateDir(pair.localPath, '');
    pair.syncMode = 'streaming';
    await this.saveState();
  }

  public async hydratePair(pairId: string) {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) return;

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
                await this.downloadDriveBinary(stub.id, targetRealPath, stub.modifiedTime || new Date().toISOString());
                this.markSelfWritten(fullPath);
                await fs.unlink(fullPath).catch(() => null);
              }
            } catch (err) { }
          }
        }
      } catch (e) { }
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
          const watcher = chokidar.watch(pair.localPath, {
            ignored: (filePath: string) => {
              const base = path.basename(filePath);
              if (base.startsWith('.')) return true;
              return matchesIgnorePattern(base, this.settings.ignoredPatterns);
            },
            persistent: true, ignoreInitial: true, awaitWriteFinish: {
              stabilityThreshold: WRITE_STABILITY_THRESHOLD_MS,
              pollInterval: WRITE_STABILITY_POLL_INTERVAL_MS,
            }
          });

          watcher.on('all', (event, filePath) => {
            if (this.activeSyncs.has(pair.id)) return;
            if (this.isSelfWritten(filePath)) return;

            if (this.debounceTimers[pair.id]) clearTimeout(this.debounceTimers[pair.id]);
            this.debounceTimers[pair.id] = setTimeout(() => {
              this.syncTriggerSource[pair.id] = 'fs-event';
              this.triggerSync(pair.id);
            }, SYNC_DEBOUNCE_MS);
          });

          watcher.on('error', (error) => {
            if (this.watchers[pair.id]) {
              this.watchers[pair.id].close().catch(() => { });
              delete this.watchers[pair.id];
            }
            const retries = (this.watcherRetryCount[pair.id] || 0) + 1;
            this.watcherRetryCount[pair.id] = retries;
            if (retries <= this.watcherMaxRetries) {
              const delay = Math.min(60000, 5000 * (2 ** (retries - 1)));
              setTimeout(() => this.refreshWatchers(), delay);
            }
          });

          this.watchers[pair.id] = watcher;
          this.watcherRetryCount[pair.id] = 0;
        } catch (err) { }
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
        const scheduleNext = () => {
          const interval = pollInterval(this.syncBackoff[pair.id]);
          this.intervalRefs[pair.id] = setTimeout(async () => {
            delete this.intervalRefs[pair.id];
            const currentPair = this.pairs.find(candidate => candidate.id === pair.id);
            if (!currentPair || (currentPair.status !== 'syncing' && currentPair.status !== 'idle')) return;
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
      if (p.status === 'syncing' || p.status === 'idle') this.triggerSync(p.id);
    });
  }

  public async triggerSync(pairId: string) {
    if (!this.accessToken) return;
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || pair.status === 'paused') return;

    const lastCompleted = this.lastSyncCompleted[pairId] || 0;
    const triggerSource = this.syncTriggerSource[pairId] || 'manual';

    if (triggerSource === 'poll' && shouldSkipPoll(lastCompleted, Date.now())) {
      this.syncTriggerSource[pairId] = 'manual';
      return;
    }

    if (this.activeSyncs.has(pairId)) {
      this.pendingSyncs.add(pairId);
      return;
    }

    this.activeSyncs.add(pairId);
    pair.status = 'syncing';
    pair.progress = { currentFile: 'Verificando carpetas y duplicados...', totalFiles: 0, currentFileIndex: 0, bytesTransferred: 0, totalBytes: 0, percentage: 0, action: 'comprobando' };

    try {
      let remoteFolderId = 'root';
      let remotePathParts = pair.remotePath.replace(/^(RemoteServer|GoogleDrive|Drive):/, '').replace(/^[\/\\]+/, '').split('/').filter(Boolean);

      if (pair.cloudCategory === 'computers' && remotePathParts[0] !== 'Ordenadores' && remotePathParts[0] !== 'Computers') {
        const deviceLabel = pair.deviceName || os.hostname() || 'Dispositivo-Linux';
        remotePathParts = ['Ordenadores', deviceLabel, ...remotePathParts];
      }

      for (const part of remotePathParts) {
        const files = await this.listDriveFiles(remoteFolderId);
        let folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
        if (!folder) folder = await this.createDriveFolder(remoteFolderId, part);
        remoteFolderId = folder.id;
      }

      await fs.mkdir(pair.localPath, { recursive: true });

      if (USE_V2_SYNC && this.db && this.DEVICE_ID) {
        await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
      } else {
        if (!this.manifests[pair.id]) this.manifests[pair.id] = {};
        await this.syncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
      }

      pair.lastSynced = Date.now();
      pair.status = 'idle';

      const finalTotalFiles = pair.progress?.totalFiles ?? 0;
      const finalFilesProcessed = pair.progress?.currentFileIndex ?? 0;
      const finalBytesTransferred = pair.progress?.bytesTransferred ?? 0;
      const finalTotalBytes = pair.progress?.totalBytes ?? 0;

      pair.progress = {
        currentFile: finalBytesTransferred > 0 ? `${finalFilesProcessed} archivo(s) sincronizado(s)` : 'Todo al día',
        totalFiles: finalTotalFiles, currentFileIndex: finalFilesProcessed,
        bytesTransferred: finalBytesTransferred, totalBytes: finalTotalBytes > 0 ? finalTotalBytes : finalBytesTransferred,
        percentage: 100, action: 'completado'
      };
      
      setTimeout(() => { if (pair && pair.status === 'idle') { pair.progress = null; this.saveState(); } }, 4000);
      await this.saveState();
    } catch (err: any) {
      if (err.message === 'UNAUTHORIZED_EXPIRED_TOKEN') pair.status = 'unauthenticated';
      else pair.status = 'error';
      pair.progress = null;
      await this.saveState();
    } finally {
      this.activeSyncs.delete(pairId);
      this.driveFolderCache.clear();

      this.lastSyncCompleted[pairId] = Date.now();
      const filesProcessed = pair.progress?.currentFileIndex ?? 0;
      const bytesTransferred = pair.progress?.bytesTransferred ?? 0;

      if (filesProcessed === 0 && bytesTransferred === 0) {
        const currentBackoff = this.syncBackoff[pairId] || INITIAL_POLL_INTERVAL_MS;
        this.syncBackoff[pairId] = nextSyncBackoff(currentBackoff);
      } else {
        this.syncBackoff[pairId] = INITIAL_POLL_INTERVAL_MS;
      }
      this.syncTriggerSource[pairId] = 'manual';

      if (this.pendingSyncs.has(pairId)) {
        this.pendingSyncs.delete(pairId);
        setTimeout(() => this.triggerSync(pairId), 5000);
      }
    }
  }

  // ─── v2: SyncDirectoryTree con 5 fases ─────────────────────────

  private beginTransferOperation(pairId: string, relPath: string, operationType: 'upload' | 'download', remoteId: string | null): string | null {
    if (!this.db) return null;
    const existing = this.db.getRecoverableOperations(pairId)
      .find(operation => operation.rel_path === relPath && operation.operation_type === operationType);
    const operationId = existing?.id ?? `${pairId}:${operationType}:${relPath}:${Date.now()}`;
    if (!existing) {
      const now = Date.now();
      this.db.createOperation({
        id: operationId, pair_id: pairId, rel_path: relPath, operation_type: operationType,
        remote_id: remoteId, status: 'pending', attempts: 0, last_error: null, created_at: now, updated_at: now,
      });
    }
    this.db.updateOperation(operationId, {
      status: 'running',
      attempts: (existing?.attempts ?? 0) + 1,
      last_error: null,
      updated_at: Date.now(),
    });
    return operationId;
  }

  private async v2SyncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = '') {
    if (!this.db || !this.DEVICE_ID) return;

    await this.reconcileWithHttp304(pair.id, remoteFolderId);

    const dbState = this.db.getFolderState(pair.id);
    const scanResult = await scanChanges(localDir, dbState, fs, pair.id);
    if (scanResult === 'PERMISSION_DENIED') {
      pair.status = 'error' as any;
      return;
    }

    const remoteFiles = await this.listDriveFiles(remoteFolderId, true);

    const localSnapshot = new Map<string, { name: string; mtime: number; size: number }>();
    
    // 1. Rellenar con todos los archivos vivos de la BD filtrando ignorados
    for (const [relPath, state] of dbState) {
      if (!state.is_tombstone && !scanResult.deleted.includes(relPath)) {
        if (matchesIgnorePattern(path.basename(relPath), this.settings.ignoredPatterns)) continue;
        localSnapshot.set(relPath, { name: path.basename(relPath), mtime: state.local_mtime || 0, size: state.file_size || 0 });
      }
    }
    // 2. Sobrescribir con cambios reales del escáner
    for (const [relPath, entry] of scanResult.changed) {
      if (!matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) localSnapshot.set(relPath, { name: entry.name, mtime: entry.mtime, size: entry.size });
    }
    for (const [relPath, entry] of scanResult.created) {
      if (!matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) localSnapshot.set(relPath, { name: entry.name, mtime: entry.mtime, size: entry.size });
    }

    const remoteSnapshot = new Map<string, RemoteEntry>();
    for (const file of remoteFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      remoteSnapshot.set(file.name, {
        id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime,
        size: file.size, md5Checksum: file.md5Checksum, appProperties: file.appProperties, etag: undefined
      });
    }

    const dbStateForPlan = new Map<string, SyncStateSnapshot>();
    for (const [relPath, state] of dbState) {
      dbStateForPlan.set(relPath, {
        localMtime: state.local_mtime || 0,
        remoteMtime: state.remote_mtime || 0,
        remoteId: state.remote_id || '',
        fileSize: state.file_size,
        baseHash: state.md5_hash,
        vectorClock: state.vector_clock,
        isTombstone: state.is_tombstone === 1
      });
    }
    
    const plan = CoreSyncLogic.computeSyncPlan(localSnapshot, remoteSnapshot, dbStateForPlan, this.DEVICE_ID);
    for (const conflict of plan.conflicts) {
      const conflictId = `${pair.id}:${conflict.localPath}:${conflict.remoteFile.id}:${conflict.baseHash ?? 'none'}`;
      this.db.setConflict({
        id: conflictId,
        pair_id: pair.id,
        rel_path: conflict.localPath,
        local_hash: conflict.localHash ?? null,
        remote_hash: conflict.remoteHash ?? null,
        base_hash: conflict.baseHash ?? null,
        resolution: 'pending',
        created_at: Date.now(),
      });
      if (!this.pendingConflicts.some(existing => existing.id === conflictId)) {
        this.pendingConflicts.push({
          id: conflictId,
          pairId: pair.id,
          relativePath: conflict.localPath,
          localPath: conflict.localPath,
          localMtime: 0,
          remoteFileId: conflict.remoteFile.id,
          remoteFileName: conflict.remoteFile.name,
          remoteMtime: new Date(conflict.remoteFile.modifiedTime).getTime(),
          timestamp: Date.now(),
        });
      }
    }
    const completedUploads = new Set<string>();
    const completedDownloads = new Set<string>();
    const uploadCommits: Array<{ journalId: number; operationId: string | null }> = [];
    const downloadCommits: Array<{ journalId: number; operationId: string | null }> = [];

    for (const upload of plan.uploads) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, upload.localPath);
      const journalId = this.db.journalStart(pair.id, 'upload_start', upload.localPath, upload.remoteId);
      const operationId = this.beginTransferOperation(pair.id, upload.localPath, 'upload', upload.remoteId || null);
      try {
        let stats;
        try {
          stats = await fs.stat(fullLocalPath);
        } catch (error) {
          this.db.journalFail(journalId);
          if (operationId) this.db.updateOperation(operationId, {
            status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
          });
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
            filename: upload.remoteName, action: 'info', timestamp: Date.now(),
            details: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
          }, true);
          continue;
        }
        
        if (pair.progress) { pair.progress.currentFile = upload.remoteName; pair.progress.action = 'subiendo'; }

        const uploadedFile = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, upload.remoteName, upload.remoteId, upload.vectorClock, operationId);
        
        upload.remoteId = uploadedFile.id;
        (upload as any).remoteMtime = new Date(uploadedFile.modifiedTime).getTime();
        (upload as any).remoteSize = uploadedFile.size ? parseInt(uploadedFile.size, 10) : stats.size;
        (upload as any).remoteMd5 = uploadedFile.md5Checksum || null;

        uploadCommits.push({ journalId, operationId });
        completedUploads.add(upload.localPath);
        
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: upload.remoteName, action: 'uploaded', timestamp: Date.now()
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        if (operationId) this.db.updateOperation(operationId, {
          status: 'retry', last_error: e instanceof Error ? e.message : String(e), updated_at: Date.now(),
        });
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: upload.remoteName, action: 'info', timestamp: Date.now(),
          details: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        }, true);
        if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
      }
    }

    const downloadedLocalMtimes = new Map<string, number>();
    for (const download of plan.downloads) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, download.localPath);
      const journalId = this.db.journalStart(pair.id, 'download_start', download.localPath, download.remoteFile.id);
      const operationId = this.beginTransferOperation(pair.id, download.localPath, 'download', download.remoteFile.id);
      try {
        if (pair.progress) { pair.progress.currentFile = download.remoteFile.name; pair.progress.action = 'descargando'; }
        const remoteTime = new Date(download.remoteFile.modifiedTime).getTime();
        await this.downloadDriveBinary(download.remoteFile.id, fullLocalPath, download.remoteFile.modifiedTime, download.remoteFile.md5Checksum, download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : undefined);
        
        const downloadedStats = await fs.stat(fullLocalPath);
        downloadedLocalMtimes.set(download.localPath, downloadedStats?.mtimeMs ?? Date.now());
        
        downloadCommits.push({ journalId, operationId });
        completedDownloads.add(download.localPath);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: download.remoteFile.name, action: 'downloaded', timestamp: Date.now()
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        if (operationId) this.db.updateOperation(operationId, {
          status: 'retry', last_error: e instanceof Error ? e.message : String(e), updated_at: Date.now(),
        });
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: download.remoteFile.name, action: 'info', timestamp: Date.now(),
          details: `Download failed: ${e instanceof Error ? e.message : String(e)}`,
        }, true);
        if (e.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw e;
      }
    }

    for (const del of plan.deleteLocal) {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, del.localPath);
      const journalId = this.db.journalStart(pair.id, 'delete_local_start', del.localPath);
      try {
        this.markSelfWritten(fullLocalPath);
        await fs.rm(fullLocalPath, { force: true }).catch(() => { });
        this.db.journalDone(journalId);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado localmente'
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
      }
    }

    for (const del of plan.deleteRemote) {
      if ((pair.status as string) === 'paused') return;
      const journalId = this.db.journalStart(pair.id, 'delete_remote_start', del.localPath, del.remoteId);
      try {
        await this.deleteDriveFile(del.remoteId, remoteFolderId);
        this.db.journalDone(journalId);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado en Drive'
        }, true);
      } catch (e: any) {
        this.db.journalFail(journalId);
        if (e.message?.includes('404') || e.message?.includes('File not found')) {
           this.db.journalDone(journalId);
        }
      }
    }

    const updates = new Map<string, FileState>();
    const now = Date.now();

    for (const upload of plan.uploads) {
      if (!completedUploads.has(upload.localPath)) continue;
      updates.set(upload.localPath, {
        pair_id: pair.id, rel_path: upload.localPath,
        remote_id: upload.remoteId || null, local_mtime: now, remote_mtime: (upload as any).remoteMtime || now,
        file_size: (upload as any).remoteSize ?? null, md5_hash: (upload as any).remoteMd5 ?? null, block_hashes: null,
        vector_clock: upload.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    for (const download of plan.downloads) {
      if (!completedDownloads.has(download.localPath)) continue;
      updates.set(download.localPath, {
        pair_id: pair.id, rel_path: download.localPath,
        remote_id: download.remoteFile.id, local_mtime: downloadedLocalMtimes.get(download.localPath) ?? now, remote_mtime: new Date(download.remoteFile.modifiedTime).getTime(),
        file_size: download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : null,
        md5_hash: download.remoteFile.md5Checksum || null, block_hashes: null,
        vector_clock: download.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    for (const del of plan.deleteLocal) {
      updates.set(del.localPath, {
        pair_id: pair.id, rel_path: del.localPath, remote_id: del.remoteId || null, local_mtime: null, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null, vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    for (const del of plan.deleteRemote) {
      updates.set(del.localPath, {
        pair_id: pair.id, rel_path: del.localPath, remote_id: del.remoteId || null, local_mtime: null, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null, vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    const subDirs = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const localDirs = await fs.readdir(localDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const dirNames = new Set<string>();
    for (const dir of localDirs) { if (dir.isDirectory()) dirNames.add(dir.name); }
    for (const dir of remoteFiles) { if (dir.mimeType === 'application/vnd.google-apps.folder') dirNames.add(dir.name); }

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

    this.db.commitTransfer(
      pair.id,
      updates,
      [...uploadCommits, ...downloadCommits].map(commit => commit.journalId),
      [...uploadCommits, ...downloadCommits]
        .map(commit => commit.operationId)
        .filter((operationId): operationId is string => operationId !== null),
    );
    this.db.vacuum();
  }

  private async reconcileWithHttp304(pairId: string, remoteFolderId: string): Promise<void> {
    if (!this.db || !this.accessToken) return;
    const dbState = this.db.getFolderState(pairId);
    const pendingDeletes: string[] = [];

    for (const [relPath, state] of dbState) {
      if (!state.remote_id || state.is_tombstone) continue;
      try {
        const modifiedSince = state.remote_mtime ? new Date(state.remote_mtime).toUTCString() : undefined;
        const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
        if (modifiedSince) headers['If-Modified-Since'] = modifiedSince;

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${state.remote_id}?fields=modifiedTime,md5Checksum,size`, {
          method: 'GET', headers
        });

        if (res.status === 304) continue;
        if (res.status === 404) { pendingDeletes.push(relPath); continue; }
        if (res.status === 401) throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
        await this.handleDriveResponse(res);

        if (res.ok) {
          const data = await res.json();
          const updatedState: FileState = {
            ...state, remote_mtime: new Date(data.modifiedTime).getTime(),
            md5_hash: data.md5Checksum || state.md5_hash, file_size: data.size ? parseInt(data.size, 10) : state.file_size,
            updated_at: Date.now()
          };
          this.db.setFileState(pairId, relPath, updatedState);
        }
      } catch (e: any) { }
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

  // ─── Legacy syncDirectoryTree ────────────────────
  private async deduplicateLocalFolder(localDir: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> { return { deleted: 0, renamed: 0 }; }
  private async deduplicateDriveFolder(remoteFolderId: string, pairId?: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> { return { deleted: 0, renamed: 0 }; }
  private async renameDriveFile(fileId: string, newName: string, parentId: string): Promise<void> { }
  private async syncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = '') { }

  private addEvent(ev: SyncEvent, skipSave = false) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.pop();
    if (!skipSave) this.saveState();
  }

  private async handleDriveResponse(res: Response): Promise<Response> {
    if (!res.ok) {
      if (res.status === 401) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) throw new Error('TOKEN_REFRESHED_RETRY');
        this.accessToken = null;
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      if (res.status === 412) throw new Error('DRIVE_PRECONDITION_FAILED_412');
      if (res.status === 304) return res;
      throw new Error(`Drive API error (${res.status})`);
    }
    return res;
  }

  private async listDriveFiles(folderId: string, forceRefresh = false): Promise<DriveFile[]> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const cached = this.driveFolderCache.get(folderId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp < 60000)) return cached.files;
    
    let files: DriveFile[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('q', `'${folderId}' in parents and trashed = false`);
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink, appProperties)');
      url.searchParams.append('orderBy', 'folder,name');
      url.searchParams.append('pageSize', '1000');
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await this.driveRequest(url.toString(), { headers: { Authorization: `Bearer ${this.accessToken}` } });
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
    const res = await this.driveRequest('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    await this.handleDriveResponse(res);
    return (await res.json()) as DriveFile;
  }

  private async deleteDriveFile(fileId: string, parentId?: string): Promise<void> {
    if (parentId) this.driveFolderCache.delete(parentId);
    const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    await this.handleDriveResponse(res);
  }

  private async downloadDriveBinary(fileId: string, destPath: string, modifiedTime: string, expectedMd5?: string, expectedSize?: number): Promise<void> {
    await downloadToAtomicFile({
      sourceUrl: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      destinationPath: destPath,
      modifiedTime,
      expectedMd5,
      expectedSize,
      client: this.transferClient(),
      markSelfWritten: filePath => this.markSelfWritten(filePath),
    });
  }

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string, vectorClock?: string, operationId?: string | null): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    const name = targetName || path.basename(filePath);
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    let mimeType = 'application/octet-stream';
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.txt') mimeType = 'text/plain';

    const appProperties = vectorClock ? VectorClockManager.toAppProperties(VectorClockManager.fromString(vectorClock)) : undefined;
    const metadata = existingFileId ? { name, ...(appProperties ? { appProperties } : {}) } : { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
    const initUrl = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink';

    if (fileSize > RESUMABLE_UPLOAD_THRESHOLD) {
      const client = this.transferClient();
      const resumableOperationId = operationId ?? `upload:${filePath}:${fileSize}`;
      const session = this.db && operationId ? this.db.getUploadSession(operationId) : null;
      const uploaded = await uploadResumableFile({
        filePath,
        fileSize,
        operationId: resumableOperationId,
        remoteId: existingFileId ?? null,
        session,
        client,
        createSession: async () => {
          const response = await requestTransfer(
            client,
            initUrl,
            () => ({
              method: existingFileId ? 'PATCH' : 'POST',
              headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': String(fileSize),
              },
              body: JSON.stringify(metadata),
            }),
          );
          if (!response.ok) throw new Error(`Drive resumable session initialization failed (${response.status})`);
          return response;
        },
        persistSession: nextSession => {
          if (this.db && operationId) this.db.setUploadSession(nextSession);
        },
        deleteSession: () => {
          if (this.db && operationId) this.db.deleteUploadSession(operationId);
        },
      });
      return uploaded as unknown as DriveFile;
    }

    const boundary = '-------SyncClientBoundary' + Math.random().toString(36);
    const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyPayload = () => Readable.from((async function* () {
      yield header;
      for await (const chunk of fsSync.createReadStream(filePath)) yield chunk;
      yield footer;
    })());
    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink';
    const res = await this.driveRequestFactory(url, () => ({
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(header.length + fileSize + footer.length),
      },
      body: bodyPayload() as any,
      duplex: 'half',
    }));
    await this.handleDriveResponse(res);
    return (await res.json()) as DriveFile;
  }
}

export const syncEngine = new SyncEngine();