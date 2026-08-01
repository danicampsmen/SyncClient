He revisado el código clave (README, package.json, server.ts, src/backend/syncEngine.ts, src/auth.ts, src/shared/*, src/components/SyncApp.tsx) buscando fallos funcionales y puntos que provocan errores en tiempo de ejecución. A continuación tienes los problemas más probables, por qué fallan, cómo reproducirlos y correcciones concretas (incluyo snippets listos para aplicar).

Resumen rápido — problemas críticos encontrados
- Error de ruta/ESM en server.ts: uso de import.meta.dirname (no existe en Node ESM) — provoca excepciones al hacer el intercambio de código OAuth que lee firebase-applet-config.json.
- Bug lógico en computeSyncPlan (src/shared/CoreSyncLogic.ts): la construcción del vector clock usa una expresión incorrecta e imposible (JSON.parse sobre remoteId) — produce clocks inválidos y puede romper merges/actualizaciones.
- Uso incorrecto de DB en uploadDriveBinary (src/backend/syncEngine.ts): llamada this.db.getFolderState('') sin pairId — lecturas inútiles/erróneas o excepción dependiendo de la implementación de StorageBackend.
- Riesgo funcional de tokens: access/refresh tokens guardados en localStorage (src/auth.ts + README) → fallo de seguridad y comportamiento errático si token se pierde o expira.
- Comportamientos potencialmente indeseados (no siempre “errores” pero sí fuente de fallos): handling de colisiones case-insensitive vs FS case-sensitive, manejo de utimes en Android (mencionado en README), uso de polling/backoff que puede cortar triggers si timestamps se actualizan erróneamente.

Detalles, reproducción y correcciones propuestas

1) server.ts — import.meta.dirname no existe en ESM
- Dónde: server.ts (ruta: raíz)
- Por qué falla: en Node ESM no existe import.meta.dirname; intentar usarlo lanza ReferenceError o falla al resolver la ruta del archivo firebase-applet-config.json en el intercambio del code → la ruta no se encuentra y la ruta de cliente secreto no se carga.
- Cómo reproducir: iniciar servidor en modo dev (npm run dev) y llamar POST /api/oauth/token?code=...; el servidor intentará leer firebase-applet-config.json y fallará.
- Corrección (usar fileURLToPath/import.meta.url). Reemplaza la lectura con la resolución correcta de __dirname en ESM.

Sugerencia de cambio (cambia en server.ts las importaciones al inicio y la lectura del archivo):

```typescript name=server.ts
// Añadir al top (junto a otros imports)
import { fileURLToPath } from 'url';

// Dentro de la handler donde se lee firebase-applet-config.json, reemplazar:
const configRaw = await fs.readFile(
  path.join(import.meta.dirname, 'firebase-applet-config.json'), 'utf8'
);

// Por:
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configRaw = await fs.readFile(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
```

Motivo: esto es la forma estándar de obtener el directorio del módulo en Node ESM y evitará errores de lectura.

2) src/shared/CoreSyncLogic.ts — vector-clock/JSON.parse bug (three-way merge)
- Dónde: CoreSyncLogic.computeSyncPlan (línea donde construyen vectorClock para uploads)
- Por qué falla: la expresión usada para incrementar el contador es:
  JSON.stringify({ [deviceId]: (JSON.parse(dbEntry.remoteId ? '{}' : '{"' + deviceId + '":0}')[deviceId] || 0) + 1 })
  Esto es incorrecto porque:
  - dbEntry.remoteId es un string (ID remoto), no contiene el vector clock JSON.
  - JSON.parse('{}') y esa lógica devuelve undefined / NaN y no refleja el estado real.
  Resultado: vector clocks inválidos, pérdida de metainformación y conflictos mal detectados.
- Cómo reproducir: sincronizar un fichero que ya aparezca en dbState y forzar upload: la entrada de journal o DB quedará con vector_clock mal formado o siempre con {deviceId:1}, lo que puede romper merges y el control de versiones.

Corrección propuesta: usar un vector clock simple cuando no hay clock disponible (p.ej. JSON.stringify({ [deviceId]: 1 })) o preferir leer un campo vector_clock real desde dbState si está disponible. Dado que dbState aquí no contiene vector_clock, la opción segura y coherente es enviar un clock sencillo.

Reemplaza esa línea por:

```typescript name=src/shared/CoreSyncLogic.ts
// En vez de la expresión compleja, usar:
vectorClock: JSON.stringify({ [deviceId]: 1 })
```

Si quieres soporte completo de vector clocks, hay que extender dbState para incluir vector_clock y usarlo aquí (me lo dices y lo implemento).

3) src/backend/syncEngine.ts — llamada this.db.getFolderState('') sin pairId
- Dónde: uploadDriveBinary (línea donde comentan "no tenemos pairId aquí")
- Por qué falla: se invoca this.db.getFolderState('') con string vacío; dependiendo de la implementación de StorageBackend esto puede:
  - devolver estado de carpeta por default (innecesario),
  - lanzar excepción por id inválido,
  - producir comportamiento silencioso incorrecto.
  Además el comentario indica que no se tiene pairId: la llamada no hace nada útil.
- Cómo reproducir: subir un archivo que use existingFileId → el flujo intentará obtener etag/metadata y puede errorar.
- Corrección: eliminar la llamada o pasar pairId adecuado. Si uploadDriveBinary necesita etag desde DB, la función debe recibir pairId como argumento. Opciones:
  a) Si no es crítico, eliminar el bloque.
  b) Si es deseable validar etag, cambiar la firma uploadDriveBinary(parentId, filePath, targetName?, existingFileId?, pairId?) y pasar pairId desde los llamadores.

Cambio sugerido (simplificar eliminando la llamada inútil):

```typescript name=src/backend/syncEngine.ts
// Eliminar o comentar el bloque:
if (existingFileId && this.db) {
  // const dbState = this.db.getFolderState(''); // no tenemos pairId aquí
  // ... (borrar)
}
```

O (mejor) añadir un TODO y no invocar getFolderState con cadena vacía.

4) Tokens en localStorage — riesgo y fallos prácticos
- Dónde: src/auth.ts, server.ts (relay)
- Problemas:
  - El access_token y refresh_token se almacenan en localStorage (persistente y accesible desde JS): vulnerable a XSS y robo.
  - server.ts acepta client_secret y realiza intercambio en servidor — eso está bien si firebase-applet-config.json está en servidor y el servidor está protegido, pero actualmente server.ts lee el archivo local; en producción la comunicación debería ser sobre HTTPS y secrets almacenados en variables de entorno.
  - auth.ts usa signInWithCredential(auth, credential) con tokens guardados — en algunos flujos esto puede no restaurar full session (missing id_token).
- Riesgos funcionales: pérdida de sesión inesperada, tokens expirados, refresh token inválido si Google no envió refresh_token (si no solicitaste access_type=offline en el flujo correcto).
- Recomendaciones:
  - Mover refresh_token y access_token fuera de localStorage. En Electron usar keytar / secure storage (ej., keytar npm) o cifrar el store. En Android usar Secure Storage plugin de Capacitor.
  - En el backend, no confiar en archivos en repo para client_secret; usar variables de entorno y forzar HTTPS.
  - Añadir manejo robusto de expiración: forzar refresh token flow y, si no hay refresh token, forzar re-auth (ya hay lógica en ensureValidToken/refreshAccessToken, pero insistir en almacenar refresh_token de forma segura).
- Cómo reproducir: iniciar sesión, borrar localStorage, intentar restaurar sesión; confirmar que app vuelve a estado "unauthenticated" o muestra errores.

5) Case-insensitive remote vs case-sensitive FS (p. ej. ext4 vs FAT/Android)
- Dónde: CoreSyncLogic.computeSyncPlan y uso de remoteByLowerName/localByLowerName
- Problema: la comparación se hace case-insensitive (lowercasing) para Drive, pero en sistemas Linux la FS puede ser case-sensitive; puede crear duplicados o sobrescrituras incorrectas.
- Mitigación: documentarlo y, si quieres, permitir una configuración por par (caseSensitive: boolean) o mantener mapping original+lowercase y avisar en UI cuando hay diferencias de caso.

6) Otras observaciones menores (potenciales fallos)
- upload resumable: el flujo intenta resumable init con POST/PATCH y luego PUT al session URI — si initRes no retorna Location, cae a multipart fallback; esto está bien, pero conviene controlar códigos 2xx/3xx y reportar error explícito si uploadRes no ok.
- listDriveFiles pageSize '1000' ok (Drive soporta hasta 1000), pero si muchas llamadas se hace caching y posibles staleness — ok porque cache TTL es 60s.
- En v2SyncDirectoryTree, reconcileWithHttp304 usa If-Modified-Since en lugar de If-None-Match (etag) porque list no devuelve etag: correcto aunque menos eficiente.

Pruebas / pasos para reproducir errores detectados
- Para import.meta.dirname:
  1. npm run dev
  2. POST /api/oauth/token con code para simular authorization code flow (o intentar login móvil que dispara server exchange)
  3. Ver logs: debería aparecer error al leer firebase-applet-config.json o exception ReferenceError.

- Para computeSyncPlan/vector clocks:
  1. Configurar un par con archivo ya presente en DB (insertar manualmente estado con remoteId).
  2. Modificar archivo local y forzar sync; revisar journal/DB o evento upload: vector_clock en DB debe ser JSON válido; si no, verás inconsistencias.

- Para this.db.getFolderState(''):
  1. Forzar subida con existingFileId (editar un archivo que ya existe remotamente).
  2. Inspeccionar logs para excepciones relacionadas con StorageBackend.getFolderState.

Acción que puedo hacer por ti
- Puedo abrir un PR con las correcciones críticas (1-3) aplicadas y tests básicos añadidos (por ejemplo, unit test pequeño para computeSyncPlan que valida vectorClock output). Dime si quieres que haga los cambios y target branch (usaré main por defecto).
- Puedo también producir un checklist de seguridad (migrar tokens a keytar/secure storage, forzar HTTPS, rotar client_secret) y aplicar algunos cambios iniciales (p. ej. mover lectura de firebase-applet-config.json a variables de entorno en server.ts).

Qué he hecho hasta ahora
- He listado y leído: README.md, package.json, server.ts, src/backend/syncEngine.ts, src/auth.ts, src/components/SyncApp.tsx, src/shared/CoreSyncLogic.ts, src/shared/* (Scanner, StorageBackend, VectorClock, tests).
- Identifiqué los puntos con alto probabilidad de fallo en ejecución y propones cambios concretos y reproducibles.

¿Quieres que aplique los cambios ahora y cree un PR con:
- la corrección ESM en server.ts,
- la corrección en computeSyncPlan (vectorClock),
- eliminar la llamada errónea a this.db.getFolderState('') en uploadDriveBinary,
- y (opcional) añadir un test unitario para computeSyncPlan?

Si sí, indícame a qué branch crear el PR (o lo hago en la rama por defecto/main).