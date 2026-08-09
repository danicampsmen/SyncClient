import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { acquirePairLock, type PairLock } from './pairProcessLock';
import {
  RclonePairConfig,
  ensureRcloneLockDirectory,
  getRcloneRemoteSections,
  validateRcloneConfigPath,
  validateRclonePairConfig,
} from '../shared/rcloneConfig';

export interface RcloneRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RcloneSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class RcloneRunner {
  constructor(
    private readonly spawnProcess: RcloneSpawn = defaultSpawn,
    private readonly binary = 'rclone',
  ) {}

  async run(config: RclonePairConfig, existingLock?: PairLock): Promise<RcloneRunResult> {
    validateRclonePairConfig(config);
    await validateRcloneConfigPath(config.configPath);
    await ensureRcloneLockDirectory(config.lockDirectory);

    // Reutilizar el PairLock de SyncEngine si ya fue adquirido
    if (existingLock) {
      return await this.runLocked(config);
    }

    const lock = await acquirePairLock(config.lockDirectory, config.pairId);
    try {
      return await this.runLocked(config);
    } finally {
      await lock.release();
    }
  }

  /**
   * Resuelve el nombre del remoto mapeándolo con las secciones reales de rclone.conf
   */
  private async resolveRemotePath(config: RclonePairConfig): Promise<string> {
    const availableSections = await getRcloneRemoteSections(config.configPath);
    const colonIndex = config.remotePath.indexOf(':');
    if (colonIndex === -1) return config.remotePath;

    if (availableSections.length === 0) {
      return config.remotePath;
    }

    const requestedRemote = config.remotePath.slice(0, colonIndex);
    const remoteSubPath = config.remotePath.slice(colonIndex + 1);

    // 1. Coincidencia exacta
    if (availableSections.includes(requestedRemote)) {
      return config.remotePath;
    }

    // 2. Coincidencia inteligente (ej: 'GoogleDrive' -> 'GoogleDrive-Documentos_Ubuntu_Fayfer')
    const matched = availableSections.find(s =>
      s.toLowerCase() === requestedRemote.toLowerCase() ||
      s.toLowerCase().includes(requestedRemote.toLowerCase()) ||
      requestedRemote.toLowerCase().includes(s.toLowerCase())
    );

    if (matched) {
      return `${matched}:${remoteSubPath}`;
    }

    // 3. Fallback: usar la primera sección encontrada en rclone.conf
    return `${availableSections[0]}:${remoteSubPath}`;
  }

  private async runLocked(config: RclonePairConfig, isRetry = false): Promise<RcloneRunResult> {
    const resolvedRemote = await this.resolveRemotePath(config);
    const shouldResync = config.resync || isRetry;
    const resyncMode = config.resyncMode || 'newer';

    const args = [
      config.operation,
      config.localPath,
      resolvedRemote,
      '--config',
      config.configPath,
      ...(config.dryRun ? ['--dry-run'] : []),
      ...(shouldResync && config.operation === 'bisync' ? ['--resync', '--resync-mode', resyncMode] : []),
    ];

    const child = this.spawnProcess(this.binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', async (code) => {
        if (code === 0) {
          resolve({ exitCode: 0, stdout, stderr });
        } else {
          const needsResync = stderr.includes('Must run --resync') 
            || stderr.includes('cannot find prior') 
            || stderr.includes('differs') 
            || stderr.includes('safety check');

          if (!isRetry && config.operation === 'bisync' && needsResync) {
            this.runLocked({ ...config, resync: true, resyncMode: 'newer' }, true)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error(`rclone exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`));
          }
        }
      });
    });
  }
}
