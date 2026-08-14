import { describe, it, expect, vi } from 'vitest';
import { SyncProgressObserver } from './SyncProgressObserver';
import { SyncPair } from '../types';

function makePair(id: string, percentage: number): SyncPair {
  return {
    id,
    progress: {
      currentFile: 'test.txt',
      totalFiles: 1,
      currentFileIndex: 1,
      bytesTransferred: 1024,
      totalBytes: 2048,
      percentage,
      action: 'subiendo',
    },
  } as any;
}

describe('SyncProgressObserver', () => {
  it('notifies subscribers with progress updates', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 0 });
    const handler = vi.fn();
    observer.subscribe(handler);

    const pair = makePair('p1', 50);
    observer.notify(pair);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        pairId: 'p1',
        progress: expect.objectContaining({ percentage: 50 }),
      })
    );
  });

  it('supports multiple subscribers', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 0 });
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    observer.subscribe(handler1);
    observer.subscribe(handler2);

    const pair = makePair('p1', 25);
    observer.notify(pair);

    await vi.waitFor(() => expect(handler1).toHaveBeenCalledTimes(1));
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 0 });
    const handler = vi.fn();
    const unsub = observer.subscribe(handler);

    const pair = makePair('p1', 10);
    observer.notify(pair);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    unsub();
    observer.notify(pair);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('buffers updates when throttled', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 50, maxBufferSize: 10 });
    const handler = vi.fn();
    observer.subscribe(handler);

    observer.notify(makePair('p1', 10));
    observer.notify(makePair('p1', 20));
    observer.notify(makePair('p1', 30));

    await new Promise(r => setTimeout(r, 200));
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('drops oldest when buffer is full', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 100, maxBufferSize: 2, dropPolicy: 'oldest' });
    const handler = vi.fn();
    observer.subscribe(handler);

    observer.notify(makePair('p1', 10));
    await new Promise(r => setTimeout(r, 10));
    observer.notify(makePair('p1', 20));
    observer.notify(makePair('p1', 30));
    observer.notify(makePair('p1', 40));

    await new Promise(r => setTimeout(r, 150));
    expect(handler).toHaveBeenCalledTimes(3);
    const calls = handler.mock.calls.map((c: any) => c[0].progress.percentage);
    expect(calls).toEqual([10, 30, 40]);
  });

  it('drops newest when buffer is full', async () => {
    const observer = new SyncProgressObserver({ throttleMs: 100, maxBufferSize: 2, dropPolicy: 'newest' });
    const handler = vi.fn();
    observer.subscribe(handler);

    observer.notify(makePair('p1', 10));
    await new Promise(r => setTimeout(r, 10));
    observer.notify(makePair('p1', 20));
    observer.notify(makePair('p1', 30));
    observer.notify(makePair('p1', 40));

    await new Promise(r => setTimeout(r, 150));
    expect(handler).toHaveBeenCalledTimes(3);
    const calls = handler.mock.calls.map((c: any) => c[0].progress.percentage);
    expect(calls).toEqual([10, 20, 40]);
  });

  it('ignores updates when progress is null', () => {
    const observer = new SyncProgressObserver();
    const handler = vi.fn();
    observer.subscribe(handler);

    observer.notify({ id: 'p1', progress: null } as any);
    expect(handler).not.toHaveBeenCalled();
  });
});
