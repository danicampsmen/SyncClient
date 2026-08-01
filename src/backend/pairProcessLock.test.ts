import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquirePairLock, PairAlreadyRunningError } from './pairProcessLock';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('acquirePairLock', () => {
  it('prevents concurrent runs for the same pair and releases safely', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-lock-'));
    temporaryDirectories.push(directory);
    const first = await acquirePairLock(directory, 'pair-a');
    await expect(acquirePairLock(directory, 'pair-a')).rejects.toBeInstanceOf(PairAlreadyRunningError);
    await first.release();
    await expect(acquirePairLock(directory, 'pair-a')).resolves.toBeDefined();
  });
});
