import { describe, expect, it } from 'vitest';
import { measureSyntheticSyncPlan } from './syncScaleBenchmark';

describe('synthetic sync scale harness', () => {
  it.each([10_000, 100_000])('plans %s files without real filesystem or Drive data', fileCount => {
    const result = measureSyntheticSyncPlan(fileCount);
    expect(result.fileCount).toBe(fileCount);
    expect(result.plannedUploads).toBe(fileCount);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
