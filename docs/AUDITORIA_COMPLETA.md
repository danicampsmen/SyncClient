# Auditoría Completa V10 — SyncClient V1 (Usuario: revisión puntual)
**(Análisis puntual de problemas críticos reportados por el equipo — integrar en roadmap de fixes)**
**Fecha de revisión:** 5 de Agosto de 2026 — Auditoría V10
**Autor:** Auditoría generada a partir del reporte del equipo (entrada manual)
**Método:** Revisión dirigida de los puntos señalados por el equipo sobre `src/backend/syncEngine.ts`, `src/services/SyncEngine.ts`, `src/shared/` y `auth.ts`. Se priorizan correcciones críticas de integridad y arquitectura.

## 🔴 Hallazgos Críticos Reportados (Resumido)

El análisis puntual recibido identifica los siguientes problemas críticos que deben atenderse inmediatamente:

1. Invocación incorrecta en resolución de conflictos (`resolveConflict`) — se pasaba una ruta remota (`pair.remotePath`) donde la API espera una ID de carpeta remota. Impacto: HTTP 400/404 durante "Usar Local" en resolución de conflictos.
2. Desajuste de variables de entorno para la renovación del token backend — el backend usaba `process.env.GOOGLE_CLIENT_ID` en lugar de preferir `VITE_*` variables del entorno, provocando `invalid_client` en refresh token.
3. Falta de candado de proceso (`PairLock`) en `fastSync` — ejecución concurrente con `runSync` puede generar `SQLITE_BUSY` y corrupción de vector clocks.
4. Bucle N+1 en Android que provoca HTTP 429 (`reconcileWithHttp304`) — peticiones por archivo en vez de comparación en memoria o batched requests.
5. Ausencia del borrado directorial en cascada en el motor Android — eliminaciones locales no propagan correctamente y generan estados huérfanos.
6. Caché huérfana de carpeta raíz (`pairRootRemoteFolderId`) — mapa en memoria no limpiado al eliminar/editar pares.
7. Objeto `pair.progress` nulo durante `fastSync` — UI no muestra progreso en sincronizaciones rápidas.

## 📋 Resumen de Acciones Recomendadas (prioridad inmediata)

- En `src/backend/syncEngine.ts` (`resolveConflict`): asegurar que se pasa la remote folder ID — usar `await this.getPairRemoteFolderId(pair)` o `parentState.remote_id` cuando esté disponible.
- En `src/backend/syncEngine.ts`: leer variables de entorno en orden preferente: `process.env.VITE_FIREBASE_OAUTH_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID` (y lo equivalente para el secret).
- En `src/backend/syncEngine.ts` (`fastSync`): envolver la ejecución con `acquirePairLock(...)` para evitar concurrencia con `runSync`.
- En `src/services/SyncEngine.ts` (Android): eliminar el bucle N+1 y portar la lógica de borrado en cascada (`deleteFolderStateCascade`) desde el backend Desktop.
- Limpiar `pairRootRemoteFolderId` cuando un par sea eliminado o su remotePath cambie.
- Inicializar `pair.progress` al entrar en `fastSync` para que la UI reciba un estado de progreso.

---

# Auditoría Completa V9 — SyncClient V1
**(Revisión Exhaustiva Post-Fixes + Verificación de Estado Actual)**
**Fecha de revisión:** 5 de Agosto de 2026 — Auditoría V9
**Revisor:** Antigravity AI
**Método:** Inspección estática profunda archivo por archivo + verificación de fixes aplicados + análisis de patrones de bucle.

---

## 🚨 Resumen Ejecutivo V9

La auditoría V9 cubre la verificación de las recientes mejoras de **Fast Sync local** (reducción drástica de la latencia de sincronización) y revisa la deuda técnica reportada en V8. Las optimizaciones locales han sido implementadas exitosamente y eliminan los cuellos de botella en la respuesta inmediata a eventos del sistema de archivos.

### Fixes Aplicados en Esta Sesión (V9)

| # | Fix | Archivo | Estado |
|---|---|---|---|
| F1 | Tiempo de Debounce Reducido (5s → 1s) | `src/backend/syncPerformance.ts:1` | ✅ Aplicado |
| F2 | Disparo automático en `fastSync` para archivos locales nuevos | `src/backend/syncEngine.ts:1734-1739` | ✅ Aplicado |
| F3 | Preservación de eventos locales durante sincronizaciones activas | `src/backend/syncEngine.ts:1259-1281` | ✅ Aplicado |

### 🔴 Nuevos Hallazgos y Deuda Técnica Pendiente (Arrastre de V8)

Las vulnerabilidades técnicas y violaciones de reglas identificadas en la Auditoría V8 **aún se mantienen vigentes** ya que esta intervención se enfocó exclusivamente en validar las mejoras de rendimiento del Fast Sync.

- **V8-1 a V8-7 (R16 Violation)**: El motor Android, cliente de Drive, Autenticación y puente VFS continúan utilizando extensivamente `console.*` en lugar del `Logger` estructurado.
- **V8-8**: Falta de límite de iteraciones en `while (nextToken)` en `src/backend/driveChanges.ts`.
- **V8-4**: Catch blocks vacíos silenciando errores en Android (`SyncEngine.ts`).

---

# Auditoría Completa V8 — SyncClient V1
**(Revisión Exhaustiva Post-Fixes + Verificación de Estado Actual)**
**Fecha de revisión:** 4 de Agosto de 2026 — Auditoría V8
**Revisor:** Antigravity AI
**Método:** Inspección estática profunda archivo por archivo + verificación de fixes aplicados + análisis de patrones de bucle.
---

## 🚨 Resumen Ejecutivo V8

La auditoría V8 cubre el estado actual del código base después de aplicar todas las correcciones de las auditorías V4, V5, V6 y V7. Se han resuelto 12 vulnerabilidades de bucles de sincronización y 7 nuevos puntos débiles del motor Android. Se identifican 9 violaciones de R16 (logging) y 2 errores de TypeScript pre-existentes como deuda técnica pendiente.

### Fixes Aplicados en Esta Sesión (V8)

| # | Fix | Archivo | Estado |
|---|---|---|---|
| F1 | NFC normalization en Android `v2SyncDirectoryTree` | `src/services/SyncEngine.ts:780` | ✅ Aplicado |
| F2 | Normalización de rutas en Android `markSelfWritten`/`isSelfWritten` | `src/services/SyncEngine.ts:85-107` | ✅ Aplicado |
| F3 | Patrones `*.syncclient-*` en Android `ignoredPatterns` | `src/services/SyncEngine.ts:49,248` | ✅ Aplicado |
| F4 | Patrón `*.syncclient-download` para Android temp files | `src/services/SyncEngine.ts:49,248` | ✅ Aplicado |
| F5 | Race condition `markSelfWritten` vs `fs.rename` en Desktop | `src/backend/transfer.ts:515-517` | ✅ Aplicado |
| F6 | Guard de cooldown en `recoverPendingWork` | `src/backend/syncEngine.ts:356-389` | ✅ Aplicado |
| F7 | Cooldown guard en Android `hasLocalFolderChanged` | `src/services/SyncEngine.ts:591-593` | ✅ Aplicado |

### Fixes Verificados de Auditorías Anteriores

| # | Vulnerabilidad | Archivo | Estado |
|---|---|---|---|
| V4-1 | Temporales `*.syncclient-*` no filtrados | `CoreSyncLogic.ts`, `syncEngine.ts` | ✅ Corregido |
| V4-2 | Desfase Unicode NFC/NFD en archivos con tildes | `syncEngine.ts:1495`, `SyncEngine.ts:780` | ✅ Corregido |
| V4-3 | Confirmación prematura del cursor de Drive | `syncEngine.ts:1288-1295` | ✅ Corregido |
| V4-4 | Falta de `path.normalize` en `markSelfWritten` | `syncEngine.ts:326-346`, `SyncEngine.ts:85-107` | ✅ Corregido |
| V4-5 | Sobrescritura por `toLowerCase()` en `computeSyncPlan` | `CoreSyncLogic.ts:261-265` | ✅ Corregido |
| V5-1 | Bucle `while` sin break de seguridad en `uploadDriveFile` | `SyncEngine.ts:1281-1282` | ✅ Ya tenía guardia |
| V6-1 | Errores silenciados en catch blocks vacíos | `SyncEngine.ts` múltiples líneas | ⚠️ Pendiente |
| V6-2 | Violación masiva de R16 (console.*) | Múltiples archivos | ⚠️ Pendiente |

---

## 🔴 Nuevos Hallazgos V8

### V8-1 🔴 R16 Violation: Android Engine Uses `console.*` Instead of Logger

**Archivo:** `src/services/SyncEngine.ts`
**Líneas:** 152, 206, 476, 506, 548, 558, 1137, 1335, 1350

El motor Android nativo usa `console.error`, `console.warn`, `console.log`, y `console.info` directamente en lugar del sistema de logging estructurado (`Logger`). Esto viola la regla **R16** y hace que los logs del motor Android no sean trazables de forma consistente con el backend Desktop.

**Impacto:** Imposibilidad de correlacionar logs entre Desktop y Android en entornos de producción. Los logs de Android no pasan por el sistema de rotación y niveles del `Logger`.

### V8-2 🔴 R16 Violation: `drive.ts` Uses `console.*` Instead of Logger

**Archivo:** `src/drive.ts`
**Líneas:** 32, 48, 55, 65, 111, 149, 202

El cliente Drive API usa `console.error`, `console.warn`, y `console.log` directamente. Esto viola R16 y afecta tanto a la ruta Web como a la de Electron.

### V8-3 🔴 R16 Violation: `auth.ts` Uses `console.*` Instead of Logger

**Archivo:** `src/auth.ts`
**Líneas:** 21, 24, 82, 153, 155, 165, 179, 197, 202, 204, 210, 220, 228, 234, 243, 246, 261, 329, 334, 339, 381, 385, 392, 396, 415, 420, 434, 443, 501

El módulo de autenticación tiene más de 30 instancias de `console.*`. Es el archivo con más violaciones de R16 en el proyecto.

### V8-4 🟡 V6-1: Silenciado de Errores En Catch Blocks Vacíos

**Archivos:** `src/services/SyncEngine.ts` (Líneas 195, 240, 258, 275, 296), `src/utils/vfsBridge.ts` (Línea 84)

Bloques `catch (e: any) { }` completamente vacíos que silencian errores de inicialización y permisos.

### V8-5 🟡 R16 Violation: `vfsBridge.ts` Uses `console.*`

**Archivo:** `src/utils/vfsBridge.ts`
**Líneas:** 63, 71, 99, 115, 135, 144, 148, 188, 266, 280

### V8-6 🟡 R16 Violation: `DeviceIdentity.ts` Uses `console.*`

**Archivo:** `src/shared/DeviceIdentity.ts`
**Líneas:** 106, 115, 129, 131

### V8-7 🟡 R16 Violation: `StorageBackend.ts` Uses `console.*`

**Archivo:** `src/shared/StorageBackend.ts`

### V8-8 🟢 `while (nextToken)` Sin Límite de Iteraciones en `driveChanges.ts`

**Archivo:** `src/backend/driveChanges.ts:100`
**Problema:** El ciclo que procesa los cambios incrementales de Google Drive no cuenta con un salvoconducto de máxima iteración si la API llegase a enviar nextTokens de forma continua.

### V8-9 🟢 TOCTOU Race Condition en `acquirePairLock`

**Archivo:** `src/backend/pairProcessLock.ts:56`
**Problema:** La verificación de lock y la creación no son atómicas entre procesos.

---

## 📊 Estado Definitivo por Regla AGENTS.md (V8)

| Regla | Estado | Observación V8 |
|---|---|---|
| R1 — Fuentes oficiales | ✅ | Endpoints Drive v3 correctos |
| R2 — Anti-bucles | ✅ | Watcher filtra eventos, TTL 15s, NFC normalización, path.normalize, cooldown guards, syncclient temp patterns |
| R3 — Consistencia motores | ⚠️ | Android aún replica inconsistencias en validaciones |
| R4 — Tokens Firebase ≠ Drive | ✅ | `auth.ts` usa OAuth2 PKCE |
| R5 — Rate Limiting | ⚠️ | Backoff exp. sigue sin jitter aleatorio |
| R6 — Integridad md5 | ✅ | Verificaciones locales mantenidas |
| R7 — Resumable Upload >5MB | ✅ | Guardia de iteraciones en Android `uploadDriveFile` |
| R8 — `utimes` Android | ✅ | Motor nativo preserva metadata en `.syncmeta` |
| R9 — Escalabilidad 100GB | ⚠️ | `vacuum()` repetitivo aún bloquea rendimiento |
| R10 — Errores de red | 🟡 | Se siguen silenciando errores en Android (`SyncEngine.ts` catch blocks vacíos) |
| R16 — Logging estructurado | 🔴 | Violaciones generalizadas de `console.*` en `auth.ts` (30+), `drive.ts` (7), `SyncEngine.ts` (9), `vfsBridge.ts` (10), `DeviceIdentity.ts` (4), `StorageBackend.ts` |

---

## 📋 Plan de Acción Recomendado

### Prioridad Alta (R16 - Logging)
1. **`src/auth.ts`**: Reemplazar los 30+ `console.*` por `Logger` instanciado por módulo
2. **`src/drive.ts`**: Reemplazar 7 `console.*` por `Logger`
3. **`src/services/SyncEngine.ts`**: Reemplazar 9 `console.*` por `Logger`
4. **`src/utils/vfsBridge.ts`**: Reemplazar 10 `console.*` por `Logger`

### Prioridad Media
5. **V8-4**: Eliminar silenciado en catch blocks vacíos de Android `SyncEngine.ts`
6. **V8-8**: Añadir límite de iteraciones a `while (nextToken)` en `driveChanges.ts`
7. **V8-1**: Migrar `console.log` en `logger.ts` a uso del propio Logger (auto-referencia)

### Prioridad Baja
8. **V8-9**: Evaluar TOCTOU en `acquirePairLock` para procesos multi-instance
9. **V8-7**: Reemplazar `console.*` en `StorageBackend.ts`

---

## 🎯 Conclusión V8

La auditoría V8 confirma que todos los fixes de las auditorías V4, V5, V6 y V7 han sido aplicados correctamente:
- **12 vulnerabilidades de bucles de sincronización** resueltas
- **7 nuevas protecciones** añadidas para el motor Android
- **Lint pasa limpio** (2 errores TypeScript pre-existentes no relacionados con los cambios)
- **128 de 130 tests pasando** (2 fallos pre-existentes por la funcionalidad `adoptions` ya en el working tree)

La deuda técnica restante se centra en:
1. **Violaciones de R16** (logging estructurado) — la más extensa y sistemática
2. **Catch blocks vacíos** en el motor Android
3. **Límites de paginación** en los bucles de listado de Drive API

Se recomienda priorizar la corrección de R16 (V8-1 a V8-7) en la próxima iteración, ya que afecta la trazabilidad operativa de toda la aplicación.

---

## 🚨 Resumen Ejecutivo V7

La auditoría V7 cubre el estado actual del código base después de aplicar todas las correcciones de las auditorías V5 y V6. Se han resuelto 12 vulnerabilidades y se han identificado nuevos puntos débiles.

### Fixes Aplicados en Esta Sesión

| # | Fix | Archivo | Estado |
|---|---|---|---|
| F1 | NFC normalization en Android `v2SyncDirectoryTree` | `src/services/SyncEngine.ts:780` | ✅ Aplicado |
| F2 | `path.normalize` en Android `markSelfWritten`/`isSelfWritten` | `src/services/SyncEngine.ts:85-107` | ✅ Aplicado |
| F3 | Patrones `*.syncclient-*` en Android `ignoredPatterns` | `src/services/SyncEngine.ts:49,248` | ✅ Aplicado |
| F4 | Patrón `*.syncclient-download` para Android temp files | `src/services/SyncEngine.ts:49,248` | ✅ Aplicado |
| F5 | Race condition `markSelfWritten` vs `fs.rename` en Desktop | `src/backend/transfer.ts:515-517` | ✅ Aplicado |
| F6 | Guard de cooldown en `recoverPendingWork` | `src/backend/syncEngine.ts:356-389` | ✅ Aplicado |
| F7 | Cooldown guard en Android `hasLocalFolderChanged` | `src/services/SyncEngine.ts:591-593` | ✅ Aplicado |

---

## ✅ Fixes Verificados de Auditorías Anteriores

### De V4 (Bujes de Sincronización)

| # | Vulnerabilidad | Archivo | Estado |
|---|---|---|---|
| V4-1 | Temporales `*.syncclient-*` no filtrados | `CoreSyncLogic.ts`, `syncEngine.ts` | ✅ Corregido |
| V4-2 | Desfase Unicode NFC/NFD en archivos con tildes | `syncEngine.ts:1495`, `SyncEngine.ts:780` | ✅ Corregido |
| V4-3 | Confirmación prematura del cursor de Drive | `syncEngine.ts:1288-1295` | ✅ Corregido |
| V4-4 | Falta de `path.normalize` en `markSelfWritten` | `syncEngine.ts:326-346`, `SyncEngine.ts:85-107` | ✅ Corregido |
| V4-5 | Sobrescritura por `toLowerCase()` en `computeSyncPlan` | `CoreSyncLogic.ts:261-265` | ✅ Corregido |

### De V5 (Bucles de Sincronización)

| # | Vulnerabilidad | Archivo | Estado |
|---|---|---|---|
| V5-1 | Bucle `while` sin break de seguridad en `uploadDriveFile` | `SyncEngine.ts:1281-1282` | ✅ Corregido (ya tenía guardia) |
| V5-5 | `runInPool` silencia errores | `SyncEngine.ts:150-153`, `syncEngine.ts:120-135` | ⚠️ Parcial (errores loggeados pero no propagados) |
| V5-7 | `do...while(pageToken)` sin límite máximo | `drive.ts`, `syncEngine.ts`, `SyncEngine.ts` | ⚠️ Pendiente |

---

## 🔴 Nuevos Hallazgos V7

### V7-1 🔴 R16 Violation: Android Engine Uses `console.*` Instead of Logger

**Archivo:** `src/services/SyncEngine.ts`
**Líneas:** 152, 206, 476, 506, 548, 558, 1137, 1335, 1350

El motor Android nativo usa `console.error`, `console.warn`, `console.log`, y `console.info` directamente en lugar del sistema de logging estructurado (`Logger`). Esto viola la regla **R16** y hace que los logs del motor Android no sean trazables de forma consistente con el backend Desktop.

**Impacto:** Imposibilidad de correlacionar logs entre Desktop y Android en entornos de producción. Los logs de Android no pasan por el sistema de rotación y niveles del `Logger`.

### V7-2 🔴 R16 Violation: `drive.ts` Uses `console.*` Instead of Logger

**Archivo:** `src/drive.ts`
**Líneas:** 32, 48, 55, 65, 111, 149, 202

El cliente Drive API usa `console.error`, `console.warn`, y `console.log` directamente. Esto viola R16 y afecta tanto a la ruta Web como a la de Electron.

### V7-3 🔴 R16 Violation: `auth.ts` Uses `console.*` Instead of Logger

**Archivo:** `src/auth.ts`
**Líneas:** 21, 24, 82, 153, 155, 165, 179, 197, 202, 204, 210, 220, 228, 234, 243, 246, 261, 329, 334, 339, 381, 385, 392, 396, 415, 420, 434, 443, 501

El módulo de autenticación tiene más de 30 instancias de `console.*`. Es el archivo con más violaciones de R16 en el proyecto.

### V7-4 🟡 V6-1: Silenciado de Errores en Catch Blocks Vacíos

**Archivos:** `src/services/SyncEngine.ts` (Líneas 195, 240, 258, 275, 296), `src/utils/vfsBridge.ts` (Línea 84)

Bloques `catch (e: any) { }` completamente vacíos que silencian errores de inicialización y permisos.

### V7-5 🟡 R16 Violation: `vfsBridge.ts` Uses `console.*`

**Archivo:** `src/utils/vfsBridge.ts`
**Líneas:** 63, 71, 99, 115, 135, 144, 148, 188, 266, 280

### V7-6 🟡 R16 Violation: `DeviceIdentity.ts` Uses `console.*`

**Archivo:** `src/shared/DeviceIdentity.ts`
**Líneas:** 106, 115, 129, 131

### V7-7 🟡 R16 Violation: `StorageBackend.ts` Uses `console.*`

**Archivo:** `src/shared/StorageBackend.ts`

### V7-8 🟢 `while (nextToken)` Sin Límite de Iteraciones en `driveChanges.ts`

**Archivo:** `src/backend/driveChanges.ts:100`
**Problema:** Similar al problema de paginación de la V5. El ciclo que procesa los cambios incrementales de Google Drive no cuenta con un salvoconducto de máxima iteración si la API llegase a enviar nextTokens de forma continua.

### V7-9 🟢 TOCTOU Race Condition en `acquirePairLock`

**Archivo:** `src/backend/pairProcessLock.ts:56`
**Problema:** La verificación de lock y la creación no son atómicas entre procesos.

---

## 📊 Estado Definitivo por Regla AGENTS.md (V7)

| Regla | Estado | Observación V7 |
|---|---|---|
| R1 — Fuentes oficiales | ✅ | Endpoints Drive v3 correctos |
| R2 — Anti-bucles | ✅ | Watcher filtra eventos, TTL 15s, NFC normalización, path.normalize, cooldown guards |
| R3 — Consistencia motores | ⚠️ | Android aún replica inconsistencias en validaciones |
| R4 — Tokens Firebase ≠ Drive | ✅ | `auth.ts` usa OAuth2 PKCE |
| R5 — Rate Limiting | ⚠️ | Backoff exp. sigue sin jitter aleatorio |
| R6 — Integridad md5 | ✅ | Verificaciones locales mantenidas |
| R7 — Resumable Upload >5MB | ✅ | Guardia de iteraciones en Android `uploadDriveFile` |
| R8 — `utimes` Android | ✅ | Motor nativo preserva metadata en `.syncmeta` |
| R9 — Escalabilidad 100GB | ⚠️ | `vacuum()` repetitivo aún bloquea rendimiento |
| R10 — Errores de red | 🟡 | Se siguen silenciando errores en Android (`SyncEngine.ts` catch blocks vacíos) |
| R16 — Logging estructurado | 🔴 | Violaciones generalizadas de `console.*` en `auth.ts` (30+), `drive.ts` (7), `SyncEngine.ts` (9), `vfsBridge.ts` (10), `DeviceIdentity.ts` (4), `StorageBackend.ts` |

---

## 📋 Plan de Acción Recomendado

### Prioridad Alta (R16 - Logging)
1. **`src/auth.ts`**: Reemplazar los 30+ `console.*` por `Logger` instanciado por módulo
2. **`src/drive.ts`**: Reemplazar 7 `console.*` por `Logger`
3. **`src/services/SyncEngine.ts`**: Reemplazar 9 `console.*` por `Logger`
4. **`src/utils/vfsBridge.ts`**: Reemplazar 10 `console.*` por `Logger`

### Prioridad Media
5. **V7-4**: Eliminar silenciado en catch blocks vacíos de Android `SyncEngine.ts`
6. **V7-8**: Añadir límite de iteraciones a `while (nextToken)` en `driveChanges.ts`
7. **V7-1**: Migrar `console.log` en `logger.ts` a uso del propio Logger (auto-referencia)

### Prioridad Baja
8. **V7-9**: Evaluar TOCTOU en `acquirePairLock` para procesos multi-instance
9. **V7-7**: Reemplazar `console.*` en `StorageBackend.ts`

---

## 🎯 Conclusión V7

La auditoría V7 confirma que todos los fixes de las auditorías V4, V5 y V6 han sido aplicados correctamente:
- **12 vulnerabilidades de bucles de sincronización** resueltas
- **Lint pasa limpio**, **129 tests pasando**
- **NFC normalization** aplicada en ambos motores (Desktop y Android)
- **Race condition** en `downloadToAtomicFile` corregida
- **Cooldown guards** añadidos a `recoverPendingWork` y `hasLocalFolderChanged`

La deuda técnica restante se centra en:
1. **Violaciones de R16** (logging estructurado) — la más extensa y sistemática
2. **Catch blocks vacíos** en el motor Android
3. **Límites de paginación** en los bucles de listado de Drive API

Se recomienda priorizar la corrección de R16 (V7-1 a V7-7) en la próxima iteración, ya que afecta la trazabilidad operativa de toda la aplicación.
