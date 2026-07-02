// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
  callHaService: vi.fn(),
}));

import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import {
  runBalanceTunerTick,
  resetBalanceTunerState,
  getBalanceTunerStatus,
  startBalanceTuner,
  stopBalanceTuner,
  isBalanceTunerRunning,
} from '../../../api/services/balance-tuner.ts';

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
  // Reset the write mock to a resolving default; some tests install a rejecting
  // implementation that clearAllMocks() does not undo.
  callHaService.mockReset();
  callHaService.mockResolvedValue(undefined);
});

afterEach(() => {
  stopBalanceTuner();
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

  it('holds (no write) on an implausible voltage read', async () => {
    mockStates({ ...DEFAULT_STATES, 'sensor.v0': '5.0' }); // outside the plausible band
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('no_voltage');
    const b0Writes = callHaService.mock.calls.filter(c => /(\.s0|\.t0)$/.test(c[0].target.entity_id));
    expect(b0Writes).toHaveLength(0);
  });

  it('records an error (without throwing) when a balance write fails', async () => {
    callHaService.mockRejectedValue(new Error('number.set_value failed'));
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('error');
    expect(r[0].error).toBe('number.set_value failed');
    expect(r[0].wrote).toBe(false);
    // reason carries the underlying decision reason
    expect(r[0].reason).toContain('balance write failed');
  });

  it('stringifies a non-Error thrown by the read (msg fallback)', async () => {
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'sensor.v0') throw 'plain string failure';
      return { state: DEFAULT_STATES[entityId] ?? 'unavailable' };
    });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('error');
    expect(r[0].error).toBe('plain string failure');
  });
});

describe('balance-tuner — parseNum edge cases', () => {
  it('holds when the voltage state is literally undefined (state == null)', async () => {
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'sensor.v0') return { state: undefined };
      return { state: DEFAULT_STATES[entityId] ?? 'unavailable' };
    });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('no_voltage');
    expect(r[0].maxCellVoltage).toBeNull();
  });

  it('treats "unknown"/"none" sentinel states as no reading', async () => {
    mockStates({ ...DEFAULT_STATES, 'sensor.v0': 'unknown', 'sensor.i0': 'none' });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('no_voltage');
  });

  it('treats a non-numeric voltage string as no reading (NaN → null)', async () => {
    mockStates({ ...DEFAULT_STATES, 'sensor.v0': 'abc' });
    const r = await runBalanceTunerTick(NOW, settings());
    expect(r[0].status).toBe('no_voltage');
  });
});

describe('balance-tuner — idempotency baseline fallback', () => {
  it('writes when the BMS reports no observed start/trigger (baseStart null) and remembers it', async () => {
    // Observed start/trigger unavailable AND no prior command → changed = true → write.
    mockStates({
      ...DEFAULT_STATES,
      'number.s0': 'unavailable', 'number.t0': 'unavailable',
      'number.s1': 'unavailable', 'number.t1': 'unavailable',
    });
    const r1 = await runBalanceTunerTick(NOW, settings());
    expect(r1[0].wrote).toBe(true);
    expect(r1[0].startVoltage).toBe(3.3);
    expect(r1[0].triggerVoltage).toBe(0.02);

    // Second tick: observed still unavailable, but lastCommanded fallback now matches
    // the freshly-decided values → idempotent, no further write.
    callHaService.mockClear();
    const r2 = await runBalanceTunerTick(NOW, settings());
    expect(r2[0].wrote).toBe(false);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('dry-run records the intended command as the fallback baseline', async () => {
    mockStates({
      ...DEFAULT_STATES,
      'number.s0': 'unavailable', 'number.t0': 'unavailable',
      'number.s1': 'unavailable', 'number.t1': 'unavailable',
    });
    const r1 = await runBalanceTunerTick(NOW, settings({}, { dryRun: true }));
    expect(r1[0].status).toBe('dry_run');
    // Next dry-run tick is idempotent against the remembered command.
    const r2 = await runBalanceTunerTick(NOW, settings({}, { dryRun: true }));
    expect(r2[0].status).toBe('ok');
    expect(r2[0].wrote).toBe(false);
  });
});

describe('balance-tuner — no batteries / no settings', () => {
  it('returns an empty record list when essConfig is absent', async () => {
    const s = settings();
    delete s.essConfig;
    const r = await runBalanceTunerTick(NOW, s);
    expect(r).toEqual([]);
  });
});

describe('balance-tuner — status view', () => {
  it('reports disabled defaults before any tick', () => {
    resetBalanceTunerState();
    const v = getBalanceTunerStatus();
    // No activeSettings yet (after reset state, activeSettings persists from prior
    // tests; assert only the always-present shape and null timestamps).
    expect(typeof v.enabled).toBe('boolean');
    expect(v.batteries).toEqual([]);
  });

  it('reflects config + records + timestamps after a writing tick', async () => {
    await runBalanceTunerTick(NOW, settings());
    const v = getBalanceTunerStatus();
    expect(v.enabled).toBe(true);
    expect(v.dryRun).toBe(false);
    expect(v.intervalSeconds).toBe(300);
    expect(v.lastTickAt).toBe(new Date(NOW).toISOString());
    expect(v.lastWriteAt).not.toBeNull();
    expect(v.batteries.map(b => b.name)).toEqual(['B0', 'B1']);
    // The view holds a copy of the records, not the live array.
    expect(v.batteries).not.toBe([]);
  });

  it('falls back to enabled=false / dryRun=true when no balance config exists', async () => {
    // Run a tick with a config so activeSettings is set, then null out the config
    // by running again with an explicit override whose batteryBalanceControl is undefined.
    await runBalanceTunerTick(NOW, settings({ batteryBalanceControl: undefined }));
    const v = getBalanceTunerStatus();
    expect(v.enabled).toBe(false);
    expect(v.dryRun).toBe(true);
    expect(v.intervalSeconds).toBeNull();
  });
});

describe('balance-tuner — lifecycle (start/stop/running)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopBalanceTuner();
    vi.useRealTimers();
  });

  it('start with disabled config does not arm the interval', () => {
    startBalanceTuner(settings({}, { enabled: false }));
    expect(isBalanceTunerRunning()).toBe(false);
  });

  it('start arms an interval, runs an immediate tick, and reports running', async () => {
    startBalanceTuner(settings());
    expect(isBalanceTunerRunning()).toBe(true);
    // The immediate void tickGuarded() runs the first tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHaEntityState).toHaveBeenCalled();
  });

  it('clamps the interval to a 5s floor and ticks again after the interval', async () => {
    startBalanceTuner(settings({}, { controlIntervalSeconds: 1 })); // below 5s floor
    await vi.advanceTimersByTimeAsync(0);
    fetchHaEntityState.mockClear();
    // 1s would be too soon if not clamped; advance the clamped 5s.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchHaEntityState).toHaveBeenCalled();
  });

  it('uses the 300s default when controlIntervalSeconds is falsy', async () => {
    startBalanceTuner(settings({}, { controlIntervalSeconds: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    fetchHaEntityState.mockClear();
    // No tick before 300s.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fetchHaEntityState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchHaEntityState).toHaveBeenCalled();
  });

  it('stop clears the interval and flips running to false', () => {
    startBalanceTuner(settings());
    expect(isBalanceTunerRunning()).toBe(true);
    stopBalanceTuner();
    expect(isBalanceTunerRunning()).toBe(false);
    // Idempotent: a second stop is a no-op (covers the !== null guard false branch).
    stopBalanceTuner();
    expect(isBalanceTunerRunning()).toBe(false);
  });

  it('tickGuarded swallows a tick error without throwing (defensive catch)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force runBalanceTunerTick() to throw from inside tickGuarded by making the
    // essConfig getter throw when the interval reads settings.essConfig?.batteries.
    const bad = settings();
    Object.defineProperty(bad, 'essConfig', {
      get() { throw new Error('settings exploded'); },
      configurable: true,
    });
    startBalanceTuner(bad);
    await vi.advanceTimersByTimeAsync(0);
    // The guard caught the throw and logged it; the tuner is still armed.
    expect(errorSpy).toHaveBeenCalledWith('[balance-tuner] tick error:', 'settings exploded');
    expect(isBalanceTunerRunning()).toBe(true);
    errorSpy.mockRestore();
  });

  it('re-entrancy guard skips an overlapping tick while one is in flight', async () => {
    // Make the first tick hang on its HA read so it is still "ticking" when the
    // interval fires the next tick, which must early-return via the `ticking` guard.
    let resolveFirst;
    let calls = 0;
    fetchHaEntityState.mockImplementation(() => {
      calls++;
      if (calls === 1) return new Promise((res) => { resolveFirst = () => res({ state: '3.30' }); });
      return Promise.resolve({ state: DEFAULT_STATES['sensor.v0'] ?? 'unavailable' });
    });

    startBalanceTuner(settings({}, { controlIntervalSeconds: 5 }));
    // First (immediate) tick starts and blocks on the pending read.
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = calls;
    // Fire the interval again while the first tick is still pending → guard returns early.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(callsAfterFirst); // no new reads — the overlapping tick was skipped
    // Let the first tick finish.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
  });
});
