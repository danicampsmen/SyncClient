import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { acquirePairLock } from './pairProcessLock';
import {
  RclonePairConfig,
  ensureRcloneLockDirectory,
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

  async run(config: RclonePairConfig): Promise<RcloneRunResult> {
    validateRclonePairConfig(config);
    await validateRcloneConfigPath(config.configPath);
    await ensureRcloneLockDirectory(config.lockDirectory);
    const lock = await acquirePairLock(config.lockDirectory, config.pairId);
    try {
      return await this.runLocked(config);
    } finally {
      await lock.release();
    }
  }

  private runLocked(config: RclonePairConfig): Promise<RcloneRunResult> {
    const args = [
      config.operation,
      config.localPath,
      config.remotePath,
      '--config',
      config.configPath,
      ...(config.dryRun ? ['--dry-run'] : []),
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
      child.once('close', (code) => {
        if (code === 0) resolve({ exitCode: 0, stdout, stderr });
        else reject(new Error(`rclone exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
    });
  }
}
