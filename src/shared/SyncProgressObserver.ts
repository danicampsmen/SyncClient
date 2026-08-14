import { SyncProgress, SyncPair } from '../types';

export interface ProgressUpdate {
  pairId: string;
  progress: SyncProgress;
  timestamp: number;
}

export type ProgressHandler = (update: ProgressUpdate) => void;

export interface ObserverOptions {
  maxBufferSize?: number;
  throttleMs?: number;
  dropPolicy?: 'oldest' | 'newest';
}

export class SyncProgressObserver {
  private handlers: Set<ProgressHandler> = new Set();
  private buffer: ProgressUpdate[] = [];
  private lastEmit: number = 0;
  private maxBufferSize: number;
  private throttleMs: number;
  private dropPolicy: 'oldest' | 'newest';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ObserverOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.throttleMs = options.throttleMs ?? 100;
    this.dropPolicy = options.dropPolicy ?? 'newest';
  }

  subscribe(handler: ProgressHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  notify(pair: SyncPair): void {
    if (!pair.progress) return;

    const update: ProgressUpdate = {
      pairId: pair.id,
      progress: pair.progress,
      timestamp: Date.now(),
    };

    const now = Date.now();
    if (now - this.lastEmit < this.throttleMs) {
      if (this.buffer.length >= this.maxBufferSize) {
        if (this.dropPolicy === 'oldest') {
          this.buffer.shift();
        } else {
          this.buffer.pop();
        }
      }
      this.buffer.push(update);
      this.scheduleFlush();
      return;
    }

    this.lastEmit = now;
    this.flushBuffer();
    this.emit(update);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const delay = Math.max(0, this.throttleMs - (Date.now() - this.lastEmit));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.lastEmit = Date.now();
      this.flushBuffer();
    }, delay);
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const update of batch) {
      this.emit(update);
    }
  }

  private emit(update: ProgressUpdate): void {
    for (const handler of this.handlers) {
      try {
        handler(update);
      } catch (e) {
        console.error('[SyncProgressObserver] Handler error:', e);
      }
    }
  }

  getSubscriberCount(): number {
    return this.handlers.size;
  }

  getBufferedCount(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this.lastEmit = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
