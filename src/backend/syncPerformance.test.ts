import { describe, expect, it } from 'vitest';
import {
  INITIAL_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  SYNC_COOLDOWN_MS,
  nextSyncBackoff,
  pollInterval,
  shouldSkipPoll,
} from './syncPerformance';

describe('sync performance policies', () => {
  it('doubles polling backoff and caps it at fifteen minutes', () => {
    expect(nextSyncBackoff(undefined)).toBe(INITIAL_POLL_INTERVAL_MS * 2);
    expect(nextSyncBackoff(MAX_POLL_INTERVAL_MS)).toBe(MAX_POLL_INTERVAL_MS);
  });

  it('keeps polling at least thirty seconds and applies the cap', () => {
    expect(pollInterval(undefined)).toBe(INITIAL_POLL_INTERVAL_MS);
    expect(pollInterval(MAX_POLL_INTERVAL_MS * 2)).toBe(MAX_POLL_INTERVAL_MS);
  });

  it('skips polling only during the mandatory cooldown', () => {
    const now = 100_000;
    expect(shouldSkipPoll(now - SYNC_COOLDOWN_MS + 1, now)).toBe(true);
    expect(shouldSkipPoll(now - SYNC_COOLDOWN_MS, now)).toBe(false);
    expect(shouldSkipPoll(undefined, now)).toBe(false);
  });
});
