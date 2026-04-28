import { describe, it, expect } from 'vitest';
import {
  decideShoreCurrent,
  normalizeMppOperationMode,
} from '../../lib/shore-optimizer.ts';

const baseInput = {
  enabled: true,
  stateFresh: true,
  gateOnDessSchedule: true,
  slotMode: 'grid_charge',
  currentShoreA: 10,
  batteryPowerW: 500,
  mppOperationMode: 2,
  config: {
    stepA: 0.5,
    minShoreA: 0,
    maxShoreA: 25,
    minChargingPowerW: 200,
  },
};

function decide(overrides = {}) {
  return decideShoreCurrent({
    ...baseInput,
    ...overrides,
    config: {
      ...baseInput.config,
      ...(overrides.config ?? {}),
    },
  });
}

describe('normalizeMppOperationMode', () => {
  it('maps canonical Victron integer states', () => {
    expect(normalizeMppOperationMode(0).id).toBe('off');
    expect(normalizeMppOperationMode(1).id).toBe('voltage_current_limited');
    expect(normalizeMppOperationMode(2).id).toBe('mppt_active');
    expect(normalizeMppOperationMode(255).id).toBe('not_available');
  });

  it('accepts translated string state ids', () => {
    expect(normalizeMppOperationMode('voltage_current_limited').id).toBe('voltage_current_limited');
    expect(normalizeMppOperationMode('mppt_active').id).toBe('mppt_active');
  });

  it('marks unexpected values unknown', () => {
    expect(normalizeMppOperationMode(99).id).toBe('unknown');
  });
});

describe('decideShoreCurrent', () => {
  it('steps up when the MPPT is active', () => {
    const result = decide({ mppOperationMode: 2 });
    expect(result.shouldWrite).toBe(true);
    expect(result.oldA).toBe(10);
    expect(result.newA).toBe(10.5);
  });

  it('steps down when the MPPT is voltage/current limited', () => {
    const result = decide({ mppOperationMode: 1 });
    expect(result.shouldWrite).toBe(true);
    expect(result.newA).toBe(9.5);
  });

  it('idles for off, not_available, and unknown MPPT states', () => {
    expect(decide({ mppOperationMode: 0 }).reason).toBe('mppt_idle');
    expect(decide({ mppOperationMode: 255 }).reason).toBe('mppt_idle');
    expect(decide({ mppOperationMode: 99 }).reason).toBe('mppt_idle');
  });

  it('blocks when disabled', () => {
    const result = decide({ enabled: false });
    expect(result.shouldWrite).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('blocks stale state', () => {
    const result = decide({ stateFresh: false });
    expect(result.shouldWrite).toBe(false);
    expect(result.reason).toBe('stale_state');
  });

  it('blocks when battery power is below the charging threshold', () => {
    expect(decide({ batteryPowerW: 199 }).reason).toBe('battery_not_charging');
    expect(decide({ batteryPowerW: -100 }).reason).toBe('battery_not_charging');
  });

  it('blocks non-grid-charge slots when the DESS gate is enabled', () => {
    const result = decide({ slotMode: 'idle' });
    expect(result.shouldWrite).toBe(false);
    expect(result.reason).toBe('dess_not_grid_charge');
  });

  it('allows non-grid-charge slots when the DESS gate is disabled', () => {
    const result = decide({ slotMode: 'idle', gateOnDessSchedule: false });
    expect(result.shouldWrite).toBe(true);
    expect(result.newA).toBe(10.5);
  });

  it('clamps every write to the configured bounds', () => {
    expect(decide({ currentShoreA: 25, mppOperationMode: 2 }).reason).toBe('unchanged');
    expect(decide({ currentShoreA: 0, mppOperationMode: 1 }).reason).toBe('unchanged');
  });

  it('never exceeds the hard 25 A safety limit even if config is malformed high', () => {
    const result = decide({
      currentShoreA: 30,
      mppOperationMode: 2,
      config: { maxShoreA: 200 },
    });
    expect(result.shouldWrite).toBe(true);
    expect(result.newA).toBe(25);
  });

  it('uses a 0.1 A minimum step and rounds to the device step', () => {
    const result = decide({
      currentShoreA: 10,
      mppOperationMode: 2,
      config: { stepA: 0.01 },
    });
    expect(result.newA).toBe(10.1);
  });
});
