import { performance } from 'node:perf_hooks';
import { CoreSyncLogic, type RemoteEntry, type SyncStateSnapshot } from '../shared/CoreSyncLogic';

export interface SyntheticScaleResult {
  fileCount: number;
  elapsedMs: number;
  plannedUploads: number;
}

export function measureSyntheticSyncPlan(fileCount: number): SyntheticScaleResult {
  if (!Number.isInteger(fileCount) || fileCount < 0) {
    throw new Error('Synthetic file count must be a non-negative integer');
  }
  const local = new Map<string, { name: string; mtime: number; size: number }>();
  const remote = new Map<string, RemoteEntry>();
  const state = new Map<string, SyncStateSnapshot>();
  for (let index = 0; index < fileCount; index++) {
    const name = `synthetic-${index}.bin`;
    local.set(name, { name, mtime: 1_000 + index, size: 1024 });
  }
  const started = performance.now();
  const plan = CoreSyncLogic.computeSyncPlan(local, remote, state, 'scale-test');
  return { fileCount, elapsedMs: performance.now() - started, plannedUploads: plan.uploads.length };
}
