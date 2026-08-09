import { describe, expect, test } from 'vitest';
import { CoreSyncLogic } from './CoreSyncLogic';

describe('CoreSyncLogic vector clocks', () => {
  test('increments the persisted base clock instead of resetting it', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['notes.pdf', { name: 'notes.pdf', mtime: 10_000, size: 11 }]]),
      new Map([['notes.pdf', {
        id: 'remote-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        modifiedTime: new Date(10_000).toISOString(),
        size: '10'
      }]]),
      new Map([['notes.pdf', {
        localMtime: 1_000,
        remoteMtime: 10_000,
        remoteId: 'remote-1',
        fileSize: 10,
        vectorClock: '{"desktop":4,"tablet":2}'
      }]]),
      'desktop'
    );

    expect(JSON.parse(plan.uploads[0].vectorClock)).toEqual({ desktop: 5, tablet: 2 });
  });

  test('keeps the remote clock and creates a local clock for a real conflict', () => {
    const plan = CoreSyncLogic.computeSyncPlan(
      new Map([['notes.pdf', { name: 'notes.pdf', mtime: 20_000, size: 11 }]]),
      new Map([['notes.pdf', {
        id: 'remote-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        modifiedTime: new Date(20_000).toISOString(),
        size: '12',
        appProperties: { syncclient_vc: '{"tablet":7}' }
      }]]),
      new Map([['notes.pdf', {
        localMtime: 1_000,
        remoteMtime: 1_000,
        remoteId: 'remote-1',
        fileSize: 10,
        vectorClock: '{"desktop":4}'
      }]]),
      'desktop'
    );

    expect(plan.conflicts).toHaveLength(1);
    expect(JSON.parse(plan.conflicts[0].localVc)).toEqual({ desktop: 5 });
    expect(JSON.parse(plan.conflicts[0].remoteVc)).toEqual({ tablet: 7 });
  });
});
