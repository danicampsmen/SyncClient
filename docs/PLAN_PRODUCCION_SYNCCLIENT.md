# Plan de producción para SyncClient

## Objetivo

Llevar SyncClient desde una base técnica valida con pruebas a una release de producción real para desktop Ubuntu/Electron, con autenticación real de Google Drive, almacenamiento seguro de tokens y validación operativa contra un entorno real y controlado.

## Estado actual verificado

La base técnica ya está asentada en el repositorio y ha sido validada con evidencia:

- Motor Ubuntu modular y desacoplado:
  - lock por pareja: [src/backend/pairProcessLock.ts](../src/backend/pairProcessLock.ts)
  - runner rclone: [src/backend/rcloneRunner.ts](../src/backend/rcloneRunner.ts)
  - ingest incremental de Drive con cursor y rescan: [src/backend/driveChanges.ts](../src/backend/driveChanges.ts)
  - persistencia y recuperación en SQLite: [src/shared/StorageBackend.ts](../src/shared/StorageBackend.ts)
  - flujo principal: [src/backend/syncEngine.ts](../src/backend/syncEngine.ts)
- Plan técnico de Ubuntu: [docs/PLAN_BISINCRONIZACION_UBUNTU.md](./PLAN_BISINCRONIZACION_UBUNTU.md)
- Validaciones automatizadas existentes:
  - `npm test` → 103/103 pruebas aprobadas
  - `npm run build` → compilación de producción completada con warnings, sin bloqueo de compilación
  - `npm run dev` + `curl http://127.0.0.1:3000` → respuesta HTTP 200

## Bloqueadores de producción

Estos puntos no son un detalle menor; son las condiciones necesarias para salir de desarrollo a producción:

1. Configuración real de Firebase/OAuth
   - [src/auth.ts](../src/auth.ts) importa [firebase-applet-config.json](../firebase-applet-config.json).
   - Ese JSON no puede quedar con placeholders en producción.
   - Requiere `apiKey`, `authDomain`, `projectId`, `appId`, `oAuthClientId` reales y autorizados para Drive.

2. Almacenamiento seguro de tokens
   - El README ya reconoce que el almacenamiento seguro de tokens para Electron sigue pendiente.
   - En producción, tokens de Google y sesión no pueden quedar en almacenamiento inseguro.

3. Validación operativa real contra Drive
   - Los tests actuales cubren los módulos, pero no la integración real con una carpeta de Drive autenticada y un dataset real.
   - La validación de `changes.list`, cursors, locks, reintentos, señales de rescan y recovery sigue siendo una condición de producción.

4. Release y operación
   - El paquete Electron existe en [package.json](../package.json), pero todavía no es una release aprobada con política de despliegue, rotación, signo, rollback y observabilidad.

## Orden de ejecución recomendado

### Fase 1 — Configurar la autenticación real

Objetivo: dejar el flujo real de OAuth y Drive operativo en entorno autenticado.

Checklist:

- Reemplazar placeholders en [firebase-applet-config.json](../firebase-applet-config.json) por valores reales del proyecto Firebase.
- Verificar que [src/auth.ts](../src/auth.ts) puede completar el flujo OAuth de Google en desktop.
- Confirmar que el cliente OAuth está autorizado para los scopes necesarios de Drive.
- Probar sesión de usuario con una cuenta de prueba real y una carpeta Drive controlada.

Criterio de salida:

- El usuario puede iniciar sesión con OAuth real sin errores de configuración.
- Las llamadas a Drive utilizan un token autorizable y no se guardan en texto plano en logs.

### Fase 2 — Cerrar el almacenamiento seguro de tokens

Objetivo: eliminar cualquier dependencia de almacenamiento inseguro para credenciales en desktop.

Checklist:

- Revisar las rutas de persistencia en Electron y desktop.
- Mover tokens y refresh tokens a almacenamiento seguro del sistema.
- Validar que la sesión pueda recuperarse tras reinicio del proceso sin exponer secretos.
- Confirmar que los cleanups de sesión no conviertan la app en un vector de fuga de credenciales.

Criterio de salida:

- La aplicación puede reanudar la sesión sin depender de `localStorage` o almacenamiento legible por cualquier proceso del usuario.

### Fase 3 — Validar el motor Ubuntu en entorno real

Objetivo: demostrar que el módulo nativo y el modo rclone pueden operar con la política de exclusividad y recovery ya diseñada.

Checklist:

- Usar una máquina Ubuntu dedicada o entorno aislado.
- Configurar una carpeta real remota en Drive y una carpeta local real.
- Ejecutar sync inicial real.
- Forzar reinicio del proceso con operaciones en curso.
- Recuperar `running`/`retry` desde SQLite.
- Confirmar `changes.list` incremental con cursor duradero.
- Validar rescan controlado cuando el cursor es inválido/expirado.
- Confirmar bloqueo explícito entre rclone y el motor nativo sobre la misma pareja.
- Verificar uploads resumables, checksum y descarga atómica para archivos que sean cambiados y re-descargados.

Criterio de salida:

- La sincronización real no pierde trabajo ni avanza el cursor sobre cambios no aplicados.
- La recuperación tras reinicio es duradera y auditable.

### Fase 4 — Preparar la release de escritorio

Objetivo: dejar una build reproducible y ejecutable para distribución.

Checklist:

- Consolidar la configuración de entorno de release.
- Ejecutar `npm run build` en un entorno limpio.
- Ejecutar `npm run electron:build` y verificar el paquete resultante.
- Documentar el procedimiento de build y el entorno mínimo requerido.
- Definir la política de rollback y de recuperación de estado.

Criterio de salida:

- Hay un artefacto reproducible y documentado para la release, y se puede regenerar sin descubrir secretos ni depender del desarrollador local.

### Fase 5 — Control operacional y go/no-go

Objetivo: definir la operación en producción.

Checklist:

- Logs de arranque, sync, cursores y errores.
- Registro de reintentos, requeue y recovery.
- Estado de SQLite y backups.
- Reglas de despliegue/rollback.
- Revisión de permisos, scopes y una política de acceso mínima.

Criterio de salida:

- La app pasa la validación operativa real y puede ser desplegada con una política de rollback y recuperación documentada.

## Criterios de aprobación para producción

La app solo puede aprobarse como release si cumple todos estos puntos:

1. Configuración real de Firebase/OAuth en entorno no placeholder.
2. Tokens y credenciales persistidos mediante almacenamiento seguro.
3. Flujo de sincronización real validado con Drive autenticado.
4. `changes.list` y cursores confirmados en ejecución real.
5. Recovery tras reinicio verificada sobre SQLite y operaciones pendientes.
6. Lock por pareja funcionando entre rclone y el motor nativo en ejecución real.
7. Verificación de checksum, reintentos y operaciones atómicas sobre archivos.
8. Build de release reproducible.
9. Política de rollback y evidencia de observabilidad.

## Texto corto de decisión

La app ya tiene una base técnica sólida y validada con pruebas, pero no está lista como producto de producción. El siguiente paso correcto es cerrar la autenticación real y la seguridad de tokens, y después validar el flujo de sync en un entorno real y dedicado con Drive autenticado y dataset representativo.

## Resumen de implementación

El repositorio ya contiene el núcleo para esta transición:

- [src/backend/syncEngine.ts](../src/backend/syncEngine.ts)
- [src/backend/driveChanges.ts](../src/backend/driveChanges.ts)
- [src/backend/pairProcessLock.ts](../src/backend/pairProcessLock.ts)
- [src/backend/rcloneRunner.ts](../src/backend/rcloneRunner.ts)
- [src/shared/StorageBackend.ts](../src/shared/StorageBackend.ts)
- [src/shared/schema.ts](../src/shared/schema.ts)
- [src/auth.ts](../src/auth.ts)

La parte que falta para dejar la app lista para producción es la integración auténtica y la validación operativa en un entorno real, no más arquitectura de fondo.
