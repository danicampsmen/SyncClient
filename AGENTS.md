# AGENTS.md — Directivas para Agentes de IA en SyncClient

## Identidad del Proyecto

SyncClient reemplaza al cliente oficial de Google Drive de Windows para **Linux (Ubuntu/Electron)** y **Android (tablets/celulares vía Capacitor)**.

## Caso de Uso Principal

1. **Tablet Android (StarNote)**: Subir automáticamente PDFs exportados a Google Drive.
2. **Celular Android**: Descargar la última versión de los apuntes para consulta offline.
3. **Linux Desktop (Ubuntu)**: Bisincronización completa de ~100GB (PDFs, .tex, proyectos).

---

## 🔴 Reglas Críticas (Violarlas rompe la app)

### R1: Precisión Técnica con Fuentes Oficiales
- Google Drive API: https://developers.google.com/drive/api/reference/rest/v3
- Google OAuth: https://developers.google.com/identity/protocols/oauth2
- Chokidar: https://github.com/paulmillr/chokidar
- Firebase Auth: https://firebase.google.com/docs/auth
- **NUNCA inventar endpoints, parámetros o comportamientos de API.**

### R2: Anti-Bucles de Sincronización
- Toda escritura local hecha por el motor DEBE llamar `markSelfWritten()`.
- Todo evento del watcher DEBE verificar `isSelfWritten()` y `activeSyncs` antes de actuar.
- El cooldown post-sincronización (`SYNC_COOLDOWN_MS = 60000`) es obligatorio para triggers por polling.
- El backoff adaptativo (30s → 60s → ... → 15min) debe respetarse.
- **NUNCA debilitar estos mecanismos sin un reemplazo equivalente.**

### R3: Sincronizar Ambos Motores (Desktop ↔ Android)
- `src/backend/syncEngine.ts` (Desktop Linux, Node.js) — ~1621 líneas.
- `src/services/SyncEngine.ts` (Android, Capacitor) — ~1296 líneas.
- **TODO cambio en uno DEBE reflejarse en el otro.** Actualmente el motor Android carece de `selfWrittenFiles`, `syncBackoff`, `SYNC_COOLDOWN_MS` y `syncTriggerSource` — esto es un bug que causa bucles en Android.
- Lógica compartida va en `src/shared/CoreSyncLogic.ts`. No duplicar.

### R4: Tokens — Firebase ≠ Google Drive
- `firebase.auth().getIdToken()` devuelve un **Firebase ID Token** (para Firebase services).
- La Google Drive API requiere un **Google Access Token** (obtenido solo durante OAuth inicial con `GoogleAuthProvider.credentialFromResult()`).
- **NUNCA usar `getIdToken()` para autenticar llamadas a Drive API.** Son tokens distintos.
- Para renovar el Google Access Token: usar `POST https://oauth2.googleapis.com/token` con el `refresh_token`.

### R5: Rate Limiting de Google Drive API
- Cuota: 10,000 requests/100s por usuario, 1,000 requests/100s por proyecto.
- Toda llamada a Drive API debe manejar HTTP 429 con exponential backoff: 1s → 2s → 4s → 8s → máx 32s.
- Implementar rate limiter local: máximo 5 requests/segundo.
- Con 100GB de datos, las llamadas recursivas a `listDriveFiles()` pueden agotar la cuota rápidamente.

---

## 🟡 Reglas de Alta Prioridad

### R6: Integridad de Archivos
- Al descargar, verificar `md5Checksum` del metadata de Drive contra el hash local.
- Si no coincide, reintentar la descarga (máx 3 intentos).
- Archivos corruptos silenciosos son inaceptables con 100GB.

### R7: Resumable Upload para Archivos Grandes
- Archivos > 5MB DEBEN usar `uploadType=resumable` (`POST /upload/drive/v3/files?uploadType=resumable`).
- No usar subida simple/multipart para archivos grandes (un fallo de red pierde todo el progreso).
- Documentación: https://developers.google.com/drive/api/guides/manage-uploads#resumable

### R8: Estrategia `utimes` en Android
- Capacitor no soporta `utimes` (cambiar mtime de archivos).
- Solución: almacenar el mtime remoto en un archivo sidecar `.syncmeta` junto a cada archivo descargado.
- La comparación de cambios debe usar el `.syncmeta`, no el mtime real del sistema de archivos en Android.

### R9: Escalabilidad para 100GB+
- I/O concurrente máximo 2-3 operaciones (`runInPool`).
- `awaitWriteFinish` con `stabilityThreshold: 5000` y `pollInterval: 1000`.
- Caché de carpetas (`driveFolderCache`) invalidada tras cada sincronización.
- Debounce de eventos del watcher: 5 segundos.
- Usar streams para archivos grandes, nunca cargar archivos completos en memoria.

### R10: Manejo de Errores de Red
- Reintentos con exponential backoff (máx 3) para errores 5xx, ECONNRESET, ETIMEDOUT, ENOTFOUND.
- No abortar toda la sincronización por un error de red en un solo archivo.

---

## 🟢 Reglas de Media Prioridad

### R11: Seguridad
- Validar todos los inputs con `isPathAllowed()`, `isValidString()`, `isValidArray()` (definidos en `server.ts`).
- Prevenir path traversal: rechazar rutas con `..` y validar contra `ALLOWED_BASE_DIRS`.
- Nunca loguear tokens en consola.
- CORS restringido a orígenes locales de confianza.

### R12: Testing
- Agregar tests unitarios para:
  - `matchesIgnorePattern()` con casos borde.
  - `parseNumberedFilename()` con formatos de StarNote.
  - `groupAndSortDuplicates()` con timestamps iguales.
  - Detección de conflictos con combinaciones de mtimes.
- Antes de marcar una tarea como completada, verificar con logs que ≥3 ciclos de polling no producen bucles.

### R13: Consistencia Multi-Plataforma
- Para operaciones no soportadas en Android, delegar al PC vía HTTP (patrón relay).
- Probar cambios en las 3 plataformas: Linux Desktop, Android Tablet, Android Celular.

---

## Estructura de Archivos Clave

| Archivo | Rol |
|---|---|
| `src/backend/syncEngine.ts` | Motor principal (Desktop Linux) |
| `src/services/SyncEngine.ts` | Motor nativo (Android Capacitor) |
| `src/shared/CoreSyncLogic.ts` | Lógica compartida (dedup, ignore) |
| `src/services/syncService.ts` | Abstracción desktop ↔ nativo |
| `server.ts` | Servidor Express + API REST |
| `src/auth.ts` | Firebase Auth + Google OAuth |
| `src/drive.ts` | Cliente Google Drive API (web) |

## Glosario

- **Par**: Asociación carpeta local ↔ carpeta remota en Drive.
- **Manifiesto**: Registro de timestamps local/remoto por archivo para detectar cambios.
- **Stub (.vstream)**: JSON de ~1KB que referencia un archivo real en Drive (modo streaming).
- **Resumable Upload**: Subida en chunks para archivos >5MB.
- **Deduplicación**: Detectar `archivo(1).pdf`, `archivo(2).pdf` → conservar solo el más reciente.
- **Sidecar `.syncmeta`**: Archivo JSON con metadata remota para suplir `utimes` en Android.

## Scripts Clave

| Comando | Uso |
|---|---|
| `npm run dev` | Iniciar servidor backend (desarrollo) |
| `npm run electron:dev` | Electron + backend simultáneos |
| `npm run android:deploy` | Build + desplegar a Android + ADB reverse |
| `npm run lint` | Verificar tipos TypeScript |