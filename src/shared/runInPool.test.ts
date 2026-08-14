import { describe, it, expect } from 'vitest';
import { runInPool } from './runInPool';

describe('runInPool', () => {
  it('runs tasks with limited concurrency', async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(i);
      return i;
    });

    const results = await runInPool(tasks, 2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('throws first error when a task fails', async () => {
    const tasks = [
      async () => 1,
      async () => { throw new Error('task2 failed'); },
      async () => 3,
    ];

    await expect(runInPool(tasks, 2)).rejects.toThrow('task2 failed');
  });

  it('handles empty task list', async () => {
    const results = await runInPool([], 3);
    expect(results).toEqual([]);
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 20));
      currentConcurrent--;
      return 1;
    });

    await runInPool(tasks, 3);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
