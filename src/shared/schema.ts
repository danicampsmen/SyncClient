/**
 * Schema SQLite compartido entre Desktop (better-sqlite3) y Android (sql.js WASM).
 * SyncClient v2 — Plan de Refactorización.
 */

export const CREATE_TABLE_SQL = `
-- Tabla principal de estado de archivos
CREATE TABLE IF NOT EXISTS file_states (
    pair_id     TEXT NOT NULL,
    rel_path    TEXT NOT NULL,
    remote_id   TEXT,
    local_mtime INTEGER,
    remote_mtime INTEGER,
    file_size   INTEGER,
    md5_hash    TEXT,
    block_hashes TEXT,
    vector_clock TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    etag        TEXT,
    updated_at  INTEGER NOT NULL,
    is_tombstone INTEGER DEFAULT 0,
    PRIMARY KEY (pair_id, rel_path)
);

-- Write-Ahead Log de operaciones de sincronización
CREATE TABLE IF NOT EXISTS sync_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_id     TEXT NOT NULL,
    action      TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    remote_id   TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_journal_pending ON sync_journal(pair_id, status);

-- Registro de dispositivos conocidos
CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    last_seen   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_states_pair ON file_states(pair_id);
CREATE INDEX IF NOT EXISTS idx_file_states_tombstone ON file_states(is_tombstone, updated_at);
`;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
`;

/** Interfaz compartida para FileState */
export interface FileState {
    pair_id: string;
    rel_path: string;
    remote_id: string | null;
    local_mtime: number | null;
    remote_mtime: number | null;
    file_size: number | null;
    md5_hash: string | null;
    block_hashes: string | null;
    vector_clock: string;
    device_id: string;
    etag: string | null;
    updated_at: number;
    is_tombstone: number;
}

/** Interfaz compartida para entrada del journal */
export interface SyncJournalEntry {
    id: number;
    pair_id: string;
    action: string;
    file_path: string;
    remote_id: string | null;
    status: 'pending' | 'done' | 'failed';
    created_at: number;
    updated_at: number;
}

/** Interfaz compartida para device info */
export interface DeviceInfo {
    device_id: string;
    name: string;
    platform: 'linux' | 'android' | 'unknown';
    last_seen: number;
}

/** Feature flag para activar/desactivar la nueva implementación */
export const USE_V2_SYNC =
    (typeof process !== 'undefined' && process.env?.SYNCCLIENT_V2 === 'true') ||
    (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;