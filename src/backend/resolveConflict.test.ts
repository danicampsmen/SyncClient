import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

// Mock heavy init in constructor
vi.spyOn(require('./syncEngine').SyncEngine.prototype as any, 'init').mockImplementation(async function () {
  (this as any).pairs = [];
  (this as any).pairRootRemoteFolderId = new Map();
  (this as any).intervalRefs = {};
  (this as any).watchers = {};
  (this as any).pendingConflicts = [];
});

import { SyncEngine } from './syncEngine';

describe('SyncEngine.resolveConflict (local) behavior', () => {
  let engine: SyncEngine;
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-mock init after restore
    vi.spyOn(require('./syncEngine').SyncEngine.prototype as any, 'init').mockImplementation(async function () {
      (this as any).pairs = [];
      (this as any).pairRootRemoteFolderId = new Map();
      (this as any).intervalRefs = {};
      (this as any).watchers = {};
      (this as any).pendingConflicts = [];
    });
    engine = new SyncEngine();
    (engine as any).db = { updateOperation: () => {}, setFileState: () => {} };
    (engine as any).accessToken = 'token';
  });

  it('uses getPairRemoteFolderId (folder id) when uploading local resolution', async () => {
    const pair = { id: 'pair1', localPath: '/tmp/pair1', remotePath: 'GoogleDrive:/Some/Path' } as any;
    engine.pairs = [pair];

    const conflict = {
      id: 'conf-1', pairId: pair.id, localPath: 'docs/file.txt', remoteFileId: 'r123', remoteFileName: 'file.txt', remoteMtime: Date.now(), localHash: 'lh', remoteHash: 'rh'
    } as any;
    engine.pendingConflicts = [conflict];

    // Mock getPairRemoteFolderId to return a numeric/alpha folder id
    const mockedFolderId = 'folder123';
    vi.spyOn(engine as any, 'getPairRemoteFolderId').mockResolvedValue(mockedFolderId);

    // Spy uploadDriveBinary
    const uploadSpy = vi.spyOn(engine as any, 'uploadDriveBinary').mockImplementation(async (parentId: string) => {
      return { id: 'newRemoteId', modifiedTime: new Date().toISOString(), md5Checksum: 'abc' } as any;
    });

    // Ensure fs.access resolves so 'local' remains effective
    vi.spyOn(fs, 'access').mockResolvedValue(undefined as any);

    await engine.resolveConflict(conflict.id, 'local');

    expect(uploadSpy).toHaveBeenCalled();
    // First argument of uploadDriveBinary should be the folder ID returned by getPairRemoteFolderId
    const firstCall = uploadSpy.mock.calls[0];
    expect(firstCall[0]).toBe(mockedFolderId);
  });
});
