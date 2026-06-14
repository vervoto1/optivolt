import { describe, it, expect } from 'vitest';
import {
  decideBatteryChargeLevel,
  nearestLevelIndex,
} from '../../lib/battery-charge-controller.ts';

const policy = {
  emergencyVoltage: 3.65,
  reduceVoltage: 3.5,
  restoreVoltage: 3.4,
  currentLevels: [400, 180, 50, 0],
};

const decide = (maxCellVoltage, currentLevel, dwellElapsed = true) =>
  decideBatteryChargeLevel({ maxCellVoltage, currentLevel, dwellElapsed }, policy);

describe('nearestLevelIndex', () => {
  it('maps a measured current to the closest rung', () => {
    expect(nearestLevelIndex([400, 180, 50, 0], 360)).toBe(0);
    expect(nearestLevelIndex([400, 180, 50, 0], 120)).toBe(1);
    expect(nearestLevelIndex([400, 180, 50, 0], 30)).toBe(2);
    expect(nearestLevelIndex([400, 180, 50, 0], 10)).toBe(3);
  });
});

describe('decideBatteryChargeLevel — emergency', () => {
  it('drops to the lowest level immediately, bypassing dwell', () => {
    const d = decide(3.7, 400, false);
    expect(d.level).toBe(0);
    expect(d.reason).toBe('emergency');
    expect(d.forced).toBe(true);
    expect(d.changed).toBe(true);
  });
});

describe('decideBatteryChargeLevel — reduce (immediate, ungated)', () => {
  it('steps down one rung from the top', () => {
    const d = decide(3.55, 400, false);
    expect(d.level).toBe(180);
    expect(d.reason).toBe('reduce');
    expect(d.forced).toBe(true);
  });

  it('steps down from a mid rung even when seeded from a measured current', () => {
    const d = decide(3.55, 360, false); // 360 ~ rung 400
    expect(d.level).toBe(180);
  });

  it('holds at the minimum rung when already there', () => {
    const d = decide(3.55, 0, false);
    expect(d.level).toBe(0);
    expect(d.reason).toBe('reduce_at_min');
    expect(d.changed).toBe(false);
  });
});

describe('decideBatteryChargeLevel — restore (dwell-gated)', () => {
  it('steps up one rung once dwell has elapsed', () => {
    expect(decide(3.3, 0, true).level).toBe(50);
    expect(decide(3.3, 50, true).level).toBe(180);
    expect(decide(3.3, 180, true).level).toBe(400);
  });

  it('waits for the dwell before stepping up', () => {
    const d = decide(3.3, 50, false);
    expect(d.level).toBe(50);
    expect(d.reason).toBe('restore_wait_dwell');
    expect(d.changed).toBe(false);
  });

  it('stays at the max rung', () => {
    const d = decide(3.3, 400, true);
    expect(d.level).toBe(400);
    expect(d.reason).toBe('at_max');
    expect(d.changed).toBe(false);
  });
});

describe('decideBatteryChargeLevel — hysteresis band', () => {
  it('holds inside [restore, reduce]', () => {
    const d = decide(3.45, 180, true);
    expect(d.level).toBe(180);
    expect(d.reason).toBe('hold');
    expect(d.changed).toBe(false);
  });
});

describe('decideBatteryChargeLevel — defensive', () => {
  it('falls back to [0] when no levels are configured', () => {
    const d = decideBatteryChargeLevel(
      { maxCellVoltage: 3.7, currentLevel: 0, dwellElapsed: true },
      { ...policy, currentLevels: [] },
    );
    expect(d.level).toBe(0);
  });
});
