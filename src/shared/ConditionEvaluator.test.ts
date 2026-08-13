import { describe, it, expect } from 'vitest';
import { ConditionEvaluator } from './ConditionEvaluator';
import { SyncPairConditions } from './schema';

describe('ConditionEvaluator', () => {
  const sampleConditions: SyncPairConditions = {
    pair_id: 'pair1',
    require_charging: 1,
    require_wifi: 1,
    min_battery_level: 20,
    block_on_roaming: 0,
    block_on_metered: 0,
    require_vpn: 0,
    allowed_ssids: 'Home_WiFi, Office_5G',
  };

  it('should block sync if require_charging is true but device is not charging', () => {
    const result = ConditionEvaluator.evaluate(
      sampleConditions,
      { isCharging: false, batteryLevel: 50, isWifiConnected: true, currentSsid: 'Home_WiFi' },
      false
    );
    expect(result.canSync).toBe(false);
    expect(result.reason).toContain('cargador');
  });

  it('should allow sync if manual trigger regardless of battery', () => {
    const result = ConditionEvaluator.evaluate(
      sampleConditions,
      { isCharging: false, batteryLevel: 10, isWifiConnected: false },
      true // manual trigger
    );
    expect(result.canSync).toBe(true);
  });

  it('should allow sync when all conditions match', () => {
    const result = ConditionEvaluator.evaluate(
      sampleConditions,
      { isCharging: true, batteryLevel: 80, isWifiConnected: true, currentSsid: 'Home_WiFi' },
      false
    );
    expect(result.canSync).toBe(true);
  });
});
