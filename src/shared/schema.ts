/**
 * Schema SQLite compartido entre Desktop (better-sqlite3) y Android (sql.js WASM).
 * SyncClient v2 — Plan de Refactorización.
 */

export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

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
CREATE INDEX IF NOT EXISTS idx_file_states_remote ON file_states(pair_id, remote_id);
`;

export const SCHEMA_VERSION = 9;

export const MIGRATION_SQL: ReadonlyArray<{ version: number; sql: string }> = [
    {
        version: 2,
        sql: `
        CREATE TABLE IF NOT EXISTS drive_cursors (
            pair_id         TEXT NOT NULL,
            account_id      TEXT NOT NULL,
            corpus_id       TEXT NOT NULL,
            drive_id        TEXT NOT NULL DEFAULT 'my-drive',
            page_token      TEXT NOT NULL,
            last_success_at INTEGER,
            status          TEXT NOT NULL DEFAULT 'active',
            PRIMARY KEY (pair_id, account_id, corpus_id, drive_id)
        );
        CREATE TABLE IF NOT EXISTS sync_operations (
            id             TEXT PRIMARY KEY,
            pair_id        TEXT NOT NULL,
            rel_path       TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            remote_id      TEXT,
            status         TEXT NOT NULL DEFAULT 'pending',
            attempts       INTEGER NOT NULL DEFAULT 0,
            last_error     TEXT,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_operations_pending
            ON sync_operations(pair_id, status, updated_at);
        CREATE TABLE IF NOT EXISTS upload_sessions (
            operation_id    TEXT PRIMARY KEY,
            remote_id       TEXT,
            session_uri     TEXT NOT NULL,
            file_size       INTEGER NOT NULL,
            confirmed_offset INTEGER NOT NULL DEFAULT 0,
            chunk_size      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            id            TEXT PRIMARY KEY,
            pair_id       TEXT NOT NULL,
            rel_path      TEXT NOT NULL,
            local_hash    TEXT,
            remote_hash   TEXT,
            base_hash     TEXT,
            resolution    TEXT NOT NULL DEFAULT 'pending',
            created_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS file_versions (
            pair_id    TEXT NOT NULL,
            rel_path   TEXT NOT NULL,
            hash       TEXT NOT NULL,
            size       INTEGER,
            source     TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (pair_id, rel_path, hash)
        );
        UPDATE schema_metadata SET value = '2' WHERE key = 'version';
        `,
    },
    {
        version: 3,
        sql: `
        ALTER TABLE upload_sessions ADD COLUMN source_hash TEXT;
        UPDATE schema_metadata SET value = '3' WHERE key = 'version';
        `,
    },
    {
        version: 4,
        sql: `
        ALTER TABLE sync_conflicts ADD COLUMN remote_id TEXT;
        ALTER TABLE sync_conflicts ADD COLUMN reason TEXT;
        ALTER TABLE sync_conflicts ADD COLUMN updated_at INTEGER;
        UPDATE schema_metadata SET value = '4' WHERE key = 'version';
        `,
    },
    {
        version: 5,
        sql: `
        CREATE INDEX IF NOT EXISTS idx_file_states_remote ON file_states(pair_id, remote_id);
        UPDATE schema_metadata SET value = '5' WHERE key = 'version';
        `,
    },
    {
        version: 6,
        sql: `
        CREATE TABLE IF NOT EXISTS sync_pair_filters (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id       TEXT NOT NULL,
            rule_type     TEXT NOT NULL,
            string_value  TEXT,
            numeric_value INTEGER,
            is_include    INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_pair_filters ON sync_pair_filters(pair_id);

        CREATE TABLE IF NOT EXISTS sync_item_logs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    TEXT NOT NULL,
            pair_id       TEXT NOT NULL,
            rel_path      TEXT NOT NULL,
            action        TEXT NOT NULL,
            status        TEXT NOT NULL,
            file_size     INTEGER,
            md5_hash      TEXT,
            error_message TEXT,
            timestamp     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_item_logs_pair ON sync_item_logs(pair_id, timestamp);

        CREATE TABLE IF NOT EXISTS sync_pair_conditions (
            pair_id            TEXT PRIMARY KEY,
            require_charging   INTEGER NOT NULL DEFAULT 0,
            require_wifi       INTEGER NOT NULL DEFAULT 0,
            min_battery_level  INTEGER NOT NULL DEFAULT 0,
            allowed_ssids      TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_webhooks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id       TEXT NOT NULL,
            target_url    TEXT NOT NULL,
            event_trigger TEXT NOT NULL DEFAULT 'all',
            is_active     INTEGER NOT NULL DEFAULT 1,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_webhooks_pair ON sync_webhooks(pair_id);

        UPDATE schema_metadata SET value = '6' WHERE key = 'version';
        `,
    },
    {
        version: 7,
        sql: `
        CREATE TABLE IF NOT EXISTS sync_pair_conditions_v2 (
            pair_id            TEXT PRIMARY KEY,
            require_charging   INTEGER NOT NULL DEFAULT 0,
            require_wifi       INTEGER NOT NULL DEFAULT 0,
            min_battery_level  INTEGER NOT NULL DEFAULT 0,
            block_on_roaming   INTEGER NOT NULL DEFAULT 0,
            block_on_metered   INTEGER NOT NULL DEFAULT 0,
            require_vpn        INTEGER NOT NULL DEFAULT 0,
            allowed_ssids      TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_pair_filters_v2 (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id       TEXT NOT NULL,
            rule_type     TEXT NOT NULL,
            string_value  TEXT,
            numeric_value INTEGER,
            numeric_value2 INTEGER,
            is_include    INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_pair_filters_v2_pair ON sync_pair_filters_v2(pair_id);

        CREATE TABLE IF NOT EXISTS sync_webhooks_v2 (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id       TEXT NOT NULL,
            target_url    TEXT NOT NULL,
            event_trigger TEXT NOT NULL DEFAULT 'all',
            is_active     INTEGER NOT NULL DEFAULT 1,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_webhooks_v2_pair ON sync_webhooks_v2(pair_id);

        UPDATE schema_metadata SET value = '7' WHERE key = 'version';
        `,
    },
    {
        version: 8,
        sql: `
        CREATE TABLE IF NOT EXISTS sync_pair_schedules (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id                TEXT NOT NULL,
            name                   TEXT NOT NULL DEFAULT 'Schedule',
            interval_minutes       INTEGER NOT NULL DEFAULT 60,
            enabled                INTEGER NOT NULL DEFAULT 1,
            require_charging       INTEGER NOT NULL DEFAULT 0,
            require_wifi           INTEGER NOT NULL DEFAULT 0,
            min_battery_level      INTEGER NOT NULL DEFAULT 0,
            block_on_roaming       INTEGER NOT NULL DEFAULT 0,
            block_on_metered       INTEGER NOT NULL DEFAULT 0,
            require_vpn            INTEGER NOT NULL DEFAULT 0,
            allowed_ssids          TEXT,
            created_at             INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_pair_schedules_pair ON sync_pair_schedules(pair_id);
        CREATE INDEX IF NOT EXISTS idx_sync_pair_schedules_enabled ON sync_pair_schedules(enabled);

        UPDATE schema_metadata SET value = '8' WHERE key = 'version';
        `,
    },
    {
        version: 9,
        sql: `
        CREATE TABLE IF NOT EXISTS sync_pair_encryption_keys (
            pair_id            TEXT PRIMARY KEY,
            salt               TEXT NOT NULL,
            created_at         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_pair_encryption_keys_pair ON sync_pair_encryption_keys(pair_id);

        UPDATE schema_metadata SET value = '9' WHERE key = 'version';
        `,
    },
];

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

export interface DriveCursor {
    pair_id: string;
    account_id: string;
    corpus_id: string;
    drive_id: string;
    page_token: string;
    last_success_at: number | null;
    status: string;
}

export type SyncOperationStatus = 'pending' | 'running' | 'retry' | 'done' | 'failed';

export interface SyncOperation {
    id: string;
    pair_id: string;
    rel_path: string;
    operation_type: string;
    remote_id: string | null;
    status: SyncOperationStatus;
    attempts: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
}

export interface UploadSession {
    operation_id: string;
    remote_id: string | null;
    session_uri: string;
    file_size: number;
    confirmed_offset: number;
    chunk_size: number;
    source_hash: string | null;
    updated_at: number;
}

export interface SyncConflict {
    id: string;
    pair_id: string;
    rel_path: string;
    local_hash: string | null;
    remote_hash: string | null;
    base_hash: string | null;
    remote_id: string | null;
    reason: string | null;
    resolution: string;
    created_at: number;
    updated_at: number;
}

export type SyncPairFilterRuleType = 'glob' | 'size' | 'mtime' | 'hidden' | 'system' | 'symlink' | 'FileType' | 'FileNameEquals' | 'FileNameStartsWith' | 'FileNameEndsWith' | 'FileNameContains' | 'FolderNameEquals' | 'FolderNameContains' | 'FileRegex' | 'FilePathRegex' | 'FileSizeLargerThan' | 'FileSizeSmallerThan' | 'FileAgeOlderMinutes' | 'FileAgeNewerMinutes';

export interface SyncPairFilter {
    id?: number;
    pair_id: string;
    rule_type: SyncPairFilterRuleType;
    string_value?: string | null;
    numeric_value?: number | null;
    numeric_value2?: number | null;
    is_include: number;
    created_at: number;
}

export interface SyncPairSchedule {
    id?: number;
    pair_id: string;
    name: string;
    interval_minutes: number;
    enabled: number;
    require_charging: number;
    require_wifi: number;
    min_battery_level: number;
    block_on_roaming: number;
    block_on_metered: number;
    require_vpn: number;
    allowed_ssids?: string | null;
    created_at: number;
}

export interface SyncItemLog {
    id?: number;
    session_id: string;
    pair_id: string;
    rel_path: string;
    action: string;
    status: 'uploaded' | 'downloaded' | 'skipped' | 'conflict' | 'failed' | 'deleted';
    file_size?: number | null;
    md5_hash?: string | null;
    error_message?: string | null;
    timestamp: number;
}

export interface SyncPairConditions {
    pair_id: string;
    require_charging: number;
    require_wifi: number;
    min_battery_level: number;
    block_on_roaming: number;
    block_on_metered: number;
    require_vpn: number;
    allowed_ssids?: string | null;
}

export interface SyncWebhook {
    id?: number;
    pair_id: string;
    target_url: string;
    event_trigger: 'all' | 'success' | 'error';
    is_active: number;
    created_at: number;
}

/**
 * El motor legacy ya no implementa sincronización. Mantener un feature flag que
 * pueda desactivarlo dejaría Android de producción marcando pares como "al día"
 * sin transferir archivos; por eso v2 es el único motor soportado.
 */
export const USE_V2_SYNC = true;

