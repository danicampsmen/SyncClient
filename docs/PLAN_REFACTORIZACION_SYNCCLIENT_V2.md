# Plan Maestro de Refactorización — SyncClient v2

**Fecha**: 30 de Julio, 2026
**Autor**: Análisis de arquitectura por Cline + feedback de @danicampsmen
**Versión**: 2.1.0 (revisión con 8 mejoras)
**Estado**: 🔵 PLAN APROBADO — Pendiente de implementación

---

## Tabla de Contenidos

1. [Visión General](#1-visión-general)
2. [Problema de Raíz](#2-problema-de-raíz)
3. [Arquitectura Objetivo](#3-arquitectura-objetivo)
4. [Schema SQLite](#4-schema-sqlite)
5. [Plan de Implementación (Fases F0-F7)](#5-plan-de-implementación)
6. [Matriz de Riesgos y Mitigaciones](#6-matriz-de-riesgos-y-mitigaciones)
7. [Estructura de Archivos](#7-estructura-de-archivos)
8. [Origen de Cada Patrón Arquitectónico](#8-origen-de-cada-patrón-arquitectónico)
9. [Alternativas Free Analizadas](#9-alternativas-free-analizadas)
10. [Comparativa Syncthing vs SyncClient v2](#10-comparativa-syncthing-vs-syncclient-v2)
11. [Análisis de Hardware — Tablet Objetivo](#11-análisis-de-hardware--tablet-objetivo)
12. [Dependencias y Ejecución](#12-dependencias-y-ejecución)
13. [Estrategia de Rollback](#13-estrategia-de-rollback)

---

## 1. Visión General

Reemplazar el actual sistema de sincronización basado en **manifiesto JSON** y **comparación ad-hoc de mtimes** por una arquitectura **Database-Backed State** con **Block-Level Content Hashing** y **Vector Clocks**.

### Inspiración

| Proyecto | ⭐ | Años en producción | Qué tomamos |
|---|---|---|---|
| **Syncthing** | 87K | 11 | DB como source of truth, three-way merge, block hashing, scanner incremental, echo cancellation |
| **Git** | — | 20+ | Three-way merge (local vs remote vs base) |
| **DynamoDB / Cassandra** | — | 15+ | Vector Clocks para resolución de conflictos sin ambigüedad |
| **HTTP/1.1 (RFC 7232)** | — | 25+ | Optimistic locking con ETag + conditional requests (If-None-Match) |
| **rsync / ZFS** | — | 25+ | Block-level content hashing |
| **SQLite** | — | 20+ | Atomic write (write-to-temp + rename), WAL mode, integrity_check |

### Resultado esperado

| Métrica | Antes | Después |
|---|---|---|
| Bucles de sincronización | Posibles (stale data) | **Cero** (single source of truth) |
| Falsos positivos (mtime sin cambio real) | Altos | **Cero** (block hashing) |
| Ambigüedad de conflictos | Alta (timestamps) | **Cero** (vector clocks) |
| Llamadas a Drive API por ciclo | 2 por directorio | **1 por directorio (-50%)** |
| I/O local por ciclo | 2 readdir por directorio | **1 readdir (-50%)** |
| Archivos re-leídos por ciclo | 100% | **~5-10%** (solo modificados) |
| Lógica duplicada Desktop↔Android | ~400 líneas | **Cero** (CoreSyncLogic) |
| Supervivencia a crash durante sync | ❌ Estado inconsistente | ✅ Write-Ahead Log + reconciliación |
| Supervivencia a reinstalación de app | ❌ Device ID perdido | ✅ Device ID en Drive |
| Reconciliación post-offline | ❌ DB obsoleta | ✅ HTTP 304 (gratis) |

---

## 2. Problema de Raíz

### Data Race Determinístico en `syncDirectoryTree`

```
syncDirectoryTree(dir) {
  dedupLocal(dir)        → modifica disco (borra/renombra archivos)
  dedupRemote(dir)       → modifica Drive (borra/renombra archivos)
  remoteFiles = fetch()  → 🔴 LISTA OBSOLETA (dedupRemote ya modificó Drive)
  localEntries = read()  → 🔴 LISTA OBSOLETA (dedupLocal ya modificó disco)
  decidirQuéSubirYDescargar(remoteFiles, localEntries)
}
```

### Consecuencias

- Uploads fantasmas (archivo borrado por dedup reaparece en la lista)
- Downloads innecesarios
- Bucles infinitos (subir → watcher detecta → volver a sincronizar → ...)
- Conflictos falsos por timestamps ambiguos
- Falsos positivos por `touch`, `git checkout`, o sync restore que cambian mtime sin cambiar contenido
- Crash durante sync → estado inconsistente entre Drive y DB local
- Dispositivo offline por días → DB local obsoleta → decisiones incorrectas
- Case-sensitivity: Linux `Apuntes.pdf` ≠ Drive `apuntes.pdf` → archivos duplicados

---

## 3. Arquitectura Objetivo

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TRIGGERS DE SINCRONIZACIÓN                        │
│  Desktop: Chokidar (inotify) + polling adaptativo                    │
│  Android: hasLocalFolderChanged() + polling adaptativo               │
│  Ambos: markSelfWritten, activeSyncs, SYNC_COOLDOWN_MS, syncBackoff  │
│  (HEREDADOS — SIN CAMBIOS)                                           │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  syncDirectoryTree(dir, remoteId, pair)               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 0 — RECONCILIACIÓN RÁPIDA (nuevo)                     │      │
│  │                                                             │      │
│  │ Para cada entrada en dbState con remoteId:                 │      │
│  │   GET /drive/v3/files/{id}?fields=etag,modifiedTime,md5    │      │
│  │   Header: If-None-Match: {etag_en_db}                      │      │
│  │   → HTTP 304 Not Modified → sin cambios (NO consume cuota)│      │
│  │   → HTTP 200 → archivo cambió → actualizar dbState        │      │
│  │   → HTTP 404 → archivo borrado en Drive → marcar deleted  │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 1 — TOMAR FOTOGRAFÍA ÚNICA                            │      │
│  │                                                             │      │
│  │ 1a. localSnapshot  = Scanner.scanChanges(dir, dbState)     │      │
│  │     → Solo archivos con (mtime, size, md5) cambiado vs DB  │      │
│  │     → Permission Gate: verificar permisos antes de scan    │      │
│  │     → Lazy hashing en lotes (solo archivos modificados)    │      │
│  │                                                             │      │
│  │ 1b. remoteSnapshot = DriveAPI.listFiles(remoteId)          │      │
│  │     → fields: id, name, mimeType, modifiedTime, size,      │      │
│  │               md5Checksum, etag, appProperties             │      │
│  │     → Normalizar nombres a lowercase para índice           │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 2 — DEDUPLICAR + MUTAR SNAPSHOTS EN RAM               │      │
│  │                                                             │      │
│  │ 2a. {local, mutations} = dedupLocal(localSnapshot)         │      │
│  │     → Recibe array, muta in-place, aplica cambios a disco  │      │
│  │     → NO hace readdir interno                               │      │
│  │                                                             │      │
│  │ 2b. {remote, mutations} = dedupRemote(remoteSnapshot)      │      │
│  │     → Recibe array, muta in-place, aplica cambios a Drive  │      │
│  │     → NO hace listDriveFiles interno                        │      │
│  │                                                             │      │
│  │     → Vector clocks se mergean en archivos sobrevivientes   │      │
│  │       (mergeClocksForDedup: MAX por dimensión + increment)  │      │
│  │     → markSelfWritten() en todos los archivos tocados       │      │
│  │     → Registrar en sync_journal (WAL)                       │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 3 — COMPUTAR PLAN (Three-Way Merge — función PURA)    │      │
│  │                                                             │      │
│  │ plan = CoreSyncLogic.computeSyncPlan(                       │      │
│  │   localSnapshot,   // ReadonlyMap (snapshot MUTADO)        │      │
│  │   remoteSnapshot,  // ReadonlyMap (snapshot MUTADO)        │      │
│  │   dbState,         // ReadonlyMap (estado base)            │      │
│  │   deviceId         // UUID del dispositivo actual           │      │
│  │ )                                                           │      │
│  │                                                             │      │
│  │ → Función PURA: sin I/O, sin DB, sin Drive                 │      │
│  │ → 100% testeable con datos mock                             │      │
│  │ → Usa índice case-insensitive para nombres de Drive         │      │
│  │                                                             │      │
│  │ SyncPlan {                                                  │      │
│  │   uploads:    {localPath, remoteName, remoteId?, vc}[]      │      │
│  │   downloads:  {remoteFile, localPath, vc}[]                 │      │
│  │   deleteLocal:  {localPath, remoteId}[]                     │      │
│  │   deleteRemote: {remoteId}[]                                │      │
│  │   conflicts:  {localPath, remoteFile, localVc, remoteVc}[]  │      │
│  │ }                                                           │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 4 — EJECUTAR PLAN (con Write-Ahead Log)               │      │
│  │                                                             │      │
│  │ 4a. executeUploads(plan.uploads)                            │      │
│  │     → sync_journal: INSERT 'upload_start'                   │      │
│  │     → Safe upload con header If-Match: etag                 │      │
│  │     → HTTP 412 Precondition Failed → conflicto              │      │
│  │     → sync_journal: UPDATE status='done'                    │      │
│  │     → Escribir vector clock en Drive appProperties          │      │
│  │                                                             │      │
│  │ 4b. executeDownloads(plan.downloads)                         │      │
│  │     → sync_journal: INSERT 'download_start'                 │      │
│  │     → Verificar integridad con md5Checksum                  │      │
│  │     → Escribir .syncmeta con remoteMtime (Android)          │      │
│  │     → sync_journal: UPDATE status='done'                    │      │
│  │                                                             │      │
│  │ 4c. executeDeletes(plan.deleteLocal, plan.deleteRemote)     │      │
│  │     → sync_journal: Registrar cada delete                   │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ FASE 5 — ACTUALIZAR DB (atómico)                            │      │
│  │                                                             │      │
│  │ db.updateBatch(pairId, plan.results)                        │      │
│  │ → BEGIN TRANSACTION                                         │      │
│  │ → Actualizar file_states con nuevos mtimes, vc, blockHashes │      │
│  │ → Incrementar vector clock para archivos subidos            │      │
│  │ → Guardar ETag para optimistic locking futuro               │      │
│  │ → Limpiar sync_journal (operaciones completadas)            │      │
│  │ → Garbage collection: eliminar huérfanos >30 días           │      │
│  │ → COMMIT                                                    │      │
│  │ → checkpoint() con atomic write + backup rotativo           │      │
│  └────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Schema SQLite

Compartido entre Desktop (`better-sqlite3`) y Android (`sql.js` WASM).

```sql
-- Tabla principal de estado de archivos
CREATE TABLE IF NOT EXISTS file_states (
    pair_id     TEXT NOT NULL,
    rel_path    TEXT NOT NULL,
    remote_id   TEXT,            -- Google Drive file ID
    local_mtime INTEGER,         -- epoch ms
    remote_mtime INTEGER,        -- epoch ms
    file_size   INTEGER,         -- bytes
    md5_hash    TEXT,            -- MD5 checksum
    block_hashes TEXT,           -- JSON: ["sha256-a1b2...", "sha256-c3d4..."]
    vector_clock TEXT NOT NULL,  -- JSON: {"device-uuid-1": 3, "device-uuid-2": 5}
    device_id   TEXT NOT NULL,   -- último dispositivo que escribió
    etag        TEXT,            -- ETag de Drive para optimistic locking + If-None-Match
    updated_at  INTEGER NOT NULL,-- epoch ms
    is_tombstone INTEGER DEFAULT 0, -- 1 = archivo borrado en ambos lados (GC en 30 días)
    PRIMARY KEY (pair_id, rel_path)
);

-- Write-Ahead Log de operaciones de sincronización
-- Permite recuperación tras crash: detectar operaciones huérfanas
CREATE TABLE IF NOT EXISTS sync_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_id     TEXT NOT NULL,
    action      TEXT NOT NULL,   -- 'upload_start' | 'download_start' | 'delete_remote_start' | 'delete_local_start'
    file_path   TEXT NOT NULL,
    remote_id   TEXT,            -- Drive file ID (si aplica)
    status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'failed'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_journal_pending ON sync_journal(pair_id, status);

-- Registro de dispositivos conocidos
CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,   -- 'linux' | 'android'
    last_seen   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_states_pair ON file_states(pair_id);
CREATE INDEX IF NOT EXISTS idx_file_states_tombstone ON file_states(is_tombstone, updated_at);
```

### PRAGMAs de rendimiento (Desktop)

```sql
PRAGMA journal_mode = WAL;       -- Write-Ahead Logging
PRAGMA busy_timeout = 5000;      -- Esperar 5s en vez de SQLITE_BUSY
PRAGMA synchronous = NORMAL;     -- Balance seguridad/rendimiento
PRAGMA foreign_keys = ON;        -- Integridad referencial
```

---

## 5. Plan de Implementación

### Diagrama de Dependencias

```
F0 (dependencias)
 └─ F1 (StorageBackend + sync_journal + atomic write + GC)
     ├─ F2 (VectorClock + DeviceIdentity)
     ├─ F3 (Scanner + Permission Gate + lazy hashing)
     └─ F4 (CoreSyncLogic.computeSyncPlan — función PURA)
            ├─ F5 (Desktop syncEngine.ts + reconciliación HTTP 304)
            └─ F6 (Android SyncEngine.ts + reconciliación)
               └─ F7 (Testing + Deploy + verificación anti-bucles)
```

---

### F0 — Dependencias y Configuración
**Tiempo**: ~30 min
**Objetivo**: Instalar paquetes, verificar compatibilidad, crear branch de feature

| Paso | Acción |
|---|---|
| F0.1 | `git checkout -b refactor/sync-v2 && git tag pre-v2-backup` |
| F0.2 | `npm install sql.js better-sqlite3` |
| F0.3 | `npm install @types/better-sqlite3 --save-dev` |
| F0.4 | Crear schema SQL con las 3 tablas en constante `CREATE_TABLE_SQL` |
| F0.5 | `npm run build` — verificar que sql.js compila para WebView Android |
| F0.6 | Probar `initSqlJs()` en navegador para confirmar WASM funciona |
| F0.7 | Agregar feature flag: `SYNCCLIENT_V2 = process.env.SYNCCLIENT_V2 === 'true'` |

---

### F1 — `src/shared/StorageBackend.ts`
**Tiempo**: ~1h 30min
**Tipo**: Archivo NUEVO (~350 líneas)
**Objetivo**: Abstracción de persistencia con 2 backends + WAL + atomic write + GC

```typescript
interface IStorageBackend {
  init(): Promise<boolean>;
  getFileState(pairId: string, relPath: string): FileState | null;
  setFileState(pairId: string, relPath: string, state: FileState): void;
  deleteFileState(pairId: string, relPath: string): void;
  getFolderState(pairId: string): Map<string, FileState>;
  updateBatch(pairId: string, updates: Map<string, FileState>): void;
  getDeviceInfo(deviceId: string): DeviceInfo | null;
  setDeviceInfo(deviceId: string, info: DeviceInfo): void;
  
  // --- Write-Ahead Log ---
  journalStart(pairId: string, action: string, filePath: string, remoteId?: string): number;
  journalDone(journalId: number): void;
  journalFail(journalId: number): void;
  getPendingJournalEntries(pairId: string): SyncJournalEntry[];
  
  // --- Mantenimiento ---
  vacuum(): void;            // Garbage collection de huérfanos >30 días
  checkpoint(): Promise<void>;// flush atómico a disco
}

// Implementación 1: SQLiteBackend
//   Desktop: driver = require('better-sqlite3')
//   Android: driver = await initSqlJs() (WASM)
//   Mismo SQL para ambos
//   Atomic write: write-to-tmp → integrity_check → rename(tmp→actual)
//   Backup rotativo: actual→.backup antes de sobreescribir

// Implementación 2: JSONBackend (fallback)
//   Lee/escribe sync_data.json (formato extendido)
//   Usado solo si SQLite no está disponible
```

**Atomic Write + Recuperación**:

```typescript
async function checkpoint(): Promise<void> {
  const data = db.export();
  const tmpPath = dbPath + '.tmp';
  const backupPath = dbPath + '.backup';
  
  // 1. Escribir a temporal
  await fs.writeFile(tmpPath, Buffer.from(data));
  
  // 2. Verificar integridad
  const testDb = new SQL.Database(new Uint8Array(await fs.readFile(tmpPath)));
  testDb.run('PRAGMA integrity_check');
  testDb.close();
  
  // 3. Renombrar atómicamente
  await fs.rename(dbPath, backupPath).catch(() => {});
  await fs.rename(tmpPath, dbPath);
  await fs.rm(backupPath).catch(() => {});
}

async function loadOrRecover(): Promise<SQL.Database> {
  try {
    return loadAndVerify(dbPath);
  } catch {
    try { return loadAndVerify(dbPath + '.backup'); } 
    catch { return new SQL.Database(); } // nuevo desde cero + migrar JSON
  }
}
```

**Garbage Collection**:

```sql
-- Ejecutar en cada updateBatch():
DELETE FROM file_states 
WHERE is_tombstone = 1 
  AND updated_at < ?;  -- Date.now() - 30 días
```

**Detección de plataforma**:

```typescript
function isCapacitor(): boolean {
  return typeof (window as any).Capacitor !== 'undefined';
}
```

---

### F2 — `src/shared/VectorClock.ts` + `src/shared/DeviceIdentity.ts`
**Tiempo**: ~1h 15min
**Tipo**: Archivos NUEVOS (~200 líneas combinados)
**Objetivo**: Resolución de conflictos + identidad que sobrevive reinstalaciones

#### VectorClock.ts (~120 líneas)

```typescript
interface VectorClock {
  [deviceId: string]: number;
}

class VectorClockManager {
  static compare(a: VectorClock, b: VectorClock): 
    'a_newer' | 'b_newer' | 'concurrent' | 'equal';

  static increment(clock: VectorClock, deviceId: string): VectorClock;

  static mergeForDedup(
    winner: VectorClock, 
    losers: VectorClock[], 
    deviceId: string
  ): VectorClock;

  // Dual-Source persistencia
  static toAppProperties(clock: VectorClock): Record<string, string>;
  static fromAppProperties(props: Record<string, string>): VectorClock | null;
  
  static resolveFromSources(
    driveProps: Record<string, string> | null,
    dbState: FileState | null,
    currentDeviceId: string
  ): VectorClock;
}
```

#### DeviceIdentity.ts (~80 líneas) — NUEVO

```typescript
// El device_id DEBE sobrevivir a reinstalaciones de la app.
// Si se pierde, todos los vector clocks anteriores quedan huérfanos.
async function getOrCreateDeviceId(
  db: IStorageBackend, 
  driveClient: DriveClient
): Promise<string> {
  // 1. Intentar DB local
  let deviceId = db.getDeviceInfo('self')?.deviceId;
  if (deviceId) return deviceId;
  
  // 2. Intentar recuperar de Drive (archivo oculto .syncclient_device_id)
  try {
    const sentinel = await driveClient.findFile('.syncclient_device_id');
    if (sentinel) {
      const content = await driveClient.downloadText(sentinel.id);
      deviceId = JSON.parse(content).deviceId;
    }
  } catch { /* no existe aún */ }
  
  // 3. Crear nuevo y persistir en Drive
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await driveClient.uploadText(
      '.syncclient_device_id', 
      JSON.stringify({ deviceId, name: getDeviceName(), platform: getPlatform() })
    );
  }
  
  // 4. Guardar en DB local
  db.setDeviceInfo('self', { deviceId, name: getDeviceName(), platform: getPlatform() });
  return deviceId;
}
```

---

### F3 — `src/shared/Scanner.ts`
**Tiempo**: ~1h
**Tipo**: Archivo NUEVO (~220 líneas)
**Objetivo**: Escaneo incremental con block hashing y Permission Gate

```typescript
const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB por bloque

// Calcular SHA-256 por bloques usando streams
function computeBlockHashes(filePath: string): Promise<string[]>;

// Quick check: número de bloques + hashes idénticos
function hasContentChanged(oldHashes: string[], newHashes: string[]): boolean;

// Normalizar a NFC + lowercase para índice
function normalizeFilename(name: string): string;
function normalizeForIndex(name: string): string; // .toLowerCase() adicional

// Tolerancia DST 1h ±5min
function isMtimeChanged(localMs: number, dbMs: number): boolean;

// Permission Gate
async function verifyReadWriteAccess(dir: string, fs: IFileSystem): Promise<boolean>;

// Escaneo incremental
async function scanChanges(
  dir: string,
  dbState: ReadonlyMap<string, FileState>,
  fs: IFileSystem,
  pairId: string
): Promise<ScanResult | 'PERMISSION_DENIED'> {
  // 1. readdir + Permission Gate
  // 2. Quick check (mtime, size, md5) vs dbState
  // 3. Lazy hashing en lotes de 5, concurrencia 2
  // 4. Progreso guardable, resume en reinicio
}
```

**Lazy Hashing**:
```
BATCH_SIZE = 5 archivos
CONCURRENCY = 2 workers

Para 100 archivos modificados:
  → 20 lotes × ~500ms/lote = ~10 segundos total
  → Progreso guardado después de cada lote
  → Si la app se cierra, continuar desde el último lote completado
```

---

### F4 — `src/shared/CoreSyncLogic.ts` — Extender
**Tiempo**: ~1h 30min
**Tipo**: Modificar archivo existente (159 → ~400 líneas)
**Objetivo**: Centralizar TODA la lógica de decisión como funciones PURAS

**Métodos existentes (sin cambios)**:
- `matchesIgnorePattern()`
- `parseNumberedFilename()`
- `groupAndSortDuplicates()`
- `isReadyForSync()`
- `normalizeRemotePath()`

**Nuevos métodos**:

```typescript
interface SyncPlan {
  uploads: Array<{
    localPath: string;
    remoteName: string;
    remoteId?: string;
    vectorClock: VectorClock;
  }>;
  downloads: Array<{
    remoteFile: RemoteEntry;
    localPath: string;
    vectorClock: VectorClock;
  }>;
  deleteLocal: Array<{
    localPath: string;
    remoteId?: string;
  }>;
  deleteRemote: Array<{
    remoteId: string;
  }>;
  conflicts: Array<{
    localPath: string;
    remoteFile: RemoteEntry;
    localVc: VectorClock;
    remoteVc: VectorClock;
  }>;
}

// FUNCIÓN PURA: sin I/O, sin DB, sin Drive. 100% testeable.
// localSnapshot: ReadonlyMap<string, LocalEntry> — inmutable
// remoteSnapshot: ReadonlyMap<string, RemoteEntry> — inmutable
// dbState: ReadonlyMap<string, FileState> — inmutable
static computeSyncPlan(
  localSnapshot: ReadonlyMap<string, LocalEntry>,
  remoteSnapshot: ReadonlyMap<string, RemoteEntry>,
  dbState: ReadonlyMap<string, FileState>,
  deviceId: string
): SyncPlan {
  // Construir índice case-insensitive para Drive
  // (Drive no permite dos archivos con mismo nombre y distinto case)
  const remoteByLowerName = new Map<string, RemoteEntry>();
  for (const [_, entry] of remoteSnapshot) {
    remoteByLowerName.set(entry.name.toLowerCase(), entry);
  }
  
  // Reglas:
  // 1. Archivo en local + en dbState → mtime/size/md5 cambió? → upload
  // 2. Archivo en remote + en dbState → mtime/size/md5 cambió? → download
  //    (solo si block hash confirma cambio real de contenido)
  // 3. Archivo en local + NOT en dbState + NOT en remoteIndex → upload (nuevo)
  // 4. Archivo en remote + NOT en dbState + NOT en localIndex → download (nuevo)
  // 5. Ambos existen → ambos cambiaron vs dbState?
  //    → VectorClock.compare() → ganador/concurrente/conflicto
  // 6. Archivo en dbState + NOT en local → deleteRemote
  // 7. Archivo en dbState + NOT en remote → deleteLocal
  // 8. Archivo con block hash idéntico → skip (solo actualizar mtime en DB)
}

static mergeClocksForDedup(
  winnerVc: VectorClock,
  loserVcs: VectorClock[],
  deviceId: string
): VectorClock;
```

**Testeabilidad**: Al ser función pura, los tests son triviales:

```typescript
test('archivo nuevo local → upload', () => {
  const local = new Map([['nuevo.pdf', { mtime: 100, size: 5000 }]]);
  const remote = new Map();
  const db = new Map();
  const plan = CoreSyncLogic.computeSyncPlan(local, remote, db, 'device-1');
  expect(plan.uploads).toHaveLength(1);
});

test('case-insensitive: Apuntes.pdf local vs apuntes.pdf remoto → mismo archivo', () => {
  const local = new Map([['Apuntes.pdf', { mtime: 100 }]]);
  const remote = new Map([['apuntes.pdf', { name: 'apuntes.pdf', mtime: 100 }]]);
  const db = new Map([['Apuntes.pdf', { localMtime: 50, remoteMtime: 50 }]]);
  const plan = CoreSyncLogic.computeSyncPlan(local, remote, db, 'd1');
  expect(plan.uploads).toHaveLength(0); // mismo archivo, no duplicar
});
```

---

### F5 — Desktop `src/backend/syncEngine.ts` — Refactor
**Tiempo**: ~2h 30min
**Tipo**: Modificar archivo existente (1725 → ~1400 líneas)
**Objetivo**: Migrar a nueva arquitectura con reconciliación HTTP 304

| # | Cambio |
|---|---|
| 5.1 | Reemplazar `manifests` por `this.db = createBackend()` |
| 5.2 | Migrar JSON → SQLite en `init()`. Atómico: solo borrar `manifests` del JSON si SQLite tiene ≥1 entrada |
| 5.3 | Inicializar device_id con `getOrCreateDeviceId(db, driveClient)` |
| 5.4 | `deduplicateLocalFolder(localDir, pairId, relativePrefix, localEntries?)` — acepta array opcional |
| 5.5 | `deduplicateDriveFolder(remoteId, pairId, relativePrefix, remoteFiles?)` — acepta array opcional |
| 5.6 | `markSelfWritten()` extendido a 30s para operaciones de dedup masivo |
| 5.7 | `listDriveFiles()` — incluir `etag, appProperties` en fields |
| 5.8 | `uploadDriveBinary()` — safe upload con `If-Match: etag` |
| 5.9 | **Reconciliación HTTP 304**: antes de sync, para cada archivo en dbState con remoteId y etag, hacer GET con `If-None-Match`. HTTP 304 = sin cambios (no consume cuota). HTTP 200 = actualizar dbState |
| 5.10 | `syncDirectoryTree()` — reordenar: Fase 0 (reconciliación) → Fase 1-5 |
| 5.11 | Cada operación en Fase 4 registrada en `sync_journal` (WAL) |
| 5.12 | `sync_journal` limpio al final del ciclo exitoso |
| 5.13 | Eliminar ~400 líneas de lógica de decisión ad-hoc |
| 5.14 | Manejar HTTP 412 → mover a pendingConflicts |
| 5.15 | `handleDriveResponse()` — añadir HTTP 412 y HTTP 304 |
| 5.16 | Feature flag: `if (!USE_V2_SYNC) return oldSyncDirectoryTree(...)` |

---

### F6 — Android `src/services/SyncEngine.ts` — Refactor
**Tiempo**: ~2h 30min
**Tipo**: Modificar archivo existente (1489 → ~1250 líneas)
**Objetivo**: Mismos cambios que Desktop con adaptaciones Capacitor

| # | Cambio | Diferencia con Desktop |
|---|---|---|
| 6.1 | `createBackend()` → `SQLiteBackend` con `sql.js` (WASM) | No usa `better-sqlite3` |
| 6.2 | `checkpoint()` → `db.export()` + atomic write + backup rotativo | WASM no persiste automáticamente |
| 6.3 | `getOrCreateDeviceId()` usa Capacitor Filesystem para Drive API | Misma lógica, distinto cliente HTTP |
| 6.4 | Reconciliación HTTP 304 con fetch | Igual que Desktop |
| 6.5 | `Scanner.verifyReadWriteAccess()` | Verifica permisos de storage en Android |
| 6.6 | `downloadDriveFile()` → `writeSyncmeta()` con `remoteMtime` | `utimes` no disponible en Capacitor |
| 6.7 | `hasLocalFolderChanged()` → `getLogicalMtime()` | `.syncmeta` sidecar |
| 6.8 | Ídem Desktop para dedup + syncDirectoryTree + sync_journal | Misma lógica |
| 6.9 | `listDriveFiles()` incluir `etag, appProperties` | Igual que Desktop |
| 6.10 | `uploadDriveFile()` con safe upload | ETag vía fetch headers |
| 6.11 | Manejar `PERMISSION_DENIED` → `pair.status = 'perm_denied'` | Nuevo estado |
| 6.12 | Feature flag | Igual que Desktop |

---

### F7 — Pruebas y Verificación
**Tiempo**: ~1h 30min
**Objetivo**: Validar que todo funciona y no hay regresiones

| # | Prueba | Tipo |
|---|---|---|
| 7.1 | `CoreSyncLogic.test.ts` — extender: computeSyncPlan (función pura, 15+ casos) | Unitario |
| 7.2 | `VectorClock.test.ts` — NUEVO | Unitario |
| 7.3 | `Scanner.test.ts` — NUEVO | Unitario |
| 7.4 | `StorageBackend.test.ts` — NUEVO: CRUD, atomic write, recovery, GC | Unitario |
| 7.5 | `DeviceIdentity.test.ts` — NUEVO: persistencia Drive, recuperación post-reinstall | Unitario |
| 7.6 | `npm run lint` — sin errores TypeScript | Integración |
| 7.7 | Verificación anti-bucles: ≥3 ciclos de polling consecutivos sin transferencias espurias | Integración |
| 7.8 | `npm run android:deploy` — desplegar en tablet física Lenovo TB370FU | E2E |
| 7.9 | StarNote export → autodetección → subida a Drive | E2E |
| 7.10 | Desktop descarga archivo subido por tablet | E2E |
| 7.11 | Simular crash durante sync → recuperación vía sync_journal | E2E |

---

## 6. Matriz de Riesgos y Mitigaciones

| # | Riesgo | Impacto | Probabilidad | Mitigación | Fase |
|---|---|---|---|---|---|
| **R1** | `appProperties` borrado por cliente externo | 🔴 Alto | 🟠 Media | Dual-Source VC: recuperar de SQLite y re-escribir en Drive | F2 |
| **R2** | `readdir` `[]` por pérdida de permisos Android | 🔴 Alto | 🟠 Media | `verifyReadWriteAccess()` → abortar, NO tocar DB | F3 |
| **R3** | Dos dispositivos suben simultáneamente | 🔴 Alto | 🟢 Baja | `If-Match: etag` → HTTP 412 → conflicto | F5, F6 |
| **R4** | Crash durante sync → DB inconsistente | 🔴 Alto | 🟡 Baja | Write-Ahead Log (`sync_journal`). Al reiniciar, detectar operaciones huérfanas y reconciliar | F1, F5 |
| **R5** | Corrupción SQLite por apagado durante `export()` | 🔴 Alto | 🟡 Baja | Atomic write (tmp → integrity_check → rename). Backup rotativo. `loadOrRecover()` | F1 |
| **R6** | Device ID perdido tras reinstalar app | 🟡 Medio | 🟠 Media | Persistir en Drive (`.syncclient_device_id`). Recuperar en init() | F2 |
| **R7** | Case-sensitivity: `Apuntes.pdf` vs `apuntes.pdf` | 🟡 Medio | 🟡 Baja | Índice por `name.toLowerCase()` en `computeSyncPlan` | F4 |
| **R8** | Block hashing lento primer scan (100GB, Android) | 🟡 Medio | 🟠 Media | Lazy hashing en lotes, progreso guardable, resume | F3 |
| **R9** | DB local obsoleta tras días offline | 🟡 Medio | 🟠 Media | Fase 0: reconciliación con `If-None-Match` (HTTP 304 = gratis) | F5, F6 |
| **R10** | Estados huérfanos acumulados en DB | 🟢 Bajo | 🟡 Media | Garbage collection: `is_tombstone=1` + 30 días → DELETE | F1 |
| **R11** | Dedup + Vector Clock ambigüedad | 🟡 Medio | 🟡 Baja | `mergeClocksForDedup()` | F4 |
| **R12** | Unicode NFC vs NFD | 🟢 Bajo | 🟡 Baja | `normalizeFilename('NFC')` en todos los puntos de entrada | F3 |
| **R13** | DST / zona horaria | 🟢 Bajo | 🟡 Baja | `isMtimeChanged()` con tolerancia 1h ±5min | F3 |
| **R14** | SQLite BUSY (Electron) | 🟢 Bajo | 🟢 Baja | WAL mode + busy_timeout=5000 | F1 |
| **R15** | Watcher post-dedup | 🟢 Bajo | 🟢 Baja | `markSelfWritten` 30s + `activeSyncs` + cooldown | F5 |
| **R16** | Drive API no soporta upload parcial | 🟡 Medio | ✅ 100% | Limitación de plataforma. Aceptada. Block hashing = DETECCIÓN, no transferencia | — |

---

## 7. Estructura de Archivos

### Antes vs Después

```
src/shared/
├── CoreSyncLogic.ts        159 → ~400 líneas (+241) [EXTENDIDO]
├── CoreSyncLogic.test.ts    ~80 → ~250 líneas (+170) [EXTENDIDO]
├── StorageBackend.ts       NUEVO (~350 líneas)
├── VectorClock.ts          NUEVO (~120 líneas)
├── VectorClock.test.ts     NUEVO (~80 líneas)
├── DeviceIdentity.ts       NUEVO (~80 líneas)
├── DeviceIdentity.test.ts  NUEVO (~60 líneas)
└── Scanner.ts              NUEVO (~220 líneas)

src/backend/
└── syncEngine.ts           1725 → ~1400 líneas (-325) [REFACTOR]

src/services/
└── SyncEngine.ts           1489 → ~1250 líneas (-239) [REFACTOR]
```

**Balance neto**: ~564 líneas duplicadas eliminadas, reemplazadas por ~770 líneas centralizadas en `src/shared/`. Cumple R3 del AGENTS.md.

---

## 8. Origen de Cada Patrón Arquitectónico

| Componente | Inspirado en | Años en prod. | Dónde en SyncClient v2 |
|---|---|---|---|
| **DB como source of truth** | Syncthing `internal/db` | 11 | `StorageBackend.ts` |
| **Three-way merge** | Git, Google Drive Client | 20+ | `CoreSyncLogic.computeSyncPlan()` |
| **Block-level content hashing** | Syncthing, rsync, ZFS | 25+ | `Scanner.computeBlockHashes()` |
| **Vector Clocks** | DynamoDB, Cassandra | 15+ | `VectorClockManager.compare()` |
| **Optimistic locking (ETag)** | HTTP/1.1 RFC 7232 | 25+ | `uploadDriveBinary()` con `If-Match` |
| **Conditional requests (HTTP 304)** | HTTP/1.1 RFC 7232 | 25+ | Reconciliación Fase 0 |
| **Write-Ahead Log** | SQLite, PostgreSQL, DBs en gral | 30+ | `sync_journal` table |
| **Atomic write** | SQLite, POSIX fs | 30+ | `checkpoint()` tmp→rename |
| **Echo cancellation** | Google Drive, Dropbox | 15+ | `markSelfWritten()` + cooldown |
| **Permission Gate** | Android best practices | 10+ | `Scanner.verifyReadWriteAccess()` |
| **Graceful degradation** | Patrón de resiliencia | 30+ | SQLite → JSON fallback |
| **Delta Index Exchange** | Syncthing BEP v1 | 11 | `Scanner.scanChanges()` |
| **CurrentFiler pattern** | Syncthing `lib/scanner` | 11 | Quick check antes de re-hashear |
| **Feature Flag** | Continuous Delivery | 15+ | `SYNCCLIENT_V2` env var |

---

## 9. Alternativas Free Analizadas

| Solución | ¿Resuelve el problema? | Conclusión |
|---|---|---|
| **Autosync for Google Drive** (Android) | No — no hace dedup de StarNote | ❌ |
| **FolderSync** (Android) | No — sin dedup específico | ❌ |
| **rclone bisync** (Linux) | Parcial — experimental, sin stubs | ⚠️ Riesgoso |
| **Syncthing** (P2P) | No usa Google Drive, no entiende StarNote | ❌ |
| **Google Drive oficial** | No existe cliente Linux. Android solo backup fotos | ❌ |
| **google-drive-ocamlfuse** | Solo monta, no sincroniza offline | ❌ |
| **SyncClient actual** | Sí, con bugs de bucles y stale data | ✅ Base para refactorizar |

---

## 10. Comparativa Syncthing vs SyncClient v2

| Capacidad | Syncthing | SyncClient v2 | Nota |
|---|---|---|---|
| DB como source of truth | ✅ LevelDB | ✅ SQLite (WASM/nativo) | Mismo patrón |
| Three-way merge | ✅ Global Model | ✅ `computeSyncPlan()` (puro) | Mismo patrón |
| Block hashing | ✅ 128KB-16MB | ✅ 4MB fijos | Adaptado a PDFs |
| Vector Clocks | ✅ | ✅ | Mismo patrón |
| Write-Ahead Log | ✅ DB transaccional | ✅ `sync_journal` | Mismo patrón |
| Conditional re-sync | ✅ Index Exchange | ✅ HTTP 304 (If-None-Match) | Mismo concepto |
| Transferencia parcial de bloques | ✅ BEP protocol | ❌ Drive API no lo permite | Limitación |
| Deduplicación StarNote | ❌ | ✅ `groupAndSortDuplicates()` | Exclusivo |
| Google Drive backend | ❌ | ✅ Drive API | Exclusivo |
| Modo streaming (stubs) | ❌ | ✅ `.vstream` | Exclusivo |
| Google Docs shortcuts | ❌ | ✅ `.gdoc`, `.gsheet` | Exclusivo |
| Device ID recovery | ❌ (P2P, no hay nube) | ✅ Drive `.syncclient_device_id` | Exclusivo |

---

## 11. Análisis de Hardware — Tablet Objetivo

### Lenovo TB370FU (Tab M10 Plus 3rd Gen)

| Componente | Valor | Implicación |
|---|---|---|
| **Modelo** | Lenovo TB370FU | Gama media-alta, 2023+ |
| **SoC** | MediaTek MT6877 (ARM64) | WASM sólido |
| **Android** | 15 (SDK 35) | Última versión |
| **RAM** | ~8GB total, ~4.1GB disponible | `sql.js` ~15-20MB |
| **Almacenamiento** | 107GB (41GB usado, 65GB libre) | DB ~5-50MB |
| **WebView** | Google WebView (Chromium) | WASM maduro |

### Capacidad de sql.js (WASM)

| Métrica | Valor |
|---|---|
| DB tamaño (10K archivos × 500B) | ~5 MB |
| Tiempo de carga | < 100ms |
| Query por primary key | < 1ms |
| `db.export()` | < 50ms |
| RAM usada | ~15-20 MB |

**Conclusión**: sql.js viable y eficiente. Sin plugin nativo necesario.

---

## 12. Dependencias y Ejecución

### Instalación

```bash
# Desktop + Android (compartido)
npm install sql.js

# Solo Desktop (nativo)
npm install better-sqlite3
npm install @types/better-sqlite3 --save-dev

# No se necesita capacitor-community/sqlite
# No se necesita modificar build.gradle
# No se necesita NDK
```

### Orden de Ejecución

```
F0 → F1 → F2 → F3 → F4 → F5 → F6 → F7
│    │     │     │     │     │     │     │
│    │     │     │     │     │     │     └─ ~1h 30min
│    │     │     │     │     │     └─ ~2h 30min
│    │     │     │     │     └─ ~2h 30min
│    │     │     │     └─ ~1h 30min
│    │     │     └─ ~1h (paralelizable con F2)
│    │     └─ ~1h 15min (paralelizable con F3)
│    └─ ~1h 30min
└─ ~30min

Total: ~13 horas
```

### Scripts

```bash
npm run lint                # TypeScript
npx vitest run src/shared/  # Tests unitarios
npm run android:deploy      # Deploy tablet
npm run electron:dev        # Desktop con hot reload
SYNCCLIENT_V2=true npm run dev  # Activar v2 (feature flag)
```

---

## 13. Estrategia de Rollback

Si F5 o F6 introducen regresión, revertir sin perder datos:

```bash
# Durante desarrollo — feature flag desactivable:
SYNCCLIENT_V2=false npm run dev

# Si hay bug en producción:
git checkout pre-v2-backup   # tag creado en F0.1
npm run android:deploy        # redeploy versión anterior
```

**Código**: feature flag en ambos motores:

```typescript
const USE_V2_SYNC = process.env.SYNCCLIENT_V2 === 'true' || import.meta.env.DEV;

async syncDirectoryTree(...) {
  if (!USE_V2_SYNC) return this.oldSyncDirectoryTree(...);
  return this.v2SyncDirectoryTree(...); // nueva implementación
}
```

El manifiesto JSON original se conserva durante la migración (solo se borra si SQLite tiene ≥1 entrada). Si hay que revertir, la versión anterior lee el JSON sin problemas.

---

## Apéndice A: Cumplimiento de AGENTS.md

| Regla | Cumplimiento |
|---|---|
| **R2** (Anti-bucles) | ✅ Heredados + snapshot post-dedup + block hashing + ETag + WAL |
| **R3** (Sincronizar ambos motores) | ✅ Lógica en `computeSyncPlan()` (pura). Sin duplicación |
| **R5** (Rate limiting) | ✅ 1 listDriveFiles/ciclo. HTTP 304 no consume cuota |
| **R6** (Integridad) | ✅ md5Checksum + block hashing + atomic write |
| **R9** (Escalabilidad 100GB+) | ✅ Scanner incremental + lazy hashing + GC de huérfanos |
| **R12** (Testing) | ✅ computeSyncPlan es función pura → 100% testeable sin mocks |
| **R13** (Multi-plataforma) | ✅ sql.js WASM + mismo schema SQL |

---

## Apéndice B: Glosario de Términos

| Término | Definición |
|---|---|
| **DB-Backed State** | SQLite como fuente de verdad, reemplaza manifiesto JSON |
| **Three-Way Merge** | Local vs Remote vs Base (DB). Sin ambigüedad |
| **Block-Level Content Hashing** | SHA-256 por bloques 4MB. Detecta cambios reales, no de mtime |
| **Vector Clock** | `{deviceA: N, deviceB: M}`. Resolución determinística de conflictos |
| **Dual-Source VC** | Vector clock en Drive `appProperties` + SQLite local |
| **Write-Ahead Log (WAL)** | `sync_journal`: registra operaciones antes de ejecutarlas. Recuperación tras crash |
| **Atomic Write** | tmp → integrity_check → rename. Sin corrupción por crash |
| **Permission Gate** | Verificar permisos antes de modificar DB |
| **Optimistic Locking (ETag)** | `If-Match: etag` → HTTP 412 si otro dispositivo modificó |
| **Conditional Request (HTTP 304)** | `If-None-Match: etag` → 304 si no cambió. No consume cuota de API |
| **Lazy Hashing** | Solo hashear archivos con quick check fallido. Lotes, progreso guardable |
| **Garbage Collection** | Eliminar `is_tombstone=1` tras 30 días |
| **Graceful Degradation** | SQLite → JSON fallback si WASM no disponible |
| **Echo Cancellation** | `markSelfWritten` + `activeSyncs` + cooldown |
| **SyncPlan** | Objeto con lista de acciones (uploads, downloads, deletes, conflicts) |
| **Feature Flag** | `SYNCCLIENT_V2` — activar/desactivar nueva implementación sin redeploy |

---

## Apéndice C: Decisiones de Diseño Clave

| Decisión | Alternativa rechazada | Razón |
|---|---|---|
| `sql.js` (WASM) para Android | `capacitor-community/sqlite` | Sin config nativa, mismo schema |
| 4MB block size | 128KB (Syncthing) | PDFs grandes → menos bloques |
| ETag + HTTP 304 | Sin reconciliación | HTTP 304 no consume cuota API |
| Write-Ahead Log (`sync_journal`) | Sin WAL | Crash durante sync = DB inconsistente |
| Device ID en Drive | Solo local storage | Reinstalación = pérdida de clocks |
| `computeSyncPlan` función pura | Acoplado a DB | Testeable sin mocks |
| Case-insensitive index | Sin normalización | `Apuntes.pdf` ≠ `apuntes.pdf` en Drive |
| Atomic write + backup | `fs.writeFile` directo | Corrupción si crash durante write |
| Garbage collection 30 días | Sin GC | DB crece indefinidamente |
| Feature flag `SYNCCLIENT_V2` | Sin flag | Sin rollback rápido |
| JSON fallback | IndexedDB | IndexedDB async, schema distinto |
| Tolerancia DST 1h | Sin tolerancia | Falsos positivos en cambio de zona |

---

*Documento generado el 30 de Julio de 2026. Versión 2.1.0 con 8 mejoras tras revisión crítica. Para referencia durante la implementación.*