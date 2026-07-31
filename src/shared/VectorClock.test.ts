import { describe, test, expect } from 'vitest';
import { VectorClockManager, VectorClock } from './VectorClock';

describe('VectorClockManager', () => {
    describe('compare', () => {
        test('equal clocks', () => {
            const a: VectorClock = { d1: 3, d2: 5 };
            const b: VectorClock = { d1: 3, d2: 5 };
            expect(VectorClockManager.compare(a, b)).toBe('equal');
        });

        test('a newer than b', () => {
            const a: VectorClock = { d1: 5, d2: 3 };
            const b: VectorClock = { d1: 2, d2: 3 };
            expect(VectorClockManager.compare(a, b)).toBe('a_newer');
        });

        test('b newer than a', () => {
            const a: VectorClock = { d1: 1, d2: 3 };
            const b: VectorClock = { d1: 2, d2: 3 };
            expect(VectorClockManager.compare(a, b)).toBe('b_newer');
        });

        test('concurrent clocks', () => {
            const a: VectorClock = { d1: 5, d2: 1 };
            const b: VectorClock = { d1: 1, d2: 5 };
            expect(VectorClockManager.compare(a, b)).toBe('concurrent');
        });

        test('empty clocks are equal', () => {
            expect(VectorClockManager.compare({}, {})).toBe('equal');
        });

        test('clock with missing device treated as 0', () => {
            const a: VectorClock = { d1: 1 };
            const b: VectorClock = { d1: 1, d2: 1 };
            expect(VectorClockManager.compare(a, b)).toBe('b_newer');
        });
    });

    describe('increment', () => {
        test('increment existing device', () => {
            const clock: VectorClock = { d1: 3 };
            const result = VectorClockManager.increment(clock, 'd1');
            expect(result.d1).toBe(4);
            expect(clock.d1).toBe(3); // original unchanged
        });

        test('increment new device', () => {
            const clock: VectorClock = { d1: 3 };
            const result = VectorClockManager.increment(clock, 'd2');
            expect(result.d2).toBe(1);
            expect(result.d1).toBe(3);
        });
    });

    describe('mergeForDedup', () => {
        test('merge takes max of all dimensions', () => {
            const winner: VectorClock = { d1: 3, d2: 1 };
            const losers: VectorClock[] = [{ d1: 1, d2: 5, d3: 2 }];
            const result = VectorClockManager.mergeForDedup(winner, losers, 'd1');
            expect(result.d1).toBe(4); // max(3,1) + 1 for merge
            expect(result.d2).toBe(5);
            expect(result.d3).toBe(2);
        });

        test('merge with empty losers', () => {
            const winner: VectorClock = { d1: 3 };
            const result = VectorClockManager.mergeForDedup(winner, [], 'd1');
            expect(result.d1).toBe(4); // just increment
        });
    });

    describe('toAppProperties / fromAppProperties', () => {
        test('roundtrip small clock', () => {
            const clock: VectorClock = { d1: 3, d2: 5 };
            const props = VectorClockManager.toAppProperties(clock);
            const restored = VectorClockManager.fromAppProperties(props);
            expect(restored).toEqual(clock);
        });

        test('fromAppProperties with no data returns null', () => {
            expect(VectorClockManager.fromAppProperties({})).toBeNull();
        });
    });

    describe('resolveFromSources', () => {
        test('uses drive props when available', () => {
            const driveProps = { syncclient_vc: '{"d1":3,"d2":5}' };
            const result = VectorClockManager.resolveFromSources(driveProps, null, 'd3');
            expect(result.clock).toEqual({ d1: 3, d2: 5 });
            expect(result.needsDriveSync).toBe(false);
        });

        test('falls back to db state', () => {
            const dbVc = '{"d1":3}';
            const result = VectorClockManager.resolveFromSources(null, dbVc, 'd2');
            expect(result.clock).toEqual({ d1: 3 });
            expect(result.needsDriveSync).toBe(true);
        });

        test('initializes new clock when no sources', () => {
            const result = VectorClockManager.resolveFromSources(null, null, 'd1');
            expect(result.clock.d1).toBe(1);
            expect(result.needsDriveSync).toBe(true);
        });
    });

    describe('toString / fromString', () => {
        test('roundtrip', () => {
            const clock: VectorClock = { d1: 3, d2: 5 };
            const str = VectorClockManager.toString(clock);
            const restored = VectorClockManager.fromString(str);
            expect(restored).toEqual(clock);
        });

        test('fromString with invalid JSON returns empty', () => {
            expect(VectorClockManager.fromString('invalid')).toEqual({});
        });
    });
});