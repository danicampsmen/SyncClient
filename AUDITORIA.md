# Auditoría de SyncClient — Resultado Final

## Resumen
Se identificaron **16 bugs** en total. **16 corregidos (100%)**. App compilada e instalada en esta PC.

---

## 🔴 Bloqueantes (5/5 corregidos)

| Bug | Archivo | Descripción |
|-----|---------|------------|
| **B1** | `src/services/SyncEngine.ts` | Android OOM: subida carga archivo entero como base64 en RAM |
| **B2** | `src/auth.ts` | Auth web sin `access_type=offline` → sin refresh_token |
| **B3** | `src/services/SyncEngine.ts` | Android `listDriveFiles()` no incluye `md5Checksum` |
| **B4** | `src/services/SyncEngine.ts` | `deleteDriveFile`/`renameDriveFile`/`createDriveFolder` sin rate limiting |
| **B5** | `src/backend/syncEngine.ts` | Desktop no excluye `.syncmeta` de uploads |

## 🟡 Altos (5/5 corregidos)

| Bug | Archivo | Descripción |
|-----|---------|------------|
| **B6** | `src/backend/syncEngine.ts` | Race condition `syncDirectoryTree` (Promise.all → secuencial) |
| **B7** | `src/drive.ts` | `uploadFile()` no retry en 401 durante subida resumable |
| **B8** | `src/services/SyncEngine.ts` | Android `downloadDriveFile()` no verificaba integridad |
| **B9** | `electron/main.cjs` | client_id hardcodeado en URL OAuth |
| **B10** | `server.ts` | `isPathAllowed` no resuelve symlinks |

## 🟢 Medios (5/5 corregidos)

| Bug | Archivo | Descripción |
|-----|---------|------------|
| **B11** | `src/backend/syncEngine.ts` | `saveState()` debounce guardaba primera versión, no última |
| **B12** | Ambos motores | Resumable upload no maneja HTTP 308 |
| **B13** | `src/backend/syncEngine.ts` | `downloadDriveBinary` importaba `crypto` por llamada |
| **B14** | `src/auth.ts` | `pollBackendForToken` timeout de 5 minutos |
| **B15** | `src/components/SyncApp.tsx` | `handleLogout` no limpiaba tokens |

## 🔵 Descubierto en Runtime (B16)

| Bug | Archivo | Descripción |
|-----|---------|------------|
| **B16** | `src/backend/syncEngine.ts` | `duplex: 'half'` requerido en Node.js 20+ para fetch con body stream (**rompía botones de conflicto**) |

---

## Archivos Modificados (7 archivos)

| Archivo | Bugs |
|---------|------|
| `src/services/SyncEngine.ts` | B1, B3, B4, B8, B12, anti-bucle, .syncmeta |
| `src/backend/syncEngine.ts` | B5, B6, B11, B12, B13, B16 |
| `src/drive.ts` | B7 |
| `electron/main.cjs` | B9 |
| `server.ts` | B10 |
| `src/auth.ts` | B14 |
| `src/components/SyncApp.tsx` | B15 |

## Instalación en esta PC

- ✅ `npm install` → dependencias instaladas
- ✅ `npm run build` → compilado (Vite + esbuild)
- ✅ `npm start` → Electron ejecutándose con backend en `http://localhost:3000`
- ✅ `tsc --noEmit` → 0 errores TypeScript

**Total: 16/16 bugs corregidos (100%)** 🎉