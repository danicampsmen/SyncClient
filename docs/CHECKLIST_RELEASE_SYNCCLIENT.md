# Checklist ejecutable de release para SyncClient

## Objetivo

Aprobar una release de producción para SyncClient Desktop Ubuntu con la evidencia mínima de seguridad, autenticación real, validación del flujo de sincronización y reproducibilidad del artefacto final.

## Estado de salida esperado

La release solo puede aprobarse si se cumplen las condiciones de esta checklist, sin placeholders de Firebase/OAuth, sin secretos en el repositorio y con validación real del backend y del motor Ubuntu.

## Fase 0 — Preflight de entorno

### Configuración base

- [ ] La máquina de release es Ubuntu LTS y está limpia de secretos locales del desarrollador.
- [ ] Node.js >= 20 y npm están instalados.
- [ ] El repositorio se clona en una ruta controlada y reproducible.
- [ ] El directorio de trabajo de sincronización está definido y es accesible por la app.
- [ ] La carpeta remota en Google Drive está autenticada con la cuenta correcta.

### Criterio de salida

- [ ] La máquina de release está lista para arrancar la app sin depender de un checkout del desarrollador.

## Fase 1 — Credenciales y configuración real

### Firebase / OAuth

- [ ] Se reemplazó el placeholder de [firebase-applet-config.json](../firebase-applet-config.json) o se usó un loader de entorno legítimo.
- [ ] Las variables `VITE_FIREBASE_*` están configuradas en el entorno de despliegue.
- [ ] `VITE_FIREBASE_OAUTH_CLIENT_ID` corresponde a un cliente Google OAuth válido para Drive.
- [ ] Los scopes de Drive, `profile` y `email` están habilitados en el proyecto OAuth.
- [ ] No hay secretos, tokens ni client secrets en el repositorio.

### Criterio de salida

- [ ] El entorno de producción tiene configuración real de Firebase/OAuth y no placeholders.

## Fase 2 — Seguridad de tokens y sesión

- [ ] La sesión de usuario no depende de `localStorage` inseguro para credenciales de Drive.
- [ ] Los tokens y refresh tokens quedan protegidos por almacenamiento seguro del sistema.
- [ ] El backend no imprime tokens ni refresh tokens en logs.
- [ ] La limpieza de sesión no deja credenciales legibles para otros procesos del usuario.

### Criterio de salida

- [ ] La autenticación puede reanudarse tras reinicio sin exponer secretos.

## Fase 3 — Validación del backend y la UI

### Backend

- [ ] `npm install` se ejecutó en la máquina de release.
- [ ] `npm run dev` arranca el backend sin errores de compilación.
- [ ] `curl -I http://127.0.0.1:3000` responde con `HTTP 200`.

### UI Desktop

- [ ] `npm run build` termina correctamente.
- [ ] `npm run electron:dev` puede abrir la UI de Electron con el backend ya levantado.
- [ ] No hay errores de CORS ni de importación de configuración pública.

### Criterio de salida

- [ ] La app puede arrancarse en desktop sin depender de secretos ni de correcciones manuales sobre el repo.

## Fase 4 — Validación operativa real del motor Ubuntu

### Validación mínima requerida

- [ ] El flujo de sincronización inicial real se ejecuta con una carpeta de Drive autenticada.
- [ ] El proceso de arranque limpio se completa sin pérdida de trabajo.
- [ ] El proceso de reinicio con trabajo pendiente reanuda operaciones `running` / `retry` desde SQLite.
- [ ] El cursor incremental de `changes.list` se confirma solo después de aplicar el lote completo.
- [ ] El rescan controlado se activa si el cursor es inválido o expirado.
- [ ] El lock por pareja entre el motor nativo y `rclone` funciona en ejecución real.
- [ ] Las transferencias resumibles, descargas atómicas y checksum quedan verificados para archivos reales.
- [ ] El evento auto-generado del watcher no provoca bucle de sincronización.

### Criterio de salida

- [ ] La sincronización real no pierde archivos, no avanza cursor sobre cambios no aplicados y mantiene recuperación auditable.

## Fase 5 — Build de release reproducible

- [ ] `npm run build` se repite limpio en el entorno de release.
- [ ] `npm run electron:build` produce el artefacto final sin intervención manual.
- [ ] El artefacto generado queda documentado como release candidate.
- [ ] Hay una política de rollback definida y auditable.

### Criterio de salida

- [ ] La release es reproducible y se puede regenerar sin secretos del desarrollador.

## Fase 6 — Criterio de aprobación final

La release se aprueba solo si todas las casillas quedan marcadas en esta checklist.

### GO / NO-GO

- [ ] GO: la configuración OAuth está real, la seguridad de tokens está cerrada, la sincronización real fue validada y el artefacto de release es reproducible.
- [ ] NO-GO: hay placeholders de autenticación, almacenamiento inseguro de tokens, o la validación real no demostró recovery/cursor/lock y la release no es reproducible.

## Evidencias mínimas requeridas

- [ ] Logs de arranque del backend y Electron.
- [ ] Evidencia de OAuth real con la cuenta autorizada.
- [ ] Evidencia de sincronización inicial y recuperación tras reinicio.
- [ ] Evidencia de cursor y rescan controlado.
- [ ] Artefacto final de release generado en la máquina de despliegue.

## Resumen

Esta checklist es la barrera de salida para producción. Si no se cumple en el entorno real, la release no debe considerarse preparada para despliegue.
