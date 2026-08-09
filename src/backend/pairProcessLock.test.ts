import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquirePairLock, PairAlreadyRunningError } from './pairProcessLock';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('acquirePairLock', () => {
  it('prevents concurrent runs and makes shutdown cleanup idempotent', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-lock-'));
    temporaryDirectories.push(directory);
    const first = await acquirePairLock(directory, 'pair-a');
    await expect(acquirePairLock(directory, 'pair-a')).rejects.toBeInstanceOf(PairAlreadyRunningError);
    await first.release();
    await first.release();
    await expect(acquirePairLock(directory, 'pair-a')).resolves.toBeDefined();
  });

  it('reclaims a stale lock left by a dead process', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-lock-'));
    temporaryDirectories.push(directory);
    const staleName = createHash('sha256').update('pair-a').digest('hex');
    const stalePath = path.join(directory, `${staleName}.lock`);
    await writeFile(stalePath, JSON.stringify({ pairId: 'pair-a', pid: 999999999, startedAt: new Date().toISOString() }));

    const first = await acquirePairLock(directory, 'pair-a');
    await first.release();
    await expect(acquirePairLock(directory, 'pair-a')).resolves.toBeDefined();
  });
});
