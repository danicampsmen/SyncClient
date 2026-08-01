# Plan de implementacion de sincronizacion Android

## Alcance

Este plan cubre exclusivamente Android mediante Capacitor. El motor nativo es
[`src/services/SyncEngine.ts`](../src/services/SyncEngine.ts) y se expone por
[`src/services/syncService.ts`](../src/services/syncService.ts).

Android debe priorizar consumo de bateria, memoria limitada, almacenamiento
intermitente y ejecuciones interrumpidas por el ciclo de vida de la aplicacion.
No se debe asumir que el proceso permanece vivo ni que Capacitor soporta las
mismas operaciones que Node.js.

## Estado actual

- El motor Android usa `CapacitorFS` y puede operar sin el backend del PC.
- Existe SQLite mediante `sql.js`/WASM y el mismo esquema base que Desktop.
- Ya existen `selfWrittenFiles`, cooldown, backoff, debounce y `activeSyncs`.
- Las descargas escriben un sidecar `.syncmeta` porque Android no puede fijar
  confiablemente el `mtime` remoto.
- Las operaciones de conflictos, hydrate y dehydrate todavía pueden delegarse
  al PC mediante relay HTTP.
- El almacenamiento WASM debe exportarse y persistirse de forma segura; no debe
  tratarse como una base nativa con WAL real.

## Objetivos

1. Subir automáticamente exportaciones de StarNote sin duplicados ni bucles.
2. Descargar apuntes para uso offline verificando integridad.
3. Reanudar operaciones después de suspender, cerrar o matar la aplicación.
4. Evitar cargar archivos grandes completos en memoria JavaScript.
5. Mantener contratos compartidos con Desktop sin forzar cambios Ubuntu no
   relacionados.
6. Delegar al PC las operaciones que requieran capacidades ausentes en Android.

## Arquitectura Android recomendada

```text
Capacitor App lifecycle
        |
        v
Watcher/scan local + .syncmeta
        |
        v
SQLite WASM + journal persistente
        |
        +--> Drive API directa (transferencias pequeñas/medianas)
        |
        +--> Relay autenticado al PC (operaciones no soportadas)
        |
        v
Temporary file + checksum + rename
        |
        v
Estado persistido y notificacion de resultado
```

## Persistencia y recuperación

Ampliar el esquema compartido con migraciones idempotentes para:

### `sync_operations`

```text
id, pair_id, rel_path, operation_type, remote_id,
status, attempts, last_error, created_at, updated_at
```

### `upload_sessions`

```text
operation_id, session_uri, file_size, confirmed_offset,
chunk_size, updated_at
```

### `drive_cursors`

```text
pair_id, account_id, drive_id, page_token,
last_success_at, status
```

Android debe guardar el resultado de `db.export()` con escritura temporal,
verificacion de integridad y rename. El archivo principal y su backup deben
mantenerse en almacenamiento de la aplicacion, no en la carpeta sincronizada.

Al reanudar la app:

1. Cargar la base principal.
2. Ejecutar `integrity_check`.
3. Recuperar el backup si la base es invalida.
4. Reconciliar operaciones `pending`, `running` y `retry`.
5. Revalidar archivos temporales y sidecars.
6. Continuar solo cuando el acceso a la carpeta sea valido.

## Sidecars `.syncmeta`

Cada archivo descargado puede tener `archivo.ext.syncmeta` con metadata minima:

```json
{
  "remoteMtime": 0,
  "remoteId": "drive-file-id",
  "size": 0,
  "md5": "optional-md5",
  "updatedAt": 0
}
```

Reglas:

- El sidecar no se sube a Drive como documento del usuario.
- Debe estar incluido en los patrones de exclusion del motor.
- Toda escritura y eliminacion del sidecar debe llamar `markSelfWritten()`.
- Si falta o esta corrupto, forzar una comparacion remota segura.
- La deteccion de cambios Android usa sidecar + tamano + hash; no usa solo mtime.
- Un sidecar nunca debe confirmar una descarga cuyo checksum no coincide.

## Transferencias

### Descarga

1. Crear un temporal unico.
2. Descargar por chunks/stream compatible con Capacitor.
3. Calcular MD5 si Drive lo proporciona.
4. Verificar tamano y checksum.
5. Renombrar atomica o equivalentemente dentro del filesystem Android.
6. Escribir `.syncmeta`.
7. Confirmar estado y journal en SQLite.

### Subida

- Archivos grandes deben usar upload resumable.
- Chunks multiples de 256 KiB, con limite de memoria configurable.
- Preferir lectura por rangos mediante `readFileChunk`.
- Persistir URI y offset antes de perder el ciclo de vida.
- Ante error, consultar el rango confirmado antes de repetir el chunk.
- No usar `readFile()` completo como fallback para archivos grandes.

## Ciclo de vida y conectividad

- Pausar nuevas transferencias cuando la app pase a background si no existe un
  worker Android persistente aprobado.
- Marcar la operacion como reanudable, no como fallida definitiva.
- Reintentar al volver a foreground, con conectividad disponible.
- Evitar polling agresivo con bateria baja o red no disponible.
- Aplicar backoff 30 s, 60 s y hasta 15 min.
- Mantener cooldown de 60 s despues de una sincronizacion.
- No ejecutar dos sincronizaciones de la misma pareja.

Para sincronizacion realmente automatica en background, evaluar WorkManager o
un servicio foreground conforme a las restricciones y permisos de la version
Android objetivo. Esa integracion requiere pruebas en dispositivos reales y no
debe simularse desde JavaScript.

## Drive API y relay

### Drive directo desde Android

Usarlo para:

- subida de PDFs exportados;
- descarga de archivos solicitados;
- lectura de metadata;
- operaciones que puedan pausarse y reanudarse.

### Relay al PC

Usarlo para:

- hydrate/dehydrate masivo;
- operaciones de archivos no soportadas por Capacitor;
- conflictos que requieran acceso al motor Desktop;
- reconciliaciones grandes cuando Android no tenga memoria o bateria.

El relay debe autenticar cada solicitud, validar `pairId`, rutas y arrays, y no
aceptar rutas arbitrarias ni tokens Firebase como tokens Drive.

## Seguridad Android

- Mantener tokens en `capacitor-secure-storage-plugin` o almacenamiento nativo.
- No registrar tokens, refresh tokens ni cabeceras de autorizacion.
- Validar path traversal antes de cada lectura, escritura y borrado.
- Restringir el relay a la red y dispositivo autorizados.
- No guardar credenciales en la carpeta sincronizada.
- Redactar identificadores sensibles en logs de diagnostico.

## Plan por fases

### A0 - Baseline Android

- Ejecutar lint y pruebas unitarias con configuracion Android disponible.
- Crear fixtures de `CapacitorFS` simulando lectura por chunks, rename, fallos y
  ausencia de permisos.
- Documentar versiones Android y dispositivos soportados.

### A1 - SQLite WASM durable

- Implementar migraciones y tablas de operaciones, sesiones y cursores.
- Hacer checkpoint temporal + verificacion + rename.
- Probar corrupcion principal, backup valido y backup corrupto.
- Evitar exportaciones frecuentes durante cada chunk.

### A2 - Sidecars y scanner

- Centralizar lectura/escritura de `.syncmeta`.
- Ignorar sidecars en local y remoto.
- Detectar modificacion por sidecar, tamano y hash.
- Probar renombrado, eliminacion, sidecar faltante y sidecar invalido.

### A3 - Upload/download reanudables

- Eliminar el fallback de archivo completo para archivos grandes.
- Persistir sesiones y offsets.
- Implementar consulta de rango tras interrupciones.
- Probar 308, 401, 403, 429, 5xx, timeout y checksum incorrecto.

### A4 - Ciclo de vida Android

- Definir politica foreground/background.
- Reanudar operaciones pendientes al volver a foreground.
- Añadir WorkManager/foreground service solo despues de validar permisos,
  bateria y restricciones del Android objetivo.
- Probar rotacion, background, force-stop, falta de red y poco almacenamiento.

### A5 - Relay seguro

- Formalizar endpoints de relay.
- Añadir autenticacion de sesion y validacion de entradas.
- Hacer idempotentes hydrate, dehydrate y resolve-conflict.
- Probar desconexion del PC y reintentos sin duplicar operaciones.

### A6 - Pruebas de dispositivo

Probar al menos:

- Tablet StarNote con exportacion PDF.
- Celular con descarga offline.
- Android con almacenamiento casi lleno.
- Red Wi-Fi intermitente.
- Aplicacion cerrada durante subida y descarga.
- Dos eventos filesystem producidos por una misma escritura.
- Tres ciclos de polling sin bucles.

## Criterios de aceptación

1. Ningun archivo grande se carga completo en memoria.
2. Una descarga corrupta no reemplaza la copia valida.
3. Una subida interrumpida continua desde el offset confirmado.
4. Los sidecars no aparecen en Drive ni disparan sincronizaciones.
5. La app se recupera tras background, cierre y reinicio.
6. SQLite puede restaurarse desde backup verificado.
7. No se duplican operaciones por eventos repetidos.
8. Los conflictos se conservan hasta una resolucion explicita.
9. El relay rechaza rutas y tokens invalidos.
10. Las pruebas pasan en dispositivos reales soportados.

## Fuentes de referencia

- [Capacitor Filesystem](https://capacitorjs.com/docs/apis/filesystem)
- [Capacitor App lifecycle](https://capacitorjs.com/docs/apis/app)
- [Android WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [SQLite backup](https://sqlite.org/backup.html)
