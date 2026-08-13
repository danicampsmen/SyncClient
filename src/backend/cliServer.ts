import http from 'node:http';
import { syncEngine } from './syncEngine';

export interface CliCommand {
  command: string;
  args: string[];
}

export interface CliResponse {
  success: boolean;
  output: string;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function executeCliCommand(cmd: CliCommand): Promise<CliResponse> {
  const { command, args } = cmd;
  try {
    switch (command) {
      case 'status': {
        const status = syncEngine.getStatus();
        const lines: string[] = [];
        lines.push(`SyncClient CLI - Status`);
        lines.push(`Pairs: ${status.pairs.length}`);
        for (const p of status.pairs) {
          const engineLabel = p.engineType === 'rclone' ? 'RCLONE' : 'NATIVE';
          lines.push(`[${p.status.toUpperCase()}] ${p.id} (${engineLabel})`);
          lines.push(`  Local: ${p.localPath}`);
          lines.push(`  Remote: ${p.remotePath}`);
          if (p.progress) {
            lines.push(`  Progress: ${p.progress.percentage}% (${formatBytes(p.progress.bytesTransferred)} / ${formatBytes(p.progress.totalBytes)})`);
          }
        }
        if (status.pendingConflicts.length > 0) {
          lines.push(`Conflicts: ${status.pendingConflicts.length}`);
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'sync': {
        const pairId = args[0];
        if (pairId) {
          await syncEngine.forceSync(pairId);
          return { success: true, output: `Sync forced for pair: ${pairId}` };
        } else {
          const status = syncEngine.getStatus();
          for (const p of status.pairs) {
            await syncEngine.forceSync(p.id);
          }
          return { success: true, output: 'Sync forced for all pairs' };
        }
      }

      case 'pause': {
        const pairId = args[0];
        if (!pairId) {
          return { success: false, output: '', error: 'Missing pairId' };
        }
        await syncEngine.togglePairSync(pairId);
        return { success: true, output: `Toggled pause for: ${pairId}` };
      }

      case 'resolve': {
        const conflictId = args[0];
        const resolution = args[1] as 'local' | 'remote' | 'rename';
        if (!conflictId || !['local', 'remote', 'rename'].includes(resolution)) {
          return { success: false, output: '', error: 'Usage: resolve <conflictId> <local|remote|rename>' };
        }
        await syncEngine.resolveConflict(conflictId, resolution as any);
        return { success: true, output: `Conflict ${conflictId} resolved with ${resolution}` };
      }

      case 'dedup': {
        const pairId = args[0];
        if (!pairId) {
          return { success: false, output: '', error: 'Missing pairId' };
        }
        const result = await syncEngine.cleanDuplicates(pairId);
        return { success: true, output: `Dedup result: ${JSON.stringify(result)}` };
      }

      default:
        return { success: false, output: '', error: `Unknown command: ${command}` };
    }
  } catch (err: any) {
    return { success: false, output: '', error: err.message || String(err) };
  }
}

export function startCliServer(port: number = 3001): void {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/cli/execute') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const cmd: CliCommand = JSON.parse(body);
          const result = await executeCliCommand(cmd);
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/cli/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    console.log(`[CLI Server] Listening on port ${port}`);
  });
}
