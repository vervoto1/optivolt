// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
  callHaService: vi.fn(),
}));

import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import { runBalanceTunerTick, resetBalanceTunerState } from '../../../api/services/balance-tuner.ts';

const NOW = 1_700_000_000_000;

function battery(n) {
  return {
    name: `B${n}`,
    maxCellVoltageEntity: `sensor.v${n}`,
    currentEntity: `sensor.i${n}`,
    balanceStartVoltageEntity: `number.s${n}`,
    balanceTriggerVoltageEntity: `number.t${n}`,
  };
}

function settings(over = {}, ctrlOver = {}) {
  return {
    haUrl: 'ws://h:8123/api/websocket', haToken: 'tok',
    essConfig: { batteries: [battery(0), battery(1)] },
    batteryBalanceControl: {
      enabled: true, dryRun: false, controlIntervalSeconds: 300,
      highCurrentThreshold_A: 50, tightTrigger: 0.005, looseTrigger: 0.02, step: 0.05,
      topCap: 3.55, criticalHighVoltage: 3.549, topStart: 3.45, bottomTop: 3.4,
      bottomFloor: 2.9, maxWarnVoltage: 3.6,
      ...ctrlOver,
    },
    ...over,
  };
}

function mockStates(map) {
  fetchHaEntityState.mockImplementation(async ({ entityId }) => ({ state: map[entityId] ?? 'unavailable' }));
}

// Default: bottom region (v 3.30 → start 3.30, trigger 0.02), observed values differ → write.
const DEFAULT_STATES = {
  'sensor.v0': '3.30', 'sensor.i0': '10', 'number.s0': '3.20', 'number.t0': '0.05',
  'sensor.v1': '3.30', 'sensor.i1': '10', 'number.s1': '3.20', 'number.t1': '0.05',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetBalanceTunerState();
  mockStates(DEFAULT_STATES);
});

describe('balance-tuner — gating + iteration', () => {
  it('disabled → empty result, no reads', async () => {
    const r = await runBalanceTunerTick(NOW, settings({}, { enabled: false }));
    expect(r).toEqual([]);
    expect(fetchHaEntityState).not.toHaveBeenCalled();
  });

  it('produces one record per configured battery', async () => {
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r.map(b => b.name)).toEqual(['B0', 'B1']);
  });

  it('marks a battery misconfigured when a balance entity is missing', async () => {
    const s = settings();
    delete s.essConfig.batteries[1].balanceStartVoltageEntity;
    const r = await runBalanceTunerTick(NOW, s);
    expect(r[1].status).toBe('misconfigured');
  });
});

describe('balance-tuner — writes', () => {
  it('writes the decided start + trigger when they differ from the BMS', async () => {
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].wrote).toBe(true);
    expect(r[0].startVoltage).toBe(3.3);
    expect(r[0].triggerVoltage).toBe(0.02);
    // 2 writes per battery × 2 batteries.
    expect(callHaService).toHaveBeenCalledTimes(4);
    const b0Start = callHaService.mock.calls.find(c => c[0].target.entity_id === 'number.s0');
    expect(b0Start[0]).toMatchObject({ domain: 'number', service: 'set_value', data: { value: 3.3 } });
  });

  it('is idempotent — no write when the BMS already matches', async () => {
    mockStates({
      ...DEFAULT_STATES,
      'number.s0': '3.30', 'number.t0': '0.02',
      'number.s1': '3.30', 'number.t1': '0.02',
    });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r.every(b => b.wrote === false)).toBe(true);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('dry-run never writes', async () => {
    const r = await runBalanceTunerTick(NOW, settings({}, { dryRun: true }));
    expect(r.every(b => b.status === 'dry_run')).toBe(true);
    expect(callHaService).not.toHaveBeenCalled();
  });
});

describe('balance-tuner — fail-safe', () => {
  it('records an error for a BMS whose read fails, without throwing', async () => {
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'sensor.v0') throw new Error('HA down');
      return { state: DEFAULT_STATES[entityId] ?? 'unavailable' };
    });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('error');
    expect(r[1].status).toBe('ok'); // B1 still processed
  });

  it('holds when voltage/current is unavailable', async () => {
    mockStates({ ...DEFAULT_STATES, 'sensor.v0': 'unavailable' });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('no_voltage');
  });
});
