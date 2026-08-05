import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

// We'll import SyncEngine dynamically so we can mock its prototype.init before constructing
let SyncEngineClass: typeof import('./syncEngine').SyncEngine;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import('./syncEngine');
  // Mock heavy init in constructor
  vi.spyOn(mod.SyncEngine.prototype as any, 'init').mockImplementation(async function () {
    (this as any).pairs = [];
    (this as any).pairRootRemoteFolderId = new Map();
    (this as any).intervalRefs = {};
    (this as any).watchers = {};
    (this as any).pendingConflicts = [];
  });
  SyncEngineClass = mod.SyncEngine;
});

describe('SyncEngine.resolveConflict (local) behavior', () => {
  it('uses getPairRemoteFolderId (folder id) when uploading local resolution', async () => {
    const engine = new SyncEngineClass();
    (engine as any).db = {
      getRecoverableOperations: (_pairId: string) => [],
      createOperation: (_op: any) => {},
      updateOperation: (_id: string, _patch: any) => {},
      setFileState: (_pairId: string, _relPath: string, _state: any) => {},
      getFileState: (_pairId: string, _relPath: string) => null,
      deleteFolderStateCascade: (_pairId: string, _relPath: string) => {},
      resolveConflict: (_conflictId: string, _effective: string) => {},
    };
    (engine as any).accessToken = 'token';

    const pair = { id: 'pair1', localPath: '/tmp/pair1', remotePath: 'GoogleDrive:/Some/Path' } as any;
    // engine.pairs will be set later after creating tmp dir

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

    // Ensure the local file exists so fs.access passes: create temporary dir and file
    const os = await import('node:os');
    const path = await import('node:path');
    const mkdtemp = (await import('node:fs/promises')).mkdtemp;
    const tmpBase = path.join(os.tmpdir(), 'syncclient-test-');
    const tmpDir = await mkdtemp(tmpBase);
    const docsDir = path.join(tmpDir, 'docs');
    await (await import('node:fs/promises')).mkdir(docsDir, { recursive: true });
    const filePath = path.join(docsDir, 'file.txt');
    await (await import('node:fs/promises')).writeFile(filePath, 'hello');

    // set pair.localPath to tmpDir so fullLocalPath points to the real file
    pair.localPath = tmpDir;
    engine.pairs = [pair];

    await engine.resolveConflict(conflict.id, 'local');

    expect(uploadSpy).toHaveBeenCalled();
    // First argument of uploadDriveBinary should be the folder ID returned by getPairRemoteFolderId
    const firstCall = uploadSpy.mock.calls[0];
    expect(firstCall[0]).toBe(mockedFolderId);
  });
});
