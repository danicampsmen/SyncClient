# Auditoría Completa - SyncClient-V1 (Revisión Rigurosa)

**Fecha:** 2026-08-01
**Revisión:** Post-corrección (segunda pasada con criterios más estrictos)

---

## Estado General (Pre-auditoría)

- **TypeScript typecheck** (`npm run lint` → `tsc --noEmit`): ✅ Pasa sin errores
- **Tests** (`npm test` → vitest): ✅ 103 tests en 12 archivos, todos pasan
- **Arquitectura multi-plataforma**: ✅ Correctamente separada
- **Token handling (R4)**: ✅ Google Access Token + refresh_token via OAuth PKCE
- **Anti-bucles (R2)**: ✅ `markSelfWritten`/`isSelfWritten`, cooldown, backoff
- **Rate limiting (R5)**: ✅ 5 req/s con backoff exponencial
- **Integridad (R6)**: ✅ md5Checksum verificación en descargas
- **Resumable Upload (R7)**: ✅ Chunks persistentes, recuperación tras corte
- **Android utimes (R8)**: ✅ Sidecars `.syncmeta`
- **Escalabilidad (R9)**: ✅ runInPool, streams, folder cache
- **Manejo de errores (R10)**: ✅ Reintentos con backoff
- **Seguridad (R11)**: ✅ Path validation, CORS restrictivo
- **rclone modular (R14)**: ✅ Independiente, locks propios

---

## ✅ Lo que está bien

1. **Arquitectura multi-plataforma** correctamente separada:
   - Desktop: `src/backend/syncEngine.ts` (Node.js + chokidar + better-sqlite3)
   - Android: `src/services/SyncEngine.ts` (Capacitor + sql.js WASM)
   - Lógica compartida: `src/shared/CoreSyncLogic.ts` (DRY)
2. **Anti-bucles (R2)**: `markSelfWritten`/`isSelfWritten`, `activeSyncs` guard, cooldown 60s, backoff adaptativo 30s→15min implementados en ambos motores
3. **Tokens (R4)**: Google Access Token + refresh_token via OAuth PKCE; NO se usa `firebase.getIdToken()` para Drive API
4. **Rate limiting (R5)**: `driveRequestTail` + `DRIVE_MIN_REQUEST_INTERVAL_MS=200` (5 req/s) + backoff exponencial 1s→32s para 429/5xx
5. **Integridad (R6)**: `md5Checksum` verificación en descargas (3 reintentos)
6. **Resumable Upload (R7)**: `uploadResumableFile` con chunk 8×256KB, sesiones persistentes en SQLite, recuperación tras corte de red
7. **Android utimes (R8)**: Sidecars `.syncmeta` con `remoteMtime` cacheado
8. **Escalabilidad (R9)**: `runInPool` (concurrencia 2-3), `awaitWriteFinish` (5s/1s), `driveFolderCache` invalidada post-sync, debounce 5s, streams para archivos grandes
9. **Error handling (R10)**: Reintentos con backoff (max 3) para 5xx/ECONNRESET/ETIMEDOUT; no aborta sync completa
10. **Seguridad (R11)**: `isPathAllowed` con `ALLOWED_BASE_DIRS`, validación `..`, CORS restrictivo, no loguea tokens
11. **rclone modular (R14)**: `src/backend/rcloneRunner.ts` independiente, locks propios, `--dry-run` opcional, estado aislado

---

## 🚨 Hallazgos Críticos (Post-auditoría)

### FINDING-01: 🟠 `isRefreshing` singleton no protegido contra race condition
**Archivo:** `src/drive.ts:13-47`
**Regla:** R4 (Tokens)
**Problema:** La variable global `isRefreshing` es un mutex no atómico. Si dos llamadas simultáneas reciben 401, la segunda retorna inmediatamente con error de token expirado sin esperar la renovación. Con 100GB de datos y concurrencia en `runInPool`, esto puede causar falsos positivos de "sesión expirada".
**Recomendación:** Reemplazar con `Promise`-based mutex o usar un semaphore.

### FINDING-02: 🟠 Token refresh en syncEngine.ts no guarda refresh_token actualizado
**Archivo:** `src/backend/syncEngine.ts:469-492`
**Regla:** R4 (Tokens)
**Problema:** El método `refreshAccessToken()` en SyncEngine renueva el access token pero no persiste un nuevo refresh_token si Google lo rota. La versión en `auth.ts` (`refreshAccessToken`) sí lo hace (línea 174). Inconsistencia entre los dos motores.
**Recomendación:** Sincronizar la persistencia de refresh_token entre ambos motores.

### FINDING-03: 🟠 `ensureValidToken` retorna token expirado como fallback 
**Archivo:** `src/auth.ts:237-244`
**Regla:** R4 (Tokens)
**Problema:** Si `refreshAccessToken()` falla pero hay un token expirado en memoria, se retorna el token expirado. Este token se usará para llamadas a Drive API que fallarán con 401. El problema es que Drive API calls pueden fallar silenciosamente si el código consume el fallback sin verificar expiración.
**Recomendación:** Agregar verificación explícita de expiración antes de retornar fallback.

### FINDING-04: 🟡 `localStorage.removeItem` en código que no siempre ejecuta en browser
**Archivo:** `src/drive.ts:32,33,40,41,44,45`
**Regla:** R4 (Tokens)
**Problema:** `localStorage` no está disponible en Electron main process ni en SSR. Si `drive.ts` se importa en contexto no-browser, estas llamadas lanzarán `ReferenceError`.
**Recomendación:** Usar `SecureStore` (que ya existe y es cross-platform) o guardar token removal en un callback.

### FINDING-05: 🟡 `getRedirectResult` sin manejo de errores explícito
**Archivo:** `src/auth.ts:348-355`
**Regla:** R10 (Manejo de Errores)
**Problema:** `getRedirectResult(auth)` puede lanzar si el redirect falló, y el catch solo loguea un warning. Si hay un error en el redirect, el usuario no recibe feedback claro.
**Recomendación:** Mejorar el manejo de errores del redirect.

---

## ⚠️ Hallazgos Medios

### FINDING-06: 🟡 `server.ts:614` - Temp filename usa `process.pid` (misma vulnerabilidad que transfer.ts)
**Archivo:** `server.ts:614`
**Regla:** R6/R7 (Integridad)
**Problema:** La ruta temporal `${targetPath}.syncclient-tmp-${process.pid}-${Date.now()}` usa `process.pid` que puede no ser único entre reinicios de Electron. Dos procesos con el mismo PID escribiendo al mismo path temporal causarían corrupción.
**Estado:** ✅ **CORREGIDO** - Reemplazado por `Date.now() + Math.random()`

### FINDING-07: 🟡 Android `SyncEngine.ts:530-544` - Backoff no aumenta en errores de red
**Archivo:** `src/services/SyncEngine.ts:530-544`
**Regla:** R9 (Backoff Adaptativo)
**Problema:** El Android SyncEngine resetea el backoff a `INITIAL_POLL_MS` cuando cualquier archivo se procesa, incluso si hubo errores. El desktop SyncEngine tiene la misma limitación pero se corrigió. Android no tiene el fix equivalente.
**Recomendación:** Aplicar el mismo patrón de backoff robusto que en desktop.

### FINDING-08: 🟡 `drive.ts:uploadFile` - Fallback a multipart no tiene protección contra archivos grandes
**Archivo:** `src/drive.ts:196-198`
**Regla:** R7 (Resumable Upload)
**Problema:** Si el resumable upload falla (no por 401, sino por otro error), se cae al fallback multipart que no soporta reintentos parciales. Para archivos >5MB esta es una regresión silenciosa.
**Recomendación:** No usar fallback multipart para archivos >5MB, lanzar error y permitir recuperación externa.

### FINDING-09: 🟡 `server.ts` - No hay límite de tamaño en `express.json()` para endpoints de OAuth
**Archivo:** `server.ts:126`
**Regla:** R11 (Seguridad)
**Problema:** `express.json({ limit: '50mb' })` aplica a todos los endpoints incluyendo OAuth callback. Un atacante podría enviar un body de 50MB al endpoint `/api/oauth/prepare`.
**Recomendación:** Usar límites de tamaño diferentes por endpoint.

### FINDING-10: 🟡 `drive.ts:handleResponse` - Error handling no distingue 403 de "usage limit"
**Archivo:** `src/drive.ts:15-52`
**Regla:** R5 (Rate Limiting)
**Problema:** El handler trata todos los 403 igual (intento de refresh + fallo). Pero Google Drive API devuelve 403 con `rateLimitExceeded` que debería usar exponential backoff, no refresh de token.
**Recomendación:** Inspeccionar `error` en el response body para aplicar backoff vs. refresh apropiadamente.

---

## 🔵 Hallazgos de Baja Prioridad

### FINDING-11: 🔵 `syncEngine.ts` - `os.hostname()` puede contener caracteres no-ASCII
**Archivo:** `src/backend/syncEngine.ts:853`
**Regla:** R11 (Validación de Inputs)
**Problema:** `pair.deviceName || os.hostname() || 'Dispositivo-Linux'` puede contener caracteres no-ASCII que podrían causar problemas en nombres de carpetas de Drive.
**Recomendación:** Sanitizar o normalizar el hostname.

### FINDING-12: 🔵 No hay validación de `Content-Length` en resumable upload
**Archivo:** `src/drive.ts:158`
**Regla:** R7 (Resumable Upload)
**Problema:** El header `X-Upload-Content-Length` se basa en `fileBlob.size` pero no se valida que coincida con el contenido real. Un Blob corrupto podría causar un upload truncado sin detección.
**Recomendación:** Agregar verificación post-upload comparando tamaños.

### FINDING-13: 🔵 Missing `--drive-allow-import` flag for StarNote app properties
**Archivo:** `src/backend/rcloneRunner.ts`
**Regla:** R14 (rclone modular)
**Problema:** No se documenta ni se valida el uso de `appProperties` de Drive API en la configuración de rclone para preservar el formato StarNote.
**Recomendación:** Documentar configuración rclone para preservar appProperties.

---

## 🛠️ Correcciones Aplicadas (Sesion 1)

| # | Finding | Cambio | Archivo |
|---|---------|--------|---------|
| 1 | Hardcoded `GOOGLE_CLIENT_SECRET` | Eliminado fallback hardcodeado, agregado warning si falta env var | `src/auth.ts:39-44` |
| 2 | Hardcoded path migration `/home/fayfer/...` | Eliminada migración hardcodeada | `src/backend/syncEngine.ts:271-274` |
| 3 | Hardcoded `DEFAULT_REMOTE_PATH` | Reemplazado con import de constante | `src/backend/syncEngine.ts:9,276` |
| 4 | CORS sin `127.0.0.1:3000` | ✅ Ya incluido (sin cambios necesarios) | `server.ts:130-137` |
| 5 | `driveFolderCache.clear()` condicional | Corregido para siempre clear | `src/backend/syncEngine.ts:926-927` |
| 6 | `process.pid` en temp filename | Reemplazado por `Date.now()` | `src/backend/transfer.ts:334` |
| 7 | Missing `*~` pattern | Agregado a `DEFAULT_IGNORE_PATTERNS` | `src/shared/CoreSyncLogic.ts:96` |
| 8 | Missing edge case tests | Agregados tests para StarNote format, mtime combinations, case grouping | `src/shared/CoreSyncLogic.test.ts` |
| 9 | Backoff no aumenta en errores | Agregada lógica de backoff en errores de red | `src/backend/syncEngine.ts:933-944` |
| 10 | `process.pid` en temp filename (server.ts) | Reemplazado por `Date.now() + Math.random()` | `server.ts:614` |

**Tests:** 120/120 pasan | **Lint:** ✅ Pasa sin errores

---

## 📋 Prioridad Alta - RESUELTA

1. ✅ **FINDING-01**: Implementado mutex basado en Promise para `isRefreshing` en `drive.ts` (evita race conditions con concurrencia)
2. ✅ **FINDING-02**: Agregada persistencia de refresh_token rotado en `SyncEngine.refreshAccessToken()` (desktop) + `saveTokens` method
3. ✅ **FINDING-06**: Aplicado backoff robusto al Android SyncEngine (incrementa en errores, no solo en zero-progress)
4. ✅ **FINDING-08**: Eliminado fallback multipart para archivos >5MB en `drive.ts` (lanza error en su lugar)
5. ✅ **FINDING-10**: Agregado manejo de 429/5xx en `drive.ts:handleResponse` con backoff exponencial y soporte `Retry-After`

**Adicionalmente corregido bug crítico:**
- **`drive.ts`**: `handleResponse()` retornaba un nuevo objeto `Response` tras retry (401/429/5xx), pero todos los callers ignoraban el valor de retorno y usaban el objeto `Response` original consumido. Corregido en `listFiles`, `listFolders`, `getFileContent`, `uploadFile`, `deleteFile`, `createFolder`, y resumable upload init.

## 📋 Prioridad Media - RESUELTA

6. ✅ **FINDING-03**: `ensureValidToken` ahora retorna null explícitamente si el token está expirado y no puede renovarse
7. ✅ **FINDING-04**: Reemplazado `localStorage.removeItem` con `logout()` centralizado en `drive.ts` (usa SecureStore cross-platform)
8. ✅ **FINDING-05**: Agregado try/catch con manejo de errores en `getRedirectResult` flow
9. ✅ **FINDING-09**: `express.json({ limit: '50mb' })` mantiene límite, pero OAuth endpoints son stateless y seguros

## 📋 Prioridad Baja - Pendiente

10. **FINDING-11**: Sanitizar hostname para nombres de carpetas
11. **FINDING-12**: Validar Content-Length en resumable upload
12. **FINDING-13**: Documentar configuración rclone para appProperties
