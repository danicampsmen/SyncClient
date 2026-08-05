#!/usr/bin/env node
/*
 E2E helper to validate token refresh on a staging backend.
 Usage (replace <STAGING_URL> or use --staging-url):
  node scripts/e2e-test-refresh.js --staging-url <STAGING_URL> [--force-expire] [--inject-refresh=REFRESH_TOKEN]

 The script is conservative: it will attempt optional admin test endpoints if present:
  - POST /api/test/inject-refresh  { refresh_token }
  - POST /api/test/force-expire    {}
  - POST /api/test/ensure-refresh  {}  -> triggers backend to call ensureValidToken and returns status
 If those endpoints are not available (404), the script prints explicit curl commands and manual steps.

 IMPORTANT: Do NOT paste client_secret or refresh_token in public channels. Use this script locally and provide tokens only to the staging host.
*/

import fetch from 'node-fetch';
import process from 'node:process';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { stagingUrl: null, forceExpire: false, injectRefresh: null };
  for (const a of args) {
    if (a.startsWith('--staging-url=')) out.stagingUrl = a.split('=')[1];
    else if (a === '--force-expire') out.forceExpire = true;
    else if (a.startsWith('--inject-refresh=')) out.injectRefresh = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/e2e-test-refresh.js --staging-url <URL> [--force-expire] [--inject-refresh=REFRESH_TOKEN]');
      process.exit(0);
    }
  }
  return out;
}

function showEnvHints() {
  console.log('\nComprobar variables de entorno (local):');
  console.log('  - VITE_FIREBASE_OAUTH_CLIENT_ID (o VITE_GOOGLE_CLIENT_ID)');
  console.log('  - VITE_FIREBASE_OAUTH_CLIENT_SECRET (o VITE_GOOGLE_CLIENT_SECRET)');
  console.log('Si usas este script apuntando al backend staging, asegúrate que el staging tenga estas variables en su entorno de ejecución.');
}

async function tryEndpoint(url, method = 'POST', body = null) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      timeout: 15000,
    });
    return res;
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

(async () => {
  const { stagingUrl, forceExpire, injectRefresh } = parseArgs();
  if (!stagingUrl) {
    console.error('ERROR: Debes pasar --staging-url <STAGING_URL> o editar el placeholder <STAGING_URL> en el script.');
    process.exit(2);
  }

  console.log(`E2E helper apuntando a: ${stagingUrl}`);
  showEnvHints();

  // 1) Health check
  console.log('\n1) Comprobando conectividad al backend...');
  const health = await tryEndpoint(`${stagingUrl.replace(/\/$/, '')}/api/health`, 'GET');
  if (health && (health.ok || health.status === 200)) {
    console.log(' - Backend accesible (GET /api/health ok)');
  } else {
    console.log(' - /api/health no respondió 200. Si tu backend no expone /api/health está bien; continuaré con intentos no invasivos.');
  }

  // 2) Optional: inject refresh token
  if (injectRefresh) {
    console.log('\n2) Intentando inyectar refresh_token vía endpoint de pruebas (si está disponible)...');
    const injectUrl = `${stagingUrl.replace(/\/$/, '')}/api/test/inject-refresh`;
    const res = await tryEndpoint(injectUrl, 'POST', { refresh_token: injectRefresh });
    if (res && res.ok) {
      console.log(' - OK: /api/test/inject-refresh respondió OK');
    } else {
      console.log(` - /api/test/inject-refresh no disponible (status: ${res.status}). Puedes inyectar manualmente con curl:`);
      console.log(`   curl -X POST '${injectUrl}' -H 'Content-Type: application/json' -d '{"refresh_token":"<REFRESH_TOKEN>"}'`);
    }
  } else {
    console.log('\n2) No se proporcionó --inject-refresh. Si necesitas inyectar refresh_token, usa el endpoint /api/test/inject-refresh o sigue las instrucciones en docs/STAGING_VALIDATION.md');
  }

  // 3) Optional: force expire
  if (forceExpire) {
    console.log('\n3) Intentando forzar expiración en el backend (endpoint de pruebas /api/test/force-expire)...');
    const feUrl = `${stagingUrl.replace(/\/$/, '')}/api/test/force-expire`;
    const res = await tryEndpoint(feUrl, 'POST', {});
    if (res && res.ok) {
      console.log(' - OK: /api/test/force-expire respondió OK');
    } else {
      console.log(` - /api/test/force-expire no disponible (status: ${res.status}). Puedes forzar expiración manualmente si tu staging permite modificar SecureStore o la base de datos (set gdrive_token_expiry a 0).`);
      console.log('   Ejemplo (si tu staging tiene un endpoint de test):');
      console.log(`   curl -X POST '${feUrl}' -H 'Content-Type: application/json' -d '{}'`);
    }
  }

  // 4) Trigger refresh attempt
  console.log('\n4) Solicitando al backend que ejecute ensureValidToken (si existe un endpoint de prueba /api/test/ensure-refresh)...');
  const ensureUrl = `${stagingUrl.replace(/\/$/, '')}/api/test/ensure-refresh`;
  const resEnsure = await tryEndpoint(ensureUrl, 'POST', {});
  if (resEnsure && resEnsure.ok) {
    console.log(' - /api/test/ensure-refresh respondió OK. Respuesta:');
    try {
      const json = await resEnsure.json();
      // Avoid printing secrets; only show non-sensitive keys
      console.log(JSON.stringify(json, Object.keys(json).filter(k => !/token|secret/i.test(k)), 2));
      if (json?.oauth_request) {
        console.log(' - Detected OAuth request info. Mostrando client_id y params (se omiten valores sensibles)');
        const body = json.oauth_request.body || '';
        if (typeof body === 'string') {
          const clientIdMatch = body.match(/client_id=([^&]+)/);
          if (clientIdMatch) console.log('   client_id:', decodeURIComponent(clientIdMatch[1]));
        }
      }
    } catch (e) {
      console.log(' - OK, pero no se pudo parsear JSON de respuesta.');
    }
  } else {
    console.log(' - /api/test/ensure-refresh no existe. Si no hay endpoints de test, realiza estas acciones manualmente en staging:');
    console.log('   1) Asegúrate que SecureStore en staging tiene gdrive_refresh_token válido (o realiza sign-in interactivo para obtenerlo).');
    console.log('   2) Forzar expiración: ajustar gdrive_token_expiry a 0 en storage o usar endpoint de test si lo hay.');
    console.log('   3) Invocar ensureValidToken() desde el backend:');
    console.log(`      - Si tienes SSH: ssh user@staging 'node -e "require(\'./path/to/dist/server.cjs\').then(m=>m.ensureValidToken())"'`);
    console.log('      - O, llama al endpoint público/privado que dispare la renovación (implementar /api/test/ensure-refresh si falta).');
  }

  console.log('\nFIN — revisa docs/STAGING_VALIDATION.md para pasos detallados y cómo limpiar tokens tras la prueba.');
  process.exit(0);
})();
