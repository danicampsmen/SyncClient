# Playbook de despliegue para SyncClient Desktop Ubuntu

## Objetivo

Preparar, validar y desplegar SyncClient en una máquina Ubuntu dedicada, verificando que el cliente desktop y el backend se ejecutan con una configuración real, segura y recuperable.

## Alcance

Este playbook cubre:

- configuración de entorno
- autenticación real con Google OAuth / Firebase
- seguridad de tokens
- build de release
- validación de sincronización real
- criterios de aprobación para go/no-go

## Requisitos de la máquina de despliegue

- Ubuntu LTS reciente
- Node.js >= 20
- npm
- acceso a una carpeta local de trabajo escrita en rutas permitidas
- acceso real a una carpeta de Google Drive autenticada
- conexión estable a internet para validación OAuth y Drive
- permisos para ejecutar la app en modo desktop

## Fase 0 — Preflight

### Checklist

- [ ] La carpeta local de sincronización existe y está lista para uso.
- [ ] La carpeta remota en Google Drive existe y es accesible con la cuenta autorizada.
- [ ] El usuario tiene `oAuthClientId` válido y `scopes` habilitados para Drive.
- [ ] La máquina tiene Node.js y npm instalados.
- [ ] El proyecto se clona en una ruta segura y no contiene secretos en el repositorio.

### Criterio de salida

La máquina está lista para iniciar la ejecución real sin depender de placeholders, mocks o datos de prueba inventados.

## Fase 1 — Configuración de entorno de producción

### Checklist

- [ ] Copiar [.env.example](../.env.example) a `.env.local`.
- [ ] Definir `CORS_ORIGIN` si la UI se sirve desde un origen distinto a localhost.
- [ ] Definir las variables `VITE_FIREBASE_*` con la configuración pública real del proyecto Firebase.
- [ ] Confirmar que `VITE_FIREBASE_OAUTH_CLIENT_ID` corresponde al cliente OAuth autorizado para Google Drive.
- [ ] No guardar secretos ni tokens en el repositorio.

### Criterio de salida

El entorno de despliegue puede iniciar la aplicación con configuración pública real y sin depender de JSON fijo en el repositorio.

## Fase 2 — Instalar dependencias y validar el backend

### Comandos

```bash
cd /home/fayfer/Projectos-Programacion/SyncClient-V1
npm install
npm run dev
```

### Verificación

```bash
curl -I http://127.0.0.1:3000
```

### Checklist

- [ ] `npm install` termina sin errores.
- [ ] El backend responde en `http://127.0.0.1:3000` con `HTTP 200`.
- [ ] La app no imprime tokens ni secretos en logs.

### Criterio de salida

El backend ya está listo para servir la UI y para ejecutar flujo OAuth/Drive en una sesión real.

## Fase 3 — Ejecutar la release desktop

### Comandos

```bash
npm run build
npm run electron:dev
```

### Checklist

- [ ] El build de producción termina sin bloqueo.
- [ ] La ventana de Electron se abre con el servidor ya levantado.
- [ ] La UI puede cargar el backend en localhost sin errores de CORS.
- [ ] El flujo de autenticación se inicia con OAuth real y no con placeholders.

### Criterio de salida

La app desktop se ejecuta en el entorno de despliegue con la configuración provisionada y sin errores de arranque.

## Fase 4 — Validación operativa real de Ubuntu

### Objetivo

Demostrar que la sincronización real de Drive funciona con el motor Ubuntu, la recoverabilidad de SQLite y el lock por pareja.

### Checklist de ejecución

- [ ] Arranque limpio del motor nativo.
- [ ] Sincronización inicial real con una carpeta de Drive vigente.
- [ ] Revisión de estado de SQLite y estados de operaciones.
- [ ] Reinicio del proceso con trabajo pendiente.
- [ ] Reanudación correcta de operaciones `running` / `retry`.
- [ ] Confirmación del cursor incremental con `changes.list`.
- [ ] Validación del rescan controlado cuando el cursor es inválido o expirado.
- [ ] Verificación del bloqueo explícito entre rclone y el motor nativo sobre la misma pareja.
- [ ] Comprobación de uploads resumables, checksum y recuperación de descargas corruptas.
- [ ] Comprobación de que un evento auto-generado por el motor no dispara un ciclo de sincronización.

### Criterio de salida

La sincronización opera en vivo sin pérdida de trabajo, sin avances del cursor sobre cambios no confirmados y con recovery auditable tras reinicio.

## Fase 5 — Release de producción

### Comandos

```bash
npm run electron:build
```

### Checklist

- [ ] El artefacto de release se genera reproduciblemente.
- [ ] La configuración de entorno para la release ya está provisionada y no se hace desde un checkout local con valores ad-hoc.
- [ ] Los artefactos de instalación se revisan y se documentan como release candidate.
- [ ] La política de rollback queda definida.

### Criterio de salida

Se dispone de un artefacto de release reproducible para desktop Ubuntu y una evidencia clara de que no se depende de credenciales del desarrollador ni de secretos en el repositorio.

## Criterios de go/no-go

### GO

La release puede aprobarse si:

- [ ] la autenticación real funciona con Drive real
- [ ] el token storage es seguro y no se conoce el acceso a tokens en texto plano
- [ ] el flujo de sync real pasó la validación con la carpeta Drive autenticada
- [ ] el build potenciado por Electron se genera reproduciblemente
- [ ] el lock por pareja y el cursor de cambios se validan en ejecución real
- [ ] la recuperación tras reinicio sobre SQLite queda demostrada

### NO-GO

La release debe suspenderse si:

- [ ] existe un placeholder real de OAuth/Firebase en el entorno de producción
- [ ] los tokens permanecen en almacenamiento inseguro o se loguean
- [ ] la validación real no demuestra `changes.list`, rescan/concurrency ni recovery
- [ ] el build no es reproducible o depende de secretos locales

## Observabilidad mínima

Durante el despliegue real se deben mantener logs y evidencias de:

- arranque del backend
- inicio de sesión de Google OAuth
- acceso a Drive y cambios recibidos
- cursor y rescan
- operación de lock por pareja
- errores de transferencia y reintentos
- estado final de la sincronización

## Resumen

Esta app ya quedó con una base técnica avanzada y validada con pruebas, pero la producción real requiere cerrar la autenticación real, la seguridad del almacenamiento de tokens y la validación operativa con Drive auténtico en Ubuntu dedicada. El playbook anterior es la ruta de salida correcta para llegar a una release controlada y auditable.
