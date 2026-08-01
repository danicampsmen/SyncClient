import { describe, expect, it } from 'vitest';
import {
  ANDROID_STARNOTE_BASE,
  ANDROID_STARNOTE_EXPORT,
  CoreSyncLogic,
  DEFAULT_LOCAL_DIR_NAME,
  DEFAULT_REMOTE_PATH,
  RemoteEntry,
} from './CoreSyncLogic';

describe('CoreSyncLogic.matchesIgnorePattern', () => {
  it('rejects empty and missing names without throwing', () => {
    expect(CoreSyncLogic.matchesIgnorePattern('')).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern(null as unknown as string)).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern(undefined as unknown as string)).toBe(false);
  });

  it('matches the default temporary, hidden, and editor files', () => {
    expect(CoreSyncLogic.matchesIgnorePattern('archivo.tmp')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('ARCHIVO.TMP')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('archivo.TMP.txt')).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('documento.aux')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('documento.log')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('documento.out')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('.gitignore')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('nota-SAVE-ERROR')).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('.nota-SAVE-ERROR')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('.DS_Store')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('.git')).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('node_modules')).toBe(false);
  });

  it('does not ignore regular source and document files', () => {
    expect(CoreSyncLogic.matchesIgnorePattern('apuntes.pdf')).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('tesis.tex')).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('main.py')).toBe(false);
  });

  it('supports custom patterns and falls back to defaults for an empty list', () => {
    expect(CoreSyncLogic.matchesIgnorePattern('debug.log', ['*.log', '*.tmp'])).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('debug.txt', ['*.log', '*.tmp'])).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('documento.log', [])).toBe(true);
    expect(CoreSyncLogic.matchesIgnorePattern('documento.pdf', [])).toBe(false);
    expect(CoreSyncLogic.matchesIgnorePattern('file.txt', [''])).toBe(false);
  });
});

describe('CoreSyncLogic.parseNumberedFilename', () => {
  it.each([
    ['apuntes(1).pdf', { isNumbered: true, baseName: 'apuntes.pdf', version: 1, extension: 'pdf' }],
    ['rotman(15).pdf', { isNumbered: true, baseName: 'rotman.pdf', version: 15, extension: 'pdf' }],
    ['nota (3).txt', { isNumbered: true, baseName: 'nota.txt', version: 3, extension: 'txt' }],
    ['archivo(2)(1).pdf', { isNumbered: true, baseName: 'archivo.pdf', version: 1, extension: 'pdf' }],
    ['documento.pdf', { isNumbered: false, baseName: 'documento.pdf', version: 0, extension: 'pdf' }],
    ['README', { isNumbered: false, baseName: 'README', version: 0, extension: '' }],
  ])('parses %s', (filename, expected) => {
    expect(CoreSyncLogic.parseNumberedFilename(filename)).toEqual(expected);
  });

  it('keeps names without an extension as ordinary files', () => {
    expect(CoreSyncLogic.parseNumberedFilename('nota(1)')).toEqual({
      isNumbered: false,
      baseName: 'nota(1)',
      version: 0,
      extension: '',
    });
  });
});

describe('CoreSyncLogic routes and settle timing', () => {
  it('exposes the platform route contracts', () => {
    expect(DEFAULT_LOCAL_DIR_NAME).toBe('Apuntes_Tablet_StarNote');
    expect(DEFAULT_REMOTE_PATH).toBe('GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote');
    expect(ANDROID_STARNOTE_BASE).toBe('/storage/emulated/0/Documents/StarNote');
    expect(ANDROID_STARNOTE_EXPORT).toBe('/storage/emulated/0/Documents/StarNote/export');
  });

  it.each([
    [undefined, DEFAULT_REMOTE_PATH],
    ['RemoteServer:/Documentos-Ubuntu/Apuntes', 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes'],
    ['Drive:/Documentos-Ubuntu-Fayfer/Apuntes', 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes'],
    ['/Documentos-Ubuntu/Apuntes', 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes'],
    ['Documentos-Ubuntu-Fayfer/Apuntes', 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes'],
    ['GoogleDrive:/Apuntes en pdf - tablet', DEFAULT_REMOTE_PATH],
  ])('normalizes %s to %s', (input, expected) => {
    expect(CoreSyncLogic.normalizeRemotePath(input)).toBe(expected);
  });

  it('only considers a file ready after the settle buffer', () => {
    expect(CoreSyncLogic.isReadyForSync(100_000, 2_000, 101_999)).toBe(false);
    expect(CoreSyncLogic.isReadyForSync(100_000, 2_000, 102_000)).toBe(true);
    expect(CoreSyncLogic.isReadyForSync(0, 2_000, 0)).toBe(true);
  });
});

describe('CoreSyncLogic.groupAndSortDuplicates', () => {
  it('keeps independent files in independent groups', () => {
    const groups = CoreSyncLogic.groupAndSortDuplicates([
      { name: 'a.pdf', mtime: 1000 },
      { name: 'b.pdf', mtime: 2000 },
    ]);

    expect(groups.size).toBe(2);
    expect(groups.get('a.pdf')).toHaveLength(1);
    expect(groups.get('b.pdf')).toHaveLength(1);
  });

  it('selects the newest mtime as the winner', () => {
    const groups = CoreSyncLogic.groupAndSortDuplicates([
      { name: 'nota(1).pdf', mtime: 1000 },
      { name: 'nota(2).pdf', mtime: 2000 },
      { name: 'nota(3).pdf', mtime: 1500 },
    ]);

    expect(groups.get('nota.pdf')?.[0]).toMatchObject({
      name: 'nota(2).pdf',
      version: 2,
    });
  });

  it('uses the highest version when mtimes are equal', () => {
    const groups = CoreSyncLogic.groupAndSortDuplicates([
      { name: 'doc(1).pdf', mtime: 1000 },
      { name: 'doc(5).pdf', mtime: 1000 },
      { name: 'doc(3).pdf', mtime: 1000 },
    ]);

    expect(groups.get('doc.pdf')?.[0]).toMatchObject({
      name: 'doc(5).pdf',
      version: 5,
    });
  });

  it('allows an unnumbered file to win by mtime', () => {
    const groups = CoreSyncLogic.groupAndSortDuplicates([
      { name: 'base.pdf', mtime: 2000 },
      { name: 'base(1).pdf', mtime: 1000 },
      { name: 'base(2).pdf', mtime: 1500 },
    ]);

    expect(groups.get('base.pdf')?.[0]).toMatchObject({
      name: 'base.pdf',
      version: 0,
    });
  });

  it('uses mtime over version when the timestamps differ', () => {
    const groups = CoreSyncLogic.groupAndSortDuplicates([
      { name: 'x(9).pdf', mtime: 1000 },
      { name: 'x(1).pdf', mtime: 5000 },
    ]);

    expect(groups.get('x.pdf')?.[0]).toMatchObject({
      name: 'x(1).pdf',
      version: 1,
    });
  });

  it('returns an empty map for an empty input', () => {
    expect(CoreSyncLogic.groupAndSortDuplicates([])).toEqual(new Map());
  });
});

const remoteFile = (overrides: Partial<RemoteEntry> = {}): RemoteEntry => ({
  id: 'remote-1',
  name: 'nota.pdf',
  mimeType: 'application/pdf',
  modifiedTime: '1970-01-01T00:00:10.000Z',
  size: '100',
  ...overrides,
});

const dbFile = (overrides: Partial<{ localMtime: number; remoteMtime: number; remoteId: string; fileSize: number }> = {}) => ({
  localMtime: 10_000,
  remoteMtime: 10_000,
  remoteId: 'remote-1',
  fileSize: 100,
  ...overrides,
});

describe('CoreSyncLogic.computeSyncPlan', () => {
  it('does nothing for an unchanged known file', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 10_000, size: 100 }]]),
      new Map([['nota.pdf', remoteFile()]]),
      new Map([['nota.pdf', dbFile()]]),
      'device-a',
    );

    expect(plan).toEqual({
      uploads: [],
      downloads: [],
      deleteLocal: [],
      deleteRemote: [],
      conflicts: [],
    });
  });

  it('uploads a new local file and preserves a matching remote id', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 10_000, size: 100 }]]),
      new Map([['nota.pdf', remoteFile()]]),
      new Map(),
      'device-a',
    );

    expect(plan.uploads).toEqual([{
      localPath: 'nota.pdf',
      remoteName: 'nota.pdf',
      remoteId: 'remote-1',
      vectorClock: '{"device-a":1}',
    }]);
  });

  it('uploads when only the local side changed', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 14_000, size: 100 }]]),
      new Map([['nota.pdf', remoteFile()]]),
      new Map([['nota.pdf', dbFile()]]),
      'device-a',
    );

    expect(plan.uploads).toHaveLength(1);
    expect(plan.downloads).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('downloads when only a known remote file changed', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map(),
      new Map([['nota.pdf', remoteFile({ modifiedTime: '1970-01-01T00:00:20.000Z' })]]),
      new Map([['nota.pdf', dbFile({ remoteMtime: 10_000 })]]),
      'device-a',
    );

    expect(plan.downloads[0]).toMatchObject({
      remoteFile: remoteFile({ modifiedTime: '1970-01-01T00:00:20.000Z' }),
      localPath: 'nota.pdf',
    });
    expect(plan.uploads).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('reports a conflict only when both sides changed beyond the threshold', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 14_000, size: 100 }]]),
      new Map([['nota.pdf', remoteFile({ modifiedTime: '1970-01-01T00:00:20.000Z' })]]),
      new Map([['nota.pdf', dbFile({ remoteMtime: 10_000 })]]),
      'device-a',
    );

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      localPath: 'nota.pdf',
      remoteFile: { id: 'remote-1', name: 'nota.pdf' },
      localVc: '{"device-a":1}',
      remoteVc: '{}',
    });
    expect(plan.uploads).toHaveLength(0);
    expect(plan.downloads).toHaveLength(0);
  });

  it('does not report a conflict when a change is exactly at the threshold', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 13_000, size: 100 }]]),
      new Map([['nota.pdf', remoteFile({ modifiedTime: '1970-01-01T00:00:13.000Z' })]]),
      new Map([['nota.pdf', dbFile({ remoteMtime: 10_000 })]]),
      'device-a',
    );

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.uploads).toHaveLength(0);
    expect(plan.downloads).toHaveLength(0);
  });

  it('uses hashes to detect both-sided changes even when mtimes are unchanged', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['nota.pdf', { name: 'nota.pdf', mtime: 10_000, size: 100, hash: 'local-hash' }]]),
      new Map([['nota.pdf', remoteFile({ md5Checksum: 'remote-hash' })]]),
      new Map([['nota.pdf', dbFile({ baseHash: 'base-hash' })]]),
      'device-a',
    );

    expect(plan.conflicts).toEqual([expect.objectContaining({
      localPath: 'nota.pdf',
      localHash: 'local-hash',
      remoteHash: 'remote-hash',
      baseHash: 'base-hash',
      reason: 'both_modified',
    })]);
  });

  it('does not delete remotely when local deletion races with a remote modification', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map(),
      new Map([['nota.pdf', remoteFile({
        modifiedTime: '1970-01-01T00:00:20.000Z',
        md5Checksum: 'remote-hash',
      })]]),
      new Map([['nota.pdf', dbFile({
        baseHash: 'base-hash',
        remoteMtime: 10_000,
      })]]),
      'device-a',
    );

    expect(plan.deleteRemote).toHaveLength(0);
    expect(plan.conflicts).toEqual([expect.objectContaining({
      localPath: 'nota.pdf',
      remoteHash: 'remote-hash',
      baseHash: 'base-hash',
      reason: 'delete_vs_modify',
    })]);
  });

  it('downloads remote-only files and schedules missing files for deletion', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map(),
      new Map([['new.pdf', remoteFile({ id: 'new-remote', name: 'new.pdf' })]]),
      new Map([
        ['new.pdf', dbFile({ remoteId: 'old-remote' })],
        ['gone.pdf', dbFile({ remoteId: 'gone-remote' })],
        ['local-only.pdf', dbFile({ remoteId: '' })],
      ]),
      'device-a',
    );

    expect(plan.downloads[0]).toMatchObject({
      localPath: 'new.pdf',
      remoteFile: { id: 'new-remote', name: 'new.pdf' },
    });
    expect(plan.deleteRemote).toEqual([{ remoteId: 'gone-remote', localPath: 'gone.pdf' }]);
    expect(plan.deleteLocal).toEqual([{ localPath: 'local-only.pdf' }]);
  });
});

describe('CoreSyncLogic.mergeClocksForDedup', () => {
  it('merges maximum dimensions, ignores malformed losers, and increments this device', () => {
    expect(CoreSyncLogic.mergeClocksForDedup(
      '{"device-a":3,"device-b":1}',
      ['{"device-a":1,"device-b":5,"device-c":2}', '{invalid'],
      'device-a',
    )).toBe('{"device-a":4,"device-b":5,"device-c":2}');
  });

  it('increments the winner device even without losers', () => {
    expect(CoreSyncLogic.mergeClocksForDedup('{"device-a":3}', [], 'device-a'))
      .toBe('{"device-a":4}');
  });
});
