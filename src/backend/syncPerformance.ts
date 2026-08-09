import fs from 'fs';

export const SYNC_DEBOUNCE_MS = 1000;
export const WRITE_STABILITY_THRESHOLD_MS = 5000;
export const WRITE_STABILITY_POLL_INTERVAL_MS = 1000;
export const INITIAL_POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_INTERVAL_MS = 900_000;
export const SYNC_COOLDOWN_MS = 60_000;
export const TRANSFER_CONCURRENCY = 3;

export function nextSyncBackoff(current: number | undefined): number {
  return Math.min((current || INITIAL_POLL_INTERVAL_MS) * 2, MAX_POLL_INTERVAL_MS);
}

export function isOperatingOnBattery(): boolean {
  try {
    if (fs.existsSync('/sys/class/power_supply/BAT0/status')) {
      const status = fs.readFileSync('/sys/class/power_supply/BAT0/status', 'utf8').trim();
      return status === 'Discharging';
    }
    if (fs.existsSync('/sys/class/power_supply/BAT1/status')) {
      const status = fs.readFileSync('/sys/class/power_supply/BAT1/status', 'utf8').trim();
      return status === 'Discharging';
    }
  } catch { }
  return false;
}

export function pollInterval(current: number | undefined): number {
  const baseInterval = Math.min(current || INITIAL_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  if (isOperatingOnBattery()) {
    return Math.max(120_000, baseInterval * 2);
  }
  return baseInterval;
}

export function shouldSkipPoll(lastCompleted: number | undefined, now = Date.now()): boolean {
  return lastCompleted !== undefined && now - lastCompleted < SYNC_COOLDOWN_MS;
}
