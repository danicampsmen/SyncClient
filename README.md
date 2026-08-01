<div align="center">
<img width="1200" height="475" alt="SyncClient Banner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# SyncClient — Cliente de Sincronización Google Drive

SyncClient es un cliente de sincronización bidireccional entre **Google Drive** y el **disco local**, diseñado para:

- **Linux Desktop** (Electron + Express backend)
- **Android** (Capacitor nativo)
- **Web** (navegador)

## Características

- Soporte de sincronización upload, download y bidirectional en desarrollo
- Deduplicación configurable de exportaciones (StarNote, etc.)
- Modo espejo (1:1 offline) y modo streaming (stubs virtuales)
- Protecciones anti-bucle para carpetas grandes
- Resolución de conflictos manual en evolución
- Subida resumible para archivos grandes
- ✅ Autenticación con Google OAuth vía Firebase
- ✅ Monitoreo de dispositivos de almacenamiento USB externos

## Arquitectura

```
src/
├── server.ts              # Backend Express (Linux Desktop)
├── electron/              # Main process + preload (Electron)
├── src/
│   ├── auth.ts            # Firebase Auth + Google OAuth
│   ├── drive.ts           # Google Drive API client (web)
│   ├── local.ts           # API de sistema de archivos local
│   ├── types.ts           # Tipos TypeScript
│   ├── backend/
│   │   └── syncEngine.ts  # Motor de sync (Node.js backend)
│   ├── services/
│   │   ├── SyncEngine.ts  # Motor de sync (Capacitor nativo)
│   │   └── syncService.ts # Abstracción de servicio de sync
│   ├── shared/
│   │   └── CoreSyncLogic.ts  # Lógica de sync compartida (DRY)
│   ├── utils/
│   │   ├── fileSystem.ts  # Abstracción de FS (Capacitor)
│   │   └── vfsBridge.ts   # Puente VFS (desktop ↔ nativo)
│   ├── components/
│   │   └── SyncApp.tsx    # UI principal (React + Tailwind)
│   └── App.tsx            # Entry point
```

## Configuración

### Variables de entorno

Copia `.env.example` a `.env.local` y configura:

```bash
cp .env.example .env.local
```

| Variable | Descripción |
|---|---|
| `CORS_ORIGIN` | Origen CORS permitido (opcional, para despliegues personalizados) |

### Firebase

El archivo `firebase-applet-config.json` contiene la configuración de Firebase. Asegúrate de que los siguientes scopes estén habilitados:

- `https://www.googleapis.com/auth/drive`
- `profile`
- `email`

## Desarrollo

### Requisitos

- Node.js >= 20
- npm

### Instalación

```bash
npm install
```

### Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Inicia el servidor backend en modo desarrollo (tsx) |
| `npm run build` | Compila el frontend (Vite) y el backend (esbuild) |
| `npm run start` | Inicia la app en Electron (build + electron) |
| `npm run electron:dev` | Inicia Electron + backend simultáneamente |
| `npm run electron:build` | Genera el instalador (electron-builder) |
| `npm run preview` | Previsualiza el build de Vite |
| `npm run lint` | Verifica tipos TypeScript (`tsc --noEmit`) |
| `npm test` | Ejecuta la suite de pruebas Vitest |
| `npm run android:build` | Compila y copia a Capacitor Android |
| `npm run android:deploy` | Despliega a dispositivo Android conectado |

### Desarrollo con Electron

```bash
npm run electron:dev
```

Esto inicia simultáneamente:
- El servidor Express en `http://localhost:3000`
- La ventana de Electron apuntando al servidor

### Desarrollo Android

```bash
npm run android:build
npx cap open android
```

## Estructura de sincronización

### Pares de sincronización

Cada par define:
- `localPath`: Ruta local en el dispositivo
- `remotePath`: Ruta en Google Drive (ej. `GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes`)
- `direction`: `bidirectional` | `upload` | `download`
- `syncMode`: `mirror` (1:1 offline) | `streaming` (stubs virtuales)
- `cloudCategory`: `shared` (Mi Unidad) | `computers` (Ordenadores)

### Modos de almacenamiento

- **Duplicado (Mirror)**: Archivos reales en disco, disponibles 100% offline
- **Streaming Virtual**: Stubs de 1KB en disco, contenido descargado bajo demanda

### Deduplicación

SyncClient detecta automáticamente archivos numerados como `Nota(1).pdf`, `Nota(2).pdf` y conserva únicamente la última versión, renombrándola al nombre base.

## Seguridad

- CORS restringido a orígenes locales configurados
- OAuth relay para dispositivos móviles sin navegador
- Sesiones aisladas en Electron (partitioned sessions)
- La migración completa de tokens a almacenamiento seguro de escritorio sigue
  pendiente; no usar esta versión como producto de producción sin revisarla.

## Known Issues

- El almacenamiento seguro de tokens para Electron todavía está pendiente.
- `utimes` no está implementado en CapacitorFS; Android usa sidecars `.syncmeta`.
- `VFSBridge.readFile/writeFile` en modo desktop requiere verificación de endpoints.
- La bisincronización incremental de Ubuntu con `changes.list` y cursores SQLite
  está planificada, pero aún no se declara terminada.

Para el plan técnico de Ubuntu, consulta
[`docs/PLAN_BISINCRONIZACION_UBUNTU.md`](docs/PLAN_BISINCRONIZACION_UBUNTU.md).

Para el plan técnico de Android, consulta
[`docs/PLAN_SINCRONIZACION_ANDROID.md`](docs/PLAN_SINCRONIZACION_ANDROID.md).

## Licencia

MIT — Desarrollado por Dani (danicampsmen@gmail.com)
