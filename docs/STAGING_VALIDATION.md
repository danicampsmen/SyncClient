STAGING VALIDATION CHECKLIST

Objetivo
- Validar en un entorno de staging que la renovación de tokens y la resolución de conflictos funcionan con credenciales reales y con la configuración VITE_*.

Requisitos
- Variables de entorno en staging (ejemplo):
  - VITE_FIREBASE_OAUTH_CLIENT_ID=... (o VITE_GOOGLE_CLIENT_ID)
  - VITE_FIREBASE_OAUTH_CLIENT_SECRET=... (o VITE_GOOGLE_CLIENT_SECRET)
  - Asegurarse de que SecureStore contiene un `gdrive_refresh_token` válido para la cuenta de prueba.
- Un servidor staging capaz de ejecutar el backend (Node 20) y el proceso Electron si aplica.

Pasos de validación
1) Preparar entorno
   - Exportar variables env en el host o en el .env de staging:
     export VITE_FIREBASE_OAUTH_CLIENT_ID="..."
     export VITE_FIREBASE_OAUTH_CLIENT_SECRET="..."
   - Colocar refresh_token en SecureStore (ejemplo con sqlite-backed secure store o manualmente en staging storage). Si no es posible, realizar un inicio de sesión completo en staging para obtener el refresh_token.

2) Iniciar backend en modo desarrollo
   - npm ci
   - npm run dev
   - Verificar logs del backend para mensajes de autenticación.

3) Forzar expiración y probar renovación
   - Simular expiración: en SecureStore setear gdrive_token_expiry a 0 o un timestamp pasado.
   - Llamar ensureValidToken() desde la UI o ejecutar un script pequeño (ver ejemplo abajo) que importe ./auth y llame ensureValidToken().
   - Verificar en logs que el backend envía una petición POST a https://oauth2.googleapis.com/token con client_id correcto y que la respuesta devuelve un access_token.

Ejemplo de script local para probar renovación (no subir a repo con credenciales):

// scripts/test-refresh.js
// Ejecutar: VITE_FIREBASE_OAUTH_CLIENT_ID=... VITE_FIREBASE_OAUTH_CLIENT_SECRET=... node scripts/test-refresh.js

/*
import('./dist/server.cjs').then(async (mod) => {
  const { ensureValidToken } = await import('../src/auth');
  const token = await ensureValidToken();
  console.log('Token obtenido:', token);
});
*/

4) Validar resolveConflict (usar par de staging con conflicto reproducible)
   - Crear conflicto: modificar archivo localmente y en Drive (o manipular DB) para generar pendingConflicts.
   - Llamar endpoint de backend que resuelve conflicto (o usar UI) seleccionando 'Usar Local'.
   - Verificar que la petición de upload a Drive usa un parent id alfanumérico (no la ruta) y que el conflict desaparece.

Observabilidad
- Habilitar logs a nivel info/debug en SyncEngine para capturar:
  - [SyncEngine/Auth] Token recibido/renovado
  - [SyncEngine/ResolveConflict] Upload parentId
  - [SyncEngine/Drive] Drive API request/response statuses

Si algo falla
- Recolectar logs, el body POST enviado a oauth2.googleapis.com/token (sin tokens completos), y revisar que las vars VITE_* son las esperadas.
- No compartir refresh_token o client_secret en canales públicos.
