# Plan de bisincronizacion para Ubuntu

## Alcance

Este documento define la estrategia exclusiva para Ubuntu Desktop/Linux.
Android no forma parte de este plan, salvo cuando sea necesario preservar una
interfaz compartida.

Objetivos:

- Sincronizar aproximadamente 100 GB entre un directorio local y Google Drive.
- Evitar bucles entre watcher local, polling remoto y escrituras del motor.
- Recuperarse de reinicios, errores de red, interrupciones y apagados.
- Mantener estado durable y auditable en SQLite.
- Verificar integridad antes de confirmar una transferencia.
- Reducir el consumo de la API evitando recorridos completos repetidos.

## Mejoras utiles extraidas de auditorias anteriores

Estas recomendaciones se conservan como trabajo verificable. No se considera
que una auditoria haya demostrado una correccion hasta que exista una prueba o
una verificacion reproducible en este repositorio.

### Seguridad del cliente Ubuntu

- Guardar access tokens y refresh tokens en el llavero del sistema Linux
  (`safeStorage`, Secret Service o una alternativa equivalente), nunca en
  `localStorage`.
- Proteger el servidor Express local con un secreto de sesion generado al
  arrancar Electron, validacion de `Authorization` y CORS restringido.
- Revisar `contextIsolation`, `nodeIntegration` y `sandbox` de Electron, y
  exponer en preload solo operaciones necesarias.
- No guardar secretos OAuth en archivos versionados; usar variables de entorno
  o almacenamiento seguro y rotar cualquier secreto expuesto.

### Integridad y seguridad de archivos

- Validar MD5 de Drive cuando exista y conservar SHA-256 local cuando no exista.
- No deduplicar solo por nombre: comparar hash, tamano, ruta y estado base antes
  de borrar o renombrar.
- Excluir `.syncmeta`, temporales, locks y archivos del motor del escaneo remoto.
- Resolver symlinks y validar la ruta real contra las bases permitidas antes de
  leer, escribir o borrar.
- Detectar colisiones de mayusculas/minusculas entre Drive y ext4 y convertirlas
  en advertencias o conflictos, no en sobrescrituras silenciosas.

### Robustez del motor

- Mantener la ejecucion secuencial por pareja; paralelizar solo transferencias
  independientes con un limite de 2-3 workers.
- Manejar 401 renovando el token y reintentando una vez de forma segura.
- Manejar HTTP 308 y consultar el rango confirmado antes de reintentar uploads.
- Verificar que las respuestas resumables incluyan `Location`; fallar de forma
  explicita si la sesion no puede continuar.
- No conservar llamadas SQLite sin efecto, como consultas sin `pair_id`; pasar
  el contexto correcto o eliminarlas.
- Asegurar que el debounce de persistencia guarde el ultimo estado, no una
  fotografia antigua.
- No usar `catch` vacios en reconciliacion: registrar el error y conservar la
  operacion para recuperacion.

### Calidad y pruebas

- Ejecutar pruebas unitarias de `CoreSyncLogic`, conflictos, deduplicacion,
  hashes, rutas y vector clocks.
- Añadir pruebas de integracion con SQLite real y un servidor Drive simulado.
- Probar reinicio, apagado durante transferencia, checksum incorrecto, 401,
  308, 429, 5xx, cursor invalido y eventos duplicados.
- Mantener un solo gestor de paquetes y un lockfile oficial.
- Verificar las afirmaciones de auditorias contra el codigo y los logs actuales;
  no heredar resultados historicos como evidencia presente.

## Nota de confiabilidad

No existe una implementación que pueda garantizar matemáticamente 100% de
confiabilidad ante todos los fallos posibles. La estrategia correcta es definir
un modo de operación seguro, pruebas de fallos reproducibles, recuperación
conservadora y evidencia de cada operación.

Para una opción operativa de máxima madurez se usara `rclone bisync`, con
protecciones contra borrados, locks, snapshots, recuperacion y verificaciones.
El motor propio se implementara con las mismas invariantes, pero mantendra el
control de conflictos y la integracion nativa con SyncClient.

## Directiva de modularidad y continuidad operativa

Ubuntu debe ofrecer dos módulos completos y desacoplados:

1. **Módulo rclone**: modo operativo independiente, ejecutable por CLI aunque
   SyncClient, Express, SQLite o el motor propio estén detenidos.
2. **Módulo nativo**: motor Drive API + SQLite integrado con la UI, el watcher,
   los conflictos y los manifiestos propios de SyncClient.

El módulo rclone no puede depender de tablas SQLite, cursores, journal, tokens
ni procesos del motor nativo. Debe mantener su propia configuración segura,
locks, snapshots, logs, recuperación y verificación. El módulo nativo tampoco
debe asumir que rclone está instalado o disponible.

La selección de módulo debe ser explícita por pareja y persistir solo como
configuración de control, nunca como estado compartido de sincronización. La UI
debe bloquear la ejecución simultánea de ambos módulos sobre la misma pareja.
No se permite cambiar de módulo durante una operación ni hacer fallback
silencioso después de un error parcial: se debe detener, conservar el estado,
mostrar el error y pedir una acción explícita.

Cada módulo debe poder validarse sin el otro:

- rclone: `--dry-run`, ejecución real controlada, `--check-sync`, `rclone check`,
  recuperación y pruebas de reinicio desde CLI.
- Motor nativo: pruebas de SQLite, cursores, journal, watcher y transferencias
  sin requerir rclone.

La interfaz común solo debe compartir conceptos de configuración (pareja,
dirección, exclusiones y estado visible), no archivos de estado ni mecanismos
internos. Las pruebas de aceptación deben ejecutar ambos módulos por separado
contra una carpeta de prueba y nunca contra datos reales del usuario.

# 1. Opcion operativa de máxima confianza: rclone bisync

`rclone bisync` es la alternativa mantenida y con mayor evidencia practica para
una bisincronizacion de archivos. Su documentacion la clasifica como avanzada:
puede producir perdida de datos si se configura mal y requiere una politica
operativa estricta.

Documentacion:

- [rclone bisync](https://rclone.org/bisync/)
- [rclone Drive backend](https://rclone.org/drive/)
- [rclone bisync source](https://github.com/rclone/rclone/tree/master/cmd/bisync)

## Modo A: Ubuntu local <-> Google Drive

```bash
# Primera inicializacion, siempre revisar antes con dry-run
rclone bisync /ruta/local gdrive:SyncClient --resync --dry-run

# Inicializacion real despues de revisar el resultado
rclone bisync /ruta/local gdrive:SyncClient --resync \
  --check-access --max-delete 10 --recover

# Ejecuciones posteriores
rclone bisync /ruta/local gdrive:SyncClient \
  --check-access --resilient --recover --max-delete 10
```

Reglas:

- Ejecutar la primera vez con `--resync --dry-run`.
- No usar `--resync` en cada ciclo normal.
- No ejecutar rclone y el motor propio sobre la misma pareja al mismo tiempo.
- Usar un lock externo o el lock de bisync para impedir ejecuciones solapadas.
- Revisar los snapshots y logs antes de aceptar borrados masivos.
- Usar `rclone check` como verificacion independiente de una reconciliacion.

## Modo B: Google Drive <-> Google Drive

```bash
# Primera inicializacion
rclone bisync gdrive1:SyncClient gdrive2:SyncClient \
  --resync --dry-run

# Inicializacion real
rclone bisync gdrive1:SyncClient gdrive2:SyncClient \
  --resync --check-access --max-delete 10 --recover

# Ciclos posteriores
rclone bisync gdrive1:SyncClient gdrive2:SyncClient \
  --check-access --resilient --recover --max-delete 10
```

Este modo sirve para replicar Drive entre dos cuentas, dos configuraciones o
dos espacios remotos. No debe mezclarse con el modo local-Drive en la misma
carpeta de estado.

## Protecciones verificadas en rclone

El codigo de bisync mantiene snapshots/listings con ruta, tamano, hash, ID y
fecha; calcula deltas en ambos lados; usa lock files; tiene pruebas de locks,
ejecuciones concurrentes, listings y backends locales/remotos. El proyecto
tambien contiene pruebas opcionales contra backends reales, incluido Drive.

Estas caracteristicas son evidencia de madurez, no una garantia absoluta:

- La comparacion por defecto puede usar `size,modtime`; habilitar checksum
  cuando la integridad del contenido sea prioritaria.
- Los conflictos necesitan una politica explicita; no se resuelven por magia.
- `--check-sync` valida el estado final, pero no sustituye una auditoria
  independiente con `rclone check`.
- La proteccion contra borrados debe configurarse con limites conservadores.

## Integracion recomendada con SyncClient

No incrustar rclone como sustituto silencioso del motor propio. Ofrecerlo como
un adaptador modular de primera clase:

1. Modo operativo independiente completo.
2. Modo de recuperacion.
3. Modo de reconciliacion inicial.
4. Herramienta de diagnostico.
5. Modo alternativo seleccionable para usuarios que prioricen madurez
   operativa sobre conflictos personalizados.

La UI debe impedir que ambos motores trabajen sobre la misma pareja
simultaneamente y debe permitir ejecutar el módulo rclone sin que el motor
nativo esté disponible.

## Otros modos de sincronizacion de rclone

Ademas de `bisync`, rclone ofrece operaciones unidireccionales. Estas no son
bisincronizacion: una ruta es la fuente y la otra el destino. La direccion debe
mostrarse explicitamente en la UI para evitar invertirla por accidente.

### Modo C: solo subida, conservador (`copy`)

Copia cambios desde Ubuntu hacia Drive y **no borra** archivos que solo existan
en Drive:

```bash
rclone copy /ruta/local gdrive:SyncClient \
  --check-access --checksum --dry-run

# Ejecutar despues de revisar el dry-run
rclone copy /ruta/local gdrive:SyncClient \
  --check-access --checksum --retries 3 --low-level-retries 10
```

Usarlo para:

- respaldos incrementales;
- publicar archivos nuevos o modificados;
- proteger archivos remotos contra borrado accidental.

`copy` no elimina el destino. Por eso no garantiza que Drive sea un espejo
exacto del directorio local.

### Modo D: solo subida, espejo destructivo (`sync`)

Hace que Drive coincida con Ubuntu y puede borrar del destino lo que no exista
en la fuente:

```bash
rclone sync /ruta/local gdrive:SyncClient \
  --check-access --checksum --max-delete 10 --dry-run

# Ejecutar solo despues de validar la lista de borrados
rclone sync /ruta/local gdrive:SyncClient \
  --check-access --checksum --max-delete 10 \
  --retries 3 --low-level-retries 10
```

Usarlo solo si Ubuntu es la fuente autoritativa. `--dry-run`, `--max-delete` y
un backup previo son obligatorios para una operacion segura.

### Modo E: solo bajada, conservador (`copy` invertido)

Copia cambios desde Drive hacia Ubuntu y **no borra** archivos locales que no
existan en Drive:

```bash
rclone copy gdrive:SyncClient /ruta/local \
  --check-access --checksum --dry-run

# Ejecutar despues de revisar el dry-run
rclone copy gdrive:SyncClient /ruta/local \
  --check-access --checksum --retries 3 --low-level-retries 10
```

Usarlo para:

- descargar una copia local;
- recuperar datos desde Drive;
- actualizar una carpeta local sin eliminar archivos extras.

### Modo F: solo bajada, espejo destructivo (`sync` invertido)

Hace que Ubuntu coincida con Drive y puede borrar del destino local lo que no
exista en Drive:

```bash
rclone sync gdrive:SyncClient /ruta/local \
  --check-access --checksum --max-delete 10 --dry-run

# Ejecutar solo despues de validar la lista de borrados
rclone sync gdrive:SyncClient /ruta/local \
  --check-access --checksum --max-delete 10 \
  --retries 3 --low-level-retries 10
```

Usarlo solo si Drive es la fuente autoritativa. No debe ejecutarse sobre la
carpeta de trabajo de Ubuntu sin una copia de seguridad y una confirmacion
explicita del usuario.

### Modo G: copiar un archivo o renombrar (`copyto`)

`copyto` sirve para un archivo individual o para copiar un directorio con un
nombre de destino especifico. No elimina archivos del destino:

```bash
rclone copyto /ruta/local/nota.pdf gdrive:SyncClient/nota.pdf \
  --checksum --dry-run
```

### Modo H: mover una entrada (`moveto`)

`moveto` transfiere y elimina el origen despues de una transferencia exitosa.
No es un modo de sincronizacion recurrente y debe tratarse como destructivo:

```bash
rclone moveto /ruta/local/nota.pdf gdrive:SyncClient/nota.pdf \
  --checksum --dry-run
```

No usar `moveto` para backups ni para el ciclo normal de SyncClient.

### Matriz de seleccion

| Modo | Direccion | Borra destino | Uso recomendado |
|---|---|---:|---|
| `bisync` | Ambos lados | Segun deltas y politica | Bisincronizacion |
| `copy` | Fuente -> destino | No | Backup/publicacion conservadora |
| `sync` | Fuente -> destino | Si | Espejo de una sola fuente |
| `copyto` | Entrada -> destino | No | Archivo o nombre puntual |
| `moveto` | Entrada -> destino | Borra origen | Migracion puntual |

Para todos los modos:

- probar primero con `--dry-run`;
- usar `--checksum` cuando la integridad sea prioritaria;
- revisar `--combined`, `--differ`, `--error` o `--dest-after` cuando se
  necesite un informe auditable;
- no ejecutar dos comandos sobre la misma pareja simultaneamente;
- no confundir `copy` con `sync`: `sync` puede borrar el destino.

# 2. Motor propio basado en Drive API + SQLite

## Arquitectura final recomendada

```text
Watcher local (chokidar)
        |
        v
Escaner incremental local
        |
        v
Cola de operaciones SQLite
        |
        +--> Drive changes.list
        |
        +--> Planificador de conflictos
        |
        +--> Workers de transferencia resumable
        |
        v
Commit atomico del filesystem
        |
        v
Estado, journal y cursor SQLite
```

## Fuente incremental remota

Usar:

- `changes.getStartPageToken`
- `changes.list`
- `nextPageToken`
- `newStartPageToken`

El cursor se confirma solo despues de aplicar todos los cambios de sus paginas.
Los cambios de unidades compartidas requieren cursores separados por unidad.
Un cursor invalido debe provocar un rescan controlado, no borrar el estado local.

Documentacion oficial:

- [Manage changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [About changes](https://developers.google.com/workspace/drive/api/guides/about-changes)
- [changes.list](https://developers.google.com/drive/api/reference/rest/v3/changes/list)

`changes.watch` solo notifica que hay cambios disponibles. Para Ubuntu, el
polling durable es la base mas sencilla; un webhook puede añadirse despues como
acelerador.

## Estado SQLite

Ampliar [`src/shared/schema.ts`](../src/shared/schema.ts) con:

### `drive_cursors`

```text
pair_id, account_id, corpus_id, drive_id, page_token,
last_success_at, status
```

### `sync_operations`

```text
id, pair_id, rel_path, operation_type, remote_id,
status, attempts, last_error, created_at, updated_at
```

### `upload_sessions`

```text
operation_id, remote_id, session_uri, file_size,
confirmed_offset, chunk_size, updated_at
```

### `sync_conflicts`

```text
id, pair_id, rel_path, local_hash, remote_hash,
base_hash, resolution, created_at
```

### `file_versions`

```text
pair_id, rel_path, hash, size, source, created_at
```

SQLite debe usar WAL, `busy_timeout`, transacciones cortas y una cola unica de
escrituras. Las transferencias de red nunca deben ejecutarse dentro de una
transaccion abierta.

Referencias:

- [SQLite WAL](https://sqlite.org/wal.html)
- [SQLite transactions](https://sqlite.org/lang_transaction.html)
- [SQLite busy timeout](https://sqlite.org/pragma.html#pragma_busy_timeout)
- [SQLite backup API](https://sqlite.org/backup.html)

## Outbox transaccional

Para cada operacion:

1. Registrar la intencion en `sync_operations`.
2. Ejecutar la transferencia fuera de SQLite.
3. Verificar checksum, tamano y respuesta remota.
4. Actualizar `file_states`.
5. Marcar la operacion como completada.
6. Confirmar el cursor dentro de la misma transaccion logica del estado.

Un reinicio debe reanudar o reconciliar toda operacion `pending`, `running` o
`retry`. Nunca se debe eliminar una operacion pendiente solo porque la app se
cerro.

## Subidas resumables

Para archivos mayores de 5 MB:

- Chunks de 8, 16 o 32 MiB.
- Tamano multiple de 256 KiB.
- URI de sesion y offset persistidos.
- Consulta del rango confirmado despues de un error.
- Reanudacion despues de reinicio.
- Streams, nunca buffers completos para archivos grandes.

Documentacion:

- [Manage uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Handle errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)

## Descargas e integridad

1. Crear un temporal unico en el mismo filesystem.
2. Descargar por stream.
3. Calcular MD5 durante la escritura cuando Drive lo proporcione.
4. Verificar tamano y checksum.
5. Renombrar atomicamente.
6. Llamar `markSelfWritten()` para temporal y destino.
7. Confirmar SQLite despues del rename.

Cuando Drive no proporcione MD5, usar SHA-256 local y conservarlo como hash base.
No usar `modifiedTime` como prueba definitiva de contenido.

## Conflictos

Comparar siempre:

```text
hash_local_actual != hash_local_base
hash_remoto_actual != hash_remoto_base
```

Politica:

- Solo local cambio: subir.
- Solo remoto cambio: descargar.
- Ambos cambiaron: conflicto.
- Ninguno cambio: no hacer nada.
- Eliminacion contra modificacion: conflicto.
- No borrar automaticamente ante evidencia ambigua.

Los vector clocks existentes pueden complementar el hash base, no sustituirlo.

# 3. Plan de implementacion por fases

## Fase 0 - Baseline

- Corregir la prueba que espera la estructura antigua de `deleteRemote`.
- Crear fixtures de Drive y filesystem.
- Crear un servidor HTTP falso para respuestas 200, 308, 403, 404, 429 y 5xx.
- Separar pruebas Ubuntu de pruebas Android.
- Preparar la base independiente de rclone: configuración de pareja validada,
  ruta externa de configuración privada, lock por pareja y ejecución segura
  mediante `spawn` sin shell. Las operaciones destructivas requieren `--dry-run`
  o confirmación explícita; no se comparte estado con SQLite ni con el motor
  nativo.
- Adoptar `package-lock.json` como lockfile oficial de npm y conservarlo
  versionado para que las pruebas reproduzcan las mismas dependencias.
- La recuperación de locks abandonados queda deliberadamente pendiente: nunca
  se eliminará un lock activo por antigüedad sin comprobar el PID y exigir una
  acción explícita.

## Fase 1 - Persistencia

- Agregar migraciones idempotentes para las tablas nuevas.
- Implementar transacciones de `file_states` + journal.
- Agregar recuperacion de operaciones al iniciar.
- Crear backup verificable de SQLite.
- Quitar `vacuum()` de cada sincronizacion y programar mantenimiento.

Estado actual de la fase:

- Implementadas las migraciones versionadas para cursores, operaciones,
  sesiones resumables, conflictos y versiones de archivos.
- `SQLiteBackend` y `JSONBackend` exponen el contrato de persistencia ampliado.
- Las operaciones `running` se recuperan como `retry` al reiniciar.
- Desktop crea un backup mediante la API de backup de SQLite y verifica
  `integrity_check`; WASM mantiene checkpoint temporal, backup y verificacion.
- La cola todavía no ejecuta transferencias ni confirma cursores: eso pertenece a
  las fases de `changes.list` y transferencias.

## Fase 2 - Changes API

- Persistir el start page token.
- Consumir paginas hasta `nextPageToken`.
- Aplicar tombstones y cambios actuales.
- Confirmar `newStartPageToken` solo al completar el lote.
- Implementar rescan ante cursor invalido.
- Mantener reconciliacion completa diaria o bajo demanda.

Estado actual de la fase:

- Implementado [`src/backend/driveChanges.ts`](../src/backend/driveChanges.ts)
  como ingestor reutilizable y desacoplado del motor de transferencias.
- Usa `getStartPageToken` cuando no existe cursor y `changes.list` para las
  paginas siguientes.
- Solo persiste `newStartPageToken` despues de aplicar todas las paginas.
- Conserva el cursor anterior si falla `applyChange`.
- Los cursores invalidos o expirados generan una señal de rescan controlado sin
  borrar el estado local.
- Incluye parametros para unidades compartidas y reintentos acotados de 429,
  5xx y errores de red.
- La integracion con `syncEngine.ts` y la aplicacion de cambios sobre archivos
  se dejan para la siguiente fase, junto con las transferencias.

## Fase 3 - Transferencias

- [Completada] Subida resumable para archivos grandes en chunks de 256 KiB.
- [Completada] Persistencia de URI, offset, tamaño, chunk y hash fuente.
- [Completada] Consulta de `Range` despues de interrupciones y reanudacion tras reinicio.
- [Completada] Descarga a temporal unico, verificacion de tamaño/MD5 y rename atomico.
- [Completada] Reintentos limitados para 401, 429, errores 5xx y fallos de red.
- Pendiente: integrar el ingestor `changes.list` con el motor principal y ampliar
  la validacion de fallos de extremo a extremo.

## Fase 4 - Planificacion y conflictos

- Guardar hash base local y remoto.
- Evitar decisiones basadas solamente en mtime.
- Registrar conflictos y resoluciones.
- Definir versionado antes de habilitar borrados automaticos.

## Fase 5 - Watcher y rendimiento

- Mantener `markSelfWritten`, `isSelfWritten` y `activeSyncs`.
- Debounce de 5 segundos.
- `awaitWriteFinish` con estabilidad de 5 segundos.
- Concurrencia de 2-3 transferencias.
- Polling remoto de 30-120 segundos con backoff adaptativo.
- Rescan completo solo en inicializacion, recuperacion o mantenimiento.

## Fase 6 - Validacion de fallos

Simular y verificar:

- Interrupcion durante subida.
- Interrupcion durante descarga.
- 429 con `Retry-After`.
- 403 de cuota.
- 500/502/503.
- Timeout, reset y DNS.
- Cursor invalido.
- Eliminacion local y remota.
- Modificacion simultanea.
- Dos procesos sobre la misma pareja.
- Apagado durante una operacion.
- Checksum incorrecto.
- Archivos de varios gigabytes.

## Fase 7 - Pruebas de escala

Medir con 10.000 archivos, 100.000 archivos y aproximadamente 100 GB:

- Latencia de deteccion local.
- Solicitudes Drive por ciclo.
- Memoria maxima.
- Throughput con 1, 2 y 3 workers.
- Tiempo de recuperacion tras reinicio.
- Cero bucles en al menos tres ciclos de polling.

# 4. Alternativas existentes y evidencia

## rclone bisync

Es la implementacion practica mas madura encontrada para la necesidad
operativa. Su repositorio contiene snapshots, deltas, locks y pruebas de
ejecuciones concurrentes, listings y backends. Aun asi, su propia documentacion
la clasifica como avanzada y no garantiza ausencia de perdida por mala
configuracion.

## shadow30812/DriveSync

Repositorio: [DriveSync](https://github.com/shadow30812/DriveSync)

Es una referencia de Google Drive API + SQLite, con WAL, escaneo local,
reintentos, uploads resumables y una comprobacion opcional MD5. No es
bidireccional: su README reconoce que los cambios directos en Drive no estan
soportados. Ademas, sus operaciones Drive y SQLite no son atomicas.

Uso recomendado: estudiar inode/mtime, retries y checksum; no reutilizarlo como
motor de bisincronizacion sin rediseño.

## MKRodge/sqlite-shared-sync

Repositorio:
[sqlite-shared-sync](https://github.com/MKRodge/sqlite-shared-sync)

No usa Google Drive. Es una referencia util para snapshots, backups, estados
offline, pruebas con SQLite real y deteccion de locks. Su modelo depende de
timestamps y soft deletes, por lo que no resuelve por si solo conflictos Drive.

## smart-fun/Nuage

Repositorio: [Nuage](https://github.com/smart-fun/Nuage)

Es un proyecto marcado como work in progress; su modulo Drive aparece como
pendiente. No aporta evidencia de una implementacion Drive bidireccional exitosa.

## Syncthing e Insync

- [Syncthing](https://docs.syncthing.net/users/syncthing.html) es maduro para
  sincronizacion P2P, pero no reemplaza el adaptador de Google Drive.
- [Insync](https://www.insynchq.com/) es una alternativa comercial para Linux,
  pero no es una biblioteca inspeccionable para integrar en SyncClient.

# 5. Criterios de aceptacion

La implementacion Ubuntu no se considerara lista hasta demostrar:

1. El polling normal no hace listados recursivos completos de Drive.
2. Los cursores sobreviven a reinicios y no avanzan sobre cambios sin aplicar.
3. Una subida interrumpida continua desde el offset confirmado.
4. Una descarga corrupta no reemplaza el archivo valido.
5. Un evento generado por el motor no crea un ciclo.
6. Un conflicto no destruye silenciosamente ninguna version.
7. Un error de un archivo no descarta operaciones independientes.
8. SQLite pasa `integrity_check` y puede recuperarse desde backup.
9. Las pruebas de fallos y de escala producen logs auditables.
10. El modo rclone y el motor propio no pueden ejecutarse simultaneamente sobre
    la misma pareja.
11. El módulo rclone completa una inicialización, un ciclo normal, una
    recuperación y una verificación sin que el motor propio ni SQLite estén
    ejecutándose.
12. El motor nativo puede probarse y recuperarse sin que rclone esté instalado.

# 6. Fuentes oficiales principales

- [Google Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Google Drive change model](https://developers.google.com/workspace/drive/api/guides/about-changes)
- [Google Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Google Drive errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [SQLite WAL](https://sqlite.org/wal.html)
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html)
- [rclone bisync](https://rclone.org/bisync/)
