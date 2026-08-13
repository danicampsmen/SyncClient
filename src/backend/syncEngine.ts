import fs from 'fs/promises';
import fsSync from 'fs';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import crypto from 'node:crypto';
import parcelWatcher, { AsyncSubscription } from '@parcel/watcher';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert, SyncStatus } from '../types';
import { CoreSyncLogic, RemoteEntry, SyncStateSnapshot, DEFAULT_REMOTE_PATH } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, DriveCursor } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager } from '../shared/VectorClock';
import { scanChanges, computeBlockHashes, lazyHashBatch, type LocalEntry } from '../shared/Scanner';
import { ExifDateExtractor } from '../shared/ExifDateExtractor';
import { SyncFilterEngine } from '../shared/SyncFilterEngine';
import { ConditionEvaluator } from '../shared/ConditionEvaluator';
import { NodeFileSystem } from '../utils/nodeFileSystem';
import { downloadToAtomicFile, requestTransfer, RESUMABLE_UPLOAD_THRESHOLD, uploadResumableFile, type TransferHttpClient, FileNotFoundError, TransferHttpError } from './transfer';
import { acquirePairLock, PairAlreadyRunningError, type PairLock } from './pairProcessLock';
import { DriveChangesIngestor, DriveCursorRescanRequiredError, type DriveChange } from './driveChanges';
import { RcloneRunner } from './rcloneRunner';
import { RclonePairConfig } from '../shared/rcloneConfig';
import { SecureStore } from '../utils/secureStore';
import { Logger } from './logger';
import { encryptFile, decryptFile, encryptedSize, EncryptionError, deriveKey } from './encryption';
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

function normalizeNFC(str: string): string {
  return str ? str.normalize('NFC') : str;
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
    ignoredPatterns: ['.#*', '*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.synctex(busy)', '*.run.xml', '*.bcf*', '*.bbl*', '*.blg', '*.ind', '*.ilg', '*.idx', 'auto', '*.minted', '_minted-*', '*.snm', '*.nav', '*.cwl', '*.conflict*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp', '*.syncclient-download-*', '*.syncclient-tmp-*', '__MACOSX', 'Thumbs.db', 'desktop.ini', '*.pyc', '__pycache__', '*.pyi', '.ttxfolder', '.venv', 'venv', 'env', '.syncclient-backups'],
    autoStart: false,
    desktopNotifications: true
  };
  private readonly exifExtractor = new ExifDateExtractor();
  private readonly filterEngine = new SyncFilterEngine();
  private manifests: Record<string, Record<string, ManifestEntry>> = {};
  private pendingConflicts: PendingConflict[] = [];
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private lastTokenRefreshedAt: number = 0;
  private lastProgressEmitAt: Record<string, number> = {};
  private get googleClientId(): string {
    const fbConfig = getFirebaseClientConfig();
    return process.env.VITE_FIREBASE_OAUTH_CLIENT_ID
      || process.env.VITE_GOOGLE_CLIENT_ID
      || process.env.GOOGLE_CLIENT_ID
      || (fbConfig as any).oAuthClientId
      || '';
  }

  private get googleClientSecret(): string {
    const fbConfig = getFirebaseClientConfig();
    return process.env.VITE_GOOGLE_CLIENT_SECRET
      || process.env.GOOGLE_CLIENT_SECRET
      || process.env.VITE_FIREBASE_CLIENT_SECRET
      || process.env.FIREBASE_CLIENT_SECRET
      || '';
  }
  private configDir = path.join(os.homedir(), '.config', 'syncclient');
  private configFile = path.join(this.configDir, 'sync_data.json');

  private appVisible = true;
  private watchers: Record<string, AsyncSubscription> = {};
  private watcherUnsubscribePromises: Record<string, Promise<void>> = {};
  private syncTriggerSource: Record<string, 'manual' | 'poll' | 'webhook' | 'fs-event'> = {};
  private activeSyncs = new Set<string>();
  private pendingSyncs = new Set<string>();
  private pendingResync = new Set<string>();
  private activeTransfers = new Set<string>();
  private activeTransferProgress = new Map<string, number>();
  private completedBytesByPair: Record<string, number> = {};
  private dedupCancelled = new Set<string>();
  private watcherRetryCount: Record<string, number> = {};
  private debounceTimers: Record<string, NodeJS.Timeout> = {};
  private pollingFallbackTimers: Record<string, NodeJS.Timeout> = {};
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
  private readonly DRIVE_MAX_ATTEMPTS = 5;
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
  private rootResolutionPromiseMap = new Map<string, Promise<string>>();
  private abortControllers: Record<string, AbortController> = {};
  private webhookDebounceTimers: Record<string, NodeJS.Timeout> = {};
  private lastLocalMutationTime: Record<string, number> = {};
  private excludedCleanCancelled = false;
  private scheduleInterval: NodeJS.Timeout | null = null;

  private async readSystemStatus() {
    try {
      const os = await import('os');
      const cpus = os.cpus();
      const isLaptop = cpus.length > 0 && (cpus[0].model || '').toLowerCase().includes('intel') || (cpus[0].model || '').toLowerCase().includes('amd');
      return {
        isCharging: true,
        batteryLevel: 100,
        isWifiConnected: true,
        currentSsid: undefined,
        isRoaming: false,
        isMetered: false,
        isVpnConnected: false,
      };
    } catch {
      return {
        isCharging: true,
        batteryLevel: 100,
        isWifiConnected: true,
        currentSsid: undefined,
        isRoaming: false,
        isMetered: false,
        isVpnConnected: false,
      };
    }
  }

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
          if (err instanceof Error && (err.message.includes('UNAUTHORIZED_EXPIRED_TOKEN') || err.message.includes(this.WEBHOOK_INTERRUPT))) {
            index = tasks.length;
          }
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
    this.lastVacuumAt = now;
    setTimeout(() => {
      try {
        this.db!.vacuum();
        this.logger.info('[SyncEngine/DB] SQLite VACUUM completado en segundo plano.');
      } catch (e) {
        this.logger.warn('[SyncEngine/DB] Error durante VACUUM:', e instanceof Error ? e.message : String(e));
      }
    }, 5000);
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
    pairId?: string
  ): Promise<Response> {
    let lastError: unknown;
    let refreshed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // Full Jitter Backoff (1s -> 2s -> 4s -> 8s -> 16s + variación aleatoria)
        const baseDelay = Math.min(32000, 1000 * (2 ** (attempt - 2)));
        const jitter = Math.floor(Math.random() * 1000);
        const delay = baseDelay + jitter;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        await this.waitForDriveSlot();
        const init = initFactory();
        const headers = new Headers(init.headers);
        if (this.accessToken && headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${this.accessToken}`);
        }

        let controller = pairId ? this.abortControllers[pairId] : undefined;
        if (controller && controller.signal.aborted) {
          controller = undefined;
        }
        const signal = controller ? controller.signal : (init.signal !== undefined ? init.signal : AbortSignal.timeout(30000));

        const response = await fetch(url, { ...init, headers, signal });

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
          } catch {
            isAuthError = true;
          }
        }

        if (isAuthError && !refreshed) {
          refreshed = true;
          await response.body?.cancel().catch(() => {});
          if (await this.refreshAccessToken()) {
            attempt--;
            continue;
          }
          throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
        }

        // Si recibimos 429 con Retry-After, respetar la espera indicada por Google
        if (isRateLimit && attempt < maxAttempts) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryDelayMs = retryAfterHeader ? Math.min(32000, parseInt(retryAfterHeader, 10) * 1000) : 3000;
          await response.body?.cancel().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }

        if (!(response.status === 429 || response.status >= 500 || isRateLimit) || attempt === maxAttempts) {
          return response;
        }

        // Liberar sockets y descriptores de red inmediatamente antes del reintento
        await response.body?.cancel().catch(() => {});
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
      request: (url, init) => this.driveRequest(url, init ?? {}),
      getAccessToken: () => this.accessToken,
      refreshAccessToken: () => this.refreshAccessToken(),
    };
  }

  constructor() {
    this.init();
    setInterval(() => this.cleanupSelfWrittenFiles(), 60000);
    setInterval(() => this.autoRefreshTokensPeriodic(), 15 * 60 * 1000);
  }

  private async autoRefreshTokensPeriodic() {
    if (!this.refreshToken) return;
    const now = Date.now();
    if (now - this.lastTokenRefreshedAt >= 40 * 60 * 1000) {
      this.logger.info('[SyncEngine/Auth] Ejecutando renovación proactiva periódica del token OAuth2 (40m)...');
      await this.refreshAccessToken().catch(() => {});
    }
  }

  private async init() {
    try {
      this.initializeOAuthCredentials();
      await fs.mkdir(this.configDir, { recursive: true });

      // Cargar tokens guardados en SecureStore al arrancar el backend
      try {
        const savedAccess = await SecureStore.get('gdrive_access_token');
        const savedRefresh = await SecureStore.get('gdrive_refresh_token');
        if (savedAccess) this.accessToken = savedAccess;
        if (savedRefresh) this.refreshToken = savedRefresh;
      } catch (err) {
        this.logger.debug('[SyncEngine] No se pudieron cargar tokens previos desde SecureStore:', err instanceof Error ? err.message : String(err));
      }

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
          const defaultPatterns = ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.synctex(busy)', '*.run.xml', '*.bcf*', '*.bbl*', '*.blg', '*.ind', '*.ilg', '*.idx', 'auto', '*.minted', '_minted-*', '*.snm', '*.nav', '*.cwl', '*.conflict*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp', '*.syncclient-download-*', '*.syncclient-tmp-*', '__MACOSX', 'Thumbs.db', 'desktop.ini', '*.pyc', '__pycache__', '*.pyi', '.ttxfolder', '.venv', 'venv', 'env', '.syncclient-backups'];
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
      this.scheduleInterval = setInterval(() => this.evaluateSchedules(), 60 * 1000);
    } catch (err) {
      this.logger.error('[SyncEngine] Init error:', err);
    }
  }

  private markSelfWritten(filePath: string) {
    if (!filePath) return;
    const normalized = path.normalize(filePath).normalize('NFC');
    this.selfWrittenFiles.set(normalized, Date.now());
    if (this.selfWrittenFiles.size > 10000) {
      const now = Date.now();
      for (const [key, timestamp] of this.selfWrittenFiles.entries()) {
        if (now - timestamp > 30000) this.selfWrittenFiles.delete(key);
      }
    }
  }

  private cleanupSelfWrittenFiles(): void {
    if (this.selfWrittenFiles.size <= 5000) return;
    const now = Date.now();
    for (const [key, timestamp] of this.selfWrittenFiles.entries()) {
      if (now - timestamp > 30000) this.selfWrittenFiles.delete(key);
    }
  }

  private isSelfWritten(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = path.normalize(filePath).normalize('NFC');
    const timestamp = this.selfWrittenFiles.get(normalized);
    if (!timestamp) return false;
    if (Date.now() - timestamp < 3000) return true;
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
    const pairsToRecover = this.pairs.filter(pair => {
      const lastAttempt = this.lastRecoveryAttempt[pair.id] || 0;
      if (now - lastAttempt < 60000) return false;
      const operations = this.db!.getRecoverableOperations(pair.id);
      const journalEntries = this.db!.getPendingJournalEntries(pair.id);
      return operations.length > 0 || journalEntries.length > 0;
    });

    for (let i = 0; i < pairsToRecover.length; i++) {
      const pair = pairsToRecover[i];
      this.lastRecoveryAttempt[pair.id] = Date.now();
      const operations = this.db!.getRecoverableOperations(pair.id);
      const journalEntries = this.db!.getPendingJournalEntries(pair.id);
      
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of journalEntries) {
        if (entry.created_at < cutoff) {
          this.db!.journalFail(entry.id);
        }
      }
      
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

      if (i < pairsToRecover.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  private applyDriveChange(pairId: string, change: DriveChange): void {
    if (change.removed) {
      for (const [folderId, cached] of this.driveFolderCache) {
        const next = cached.files.filter(file => file.id !== change.fileId);
        if (next.length !== cached.files.length) {
          this.driveFolderCache.set(folderId, { ...cached, files: next });
        }
      }
      return;
    }

    // Ignorar cambios e interrupciones causadas por este propio dispositivo (Self-Echo)
    const appProps = (change.file as any)?.appProperties;
    if (appProps && appProps.syncclient_device_id === this.DEVICE_ID) {
      this.logger.debug(`[DriveChanges] Ignorando eco remoto del propio dispositivo (${this.DEVICE_ID}) en fileId: ${change.fileId}`);
      return;
    }

    if (!change.file) return; // Registro silencioso en lugar de excepción fatal
    
    const rawFile = change.file as unknown as any;
    if (typeof rawFile.id !== 'string' || typeof rawFile.name !== 'string'
      || typeof rawFile.mimeType !== 'string' || typeof rawFile.modifiedTime !== 'string') {
      return;
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

    const cacheUpdates = new Map<string, DriveFile[]>();
    for (const [folderId, cached] of this.driveFolderCache) {
      const withoutChange = cached.files.filter(candidate => candidate.id !== file.id);
      if (withoutChange.length !== cached.files.length) {
        cacheUpdates.set(folderId, withoutChange);
      }
      if (file.parents?.includes(folderId)) {
        const current = cacheUpdates.get(folderId) ?? withoutChange;
        cacheUpdates.set(folderId, [...current, file]);
      }
    }
    for (const [folderId, files] of cacheUpdates) {
      const existing = this.driveFolderCache.get(folderId);
      if (existing) {
        this.driveFolderCache.set(folderId, { ...existing, files });
      } else {
        this.driveFolderCache.set(folderId, { timestamp: Date.now(), files });
      }
    }
  }

  private async ingestDriveChanges(pair: SyncPair): Promise<{ pageToken: string; controlledRescan: boolean; changes: DriveChange[] } | null> {
    if (!this.isDriveChangesEnabled() || !this.db || !this.accessToken) return null;

    const accountId = pair.accountId || 'default-account';
    const driveId = pair.driveId ?? 'my-drive';
    const cursorKey = {
      pair_id: pair.id,
      account_id: accountId,
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
      accountId,
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
    if (!this.db) return;
    const accountId = pair.accountId || 'default-account';
    this.db.setDriveCursor({
      pair_id: pair.id,
      account_id: accountId,
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
    if (accessToken) this.lastTokenRefreshedAt = Date.now();

    this.saveTokens(accessToken, refreshToken || this.refreshToken);

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
            if (event.timestamp > lastProcessed) {
              const lastMutation = this.lastLocalMutationTime[pair.id] || 0;
              if (Date.now() - lastMutation < 3000) {
                this.lastProcessedWebhookEvent[pair.id] = event.timestamp;
                this.logger.debug(`[Webhooks] Ignorando evento RTDB por inmunidad de mutación local reciente (${pair.id})`);
                continue;
              }

              if (this.webhookDebounceTimers[pair.id]) {
                clearTimeout(this.webhookDebounceTimers[pair.id]);
              }

              this.webhookDebounceTimers[pair.id] = setTimeout(() => {
                this.lastProcessedWebhookEvent[pair.id] = event.timestamp;
                this.driveFolderCache.clear();
                this.driveChangesCacheReady.delete(pair.id);

                if (this.activeSyncs.has(pair.id) || this.activeTransfers.size > 0) {
                  this.pendingResync.add(pair.id);
                  this.logger.info(`[Webhooks] Cambio remoto detectado durante sync para ${pair.id}. Programado para procesar al finalizar.`);
                } else {
                  this.logger.info(`[Webhooks] ¡Nuevo cambio en Google Drive! Iniciando actualización para ${pair.id}...`);
                  this.syncTriggerSource[pair.id] = 'webhook' as any;
                  this.executeFastSyncFromWebhook(pair).catch(e => {
                    this.logger.error(`[Webhooks] Error en Fast Sync, ejecutando Sincronización Completa:`, e instanceof Error ? e.message : String(e));
                    this.triggerSync(pair.id);
                  });
                }
              }, 1500);
            }
          }
        }
      }, (error) => {
        this.logger.warn(`[Webhooks] Error escuchando RTDB:`, error.message);
      });
      this.logger.info(`[Webhooks] Escuchando cambios en tiempo real vía Firebase RTDB con Inmunidad Local.`);
    } catch (e) {
      this.logger.error(`[Webhooks] No se pudo inicializar listener RTDB:`, e instanceof Error ? e.message : String(e));
    }
  }

  // --- Token Persistence ---
  private initializeOAuthCredentials() {
    // Dynamically evaluated via getters
  }

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
    if (!this.refreshToken) {
      this.logger.warn('[SyncEngine/Auth] Cannot refresh access token: No refresh_token stored.');
      return false;
    }
    try {
      const buildParams = (includeSecret = true) => {
        const params = new URLSearchParams({
          client_id: this.googleClientId || '',
          refresh_token: this.refreshToken!,
          grant_type: 'refresh_token',
        });
        if (includeSecret && this.googleClientSecret) {
          params.append('client_secret', this.googleClientSecret);
        }
        return params;
      };

      let res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildParams(true).toString(),
        signal: AbortSignal.timeout(15000),
      });

      // Fallback: If request with client_secret failed with invalid_client, retry without client_secret
      if (!res.ok && this.googleClientSecret) {
        const clone = res.clone();
        const errData = await clone.json().catch(() => ({}));
        if (errData.error === 'invalid_client') {
          this.logger.warn('[SyncEngine/Auth] Token refresh with client_secret failed (invalid_client), retrying without client_secret...');
          res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: buildParams(false).toString(),
            signal: AbortSignal.timeout(15000),
          });
        }
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        this.logger.error(`[SyncEngine/Auth] Token refresh request failed (HTTP ${res.status}):`, errData);
        if (errData.error === 'invalid_grant' || errData.error === 'invalid_client') {
          this.logger.error(`[SyncEngine/Auth] Refresh token is invalid/revoked (${errData.error}). Clearing stored tokens.`);
          this.refreshToken = null;
          this.accessToken = null;
          await this.saveTokens(null, null);
        }
        return false;
      }

      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        this.lastTokenRefreshedAt = Date.now();
        this.logger.info('[SyncEngine/Auth] Access token refreshed successfully via refresh_token.');
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
      this.logger.warn('[SyncEngine/Auth] Access-token refresh failed:', error instanceof Error ? error.message : String(error));
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

  public getPairs(): SyncPair[] {
    return this.pairs;
  }

  public dismissExternalDriveAlert(drivePath: string) {
    this.detectedExternalDrives = this.detectedExternalDrives.filter(d => d.path !== drivePath);
  }

  private startExternalDriveMonitor() {
    if (!this.appVisible) return;
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
    const loaded = await Promise.all(pairs.map(async p => {
      const conditions = this.getPairConditions(p.id);
      const schedules = this.getPairSchedules(p.id);
      return {
        ...p,
        localPath: p.localPath.startsWith('~/') ? path.join(os.homedir(), p.localPath.slice(2)) : p.localPath,
        conditions: conditions || undefined,
        schedules: schedules || undefined,
      };
    }));
    this.pairs = loaded;
    await this.saveState();
    this.refreshWatchers();
    this.refreshIntervals();
  }

  public async updateSettings(settings: SyncSettings) {
    this.settings = settings;
    await this.saveState();
  }

  public setAppVisible(visible: boolean) {
    this.appVisible = visible;
    if (visible) {
      this.refreshWatchers();
      this.refreshIntervals();
      this.startExternalDriveMonitor();
    } else {
      this.refreshWatchers();
      this.refreshIntervals();
      if (this.externalMonitorInterval) {
        clearInterval(this.externalMonitorInterval);
        this.externalMonitorInterval = null;
      }
    }
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

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'rename' | 'skip' | 'overwrite_oldest' | 'overwrite_newest' | 'use_left' | 'use_right' | 'delete' | 'consider_equal'): Promise<void> {
    const conflict = this.pendingConflicts.find(c => c.id === conflictId);
    if (!conflict) return;
    const pair = this.pairs.find(p => p.id === conflict.pairId);
    if (!pair) return;

    const fullLocalPath = path.join(pair.localPath, conflict.localPath);
    let effective: 'local' | 'remote' | 'rename' | 'skip' | 'overwrite_oldest' | 'overwrite_newest' | 'use_left' | 'use_right' | 'delete' | 'consider_equal' = resolution;

    if (effective === 'consider_equal') {
      if (conflict.localHash && conflict.remoteHash && conflict.localHash === conflict.remoteHash) {
        effective = 'skip';
      } else {
        effective = conflict.localMtime >= conflict.remoteMtime ? 'local' : 'remote';
      }
    }

    if (effective === 'use_left') effective = 'local';
    if (effective === 'use_right') effective = 'remote';
    if (effective === 'overwrite_oldest') {
      effective = conflict.localMtime <= conflict.remoteMtime ? 'local' : 'remote';
    }
    if (effective === 'overwrite_newest') {
      effective = conflict.localMtime >= conflict.remoteMtime ? 'local' : 'remote';
    }

    if (effective === 'delete') {
      try {
        await fs.unlink(fullLocalPath);
        this.markSelfWritten(fullLocalPath);
      } catch {}
      effective = 'skip';
    }

    if (effective === 'local') {
      try {
        await fs.access(fullLocalPath);
      } catch {
        this.logger.warn(`[ResolveConflict] '${conflict.localPath}' no existe localmente; resolviendo como 'remote' (restaurar desde Drive)`);
        effective = 'remote';
      }
    }

    if (conflict.reason === 'MASS_DELETION_APPROVAL_REQUIRED') {
      if (effective === 'local') {
        this.logger.info(`[ResolveConflict] Borrado masivo confirmado por el usuario para pair=${pair.id}. Marcando archivos como tombstones.`);
        if (this.db) {
          const folderStates = this.db.getFolderState(pair.id);
          if (folderStates) {
            for (const [relPath, state] of folderStates) {
              if (!state.is_tombstone) {
                this.db.setFileState(pair.id, relPath, { ...state, is_tombstone: 1, updated_at: Date.now() });
              }
            }
          }
        }
      } else if (effective === 'remote') {
        this.logger.info(`[ResolveConflict] Restauración de borrado masivo solicitada para pair=${pair.id}. Se descargarán los archivos de Drive en el próximo ciclo.`);
      } else {
        this.logger.info(`[ResolveConflict] Borrado masivo omitido para pair=${pair.id}. Marcando archivos como tombstones.`);
        if (this.db) {
          const folderStates = this.db.getFolderState(pair.id);
          if (folderStates) {
            for (const [relPath, state] of folderStates) {
              if (!state.is_tombstone) {
                this.db.setFileState(pair.id, relPath, { ...state, is_tombstone: 1, updated_at: Date.now() });
              }
            }
          }
        }
      }

      this.pendingConflicts = this.pendingConflicts.filter(c => c.id !== conflictId);
      if (this.db) this.db.resolveConflict(conflictId, effective);
      await this.saveState();
      return;
    }

    const parentDir = path.dirname(conflict.localPath);
    const relParentDir = parentDir === '.' ? '' : parentDir;
    const remoteFolderId = await this.ensureRemoteFolderPath(pair, relParentDir);
    const safeRemoteISO = (conflict.remoteMtime && Number.isFinite(conflict.remoteMtime) && conflict.remoteMtime > 0)
      ? new Date(conflict.remoteMtime).toISOString()
      : new Date().toISOString();

    if (effective === 'local') {
      const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'upload', conflict.remoteFileId);
      try {
        const uploaded = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, conflict.remoteFileName, conflict.remoteFileId, undefined, operationId, undefined, pair.id);
        this.markSelfWritten(fullLocalPath);
        if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
        const stats = await fs.stat(fullLocalPath);

        let finalMd5 = uploaded.md5Checksum || conflict.localHash || conflict.remoteHash || null;
        if (!finalMd5) {
          const hashes = await computeBlockHashes(fullLocalPath, false).catch(() => []);
          if (hashes.length > 0) finalMd5 = hashes[0];
        }

        await this.commitResolutionState(pair, conflict.localPath, {
          remoteId: uploaded.id || conflict.remoteFileId,
          remoteMtime: uploaded.modifiedTime ? new Date(uploaded.modifiedTime).getTime() : (conflict.remoteMtime || Date.now()),
          md5: finalMd5,
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
      if (!conflict.remoteFileId || !conflict.remoteFileId.trim()) {
        this.logger.warn(`[ResolveConflict] fileId vacío para '${conflict.localPath}'; resolviendo como 'skip'.`);
        effective = 'skip';
      } else {
        const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'download', conflict.remoteFileId);
        try {
          await this.downloadDriveBinary(conflict.remoteFileId, fullLocalPath, safeRemoteISO, pair.id, conflict.remoteHash || undefined);
          this.markSelfWritten(fullLocalPath);
          if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });
          const stats = await fs.stat(fullLocalPath);

          let finalMd5 = conflict.remoteHash || conflict.localHash || null;
          if (!finalMd5) {
            const hashes = await computeBlockHashes(fullLocalPath, false).catch(() => []);
            if (hashes.length > 0) finalMd5 = hashes[0];
          }

          await this.commitResolutionState(pair, conflict.localPath, {
            remoteId: conflict.remoteFileId,
            remoteMtime: conflict.remoteMtime || Date.now(),
            md5: finalMd5,
            localMtime: stats.mtimeMs,
            fileSize: stats.size,
          });
        } catch (error) {
          if (error instanceof Error && (error.message.includes('404') || error.message.includes('File not found'))) {
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
            effective = 'skip';
          } else {
            if (operationId && this.db) this.db.updateOperation(operationId, {
              status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
            });
            throw error;
          }
        }
      }
    } else if (effective === 'rename') {
      if (!conflict.remoteFileId || !conflict.remoteFileId.trim()) {
        this.logger.warn(`[ResolveConflict] fileId vacío para '${conflict.localPath}'; resolviendo como 'skip'.`);
        effective = 'skip';
      } else {
        const parsed = path.parse(fullLocalPath);
        const renamedPath = path.join(parsed.dir, `${parsed.name}.remote${parsed.ext}`);
        const operationId = this.beginTransferOperation(pair.id, conflict.localPath, 'download', conflict.remoteFileId);
        try {
          await this.downloadDriveBinary(conflict.remoteFileId, renamedPath, safeRemoteISO, pair.id, conflict.remoteHash || undefined);
          this.markSelfWritten(renamedPath);
          if (operationId && this.db) this.db.updateOperation(operationId, { status: 'done', updated_at: Date.now() });

          const originalStats = await fs.stat(fullLocalPath).catch(() => null);
          const renamedStats = await fs.stat(renamedPath).catch(() => null);

          if (renamedStats) {
            const parsedRel = path.parse(conflict.localPath);
            const renamedRelPath = path.join(parsedRel.dir, `${parsedRel.name}.remote${parsedRel.ext}`);
            await this.commitResolutionState(pair, renamedRelPath, {
              remoteId: conflict.remoteFileId,
              remoteMtime: conflict.remoteMtime || Date.now(),
              md5: conflict.remoteHash || null,
              localMtime: renamedStats.mtimeMs,
              fileSize: renamedStats.size,
            });
          }

          if (originalStats) {
            await this.commitResolutionState(pair, conflict.localPath, {
              remoteId: null,
              remoteMtime: Date.now(),
              md5: conflict.localHash || null,
              localMtime: originalStats.mtimeMs,
              fileSize: originalStats.size,
            });
          }
        } catch (error) {
          if (operationId && this.db) this.db.updateOperation(operationId, {
            status: 'retry', last_error: error instanceof Error ? error.message : String(error), updated_at: Date.now(),
          });
          throw error;
        }
      }
    }

    if (effective === 'skip') {
      const stats = await fs.stat(fullLocalPath).catch(() => null);
      await this.commitResolutionState(pair, conflict.localPath, {
        remoteId: conflict.remoteFileId || null,
        remoteMtime: conflict.remoteMtime || Date.now(),
        md5: conflict.localHash || conflict.remoteHash || null,
        localMtime: stats?.mtimeMs || Date.now(),
        fileSize: stats?.size || null,
      });
      this.logger.info(`[ResolveConflict] Estado de '${conflict.localPath}' asentado en SQLite como 'skip'.`);
    }

    this.pendingConflicts = this.pendingConflicts.filter(c => c.id !== conflictId);
    if (this.db) this.db.resolveConflict(conflictId, effective);
    await this.saveState();
  }

  private async commitResolutionState(pair: SyncPair, relPath: string, opts: {
    remoteId: string | null; remoteMtime: number; md5: string | null; localMtime: number; fileSize: number | null;
  }): Promise<void> {
    if (!this.db) return;
    const existing = this.db.getFileState(pair.id, relPath);
    const now = Date.now();

    const currentClock = VectorClockManager.fromString(existing?.vector_clock || '{}');
    const updatedClock = VectorClockManager.increment(currentClock, this.DEVICE_ID || 'desktop');

    const state: FileState = {
      pair_id: pair.id,
      rel_path: relPath,
      remote_id: opts.remoteId,
      local_mtime: opts.localMtime,
      remote_mtime: opts.remoteMtime,
      file_size: opts.fileSize,
      md5_hash: opts.md5,
      block_hashes: existing?.block_hashes ?? null,
      vector_clock: JSON.stringify(updatedClock),
      device_id: this.DEVICE_ID || '',
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
      if (entry.name.startsWith('.syncclient-backups')) continue;
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

    const dateStamp = new Date().toISOString().slice(0, 10);
    const backupDir = path.join(pair.localPath, '.syncclient-backups', `dedup_${dateStamp}`);

    for (const [baseName, versions] of grouped.entries()) {
      if (versions.length <= 1) continue;

      if (this.dedupCancelled.has(pair.id)) {
        this.logger.info(`[Deduplicate] Cancelación detectada en cleanLocalDuplicatesDir para pair=${pair.id}`);
        break;
      }

      const winner = versions[0];
      const losers = versions.slice(1);

      for (const loser of losers) {
        const loserPath = path.join(currentDir, loser.name);
        const loserRelPath = relativePrefix ? `${relativePrefix}/${loser.name}` : loser.name;

        try {
          await fs.mkdir(backupDir, { recursive: true });
          let backupFilePath = path.join(backupDir, loserRelPath.replace(/[\/\\]/g, '_'));
          try {
            await fs.stat(backupFilePath);
            const parsed = path.parse(backupFilePath);
            backupFilePath = path.join(parsed.dir, `${parsed.name}_${Date.now()}${parsed.ext}`);
          } catch { }
          
          this.markSelfWritten(loserPath);
          this.markSelfWritten(backupFilePath);
          
          try {
            await fs.rename(loserPath, backupFilePath);
          } catch {
            await fs.copyFile(loserPath, backupFilePath);
            await fs.unlink(loserPath);
          }

          this.logger.info(`[Deduplicate] ${loser.name} movido de forma segura a respaldo local: ${backupFilePath}`);
        } catch (e) {
          this.logger.warn(`[Deduplicate] No se pudo mover a respaldo ${loserPath}, eliminando con fallback:`, e instanceof Error ? e.message : String(e));
          this.markSelfWritten(loserPath);
          await fs.rm(loserPath, { force: true }).catch(() => {});
        }

        localDeleted++;

        if (this.db) {
          const existingState = this.db.getFileState(pair.id, loserRelPath);
          this.db.setFileState(pair.id, loserRelPath, {
            pair_id: pair.id, rel_path: loserRelPath,
            remote_id: existingState?.remote_id ?? null,
            local_mtime: Date.now(), remote_mtime: existingState?.remote_mtime ?? null,
            file_size: null, md5_hash: null, block_hashes: null,
            vector_clock: existingState?.vector_clock ?? '{}',
            device_id: existingState?.device_id ?? this.DEVICE_ID ?? '',
            etag: null, updated_at: Date.now(), is_tombstone: 1
          });
        }

        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: loserRelPath, action: 'cleaned', timestamp: Date.now(),
          details: `Respaldado en .syncclient-backups; conservado el más reciente: ${winner.name}`,
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
                local_mtime: Date.now(),
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

  private async trashDriveFile(fileId: string, parentId?: string): Promise<void> {
    if (parentId) this.driveFolderCache.delete(parentId);
    for (const pair of this.pairs) {
      this.lastLocalMutationTime[pair.id] = Date.now();
    }
    const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trashed: true })
    });
    await this.handleDriveResponse(res);
  }

  private invalidatePairRootCache(pairId: string): void {
    this.pairRootRemoteFolderCache.delete(pairId);
  }

  private async cleanRemoteDuplicatesDir(pairId: string, folderId: string): Promise<number> {
    let remoteDeleted = 0;
    const remoteFiles = await this.listDriveFiles(folderId, true);
    const fileItems = remoteFiles
      .filter(f => f.mimeType !== 'application/vnd.google-apps.folder')
      .map(f => ({ name: f.name, mtime: new Date(f.modifiedTime).getTime(), md5Checksum: f.md5Checksum, remoteId: f.id }));

    const remoteGrouped = CoreSyncLogic.groupAndSortDuplicates(fileItems);
    for (const [, versions] of remoteGrouped.entries()) {
      if (versions.length <= 1) continue;

      if (this.dedupCancelled.has(pairId)) {
        this.logger.info(`[Deduplicate] Cancelación detectada en cleanRemoteDuplicatesDir para pair=${pairId}`);
        break;
      }

      const winner = versions[0];
      const losers = versions.slice(1);

      for (const loser of losers) {
        if (this.dedupCancelled.has(pairId)) {
          this.logger.info(`[Deduplicate] Interrumpiendo envío a papelera por cancelación del par ${pairId}`);
          break;
        }

        if (loser.remoteId) {
          this.logger.info(`[Deduplicate] Moviendo archivo duplicado a Papelera de Drive: ${loser.name} (id: ${loser.remoteId}). Conservado el más reciente: ${winner.name}`);
          await this.trashDriveFile(loser.remoteId, folderId).catch(e =>
            this.logger.warn(`[Deduplicate] No se pudo enviar a papelera archivo remoto ${loser.remoteId}:`, e instanceof Error ? e.message : String(e))
          );
          remoteDeleted++;
        }
      }
    }

    const subFolders = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    for (const subFolder of subFolders) {
      if (this.dedupCancelled.has(pairId)) break;
      remoteDeleted += await this.cleanRemoteDuplicatesDir(pairId, subFolder.id);
    }

    return remoteDeleted;
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) {
      return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };
    }

    this.dedupCancelled.delete(pairId);

      let localDeleted = 0;
      let localRenamed = 0;
      let remoteDeleted = 0;
      let remoteRenamed = 0;

    try {
      const localRes = await this.cleanLocalDuplicatesDir(pair, pair.localPath, '');
      if (this.dedupCancelled.has(pairId)) {
        this.logger.info(`[Deduplicate] pair=${pairId} cancelado tras fase local.`);
        return { localDeleted: localRes.localDeleted, localRenamed: localRes.localRenamed, remoteDeleted: 0, remoteRenamed: 0 };
      }
      localDeleted = localRes.localDeleted;
      localRenamed = localRes.localRenamed;

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

          if (this.dedupCancelled.has(pairId)) {
            this.logger.info(`[Deduplicate] pair=${pairId} cancelado antes de iniciar deduplicación remota.`);
            return { localDeleted, localRenamed, remoteDeleted: 0, remoteRenamed: 0 };
          }
          remoteDeleted = await this.cleanRemoteDuplicatesDir(pairId, remoteFolderId);
        } catch (e) {
          this.logger.warn(`[Deduplicate] Deduplicación remota omitida (error al resolver carpeta):`, e instanceof Error ? e.message : String(e));
        }
      }

      this.logger.info(`[Deduplicate] pair=${pairId} completado — local: ${localDeleted} respaldados, ${localRenamed} renombrados; remoto: ${remoteDeleted} a papelera.`);
      this.addEvent({
        id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
        filename: pair.localPath, action: 'cleaned', timestamp: Date.now(),
        details: `Limpieza completada: ${localDeleted} respaldados en .syncclient-backups, ${localRenamed} renombrados, ${remoteDeleted} en Papelera de Drive.`,
      });
    } catch (error) {
      if (this.dedupCancelled.has(pairId)) {
        this.logger.info(`[Deduplicate] pair=${pairId} cancelado explícitamente.`);
      } else {
        this.logger.error(`[Deduplicate] Error al limpiar duplicados para pair=${pairId}:`, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.dedupCancelled.delete(pairId);
    }

    return { localDeleted, localRenamed, remoteDeleted, remoteRenamed };
  }

  public cancelCleanDuplicates(pairId: string): void {
    this.dedupCancelled.add(pairId);
    this.logger.info(`[Deduplicate] Solicitud de cancelación recibida para pair=${pairId}`);
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
              if (stub && stub.id && stub.id.trim()) {
                const realFileName = entry.name.replace(/\.vstream$/, '');
                const targetRealPath = path.join(dir, realFileName);
                 await this.downloadDriveBinary(stub.id, targetRealPath, stub.modifiedTime || new Date().toISOString(), pairId);
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

  private enablePollingFallback(pairId: string) {
    if (this.pollingFallbackTimers[pairId]) return;

    // Poll every 30 seconds as a fallback
    this.pollingFallbackTimers[pairId] = setInterval(() => {
      const pair = this.pairs.find(p => p.id === pairId);
      if (!pair || (pair.status !== 'syncing' && pair.status !== 'idle')) {
        clearInterval(this.pollingFallbackTimers[pairId]);
        delete this.pollingFallbackTimers[pairId];
        return;
      }
      this.logger.info(`[SyncEngine/Watcher] Triggering fallback poll for pair ${pairId}`);
      this.syncTriggerSource[pairId] = 'poll' as any;
      this.triggerSync(pairId);
    }, 30000);
  }

  private async createWatcherForPair(pair: SyncPair): Promise<void> {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const subscription = await parcelWatcher.subscribe(pair.localPath, (err, events) => {
          if (err) {
            this.logger.error(`Error en watcher para par=${pair.id}:`, err);
            return;
          }

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

          // Si hay una sincronización activa: Encolar eventos locales sin abortar con interruptRequested
          if (this.activeSyncs.has(pair.id) || this.interruptRequested[pair.id]) {
            const existing = this.pendingLocalEvents[pair.id] || [];
            const newEvents = relevantEvents.map(evt => ({
              relPath: path.relative(pair.localPath, evt.path),
              localEvent: evt.type as 'create' | 'update' | 'delete'
            }));
            const merged = [...existing];
            for (const item of newEvents) {
              if (!merged.some(u => u.relPath === item.relPath)) merged.push(item);
            }
            this.pendingLocalEvents[pair.id] = merged;
            this.logger.info(`[Watcher] Cambios locales detectados durante sync para el par ${pair.id}. Se procesarán al finalizar.`);
            return;
          }

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
        this.logger.info(`[SyncEngine/Watcher] Watcher created successfully for pair ${pair.id} on attempt ${attempt + 1}`);

        if (this.pollingFallbackTimers[pair.id]) {
          clearInterval(this.pollingFallbackTimers[pair.id]);
          delete this.pollingFallbackTimers[pair.id];
        }
        return;
      } catch (err) {
        this.watcherRetryCount[pair.id] = (this.watcherRetryCount[pair.id] || 0) + 1;
        if (attempt < MAX_RETRIES - 1) {
          const backoff = (2 ** attempt) * 1000 + Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    this.logger.error(`[SyncEngine/Watcher] Failed to create watcher for pair ${pair.id} after ${MAX_RETRIES} retries. Enabling polling fallback.`);
    this.enablePollingFallback(pair.id);
  }

  private refreshWatchers() {
    this.pairs.forEach(pair => {
      const shouldWatch = (pair.status === 'syncing' || pair.status === 'idle') && !!pair.localPath && this.appVisible;
      const existingWatcher = this.watchers[pair.id];
      const pendingUnsubscribe = this.watcherUnsubscribePromises[pair.id];

      if (shouldWatch && !existingWatcher && !pendingUnsubscribe) {
        this.createWatcherForPair(pair).catch(error => {
          this.logger.error(`[SyncEngine/Watcher] createWatcherForPair threw an unexpected error for pair ${pair.id}:`, error instanceof Error ? error.message : String(error));
        });
      } else if (!shouldWatch && existingWatcher) {
        this.watcherUnsubscribePromises[pair.id] = (async () => {
          try {
            await existingWatcher.unsubscribe();
          } catch (error) {
            this.logger.warn(`[SyncEngine/Watcher] Could not unsubscribe watcher for pair ${pair.id}:`, error instanceof Error ? error.message : String(error));
          }
        })().finally(() => {
          delete this.watchers[pair.id];
          delete this.watcherUnsubscribePromises[pair.id];
        });
        delete this.watchers[pair.id];
      }
    });

    Object.keys(this.watchers).forEach(id => {
      if (!this.pairs.find(p => p.id === id)) {
        const existingWatcher = this.watchers[id];
        if (existingWatcher) {
          this.watcherUnsubscribePromises[id] = (async () => {
            try {
              await existingWatcher.unsubscribe();
            } catch (error) {
              this.logger.warn(`[SyncEngine/Watcher] Could not unsubscribe stale watcher for pair ${id}:`, error instanceof Error ? error.message : String(error));
            }
          })().finally(() => {
            delete this.watchers[id];
            delete this.watcherUnsubscribePromises[id];
          });
          delete this.watchers[id];
        }
      }
    });

    Object.keys(this.pollingFallbackTimers).forEach(id => {
      if (!this.pairs.find(p => p.id === id)) {
        clearInterval(this.pollingFallbackTimers[id]);
        delete this.pollingFallbackTimers[id];
      }
    });
  }

  private refreshIntervals() {
    this.pairs.forEach(pair => {
      const isWatchable = pair.status === 'syncing' || pair.status === 'idle';
      if (isWatchable && !this.intervalRefs[pair.id] && this.appVisible) {
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
    this.completedBytesByPair[pairId] = 0;

    // --- BIFURCACIÓN DE MOTOR: SI EL PAR USA RCLONE ---
    if (pair.engineType === 'rclone') {
      this.logger.info(`[SyncEngine] Ejecutando sincronización con motor autónomo Rclone CLI para par=${pairId}...`);
      const runner = new RcloneRunner();
      const rcloneConf = pair.rcloneConfigPath || path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
      
      const rclonePairConfig: RclonePairConfig = {
        pairId: pair.id,
        localPath: pair.localPath,
        remotePath: pair.remotePath,
        operation: pair.rcloneOperation || (pair.direction === 'upload' ? 'sync' : pair.direction === 'download' ? 'copy' : 'bisync'),
        configPath: rcloneConf,
        lockDirectory: this.sharedPairLockDirectory(),
        dryRun: false,
        confirmDestructive: true,
      };

      pair.progress = {
        currentFile: 'Ejecutando proceso Rclone CLI...',
        totalFiles: 0,
        currentFileIndex: 0,
        bytesTransferred: 0,
        totalBytes: 0,
        percentage: 50,
        action: 'subiendo'
      };

      try {
        const result = await runner.run(rclonePairConfig, pairLock);
        this.logger.info(`[Rclone] Par ${pairId} completado exitosamente.`);
        pair.lastSynced = Date.now();
        pair.status = 'idle';
        pair.progress = {
          currentFile: 'Sincronización Rclone completada',
          totalFiles: 1, currentFileIndex: 1,
          bytesTransferred: 0, totalBytes: 0,
          percentage: 100, action: 'completado'
        };

        this.addEvent({
          id: Math.random().toString(36).slice(2, 11),
          pairId: pair.id,
          filename: pair.localPath,
          action: 'sync_end',
          timestamp: Date.now(),
          details: `Rclone CLI (${rclonePairConfig.operation}) finalizado con éxito.`,
        });
      } catch (err: any) {
        const isNotFound = err?.code === 'ENOENT' || String(err).includes('ENOENT');
        const detailMsg = isNotFound
          ? 'El ejecutable rclone no está instalado en tu sistema Linux. Instálalo ejecutando: sudo apt install rclone'
          : `Error en Rclone: ${err?.message || String(err)}`;

        this.logger.error(`[Rclone] Error ejecutando rclone para par=${pairId}:`, detailMsg);
        pair.status = 'error';
        pair.progress = null;

        // FIX: Limpiar cola de reintentos pendientes para evitar bucles de 2 segundos
        this.pendingSyncs.delete(pairId);

        this.addEvent({
          id: Math.random().toString(36).slice(2, 11),
          pairId: pair.id,
          filename: pair.localPath,
          action: 'info',
          timestamp: Date.now(),
          details: detailMsg,
        });
      } finally {
        try {
          await pairLock.release();
        } catch { }
        this.activeSyncs.delete(pairId);
        delete this.interruptRequested[pairId];
        await this.saveState();
      }
      return; // Finalizar la ejecución sin pasar por v2SyncDirectoryTree
    }

    // --- CONTINUAR CON EL MOTOR NATIVO V2 (SQLITE + DRIVE API) ---
    if (this.db) {
      const incompleteCount = this.db.getIncompleteTransfers(pairId).length;
      if (incompleteCount > 0) {
        this.logger.warn(`[Recovery] Se encontraron ${incompleteCount} transferencias incompletas para pair=${pairId}. Limpiando para un nuevo intento.`);
        this.db.clearIncompleteTransfers(pairId);
      }
    }

    let driveChangeBatch: { pageToken: string; controlledRescan: boolean } | null = null;
    try {
      const systemStatus = await this.readSystemStatus();
      const conditionResult = ConditionEvaluator.evaluate(pair.conditions, systemStatus, false);
      if (!conditionResult.canSync) {
        this.logger.warn(`[SyncEngine/Conditions] pair=${pairId} omitido: ${conditionResult.reason}`);
        pair.status = conditionResult.statusCode || 'error';
        pair.progress = {
          currentFile: `Sincronización omitida: ${conditionResult.reason}`,
          totalFiles: 0,
          currentFileIndex: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          percentage: 0,
          action: 'espera'
        };
        this.addEvent({
          id: Math.random().toString(36).slice(2, 11),
          pairId: pair.id,
          filename: pair.localPath,
          action: 'info',
          timestamp: Date.now(),
          details: conditionResult.reason || 'Condiciones no cumplidas',
        });
        await this.saveState();
        return;
      }

      const remoteFolderId = await this.getPairRootRemoteFolderId(pair);

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
      else pair.status = this.mapErrorToGranularStatus(err);
      pair.progress = null;
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      if (err instanceof Error && err.message !== 'WEBHOOK_INTERRUPT') {
        this.logger.error(`[SyncEngine] pair=${pairId} sync failed; recoverable state was retained:`, errMsg);
        this.addEvent({
          id: Math.random().toString(36).slice(2, 11), pairId, filename: pair.localPath,
          action: 'info', timestamp: Date.now(),
          details: `Synchronization failed: ${err instanceof Error ? err.message : String(err)}`,
        }, true);
      }
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
        this.driveFolderCache.clear();
        this.driveChangesCacheReady.delete(pairId);
        setTimeout(() => {
          this.executeFastSyncFromWebhook(pair).catch(e => {
            this.logger.error(`[Webhooks] Error en Fast Sync diferido para par ${pairId}, ejecutando Sincronización Completa:`, e instanceof Error ? e.message : String(e));
            this.driveFolderCache.clear();
            this.driveChangesCacheReady.delete(pairId);
            this.triggerSync(pairId);
          });
        }, 1000);
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

  private async ensureTokenFreshness(): Promise<boolean> {
    if (!this.accessToken) return false;
    if (this.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          this.logger.info('[SyncEngine/Auth] Token de Google Drive renovado proactivamente antes de la transmisión.');
          return true;
        }
      } catch (err) {
        this.logger.warn('[SyncEngine/Auth] Falló la comprobación proactiva de token:', err);
      }
    }
    return Boolean(this.accessToken);
  }

  public async triggerSync(pairId: string) {
    if (!this.accessToken) return;
    await this.ensureTokenFreshness();
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

    this.driveFolderCache.clear();
    this.driveChangesCacheReady.delete(pair.id);

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
          // El archivo o carpeta ya existe en la base de datos local
          targetPaths.push({ relPath: state.rel_path, change });
        } else if (df?.parents?.length) {
          const parentId = df.parents[0];
          let parentRelPath: string | null = null;
          const rootFolderId = this.pairRootRemoteFolderCache.get(pair.id) ?? await this.ensureRemoteFolderPath(pair, '');
          if (parentId === rootFolderId) {
            parentRelPath = '';
          } else {
            const parentState = this.db.getFileStateByRemoteId(pair.id, parentId);
            if (parentState) {
              parentRelPath = parentState.rel_path;
            }
          }

          if (parentRelPath !== null && df.name) {
            targetPaths.push({
              relPath: parentRelPath ? `${parentRelPath}/${df.name}` : df.name,
              change
            });
          } else {
            requiresFullSync = true;
          }
        } else if (change.removed) {
          // Si fue removido pero no estaba en DB, no hay nada que hacer
        } else {
          requiresFullSync = true;
        }
      }
    }

    // Si logramos mapear las rutas y no requerimos resync completo
    if (targetPaths.length > 0 && !requiresFullSync) {
      this.logger.info(`[FastSync] Descargando/Actualizando inmediatamente ${targetPaths.length} archivo(s) en el par ${pair.id}.`);
      await this.fastSync(pair, targetPaths);
      this.commitDriveChangesCursor(pair, changesResult.pageToken);
    } else if (!requiresFullSync && targetPaths.length === 0) {
      this.commitDriveChangesCursor(pair, changesResult.pageToken);
    } else {
      this.driveChangesCacheReady.delete(pair.id);
      if (this.ensureInterrupt(pair.id)) {
        this.interruptRequested[pair.id] = { eventTimestamp: Date.now() };
      }
      this.logger.info(`[Webhooks] Transición a Sincronización Directa Inmediata para el par ${pair.id}...`);
      this.triggerSync(pair.id);
    }
  }

  private pairRootRemoteFolderCache = new Map<string, string>();

  private async searchSharedWithMeFolder(name: string): Promise<DriveFile[]> {
    if (!this.accessToken) throw new Error('No OAuth access token set');
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.append('q', `sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
    url.searchParams.append('fields', 'files(id, name, mimeType, modifiedTime)');
    url.searchParams.append('supportsAllDrives', 'true');
    url.searchParams.append('includeItemsFromAllDrives', 'true');

    const res = await this.driveRequest(url.toString(), { headers: { Authorization: `Bearer ${this.accessToken}` } });
    await this.handleDriveResponse(res);
    const data: any = await res.json();
    return data.files || [];
  }

  private async checkIfRemoteFolderDeleted(remoteId: string): Promise<boolean> {
    try {
      const url = `https://www.googleapis.com/drive/v3/files/${remoteId}?fields=id,trashed&supportsAllDrives=true`;
      const res = await this.driveRequest(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
      if (res.status === 404) return true;
      if (!res.ok) return false;
      const data = await res.json();
      return data.trashed === true;
    } catch {
      return false;
    }
  }

  public async getPairRootRemoteFolderId(pair: SyncPair): Promise<string> {
    if (this.pairRootRemoteFolderCache.has(pair.id)) {
      const cached = this.pairRootRemoteFolderCache.get(pair.id)!;
      const isDeleted = await this.checkIfRemoteFolderDeleted(cached);
      if (!isDeleted) {
        return cached;
      }
      this.pairRootRemoteFolderCache.delete(pair.id);
    }

    // Single-Flight Mutex: Si otra rutina ya está resolviendo la raíz de este par, esperar la misma promesa
    const inFlight = this.rootResolutionPromiseMap.get(pair.id);
    if (inFlight) {
      return await inFlight;
    }

    const resolutionPromise = (async () => {
      let remotePathStr = pair.remotePath || DEFAULT_REMOTE_PATH;
      if (remotePathStr.startsWith('GoogleDrive:')) remotePathStr = remotePathStr.replace('GoogleDrive:', '');
      if (!remotePathStr.startsWith('/')) remotePathStr = '/' + remotePathStr;
      let remotePathParts = remotePathStr.split('/').filter(p => p.length > 0);

      if (pair.cloudCategory === 'computers' && remotePathParts[0] !== 'Ordenadores' && remotePathParts[0] !== 'Computers') {
        const deviceLabel = pair.deviceName || os.hostname() || 'Dispositivo-Linux';
        remotePathParts = ['Ordenadores', deviceLabel, ...remotePathParts];
      }

      let remoteFolderId = (pair.cloudCategory === 'shared' && pair.driveId) ? pair.driveId : 'root';
      for (const part of remotePathParts) {
        let folder = undefined;
        if (remoteFolderId === 'root' && pair.cloudCategory === 'shared') {
          const sharedFolders = await this.searchSharedWithMeFolder(part);
          if (sharedFolders.length > 0) {
            folder = sharedFolders[0];
          }
        }
        if (!folder) {
          const files = await this.listDriveFiles(remoteFolderId, true);
          folder = files.find(f => f.name.normalize('NFC') === part && f.mimeType === 'application/vnd.google-apps.folder');
        }
        if (!folder) folder = await this.createDriveFolder(remoteFolderId, part);
        remoteFolderId = folder.id;
      }
      this.pairRootRemoteFolderCache.set(pair.id, remoteFolderId);
      return remoteFolderId;
    })();

    this.rootResolutionPromiseMap.set(pair.id, resolutionPromise);
    try {
      return await resolutionPromise;
    } finally {
      this.rootResolutionPromiseMap.delete(pair.id);
    }
  }

  public async cleanCloudExcludedFiles(): Promise<{ excludedFilesCleaned: number; patternsChecked: number }> {
    if (!this.accessToken) throw new Error('No hay sesión activa en Google Drive');

    this.excludedCleanCancelled = false;
    let excludedFilesCleaned = 0;
    const patterns = this.settings.ignoredPatterns || CoreSyncLogic.DEFAULT_IGNORE_PATTERNS;

    for (const pair of this.pairs) {
      if (this.excludedCleanCancelled) {
        this.logger.info('[CleanExcluded] Limpieza cancelada antes de procesar el siguiente par.');
        break;
      }

      try {
        const remoteFolderId = await this.getPairRootRemoteFolderId(pair);
        const cleanedCount = await this.cleanExcludedFilesInFolder(remoteFolderId, patterns);
        excludedFilesCleaned += cleanedCount;
      } catch (e: any) {
        this.logger.warn(`[CleanExcluded] Error al escanear carpeta remota del par ${pair.id}:`, e?.message || e);
      }
    }

    this.addEvent({
      id: Math.random().toString(36).substr(2, 9),
      pairId: 'global',
      filename: 'Limpieza de Archivos Excluidos en Nube',
      action: 'cleaned',
      timestamp: Date.now(),
      details: this.excludedCleanCancelled
        ? `Limpieza de exclusiones cancelada: ${excludedFilesCleaned} archivo(s) eliminados antes de detenerse.`
        : `Limpieza de exclusiones completada: ${excludedFilesCleaned} archivo(s) temporales eliminados en Drive. La papelera NO fue tocada.`
    });

    return { excludedFilesCleaned, patternsChecked: patterns.length };
  }

  public cancelCleanCloudExcludedFiles(): void {
    this.excludedCleanCancelled = true;
    this.logger.info('[CleanExcluded] Solicitud de cancelación de limpieza de exclusiones recibida.');
  }

  private async cleanExcludedFilesInFolder(folderId: string, patterns: string[]): Promise<number> {
    if (this.excludedCleanCancelled) return 0;
    
    let count = 0;
    const files = await this.listDriveFiles(folderId, true);

    for (const file of files) {
      if (this.excludedCleanCancelled) {
        this.logger.info('[CleanExcluded] Interrumpiendo borrado de exclusiones por orden de cancelación.');
        break;
      }

      if (file.mimeType === 'application/vnd.google-apps.folder') {
        if (matchesIgnorePattern(file.name, patterns)) {
          this.logger.info(`[CleanExcluded] Eliminando carpeta excluida en Drive: ${file.name} (id: ${file.id})`);
          await this.deleteDriveFile(file.id, folderId).catch(() => {});
          count++;
        } else {
          count += await this.cleanExcludedFilesInFolder(file.id, patterns);
        }
      } else {
        if (matchesIgnorePattern(file.name, patterns)) {
          this.logger.info(`[CleanExcluded] Eliminando archivo excluido en Drive: ${file.name} (id: ${file.id})`);
          await this.deleteDriveFile(file.id, folderId).catch(() => {});
          count++;
        }
      }
    }

    return count;
  }

  public async ensureRemoteFolderPath(pair: SyncPair, relDirPath: string, depth = 0): Promise<string> {
    const MAX_DEPTH = 50;
    if (depth > MAX_DEPTH) {
      throw new Error(`[SyncEngine] ensureRemoteFolderPath exceeded max depth (${MAX_DEPTH}) for path: ${relDirPath}`);
    }
    const normalized = relDirPath.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/').normalize('NFC');
    if (!normalized || normalized === '.' || normalized === '') {
      return await this.getPairRootRemoteFolderId(pair);
    }

    const existingState = this.db?.getFileState(pair.id, normalized);
    if (existingState && existingState.remote_id && existingState.remote_id !== '.' && existingState.is_tombstone !== 1) {
      const isDeleted = await this.checkIfRemoteFolderDeleted(existingState.remote_id);
      if (!isDeleted) {
        return existingState.remote_id;
      }
      this.logger.warn(`[SyncEngine] La carpeta remota ${normalized} (id: ${existingState.remote_id}) ya no existe en Drive. Sanando estado en cascada...`);
      if (this.db) {
        this.db.setFileState(pair.id, normalized, {
          ...existingState,
          remote_id: null,
          updated_at: Date.now()
        });
        const folderStateMap = this.db.getFolderState(pair.id);
        const prefix = normalized + '/';
        for (const [childPath, childState] of folderStateMap) {
          if (childPath.startsWith(prefix) && childState.remote_id) {
            this.db.setFileState(pair.id, childPath, {
              ...childState,
              remote_id: null,
              updated_at: Date.now()
            });
          }
        }
      }
      this.pairRootRemoteFolderCache.delete(pair.id);
    }

    const parentDir = path.dirname(normalized);
    const parentFolderId = await this.ensureRemoteFolderPath(pair, parentDir === '.' ? '' : parentDir, depth + 1);
    const folderName = path.basename(normalized);

    let folder: DriveFile | undefined;
    try {
      const files = await this.listDriveFiles(parentFolderId, true);
      folder = files.find(f => f.name.normalize('NFC') === folderName && f.mimeType === 'application/vnd.google-apps.folder');
    } catch (err: any) {
      if (err instanceof Error && (err.message.includes('404') || err.message.includes('File not found'))) {
        this.logger.warn(`[SyncEngine] Padre ${parentFolderId} dio 404 al listar ${folderName}. Re-creando rama completa...`);
        this.pairRootRemoteFolderCache.delete(pair.id);
        const freshParentId = await this.getPairRootRemoteFolderId(pair);
        const files = await this.listDriveFiles(freshParentId, true);
        folder = files.find(f => f.name.normalize('NFC') === folderName && f.mimeType === 'application/vnd.google-apps.folder');
      } else {
        throw err;
      }
    }

    if (!folder) {
      try {
        folder = await this.createDriveFolder(parentFolderId, folderName);
        this.logger.info(`[SyncEngine] Carpeta remota creada para ${normalized} (id: ${folder.id})`);
      } catch (err: any) {
        if (err instanceof Error && (err.message.includes('404') || err.message.includes('File not found'))) {
          this.logger.warn(`[SyncEngine] Padre ${parentFolderId} dio 404 al crear ${folderName}. Re-creando desde raíz...`);
          this.pairRootRemoteFolderCache.delete(pair.id);
          const freshParentId = await this.getPairRootRemoteFolderId(pair);
          folder = await this.createDriveFolder(freshParentId, folderName);
        } else {
          throw err;
        }
      }
    }

    if (this.db) {
      this.db.setFileState(pair.id, normalized, {
        pair_id: pair.id,
        rel_path: normalized,
        remote_id: folder.id,
        local_mtime: Date.now(),
        remote_mtime: new Date(folder.modifiedTime || Date.now()).getTime(),
        file_size: null,
        md5_hash: null,
        block_hashes: null,
        vector_clock: '{}',
        device_id: this.DEVICE_ID || '',
        etag: null,
        updated_at: Date.now(),
        is_tombstone: 0
      });
    }

    return folder.id;
  }

  public async fastSync(pair: SyncPair, targetPaths: { relPath: string; change?: DriveChange; localEvent?: 'create' | 'update' | 'delete' }[]) {
    if (!this.db || !this.accessToken) return;

    let pairLock: PairLock | null = null;
    try {
      pairLock = await acquirePairLock(this.sharedPairLockDirectory(), pair.id);
    } catch {
      const existing = this.pendingLocalEvents[pair.id] || [];
      const newEvents = targetPaths.map(t => ({ relPath: t.relPath, localEvent: t.localEvent || 'update' }));
      const merged = [...existing];
      for (const item of newEvents) {
        if (!merged.some(u => u.relPath === item.relPath)) merged.push(item);
      }
      this.pendingLocalEvents[pair.id] = merged;
      this.logger.info(`[FastSync] Sincronización ocupada. Se difirieron ${targetPaths.length} evento(s) local(es).`);
      return;
    }

    try {
      this.logger.info(`[FastSync] Paths a sincronizar: ${targetPaths.map(t => `${t.relPath} (${t.change ? 'remote' : 'local'})`).join(', ')}`);

      const sortedTargets = [...targetPaths].sort((a, b) => a.relPath.split(path.sep).length - b.relPath.split(path.sep).length);

      for (const { relPath, change, localEvent } of sortedTargets) {
        if (!relPath || relPath === '.' || relPath === '') continue;

        const canonicalRelPath = normalizeNFC(relPath);
        const lockKey = `${pair.id}:${canonicalRelPath}`;

        if (this.activeTransfers.has(lockKey)) continue;
        this.activeTransfers.add(lockKey);

        try {
          const fullLocalPath = path.join(pair.localPath, canonicalRelPath);

          if (change) {
            if (pair.direction === 'upload') {
              this.logger.debug(`[FastSync] Ignorando evento remoto en ${canonicalRelPath} por modo 'Solo Subida'.`);
              continue;
            }

            if (change.removed) {
              this.markSelfWritten(fullLocalPath);
              await fs.rm(fullLocalPath, { recursive: true, force: true }).catch(() => {});
              
              const state = this.db.getFileState(pair.id, canonicalRelPath);
              if (state) {
                this.db.setFileState(pair.id, canonicalRelPath, {
                  ...state,
                  is_tombstone: 1,
                  updated_at: Date.now(),
                  local_mtime: Date.now(),
                  file_size: null
                });
              } else {
                this.db.deleteFileState(pair.id, canonicalRelPath);
              }
              this.logger.info(`[FastSync] Deleted local file/folder ${canonicalRelPath} (removed remotely)`);
              continue;
            }

            const remoteFile = change.file as unknown as DriveFile;
            if (remoteFile && remoteFile.mimeType === 'application/vnd.google-apps.folder') {
              this.markSelfWritten(fullLocalPath);
              await fs.mkdir(fullLocalPath, { recursive: true }).catch(() => {});
              this.db.setFileState(pair.id, canonicalRelPath, {
                pair_id: pair.id, rel_path: canonicalRelPath, remote_id: remoteFile.id,
                local_mtime: Date.now(), remote_mtime: new Date(remoteFile.modifiedTime || Date.now()).getTime(),
                file_size: null, md5_hash: null, block_hashes: null,
                vector_clock: '{}', device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
              });
              continue;
            }

            const state = this.db.getFileState(pair.id, canonicalRelPath);

            if (state && remoteFile.md5Checksum && state.md5_hash === remoteFile.md5Checksum) {
              this.logger.debug(`[FastSync] ${canonicalRelPath} coincide en MD5 con Drive. Ignorando evento.`);
              continue;
            }

            this.logger.info(`[FastSync] Descargando actualización remota: ${canonicalRelPath}`);
            const remoteFileSize = remoteFile.size ? parseInt(remoteFile.size, 10) : undefined;
            
            if (pair.progress) {
              pair.progress.action = 'descargando';
              pair.progress.currentFile = remoteFile.name;
            }

            await this.downloadDriveBinary(remoteFile.id, fullLocalPath, remoteFile.modifiedTime, pair.id, remoteFile.md5Checksum, remoteFileSize, (loaded) => {
              if (pair.progress) pair.progress.bytesTransferred = loaded;
            });

            const newStat = await fs.stat(fullLocalPath);
            if (remoteFileSize && newStat.size !== remoteFileSize) {
              throw new Error(`Downloaded size mismatch for ${canonicalRelPath}: expected ${remoteFileSize}, got ${newStat.size}`);
            }
            if (remoteFile.md5Checksum) {
              const actualHashes = await computeBlockHashes(fullLocalPath, false).catch(() => []);
              const actualMd5 = actualHashes[0];
              if (actualMd5 && actualMd5.toLowerCase() !== remoteFile.md5Checksum.toLowerCase()) {
                throw new Error(`Downloaded MD5 mismatch for ${canonicalRelPath}`);
              }
            }

            const currentClock = VectorClockManager.fromString(state?.vector_clock || '{}');
            const updatedClock = VectorClockManager.increment(currentClock, this.DEVICE_ID || 'desktop');
            this.db.setFileState(pair.id, canonicalRelPath, {
              pair_id: pair.id, rel_path: canonicalRelPath, remote_id: remoteFile.id,
              local_mtime: newStat.mtimeMs, remote_mtime: new Date(remoteFile.modifiedTime).getTime(),
              file_size: newStat.size, md5_hash: remoteFile.md5Checksum || null, block_hashes: null,
              vector_clock: JSON.stringify(updatedClock), device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
            });
            this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: remoteFile.name, action: 'downloaded', timestamp: Date.now() }, true);

          } else if (localEvent) {
            if (pair.direction === 'download') {
              this.logger.debug(`[FastSync] Ignorando evento local en ${canonicalRelPath} por modo 'Solo Descarga'.`);
              continue;
            }

            const state = this.db.getFileState(pair.id, canonicalRelPath);

            let localStat = null;
            try { localStat = await fs.stat(fullLocalPath); } catch { localStat = null; }

            if (localEvent === 'delete' || !localStat) {
              if (localStat) {
                this.logger.info(`[FastSync] Ignorando evento 'delete' para ${canonicalRelPath}: aún existe en disco.`);
                continue;
              }
              if (state && (state.file_size === 0 || state.file_size === null) && !state.md5_hash) {
                this.logger.info(`[FastSync] Borrado de directorio detectado (${canonicalRelPath}). Programando sincronización de árbol...`);
                setTimeout(() => this.triggerSync(pair.id), 100);
                continue;
              }
              if (state && state.remote_id) {
                this.logger.info(`[FastSync] Deleting remote file ${canonicalRelPath}`);
                await this.deleteDriveFile(state.remote_id);
                this.invalidatePairRootCache(pair.id);
                this.db.setFileState(pair.id, canonicalRelPath, { ...state, is_tombstone: 1, updated_at: Date.now() });
                this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: path.basename(canonicalRelPath), action: 'deleted', timestamp: Date.now() }, true);
              }
            } else {
              if (localStat.isDirectory()) {
                await this.ensureRemoteFolderPath(pair, canonicalRelPath);
                this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: path.basename(canonicalRelPath), action: 'uploaded', timestamp: Date.now() }, true);
              } else if (localStat.isFile()) {
                this.logger.info(`[FastSync] Uploading local file ${canonicalRelPath}`);
                const parentDir = path.dirname(canonicalRelPath);
                const remoteFolderId = await this.ensureRemoteFolderPath(pair, parentDir === '.' ? '' : parentDir);
                const existingRemoteId = (state && state.remote_id && state.remote_id !== '.' && state.is_tombstone !== 1) ? state.remote_id : undefined;

                const uploadedFile = await this.uploadDriveBinary(remoteFolderId, fullLocalPath, path.basename(canonicalRelPath), existingRemoteId, state?.vector_clock, undefined, undefined, pair.id);
                const updatedStat = await fs.stat(fullLocalPath);
                
                const currentClock = VectorClockManager.fromString(state?.vector_clock || '{}');
                const updatedClock = VectorClockManager.increment(currentClock, this.DEVICE_ID || 'desktop');
                
                this.db.setFileState(pair.id, canonicalRelPath, {
                  pair_id: pair.id, rel_path: canonicalRelPath, remote_id: uploadedFile.id,
                  local_mtime: updatedStat.mtimeMs, remote_mtime: new Date(uploadedFile.modifiedTime).getTime(),
                  file_size: updatedStat.size, md5_hash: uploadedFile.md5Checksum || null, block_hashes: null,
                  vector_clock: JSON.stringify(updatedClock), device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
                });
                this.addEvent({ id: Math.random().toString(36).substr(2, 9), pairId: pair.id, filename: path.basename(canonicalRelPath), action: 'uploaded', timestamp: Date.now() }, true);
              }
            }
          }
        } catch (err) {
          this.logger.error(`[FastSync] Error procesando ${canonicalRelPath}:`, err);
        } finally {
          this.activeTransfers.delete(lockKey);
        }
      }
    } finally {
      await pairLock.release();
      if (this.pendingResync.has(pair.id)) {
        this.pendingResync.delete(pair.id);
        this.logger.info(`[FastSync] Se detectaron cambios locales que requieren resync completo para ${pair.id}. Ejecutando Sincronización Inmediata...`);
        this.triggerSync(pair.id);
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

  private async v2SyncDirectoryTree(
    localDir: string,
    remoteFolderId: string,
    pair: SyncPair,
    relativePrefix = '',
    dbFolderMap?: Map<string, Map<string, FileState>>,
    scanTracker?: { scannedFolders: number; totalFoldersEstimate: number }
  ): Promise<boolean> {
    if (!this.db || !this.DEVICE_ID) return false;

    let folderMap = dbFolderMap;
    let tracker = scanTracker;
    if (!folderMap) {
      folderMap = new Map<string, Map<string, FileState>>();
      const dbState = this.db.getFolderState(pair.id);
      for (const [relPath, state] of dbState) {
        const canonicalRelPath = normalizeNFC(relPath);
        const dirname = path.dirname(canonicalRelPath) === '.' ? '' : normalizeNFC(path.dirname(canonicalRelPath).replace(/\\/g, '/'));
        const baseName = normalizeNFC(path.basename(canonicalRelPath));
        let subMap = folderMap.get(dirname);
        if (!subMap) {
          subMap = new Map<string, FileState>();
          folderMap.set(dirname, subMap);
        }
        subMap.set(baseName, state);
      }
    }

    if (!tracker) {
      tracker = { scannedFolders: 0, totalFoldersEstimate: Math.max(1, folderMap.size) };
    }

    tracker.scannedFolders++;
    const scanPct = Math.min(99, Math.max(1, Math.round((tracker.scannedFolders / tracker.totalFoldersEstimate) * 100)));
    if (pair.progress) {
      pair.progress.currentFile = relativePrefix ? `Escaneando subcarpeta: ${relativePrefix}` : 'Escaneando árbol de directorios...';
      pair.progress.percentage = scanPct;
      pair.progress.action = 'comprobando';
    }

    const checkInterrupt = () => {
      if (this.interruptRequested[pair.id]) {
        throw new Error(this.WEBHOOK_INTERRUPT);
      }
    };

    const normalizedPrefix = normalizeNFC(relativePrefix.replace(/\\/g, '/'));
    const dirDbState = folderMap.get(normalizedPrefix) || new Map<string, FileState>();

    const scanResult = await scanChanges(localDir, dirDbState, new NodeFileSystem(), pair.id, this.exifExtractor as any);
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

    if ((relativePrefix === '' || relativePrefix === '.') && remoteFiles.length === 0 && dirDbState.size > 5) {
      this.logger.warn(`[SyncEngine] Listado remoto devolvió 0 archivos para la raíz con ${dirDbState.size} registros en DB. Re-verificando ID de carpeta raíz...`);
      this.pairRootRemoteFolderCache.delete(pair.id);
      return false;
    }

    const getRelPath = (baseName: string): string => normalizeNFC(relativePrefix ? `${relativePrefix}/${baseName}` : baseName);

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
      if (file.mimeType.startsWith('application/vnd.google-apps.')) continue;
      const canonicalName = file.name.normalize('NFC');
      remoteSnapshot.set(canonicalName, {
        id: file.id, name: canonicalName, mimeType: file.mimeType, modifiedTime: file.modifiedTime,
        size: file.size, md5Checksum: file.md5Checksum, appProperties: file.appProperties, etag: undefined
      });
    }

    // O(1) Batch Reconcile: Stage tombstones SOLO PARA ARCHIVOS (no carpetas)
    const tombstonesToWrite = new Map<string, FileState>();
    for (const [baseName, state] of dirDbState) {
      const isDirectoryEntry = (state.file_size === null || state.file_size === 0) && !state.md5_hash;
      if (state.remote_id && !state.is_tombstone && !isDirectoryEntry) {
        const stillExists = remoteFiles.some(f => f.id === state.remote_id);
        if (!stillExists) {
          tombstonesToWrite.set(baseName, { ...state, is_tombstone: 1, updated_at: Date.now() });
        }
      }
    }

    const dbStateForPlan = new Map<string, SyncStateSnapshot>();
    for (const [baseName, state] of dirDbState) {
      const isTombstone = state.is_tombstone === 1 || tombstonesToWrite.has(baseName);
      dbStateForPlan.set(baseName, {
        localMtime: state.local_mtime || 0,
        remoteMtime: state.remote_mtime || 0,
        remoteId: state.remote_id || '',
        fileSize: state.file_size,
        baseHash: state.md5_hash,
        vectorClock: state.vector_clock,
        isTombstone
      });
    }

    const plan = CoreSyncLogic.computeSyncPlan(localSnapshot, remoteSnapshot, dbStateForPlan, this.DEVICE_ID);
    checkInterrupt();

    if (pair.direction === 'upload') {
      plan.downloads = [];
      plan.deleteLocal = [];
      plan.adoptions = [];
      if (plan.moves) plan.moves = [];
    } else if (pair.direction === 'download') {
      plan.uploads = [];
      plan.deleteRemote = [];
      if (plan.moves) plan.moves = [];
    }

    const sortCriterion = pair.transferSortCriterion || pair.transferPriority || 'default';
    if (sortCriterion !== 'default') {
      plan.uploads = SyncFilterEngine.sortTransferQueue(plan.uploads.map(u => ({
        ...u,
        size: localSnapshot.get(u.localPath)?.size,
        mtimeMs: localSnapshot.get(u.localPath)?.mtime,
      })), sortCriterion);
      plan.downloads = SyncFilterEngine.sortTransferQueue(plan.downloads.map(d => ({
        ...d,
        size: d.remoteFile.size ? parseInt(d.remoteFile.size, 10) : 0,
        mtimeMs: new Date(d.remoteFile.modifiedTime).getTime(),
      })), sortCriterion);
    }

    // Safeguard: Deletion Protection Guard (Agrupar borrados por raíz para no bloquear carpetas individuales)
    const deletionsCount = plan.deleteLocal.length + plan.deleteRemote.length;
    const totalKnownFiles = dbStateForPlan.size;
    const conflictId = `mass_del_${pair.id}`;

    const topLevelDeletedRoots = new Set<string>();
    for (const del of [...plan.deleteLocal, ...plan.deleteRemote]) {
      const rootSegment = del.localPath.split('/')[0];
      topLevelDeletedRoots.add(rootSegment);
    }

    const isMassDeletion = totalKnownFiles > 10 && (
      deletionsCount > 50 ||
      (deletionsCount / totalKnownFiles > 0.30)
    );

    if (isMassDeletion) {
      const existingConflict = this.pendingConflicts.find(c => c.id === conflictId);
      if (existingConflict) {
        this.logger.info(`[SafetyGuard] Borrado masivo para ${pair.id} ya registrado previamente. Esperando resolución del usuario.`);
        return false;
      }

      this.logger.warn(`[SafetyGuard] Intento de borrado masivo detectado en ${pair.id} (${deletionsCount}/${totalKnownFiles}). Registrando conflicto interactivo.`);
      this.pendingConflicts.push({
        id: conflictId,
        pairId: pair.id,
        localPath: relativePrefix || '.',
        relativePath: relativePrefix || '.',
        remoteFileId: '',
        remoteFileName: 'BORRADO_MASIVO_DETECTADO',
        reason: 'MASS_DELETION_APPROVAL_REQUIRED',
        baseHash: null, localHash: null, remoteHash: null,
        localSize: null, localMtime: 0, remoteSize: null, remoteMtime: 0,
        resolved: false, timestamp: Date.now()
      });
      return false;
    }

    for (const [baseName, state] of tombstonesToWrite) {
      this.db.setFileState(pair.id, getRelPath(baseName), state);
      this.logger.debug(`[SyncEngine] Remote file ${baseName} (id: ${state.remote_id}) was deleted remotely. Marking as tombstone locally.`);
    }

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

    // Procesar movimientos y renombres atómicos (Zero-Byte Transfers)
    if (plan.moves && plan.moves.length > 0) {
      for (const move of plan.moves) {
        checkInterrupt();
        try {
          const parentDir = path.dirname(move.newLocalPath);
          const relParentDir = parentDir === '.' ? '' : parentDir;
          const newParentFolderId = await this.ensureRemoteFolderPath(pair, relParentDir);

          const movedFile = await this.moveDriveFile(move.remoteId, newParentFolderId, move.newName);
          const fullNewLocalPath = path.join(localDir, move.newLocalPath);
          const stats = await fs.stat(fullNewLocalPath);

          this.db.setFileState(pair.id, move.newLocalPath, {
            pair_id: pair.id,
            rel_path: move.newLocalPath,
            remote_id: move.remoteId,
            local_mtime: stats.mtimeMs,
            remote_mtime: new Date(movedFile.modifiedTime).getTime(),
            file_size: stats.size,
            md5_hash: movedFile.md5Checksum || null,
            block_hashes: null,
            vector_clock: move.vectorClock,
            device_id: this.DEVICE_ID!,
            etag: null,
            updated_at: Date.now(),
            is_tombstone: 0
          });

          this.db.setFileState(pair.id, move.oldLocalPath, {
            pair_id: pair.id,
            rel_path: move.oldLocalPath,
            remote_id: null,
            local_mtime: Date.now(),
            remote_mtime: null,
            file_size: null,
            md5_hash: null,
            block_hashes: null,
            vector_clock: '{}',
            device_id: this.DEVICE_ID!,
            etag: null,
            updated_at: Date.now(),
            is_tombstone: 1
          });

          this.logger.info(`[SyncEngine] Movimiento atómico completado en Drive (0.2s): ${move.oldLocalPath} ➔ ${move.newLocalPath}`);
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
            filename: move.newName, action: 'uploaded', timestamp: Date.now(),
            details: `Movido/Renombrado en Drive instantáneamente (0 bytes transferidos)`
          }, true);
        } catch (e: any) {
          this.logger.error(`Error procesando movimiento atómico para ${move.oldLocalPath}:`, e?.message || e);
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

        let activeFileTransferred = 0;
        const transferKey = `${pair.id}:${upload.localPath}`;
        this.activeTransfers.add(transferKey);
        try {
          const uploadedFile = await this.uploadDriveBinary(
            remoteFolderId, fullLocalPath, upload.remoteName, upload.remoteId, upload.vectorClock, operationId,
            (loadedChunkBytes) => {
              if (pair.progress) {
                this.activeTransferProgress.set(transferKey, Math.min(loadedChunkBytes, stats.size));
                const currentActiveTotal = Array.from(this.activeTransferProgress.entries())
                  .filter(([k]) => k.startsWith(`${pair.id}:`))
                  .reduce((sum, [, bytes]) => sum + bytes, 0);
                pair.progress.bytesTransferred = Math.min((this.completedBytesByPair[pair.id] || 0) + currentActiveTotal, pair.progress.totalBytes);
                if (pair.progress.totalBytes > 0) {
                  pair.progress.percentage = Math.min(99, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100));
                } else {
                  pair.progress.percentage = 0;
                }
              }
            },
            pair.id
          );

          this.completedBytesByPair[pair.id] = (this.completedBytesByPair[pair.id] || 0) + stats.size;
          upload.remoteId = uploadedFile.id;
          (upload as any).remoteMtime = new Date(uploadedFile.modifiedTime).getTime();
          (upload as any).remoteSize = uploadedFile.size ? parseInt(uploadedFile.size, 10) : stats.size;
          (upload as any).remoteMd5 = uploadedFile.md5Checksum || null;
          (upload as any).localMtime = stats.mtimeMs;

          uploadCommits.push({ journalId, operationId });
          completedUploads.add(upload.localPath);
          if (pair.progress) {
            pair.progress.currentFileIndex = Math.min((pair.progress.currentFileIndex || 0) + 1, pair.progress.totalFiles);
            pair.progress.bytesTransferred = Math.min(this.completedBytesByPair[pair.id] || 0, pair.progress.totalBytes);
          }

          this.addEvent({
            id: Math.random().toString(36).substr(2, 9),
            pairId: pair.id,
            filename: upload.remoteName,
            action: 'uploaded',
            timestamp: Date.now(),
            size: stats.size,
            webViewLink: uploadedFile.webViewLink,
            details: `Subido a Google Drive (${formatBytes(stats.size)})`
          }, true);
        } finally {
          this.activeTransferProgress.delete(transferKey);
          this.activeTransfers.delete(transferKey);
        }
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
      const fileSize = download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : 0;

      if (pair.progress) {
        pair.progress.currentFile = download.remoteFile.name;
        pair.progress.action = 'descargando';
      }

      try {
        const transferKey = `${pair.id}:${download.localPath}`;
        this.activeTransfers.add(transferKey);
        let activeFileTransferred = 0;
        if (!download.remoteFile.id || !download.remoteFile.id.trim()) {
          this.logger.warn(`[Transfer] Omitiendo descarga para '${relPath}': fileId remoto vacío.`);
          this.activeTransfers.delete(transferKey);
          return;
        }
        try {
          await this.downloadDriveBinary(
            download.remoteFile.id,
            fullLocalPath,
            download.remoteFile.modifiedTime,
            pair.id,
            download.remoteFile.md5Checksum,
            fileSize,
            (loadedChunkBytes) => {
              if (pair.progress) {
                this.activeTransferProgress.set(transferKey, fileSize > 0 ? Math.min(loadedChunkBytes, fileSize) : loadedChunkBytes);
                const currentActiveTotal = Array.from(this.activeTransferProgress.entries())
                  .filter(([k]) => k.startsWith(`${pair.id}:`))
                  .reduce((sum, [, bytes]) => sum + bytes, 0);
                pair.progress.bytesTransferred = Math.min((this.completedBytesByPair[pair.id] || 0) + currentActiveTotal, pair.progress.totalBytes > 0 ? pair.progress.totalBytes : currentActiveTotal);
                
                if (pair.progress.totalBytes > 0) {
                  pair.progress.percentage = Math.min(99, Math.round((pair.progress.bytesTransferred / pair.progress.totalBytes) * 100));
                } else {
                  pair.progress.percentage = 0;
                }
              }
            }
          );
        } finally {
          this.activeTransferProgress.delete(transferKey);
          this.activeTransfers.delete(transferKey);
        }

        const downloadedStats = await fs.stat(fullLocalPath);
        downloadedLocalMtimes.set(download.localPath, downloadedStats?.mtimeMs ?? Date.now());
        this.completedBytesByPair[pair.id] = (this.completedBytesByPair[pair.id] || 0) + fileSize;

        downloadCommits.push({ journalId, operationId });
        completedDownloads.add(download.localPath);
        if (pair.progress) {
          pair.progress.currentFileIndex = Math.min((pair.progress.currentFileIndex || 0) + 1, pair.progress.totalFiles);
          pair.progress.bytesTransferred = Math.min(this.completedBytesByPair[pair.id] || 0, pair.progress.totalBytes);
        }
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9),
          pairId: pair.id,
          filename: download.remoteFile.name,
          action: 'downloaded',
          timestamp: Date.now(),
          size: downloadedStats.size,
          webViewLink: (download.remoteFile as any).webViewLink,
          details: `Descargado a disco local (${formatBytes(downloadedStats.size)})`
        }, true);
      } catch (e: any) {
        if (e instanceof FileNotFoundError) {
          db.journalDone(journalId);
          if (operationId) db.updateOperation(operationId, {
            status: 'done', last_error: null, updated_at: Date.now(),
          });
          db.setFileState(pair.id, relPath, {
            pair_id: pair.id, rel_path: relPath, remote_id: null,
            local_mtime: Date.now(), remote_mtime: null, file_size: null, md5_hash: null,
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

    // FIX DE RAÍZ: Liberar el archivo del progreso al terminar la transmisión de bytes
    if (pair.progress && pair.progress.bytesTransferred >= pair.progress.totalBytes && pair.progress.totalBytes > 0) {
      pair.progress.action = 'comprobando';
      pair.progress.currentFile = 'Verificando subdirectorios...';
      pair.progress.percentage = 99;
    }

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
        await fs.rm(fullLocalPath, { recursive: true, force: true });
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
        if (!del.remoteId) {
          this.db.journalDone(journalId);
          completedDeletesRemote.add(del.localPath);
          continue;
        }
        await this.deleteDriveFile(del.remoteId, remoteFolderId);
        this.invalidatePairRootCache(pair.id);
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
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null, local_mtime: now, remote_mtime: null,
        file_size: null, md5_hash: null, block_hashes: null, vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null,
        updated_at: now, is_tombstone: 1
      });
    }

    for (const del of plan.deleteRemote) {
      if (!completedDeletesRemote.has(del.localPath)) continue;
      updates.set(getRelPath(del.localPath), {
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null, local_mtime: now, remote_mtime: null,
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
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        this.logger.info(`[SyncEngine] La carpeta local ${localDir} ya no existe en disco. Sincronización de borrado continua.`);
        return true;
      }
      this.logger.error(`Could not read local directory ${localDir}; retaining pending work:`, error instanceof Error ? error.message : String(error));
      return false;
    }
    checkInterrupt();
    const dirNames = new Set<string>();
    for (const dir of localDirs) {
      if (dir.isDirectory() && !dir.isSymbolicLink() && !matchesIgnorePattern(dir.name, this.settings.ignoredPatterns)) {
        dirNames.add(dir.name);
      }
    }
    for (const dir of remoteFiles) {
      if (dir.mimeType === 'application/vnd.google-apps.folder' && !matchesIgnorePattern(dir.name, this.settings.ignoredPatterns)) {
        dirNames.add(dir.name);
      }
    }
    // Incluir carpetas registradas en SQLite para poder limpiar carpetas huérfanas
    for (const [baseName, state] of dirDbState) {
      if (state.remote_id && !state.is_tombstone && (state.file_size === null || state.file_size === 0) && !state.md5_hash) {
        dirNames.add(baseName);
      }
    }

    for (const dirName of dirNames) {
      if ((pair.status as string) === 'paused') return false;
      checkInterrupt();
      const subDir = path.join(localDir, dirName);
      const subPrefix = getRelPath(dirName);
      const subRemoteFolder = subDirs.find(d => normalizeNFC(d.name) === normalizeNFC(dirName));
      const existsLocally = localDirs.some(d => d.isDirectory() && normalizeNFC(d.name) === normalizeNFC(dirName));
      const folderState = this.db.getFileState(pair.id, subPrefix);

      // Comprobar si la carpeta o alguno de sus subarchivos pertenecían a la BD local
      const hasChildrenInDb = Boolean(folderMap.get(subPrefix) && folderMap.get(subPrefix)!.size > 0);
      const isLocalFolderDeletion = !existsLocally && (hasChildrenInDb || (folderState && folderState.is_tombstone !== 1));

      // CASO A: Borrado local de carpeta que existe en Google Drive
      if (subRemoteFolder && isLocalFolderDeletion) {
        if (pair.direction === 'download') {
          this.logger.info(`[SyncEngine] Carpeta local '${subPrefix}' fue eliminada en modo 'download'. Recreando carpeta desde Drive...`);
          this.markSelfWritten(subDir);
          await fs.mkdir(subDir, { recursive: true }).catch(() => {});
        } else {
          this.logger.info(`[SyncEngine] Carpeta local '${subPrefix}' fue eliminada. Borrando en Google Drive...`);
          try {
            await this.deleteDriveFile(subRemoteFolder.id, remoteFolderId);
            this.invalidatePairRootCache(pair.id);

            const prefix = subPrefix + '/';
            const folderStateMap = this.db.getFolderState(pair.id);
            for (const [childPath, childState] of folderStateMap) {
              if (childPath === subPrefix || childPath.startsWith(prefix)) {
                this.db.setFileState(pair.id, childPath, {
                  ...childState,
                  is_tombstone: 1,
                  updated_at: now,
                  local_mtime: now
                });
              }
            }

            this.addEvent({
              id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
              filename: dirName, action: 'deleted', timestamp: Date.now(), details: 'Carpeta eliminada en Drive'
            }, true);
          } catch (error) {
            this.logger.error(`[SyncEngine] Falló el borrado de la carpeta remota ${subPrefix}:`, error instanceof Error ? error.message : String(error));
            hadFailures = true;
          }
          continue;
        }
      }

      // CASO B: Carpeta no existe localmente ni en Drive pero sigue viva en SQLite
      if (!subRemoteFolder && !existsLocally && (hasChildrenInDb || folderState)) {
        const prefix = subPrefix + '/';
        const folderStateMap = this.db.getFolderState(pair.id);
        for (const [childPath, childState] of folderStateMap) {
          if (childPath === subPrefix || childPath.startsWith(prefix)) {
            this.db.setFileState(pair.id, childPath, {
              ...childState,
              is_tombstone: 1,
              updated_at: now
            });
          }
        }
        continue;
      }

      // CASO C: Carpeta existe en Drive y se mantiene o descarga localmente
      if (subRemoteFolder) {
        if (!existsLocally) {
          if (pair.direction === 'upload') {
            this.logger.debug(`[SyncEngine] Omitiendo creación de carpeta local '${subPrefix}' por estar en modo 'upload'.`);
            continue;
          }
          this.markSelfWritten(subDir);
          try {
            await fs.mkdir(subDir, { recursive: true });
          } catch (error) {
            this.logger.error(`Could not create local directory ${subDir}:`, error);
            continue;
          }
        }

        this.db.setFileState(pair.id, subPrefix, {
          pair_id: pair.id,
          rel_path: subPrefix,
          remote_id: subRemoteFolder.id,
          local_mtime: Date.now(),
          remote_mtime: new Date(subRemoteFolder.modifiedTime || Date.now()).getTime(),
          file_size: null,
          md5_hash: null,
          block_hashes: null,
          vector_clock: '{}',
          device_id: deviceId,
          etag: null,
          updated_at: now,
          is_tombstone: 0,
        });

        const childCompleted = await this.v2SyncDirectoryTree(subDir, subRemoteFolder.id, pair, subPrefix, folderMap, tracker);
        if (!childCompleted) hadFailures = true;
      } else if (existsLocally) {
        if (folderState && folderState.remote_id && folderState.is_tombstone !== 1) {
          const isDeleted = await this.checkIfRemoteFolderDeleted(folderState.remote_id);
          if (isDeleted) {
            this.logger.info(`[SyncEngine] Remote folder ${subPrefix} (id: ${folderState.remote_id}) was verified as deleted on Google Drive. Deleting local directory.`);
            this.markSelfWritten(subDir);
            try {
              await fs.rm(subDir, { recursive: true, force: true });
            } catch (e) {
              this.logger.error(`[SyncEngine] Failed to delete local folder ${subDir}:`, e instanceof Error ? e.message : String(e));
            }
            this.db.setFileState(pair.id, subPrefix, {
              ...folderState,
              is_tombstone: 1,
              updated_at: now,
            });
            this.addEvent({
              id: Math.random().toString(36).substr(2, 9),
              pairId: pair.id,
              filename: dirName,
              action: 'deleted',
              timestamp: Date.now(),
              details: 'Eliminado en Drive',
            }, true);
          } else {
            // FIX: Continuar sincronización dentro del subdirectorio usando su remote_id existente
            this.logger.info(`[SyncEngine] Sincronizando subdirectorio existente ${subPrefix}...`);
            const childCompleted = await this.v2SyncDirectoryTree(subDir, folderState.remote_id, pair, subPrefix, folderMap);
            if (!childCompleted) hadFailures = true;
          }
        } else {
          if (pair.direction === 'download') {
            this.logger.debug(`[SyncEngine] Omitiendo creación de carpeta remota '${subPrefix}' en Drive por estar en modo 'download'.`);
            continue;
          }
          this.logger.info(`[SyncEngine] Creating remote folder in Google Drive for local directory ${subPrefix}...`);
          try {
            const createdFolder = await this.createDriveFolder(remoteFolderId, dirName);
            this.db.setFileState(pair.id, subPrefix, {
              pair_id: pair.id,
              rel_path: subPrefix,
              remote_id: createdFolder.id,
              local_mtime: Date.now(),
              remote_mtime: new Date(createdFolder.modifiedTime || Date.now()).getTime(),
              file_size: null,
              md5_hash: null,
              block_hashes: null,
              vector_clock: '{}',
              device_id: deviceId,
              etag: null,
              updated_at: now,
              is_tombstone: 0,
            });
            const childCompleted = await this.v2SyncDirectoryTree(subDir, createdFolder.id, pair, subPrefix, folderMap);
            if (!childCompleted) hadFailures = true;
          } catch (err: any) {
            if (err instanceof Error && err.message === this.WEBHOOK_INTERRUPT) {
              throw err;
            }
            if (err instanceof Error && (err.message.includes('404') || err.message.includes('File not found'))) {
              this.logger.warn(`[SyncEngine] 404 detectado al crear carpeta ${subPrefix}. Re-resolviendo padre y reintentando...`);
              this.pairRootRemoteFolderCache.delete(pair.id);
              try {
                const freshParentId = await this.ensureRemoteFolderPath(pair, relativePrefix);
                const createdFolder = await this.createDriveFolder(freshParentId, dirName);
                this.db.setFileState(pair.id, subPrefix, {
                  pair_id: pair.id,
                  rel_path: subPrefix,
                  remote_id: createdFolder.id,
                  local_mtime: Date.now(),
                  remote_mtime: new Date(createdFolder.modifiedTime || Date.now()).getTime(),
                  file_size: null,
                  md5_hash: null,
                  block_hashes: null,
                  vector_clock: '{}',
                  device_id: deviceId,
                  etag: null,
                  updated_at: now,
                  is_tombstone: 0,
                });
                const childCompleted = await this.v2SyncDirectoryTree(subDir, createdFolder.id, pair, subPrefix, folderMap);
                if (!childCompleted) hadFailures = true;
              } catch (retryErr) {
                this.logger.error(`[SyncEngine] Reintento de creación de carpeta remota falló para ${subPrefix}:`, retryErr);
                hadFailures = true;
              }
            } else {
              this.logger.error(`[SyncEngine] Failed to create remote folder for ${subPrefix}:`, err instanceof Error ? err.message : String(err));
              hadFailures = true;
            }
          }
        }
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
        await this.refreshAccessToken().catch(() => false);
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
      url.searchParams.append('supportsAllDrives', 'true');
      url.searchParams.append('includeItemsFromAllDrives', 'true');
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
    // Marcar timestamp para activar la ventana de inmunidad
    for (const pair of this.pairs) {
      this.lastLocalMutationTime[pair.id] = Date.now();
    }
    try {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('fields', 'id,name,mimeType,modifiedTime,webViewLink,appProperties');
      url.searchParams.append('supportsAllDrives', 'true');
      const res = await this.driveRequest(url.toString(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
          appProperties: { syncclient_device_id: this.DEVICE_ID || '' }
        })
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
    for (const pair of this.pairs) {
      this.lastLocalMutationTime[pair.id] = Date.now();
    }
    const res = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    await this.handleDriveResponse(res);
  }

  private async moveDriveFile(fileId: string, newParentId: string, newName: string): Promise<DriveFile> {
    const fileRes = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`, {});
    await this.handleDriveResponse(fileRes);
    const fileData: any = await fileRes.json();
    const oldParents = (fileData.parents || []).join(',');

    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.append('addParents', newParentId);
    if (oldParents) url.searchParams.append('removeParents', oldParents);
    url.searchParams.append('supportsAllDrives', 'true');
    url.searchParams.append('fields', 'id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink');

    const res = await this.driveRequest(url.toString(), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    await this.handleDriveResponse(res);
    return (await res.json()) as DriveFile;
  }

  private async downloadDriveBinary(
    fileId: string,
    destPath: string,
    modifiedTime: string,
    pairId?: string,
    expectedMd5?: string,
    expectedSize?: number,
    onProgress?: (loaded: number, total?: number) => void
  ): Promise<void> {
    if (!fileId || !fileId.trim()) {
      this.logger.warn(`[SyncEngine] Omitiendo descarga para '${destPath}': el fileId remoto está vacío o es nulo.`);
      throw new FileNotFoundError(`Cannot download '${destPath}': remote fileId is empty`);
    }

    this.logger.info(`Iniciando descarga binaria para fileId: ${fileId} en: ${destPath}`);
    const effectiveDest = (pairId && this.getPairById(pairId) && this.isPairEncrypted(this.getPairById(pairId)!))
      ? destPath + '.syncclient-enc-tmp'
      : destPath;
    await downloadToAtomicFile({
      sourceUrl: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true`,
      destinationPath: effectiveDest,
      modifiedTime,
      expectedMd5,
      expectedSize,
      client: this.transferClient(),
      markSelfWritten: filePath => this.markSelfWritten(filePath),
      onProgress,
    });

    if (pairId && effectiveDest !== destPath) {
      const pair = this.getPairById(pairId);
      if (pair && this.isPairEncrypted(pair)) {
        const password = await this.getPairEncryptionPassword(pairId);
        if (password) {
          try {
            await decryptFile(effectiveDest, destPath, password);
            await fs.rm(effectiveDest, { force: true });
            if (modifiedTime) {
              const mtime = new Date(modifiedTime);
              await fs.utimes(destPath, mtime, mtime);
            }
          } catch (err) {
            this.logger.error(`[Encryption] Fallo al desencriptar ${destPath}:`, err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
      }
    }
  }

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string, vectorClock?: string, operationId?: string | null, onProgress?: (loaded: number, total: number) => void, pairId?: string): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    const name = targetName || path.basename(filePath);
    let effectivePath = filePath;
    let effectiveSize = (await fs.stat(filePath)).size;

    if (pairId) {
      const pair = this.getPairById(pairId);
      if (pair && this.isPairEncrypted(pair)) {
        const password = await this.ensureEncryptionKey(pairId);
        const tempPath = filePath + '.syncclient-enc-tmp';
        await encryptFile(filePath, tempPath, password);
        effectivePath = tempPath;
        effectiveSize = encryptedSize(effectiveSize);
      }
    }

    let mimeType = 'application/octet-stream';
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.djvu') mimeType = 'image/vnd.djvu';
    else if (ext === '.epub') mimeType = 'application/epub+zip';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.txt') mimeType = 'text/plain';

    const appProperties: Record<string, string> = { syncclient_device_id: this.DEVICE_ID || '' };
    if (vectorClock) {
      Object.assign(appProperties, VectorClockManager.toAppProperties(VectorClockManager.fromString(vectorClock)));
    }
    const metadata = existingFileId ? { name, appProperties } : { name, parents: [parentId], appProperties };
    const initUrl = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink&supportsAllDrives=true`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink&supportsAllDrives=true';

    if (effectiveSize > RESUMABLE_UPLOAD_THRESHOLD) {
      const client = this.transferClient();
      const resumableOperationId = operationId ?? `upload:${filePath}:${effectiveSize}`;
      const session = this.db && operationId ? this.db.getUploadSession(operationId) : null;
      try {
        const uploaded = await uploadResumableFile({
          filePath: effectivePath,
          fileSize: effectiveSize,
          operationId: resumableOperationId,
          remoteId: existingFileId ?? null,
          session,
          client,
          onProgress,
          createSession: async () => {
            const response = await requestTransfer(
              client,
              initUrl,
              () => ({
                method: existingFileId ? 'PATCH' : 'POST',
                headers: {
                  'Content-Type': 'application/json; charset=UTF-8',
                  'X-Upload-Content-Type': mimeType,
                  'X-Upload-Content-Length': String(effectiveSize),
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
      } finally {
        if (effectivePath !== filePath) {
          await fs.rm(effectivePath, { force: true });
        }
      }
    }

    const boundary = '-------SyncClientBoundary' + Math.random().toString(36);
    const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink&supportsAllDrives=true`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink&supportsAllDrives=true';

    const res = await this.driveRequestFactory(
      url,
      () => {
        const fileStream = fsSync.createReadStream(effectivePath);
        const bodyPayload = Readable.from((async function* () {
          yield header;
          for await (const chunk of fileStream) {
            yield chunk;
          }
          yield footer;
        })());
        return {
          method: existingFileId ? 'PATCH' : 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(header.length + effectiveSize + footer.length),
          },
          body: bodyPayload as any,
          duplex: 'half'
        };
      },
      this.DRIVE_MAX_ATTEMPTS
    );

    if (res.status === 404 && existingFileId) {
      this.logger.warn(`[SyncEngine/Upload] Remote fileId ${existingFileId} no encontrado en Drive (404). Reintentando creación como archivo nuevo.`);
      if (effectivePath !== filePath) {
        await fs.rm(effectivePath, { force: true });
      }
      return this.uploadDriveBinary(parentId, filePath, targetName, undefined, vectorClock, operationId, onProgress, pairId);
    }
    await this.handleDriveResponse(res);
    onProgress?.(effectiveSize, effectiveSize);
    if (effectivePath !== filePath) {
      await fs.rm(effectivePath, { force: true });
    }
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

    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
      this.logger.info('[SyncEngine] Scheduler de intervalos detenido.');
    }

    for (const pairId in this.webhookDebounceTimers) {
      clearTimeout(this.webhookDebounceTimers[pairId]);
    }
    this.webhookDebounceTimers = {};
    this.logger.info('[SyncEngine] Timers de webhook limpiados.');

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

  // --- Métodos de Ayuda para Capacidades Estilo FolderSync ---

  public getPairFilters(pairId: string): any[] {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return [];
    try {
      return rawDb.prepare('SELECT * FROM sync_pair_filters_v2 WHERE pair_id = ? ORDER BY id ASC').all(pairId);
    } catch {
      return [];
    }
  }

  public addPairFilter(pairId: string, filter: any): any {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    const stmt = rawDb.prepare(`
      INSERT INTO sync_pair_filters_v2 (pair_id, rule_type, string_value, numeric_value, numeric_value2, is_include, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      pairId,
      filter.rule_type,
      filter.string_value ?? null,
      typeof filter.numeric_value === 'number' ? filter.numeric_value : null,
      typeof filter.numeric_value2 === 'number' ? filter.numeric_value2 : null,
      filter.is_include ?? 0,
      filter.created_at || Date.now()
    );
    return { ...filter, id: res.lastInsertRowid };
  }

  public deletePairFilter(filterId: number): void {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    rawDb.prepare('DELETE FROM sync_pair_filters_v2 WHERE id = ?').run(filterId);
  }

  public getItemLogs(pairId: string, limit = 50, offset = 0): any[] {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return [];
    try {
      return rawDb.prepare(`
        SELECT * FROM sync_item_logs WHERE pair_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?
      `).all(pairId, limit, offset);
    } catch {
      return [];
    }
  }

  public getPairConditions(pairId: string): any | null {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return null;
    try {
      return rawDb.prepare('SELECT * FROM sync_pair_conditions_v2 WHERE pair_id = ?').get(pairId) || null;
    } catch {
      return null;
    }
  }

  public setPairConditions(conditions: any): any {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    const stmt = rawDb.prepare(`
      INSERT INTO sync_pair_conditions_v2 (pair_id, require_charging, require_wifi, min_battery_level, block_on_roaming, block_on_metered, require_vpn, allowed_ssids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET
        require_charging = excluded.require_charging,
        require_wifi = excluded.require_wifi,
        min_battery_level = excluded.min_battery_level,
        block_on_roaming = excluded.block_on_roaming,
        block_on_metered = excluded.block_on_metered,
        require_vpn = excluded.require_vpn,
        allowed_ssids = excluded.allowed_ssids
    `);
    stmt.run(
      conditions.pair_id,
      conditions.require_charging ?? 0,
      conditions.require_wifi ?? 0,
      conditions.min_battery_level ?? 0,
      conditions.block_on_roaming ?? 0,
      conditions.block_on_metered ?? 0,
      conditions.require_vpn ?? 0,
      conditions.allowed_ssids ?? null
    );
    return conditions;
  }

  public getWebhooks(pairId?: string): any[] {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return [];
    try {
      if (pairId) {
        return rawDb.prepare('SELECT * FROM sync_webhooks_v2 WHERE pair_id = ?').all(pairId);
      }
      return rawDb.prepare('SELECT * FROM sync_webhooks_v2').all();
    } catch {
      return [];
    }
  }

  public addWebhook(webhook: any): any {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    const stmt = rawDb.prepare(`
      INSERT INTO sync_webhooks_v2 (pair_id, target_url, event_trigger, is_active, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      webhook.pair_id,
      webhook.target_url,
      webhook.event_trigger || 'all',
      webhook.is_active ?? 1,
      webhook.created_at || Date.now()
    );
    return { ...webhook, id: res.lastInsertRowid };
  }

  public deleteWebhook(id: number): void {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    rawDb.prepare('DELETE FROM sync_webhooks_v2 WHERE id = ?').run(id);
  }

  public getPairSchedules(pairId: string): any[] {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return [];
    try {
      return rawDb.prepare('SELECT * FROM sync_pair_schedules WHERE pair_id = ? ORDER BY id ASC').all(pairId);
    } catch {
      return [];
    }
  }

  public addPairSchedule(pairId: string, schedule: any): any {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    const stmt = rawDb.prepare(`
      INSERT INTO sync_pair_schedules (pair_id, name, interval_minutes, enabled, require_charging, require_wifi, min_battery_level, block_on_roaming, block_on_metered, require_vpn, allowed_ssids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      pairId,
      schedule.name || 'Schedule',
      schedule.interval_minutes ?? 60,
      schedule.enabled ?? 1,
      schedule.require_charging ?? 0,
      schedule.require_wifi ?? 0,
      schedule.min_battery_level ?? 0,
      schedule.block_on_roaming ?? 0,
      schedule.block_on_metered ?? 0,
      schedule.require_vpn ?? 0,
      schedule.allowed_ssids || null,
      schedule.created_at || Date.now()
    );
    return { ...schedule, id: res.lastInsertRowid, pair_id: pairId };
  }

  public updatePairSchedule(schedule: any): any {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    const stmt = rawDb.prepare(`
      UPDATE sync_pair_schedules SET
        name = ?, interval_minutes = ?, enabled = ?, require_charging = ?, require_wifi = ?, min_battery_level = ?,
        block_on_roaming = ?, block_on_metered = ?, require_vpn = ?, allowed_ssids = ?
      WHERE id = ? AND pair_id = ?
    `);
    stmt.run(
      schedule.name,
      schedule.interval_minutes,
      schedule.enabled ? 1 : 0,
      schedule.require_charging ? 1 : 0,
      schedule.require_wifi ? 1 : 0,
      schedule.min_battery_level ?? 0,
      schedule.block_on_roaming ? 1 : 0,
      schedule.block_on_metered ? 1 : 0,
      schedule.require_vpn ? 1 : 0,
      schedule.allowed_ssids || null,
      schedule.id,
      schedule.pair_id
    );
    return schedule;
  }

  public deletePairSchedule(scheduleId: number): void {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) throw new Error('Base de datos no inicializada');
    rawDb.prepare('DELETE FROM sync_pair_schedules WHERE id = ?').run(scheduleId);
  }

  public async evaluateSchedules() {
    const rawDb = (this.db as any)?.db;
    if (!rawDb) return;
    try {
      const schedules = rawDb.prepare('SELECT * FROM sync_pair_schedules WHERE enabled = 1').all();
      for (const schedule of schedules) {
        const pair = this.pairs.find(p => p.id === schedule.pair_id);
        if (!pair || pair.status === 'syncing' || pair.status === 'paused') continue;

        const now = Date.now();
        const lastSynced = pair.lastSynced || 0;
        const intervalMs = (schedule.interval_minutes || 60) * 60 * 1000;
        if (now - lastSynced < intervalMs) continue;

        const systemStatus = await this.readSystemStatus();
        const conditionResult = ConditionEvaluator.evaluate(schedule, systemStatus, false);
        if (!conditionResult.canSync) {
          this.logger.info(`[Schedule] pair=${pair.id} omitido por schedule: ${conditionResult.reason}`);
          continue;
        }

        this.logger.info(`[Schedule] Disparando sync para pair=${pair.id} por schedule`);
        this.triggerSync(pair.id);
      }
    } catch (err) {
      this.logger.error('[Schedule] Error evaluando schedules:', err instanceof Error ? err.message : String(err));
    }
  }

  public async getPairEncryptionPassword(pairId: string): Promise<string | null> {
    const stored = await SecureStore.get(`encryption:password:${pairId}`);
    return stored;
  }

  public async setPairEncryptionPassword(pairId: string, password: string): Promise<void> {
    await SecureStore.set(`encryption:password:${pairId}`, password);
  }

  public async removePairEncryptionPassword(pairId: string): Promise<void> {
    await SecureStore.remove(`encryption:password:${pairId}`);
  }

  public async ensureEncryptionKey(pairId: string): Promise<string> {
    let password = await this.getPairEncryptionPassword(pairId);
    if (!password) {
      password = crypto.randomBytes(32).toString('hex');
      await this.setPairEncryptionPassword(pairId, password);
      const rawDb = (this.db as any)?.db;
      if (rawDb) {
        const salt = deriveKey(password, crypto.randomBytes(16)).toString('hex');
        try {
          rawDb.prepare('INSERT OR REPLACE INTO sync_pair_encryption_keys (pair_id, salt, created_at) VALUES (?, ?, ?)').run(pairId, salt, Date.now());
        } catch { /* table may not exist yet */ }
      }
    }
    return password;
  }

  public isPairEncrypted(pair: { encryptionMode?: string }): boolean {
    return pair.encryptionMode === 'encrypted';
  }

  private getPairById(pairId: string) {
    return this.pairs.find(p => p.id === pairId);
  }

  private mapErrorToGranularStatus(err: unknown): SyncStatus {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes('enomem') || msg.includes('no space') || msg.includes('not enough space') || msg.includes('disk quota exceeded')) {
      return 'sync_failed_not_enough_space';
    }
    if (msg.includes('eacces') || msg.includes('eperm') || msg.includes('permission denied') || msg.includes('write permission')) {
      return 'sync_failed_missing_write_permission';
    }
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('esockettimeout')) {
      return 'sync_failed_timeout';
    }
    if (msg.includes('roaming') || msg.includes('block_on_roaming')) {
      return 'sync_failed_is_roaming';
    }
    if (msg.includes('metered') || msg.includes('block_on_metered')) {
      return 'sync_failed_metered_connection';
    }
    if (msg.includes('vpn') && msg.includes('required')) {
      return 'sync_failed_vpn_not_connected';
    }
    if (msg.includes('ssid') && msg.includes('not allowed')) {
      return 'sync_failed_ssid_not_allowed';
    }
    if (msg.includes('not charging') || msg.includes('charging required')) {
      return 'sync_failed_not_charging';
    }
    if (msg.includes('network') && msg.includes('illegal')) {
      return 'sync_failed_illegal_network_state';
    }
    if (msg.includes('no account') || msg.includes('not configured')) {
      return 'sync_failed_no_account_configured';
    }
    if (msg.includes('no file path') || msg.includes('path not configured')) {
      return 'sync_failed_no_file_path_configured';
    }
    return 'error';
  }
}

export const syncEngine = new SyncEngine();