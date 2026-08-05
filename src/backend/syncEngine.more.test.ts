import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pairProcessLock to simulate lock acquisition behavior for concurrency tests
vi.mock('./pairProcessLock', () => {
  class PairAlreadyRunningError extends Error {
    constructor(public readonly pairId: string) {
      super(`A synchronization process is already active for pair ${pairId}`);
      this.name = 'PairAlreadyRunningError';
    }
  }

  let calls = 0;
  return {
    PairAlreadyRunningError,
    acquirePairLock: async (_lockDir: string, _pairId: string) => {
      calls++;
      if (calls === 1) {
        // First caller gets a lock object that never releases until test decides
        let released = false;
        return {
          lockPath: '/tmp/mock.lock',
          async release() {
            if (released) return;
            released = true;
          }
        };
      }
      // Subsequent callers see an active lock
      throw new PairAlreadyRunningError('pair-a');
    }
  };
});

import { SyncEngine } from './syncEngine';
import { acquirePairLock, PairAlreadyRunningError } from './pairProcessLock';

beforeEach(() => {
  // Avoid heavy constructor init
  vi.spyOn(SyncEngine.prototype as any, 'init').mockImplementation(async function () {
    (this as SyncEngine).pairs = [] as any;
    (this as SyncEngine).pairRootRemoteFolderId = new Map();
    (this as SyncEngine).intervalRefs = {} as any;
    (this as SyncEngine).watchers = {} as any;
    (this as SyncEngine).pendingConflicts = [] as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncEngine additional backend tests', () => {
  it('simulates runSync holding the pair lock while fastSync returns cleanly when lock is busy', async () => {
    const engine = new SyncEngine();
    (engine as any).db = {};
    (engine as any).accessToken = 'token';

    const pair = { id: 'pair-a', localPath: '/tmp', remotePath: 'GoogleDrive:/Test' } as any;
    engine.pairs = [pair];

    // Simulate a long-running runSync by acquiring the lock directly (mocked)
    const lock = await acquirePairLock('/tmp/locks', pair.id);

    // Now call fastSync which should attempt to acquire the lock and receive PairAlreadyRunningError
    await expect(engine.fastSync(pair, [{ relPath: 'file.txt' }])).resolves.toBeUndefined();

    // Release the simulated lock
    await lock.release();
  });

  it('recomputes getPairRemoteFolderId after setPairs clears cache', async () => {
    const engine = new SyncEngine();
    // minimal state
    (engine as any).db = {};
    (engine as any).accessToken = 'token';

    const pair = { id: 'p1', localPath: '/tmp/p1', remotePath: 'GoogleDrive:/A/B', cloudCategory: undefined, deviceName: undefined } as any;
    engine.pairs = [pair];

    // Spy save/refresh to avoid side effects
    vi.spyOn(engine as any, 'saveState').mockImplementation(async () => {});
    vi.spyOn(engine as any, 'refreshWatchers').mockImplementation(() => {});
    vi.spyOn(engine as any, 'refreshIntervals').mockImplementation(() => {});

    // Mock listDriveFiles to return folder A under root, and B under idA
    vi.spyOn(engine as any, 'listDriveFiles').mockImplementation(async (folderId: string) => {
      if (folderId === 'root') return [{ name: 'A', mimeType: 'application/vnd.google-apps.folder', id: 'idA' }];
      if (folderId === 'idA') return [{ name: 'B', mimeType: 'application/vnd.google-apps.folder', id: 'idB' }];
      return [];
    });

    const idFirst = await (engine as any).getPairRemoteFolderId(pair);
    expect(idFirst).toBe('idB');
    expect(engine.pairRootRemoteFolderId.get(pair.id)).toBe('idB');

    // Change remotePath via setPairs (which should clear the cache)
    const newPair = { ...pair, remotePath: 'GoogleDrive:/C' };
    await engine.setPairs([newPair]);

    // Update listDriveFiles to return C under root
    (engine as any).listDriveFiles.mockImplementationOnce(async (folderId: string) => {
      if (folderId === 'root') return [{ name: 'C', mimeType: 'application/vnd.google-apps.folder', id: 'idC' }];
      return [];
    });

    const idSecond = await (engine as any).getPairRemoteFolderId(newPair as any);
    expect(idSecond).toBe('idC');
    expect(engine.pairRootRemoteFolderId.get(newPair.id)).toBe('idC');
  });
});
