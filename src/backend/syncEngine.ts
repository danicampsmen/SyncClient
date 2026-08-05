import fs from 'fs/promises';
import fsSync from 'fs';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import parcelWatcher, { AsyncSubscription } from '@parcel/watcher';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { CoreSyncLogic, RemoteEntry, SyncStateSnapshot, DEFAULT_REMOTE_PATH } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, DriveCursor } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager } from '../shared/VectorClock';
import { scanChanges, computeBlockHashes } from '../shared/Scanner';
import { NodeFileSystem } from '../utils/nodeFileSystem';
import { downloadToAtomicFile, requestTransfer, RESUMABLE_UPLOAD_THRESHOLD, uploadResumableFile, type TransferHttpClient, FileNotFoundError, TransferHttpError } from './transfer';
import { acquirePairLock, PairAlreadyRunningError, type PairLock } from './pairProcessLock';
import { DriveChangesIngestor, DriveCursorRescanRequiredError, type DriveChange } from './driveChanges';
import { SecureStore } from '../utils/secureStore';
import { Logger } from './logger';
import { initializeApp, getApp, getApps } from 'firebase/app';
import { getDatabase, ref, onValue } from 'firebase/database';
import { getFirebaseClientConfig } from '../config/firebaseConfig';
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

const SYNCCLIENT_DEBUG = process.env.SYNCCLIENT_DEBUG === 'true';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
  parents?: string[];
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

export const DRIVE_CHANGES_FEATURE_FLAG = 'SYNCCLIENT_DRIVE_CHANGES';

export function isDriveChangesFeatureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  // Habilitado por defecto; desactivar explícitamente con SYNCCLIENT_DRIVE_CHANGES=false para reducir N+1 en listados
  return environment[DRIVE_CHANGES_FEATURE_FLAG] !== 'false';
}

export class SyncEngine {
  private logger = new Logger('SyncEngine');
  private pairs: SyncPair[] = [];
  private events: SyncEvent[] = [];
  private settings: SyncSettings = {
    maxDownloadSpeed: 0,
    maxUploadSpeed: 0,
    conflictResolution: 'prompt',
    ignoredPatterns: ['.#*', '*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.synctex(busy)', '*.run.xml', '*.bcf*', '*.bbl*', '*.blg', '*.ind', '*.ilg', '*.idx', 'auto', '*.minted', '_minted-*', '*.snm', '*.nav', '*.cwl', '*.conflict*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp', '*.syncclient-download-*', '*.syncclient-tmp-*', '__MACOSX', 'Thumbs.db', 'desktop.ini', '*.pyc', '__pycache__', '*.pyi', '.ttxfolder', '.venv', 'venv', 'env'],
    autoStart: false,
    desktopNotifications: true
  };
  private manifests: Record<string, Record<string, ManifestEntry>> = {};
  private pendingConflicts: PendingConflict[] = [];
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private googleClientId: string = process.env.GOOGLE_CLIENT_ID || '';
  private googleClientSecret: string = process.env.GOOGLE_CLIENT_SECRET || '';
  private configDir = path.join(os.homedir(), '.config', 'syncclient');
  private configFile = path.join(this.configDir, 'sync_data.json');

  private watchers: Record<string, AsyncSubscription> = {};
  private syncTriggerSource: Record<string, 'manual' | 'poll' | 'webhook' | 'fs-event'> = {};
  private activeSyncs = new Set<string>();
  private pendingSyncs = new Set<string>();
  private pendingResync = new Set<string>();
  private activeTransfers = new Set<string>();
  private watcherRetryCount: Record<string, number> = {};
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
  private lastProcessedWebhookEvent: Record<string, number> = {};
  private activeWebhooks = new Set<string>();
  private webhooksInitialized = false;
  private syncBackoff: Record<string, number> = {};
  private readonly DRIVE_MAX_ATTEMPTS = 3;
  private readonly DRIVE_MIN_REQUEST_INTERVAL_MS = 200;
  private readonly DRIVE_LIST_MAX_PAGES = 1000;
  private readonly VACUUM_INTERVAL_MS = 6 * 60 * 60 * 1000;
  private driveRequestTail: Promise<void> = Promise.resolve();
  private nextDriveRequestAt = 0;
  private lastVacuumAt = 0;
  private readonly driveCursorRescans = new Set<string>();
  private readonly driveChangesCacheReady = new Set<string>();
  private readonly interruptRequested: Record<string, { eventTimestamp: number }> = {};
  private readonly WEBHOOK_INTERRUPT = 'WEBHOOK_INTERRUPT';
  private readonly INTERRUPT_COOLDOWN_MS = 2000;
  private lastInterruptTime: Record<string, number> = {};
  private readonly pendingLocalEvents: Record<string, { relPath: string; localEvent: 'create' | 'update' | 'delete' }[]> = {};
  private tokenRefreshPromise: Promise<boolean> | null = null;

  private ensureInterrupt(pairId: string): boolean {
    const now = Date.now();
    const last = this.lastInterruptTime[pairId] || 0;
    if (now - last < this.INTERRUPT_COOLDOWN_MS) return false;
    this.lastInterruptTime[pairId] = now;
    return true;
  }

  private async runInPool<T>(tasks: (() => Promise<T>)[], concurrency = 3): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    const errors: unknown[] = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, TRANSFER_CONCURRENCY, tasks.length) }, async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err: unknown) {
          errors.push(err);
          this.logger.error(`[SyncEngine/BackendPool] Error en tarea concurrente:`, err instanceof Error ? err.message : err);
        }
      }
    });
    await Promise.all(workers);
    if (errors.length > 0) {
      const firstError = errors[0];
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return results;
  }

  private maybeVacuumDatabase(): void {
    if (!this.db) return;
    const now = Date.now();
    if (now - this.lastVacuumAt < this.VACUUM_INTERVAL_MS) return;
    this.db.vacuum();
    this.lastVacuumAt = now;
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
        const response = await fetch(url, { 
          ...init, 
          headers, 
          signal: init.signal !== undefined ? (init.signal as any) : AbortSignal.timeout(15000) 
        });
        let isRateLimit = response.status === 429;
        let isAuthError = response.status === 401;

        if (response.status === 403) {
          try {
            const clone = response.clone();
            const errJson = await clone.json();
            const reason = errJson?.error?.errors?.[0]?.reason;
            if (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded') {
              isRateLimit = true;
            } else {
              isAuthError = true;
            }
          } catch (e) {
            isAuthError = true;
          }
        }

        if (isAuthError && !refreshed) {
          refreshed = true;
          await response.body?.cancel();
          if (await this.refreshAccessToken()) {
            attempt--;
            continue;
          }
        }
        if (!(this.isTransientDriveStatus(response.status) || isRateLimit) || attempt === maxAttempts) {
          return response;
        }
        await response.body?.cancel().catch(error => {
          this.logger.debug('[SyncEngine/Drive] Could not cancel transient response body before retry:', error instanceof Error ? error.message : String(error));
        });
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
      request: (url, init) => this.driveRequest(url, { ...init, signal: null }, 1),
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
          this.logger.info(`v2 DB initialized, device: ${this.DEVICE_ID}`);

          try {
            const data = await fs.readFile(this.configFile, 'utf8');
            const parsed: { manifests?: Record<string, Record<string, ManifestEntry>> } = JSON.parse(data);
            const jsonManifests = parsed.manifests;
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
                this.logger.info(`[SyncEngine] Migrated ${Object.keys(jsonManifests).length} pairs from JSON to SQLite`);
              }
            }
          } catch (error) {
            this.logger.warn('[SyncEngine] Legacy manifest migration skipped; SQLite state is preserved:', error instanceof Error ? error.message : String(error));
          }
        }
      } catch (e: unknown) {
        this.logger.warn('[SyncEngine] DB init failed, using JSON only:', e instanceof Error ? e.message : String(e));
      }

      try {
        const data = await fs.readFile(this.configFile, 'utf8');
        const parsed: {
          pairs?: SyncPair[];
          events?: SyncEvent[];
          settings?: SyncSettings;
          manifests?: Record<string, Record<string, ManifestEntry>>;
          pendingConflicts?: PendingConflict[];
        } = JSON.parse(data);
        if (parsed.pairs) this.pairs = parsed.pairs;
        if (parsed.events) this.events = parsed.events.slice(0, 200);
        if (parsed.settings) {
          this.settings = parsed.settings;
          const defaultPatterns = ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.synctex(busy)', '*.run.xml', '*.bcf*', '*.bbl*', '*.blg', '*.ind', '*.ilg', '*.idx', 'auto', '*.minted', '_minted-*', '*.snm', '*.nav', '*.cwl', '*.conflict*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp', '*.syncclient-download-*', '*.syncclient-tmp-*', '__MACOSX', 'Thumbs.db', 'desktop.ini', '*.pyc', '__pycache__', '*.pyi', '.ttxfolder', '.venv', 'venv', 'env'];
          const current = new Set(this.settings.ignoredPatterns || []);
          defaultPatterns.forEach(p => current.add(p));
          this.settings.ignoredPatterns = Array.from(current);
        }
        if (parsed.manifests && !this.db) this.manifests = parsed.manifests;
        if (parsed.pendingConflicts) this.pendingConflicts = parsed.pendingConflicts;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn('[SyncEngine] State file could not be loaded; keeping defaults:', e instanceof Error ? e.message : String(e));
        }
      }

      if (this.pairs.length > 0) {
        let modified = false;
        this.pairs.forEach(p => {
          if (p.localPath.startsWith('~/')) {
            p.localPath = path.join(os.homedir(), p.localPath.slice(2));
            modified = true;
          }
          if (p.remotePath === 'GoogleDrive:/Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:/Apuntes en pdf - tablet' || p.remotePath === 'GoogleDrive:Apuntes_Tablet_StarNote' || p.remotePath === 'GoogleDrive:/Documentos-Ubuntu/Apuntes_Tablet_StarNote') {
            p.remotePath = DEFAULT_REMOTE_PATH;
            modified = true;
          }
        });
        if (modified) await this.saveState();
      }
      await this.recoverPendingWork();
      this.refreshWatchers();
      this.refreshIntervals();
      this.startExternalDriveMonitor();
    } catch (err) {
      this.logger.error('[SyncEngine] Init error:', err);
    }
  }

  private markSelfWritten(filePath: string) {
    if (!filePath) return;
    const normalized = path.normalize(filePath);
    this.selfWrittenFiles.set(normalized, Date.now());
    if (this.selfWrittenFiles.size > 200) {
      const now = Date.now();
      for (const [key, timestamp] of this.selfWrittenFiles.entries()) {
        if (now - timestamp > 30000) this.selfWrittenFiles.delete(key);
      }
    }
  }

  private isSelfWritten(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = path.normalize(filePath);
    const timestamp = this.selfWrittenFiles.get(normalized);
    if (!timestamp) return false;
    if (Date.now() - timestamp < 15000) return true;
    this.selfWrittenFiles.delete(normalized);
    return false;
  }

  private sharedPairLockDirectory(): string {
    return path.join(this.configDir, 'pair-locks');
  }

  private isDriveChangesEnabled(): boolean {
    return isDriveChangesFeatureEnabled();
  }

  private lastRecoveryAttempt: Record<string, number> = {};

  private async recoverPendingWork(): Promise<void> {
    if (!this.db) return;

    const now = Date.now();

    for (const pair of this.pairs) {
      const lastAttempt = this.lastRecoveryAttempt[pair.id] || 0;
      if (now - lastAttempt < 60000) continue;

      const operations = this.db.getRecoverableOperations(pair.id);
      const journalEntries = this.db.getPendingJournalEntries(pair.id);
      if (operations.length === 0 && journalEntries.length === 0) continue;

      this.lastRecoveryAttempt[pair.id] = now;

      const detail = `Recovery queued: ${operations.length} operation(s), ${journalEntries.length} pending journal entr${journalEntries.length === 1 ? 'y' : 'ies'}`;
      this.logger.warn(`[Recovery] pair=${pair.id} ${detail}`);
      this.addEvent({
        id: Math.random().toString(36).slice(2, 11),
        pairId: pair.id,
        filename: pair.localPath,
        action: 'info',
        timestamp: Date.now(),
        details: detail,
      }, true);

      if (pair.status === 'error') pair.status = 'idle';
      if (pair.status !== 'paused' && pair.status !== 'unauthenticated' && this.accessToken) {
        this.driveChangesCacheReady.delete(pair.id);
        if (this.ensureInterrupt(pair.id)) {
          this.interruptRequested[pair.id] = { eventTimestamp: Date.now() };
        }
        await this.triggerSync(pair.id);
      }
    }
  }

  private applyDriveChange(pairId: string, change: DriveChange): void {
    interface RawFile {
      id: unknown;
      name: unknown;
      mimeType: unknown;
      modifiedTime: unknown;
      size?: unknown;
      webViewLink?: unknown;
      md5Checksum?: unknown;
      appProperties?: unknown;
      parents?: unknown;
    }

    if (change.removed) {
      for (const [folderId, cached] of this.driveFolderCache) {
        const next = cached.files.filter(file => file.id !== change.fileId);
        if (next.length !== cached.files.length) {
          this.driveFolderCache.set(folderId, { ...cached, files: next });
        }
      }
      return;
    }

    if (!change.file) {
      throw new Error(`Incomplete Drive change for pair ${pairId}: ${change.fileId}`);
    }
    const rawFile = change.file as unknown as RawFile;
    if (typeof rawFile.id !== 'string' || typeof rawFile.name !== 'string'
      || typeof rawFile.mimeType !== 'string' || typeof rawFile.modifiedTime !== 'string') {
      throw new Error(`Incomplete Drive change for pair ${pairId}: ${change.fileId}`);
    }

    const file: DriveFile = {
      id: rawFile.id,
      name: rawFile.name,
      mimeType: rawFile.mimeType,
      modifiedTime: rawFile.modifiedTime,
      size: typeof rawFile.size === 'string' ? rawFile.size : undefined,
      webViewLink: typeof rawFile.webViewLink === 'string' ? rawFile.webViewLink : undefined,
      md5Checksum: typeof rawFile.md5Checksum === 'string' ? rawFile.md5Checksum : undefined,
      appProperties: typeof rawFile.appProperties === 'object' && rawFile.appProperties !== null
        ? rawFile.appProperties as Record<string, string>
        : undefined,
      parents: Array.isArray(rawFile.parents) ? rawFile.parents.filter((parent): parent is string => typeof parent === 'string') : undefined,
    };

    for (const [folderId, cached] of this.driveFolderCache) {
      const withoutChange = cached.files.filter(candidate => candidate.id !== file.id);
      if (withoutChange.length !== cached.files.length) {
        this.driveFolderCache.set(folderId, { ...cached, files: withoutChange });
      }
      if (file.parents?.includes(folderId)) {
        this.driveFolderCache.set(folderId, { ...this.driveFolderCache.get(folderId)!, files: [...withoutChange, file] });
      }
    }
    this.logger.debug(`[SyncEngine/DriveChanges] Applied change ${change.fileId} for pair ${pairId}`);
  }

  private async ingestDriveChanges(pair: SyncPair): Promise<{ pageToken: string; controlledRescan: boolean; changes: DriveChange[] } | null> {
    if (!this.isDriveChangesEnabled() || !this.db || !this.accessToken || !pair.accountId) return null;

    const driveId = pair.driveId ?? 'my-drive';
    const cursorKey = {
      pair_id: pair.id,
      account_id: pair.accountId,
      corpus_id: pair.cloudCategory === 'shared' ? 'drive' : 'user',
      drive_id: driveId,
    } as const;
    const existingCursor = this.db.getDriveCursor(cursorKey);
    const forceRescan = this.driveCursorRescans.has(pair.id) || existingCursor?.status === 'rescan_required';
    const ingestor = new DriveChangesIngestor(
      this.db,
      (url, init) => this.driveRequest(url, init ?? {}, this.DRIVE_MAX_ATTEMPTS),
      this.accessToken,
    );
    const options = {
      pairId: pair.id,
      accountId: pair.accountId,
      corpusId: pair.cloudCategory === 'shared' ? 'drive' : 'user',
      corpus: pair.cloudCategory === 'shared' ? 'drive' : 'user',
      driveId: pair.cloudCategory === 'shared' ? pair.driveId : undefined,
      forceRescan,
      persistCursor: false,
    };

    try {
      const changes: DriveChange[] = [];
      const result = await ingestor.ingest(options, change => {
        this.applyDriveChange(pair.id, change);
        changes.push(change);
      });
      this.driveCursorRescans.delete(pair.id);
      this.driveChangesCacheReady.add(pair.id);
      this.logger.info(`[DriveChanges] pair=${pair.id} pages=${result.pageCount} changes=${result.appliedChanges}`);
      return { pageToken: result.pageToken, controlledRescan: forceRescan, changes };
    } catch (error) {
      if (error instanceof DriveCursorRescanRequiredError) {
        this.driveCursorRescans.add(pair.id);
        const cursor = this.db.getDriveCursor(cursorKey);
        if (cursor) this.db.setDriveCursor({ ...cursor, status: 'rescan_required' });
        this.logger.warn(`[DriveChanges] pair=${pair.id} cursor invalid; controlled rescan retained local state`);
        return null;
      }
      this.logger.error(`[SyncEngine/DriveChanges] pair=${pair.id} ingestion failed; cursor was not advanced:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private commitDriveChangesCursor(pair: SyncPair, pageToken: string): void {
    if (!this.db || !pair.accountId) return;
    this.db.setDriveCursor({
      pair_id: pair.id,
      account_id: pair.accountId,
      corpus_id: pair.cloudCategory === 'shared' ? 'drive' : 'user',
      drive_id: pair.driveId ?? 'my-drive',
      page_token: pageToken,
      last_success_at: Date.now(),
      status: 'active',
    } satisfies DriveCursor);
  }

  private async saveState() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const data = { pairs: this.pairs, events: this.events.slice(0, 200), settings: this.settings, manifests: this.manifests, pendingConflicts: this.pendingConflicts };
      const tmpFile = `${this.configFile}.tmp.${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmpFile, this.configFile);
    } catch (err) {
      this.logger.error('[SyncEngine] State persistence failed; the current state remains in memory:', err instanceof Error ? err.message : String(err));
    }
  }

  public setToken(accessToken: string | null, refreshToken?: string | null) {
    const prev = this.accessToken;
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;

    // Log del tipo de token recibido
    if (accessToken) {
      const isJWT = accessToken.includes('.') && accessToken.split('.').length === 3;
      const tokenType = isJWT ? 'JWT (probablemente Firebase ID Token)' : 'OAuth2 Access Token';
      this.logger.info(`[SyncEngine/Auth] Token recibido: ${tokenType}`);

      // Si es un JWT de Firebase, advertir que no servirá para Drive API
      if (isJWT) {
        this.logger.warn('[SyncEngine/Auth] Se recibió un JWT. Drive API requiere un Google OAuth2 Access Token, no un Firebase ID Token.');
      }
    }

    if (accessToken && prev !== accessToken) {
      this.pairs.forEach(p => { if (p.status === 'unauthenticated') p.status = 'idle'; });
      this.triggerAllActive();
    }
    this.setupWebhooks();
  }

  private setupWebhooks() {
    if (this.webhooksInitialized) return;
    this.webhooksInitialized = true;

    try {
      const config = getFirebaseClientConfig();
      if (!(config as any).databaseURL) {
        (config as any).databaseURL = `https://${config.projectId}-default-rtdb.firebaseio.com`;
      }

      const app = getApps().length === 0 ? initializeApp(config) : getApp();
      const db = getDatabase(app);

      const eventsRef = ref(db, 'drive_events');
      onValue(eventsRef, (snapshot) => {
        if (!snapshot.exists()) return;
        const events = snapshot.val();
        
        for (const pair of this.pairs) {
          if (pair.status === 'paused') continue;

          const channelKeys = Object.keys(events).filter(k => k.startsWith(`${pair.id}-`));
          let latestEvent: any = null;
          for (const key of channelKeys) {
            const ev = events[key];
            if (!latestEvent || (ev.timestamp && ev.timestamp > latestEvent.timestamp)) {
              latestEvent = ev;
            }
          }
          
          const event = latestEvent;
          if (event && event.timestamp) {
            const lastProcessed = this.lastProcessedWebhookEvent[pair.id] || 0;
            if (lastProcessed === 0) {
              this.lastProcessedWebhookEvent[pair.id] = event.timestamp;
            } else if (event.timestamp > lastProcessed) {
              this.lastProcessedWebhookEvent[pair.id] = event.timestamp;
              
              if (this.activeSyncs.has(pair.id) || this.interruptRequested[pair.id]) {
                if (!this.ensureInterrupt(pair.id)) continue;
                this.logger.info(`[Webhooks] Cambio remoto detectado durante sync para el par ${pair.id}. Programando resync inmediato.`);
                this.pendingResync.add(pair.id);
                this.interruptRequested[pair.id] = { eventTimestamp: event.timestamp };
                if (this.debounceTimers[pair.id]) {
                  clearTimeout(this.debounceTimers[pair.id]);
                  delete this.debounceTimers[pair.id];
                }
              } else {
                this.logger.info(`[Webhooks] ¡Nuevo cambio en Google Drive! Iniciando actualización inmediata para el par ${pair.id}...`);
                this.syncTriggerSource[pair.id] = 'webhook' as any;
                this.executeFastSyncFromWebhook(pair).catch(e => {
                  this.logger.error(`[Webhooks] Error en Fast Sync para par ${pair.id}, ejecutando Sincronización Completa:`, e instanceof Error ? e.message : String(e));
                  this.triggerSync(pair.id);
                });
              }
            }
          }
        }
      }, (error) => {
        this.logger.warn(`[Webhooks] Error escuchando RTDB:`, error.message);
      });
      this.logger.info(`[Webhooks] Escuchando cambios en tiempo real vía Firebase RTDB.`);
    } catch (e) {
      this.logger.error(`[Webhooks] No se pudo inicializar listener RTDB:`, e instanceof Error ? e.message : String(e));
    }
  }

  // --- Token Persistence ---
  private async saveTokens(accessToken: string | null, refreshToken: string | null): Promise<void> {
    try {
      if (accessToken) {
        await SecureStore.set('gdrive_access_token', accessToken);
      } else {
        await SecureStore.remove('gdrive_access_token');
      }
      if (refreshToken) {
        await SecureStore.set('gdrive_refresh_token', refreshToken);
      } else {
        await SecureStore.remove('gdrive_refresh_token');
      }
    } catch (err) {
      this.logger.warn('[SyncEngine/Auth] Could not persist tokens to secure store:', err instanceof Error ? err.message : String(err));
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }
    this.tokenRefreshPromise = this._refreshAccessTokenInternal();
    try {
      return await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async _refreshAccessTokenInternal(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.googleClientId || '',
          client_secret: this.googleClientSecret || '',
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.error === 'invalid_grant') {
          this.refreshToken = null;
          this.accessToken = null;
          await this.saveTokens(null, null);
        }
        return false;
      }
      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        // Persistir refresh_token rotado por Google (si es diferente)
        if (data.refresh_token) {
          this.refreshToken = data.refresh_token;
          await this.saveTokens(data.access_token, data.refresh_token);
        } else {
          await this.saveTokens(data.access_token, this.refreshToken);
        }
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn('[SyncEngine/Auth] Access-token refresh failed; queued work remains recoverable:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  public getToken(): string | null { return this.accessToken; }

  public getStatus() {
    return {
      pairs: this.pairs, events: this.events, settings: this.settings,
      pendingConflicts: this.pendingConflicts,
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
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.debug(`[SyncEngine/ExternalDrive] Could not inspect ${base}:`, error instanceof Error ? error.message : String(error));
          }
        }
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

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'rename' | 'skip'): Promise<void> {
    const conflict = this.pendingConflicts.find(c => c.id === conflictId);
    if (!conflict) return;
    const pair = this.pairs.find(p => p.id === conflict.pairId);
    if (!pair) return;
    const fullLocalPath = path.join(pair.localPath, conflict.localPath);
    let effective: 'local' | 'remote' | 'rename' | 'skip' = resolution;
    if (effective === 'local') {
      try {
        await fs.access(fullLocalPath);
      } catch {
        this.logger.warn(`[ResolveConflict] '${conflict.localPath}' no existe localmente; resolviendo como 'remote' (restaurar desde Drive)`);
        effective = 'remote';
      }
    }

    if (effective === 'local') {
      // Confiar en la versión local: subir el archivo local a Drive (actualización in place del remote existente)
      const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'upload', conflict.remoteFileId);
      try {
        const uploaded = await this.uploadDriveBinary(pair.remotePath, fullLocalPath, conflict.remoteFileName, conflict.remoteFileId, undefined, operationId);
        this.markSelfWritten(fullLocalPath);
        if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        const stats = await fs.stat(fullLocalPath);
        await this.commitResolutionState(pair, conflict.localPath, {
          remoteId: uploaded.id ?? conflict.remoteFileId,
          remoteMtime: uploaded.modifiedTime ? new Date(uploaded.modifiedTime).getTime() : conflict.remoteMtime,
          md5: uploaded.md5Checksum ?? conflict.localHash ?? conflict.remoteHash ?? null,
          localMtime: stats.mtimeMs,
          fileSize: stats.size,
        });
      } catch (error) {
        if (operationId && this.db) this.db.updateOperation(operationId, {
          status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
        });
        throw error;
      }
    } else if (effective === 'remote') {
      // Confiar en la versión remota: descargarla sobrescribiendo el local
      const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'download', conflict.remoteFileId);
      try {
        await this.downloadDriveBinary(conflict.remoteFileId, fullLocalPath, new Date(conflict.remoteMtime).toISOString());
        this.markSelfWritten(fullLocalPath);
        if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        const stats = await fs.stat(fullLocalPath);
        await this.commitResolutionState(pair, conflict.localPath, {
          remoteId: conflict.remoteFileId,
          remoteMtime: conflict.remoteMtime,
          md5: conflict.remoteHash ?? conflict.localHash ?? null,
          localMtime: stats.mtimeMs,
          fileSize: stats.size,
        });
      } catch (error) {
        if (error instanceof Error && (error.message.includes('404') || error.message.includes('File not found'))) { // TODO: Use TransferHttpError
          this.logger.warn(`[SyncEngine/ResolveConflict] El archivo remoto ${conflict.remoteFileId} no existe (404). Marcando como eliminado.`);
          if (this.db) {
            const state = this.db.getFileState(pair.id, conflict.localPath);
            if (state) {
              state.is_tombstone = 1;
              state.updated_at = Date.now();
              this.db.setFileState(pair.id, conflict.localPath, state);
            }
            if (operationId) {
              this.db.updateOperation(operationId, { status: 'failed', last_error: 'Remote file not found (404)', updated_at: Date.now() });
            }
          }
          // Marcar el conflicto como resuelto 'skip' para evitar bucle infinito
          effective = 'skip';
        } else {
          if (operationId && this.db) this.db.updateOperation(operationId, {
            status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
          });
          throw error;
        }
      }
    } else if (effective === 'rename') {
      // Guardar ambos: conservar el local y descargar el remoto como hermano .remote
      const parsed = path.parse(fullLocalPath);
      const renamedPath = path.join(parsed.dir, `${parsed.name}.remote${parsed.ext}`);
      const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'download', conflict.remoteFileId);
      try {
        await this.downloadDriveBinary(conflict.remoteFileId, renamedPath, new Date(conflict.remoteMtime).toISOString());
        this.markSelfWritten(renamedPath);
        if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        const stats = await fs.stat(fullLocalPath);
        await this.commitResolutionState(pair, conflict.localPath, {
          remoteId: conflict.remoteFileId,
          remoteMtime: conflict.remoteMtime,
          md5: conflict.remoteHash ?? conflict.localHash ?? null,
          localMtime: stats.mtimeMs,
          fileSize: stats.size,
        });
      } catch (error) {
        if (operationId && this.db) this.db.updateOperation(operationId, {
          status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
        });
        throw error;
      }
    }

    this.pendingConflicts = this.pendingConflicts.filter(c => c.id !== conflictId);
    if (this.db) this.db.resolveConflict(conflictId, effective);
    await this.saveState();
  }

  private async commitResolutionState(pair: SyncPair, relPath: string, opts: {
    remoteId: string; remoteMtime: number; md5: string | null; localMtime: number; fileSize: number | null;
  }): Promise<void> {
    if (!this.db) return;
    const existing = this.db.getFileState(pair.id, relPath);
    const now = Date.now();
    const state: FileState = {
      pair_id: pair.id,
      rel_path: relPath,
      remote_id: opts.remoteId,
      local_mtime: opts.localMtime,
      remote_mtime: opts.remoteMtime,
      file_size: opts.fileSize,
      md5_hash: opts.md5,
      block_hashes: existing?.block_hashes ?? null,
      vector_clock: existing?.vector_clock ?? '{}',
      device_id: existing?.device_id ?? this.DEVICE_ID!,
      etag: existing?.etag ?? null,
      updated_at: now,
      is_tombstone: 0,
    };
    this.db.setFileState(pair.id, relPath, state);
  }


  private async cleanLocalDuplicatesDir(
    pair: SyncPair,
    currentDir: string,
    relativePrefix = '',
  ): Promise<{ localDeleted: number; localRenamed: number }> {
    let localDeleted = 0;
    let localRenamed = 0;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return { localDeleted: 0, localRenamed: 0 };
    }

    const localFiles: Array<{ name: string; mtime: number }> = [];
    const subDirs: string[] = [];

    for (const entry of entries) {
      if (matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) continue;
      if (entry.isDirectory()) {
        subDirs.push(entry.name);
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(path.join(currentDir, entry.name));
          localFiles.push({ name: entry.name, mtime: st.mtimeMs });
        } catch { /* ignorar inaccesibles */ }
      }
    }

    const grouped = CoreSyncLogic.groupAndSortDuplicates(localFiles);

    for (const [baseName, versions] of grouped.entries()) {
      if (versions.length <= 1) continue;

      const winner = versions[0];
      const losers = versions.slice(1);

      for (const loser of losers) {
        const loserPath = path.join(currentDir, loser.name);
        const loserRelPath = relativePrefix ? `${relativePrefix}/${loser.name}` : loser.name;
        this.markSelfWritten(loserPath);
        await fs.rm(loserPath, { force: true }).catch(e =>
          this.logger.warn(`[Deduplicate] No se pudo eliminar ${loserPath}:`, e instanceof Error ? e.message : String(e))
        );
        localDeleted++;

        if (this.db) {
          const existingState = this.db.getFileState(pair.id, loserRelPath);
          this.db.setFileState(pair.id, loserRelPath, {
            pair_id: pair.id, rel_path: loserRelPath,
            remote_id: existingState?.remote_id ?? null,
            local_mtime: null, remote_mtime: existingState?.remote_mtime ?? null,
            file_size: null, md5_hash: null, block_hashes: null,
            vector_clock: existingState?.vector_clock ?? '{}',
            device_id: existingState?.device_id ?? this.DEVICE_ID ?? '',
            etag: null, updated_at: Date.now(), is_tombstone: 1
          });
        }

        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: loserRelPath, action: 'cleaned', timestamp: Date.now(),
          details: `Duplicado eliminado; ganador: ${winner.name}`,
        }, true);
      }

      if (winner.name !== baseName) {
        const winnerPath = path.join(currentDir, winner.name);
        const basePath = path.join(currentDir, baseName);
        const winnerRelPath = relativePrefix ? `${relativePrefix}/${winner.name}` : winner.name;
        const canonicalRelPath = relativePrefix ? `${relativePrefix}/${baseName}` : baseName;
        try {
          this.markSelfWritten(winnerPath);
          this.markSelfWritten(basePath);
          await fs.rename(winnerPath, basePath);
          localRenamed++;

          if (this.db) {
            const winnerState = this.db.getFileState(pair.id, winnerRelPath);
            if (winnerState) {
              const renamedStat = await fs.stat(basePath).catch(() => null);
              this.db.setFileState(pair.id, canonicalRelPath, {
                ...winnerState,
                rel_path: canonicalRelPath,
                local_mtime: renamedStat?.mtimeMs ?? winnerState.local_mtime,
                updated_at: Date.now(),
                is_tombstone: 0,
              });
              this.db.setFileState(pair.id, winnerRelPath, {
                ...winnerState,
                rel_path: winnerRelPath,
                local_mtime: null,
                file_size: null,
                updated_at: Date.now(),
                is_tombstone: 1,
              });
            }
          }
        } catch (e) {
          this.logger.warn(`[Deduplicate] No se pudo renombrar ${winner.name} → ${baseName}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    for (const subDir of subDirs) {
      const subPath = path.join(currentDir, subDir);
      const subPrefix = relativePrefix ? `${relativePrefix}/${subDir}` : subDir;
      const childRes = await this.cleanLocalDuplicatesDir(pair, subPath, subPrefix);
      localDeleted += childRes.localDeleted;
      localRenamed += childRes.localRenamed;
    }

    return { localDeleted, localRenamed };
  }

  private async cleanRemoteDuplicatesDir(folderId: string): Promise<number> {
    let remoteDeleted = 0;
    const remoteFiles = await this.listDriveFiles(folderId, true);
    const fileItems = remoteFiles
      .filter(f => f.mimeType !== 'application/vnd.google-apps.folder')
      .map(f => ({ name: f.name, mtime: new Date(f.modifiedTime).getTime(), remoteId: f.id }));

    const remoteGrouped = CoreSyncLogic.groupAndSortDuplicates(fileItems);
    for (const [, versions] of remoteGrouped.entries()) {
      if (versions.length <= 1) continue;
      for (const loser of versions.slice(1)) {
        const loserWithId = loser as typeof loser & { remoteId?: string };
        if (loserWithId.remoteId) {
          await this.deleteDriveFile(loserWithId.remoteId, folderId).catch(e =>
            this.logger.warn(`[Deduplicate] No se pudo eliminar archivo remoto ${loserWithId.remoteId}:`, e instanceof Error ? e.message : String(e))
          );
          remoteDeleted++;
        }
      }
    }

    const subFolders = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    for (const subFolder of subFolders) {
      remoteDeleted += await this.cleanRemoteDuplicatesDir(subFolder.id);
    }

    return remoteDeleted;
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) {
      return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };
    }

    let localDeleted = 0;
    let localRenamed = 0;
    let remoteDeleted = 0;
    const remoteRenamed = 0;

    try {
      // 1. Escanear y deduplicar archivos locales en forma RECURSIVA (raíz y subdirectorios)
      const localRes = await this.cleanLocalDuplicatesDir(pair, pair.localPath, '');
      localDeleted = localRes.localDeleted;
      localRenamed = localRes.localRenamed;

      // 2. Escanear y deduplicar en Google Drive en forma RECURSIVA
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

          remoteDeleted = await this.cleanRemoteDuplicatesDir(remoteFolderId);
        } catch (e) {
          this.logger.warn(`[Deduplicate] Deduplicación remota omitida (error al resolver carpeta):`, e instanceof Error ? e.message : String(e));
        }
      }

      this.logger.info(`[Deduplicate] pair=${pairId} completado — local: ${localDeleted} borrados, ${localRenamed} renombrados; remoto: ${remoteDeleted} borrados.`);
      this.addEvent({
        id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
        filename: pair.localPath, action: 'cleaned', timestamp: Date.now(),
        details: `Limpieza total: ${localDeleted} locales borrados, ${localRenamed} renombrados, ${remoteDeleted} remotos borrados.`,
      });
    } catch (error) {
      this.logger.error(`[Deduplicate] Error al limpiar duplicados para pair=${pairId}:`, error instanceof Error ? error.message : String(error));
    }

    return { localDeleted, localRenamed, remoteDeleted, remoteRenamed };
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
      await this.watchers[pairId].unsubscribe();
      delete this.watchers[pairId];
    }
    if (this.intervalRefs[pairId]) {
      clearTimeout(this.intervalRefs[pairId]);
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
              try {
                await fs.unlink(fullPath);
              } catch (error) {
                this.logger.warn(`[Dehydrate] Could not remove source file ${fullPath}; stub retained for recovery:`, error instanceof Error ? error.message : String(error));
              }
            }
          }
        }
      } catch (error) {
        this.logger.error(`[SyncEngine/Dehydrate] Could not process ${dir}; remaining files were left untouched:`, error instanceof Error ? error.message : String(error));
      }
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
                try {
                  await fs.unlink(fullPath);
                } catch (error) {
                  this.logger.warn(`[SyncEngine/Hydrate] Could not remove stub ${fullPath} after download:`, error instanceof Error ? error.message : String(error));
                }
              }
            } catch (error) {
              this.logger.error(`[SyncEngine/Hydrate] Could not hydrate ${fullPath}; stub remains for retry:`, error instanceof Error ? error.message : String(error));
            }
          }
        }
      } catch (error) {
        this.logger.error(`[SyncEngine/Hydrate] Could not process ${dir}; remaining stubs were left for recovery:`, error instanceof Error ? error.message : String(error));
      }
    };
    await hydrateDir(pair.localPath, '');
    pair.syncMode = 'mirror';
    await this.saveState();
  }

  private refreshWatchers() {
    this.pairs.forEach(async (pair) => {
      const shouldWatch = (pair.status === 'syncing' || pair.status === 'idle') && !!pair.localPath;
      if (shouldWatch && !this.watchers[pair.id]) {
        try {
           const subscription = await parcelWatcher.subscribe(pair.localPath, (err, events) => {
             if (err) {
               this.logger.error(`Error en watcher para par=${pair.id}:`, err);
               return;
             }
              if (this.activeSyncs.has(pair.id) || this.interruptRequested[pair.id]) {
                const relevantEvents = events.filter(evt => {
                  const relPath = path.relative(pair.localPath, evt.path);
                  const parts = relPath.split(path.sep);
                 if (parts.some(p => p.startsWith('.') || matchesIgnorePattern(p, this.settings.ignoredPatterns))) {
                   return false;
                 }
                 if (this.isSelfWritten(evt.path)) {
                   this.logger.debug(`[Watcher] Ignorando cambio auto-generado por el motor: ${evt.path}`);
                   return false;
                 }
                 return true;
               });
               if (relevantEvents.length === 0) return;
               this.pendingLocalEvents[pair.id] = (this.pendingLocalEvents[pair.id] || []).concat(
                 relevantEvents.map(evt => ({
                   relPath: path.relative(pair.localPath, evt.path),
                   localEvent: evt.type as 'create' | 'update' | 'delete'
                 }))
               );
                this.logger.info(`[Watcher] Cambios locales detectados durante sync para el par ${pair.id}. Interrumpiendo el ciclo activo para procesarlos inmediatamente.`);
                this.interruptRequested[pair.id] = true;
               return;
             }

             // Filtrar ignorados Y auto-escritos por el motor (cada evento del lote, no solo el primero)
             const relevantEvents = events.filter(evt => {
               const relPath = path.relative(pair.localPath, evt.path);
               const parts = relPath.split(path.sep);
               if (parts.some(p => p.startsWith('.') || matchesIgnorePattern(p, this.settings.ignoredPatterns))) {
                 return false;
               }
               if (this.isSelfWritten(evt.path)) {
                 this.logger.debug(`[Watcher] Ignorando cambio auto-generado por el motor: ${evt.path}`);
                 return false;
               }
               return true;
             });

             if (relevantEvents.length === 0) return;

              if (this.debounceTimers[pair.id]) clearTimeout(this.debounceTimers[pair.id]);
              this.debounceTimers[pair.id] = setTimeout(() => {
                this.logger.info(`[Watcher] Detectados ${relevantEvents.length} eventos locales para el par ${pair.id}. Iniciando Fast Sync...`);
               const targetPaths = relevantEvents.map(evt => ({
                 relPath: path.relative(pair.localPath, evt.path),
                 localEvent: evt.type as 'create' | 'update' | 'delete'
               }));
               this.fastSync(pair, targetPaths).catch(e => {
                 this.logger.error(`[Watcher] Fast Sync falló para el par ${pair.id}:`, e instanceof Error ? e.message : String(e));
                 this.syncTriggerSource[pair.id] = 'fs-event' as any;
                 this.triggerSync(pair.id);
               });
             }, SYNC_DEBOUNCE_MS);
           });

          this.watchers[pair.id] = subscription;
          this.watcherRetryCount[pair.id] = 0;
        } catch (error) {
          this.logger.error(`[SyncEngine/Watcher] Could not create watcher for pair ${pair.id}:`, error instanceof Error ? error.message : String(error));
        }
      } else if (!shouldWatch && this.watchers[pair.id]) {
        this.watchers[pair.id].unsubscribe().catch(error => {
          this.logger.warn(`[SyncEngine/Watcher] Could not unsubscribe watcher for pair ${pair.id}:`, error instanceof Error ? error.message : String(error));
        });
        delete this.watchers[pair.id];
      }
    });

    Object.keys(this.watchers).forEach(id => {
      if (!this.pairs.find(p => p.id === id)) {
        this.watchers[id].unsubscribe().catch(error => {
          this.logger.warn(`[SyncEngine/Watcher] Could not unsubscribe stale watcher for pair ${id}:`, error instanceof Error ? error.message : String(error));
        });
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



  private async runSync(pair: SyncPair, pairLock: PairLock): Promise<void> {
    const pairId = pair.id;

    if (this.db) {
      const incompleteCount = this.db.getIncompleteTransfers(pairId).length;
      if (incompleteCount > 0) {
        this.logger.warn(`[Recovery] Se encontraron ${incompleteCount} transferencias incompletas para pair=${pairId}. Limpiando para un nuevo intento.`);
        this.db.clearIncompleteTransfers(pairId);
      }
    }

    let driveChangeBatch: { pageToken: string; controlledRescan: boolean } | null = null;
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

      // Intentar registrar el Webhook para recibir notificaciones instantáneas
      this.registerDriveWebhook(pair, remoteFolderId);

      if ((USE_V2_SYNC || this.isDriveChangesEnabled()) && this.db && this.DEVICE_ID) {
        driveChangeBatch = await this.ingestDriveChanges(pair);
        const syncCompleted = await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
        if (syncCompleted && driveChangeBatch) {
          if (driveChangeBatch.controlledRescan) {
            this.logger.info(`[DriveChanges] pair=${pair.id} controlled rescan completed before cursor commit`);
          }
          this.commitDriveChangesCursor(pair, driveChangeBatch.pageToken);
        }
        if (!syncCompleted) {
          if ((pair.status as string) === 'paused') return;
          throw new Error('Native sync did not complete; pending work was retained');
        }
      } else {
        if (!this.db || !this.DEVICE_ID) {
          throw new Error('Native v2 sync requires an initialized database and device id; cannot sync pair');
        }
        const syncCompleted = await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
        if (!syncCompleted && (pair.status as string) !== 'paused') {
          throw new Error('Native sync did not complete; pending work was retained');
        }
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

      this.maybeVacuumDatabase();

      setTimeout(() => { if (pair && pair.status === 'idle') { pair.progress = null; this.saveState(); } }, 4000);
      await this.saveState();
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'WEBHOOK_INTERRUPT') {
        this.logger.info(`[SyncEngine] pair=${pairId} interrupted by external change; rescheduling sync.`);
      } else if (err instanceof Error && err.message === 'UNAUTHORIZED_EXPIRED_TOKEN') pair.status = 'unauthenticated';
      else if (err instanceof Error && err.message === 'UNAUTHORIZED_TOKEN_REFRESH_FAILED') {
        pair.status = this.accessToken === null ? 'unauthenticated' : 'error';
      }
      else pair.status = 'error';
      pair.progress = null;
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      if (err instanceof Error && err.message !== 'WEBHOOK_INTERRUPT') {
        this.logger.error(`[SyncEngine] pair=${pairId} sync failed; recoverable state was retained:`, errMsg);
      }
      this.addEvent({
        id: Math.random().toString(36).slice(2, 11), pairId, filename: pair.localPath,
        action: 'info', timestamp: Date.now(),
        details: `Synchronization failed: ${err instanceof Error ? err.message : String(err)}`,
      }, true);
      await this.saveState();
    } finally {
      try {
        await pairLock.release();
      } catch (error) {
        this.logger.error(`[SyncEngine/Lock] Could not release pair ${pairId}; manual recovery may be required:`, error instanceof Error ? error.message : String(error));
      }
      this.activeSyncs.delete(pairId);
      this.driveFolderCache.clear();
      this.driveChangesCacheReady.delete(pairId);
      delete this.interruptRequested[pairId];
      if (this.pendingResync.has(pairId)) {
        this.lastInterruptTime[pairId] = Date.now();
      }

      if (this.pendingResync.has(pairId)) {
        this.pendingResync.delete(pairId);
        this.logger.info(`[SyncEngine] Ejecutando resync pendiente para ${pairId} debido a un webhook recibido durante la sincronización anterior.`);
        this.syncTriggerSource[pairId] = 'webhook' as any;
        setTimeout(() => this.triggerSync(pairId), 1000);
      } else {
        this.syncTriggerSource[pairId] = 'manual';
      }

      const pendingLocal = this.pendingLocalEvents[pairId];
      if (pendingLocal && pendingLocal.length > 0) {
        delete this.pendingLocalEvents[pairId];
        this.logger.info(`[SyncEngine] Procesando ${pendingLocal.length} eventos locales pendientes para ${pairId}...`);
        setTimeout(() => this.fastSync(pair, pendingLocal), 0);
      }

      this.lastSyncCompleted[pairId] = Date.now();
      const filesProcessed = pair.progress?.currentFileIndex ?? 0;
      const bytesTransferred = pair.progress?.bytesTransferred ?? 0;

      if (filesProcessed === 0 && bytesTransferred === 0) {
        const currentBackoff = this.syncBackoff[pairId] || INITIAL_POLL_INTERVAL_MS;
        this.syncBackoff[pairId] = nextSyncBackoff(currentBackoff);
      } else if (!this.isDriveChangesEnabled()) {
        const currentBackoff = this.syncBackoff[pairId] || INITIAL_POLL_INTERVAL_MS;
        this.syncBackoff[pairId] = nextSyncBackoff(currentBackoff);
      } else {
        this.syncBackoff[pairId] = INITIAL_POLL_INTERVAL_MS;
      }
      this.syncTriggerSource[pairId] = 'manual';

      if (this.pendingSyncs.has(pairId)) {
        this.pendingSyncs.delete(pairId);
        if (pair.status === 'error' || pair.status === 'unauthenticated') {
          this.logger.warn(`[SyncEngine] pair=${pairId} has pending syncs but is in error state. Aborting immediate retry.`);
        } else {
          setTimeout(() => this.triggerSync(pairId), 5000);
        }
      }
    }
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

    let pairLock: PairLock | null = null;
    try {
      pairLock = await acquirePairLock(this.sharedPairLockDirectory(), pairId);
    } catch (err: unknown) {
      if (err instanceof PairAlreadyRunningError) {
        this.logger.warn(`[SyncEngine/Lock] pair=${pairId} is already active in another engine; work remains queued`);
      } else {
        this.logger.error(`[SyncEngine] pair=${pairId} lock acquisition failed; sync will be skipped:`, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    this.activeSyncs.add(pairId);
    pair.status = 'syncing';
    pair.progress = { currentFile: 'Verificando carpetas y duplicados...', totalFiles: 0, currentFileIndex: 0, bytesTransferred: 0, totalBytes: 0, percentage: 0, action: 'comprobando' };

    this.runSync(pair, pairLock);
  }

  private async executeFastSyncFromWebhook(pair: SyncPair) {
    if (!this.db || !this.accessToken) return;

    // Ingestar cambios de la API de Drive
    const changesResult = await this.ingestDriveChanges(pair);
    if (!changesResult || !changesResult.changes.length) {
      // Si no hay cambios detallados pero llegó notificación, forzar sync directo
      this.logger.info(`[Webhooks] Evento de cambio recibido. Ejecutando Sincronización Directa para ${pair.id}...`);
      this.triggerSync(pair.id);
      return;
    }

    const targetPaths: { relPath: string; change: DriveChange }[] = [];
    let requiresFullSync = false;

    for (const change of changesResult.changes) {
      if (change.fileId) {
        const state = this.db.getFileStateByRemoteId(pair.id, change.fileId);
        const df = change.file as unknown as DriveFile | undefined;

        if (state) {
          // El archivo ya existe en la base de datos local
          targetPaths.push({ relPath: state.rel_path, change });
        } else if (df?.parents?.length) {
          const parentId = df.parents[0];
          const parentState = this.db.getFileStateByRemoteId(pair.id, parentId);

          if (parentState) {
            // El archivo está dentro de una subcarpeta conocida
            targetPaths.push({
              relPath: parentState.rel_path ? `${parentState.rel_path}/${df.name}` : (df.name as string) || '',
              change
            });
          } else {
            // Si el padre no está en DB, es un archivo nuevo en la RAÍZ de la carpeta o subcarpeta nueva
            if (df.name) {
              targetPaths.push({ relPath: df.name, change });
            } else {
              requiresFullSync = true;
            }
          }
        } else {
          requiresFullSync = true;
        }
      }
    }

    // Si logramos mapear las rutas y no requerimos resync completo
    if (targetPaths.length > 0 && !requiresFullSync) {
      this.logger.info(`[FastSync] Descargando/Actualizando inmediatamente ${targetPaths.length} archivo(s) en el par ${pair.id}.`);
      await this.fastSync(pair, targetPaths);
    } else {
      this.driveChangesCacheReady.delete(pair.id);
      if (this.ensureInterrupt(pair.id)) {
        this.interruptRequested[pair.id] = { eventTimestamp: Date.now() };
      }
      this.logger.info(`[Webhooks] Transición a Sincronización Directa Inmediata para el par ${pair.id}...`);
      this.triggerSync(pair.id);
    }
  }

  public async fastSync(pair: SyncPair, targetPaths: { relPath: string; change?: DriveChange; localEvent?: 'create' | 'update' | 'delete' }[]) {
    if (!this.db || !this.accessToken) return;
    
    this.logger.info(`[FastSync] Paths a sincronizar: ${targetPaths.map(t => `${t.relPath} (${t.change ? 'remote' : 'local'})`).join(', ')}`);

    for (const { relPath, change, localEvent } of targetPaths) {
      const lockKey = `${pair.id}:${relPath}`;
      if (this.activeTransfers.has(lockKey)) {
        this.logger.info(`[FastSync] Path ${relPath} ya se está transfiriendo, omitiendo...`);
        continue;
      }
      this.activeTransfers.add(lockKey);
      
      try {
        const fullLocalPath = path.join(pair.localPath, relPath);
        
        if (change) {
          // --- REMOTE CHANGE PROCESSING ---
          if (change.removed) {
             try { await fs.unlink(fullLocalPath); } catch (e) { /* ignore */ }
             this.db.deleteFileState(pair.id, relPath);
             this.logger.info(`[FastSync] Deleted local file ${relPath} (removed remotely)`);
             continue;
          }

          const remoteFile = change.file as unknown as DriveFile;
          if (remoteFile.mimeType === 'application/vnd.google-apps.folder') {
             try { await fs.mkdir(fullLocalPath, { recursive: true }); } catch (e) { /* ignore */ }
             this.logger.info(`[FastSync] Created local directory ${relPath}`);
             continue;
          }

          let localStat = null;
          try { localStat = await fs.stat(fullLocalPath); } catch (e) { /* ignore */ }
          const remoteMtime = new Date(remoteFile.modifiedTime).getTime();

          if (!localStat || remoteMtime > localStat.mtimeMs + 2000) {
             this.logger.info(`[FastSync] Downloading remote file ${relPath}`);
             const operationId = this.beginTransferOperation(pair.id, relPath, 'download', remoteFile.id);
             try {
               await this.downloadDriveBinary(remoteFile.id, fullLocalPath, remoteFile.modifiedTime, remoteFile.md5Checksum, remoteFile.size ? parseInt(remoteFile.size, 10) : undefined);
               const newStat = await fs.stat(fullLocalPath);
               this.db.setFileState(pair.id, relPath, {
                 pair_id: pair.id, rel_path: relPath, remote_id: remoteFile.id,
                 local_mtime: newStat.mtimeMs, remote_mtime: remoteMtime,
                 file_size: newStat.size, md5_hash: remoteFile.md5Checksum || null, block_hashes: null,
                 vector_clock: '{}', device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
               });
               if (operationId) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
               this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: remoteFile.name, action: 'downloaded', timestamp: Date.now() }, true);
             } catch (err: any) {
               if (operationId) this.db.updateOperation(operationId, { status: 'retry', last_error: err instanceof Error ? err.message : String(err), updated_at: Date.now() });
               this.logger.error(`[FastSync] Download failed for ${relPath}:`, err);
             }
          } else {
             this.logger.info(`[FastSync] Remote file ${relPath} is not newer than local file. Skipping.`);
          }
        } else if (localEvent) {
          // --- LOCAL CHANGE PROCESSING ---
          const state = this.db.getFileState(pair.id, relPath);
          if (localEvent === 'delete') {
            if (state && state.remote_id) {
              this.logger.info(`[FastSync] Deleting remote file ${relPath}`);
              await this.deleteDriveFile(state.remote_id);
              this.db.setFileState(pair.id, relPath, { ...state, is_tombstone: 1, updated_at: Date.now() });
              this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: path.basename(relPath), action: 'deleted', timestamp: Date.now() }, true);
            }
          } else {
            let localStat = null;
            try { localStat = await fs.stat(fullLocalPath); } catch (e) { /* ignore */ }
            if (localStat && localStat.isFile()) {
              this.logger.info(`[FastSync] Uploading local file ${relPath}`);
              let remoteFolderId = 'root'; // Simplified. In reality, we should resolve the parent's remoteFolderId!
              // Try to find parent's remote ID if not root
              const parentDir = path.dirname(relPath);
              if (parentDir && parentDir !== '.') {
                const parentState = this.db.getFileState(pair.id, parentDir);
                if (parentState && parentState.remote_id) remoteFolderId = parentState.remote_id;
                else {
                  this.logger.warn(`[FastSync] Parent folder ${parentDir} not found in DB. Falling back to full resync.`);
                  this.pendingResync.add(pair.id);
                  continue;
                }
              } else {
                // To safely resolve root without a huge scan, let's just queue resync for files at the root if we don't have remoteFolderId cached
                // Wait, pair.remotePath is known. We'd have to resolve it. Since fastSync is an optimization, falling back is fine!
                // Actually, if state exists, we already have state.remote_id, so uploadDriveBinary will just overwrite it, parent ID doesn't matter much for update!
                if (!state?.remote_id) {
                   this.pendingResync.add(pair.id);
                   continue;
                }
              }
              const operationId = this.beginTransferOperation(pair.id, relPath, 'upload', state?.remote_id || null);
              try {
                const uploadedFile = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, path.basename(relPath), state?.remote_id || undefined, state?.vector_clock, operationId);
                const newStat = await fs.stat(fullLocalPath);
                this.db.setFileState(pair.id, relPath, {
                  pair_id: pair.id, rel_path: relPath, remote_id: uploadedFile.id,
                  local_mtime: newStat.mtimeMs, remote_mtime: new Date(uploadedFile.modifiedTime).getTime(),
                  file_size: newStat.size, md5_hash: uploadedFile.md5Checksum || null, block_hashes: null,
                  vector_clock: '{}', device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
                });
                if (operationId) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
                this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: path.basename(relPath), action: 'uploaded', timestamp: Date.now() }, true);
              } catch (err: any) {
                if (operationId) this.db.updateOperation(operationId, { status: 'retry', last_error: err instanceof Error ? err.message : String(err), updated_at: Date.now() });
                this.logger.error(`[FastSync] Upload failed for ${relPath}:`, err);
              }
            }
          }
        }
      } catch (error) {
        this.logger.error(`[FastSync] Error processing ${relPath}:`, error instanceof Error ? error.message : String(error));
      } finally {
        this.activeTransfers.delete(lockKey);
      }
    }

    if (this.pendingResync.has(pair.id)) {
      this.pendingResync.delete(pair.id);
      this.logger.info(`[FastSync] Se detectaron cambios locales que requieren resync completo para ${pair.id}. Ejecutando Sincronización Inmediata...`);
      this.triggerSync(pair.id);
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

  private async v2SyncDirectoryTree(localDir: string, remoteFolderId: string, pair: SyncPair, relativePrefix = ''): Promise<boolean> {
    if (!this.db || !this.DEVICE_ID) return false;

    const dbState = this.db.getFolderState(pair.id);

    const checkInterrupt = () => {
      if (this.interruptRequested[pair.id]) {
        throw new Error(this.WEBHOOK_INTERRUPT);
      }
    };

    const dirDbState = new Map<string, FileState>();
    const normalizedPrefix = relativePrefix.replace(/\\/g, '/');
    for (const [relPath, state] of dbState) {
      const dirname = path.dirname(relPath) === '.' ? '' : path.dirname(relPath).replace(/\\/g, '/');
      if (dirname === normalizedPrefix) {
        dirDbState.set(path.basename(relPath), state);
      }
    }

    const scanResult = await scanChanges(localDir, dirDbState, new NodeFileSystem(), pair.id);
    if (scanResult === 'PERMISSION_DENIED') {
      pair.status = 'error' as any;
      return false;
    }
    checkInterrupt();

    const remoteFiles = await this.listDriveFiles(
      remoteFolderId,
      !this.isDriveChangesEnabled()
      || this.driveCursorRescans.has(pair.id)
      || !this.driveChangesCacheReady.has(pair.id),
    );
    checkInterrupt();

    const getRelPath = (baseName: string): string => relativePrefix ? `${relativePrefix}/${baseName}` : baseName;

    const localSnapshot = new Map<string, { name: string; rawName?: string; mtime: number; size: number; hash?: string }>();

    for (const [baseName, state] of dirDbState) {
      if (!state.is_tombstone && !scanResult.deleted.includes(baseName)) {
        if (matchesIgnorePattern(baseName, this.settings.ignoredPatterns)) continue;
        localSnapshot.set(baseName, { name: baseName, mtime: state.local_mtime || 0, size: state.file_size || 0 });
      }
    }
    for (const [baseName, entry] of scanResult.changed) {
      if (!matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) {
        localSnapshot.set(baseName, { name: entry.name, rawName: (entry as any).rawName, mtime: entry.mtime, size: entry.size, hash: entry.hash });
      }
    }
    for (const [baseName, entry] of scanResult.created) {
      if (!matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) {
        localSnapshot.set(baseName, { name: entry.name, rawName: (entry as any).rawName, mtime: entry.mtime, size: entry.size, hash: entry.hash });
      }
    }

    const remoteSnapshot = new Map<string, RemoteEntry>();
    for (const file of remoteFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      const canonicalName = file.name.normalize('NFC');
      remoteSnapshot.set(canonicalName, {
        id: file.id, name: canonicalName, mimeType: file.mimeType, modifiedTime: file.modifiedTime,
        size: file.size, md5Checksum: file.md5Checksum, appProperties: file.appProperties, etag: undefined
      });
    }

    // O(1) Batch Reconcile: Mark files as tombstones if they are missing from the definitive remote list.
    // This entirely replaces the N+1 API calls of reconcileWithHttp304.
    for (const [baseName, state] of dirDbState) {
      if (state.remote_id && !state.is_tombstone) {
        const stillExists = remoteFiles.some(f => f.id === state.remote_id);
        if (!stillExists) {
          state.is_tombstone = 1;
          state.updated_at = Date.now();
          this.db.setFileState(pair.id, getRelPath(baseName), state);
          this.logger.debug(`[SyncEngine] Remote file ${baseName} (id: ${state.remote_id}) was deleted remotely. Marking as tombstone locally.`);
        }
      }
    }

    const dbStateForPlan = new Map<string, SyncStateSnapshot>();
    for (const [baseName, state] of dirDbState) {
      dbStateForPlan.set(baseName, {
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
    checkInterrupt();

    const totalFilesToSync = plan.downloads.length + plan.uploads.length
      + plan.deleteLocal.length + plan.deleteRemote.length;
    let totalBytesToTransfer = 0;
    for (const dl of plan.downloads) {
      totalBytesToTransfer += dl.remoteFile.size ? parseInt(dl.remoteFile.size, 10) : 0;
    }
    for (const ul of plan.uploads) {
      const localEntry = localSnapshot.get(ul.localPath);
      if (localEntry?.size) totalBytesToTransfer += localEntry.size;
    }
    if (pair.progress) {
      // Acumular en lugar de sobreescribir para que el total sea correcto en llamadas recursivas (BUG-03 fix)
      pair.progress.totalFiles += totalFilesToSync;
      pair.progress.totalBytes += totalBytesToTransfer;
    }

    for (const conflict of plan.conflicts) {
      const relPath = getRelPath(conflict.localPath);
      const conflictId = `${pair.id}:${relPath}:${conflict.remoteFile.id}:${conflict.baseHash ?? 'none'}`;
      if (!this.pendingConflicts.some(c => c.id === conflictId)) {
        this.pendingConflicts.push({
          id: conflictId,
          pairId: pair.id,
          localPath: relPath,
          relativePath: relPath,
          remoteFileId: conflict.remoteFile.id,
          remoteFileName: conflict.remoteFile.name,
          reason: conflict.reason ?? null,
          baseHash: conflict.baseHash ?? null,
          localHash: conflict.localHash ?? null,
          remoteHash: conflict.remoteHash ?? null,
          localSize: localSnapshot.get(conflict.localPath)?.size ?? null,
          localMtime: localSnapshot.get(conflict.localPath)?.mtime ?? 0,
          remoteSize: conflict.remoteFile.size ? parseInt(conflict.remoteFile.size, 10) : null,
          remoteMtime: new Date(conflict.remoteFile.modifiedTime).getTime(),
          resolved: false,
          timestamp: Date.now()
        });

        if (this.db) {
          this.db.setConflict({
            id: conflictId,
            pair_id: pair.id,
            rel_path: relPath,
            local_hash: conflict.localHash ?? null,
            remote_hash: conflict.remoteHash ?? null,
            base_hash: conflict.baseHash ?? null,
            remote_id: conflict.remoteFile.id,
            reason: conflict.reason ?? null,
            resolution: 'pending',
            created_at: Date.now(),
            updated_at: Date.now(),
          });
        }
      }
    }
    const completedUploads = new Set<string>();
    const completedDownloads = new Set<string>();
    const uploadCommits: Array<{ journalId: number; operationId: string | null }> = [];
    const downloadCommits: Array<{ journalId: number; operationId: string | null }> = [];
    let hadFailures = false;

    const db = this.db;
    const deviceId = this.DEVICE_ID!;
    const updates = new Map<string, FileState>();
    const now = Date.now();

    // -- Adoption Mechanism --
    for (const adoption of plan.adoptions || []) {
      if ((pair.status as string) === 'paused') return false;
      const fullLocalPath = path.join(localDir, adoption.localPath);
      let adopted = false;
      try {
        const stats = await fs.stat(fullLocalPath);
        const remoteSize = adoption.remoteFile.size ? parseInt(adoption.remoteFile.size, 10) : undefined;
        if (remoteSize === undefined || stats.size === remoteSize) {
          const hashes = await computeBlockHashes(fullLocalPath, false);
          if (hashes.length > 0 && hashes[0].toLowerCase() === (adoption.remoteFile.md5Checksum || '').toLowerCase()) {
            updates.set(getRelPath(adoption.localPath), {
              pair_id: pair.id, rel_path: getRelPath(adoption.localPath),
              remote_id: adoption.remoteFile.id, local_mtime: stats.mtimeMs, remote_mtime: new Date(adoption.remoteFile.modifiedTime).getTime(),
              file_size: remoteSize ?? stats.size, md5_hash: adoption.remoteFile.md5Checksum || hashes[0], block_hashes: null,
              vector_clock: adoption.vectorClock, device_id: deviceId, etag: null, updated_at: now, is_tombstone: 0
            });
            adopted = true;
            this.addEvent({
              id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
              filename: adoption.remoteFile.name, action: 'info', timestamp: Date.now(),
              details: 'Archivo adoptado (coincide con Drive, no fue subido)',
            }, true);
          }
        }
      } catch (error: any) {
        if (error && error.code === 'ENOENT') {
          this.logger.warn(`Failed to stat/hash for adoption of ${fullLocalPath} (Ignorable ENOENT)`);
        } else {
          this.logger.warn(`Failed to stat/hash for adoption of ${fullLocalPath}`, error);
        }
      }

      if (!adopted) {
        plan.uploads.push({
          localPath: adoption.localPath,
          remoteName: adoption.remoteFile.name,
          remoteId: adoption.remoteFile.id,
          vectorClock: adoption.vectorClock
        });
      }
    }
    checkInterrupt();

    const uploadTasks = plan.uploads.map(upload => async (): Promise<void> => {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, upload.localPath);
      const relPath = getRelPath(upload.localPath);
      const journalId = db.journalStart(pair.id, 'upload_start', relPath, upload.remoteId);
      const operationId = this.beginTransferOperation(pair.id, relPath, 'upload', upload.remoteId || null);
      try {
        let stats;
        try {
          stats = await fs.stat(fullLocalPath);
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            hadFailures = true;
          }
          db.journalFail(journalId);
          if (operationId) {
            // Si el archivo ya no existe, marcarlo como completado con error tolerado (tombstone indirecto)
            const status = error.code === 'ENOENT' ? 'done' : 'retry';
            db.updateOperation(operationId, {
              status: status, last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
            });
          }
          this.logger.warn(`[Transfer] Upload stat failed for ${fullLocalPath} (ENOENT = ignorable):`, error instanceof Error ? error.message : String(error));
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
            filename: upload.remoteName, action: 'info', timestamp: Date.now(),
            details: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
          }, true);
          return;
        }

        if (pair.progress) { pair.progress.currentFile = upload.remoteName; pair.progress.action = 'subiendo'; }

        // BUG-02/04 fix: onProgress actualiza bytesTransferred y percentage en tiempo real durante subidas
        let fileTransferredBytes = 0;
        const uploadedFile = await this.uploadDriveBinary(
          remoteFolderId, fullLocalPath, upload.remoteName, upload.remoteId, upload.vectorClock, operationId,
          (loadedChunkBytes) => {
            if (pair.progress) {
              const delta = loadedChunkBytes - fileTransferredBytes;
              fileTransferredBytes = loadedChunkBytes;
              pair.progress.bytesTransferred += Math.max(0, delta);
              if (pair.progress.totalBytes > 0) {
                pair.progress.percentage = Math.min(99, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100));
              }
            }
          }
        );

        upload.remoteId = uploadedFile.id;
        (upload as any).remoteMtime = new Date(uploadedFile.modifiedTime).getTime();
        (upload as any).remoteSize = uploadedFile.size ? parseInt(uploadedFile.size, 10) : stats.size;
        (upload as any).remoteMd5 = uploadedFile.md5Checksum || null;
        (upload as any).localMtime = stats.mtimeMs;

        uploadCommits.push({ journalId, operationId });
        completedUploads.add(upload.localPath);
        if (pair.progress) pair.progress.currentFileIndex = (pair.progress.currentFileIndex || 0) + 1;

        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: upload.remoteName, action: 'uploaded', timestamp: Date.now()
        }, true);
      } catch (e: any) {
        if (e && e.code === 'ENOENT') {
           if (operationId) db.updateOperation(operationId, { status: 'done', last_error: 'ENOENT', updated_at: Date.now() });
           this.logger.warn(`[Transfer] Upload skipped for ${fullLocalPath} because it was deleted locally.`);
        } else {
          hadFailures = true;
          if (operationId) db.updateOperation(operationId, {
            status: 'retry', last_error: e instanceof Error ? e.message : String(e), updated_at: Date.now(),
          });
          this.logger.error(`[Transfer] Upload failed for ${fullLocalPath}:`, e instanceof Error ? e.message : String(e));
        }
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: upload.remoteName, action: 'info', timestamp: Date.now(),
          details: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        }, true);
      }
    });

    await this.runInPool(uploadTasks, TRANSFER_CONCURRENCY);
    checkInterrupt();
    if ((pair.status as string) === 'paused') return false;

    const downloadedLocalMtimes = new Map<string, number>();

    const downloadTasks = plan.downloads.map(download => async (): Promise<void> => {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, download.localPath);
      const relPath = getRelPath(download.localPath);
      const journalId = db.journalStart(pair.id, 'download_start', relPath, download.remoteFile.id);
      const operationId = this.beginTransferOperation(pair.id, relPath, 'download', download.remoteFile.id);
      try {
        let fileTransferredBytes = 0;
        await this.downloadDriveBinary(
          download.remoteFile.id,
          fullLocalPath,
          download.remoteFile.modifiedTime,
          download.remoteFile.md5Checksum,
          download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : undefined,
          (loadedChunkBytes) => {
            if (pair.progress) {
              const delta = loadedChunkBytes - fileTransferredBytes;
              fileTransferredBytes = loadedChunkBytes;
              pair.progress.bytesTransferred += Math.max(0, delta);
              pair.progress.percentage = pair.progress.totalBytes > 0
                ? Math.min(99, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100))
                : 100;
            }
          }
        );

        const downloadedStats = await fs.stat(fullLocalPath);
        downloadedLocalMtimes.set(download.localPath, downloadedStats?.mtimeMs ?? Date.now());

        downloadCommits.push({ journalId, operationId });
        completedDownloads.add(download.localPath);
        if (pair.progress) pair.progress.currentFileIndex = (pair.progress.currentFileIndex || 0) + 1;
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: download.remoteFile.name, action: 'downloaded', timestamp: Date.now()
        }, true);
      } catch (e: any) {
        if (e instanceof FileNotFoundError) {
          db.journalDone(journalId);
          if (operationId) db.updateOperation(operationId, {
            status: 'done', last_error: null, updated_at: Date.now(),
          });
          db.setFileState(pair.id, relPath, {
            pair_id: pair.id, rel_path: relPath, remote_id: null,
            local_mtime: null, remote_mtime: null, file_size: null, md5_hash: null,
            block_hashes: null, vector_clock: '{}',
            device_id: deviceId, etag: null, updated_at: Date.now(), is_tombstone: 1,
          });
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
            filename: download.remoteFile.name, action: 'info', timestamp: Date.now(),
            details: 'Remote file was deleted (404); marked as tombstone',
          }, true);
          return;
        }
        hadFailures = true;
        db.journalFail(journalId);
        if (operationId) db.updateOperation(operationId, {
          status: 'retry', last_error: e instanceof Error ? e.message : String(e), updated_at: Date.now(),
        });
        this.logger.error(`[Transfer] Download failed for ${fullLocalPath}:`, e instanceof Error ? e.message : String(e));
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: download.remoteFile.name, action: 'info', timestamp: Date.now(),
          details: `Download failed: ${e instanceof Error ? e.message : String(e)}`,
        }, true);
      }
    });

    await this.runInPool(downloadTasks, TRANSFER_CONCURRENCY);
    checkInterrupt();
    if ((pair.status as string) === 'paused') return false;

    const completedDeletesLocal = new Set<string>();
    const completedDeletesRemote = new Set<string>();

    for (const del of plan.deleteLocal) {
      if ((pair.status as string) === 'paused') return false;
      checkInterrupt();
      const fullLocalPath = path.join(localDir, del.localPath);
      const relPath = getRelPath(del.localPath);
      const journalId = this.db.journalStart(pair.id, 'delete_local_start', relPath);
      try {
        this.markSelfWritten(fullLocalPath);
        await fs.rm(fullLocalPath, { force: true });
        this.db.journalDone(journalId);
        completedDeletesLocal.add(del.localPath);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado localmente'
        }, true);
      } catch (e: unknown) {
        hadFailures = true;
        this.db.journalFail(journalId);
        this.logger.error(`Local delete failed for ${del.localPath}; journal retained as failed:`, e instanceof Error ? e.message : String(e));
      }
    }

    for (const del of plan.deleteRemote) {
      if ((pair.status as string) === 'paused') return false;
      checkInterrupt();
      const relPath = getRelPath(del.localPath);
      const journalId = this.db.journalStart(pair.id, 'delete_remote_start', relPath, del.remoteId);
      try {
        await this.deleteDriveFile(del.remoteId, remoteFolderId);
        this.db.journalDone(journalId);
        completedDeletesRemote.add(del.localPath);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado en Drive'
        }, true);
      } catch (e: unknown) {
        this.db.journalFail(journalId);
        if (e instanceof Error && (e.message.includes('404') || e.message.includes('File not found'))) {
          this.db.journalDone(journalId);
          completedDeletesRemote.add(del.localPath);
        } else {
          hadFailures = true;
          this.logger.error(`Remote delete failed for ${del.localPath}; journal retained as failed:`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    for (const upload of plan.uploads) {
      if (!completedUploads.has(upload.localPath)) continue;
      updates.set(getRelPath(upload.localPath), {
        pair_id: pair.id, rel_path: getRelPath(upload.localPath),
        remote_id: upload.remoteId || null, local_mtime: (upload as any).localMtime || Date.now(), remote_mtime: (upload as any).remoteMtime || Date.now(),
        file_size: (upload as any).remoteSize ?? null, md5_hash: (upload as any).remoteMd5 ?? null, block_hashes: null,
        vector_clock: upload.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    for (const download of plan.downloads) {
      if (!completedDownloads.has(download.localPath)) continue;
      updates.set(getRelPath(download.localPath), {
        pair_id: pair.id, rel_path: getRelPath(download.localPath),
        remote_id: download.remoteFile.id, local_mtime: downloadedLocalMtimes.get(download.localPath) ?? now, remote_mtime: new Date(download.remoteFile.modifiedTime).getTime(),
        file_size: download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : null,
        md5_hash: download.remoteFile.md5Checksum || null, block_hashes: null,
        vector_clock: download.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    for (const del of plan.deleteLocal) {
      if (!completedDeletesLocal.has(del.localPath)) continue;
      updates.set(getRelPath(del.localPath), {
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null, local_mtime: null, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null, vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    for (const del of plan.deleteRemote) {
      if (!completedDeletesRemote.has(del.localPath)) continue;
      updates.set(getRelPath(del.localPath), {
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null, local_mtime: null, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null, vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    const successfulJournalIds = [
      ...uploadCommits.map(c => c.journalId),
      ...downloadCommits.map(c => c.journalId),
    ];
    const successfulOperationIds = [
      ...uploadCommits.map(c => c.operationId).filter((id): id is string => id !== null),
      ...downloadCommits.map(c => c.operationId).filter((id): id is string => id !== null),
    ];

    if (successfulJournalIds.length > 0 || successfulOperationIds.length > 0 || updates.size > 0) {
      checkInterrupt();
      this.db.commitTransfer(
        pair.id,
        updates,
        successfulJournalIds,
        successfulOperationIds,
      );
    }

    const subDirs = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    let localDirs: Dirent[];
    try {
      localDirs = await fs.readdir(localDir, { withFileTypes: true });
    } catch (error) {
      this.logger.error(`Could not read local directory ${localDir}; retaining pending work and skipping destructive planning:`, error instanceof Error ? error.message : String(error));
      return false;
    }
    checkInterrupt();
    const dirNames = new Set<string>();
    for (const dir of localDirs) {
      if (dir.isDirectory() && !matchesIgnorePattern(dir.name, this.settings.ignoredPatterns)) {
        dirNames.add(dir.name);
      }
    }
    for (const dir of remoteFiles) {
      if (dir.mimeType === 'application/vnd.google-apps.folder' && !matchesIgnorePattern(dir.name, this.settings.ignoredPatterns)) {
        dirNames.add(dir.name);
      }
    }

    for (const dirName of dirNames) {
      if ((pair.status as string) === 'paused') return false;
      checkInterrupt();
      const subDir = path.join(localDir, dirName);
      const subPrefix = path.join(relativePrefix, dirName);
      const subRemoteFolder = subDirs.find(d => d.name === dirName);
      if (subRemoteFolder) {
        try {
          await fs.mkdir(subDir, { recursive: true });
        } catch (error) {
          this.logger.error(`Could not create local directory ${subDir}; keeping its work recoverable:`, error instanceof Error ? error.message : String(error));
          continue;
        }
        const childCompleted = await this.v2SyncDirectoryTree(subDir, subRemoteFolder.id, pair, subPrefix);
        if (!childCompleted) hadFailures = true;
      }
    }

    if (hadFailures) {
      this.logger.warn(`[SyncEngine] pair=${pair.id} retained incomplete transfer state; cursor will not advance`);
      return false;
    }

    return true;
  }



  // ─── Engine internals ────────────────────
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
      const errText = await res.text().catch(() => '');
      throw new Error(`Drive API Error ${res.status}: ${errText}`);
    }
    return res;
  }

  private async listDriveFiles(folderId: string, forceRefresh = false): Promise<DriveFile[]> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const cached = this.driveFolderCache.get(folderId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp < 15000)) return cached.files;

    let files: DriveFile[] = [];
    let pageToken: string | undefined = undefined;
    let pageCount = 0;
    do {
      if (pageCount >= this.DRIVE_LIST_MAX_PAGES) {
        throw new Error(`Drive list pagination exceeded ${this.DRIVE_LIST_MAX_PAGES} pages for folder ${folderId}`);
      }
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
      pageCount++;
    } while (pageToken);

    this.driveFolderCache.set(folderId, { timestamp: Date.now(), files });
    return files;
  }

  private async createDriveFolder(parentId: string, name: string): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    try {
      const res = await this.driveRequest('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
      });
      await this.handleDriveResponse(res);
      return (await res.json()) as DriveFile;
    } catch (err: any) {
      if (err.message && err.message.includes('412')) {
        const files = await this.listDriveFiles(parentId, true);
        const existing = files.find(f => f.name === name && f.mimeType === 'application/vnd.google-apps.folder');
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async deleteDriveFile(fileId: string, parentId?: string): Promise<void> {
    if (parentId) this.driveFolderCache.delete(parentId);
    const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    await this.handleDriveResponse(res);
  }

  private async downloadDriveBinary(fileId: string, destPath: string, modifiedTime: string, expectedMd5?: string, expectedSize?: number, onProgress?: (loaded: number) => void): Promise<void> {
    this.logger.info(`Iniciando descarga binaria para fileId: ${fileId} en: ${destPath}`);
    await downloadToAtomicFile({
      sourceUrl: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      destinationPath: destPath,
      modifiedTime,
      expectedMd5,
      expectedSize,
      client: this.transferClient(),
      markSelfWritten: filePath => this.markSelfWritten(filePath),
      onProgress,
    });
  }

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string, vectorClock?: string, operationId?: string | null, onProgress?: (loaded: number, total: number) => void): Promise<DriveFile> {
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
        onProgress,  // BUG-02 fix: propaga el callback de progreso al loop de chunks
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
    const fileData = await fs.readFile(filePath);
    const bodyPayload = Buffer.concat([header, fileData, footer]);
    
    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink';
    const res = await this.driveRequestFactory(url, () => ({
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(bodyPayload.length),
      },
      body: bodyPayload,
    }));
    await this.handleDriveResponse(res);
    // BUG-02 fix: para uploads multipart (<5MB) reportar completado sintético al terminar
    onProgress?.(fileSize, fileSize);
    return (await res.json()) as DriveFile;
  }
  public async shutdown(): Promise<void> {
    this.logger.info('[SyncEngine] Iniciando cierre controlado...');

    for (const pairId in this.intervalRefs) {
      clearTimeout(this.intervalRefs[pairId]);
      delete this.intervalRefs[pairId];
    }
    this.logger.info('[SyncEngine] Intervalos de sondeo detenidos.');

    if (this.externalMonitorInterval) {
      clearInterval(this.externalMonitorInterval);
      this.externalMonitorInterval = null;
      this.logger.info('[SyncEngine] Monitor de unidades externas detenido.');
    }

    const watcherClosures = Object.entries(this.watchers).map(([pairId, watcher]) =>
      watcher.unsubscribe().catch(error => {
        this.logger.warn(`[SyncEngine] Could not close watcher for pair ${pairId}:`, error instanceof Error ? error.message : String(error));
      }),
    );
    await Promise.all(watcherClosures);
    this.watchers = {};
    this.logger.info('[SyncEngine] Observadores de archivos cerrados.');

    if (this.db) {
      await this.db.close();
      this.db = null;
      this.logger.info('[SyncEngine] Conexión a la base de datos cerrada.');
    }

    this.logger.info('[SyncEngine] Cierre controlado completado.');
  }

  public async resetDatabase(): Promise<void> {
    this.logger.warn('[SyncEngine] Resetting database...');
    for (const pair of this.pairs) {
      if (pair.status === 'syncing') {
        pair.status = 'paused';
      }
    }

    if (this.db) {
      await this.db.clearDatabase();
    }

    this.events = [];
    this.pendingConflicts = [];
    await this.saveState();

    this.logger.info('[SyncEngine] Database reset completed.');
  }

  private async registerDriveWebhook(pair: SyncPair, remoteFolderId: string): Promise<void> {
    if (this.activeWebhooks.has(pair.id)) return;
    this.activeWebhooks.add(pair.id);

    const config = getFirebaseClientConfig();
    const webhookUrl = `https://us-central1-${config.projectId}.cloudfunctions.net/driveWebhook`;
    const channelId = `${pair.id}-${Date.now()}`;

    try {
      const res = await this.driveRequestFactory(`https://www.googleapis.com/drive/v3/files/${remoteFolderId}/watch`, () => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: webhookUrl,
          payload: true
        })
      }));
      await this.handleDriveResponse(res);
      this.logger.info(`[Webhooks] Canal ${channelId} registrado con éxito en Google Drive para notificaciones Push.`);
    } catch (e: any) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (errorMessage.includes('Webhook Error:')) {
        this.logger.warn(`[Webhooks] No se pudo registrar el canal. Requiere verificación de dominio en Google Cloud:`, errorMessage);
      } else if (errorMessage.toLowerCase().includes('channel id') || errorMessage.toLowerCase().includes('not unique')) {
        this.logger.info(`[Webhooks] El canal ${channelId} ya está registrado y activo.`);
      } else {
        this.logger.warn(`[Webhooks] Falló el registro del canal para Google Drive:`, errorMessage);
      }
    }
  }
}

export const syncEngine = new SyncEngine();