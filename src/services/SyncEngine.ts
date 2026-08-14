import fs from 'fs/promises';
import fsSync from 'fs';
import { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import parcelWatcher, { AsyncSubscription } from '@parcel/watcher';
import { SyncPair, SyncEvent, SyncSettings, PendingConflict, ExternalDriveAlert } from '../types';
import { CoreSyncLogic, RemoteEntry, SyncStateSnapshot, DEFAULT_REMOTE_PATH } from '../shared/CoreSyncLogic';
import { USE_V2_SYNC, FileState, DriveCursor } from '../shared/schema';
import { IStorageBackend, createBackend } from '../shared/StorageBackend';
import { getOrCreateDeviceId } from '../shared/DeviceIdentity';
import { VectorClockManager } from '../shared/VectorClock';
import { runInPool } from '../shared/runInPool';
import { scanChanges } from '../shared/Scanner';
import { ExifDateExtractor } from '../shared/ExifDateExtractor';
import { SyncFilterEngine } from '../shared/SyncFilterEngine';
import { ConditionEvaluator } from '../shared/ConditionEvaluator';
import { NodeFileSystem } from '../utils/nodeFileSystem';

// --- Imports desde src/backend/ ---
import {
  downloadToAtomicFile,
  requestTransfer,
  RESUMABLE_UPLOAD_THRESHOLD,
  uploadResumableFile,
  type TransferHttpClient,
  FileNotFoundError
} from '../backend/transfer';

import { acquirePairLock, PairAlreadyRunningError, type PairLock } from '../backend/pairProcessLock';
import { DriveChangesIngestor, DriveCursorRescanRequiredError, type DriveChange } from '../backend/driveChanges';
import { Logger } from '../backend/logger';

import {
  INITIAL_POLL_INTERVAL_MS,
  SYNC_DEBOUNCE_MS,
  TRANSFER_CONCURRENCY,
  nextSyncBackoff,
  pollInterval,
  shouldSkipPoll,
} from '../backend/syncPerformance';

import { initializeApp, getApp, getApps } from 'firebase/app';
import { getDatabase, ref, onValue } from 'firebase/database';
import { getFirebaseClientConfig } from '../config/firebaseConfig';

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

function sanitizeLocalFilename(name: string): string {
  if (process.platform === 'win32') {
    return name.replace(/[<>:"/\\|?*]/g, '_');
  }
  return name.replace(/\//g, '_');
}

export const DRIVE_CHANGES_FEATURE_FLAG = 'SYNCCLIENT_DRIVE_CHANGES';

export function isDriveChangesFeatureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
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
    ignoredPatterns: [
      '.#*', '*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz',
      '*.synctex(busy)', '*.run.xml', '*.bcf*', '*.bbl*', '*.blg', '*.ind', '*.ilg', '*.idx',
      'auto', '*.minted', '_minted-*', '*.snm', '*.nav', '*.cwl', '*.conflict*', '*SAVE-ERROR*',
      '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp', '*.syncclient-download-*',
      '*.syncclient-tmp-*', '*.syncmeta', '__MACOSX', 'Thumbs.db', 'desktop.ini', '*.pyc',
      '__pycache__', '*.pyi', '.ttxfolder', '.venv', 'venv', 'env'
    ],
    autoStart: false,
    desktopNotifications: true
  };
  private readonly exifExtractor = new ExifDateExtractor();
  private readonly filterEngine = new SyncFilterEngine();

  private manifests: Record<string, Record<string, any>> = {};
  private pendingConflicts: PendingConflict[] = [];
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
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

  private watchers: Record<string, AsyncSubscription> = {};
  private syncTriggerSource: Record<string, 'manual' | 'poll' | 'webhook' | 'fs-event'> = {};
  private activeSyncs = new Set<string>();
  private pendingSyncs = new Set<string>();
  private pendingResync = new Set<string>();
  private activeTransfers = new Set<string>();
  private dedupCancelled = new Set<string>();
  private watcherRetryCount: Record<string, number> = {};
  private debounceTimers: Record<string, NodeJS.Timeout> = {};
  private pollingFallbackTimers: Record<string, NodeJS.Timeout> = {};
  private intervalRefs: Record<string, NodeJS.Timeout> = {};
  private detectedExternalDrives: ExternalDriveAlert[] = [];
  private externalMonitorInterval: NodeJS.Timeout | null = null;
  private driveFolderCache = new Map<string, { timestamp: number; files: DriveFile[] }>();

  // --- v2: Database & Identity ---
  private db: IStorageBackend | null = null;
  private DEVICE_ID: string | null = null;

  // --- Control de Abort y Cancelación por Red ---
  private abortControllers: Record<string, AbortController> = {};

  // --- Cache de auto-escrituras ampliada a 10,000 elementos con TTL ---
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
  private lastRecoveryAttempt: Record<string, number> = {};
  private lastLocalMutationTime: Record<string, number> = {};
  private readonly pendingLocalEvents: Record<string, { relPath: string; localEvent: 'create' | 'update' | 'delete' }[]> = {};
  private tokenRefreshPromise: Promise<boolean> | null = null;
  private pairRootRemoteFolderCache = new Map<string, string>();

  private ensureInterrupt(pairId: string): boolean {
    const now = Date.now();
    const last = this.lastInterruptTime[pairId] || 0;
    if (now - last < this.INTERRUPT_COOLDOWN_MS) return false;
    this.lastInterruptTime[pairId] = now;
    return true;
  }

  private markSelfWritten(filePath: string) {
    if (!filePath) return;
    const normalized = normalizeNFC(path.normalize(filePath));
    this.selfWrittenFiles.set(normalized, Date.now());
    if (this.selfWrittenFiles.size > 10000) {
      const now = Date.now();
      for (const [key, timestamp] of this.selfWrittenFiles.entries()) {
        if (now - timestamp > 30000) this.selfWrittenFiles.delete(key);
      }
    }
  }

  private isSelfWritten(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = normalizeNFC(path.normalize(filePath));
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

  constructor() {
    this.init();
  }

  private async init() {
    try {
      this.initializeOAuthCredentials();
      await fs.mkdir(this.configDir, { recursive: true });

      try {
        this.db = await createBackend(this.configDir);
        if (this.db) {
          const deviceResult = await getOrCreateDeviceId(this.db);
          this.DEVICE_ID = deviceResult.deviceId;
          this.logger.info(`v2 DB initialized, device: ${this.DEVICE_ID}`);
        }
      } catch (e: unknown) {
        this.logger.warn('[SyncEngine] DB init failed, using legacy config:', e instanceof Error ? e.message : String(e));
      }

      try {
        const data = await fs.readFile(this.configFile, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed.pairs) this.pairs = parsed.pairs;
        if (parsed.events) this.events = parsed.events.slice(0, 200);
        if (parsed.settings) {
          this.settings = parsed.settings;
          const defaultPatterns = this.settings.ignoredPatterns || [];
          const current = new Set(defaultPatterns);
          ['*.syncclient-download-*', '*.syncclient-tmp-*', '*.syncmeta'].forEach(p => current.add(p));
          this.settings.ignoredPatterns = Array.from(current);
        }
        if (parsed.pendingConflicts) this.pendingConflicts = parsed.pendingConflicts;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn('[SyncEngine] State file could not be loaded:', e instanceof Error ? e.message : String(e));
        }
      }

      if (this.pairs.length > 0) {
        let modified = false;
        this.pairs.forEach(p => {
          if (p.localPath.startsWith('~/')) {
            p.localPath = path.join(os.homedir(), p.localPath.slice(2));
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

  private async runInPool<T>(tasks: (() => Promise<T>)[], concurrency = 3): Promise<T[]> {
    return runInPool(tasks, concurrency);
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

        // Integración de AbortSignal para cancelación inmediata
        const controller = pairId ? this.abortControllers[pairId] : undefined;
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
          await response.body?.cancel();
          if (await this.refreshAccessToken()) {
            attempt--;
            continue;
          }
        }

        if (!(response.status === 429 || response.status >= 500 || isRateLimit) || attempt === maxAttempts) {
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

  private async driveRequest(url: string, init: RequestInit & { duplex?: 'half' }, maxAttempts = this.DRIVE_MAX_ATTEMPTS, pairId?: string): Promise<Response> {
    return this.driveRequestFactory(url, () => init, maxAttempts, pairId);
  }

  private transferClient(pairId?: string): TransferHttpClient {
    return {
      request: (url, init) => this.driveRequest(url, { ...init, signal: null }, 1, pairId),
      getAccessToken: () => this.accessToken,
      refreshAccessToken: () => this.refreshAccessToken(),
    };
  }

  private async recoverPendingWork(): Promise<void> {
    if (!this.db) return;

    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
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
      
      const pendingJournal = this.db!.getPendingJournalEntries(pair.id);
      for (const entry of pendingJournal) {
        if (entry.created_at < cutoff) {
          this.db!.journalFail(entry.id);
        }
      }

      const operations = this.db!.getRecoverableOperations(pair.id);
      const remainingJournal = this.db!.getPendingJournalEntries(pair.id);
      
      if (operations.length === 0 && remainingJournal.length === 0) continue;

      const detail = `Recovery queued: ${operations.length} operation(s), ${remainingJournal.length} pending journal entr${remainingJournal.length === 1 ? 'y' : 'ies'}`;
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

  public setToken(accessToken: string | null, refreshToken?: string | null) {
    const prev = this.accessToken;
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;

    if (accessToken && prev !== accessToken) {
      this.pairs.forEach(p => { if (p.status === 'unauthenticated') p.status = 'idle'; });
      this.triggerAllActive();
    }
    this.setupWebhooks();
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (this.tokenRefreshPromise) return this.tokenRefreshPromise;
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

      if (!res.ok && this.googleClientSecret) {
        const clone = res.clone();
        const errData = await clone.json().catch(() => ({}));
        if (errData.error === 'invalid_client') {
          res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: buildParams(false).toString(),
            signal: AbortSignal.timeout(15000),
          });
        }
      }

      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          this.refreshToken = null;
          this.accessToken = null;
        }
        return false;
      }

      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private startExternalDriveMonitor() {
    if (this.externalMonitorInterval) clearInterval(this.externalMonitorInterval);
    this.externalMonitorInterval = setInterval(async () => {
      const user = process.env.USER || process.env.LOGNAME || 'usuario';
      const mediaPaths = [`/media/${user}`, `/run/media/${user}`];

      // Limpieza de unidades desconectadas
      for (const drive of [...this.detectedExternalDrives]) {
        try {
          await fs.access(drive.path);
        } catch {
          this.detectedExternalDrives = this.detectedExternalDrives.filter(d => d.path !== drive.path);
        }
      }

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
        } catch (err: unknown) {
          this.logger.debug(`Error al escanear ruta de medio externo ${base}:`, err);
        }
      }
    }, 5000);
  }

  private async createWatcherForPair(pair: SyncPair): Promise<void> {
    try {
      const subscription = await parcelWatcher.subscribe(pair.localPath, (err, events) => {
        if (err) return;

        const relevantEvents = events.filter(evt => {
          if (evt.type as any === 'symbolicLink') return false; // Ignorar Symlinks
          const relPath = normalizeNFC(path.relative(pair.localPath, evt.path));
          const parts = relPath.split(path.sep);
          if (parts.some(p => p.startsWith('.') || matchesIgnorePattern(p, this.settings.ignoredPatterns))) return false;
          if (this.isSelfWritten(evt.path)) return false;
          return true;
        });

        if (relevantEvents.length === 0) return;

        // Si hay una sincronización activa: Encolar eventos locales sin abortar con interruptRequested
        if (this.activeSyncs.has(pair.id)) {
          const existing = this.pendingLocalEvents[pair.id] || [];
          const newEvents = relevantEvents.map(evt => ({
            relPath: normalizeNFC(path.relative(pair.localPath, evt.path)),
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
          const targetPaths = relevantEvents.map(evt => ({
            relPath: normalizeNFC(path.relative(pair.localPath, evt.path)),
            localEvent: evt.type as 'create' | 'update' | 'delete'
          }));
          this.fastSync(pair, targetPaths).catch(() => {
            this.syncTriggerSource[pair.id] = 'fs-event';
            this.triggerSync(pair.id);
          });
        }, SYNC_DEBOUNCE_MS);
      });

      this.watchers[pair.id] = subscription;
    } catch (err) {
      this.enablePollingFallback(pair.id);
    }
  }

  private enablePollingFallback(pairId: string) {
    if (this.pollingFallbackTimers[pairId]) return;
    this.pollingFallbackTimers[pairId] = setInterval(() => {
      const pair = this.pairs.find(p => p.id === pairId);
      if (!pair || (pair.status !== 'syncing' && pair.status !== 'idle')) return;
      this.syncTriggerSource[pairId] = 'poll';
      this.triggerSync(pairId);
    }, 30000);
  }

  private refreshWatchers() {
    this.pairs.forEach(pair => {
      const shouldWatch = (pair.status === 'syncing' || pair.status === 'idle') && !!pair.localPath;
      if (shouldWatch && !this.watchers[pair.id]) {
        this.createWatcherForPair(pair);
      } else if (!shouldWatch && this.watchers[pair.id]) {
        this.watchers[pair.id].unsubscribe().catch(() => { });
        delete this.watchers[pair.id];
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
            const currentPair = this.pairs.find(c => c.id === pair.id);
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

    let pairLock: PairLock | null = null;
    try {
      pairLock = await acquirePairLock(this.sharedPairLockDirectory(), pairId);
    } catch {
      return;
    }

    this.activeSyncs.add(pairId);
    this.abortControllers[pairId] = new AbortController();
    pair.status = 'syncing';
    pair.progress = { currentFile: 'Iniciando escaneo...', totalFiles: 0, currentFileIndex: 0, bytesTransferred: 0, totalBytes: 0, percentage: 0, action: 'comprobando' };

    this.runSync(pair, pairLock);
  }

  private async runSync(pair: SyncPair, pairLock: PairLock): Promise<void> {
    const pairId = pair.id;
    let driveChangeBatch: { pageToken: string; controlledRescan: boolean } | null = null;

    try {
      const remoteFolderId = await this.getPairRootRemoteFolderId(pair);
      await fs.mkdir(pair.localPath, { recursive: true });

      if ((USE_V2_SYNC || this.isDriveChangesEnabled()) && this.db && this.DEVICE_ID) {
        driveChangeBatch = await this.ingestDriveChanges(pair);
        const syncCompleted = await this.v2SyncDirectoryTree(pair.localPath, remoteFolderId, pair, '');
        if (syncCompleted && driveChangeBatch) {
          this.commitDriveChangesCursor(pair, driveChangeBatch.pageToken);
        }
      }

      pair.lastSynced = Date.now();
      pair.status = 'idle';

      if (pair.progress) {
        pair.progress.percentage = 100;
        pair.progress.action = 'completado';
        pair.progress.currentFile = 'Todo al día';
      }

      this.maybeVacuumDatabase();
      await this.saveState();
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'WEBHOOK_INTERRUPT') {
        this.logger.info(`[SyncEngine] pair=${pairId} interrumpido por cambio externo. Re-programando...`);
      } else if (err instanceof Error && err.message === 'UNAUTHORIZED_EXPIRED_TOKEN') {
        pair.status = 'unauthenticated';
      } else {
        pair.status = 'error';
      }
      pair.progress = null;
      await this.saveState();
    } finally {
      if (this.abortControllers[pairId]) {
        delete this.abortControllers[pairId];
      }
      try {
        await pairLock.release();
      } catch { }

      this.activeSyncs.delete(pairId);
      this.driveFolderCache.clear();
      delete this.interruptRequested[pairId];

      // Procesar eventos locales pendientes diferidos
      const pendingLocal = this.pendingLocalEvents[pairId];
      if (pendingLocal && pendingLocal.length > 0) {
        delete this.pendingLocalEvents[pairId];
        setTimeout(() => this.fastSync(pair, pendingLocal), 100);
      }

      this.lastSyncCompleted[pairId] = Date.now();
      this.syncBackoff[pairId] = INITIAL_POLL_INTERVAL_MS;

      if (this.pendingSyncs.has(pairId)) {
        this.pendingSyncs.delete(pairId);
        setTimeout(() => this.triggerSync(pairId), 1000);
      }
    }
  }

  // ─── FastSync con Respeto de PairLock y Validación MD5 ─────────

  public async fastSync(pair: SyncPair, targetPaths: { relPath: string; change?: DriveChange; localEvent?: 'create' | 'update' | 'delete' }[]) {
    if (!this.db || !this.accessToken) return;

    let pairLock: any = null;
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
      const sortedTargets = [...targetPaths].sort((a, b) => a.relPath.split(path.sep).length - b.relPath.split(path.sep).length);

      for (const { relPath, change, localEvent } of sortedTargets) {
        const canonicalRelPath = normalizeNFC(relPath);
        const lockKey = `${pair.id}:${canonicalRelPath}`;

        if (this.activeTransfers.has(lockKey)) continue;
        this.activeTransfers.add(lockKey);

        try {
          const fullLocalPath = path.join(pair.localPath, canonicalRelPath);

          if (change) {
            if (pair.direction === 'upload') {
              this.logger.debug(`[FastSync] Omitiendo cambio remoto en ${canonicalRelPath} por modo 'upload'.`);
              continue;
            }

            if (change.removed) {
              this.markSelfWritten(fullLocalPath);
              await fs.rm(fullLocalPath, { recursive: true, force: true }).catch(() => { });
              
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
              continue;
            }

            const remoteFile = change.file as unknown as DriveFile;
            if (remoteFile && remoteFile.mimeType === 'application/vnd.google-apps.folder') {
              this.markSelfWritten(fullLocalPath);
              await fs.mkdir(fullLocalPath, { recursive: true }).catch(() => { });
              continue;
            }

            const state = this.db.getFileState(pair.id, canonicalRelPath);

            if (state && remoteFile.md5Checksum && state.md5_hash === remoteFile.md5Checksum) {
              this.logger.debug(`[FastSync] ${canonicalRelPath} coincide en MD5 con Drive. Ignorando evento.`);
              continue;
            }

            this.logger.info(`[FastSync] Descargando actualización remota: ${canonicalRelPath}`);
            await this.downloadDriveBinary(remoteFile.id, fullLocalPath, remoteFile.modifiedTime, pair.id, remoteFile.md5Checksum);

            const newStat = await fs.stat(fullLocalPath);
            const currentClock = VectorClockManager.fromString(state?.vector_clock || '{}');
            const updatedClock = VectorClockManager.increment(currentClock, this.DEVICE_ID || 'desktop');
            this.db.setFileState(pair.id, canonicalRelPath, {
              pair_id: pair.id, rel_path: canonicalRelPath, remote_id: remoteFile.id,
              local_mtime: newStat.mtimeMs,
              remote_mtime: new Date(remoteFile.modifiedTime).getTime(),
              file_size: newStat.size, md5_hash: remoteFile.md5Checksum || null, block_hashes: null,
              vector_clock: JSON.stringify(updatedClock), device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
            });
          } else if (localEvent) {
            let localStat = null;
            try { localStat = await fs.stat(fullLocalPath); } catch { }

            if (localStat && localStat.isFile()) {
              const sanitizedName = sanitizeLocalFilename(path.basename(canonicalRelPath));
              const parentDir = path.dirname(canonicalRelPath);
              const remoteFolderId = await this.ensureRemoteFolderPath(pair, parentDir === '.' ? '' : parentDir);
              const state = this.db.getFileState(pair.id, canonicalRelPath);

              const uploadedFile = await this.uploadDriveBinary(
                remoteFolderId, fullLocalPath, sanitizedName, state?.remote_id || undefined, state?.vector_clock, pair.id, null
              );

              const updatedStat = await fs.stat(fullLocalPath);
              const currentClock = VectorClockManager.fromString(state?.vector_clock || '{}');
              const updatedClock = VectorClockManager.increment(currentClock, this.DEVICE_ID || 'desktop');
              this.db.setFileState(pair.id, canonicalRelPath, {
                pair_id: pair.id, rel_path: canonicalRelPath, remote_id: uploadedFile.id,
                local_mtime: updatedStat.mtimeMs,
                remote_mtime: new Date(uploadedFile.modifiedTime).getTime(),
                file_size: updatedStat.size, md5_hash: uploadedFile.md5Checksum || null, block_hashes: null,
                vector_clock: JSON.stringify(updatedClock), device_id: this.DEVICE_ID || '', etag: null, updated_at: Date.now(), is_tombstone: 0
              });
            }
          }
        } catch (err) {
          this.logger.error(`[FastSync] Error procesando ${canonicalRelPath}:`, err);
        } finally {
          this.activeTransfers.delete(lockKey);
        }
      }
    } finally {
      if (pairLock) {
        try { await pairLock.release(); } catch { }
      }
    }
  }

  // ─── v2: SyncDirectoryTree con Correcciones Completas ───────────

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
      pair.status = 'error';
      return false;
    }
    checkInterrupt();

    const remoteFiles = await this.listDriveFiles(remoteFolderId);
    checkInterrupt();

    if ((relativePrefix === '' || relativePrefix === '.') && remoteFiles.length === 0 && dirDbState.size > 5) {
      this.logger.warn(`[SyncEngine] Listado remoto devolvió 0 archivos para la raíz con ${dirDbState.size} registros en DB. Re-verificando ID de carpeta raíz...`);
      this.pairRootRemoteFolderCache.delete(pair.id);
      return false;
    }

    const getRelPath = (baseName: string): string => normalizeNFC(relativePrefix ? `${relativePrefix}/${baseName}` : baseName);

    const localSnapshot = new Map<string, { name: string; mtime: number; size: number; hash?: string }>();
    for (const [baseName, state] of dirDbState) {
      if (!state.is_tombstone && !scanResult.deleted.includes(baseName)) {
        if (matchesIgnorePattern(baseName, this.settings.ignoredPatterns)) continue;
        localSnapshot.set(baseName, { name: baseName, mtime: state.local_mtime || 0, size: state.file_size || 0 });
      }
    }

    for (const [baseName, entry] of scanResult.changed) {
      if (!matchesIgnorePattern(entry.name, this.settings.ignoredPatterns)) {
        localSnapshot.set(baseName, { name: entry.name, mtime: entry.mtime, size: entry.size, hash: entry.hash });
      }
    }

    const remoteSnapshot = new Map<string, RemoteEntry>();
    for (const file of remoteFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      if (file.mimeType.startsWith('application/vnd.google-apps.')) continue;
      const canonicalName = normalizeNFC(file.name);
      remoteSnapshot.set(canonicalName, {
        id: file.id, name: canonicalName, mimeType: file.mimeType, modifiedTime: file.modifiedTime,
        size: file.size, md5Checksum: file.md5Checksum, appProperties: file.appProperties, etag: undefined
      });
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

    // FIX: Salvaguarda de Borrado Masivo mediante pendiente interactivo
    const deletionsCount = plan.deleteLocal.length + plan.deleteRemote.length;
    const totalKnownFiles = dbStateForPlan.size;
    if (totalKnownFiles > 10 && (deletionsCount > 100 || (deletionsCount > 5 && deletionsCount / totalKnownFiles > 0.4))) {
      this.logger.warn(`[SafetyGuard] Intento de borrado masivo detectado en ${pair.id} (${deletionsCount}/${totalKnownFiles}). Requiere confirmación.`);
      this.pendingConflicts.push({
        id: `mass_del_${pair.id}_${Date.now()}`,
        pairId: pair.id, localPath: '.', relativePath: '.',
        remoteFileId: '', remoteFileName: 'MASS_DELETION',
        reason: 'MASS_DELETION_APPROVAL_REQUIRED', baseHash: null, localHash: null, remoteHash: null,
        localSize: null, localMtime: 0, remoteSize: null, remoteMtime: 0, resolved: false, timestamp: Date.now()
      });
      return false;
    }

    // FIX: BUG-03 Inicialización de Progreso Únicamente en Raíz
    let totalBytesToTransfer = 0;
    for (const dl of plan.downloads) totalBytesToTransfer += dl.remoteFile.size ? parseInt(dl.remoteFile.size, 10) : 0;
    for (const ul of plan.uploads) totalBytesToTransfer += localSnapshot.get(ul.localPath)?.size || 0;

    if (relativePrefix === '') {
      pair.progress = {
        currentFile: 'Sincronizando directorios...',
        totalFiles: plan.downloads.length + plan.uploads.length + plan.deleteLocal.length + plan.deleteRemote.length,
        totalBytes: totalBytesToTransfer,
        currentFileIndex: 0, bytesTransferred: 0, percentage: 0, action: 'comprobando'
      };
    } else if (pair.progress) {
      pair.progress.totalFiles += plan.downloads.length + plan.uploads.length;
      pair.progress.totalBytes += totalBytesToTransfer;
    }

    const completedUploads = new Set<string>();
    const completedDownloads = new Set<string>();
    const uploadCommits: Array<{ journalId: number; operationId: string | null }> = [];
    const downloadCommits: Array<{ journalId: number; operationId: string | null }> = [];

    const uploadTasks = plan.uploads.map(upload => async (): Promise<void> => {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, upload.localPath);
      const relPath = getRelPath(upload.localPath);
      const sanitizedName = sanitizeLocalFilename(upload.remoteName);

      const journalId = this.db!.journalStart(pair.id, 'upload_start', relPath, upload.remoteId);
      const operationId = `${pair.id}:upload:${relPath}:${Date.now()}`;

      try {
        const uploadedFile = await this.uploadDriveBinary(
          remoteFolderId, fullLocalPath, sanitizedName, upload.remoteId, upload.vectorClock, pair.id, operationId
        );

        const realStats = await fs.stat(fullLocalPath);
        (upload as any).remoteMtime = new Date(uploadedFile.modifiedTime).getTime();
        (upload as any).remoteSize = uploadedFile.size ? parseInt(uploadedFile.size, 10) : realStats.size;
        (upload as any).remoteMd5 = uploadedFile.md5Checksum || null;
        (upload as any).localMtime = realStats.mtimeMs; // FIX: mtime real

        uploadCommits.push({ journalId, operationId });
        completedUploads.add(upload.localPath);
      } catch (e) {
        this.db!.journalFail(journalId);
      }
    });

    await this.runInPool(uploadTasks, TRANSFER_CONCURRENCY);
    checkInterrupt();

    const downloadedLocalMtimes = new Map<string, number>();

    const downloadTasks = plan.downloads.map(download => async (): Promise<void> => {
      if ((pair.status as string) === 'paused') return;
      const fullLocalPath = path.join(localDir, download.localPath);
      const relPath = getRelPath(download.localPath);
      const journalId = this.db!.journalStart(pair.id, 'download_start', relPath, download.remoteFile.id);
      const operationId = `${pair.id}:download:${relPath}:${Date.now()}`;

      try {
        await this.downloadDriveBinary(download.remoteFile.id, fullLocalPath, download.remoteFile.modifiedTime, pair.id, download.remoteFile.md5Checksum);
        const downloadedStats = await fs.stat(fullLocalPath);
        downloadedLocalMtimes.set(download.localPath, downloadedStats.mtimeMs); // FIX: mtime real

        downloadCommits.push({ journalId, operationId });
        completedDownloads.add(download.localPath);
      } catch (e) {
        this.db!.journalFail(journalId);
      }
    });

    await this.runInPool(downloadTasks, TRANSFER_CONCURRENCY);
    checkInterrupt();

    const updates = new Map<string, FileState>();
    const now = Date.now();

    const completedDeletesLocal = new Set<string>();
    const completedDeletesRemote = new Set<string>();

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

          updates.set(getRelPath(move.newLocalPath), {
            pair_id: pair.id, rel_path: getRelPath(move.newLocalPath), remote_id: move.remoteId,
            local_mtime: stats.mtimeMs, remote_mtime: new Date(movedFile.modifiedTime).getTime(),
            file_size: stats.size, md5_hash: movedFile.md5Checksum || null, block_hashes: null,
            vector_clock: move.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
          });

          updates.set(getRelPath(move.oldLocalPath), {
            pair_id: pair.id, rel_path: getRelPath(move.oldLocalPath), remote_id: null,
            local_mtime: Date.now(), remote_mtime: null, file_size: null, md5_hash: null, block_hashes: null,
            vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 1
          });

          this.logger.info(`[SyncEngine] Movimiento atómico completado en Drive (0.2s): ${move.oldLocalPath} ➔ ${move.newLocalPath}`);
          this.addEvent({
            id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
            filename: move.newName, action: 'uploaded', timestamp: Date.now(),
            details: `Movido/Renombrado en Drive instantáneamente (0 bytes transferidos)`
          }, true);
        } catch (e: unknown) {
          this.logger.error(`Error procesando movimiento atómico para ${move.oldLocalPath}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    for (const del of plan.deleteLocal) {
      if ((pair.status as string) === 'paused') return false;
      const fullLocalPath = path.join(localDir, del.localPath);
      const relPath = getRelPath(del.localPath);
      const journalId = this.db!.journalStart(pair.id, 'delete_local_start', relPath);
      try {
        this.markSelfWritten(fullLocalPath);
        await fs.rm(fullLocalPath, { recursive: true, force: true });
        this.db.journalDone(journalId);
        completedDeletesLocal.add(del.localPath);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado localmente en dispositivo'
        }, true);
      } catch (e: unknown) {
        this.db!.journalFail(journalId);
        this.logger.error(`Error borrando localmente ${del.localPath}:`, e instanceof Error ? e.message : String(e));
      }
    }

    for (const del of plan.deleteRemote) {
      if ((pair.status as string) === 'paused') return false;
      const relPath = getRelPath(del.localPath);
      const journalId = this.db!.journalStart(pair.id, 'delete_remote_start', relPath, del.remoteId);
      try {
        if (!del.remoteId) {
          this.db.journalDone(journalId);
          completedDeletesRemote.add(del.localPath);
          continue;
        }
        await this.deleteDriveFile(del.remoteId);
        this.pairRootRemoteFolderCache.delete(pair.id);
        this.db.journalDone(journalId);
        completedDeletesRemote.add(del.localPath);
        this.addEvent({
          id: Math.random().toString(36).substr(2, 9), pairId: pair.id,
          filename: del.localPath, action: 'deleted', timestamp: Date.now(), details: 'Eliminado en Drive desde Android'
        }, true);
      } catch (e: unknown) {
        this.db!.journalFail(journalId);
        if (e instanceof Error && (e.message.includes('404') || e.message.includes('File not found'))) {
          this.db.journalDone(journalId);
          completedDeletesRemote.add(del.localPath);
        } else {
          this.logger.error(`Error borrando remoto ${del.localPath}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    for (const del of plan.deleteLocal) {
      if (!completedDeletesLocal.has(del.localPath)) continue;
      updates.set(getRelPath(del.localPath), {
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null,
        local_mtime: Date.now(), remote_mtime: null, file_size: null, md5_hash: null, block_hashes: null,
        vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 1
      });
    }

    for (const del of plan.deleteRemote) {
      if (!completedDeletesRemote.has(del.localPath)) continue;
      updates.set(getRelPath(del.localPath), {
        pair_id: pair.id, rel_path: getRelPath(del.localPath), remote_id: del.remoteId || null,
        local_mtime: Date.now(), remote_mtime: null, file_size: null, md5_hash: null, block_hashes: null,
        vector_clock: '{}', device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 1
      });
    }

    for (const upload of plan.uploads) {
      if (!completedUploads.has(upload.localPath)) continue;
      updates.set(getRelPath(upload.localPath), {
        pair_id: pair.id, rel_path: getRelPath(upload.localPath),
        remote_id: upload.remoteId || null,
        local_mtime: (upload as any).localMtime, // FIX: stat.mtimeMs
        remote_mtime: (upload as any).remoteMtime || now,
        file_size: (upload as any).remoteSize ?? null, md5_hash: (upload as any).remoteMd5 ?? null,
        block_hashes: null, vector_clock: upload.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    for (const download of plan.downloads) {
      if (!completedDownloads.has(download.localPath)) continue;
      updates.set(getRelPath(download.localPath), {
        pair_id: pair.id, rel_path: getRelPath(download.localPath),
        remote_id: download.remoteFile.id,
        local_mtime: downloadedLocalMtimes.get(download.localPath) ?? now, // FIX: stat.mtimeMs
        remote_mtime: new Date(download.remoteFile.modifiedTime).getTime(),
        file_size: download.remoteFile.size ? parseInt(download.remoteFile.size, 10) : null,
        md5_hash: download.remoteFile.md5Checksum || null, block_hashes: null,
        vector_clock: download.vectorClock, device_id: this.DEVICE_ID!, etag: null, updated_at: now, is_tombstone: 0
      });
    }

    if (updates.size > 0) {
      this.db.commitTransfer(
        pair.id, updates,
        [...uploadCommits.map(c => c.journalId), ...downloadCommits.map(c => c.journalId)],
        []
      );
    }

    // Recorrer subdirectorios ignorando enlaces simbólicos
    const subDirs = remoteFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    let localDirs: Dirent[] = [];
    try {
      localDirs = await fs.readdir(localDir, { withFileTypes: true });
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        this.logger.info(`[SyncEngine] La carpeta local ${localDir} ya no existe en disco. Sincronización de borrado continua.`);
        return true;
      }
      return false;
    }

    for (const dir of localDirs) {
      if (dir.isDirectory() && !dir.isSymbolicLink() && !matchesIgnorePattern(dir.name, this.settings.ignoredPatterns)) {
        const subDir = path.join(localDir, dir.name);
        const subPrefix = getRelPath(dir.name);
        const subRemoteFolder = subDirs.find(d => normalizeNFC(d.name) === normalizeNFC(dir.name));

        if (subRemoteFolder) {
          await this.v2SyncDirectoryTree(subDir, subRemoteFolder.id, pair, subPrefix, folderMap, tracker);
        }
      }
    }

    return true;
  }

  // ─── Métodos Auxiliares e Infraestructura de Red ───────────────

  private async writeSidecarMeta(localFilePath: string, remoteId: string, remoteMtime: number, md5Hash?: string | null) {
    try {
      const metaPath = `${localFilePath}.syncmeta`;
      const metaData = JSON.stringify({ remoteId, remoteMtime, md5Hash, updatedAt: Date.now() });
      this.markSelfWritten(metaPath);
      await fs.writeFile(metaPath, metaData, 'utf-8');
    } catch (err) {
      this.logger.debug('[SyncEngine/Sidecar] Falló la escritura de .syncmeta:', err);
    }
  }

  private async downloadDriveBinary(fileId: string, destPath: string, modifiedTime: string, pairId: string, expectedMd5?: string): Promise<void> {
    await downloadToAtomicFile({
      sourceUrl: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true`,
      destinationPath: destPath,
      modifiedTime,
      expectedMd5,
      client: this.transferClient(pairId),
      markSelfWritten: filePath => this.markSelfWritten(filePath),
    });
    await this.writeSidecarMeta(destPath, fileId, new Date(modifiedTime).getTime(), expectedMd5);
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

  private async uploadDriveBinary(parentId: string, filePath: string, targetName?: string, existingFileId?: string, vectorClock?: string, pairId?: string, operationId?: string): Promise<DriveFile> {
    this.driveFolderCache.delete(parentId);
    const name = sanitizeLocalFilename(targetName || path.basename(filePath));
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    const appProperties = vectorClock ? VectorClockManager.toAppProperties(VectorClockManager.fromString(vectorClock)) : undefined;
    const metadata = existingFileId ? { name, ...(appProperties ? { appProperties } : {}) } : { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };

    if (fileSize > RESUMABLE_UPLOAD_THRESHOLD) {
      const client = this.transferClient(pairId);
      const resumableOperationId = operationId || `upload:${filePath}:${fileSize}:${Date.now()}`;
      return (await uploadResumableFile({
        filePath, fileSize, operationId: resumableOperationId, remoteId: existingFileId ?? null, session: null, client,
        createSession: async () => {
          const initUrl = existingFileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum&supportsAllDrives=true`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum&supportsAllDrives=true';
          return await requestTransfer(client, initUrl, () => ({
            method: existingFileId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(fileSize) },
            body: JSON.stringify(metadata)
          }));
        },
        persistSession: (sess) => {
          if (this.db && resumableOperationId) {
            this.db.setUploadSession({
              operation_id: resumableOperationId,
              remote_id: existingFileId ?? null,
              session_uri: sess.session_uri,
              file_size: fileSize,
              confirmed_offset: sess.confirmed_offset,
              chunk_size: sess.chunk_size,
              source_hash: null,
              updated_at: Date.now()
            });
          }
        },
        deleteSession: () => {
          if (this.db && resumableOperationId) {
            this.db.deleteUploadSession(resumableOperationId);
          }
        },
      })) as unknown as DriveFile;
    }

    const boundary = '-------SyncClientBoundary' + Math.random().toString(36);
    const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileData = await fs.readFile(filePath);
    const bodyPayload = Buffer.concat([header, fileData, footer]);

    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,md5Checksum&supportsAllDrives=true`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,md5Checksum&supportsAllDrives=true';

    const res = await this.driveRequestFactory(url, () => ({
      method: existingFileId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(bodyPayload.length) },
      body: bodyPayload
    }), this.DRIVE_MAX_ATTEMPTS, pairId);

    return (await res.json()) as DriveFile;
  }

  private initializeOAuthCredentials() {
    // Dynamically evaluated via getters
  }

  public async shutdown(): Promise<void> {
    this.logger.info('[SyncEngine] Iniciando apagado controlado...');

    // Abortar peticiones de red activas
    Object.values(this.abortControllers).forEach(controller => controller.abort());

    for (const pairId in this.intervalRefs) {
      clearTimeout(this.intervalRefs[pairId]);
    }

    if (this.externalMonitorInterval) clearInterval(this.externalMonitorInterval);

    if ((this as any).webhookDebounceTimers) {
      for (const pairId in (this as any).webhookDebounceTimers) {
        clearTimeout((this as any).webhookDebounceTimers[pairId]);
      }
      (this as any).webhookDebounceTimers = {};
    }

    await Promise.all(Object.values(this.watchers).map(w => w.unsubscribe().catch(() => { })));
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    this.logger.info('[SyncEngine] Apagado controlado completado.');
  }

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

  private async saveState() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const data = { pairs: this.pairs, events: this.events.slice(0, 200), settings: this.settings, pendingConflicts: this.pendingConflicts };
      const tmpFile = `${this.configFile}.tmp.${Date.now()}`;
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmpFile, this.configFile);
    } catch (err: unknown) {
      this.logger.error('Error al guardar archivo de estado configFile:', err);
    }
  }

  private async listDriveFiles(folderId: string): Promise<DriveFile[]> {
    let files: DriveFile[] = [];
    let pageToken: string | undefined = undefined;
    let pageCount = 0;
    do {
      if (++pageCount > this.DRIVE_LIST_MAX_PAGES) break;
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('q', `'${folderId}' in parents and trashed = false`);
      url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, appProperties)');
      url.searchParams.append('pageSize', '1000');
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await this.driveRequest(url.toString(), { headers: { Authorization: `Bearer ${this.accessToken}` } });
      const data = await res.json();
      if (data.files) files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  public async getPairRootRemoteFolderId(pair: SyncPair): Promise<string> {
    if (this.pairRootRemoteFolderCache.has(pair.id)) return this.pairRootRemoteFolderCache.get(pair.id)!;
    let remoteFolderId = 'root';
    const parts = pair.remotePath.replace(/^(GoogleDrive|Drive):/, '').split('/').filter(Boolean);
    for (const part of parts) {
      const files = await this.listDriveFiles(remoteFolderId);
      let folder = files.find(f => f.name === part && f.mimeType === 'application/vnd.google-apps.folder');
      if (!folder) folder = await this.createDriveFolder(remoteFolderId, part);
      remoteFolderId = folder.id;
    }
    this.pairRootRemoteFolderCache.set(pair.id, remoteFolderId);
    return remoteFolderId;
  }

  private async createDriveFolder(parentId: string, name: string): Promise<DriveFile> {
    const res = await this.driveRequest('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    return (await res.json()) as DriveFile;
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

  public async ensureRemoteFolderPath(pair: SyncPair, relDirPath: string): Promise<string> {
    const normalized = normalizeNFC(relDirPath.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || normalized === '') {
      return await this.getPairRootRemoteFolderId(pair);
    }

    // 1. Consultar estado en SQLite
    const existingState = this.db?.getFileState(pair.id, normalized);
    if (existingState && existingState.remote_id && existingState.remote_id !== '.' && existingState.is_tombstone !== 1) {
      const isDeleted = await this.checkIfRemoteFolderDeleted(existingState.remote_id);
      if (!isDeleted) {
        return existingState.remote_id;
      }
      this.logger.warn(`[SyncEngine] La carpeta remota ${normalized} (id: ${existingState.remote_id}) fue borrada en Drive. Sanando en cascada...`);
      if (this.db) {
        this.db.setFileState(pair.id, normalized, {
          ...existingState,
          remote_id: null,
          updated_at: Date.now()
        });
        // Resetear remote_id de todos los hijos en SQLite
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

    // 2. Obtener/crear carpeta padre recursivamente
    const parentDir = path.dirname(normalized);
    const parentFolderId = await this.ensureRemoteFolderPath(pair, parentDir === '.' ? '' : parentDir);
    const folderName = path.basename(normalized);

    let folder: DriveFile | undefined;
    try {
      const files = await this.listDriveFiles(parentFolderId);
      folder = files.find(f => normalizeNFC(f.name) === folderName && f.mimeType === 'application/vnd.google-apps.folder');
    } catch (err: any) {
      if (err instanceof Error && (err.message.includes('404') || err.message.includes('File not found'))) {
        this.logger.warn(`[SyncEngine] Padre ${parentFolderId} dio 404 al listar ${folderName}. Re-creando desde raíz...`);
        this.pairRootRemoteFolderCache.delete(pair.id);
        const freshParentId = await this.getPairRootRemoteFolderId(pair);
        const files = await this.listDriveFiles(freshParentId);
        folder = files.find(f => normalizeNFC(f.name) === folderName && f.mimeType === 'application/vnd.google-apps.folder');
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
    } catch (e) {
      this.logger.warn(`[Deduplicate] No se pudo leer directorio ${currentDir}:`, e instanceof Error ? e.message : String(e));
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
        this.logger.info(`[Deduplicate] Deduplicación nativa detenida para pair=${pair.id}`);
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
          
          await fs.rename(loserPath, backupFilePath).catch(async () => {
            await fs.copyFile(loserPath, backupFilePath);
            await fs.unlink(loserPath);
          });

          this.logger.info(`[Deduplicate] ${loser.name} respaldado en: ${backupFilePath}`);
        } catch (e) {
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
                ...winnerState, rel_path: canonicalRelPath,
                local_mtime: renamedStat?.mtimeMs ?? winnerState.local_mtime,
                updated_at: Date.now(), is_tombstone: 0,
              });
              this.db.setFileState(pair.id, winnerRelPath, {
                ...winnerState, rel_path: winnerRelPath,
                local_mtime: Date.now(), file_size: null, updated_at: Date.now(), is_tombstone: 1,
              });
            }
          }
        } catch (e) {
          this.logger.warn(`[Deduplicate] Error al renombrar ${winner.name} → ${baseName}:`, e instanceof Error ? e.message : String(e));
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

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number }> {
    const pair = this.pairs.find(p => p.id === pairId);
    if (!pair || !pair.localPath) return { localDeleted: 0, localRenamed: 0, remoteDeleted: 0, remoteRenamed: 0 };

    this.dedupCancelled.delete(pairId);

    let localDeleted = 0;
    let localRenamed = 0;
    const remoteDeleted = 0;
    const remoteRenamed = 0;

    try {
      const localRes = await this.cleanLocalDuplicatesDir(pair, pair.localPath, '');
      if (this.dedupCancelled.has(pairId)) {
        this.logger.info(`[Deduplicate] Android pair=${pairId} cancelado tras fase local.`);
        return { localDeleted: localRes.localDeleted, localRenamed: localRes.localRenamed, remoteDeleted: 0, remoteRenamed: 0 };
      }
      localDeleted = localRes.localDeleted;
      localRenamed = localRes.localRenamed;
      this.logger.info(`[Deduplicate] Android pair=${pairId} completado — local: ${localDeleted} respaldados, ${localRenamed} renombrados.`);
    } catch (error) {
      if (this.dedupCancelled.has(pairId)) {
        this.logger.info(`[Deduplicate] Android pair=${pairId} cancelado explícitamente.`);
      } else {
        this.logger.error(`[Deduplicate] Error en Android para pair=${pairId}:`, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.dedupCancelled.delete(pairId);
    }

    return { localDeleted, localRenamed, remoteDeleted, remoteRenamed };
  }

  public cancelCleanDuplicates(pairId: string): void {
    this.dedupCancelled.add(pairId);
    this.logger.info(`[Deduplicate] Solicitud de cancelación registrada para el par nativo ${pairId}`);
  }

  private async ingestDriveChanges(pair: SyncPair): Promise<{ pageToken: string; controlledRescan: boolean } | null> {
    if (!this.db || !this.accessToken) return null;
    const ingestor = new DriveChangesIngestor(this.db, (url, init) => this.driveRequest(url, init ?? {}), this.accessToken);
    try {
      const res = await ingestor.ingest({
        pairId: pair.id, accountId: 'default', corpusId: 'user', corpus: 'user', forceRescan: false, persistCursor: false
      }, () => { });
      return { pageToken: res.pageToken, controlledRescan: false };
    } catch {
      return null;
    }
  }

  private commitDriveChangesCursor(pair: SyncPair, pageToken: string): void {
    if (!this.db) return;
    this.db.setDriveCursor({
      pair_id: pair.id, account_id: 'default', corpus_id: 'user', drive_id: 'my-drive',
      page_token: pageToken, last_success_at: Date.now(), status: 'active'
    });
  }

  private setupWebhooks() {
    if (this.webhooksInitialized) return;
    this.webhooksInitialized = true;
    try {
      const config = getFirebaseClientConfig();
      const app = getApps().length === 0 ? initializeApp(config) : getApp();
      const db = getDatabase(app);
      onValue(ref(db, 'drive_events'), snapshot => {
        if (!snapshot.exists()) return;
        this.pairs.forEach(pair => {
          if (pair.status === 'paused') return;
          if (this.ensureInterrupt(pair.id)) {
            this.interruptRequested[pair.id] = { eventTimestamp: Date.now() };
            this.triggerSync(pair.id);
          }
        });
      });
    } catch (err: unknown) {
      this.logger.warn('No se pudieron inicializar webhooks de Firebase:', err);
    }
  }
}

export const syncEngine = new SyncEngine();