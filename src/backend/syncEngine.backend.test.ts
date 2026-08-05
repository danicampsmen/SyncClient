import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the pairProcessLock module BEFORE importing SyncEngine so that
// SyncEngine.fastSync will see the mocked acquirePairLock when it's called.
vi.mock('./pairProcessLock', () => {
  class PairAlreadyRunningError extends Error {
    constructor(public readonly pairId: string) {
      super(`A synchronization process is already active for pair ${pairId}`);
      this.name = 'PairAlreadyRunningError';
    }
  }
  return {
    acquirePairLock: async (_lockDir: string, _pairId: string) => {
      throw new PairAlreadyRunningError('pair-a');
    },
    PairAlreadyRunningError,
  };
});

import { SyncEngine } from './syncEngine';

const createdInstances: SyncEngine[] = [];

beforeEach(() => {
  // Prevent the heavy init() behaviour performed in the constructor by
  // mocking the prototype.init to a no-op before constructing instances.
  vi.spyOn(SyncEngine.prototype as any, 'init').mockImplementation(async function () {
    // leave minimal state to let methods under test run
    (this as SyncEngine).pairs = [] as any;
    (this as SyncEngine).pairRootRemoteFolderId = new Map();
    (this as SyncEngine).intervalRefs = {} as any;
    (this as SyncEngine).watchers = {} as any;
    (this as SyncEngine).pendingConflicts = [] as any;
  });
});

afterEach(async () => {
  // restore mocks
  vi.restoreAllMocks();
  // cleanup any created instances (if needed in the future)
  createdInstances.splice(0).forEach(() => {});
});

describe('SyncEngine backend behaviors (unit)', () => {
  it('fastSync should handle PairAlreadyRunningError from acquirePairLock and not throw', async () => {
    const engine = new SyncEngine();
    createdInstances.push(engine);

    // Provide minimal environment so fastSync does not early-return
    (engine as any).db = {};
    (engine as any).accessToken = 'token';

    const pair = { id: 'pair-a', localPath: '/tmp', remotePath: 'GoogleDrive:/Test' } as any;
    engine.pairs = [pair];

    // Call fastSync with a single path. The mocked acquirePairLock will throw
    // PairAlreadyRunningError and fastSync should catch and return without throwing.
    await expect(engine.fastSync(pair, [{ relPath: 'file.txt' }])).resolves.toBeUndefined();
  });

  it('setPairs should clear pairRootRemoteFolderId cache', async () => {
    const engine = new SyncEngine();
    createdInstances.push(engine);

    const pair = { id: 'pair-x', localPath: '/tmp/x', remotePath: 'GoogleDrive:/Old' } as any;
    engine.pairs = [pair];
    engine.pairRootRemoteFolderId.set(pair.id, 'old-remote-id');

    // Spy on saveState/refreshWatchers/refreshIntervals to avoid side effects
    vi.spyOn(engine as any, 'saveState').mockImplementation(async () => {});
    vi.spyOn(engine as any, 'refreshWatchers').mockImplementation(() => {});
    vi.spyOn(engine as any, 'refreshIntervals').mockImplementation(() => {});

    // Call setPairs with a changed remotePath for the same pair id
    const newPairs = [{ ...pair, remotePath: 'GoogleDrive:/New' }];
    await engine.setPairs(newPairs as any);

    expect(engine.pairRootRemoteFolderId.has(pair.id)).toBe(false);
  });
});
