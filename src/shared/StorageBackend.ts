/**
 * StorageBackend — Abstracción de persistencia para SyncClient v2.
 *
 * Desktop: better-sqlite3 (nativo, síncrono, WAL mode)
 * Android: sql.js (SQLite compilado a WASM, sin plugins nativos)
 * Fallback: JSONBackend (sync_data.json)
 */

import { CREATE_TABLE_SQL, FileState, SyncJournalEntry, DeviceInfo } from './schema';

// ─── IStorageBackend ────────────────────────────────────────────

export interface IStorageBackend {
    /** Inicializar backend. Retorna true si fue exitoso. */
    init(): Promise<boolean>;

    // CRUD de estado de archivos (síncrono — opera en RAM/DB)
    getFileState(pairId: string, relPath: string): FileState | null;
    getFolderState(pairId: string): Map<string, FileState>;
    setFileState(pairId: string, relPath: string, state: FileState): void;
    deleteFileState(pairId: string, relPath: string): void;
    updateBatch(pairId: string, updates: Map<string, FileState>): void;

    // Dispositivos
    getDeviceInfo(deviceId: string): DeviceInfo | null;
    setDeviceInfo(deviceId: string, info: DeviceInfo): void;

    // Write-Ahead Log
    journalStart(pairId: string, action: string, filePath: string, remoteId?: string): number;
    journalDone(journalId: number): void;
    journalFail(journalId: number): void;
    getPendingJournalEntries(pairId: string): SyncJournalEntry[];

    // Mantenimiento
    vacuum(): void;
    checkpoint(): Promise<void>;
}

// ─── Detección de plataforma ────────────────────────────────────

function isCapacitor(): boolean {
    return typeof (globalThis as any).Capacitor !== 'undefined';
}

// ─── Utilidades ──────────────────────────────────────────────────

function rowToFileState(row: any): FileState {
    return {
        pair_id: row.pair_id,
        rel_path: row.rel_path,
        remote_id: row.remote_id ?? null,
        local_mtime: row.local_mtime ?? null,
        remote_mtime: row.remote_mtime ?? null,
        file_size: row.file_size ?? null,
        md5_hash: row.md5_hash ?? null,
        block_hashes: row.block_hashes ?? null,
        vector_clock: row.vector_clock,
        device_id: row.device_id,
        etag: row.etag ?? null,
        updated_at: row.updated_at,
        is_tombstone: row.is_tombstone ?? 0,
    };
}

// ─── SQLiteBackend ───────────────────────────────────────────────

/**
 * Backend SQLite.
 * - Desktop: usa better-sqlite3 (nativo, síncrono)
 * - Android: usa sql.js (WASM)
 * Mismo schema SQL para ambas plataformas.
 */
export class SQLiteBackend implements IStorageBackend {
    private db: any; // Database (better-sqlite3) o SQL.Database (sql.js)
    private dbPath: string;
    private configDir: string;
    private fs: any; // IFileSystem o fs/promises
    private nextJournalId = 0;

    constructor(configDir: string, fs?: any) {
        this.configDir = configDir;
        this.fs = fs;
        this.dbPath = '';
    }

    async init(): Promise<boolean> {
        try {
            if (isCapacitor()) {
                return this.initWasm();
            } else {
                // Dynamic import de createRequire: solo Node.js tiene 'node:module'
                const { createRequire } = await import('node:module');
                return this.initNative(createRequire);
            }
        } catch (e: any) {
            console.error('[SQLiteBackend] Init failed:', e.message || e);
            return false;
        }
    }

    private initNative(createRequire: (url: string | URL) => NodeRequire): boolean {
        // Compatible ESM (import.meta.url) y CJS (__filename via url.pathToFileURL)
        let callerUrl: string;
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            callerUrl = import.meta.url;
        } else {
            // En CJS, import.meta no existe. Usar __filename via require('url')
            const urlMod = createRequire('file:///')('url');
            callerUrl = urlMod.pathToFileURL(__filename).href;
        }
        const _require = createRequire(callerUrl);
        const Database = _require('better-sqlite3');
        const path = _require('path') as typeof import('path');
        const fsMod = _require('fs') as typeof import('fs');
        const fs = _require('fs/promises') as typeof import('fs/promises');

        this.dbPath = path.join(this.configDir, 'sync_state_v2.db');
        this.fs = fs;

        // Asegurar que el directorio existe
        try {
            fsMod.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        } catch { }

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        // Crear tablas (idempotente)
        this.db.exec(CREATE_TABLE_SQL);

        // Inicializar journal ID desde el máximo existente
        const maxId = this.db.prepare('SELECT MAX(id) as mx FROM sync_journal').get()?.mx;
        this.nextJournalId = (maxId || 0) + 1;

        console.log('[SQLiteBackend] Native (better-sqlite3) initialized at', this.dbPath);
        return true;
    }

    private async initWasm(): Promise<boolean> {
        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs();

        this.dbPath = `${this.configDir}/sync_state_v2.db`;
        this.fs = this.fs; // ya viene del caller (CapacitorFS o similar)

        // Intentar cargar DB existente
        try {
            const data = await this.loadOrRecoverWasm();
            this.db = data;
        } catch {
            this.db = new SQL.Database();
        }

        // Crear tablas (idempotente)
        this.db.run(CREATE_TABLE_SQL);

        const maxId = this.db.exec('SELECT MAX(id) as mx FROM sync_journal');
        this.nextJournalId = ((maxId?.[0]?.values?.[0]?.[0] as number) || 0) + 1;

        console.log('[SQLiteBackend] WASM (sql.js) initialized');
        return true;
    }

    /** Cargar DB con recuperación: intentar principal → backup → nueva */
    private async loadOrRecoverWasm(): Promise<any> {
        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs();

        // Intentar archivo principal
        try {
            const raw = await this.fs.readFile(this.dbPath);
            const db = new SQL.Database(new Uint8Array(raw));
            db.run('PRAGMA integrity_check');
            return db;
        } catch {
            // Intentar backup
            try {
                const raw = await this.fs.readFile(this.dbPath + '.backup');
                const db = new SQL.Database(new Uint8Array(raw));
                db.run('PRAGMA integrity_check');
                console.warn('[SQLiteBackend] Recovered from backup');
                return db;
            } catch {
                throw new Error('Both main and backup are corrupt');
            }
        }
    }

    // ─── CRUD (síncrono) ─────────────────────────────────────────

    getFileState(pairId: string, relPath: string): FileState | null {
        const stmt = this.db.prepare('SELECT * FROM file_states WHERE pair_id = ? AND rel_path = ?');
        const row = isCapacitor()
            ? this._wasmGet(stmt, [pairId, relPath])
            : stmt.get(pairId, relPath);
        return row ? rowToFileState(row) : null;
    }

    getFolderState(pairId: string): Map<string, FileState> {
        const map = new Map<string, FileState>();
        const rows = isCapacitor()
            ? this._wasmAll(this.db.prepare('SELECT * FROM file_states WHERE pair_id = ?'), [pairId])
            : this.db.prepare('SELECT * FROM file_states WHERE pair_id = ?').all(pairId);
        for (const row of rows) {
            map.set(row.rel_path, rowToFileState(row));
        }
        return map;
    }

    setFileState(pairId: string, relPath: string, state: FileState): void {
        state.updated_at = Date.now();
        if (isCapacitor()) {
            this.db.run(
                `INSERT OR REPLACE INTO file_states 
         (pair_id, rel_path, remote_id, local_mtime, remote_mtime, file_size, 
          md5_hash, block_hashes, vector_clock, device_id, etag, updated_at, is_tombstone)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [pairId, relPath, state.remote_id, state.local_mtime, state.remote_mtime,
                    state.file_size, state.md5_hash, state.block_hashes, state.vector_clock,
                    state.device_id, state.etag, state.updated_at, state.is_tombstone]
            );
        } else {
            this.db.prepare(
                `INSERT OR REPLACE INTO file_states 
         (pair_id, rel_path, remote_id, local_mtime, remote_mtime, file_size,
          md5_hash, block_hashes, vector_clock, device_id, etag, updated_at, is_tombstone)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(pairId, relPath, state.remote_id, state.local_mtime, state.remote_mtime,
                state.file_size, state.md5_hash, state.block_hashes, state.vector_clock,
                state.device_id, state.etag, state.updated_at, state.is_tombstone);
        }
    }

    deleteFileState(pairId: string, relPath: string): void {
        if (isCapacitor()) {
            this.db.run('DELETE FROM file_states WHERE pair_id = ? AND rel_path = ?', [pairId, relPath]);
        } else {
            this.db.prepare('DELETE FROM file_states WHERE pair_id = ? AND rel_path = ?').run(pairId, relPath);
        }
    }

    updateBatch(pairId: string, updates: Map<string, FileState>): void {
        const now = Date.now();
        const runFn = isCapacitor()
            ? (sql: string, params: any[]) => this.db.run(sql, params)
            : (sql: string, params: any[]) => this.db.prepare(sql).run(...params);

        const sql = `INSERT OR REPLACE INTO file_states 
      (pair_id, rel_path, remote_id, local_mtime, remote_mtime, file_size,
       md5_hash, block_hashes, vector_clock, device_id, etag, updated_at, is_tombstone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

        for (const [relPath, state] of updates) {
            state.updated_at = now;
            runFn(sql, [pairId, relPath, state.remote_id, state.local_mtime, state.remote_mtime,
                state.file_size, state.md5_hash, state.block_hashes, state.vector_clock,
                state.device_id, state.etag, now, state.is_tombstone]);
        }

        // Garbage collection
        const cutoff = now - 30 * 86400_000; // 30 días
        if (isCapacitor()) {
            this.db.run('DELETE FROM file_states WHERE is_tombstone = 1 AND updated_at < ?', [cutoff]);
        } else {
            this.db.prepare('DELETE FROM file_states WHERE is_tombstone = 1 AND updated_at < ?').run(cutoff);
        }
    }

    // ─── Devices ──────────────────────────────────────────────────

    getDeviceInfo(deviceId: string): DeviceInfo | null {
        const stmt = this.db.prepare('SELECT * FROM devices WHERE device_id = ?');
        const row = isCapacitor() ? this._wasmGet(stmt, [deviceId]) : stmt.get(deviceId);
        return row ? row as DeviceInfo : null;
    }

    setDeviceInfo(deviceId: string, info: DeviceInfo): void {
        if (isCapacitor()) {
            this.db.run(
                'INSERT OR REPLACE INTO devices (device_id, name, platform, last_seen) VALUES (?,?,?,?)',
                [info.device_id, info.name, info.platform, info.last_seen]
            );
        } else {
            this.db.prepare(
                'INSERT OR REPLACE INTO devices (device_id, name, platform, last_seen) VALUES (?,?,?,?)'
            ).run(info.device_id, info.name, info.platform, info.last_seen);
        }
    }

    // ─── Write-Ahead Log ──────────────────────────────────────────

    journalStart(pairId: string, action: string, filePath: string, remoteId?: string): number {
        const id = this.nextJournalId++;
        const now = Date.now();
        if (isCapacitor()) {
            this.db.run(
                'INSERT INTO sync_journal (id, pair_id, action, file_path, remote_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
                [id, pairId, action, filePath, remoteId || null, 'pending', now, now]
            );
        } else {
            this.db.prepare(
                'INSERT INTO sync_journal (id, pair_id, action, file_path, remote_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
            ).run(id, pairId, action, filePath, remoteId || null, 'pending', now, now);
        }
        return id;
    }

    journalDone(journalId: number): void {
        const now = Date.now();
        if (isCapacitor()) {
            this.db.run("UPDATE sync_journal SET status = 'done', updated_at = ? WHERE id = ?", [now, journalId]);
        } else {
            this.db.prepare("UPDATE sync_journal SET status = 'done', updated_at = ? WHERE id = ?").run(now, journalId);
        }
    }

    journalFail(journalId: number): void {
        const now = Date.now();
        if (isCapacitor()) {
            this.db.run("UPDATE sync_journal SET status = 'failed', updated_at = ? WHERE id = ?", [now, journalId]);
        } else {
            this.db.prepare("UPDATE sync_journal SET status = 'failed', updated_at = ? WHERE id = ?").run(now, journalId);
        }
    }

    getPendingJournalEntries(pairId: string): SyncJournalEntry[] {
        const rows = isCapacitor()
            ? this._wasmAll(
                this.db.prepare("SELECT * FROM sync_journal WHERE pair_id = ? AND status = 'pending'"),
                [pairId]
            )
            : this.db.prepare("SELECT * FROM sync_journal WHERE pair_id = ? AND status = 'pending'").all(pairId);
        return rows;
    }

    // ─── Mantenimiento ────────────────────────────────────────────

    vacuum(): void {
        const cutoff = Date.now() - 30 * 86400_000;
        if (isCapacitor()) {
            this.db.run('DELETE FROM file_states WHERE is_tombstone = 1 AND updated_at < ?', [cutoff]);
            this.db.run("DELETE FROM sync_journal WHERE status = 'done' AND updated_at < ?", [cutoff]);
        } else {
            this.db.prepare('DELETE FROM file_states WHERE is_tombstone = 1 AND updated_at < ?').run(cutoff);
            this.db.prepare("DELETE FROM sync_journal WHERE status = 'done' AND updated_at < ?").run(cutoff);
        }
    }

    async checkpoint(): Promise<void> {
        if (isCapacitor()) {
            await this.checkpointWasm();
        }
        // Desktop: better-sqlite3 persiste automáticamente en WAL mode
    }

    private async checkpointWasm(): Promise<void> {
        if (!this.fs) return;

        const data = this.db.export();
        const tmpPath = this.dbPath + '.tmp';
        const backupPath = this.dbPath + '.backup';

        try {
            // 1. Escribir a temporal como base64
            await this.fs.writeFile(tmpPath, Buffer.from(data).toString('base64'), true);

            // 2. Verificar integridad
            const initSqlJs = (await import('sql.js')).default;
            const SQL = await initSqlJs();
            const rawData = await this.fs.readFile(tmpPath, true);
            const binaryStr = typeof rawData === 'string' ? atob(rawData) : '';
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const testDb = new SQL.Database(bytes);
            testDb.run('PRAGMA integrity_check');
            testDb.close();

            // 3. Renombrar atómicamente
            await this.fs.rename(this.dbPath, backupPath).catch(() => { });
            await this.fs.rename(tmpPath, this.dbPath);

            // 4. Limpiar backup
            await this.fs.rm(backupPath).catch(() => { });
        } catch (e) {
            console.error('[SQLiteBackend] Checkpoint failed:', e);
        }
    }

    // ─── Helpers WASM ─────────────────────────────────────────────

    /** Ejecutar stmt.get() en sql.js (que no tiene API idéntica a better-sqlite3) */
    private _wasmGet(stmt: any, params: any[]): any {
        stmt.bind(params);
        if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const obj: any = {};
            cols.forEach((c: string, i: number) => { obj[c] = vals[i]; });
            return obj;
        }
        stmt.free();
        return null;
    }

    private _wasmAll(stmt: any, params: any[]): any[] {
        stmt.bind(params);
        const results: any[] = [];
        const cols = stmt.getColumnNames();
        while (stmt.step()) {
            const vals = stmt.get();
            const obj: any = {};
            cols.forEach((c: string, i: number) => { obj[c] = vals[i]; });
            results.push(obj);
        }
        stmt.free();
        return results;
    }
}

// ─── JSONBackend (Fallback) ─────────────────────────────────────

/**
 * Backend JSON: lee/escribe sync_data.json.
 * Usado como fallback si SQLite no está disponible.
 */
export class JSONBackend implements IStorageBackend {
    private data: {
        fileStates: Record<string, Record<string, FileState>>;
        devices: Record<string, DeviceInfo>;
        journal: SyncJournalEntry[];
    };
    private configFile: string;
    private fs: any;
    private nextJournalId = 0;
    private dirty = false;

    constructor(configDir: string, fs?: any) {
        this.configFile = `${configDir}/sync_data.json`;
        this.fs = fs;
        this.data = { fileStates: {}, devices: {}, journal: [] };
    }

    async init(): Promise<boolean> {
        try {
            if (this.fs) {
                const raw = await this.fs.readFile(this.configFile);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed.fileStates) this.data.fileStates = parsed.fileStates;
                    if (parsed.devices) this.data.devices = parsed.devices;
                    if (parsed.journal) this.data.journal = parsed.journal;
                }
            } else {
                const fs = await import('fs/promises');
                try {
                    const raw = await fs.readFile(this.configFile, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (parsed.fileStates) this.data.fileStates = parsed.fileStates;
                    if (parsed.devices) this.data.devices = parsed.devices;
                    if (parsed.journal) this.data.journal = parsed.journal;
                } catch { /* no file yet */ }
            }

            this.nextJournalId = this.data.journal.reduce((max, e) => Math.max(max, e.id), 0) + 1;
            return true;
        } catch {
            return true; // Empezar con estado vacío
        }
    }

    private getStates(pairId: string): Record<string, FileState> {
        if (!this.data.fileStates[pairId]) this.data.fileStates[pairId] = {};
        return this.data.fileStates[pairId];
    }

    getFileState(pairId: string, relPath: string): FileState | null {
        return this.getStates(pairId)[relPath] || null;
    }

    getFolderState(pairId: string): Map<string, FileState> {
        return new Map(Object.entries(this.getStates(pairId)));
    }

    setFileState(pairId: string, relPath: string, state: FileState): void {
        state.updated_at = Date.now();
        this.getStates(pairId)[relPath] = state;
        this.dirty = true;
    }

    deleteFileState(pairId: string, relPath: string): void {
        delete this.getStates(pairId)[relPath];
        this.dirty = true;
    }

    updateBatch(pairId: string, updates: Map<string, FileState>): void {
        const states = this.getStates(pairId);
        const now = Date.now();
        for (const [relPath, state] of updates) {
            state.updated_at = now;
            states[relPath] = state;
        }

        // Garbage collection
        const cutoff = now - 30 * 86400_000;
        for (const [key, val] of Object.entries(states)) {
            if (val.is_tombstone && val.updated_at < cutoff) {
                delete states[key];
            }
        }
        this.dirty = true;
    }

    getDeviceInfo(deviceId: string): DeviceInfo | null {
        return this.data.devices[deviceId] || null;
    }

    setDeviceInfo(deviceId: string, info: DeviceInfo): void {
        this.data.devices[deviceId] = info;
        this.dirty = true;
    }

    journalStart(pairId: string, action: string, filePath: string, remoteId?: string): number {
        const id = this.nextJournalId++;
        const now = Date.now();
        this.data.journal.push({
            id, pair_id: pairId, action, file_path: filePath,
            remote_id: remoteId || null, status: 'pending', created_at: now, updated_at: now
        });
        this.dirty = true;
        return id;
    }

    journalDone(journalId: number): void {
        const e = this.data.journal.find(j => j.id === journalId);
        if (e) { e.status = 'done'; e.updated_at = Date.now(); this.dirty = true; }
    }

    journalFail(journalId: number): void {
        const e = this.data.journal.find(j => j.id === journalId);
        if (e) { e.status = 'failed'; e.updated_at = Date.now(); this.dirty = true; }
    }

    getPendingJournalEntries(pairId: string): SyncJournalEntry[] {
        return this.data.journal.filter(e => e.pair_id === pairId && e.status === 'pending');
    }

    vacuum(): void {
        const cutoff = Date.now() - 30 * 86400_000;
        this.data.journal = this.data.journal.filter(
            e => e.status !== 'done' || e.updated_at > cutoff
        );
        this.dirty = true;
    }

    async checkpoint(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;

        const json = JSON.stringify(this.data);
        try {
            if (this.fs) {
                const tmpFile = `${this.configFile}.tmp.${Date.now()}`;
                await this.fs.writeFile(tmpFile, json);
                await this.fs.rename(tmpFile, this.configFile).catch(() => { });
            } else {
                const fs = await import('fs/promises');
                const tmpFile = `${this.configFile}.tmp.${Date.now()}`;
                await fs.writeFile(tmpFile, json, 'utf8');
                await fs.rename(tmpFile, this.configFile);
            }
        } catch (e) {
            console.error('[JSONBackend] Checkpoint failed:', e);
        }
    }
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Crear el backend óptimo para la plataforma actual.
 * Orden: SQLiteBackend → JSONBackend (fallback)
 */
export async function createBackend(configDir: string, fs?: any): Promise<IStorageBackend> {
    // Intentar SQLite
    try {
        const sqlite = new SQLiteBackend(configDir, fs);
        if (await sqlite.init()) {
            console.log('[StorageBackend] Using SQLite');
            return sqlite;
        }
    } catch (e: any) {
        console.warn('[StorageBackend] SQLite unavailable:', e.message || e);
    }

    // Fallback JSON
    try {
        const json = new JSONBackend(configDir, fs);
        if (await json.init()) {
            console.log('[StorageBackend] Using JSON (fallback)');
            return json;
        }
    } catch {
        // último recurso
    }

    // Esto no debería pasar
    return new JSONBackend(configDir, fs);
}