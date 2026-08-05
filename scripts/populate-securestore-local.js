#!/usr/bin/env node
/*
 Helper to show example curl commands to inject a refresh_token into staging SecureStore
 This script does NOT perform any remote actions by default — it prints recommended curl examples

 Usage example (local):
   node scripts/populate-securestore-local.js --staging-url <STAGING_URL> --refresh-token <REFRESH_TOKEN>

 Security: never paste secrets into public logs. Use this locally and ensure the shell history is protected.
*/

import process from 'node:process';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { stagingUrl: null, refreshToken: null };
  for (const a of args) {
    if (a.startsWith('--staging-url=')) out.stagingUrl = a.split('=')[1];
    else if (a.startsWith('--refresh-token=')) out.refreshToken = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/populate-securestore-local.js --staging-url <STAGING_URL> --refresh-token <REFRESH_TOKEN>');
      process.exit(0);
    }
  }
  return out;
}

const { stagingUrl, refreshToken } = parseArgs();
if (!stagingUrl) {
  console.log('ERROR: provide --staging-url');
  process.exit(2);
}

console.log('\nEjemplos para inyectar refresh_token en staging:');
console.log('\n1) Si el backend expone el endpoint de test (recomendado para staging controlado):');
console.log(`   curl -X POST '${stagingUrl.replace(/\/$/, '')}/api/test/inject-refresh' -H 'Content-Type: application/json' -d '{"refresh_token":"<REFRESH_TOKEN>"}'`);

console.log('\n2) Si tienes acceso SSH al host de staging (ejecutar comando node en el host para guardar el token):');
console.log("   ssh user@staging 'node -e \"(async()=>{ const SecureStore=require(\'./path/to/dist/server.cjs\').SecureStore; await SecureStore.set(\\'gdrive_refresh_token\\', \\\"<REFRESH_TOKEN>\\\"); console.log(\\'ok\\'); })()\"' ");

console.log('\n3) Si tu staging tiene una consola administrativa o base de datos, guarda el valor en la clave gdrive_refresh_token (ej. sqlite, localStorage, etc.).');

if (refreshToken) {
  console.log('\nComando con token embebido (toma precauciones):');
  console.log(`  curl -X POST '${stagingUrl.replace(/\/$/, '')}/api/test/inject-refresh' -H 'Content-Type: application/json' -d '{"refresh_token":"${refreshToken}"}'`);
}

console.log('\nRecuerda: elimina o rota el refresh_token tras finalizar pruebas si es temporal.');
