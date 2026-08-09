#!/usr/bin/env node

/**
 * SyncClient CLI - Herramienta de Control de Terminal
 * Controla el demonio backend de SyncClient (127.0.0.1:3000)
 */

import process from 'node:process';

const BACKEND_URL = process.env.SYNCCLIENT_BACKEND_URL || 'http://127.0.0.1:3000/api';

// --- Colores ANSI para la Terminal ---
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

async function apiRequest(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${BACKEND_URL}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${res.status}`);
    }

    return await res.json();
  } catch (err: any) {
    console.error(`${colors.red}${colors.bold}❌ Error de conexión con el demonio SyncClient:${colors.reset} ${err.message || err}`);
    console.error(`${colors.dim}Asegúrate de que el servidor backend esté activo en http://127.0.0.1:3000${colors.reset}\n`);
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'status': {
      const data = await apiRequest('/sync/status');
      console.log(`\n${colors.bold}${colors.cyan}======================================================${colors.reset}`);
      console.log(`             ${colors.bold}⚡ SYNCCLIENT CLI STATUS${colors.reset}`);
      console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}\n`);

      const pairs = data.pairs || [];
      if (pairs.length === 0) {
        console.log(`${colors.yellow}No hay carpetas de sincronización configuradas.${colors.reset}\n`);
        return;
      }

      pairs.forEach((p: any) => {
        const statusColor = p.status === 'syncing' ? colors.cyan : p.status === 'idle' ? colors.green : p.status === 'paused' ? colors.yellow : colors.red;
        const engineLabel = p.engineType === 'rclone' ? '🚀 RCLONE CLI' : '⚡ NATIVO V2';
        
        console.log(`${colors.bold}${statusColor}[${p.status.toUpperCase()}]${colors.reset} ${colors.bold}${p.id}${colors.reset} (${colors.magenta}${engineLabel}${colors.reset})`);
        console.log(`  📁 Local:  ${colors.dim}${p.localPath}${colors.reset}`);
        console.log(`  ☁️ Remote: ${colors.blue}${p.remotePath}${colors.reset}`);

        if (p.progress) {
          const prog = p.progress;
          console.log(`  🔄 Progreso: ${prog.percentage}% (${formatBytes(prog.bytesTransferred)} / ${formatBytes(prog.totalBytes)}) - ${prog.currentFile || ''}`);
        }
        console.log('');
      });

      if (data.pendingConflicts && data.pendingConflicts.length > 0) {
        console.log(`${colors.yellow}${colors.bold}⚠️ Conflictos Pendientes (${data.pendingConflicts.length}):${colors.reset}`);
        data.pendingConflicts.forEach((c: any) => {
          console.log(`  • ID: ${c.id} | Archivo: ${c.relativePath}`);
        });
        console.log(`${colors.dim}Usa 'syncclient resolve <conflictId> <local|remote|rename>' para resolver.${colors.reset}\n`);
      }
      break;
    }

    case 'sync': {
      const pairId = args[1];
      if (pairId) {
        await apiRequest('/sync/force', 'POST', { pairId });
        console.log(`${colors.green}⚡ Sincronización forzada iniciada para el par: ${pairId}${colors.reset}`);
      } else {
        const status = await apiRequest('/sync/status');
        for (const p of status.pairs) {
          await apiRequest('/sync/force', 'POST', { pairId: p.id });
        }
        console.log(`${colors.green}⚡ Sincronización forzada iniciada para todas las carpetas.${colors.reset}`);
      }
      break;
    }

    case 'dedup': {
      const pairId = args[1];
      if (!pairId) {
        console.error(`${colors.red}Error: Especifica el ID de la carpeta. Ejemplo: syncclient dedup wbbgaigay${colors.reset}`);
        return;
      }
      console.log(`${colors.yellow}⏳ Ejecutando deduplicación inteligente a demanda para ${pairId}...${colors.reset}`);
      const res = await apiRequest('/sync/clean-duplicates', 'POST', { pairId });
      console.log(`${colors.green}✨ Resultado de limpieza:${colors.reset}`, res.result);
      break;
    }

    case 'pause': {
      const pairId = args[1];
      if (!pairId) {
        console.error(`${colors.red}Error: Especifica el ID de la carpeta. Ejemplo: syncclient pause wbbgaigay${colors.reset}`);
        return;
      }
      await apiRequest('/sync/pause', 'POST', { pairId });
      console.log(`${colors.yellow}⏸️ Estado de pausa alternado para: ${pairId}${colors.reset}`);
      break;
    }

    case 'resolve': {
      const conflictId = args[1];
      const resolution = args[2] as 'local' | 'remote' | 'rename';

      if (!conflictId || !['local', 'remote', 'rename'].includes(resolution)) {
        console.error(`${colors.red}Uso: syncclient resolve <conflictId> <local|remote|rename>${colors.reset}`);
        return;
      }

      await apiRequest('/sync/resolve-conflict', 'POST', { conflictId, resolution });
      console.log(`${colors.green}✅ Conflicto ${conflictId} resuelto usando opción: ${resolution}${colors.reset}`);
      break;
    }

    case 'help':
    default: {
      console.log(`\n${colors.bold}SyncClient CLI — Menú de Comandos:${colors.reset}\n`);
      console.log(`  ${colors.cyan}syncclient status${colors.reset}               Muestra carpetas, progreso y velocidad`);
      console.log(`  ${colors.cyan}syncclient sync [pairId]${colors.reset}         Forzar sincronización inmediata`);
      console.log(`  ${colors.cyan}syncclient dedup <pairId>${colors.reset}        Limpiar duplicados a demanda`);
      console.log(`  ${colors.cyan}syncclient pause <pairId>${colors.reset}        Pausar/Reanudar vigilancia de carpeta`);
      console.log(`  ${colors.cyan}syncclient resolve <id> <opt>${colors.reset}   Resolver conflicto (local|remote|rename)`);
      console.log(`  ${colors.cyan}syncclient help${colors.reset}                  Muestra este menú de ayuda\n`);
      break;
    }
  }
}

main();