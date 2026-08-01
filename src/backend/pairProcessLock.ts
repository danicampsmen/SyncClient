import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface PairLock {
  readonly lockPath: string;
  release(): Promise<void>;
}

export class PairAlreadyRunningError extends Error {
  constructor(public readonly pairId: string) {
    super(`A synchronization process is already active for pair ${pairId}`);
    this.name = 'PairAlreadyRunningError';
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    let metadata: { pid?: number } | null = null;
    try {
      metadata = JSON.parse(raw) as { pid?: number };
    } catch {
      metadata = null;
    }

    if (metadata?.pid && Number.isInteger(metadata.pid)) {
      if (await isProcessAlive(metadata.pid)) return false;
    }

    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function acquirePairLock(lockDirectory: string, pairId: string): Promise<PairLock> {
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const safeName = createHash('sha256').update(pairId).digest('hex');
  const lockPath = path.join(lockDirectory, `${safeName}.lock`);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const reclaimed = await reclaimStaleLock(lockPath);
      if (reclaimed) {
        handle = await fs.open(lockPath, 'wx', 0o600);
      } else {
        throw new PairAlreadyRunningError(pairId);
      }
    } else {
      throw error;
    }
  }

  await handle.writeFile(JSON.stringify({ pairId, pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  let released = false;
  return {
    lockPath,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await fs.rm(lockPath, { force: true });
    },
  };
}
