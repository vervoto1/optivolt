// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
  callHaService: vi.fn(),
}));

import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import {
  runBatteryChargeTick,
  resetBatteryChargeState,
  getBatteryChargeStatus,
  startBatteryChargeController,
  stopBatteryChargeController,
  isBatteryChargeControllerRunning,
} from '../../../api/services/battery-charge-controller.ts';

const NOW = 1_700_000_000_000;

function settings(over = {}, ctrlOver = {}) {
  return {
    haUrl: 'ws://h:8123/api/websocket', haToken: 'tok',
    essConfig: {
      batteries: [
        { name: 'B0', maxCellVoltageEntity: 'sensor.v0' },
        { name: 'B1', maxCellVoltageEntity: 'sensor.v1' },
      ],
      system: { maxChargeCurrentEntity: 'number.cc' },
    },
    batteryChargeControl: {
      enabled: true, dryRun: false, controlIntervalSeconds: 30,
      emergencyVoltage: 3.65, reduceVoltage: 3.5, restoreVoltage: 3.4,
      stabilizationSeconds: 30, currentLevels: [400, 180, 50, 0],
      ...ctrlOver,
    },
    ...over,
  };
}

// Respond to fetchHaEntityState by entity id.
function mockStates(map) {
  fetchHaEntityState.mockImplementation(async ({ entityId }) => ({ state: map[entityId] ?? 'unavailable' }));
}

const calledValues = () => callHaService.mock.calls.map(c => c[0].data?.value);

beforeEach(() => {
  vi.clearAllMocks();
  resetBatteryChargeState();
  mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
});

describe('battery-charge-controller — gating', () => {
  it('disabled → no write', async () => {
    const r = await runBatteryChargeTick(NOW, settings({}, { enabled: false }));
    expect(r.status).toBe('disabled');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('misconfigured when no voltage source and no charge entity', async () => {
    const r = await runBatteryChargeTick(NOW, settings({ essConfig: { batteries: [], system: {} } }));
    expect(r.status).toBe('misconfigured');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('no_voltage when cell voltages are unavailable', async () => {
    mockStates({ 'sensor.v0': 'unavailable', 'sensor.v1': 'unknown', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('no_voltage');
    expect(callHaService).not.toHaveBeenCalled();
  });
});

describe('battery-charge-controller — seeding + writes', () => {
  it('seeds from the observed register on the first tick (no write)', async () => {
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('seeded');
    expect(r.commandedLevel).toBe(400);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('emergency → writes 0 A', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed at 400
    mockStates({ 'sensor.v0': '3.70', 'sensor.v1': '3.40', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW + 1000, settings());
    expect(r.reason).toBe('emergency');
    expect(callHaService).toHaveBeenCalledOnce();
    expect(calledValues()).toEqual([0]);
    expect(callHaService.mock.calls[0][0]).toMatchObject({ domain: 'number', service: 'set_value', target: { entity_id: 'number.cc' } });
  });

  it('reduce → steps the register down one rung', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    await runBatteryChargeTick(NOW + 1000, settings());
    expect(calledValues()).toEqual([180]);
  });

  it('restore is dwell-gated, then steps up', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '0' });
    await runBatteryChargeTick(NOW, settings()); // seed 0
    // Within the dwell window → no write.
    const wait = await runBatteryChargeTick(NOW + 29_000, settings());
    expect(wait.reason).toBe('restore_wait_dwell');
    expect(callHaService).not.toHaveBeenCalled();
    // After the 30s dwell → step up to 50.
    await runBatteryChargeTick(NOW + 31_000, settings());
    expect(calledValues()).toEqual([50]);
  });
});

describe('battery-charge-controller — dry-run + fail-safe + contention', () => {
  it('dry-run advances virtual state but never writes', async () => {
    const s = settings({}, { dryRun: true });
    await runBatteryChargeTick(NOW, s); // seed 400
    mockStates({ 'sensor.v0': '3.70', 'sensor.v1': '3.40', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW + 1000, s);
    expect(r.status).toBe('dry_run');
    expect(r.commandedLevel).toBe(0);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('holds (no write) when the write call fails', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    callHaService.mockRejectedValueOnce(new Error('HA down'));
    const r = await runBatteryChargeTick(NOW + 1000, settings());
    expect(r.status).toBe('error');
    // lastCommandLevel stayed at 400 (the failed write did not commit).
    expect(getBatteryChargeStatus().commandedLevel).toBe(400);
  });

  it('flags contention when the register diverges from the last command', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400 (cc=400)
    // Register now reads 180 (another controller), voltage in the hold band → no change.
    mockStates({ 'sensor.v0': '3.45', 'sensor.v1': '3.45', 'number.cc': '180' });
    let r;
    for (let i = 1; i <= 3; i++) r = await runBatteryChargeTick(NOW + i * 1000, settings());
    expect(r.status).toBe('contention');
    expect(callHaService).not.toHaveBeenCalled();
  });
});

describe('battery-charge-controller — seed-tick safety + robustness', () => {
  it('emergency-stops on the very first tick when already over-voltage (no blind seed window)', async () => {
    mockStates({ 'sensor.v0': '3.70', 'sensor.v1': '3.40', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW, settings()); // first tick, no prior seed
    expect(r.reason).toBe('emergency');
    expect(calledValues()).toEqual([0]);
  });

  it('holds (no write, no restore) on an implausible voltage read', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400
    // A glitched 0 V read would push the state machine to RESTORE (raise current).
    mockStates({ 'sensor.v0': '0', 'sensor.v1': '0', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW + 60_000, settings());
    expect(r.status).toBe('no_voltage');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('still protects when one voltage entity errors (allSettled, not all-or-nothing)', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'sensor.v0') throw new Error('404');
      if (entityId === 'sensor.v1') return { state: '3.55' }; // above reduce
      return { state: '400' }; // number.cc
    });
    await runBatteryChargeTick(NOW + 1000, settings());
    expect(calledValues()).toEqual([180]); // reduced despite v0 failing
  });
});

describe('battery-charge-controller — entity resolution + parsing', () => {
  it('prefers the explicit maxCellVoltageEntities override over essConfig batteries', async () => {
    // Explicit override entities read from a different sensor + register. Seed in the
    // hold band (no write), then drive a reduce off the EXPLICIT voltage sensor.
    const s = settings({}, {
      maxCellVoltageEntities: ['sensor.explicit_v', ''],
      maxChargeCurrentEntity: 'number.explicit_cc',
    });
    mockStates({ 'sensor.explicit_v': '3.45', 'number.explicit_cc': '400' }); // hold band
    await runBatteryChargeTick(NOW, s);              // seed at 400 from explicit cc, no write
    expect(callHaService).not.toHaveBeenCalled();
    mockStates({ 'sensor.explicit_v': '3.55', 'number.explicit_cc': '400' }); // > reduce
    await runBatteryChargeTick(NOW + 1000, s);       // step down via explicit sensor
    expect(calledValues()).toEqual([180]);
    expect(callHaService.mock.calls[0][0].target.entity_id).toBe('number.explicit_cc');
  });

  it('treats empty/none/unknown register reads as no-seed null and holds with no voltage', async () => {
    // 'none' register read → parseNum returns null; voltages also unavailable → hold.
    mockStates({ 'sensor.v0': 'none', 'sensor.v1': '', 'number.cc': 'none' });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('no_voltage');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('seeds to level 0 when the register read is unavailable at seed time', async () => {
    // Voltage valid (hold band), but the register reads unavailable → observedLevel
    // null → seed nearestLevel(levels, 0) = 0.
    mockStates({ 'sensor.v0': '3.45', 'sensor.v1': '3.45', 'number.cc': 'unavailable' });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('seeded');
    expect(r.commandedLevel).toBe(0);
    expect(r.observedLevel).toBeNull();
  });

  it('tolerates a charge-current read failure on a later tick once already seeded', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400 from cc=400
    // Later tick: voltage triggers reduce, but the register read throws. Already
    // seeded (lastCommandLevel != null) → the read failure is tolerated, the
    // reduce write still happens.
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'number.cc') throw new Error('register read timeout');
      return { state: '3.55' }; // both voltage sensors above reduce
    });
    const r = await runBatteryChargeTick(NOW + 1000, settings());
    expect(r.status).toBe('ok');
    expect(r.observedLevel).toBeNull(); // read failed, but tolerated
    expect(calledValues()).toEqual([180]);
  });

  it('errors (cannot seed) when the register read fails on the very first tick', async () => {
    // Voltage valid (hold band) but the register read throws while never-seeded
    // (lastCommandLevel === null) → cannot seed → hold with status error.
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'number.cc') throw new Error('register unreachable');
      return { state: '3.45' }; // hold band
    });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('error');
    expect(r.reason).toBe('charge-current read failed (cannot seed)');
    expect(r.error).toBe('register unreachable');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('treats an undefined voltage state as no reading (parseNum null branch)', async () => {
    // fetchHaEntityState resolves with an object that has no `state` field at all.
    fetchHaEntityState.mockImplementation(async ({ entityId }) => {
      if (entityId === 'number.cc') return { state: '400' };
      return {}; // voltage entities: state === undefined
    });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('no_voltage');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('treats an empty-string voltage state as no reading (parseNum empty branch)', async () => {
    mockStates({ 'sensor.v0': '', 'sensor.v1': '', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('no_voltage');
  });

  it('treats a non-numeric voltage state as no reading (parseNum NaN → null)', async () => {
    // Passes the sentinel filters but Number('3.5V') is NaN → parseNum returns null.
    mockStates({ 'sensor.v0': '3.5V', 'sensor.v1': 'garbage', 'number.cc': '400' });
    const r = await runBatteryChargeTick(NOW, settings());
    expect(r.status).toBe('no_voltage');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('falls back to an empty voltage list when essConfig has no batteries array', async () => {
    // essConfig present but without `batteries` → `?? []` → no voltage sources →
    // misconfigured (also no explicit override).
    const r = await runBatteryChargeTick(NOW, settings({
      essConfig: { system: { maxChargeCurrentEntity: 'number.cc' } },
    }));
    expect(r.status).toBe('misconfigured');
  });

  it('defaults dryRun to true in the record when the config omits it (?? true branch)', async () => {
    // A disabled controller whose cfg has no dryRun → record()'s `?? true` default.
    const r = await runBatteryChargeTick(NOW, {
      haUrl: 'h', haToken: 't',
      batteryChargeControl: { enabled: false }, // no dryRun field
    });
    expect(r.status).toBe('disabled');
    expect(r.dryRun).toBe(true);
  });
});

describe('battery-charge-controller — status view + write metadata', () => {
  it('reports null interval + false enabled when the controller config omits those fields', async () => {
    resetBatteryChargeState();
    // A disabled controller whose cfg lacks enabled/controlIntervalSeconds exercises
    // the `?? false` / `?? null` defaults in the status view.
    stopBatteryChargeController();
    startBatteryChargeController({
      haUrl: 'h', haToken: 't',
      batteryChargeControl: { dryRun: true }, // no enabled, no controlIntervalSeconds
    });
    const view = getBatteryChargeStatus();
    expect(view.status).toBe('never_run');
    expect(view.enabled).toBe(false);
    expect(view.intervalSeconds).toBeNull();
    expect(view.lastWriteAt).toBeNull();
  });

  it('surfaces enabled/interval/lastWriteAt after a live write', async () => {
    const s = settings({}, { controlIntervalSeconds: 45 });
    await runBatteryChargeTick(NOW, s); // seed 400
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    await runBatteryChargeTick(NOW + 1000, s); // live write → records lastWriteAt
    const view = getBatteryChargeStatus();
    expect(view.enabled).toBe(true);
    expect(view.intervalSeconds).toBe(45);
    expect(view.lastWriteAt).toBe(new Date(NOW + 1000).toISOString());
    expect(view.wrote).toBe(true);
  });

  it('stringifies a non-Error write failure into the error field', async () => {
    await runBatteryChargeTick(NOW, settings()); // seed 400
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    callHaService.mockRejectedValueOnce('string write failure');
    const r = await runBatteryChargeTick(NOW + 1000, settings());
    expect(r.status).toBe('error');
    expect(r.error).toBe('string write failure');
  });

  it('reports contention status on a write while the register is owned by another controller', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Wide ladder so successive reduces keep WRITING long enough for contention to
    // reach the threshold on a tick that also commands a (writing) change.
    const ctrl = { currentLevels: [400, 300, 200, 100, 50, 0] };
    await runBatteryChargeTick(NOW, settings({}, ctrl)); // seed 400 (cc=400)
    // Register pinned high (~400) by another controller while OptiVolt reduces; the
    // observed rung diverges from each shrinking command.
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.55', 'number.cc': '400' });
    let r;
    for (let i = 1; i <= 4; i++) r = await runBatteryChargeTick(NOW + i * 1000, settings({}, ctrl));
    expect(r.status).toBe('contention');
    expect(r.wrote).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('battery-charge-controller — control loop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopBatteryChargeController();
    vi.useRealTimers();
  });

  it('does not start the loop when the controller is disabled', () => {
    startBatteryChargeController(settings({}, { enabled: false }));
    expect(isBatteryChargeControllerRunning()).toBe(false);
  });

  it('starts the loop and ticks immediately on start (seeds on the first tick)', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
    startBatteryChargeController(settings());
    expect(isBatteryChargeControllerRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // flush the immediate void tickGuarded()
    expect(getBatteryChargeStatus().status).toBe('seeded');
    expect(getBatteryChargeStatus().commandedLevel).toBe(400);
  });

  it('clamps the interval to a 5s floor and keeps ticking', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
    startBatteryChargeController(settings({}, { controlIntervalSeconds: 1 }));
    await vi.advanceTimersByTimeAsync(0); // immediate seed tick
    expect(getBatteryChargeStatus().status).toBe('seeded');
    // Next scheduled tick happens at the 5s floor, not 1s.
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calledValues()).toEqual([180]);
  });

  it('uses the default 30s interval when none is configured', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
    startBatteryChargeController(settings({}, { controlIntervalSeconds: 0 }));
    await vi.advanceTimersByTimeAsync(0); // immediate seed
    mockStates({ 'sensor.v0': '3.55', 'sensor.v1': '3.40', 'number.cc': '400' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(callHaService).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calledValues()).toEqual([180]);
  });

  it('preserves seed/ownership state across a re-start while already enabled', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '180' });
    startBatteryChargeController(settings()); // seed 180
    await vi.advanceTimersByTimeAsync(0);
    expect(getBatteryChargeStatus().commandedLevel).toBe(180);
    // Re-start while already enabled (a settings save) must NOT re-seed: the
    // observed register is irrelevant; lastCommandLevel stays 180.
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
    startBatteryChargeController(settings());
    await vi.advanceTimersByTimeAsync(0);
    expect(getBatteryChargeStatus().commandedLevel).toBe(180);
  });

  it('resets state on a genuine disabled→enabled transition', async () => {
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '50' });
    startBatteryChargeController(settings()); // enabled → seed 50
    await vi.advanceTimersByTimeAsync(0);
    expect(getBatteryChargeStatus().commandedLevel).toBe(50);
    // Disable, then re-enable → reset → re-seed from the now-observed register.
    startBatteryChargeController(settings({}, { enabled: false }));
    expect(isBatteryChargeControllerRunning()).toBe(false);
    mockStates({ 'sensor.v0': '3.30', 'sensor.v1': '3.30', 'number.cc': '400' });
    startBatteryChargeController(settings());
    await vi.advanceTimersByTimeAsync(0);
    expect(getBatteryChargeStatus().commandedLevel).toBe(400);
  });

  it('skips overlapping ticks via the ticking guard', async () => {
    let release;
    fetchHaEntityState.mockReturnValue(new Promise((res) => { release = () => res({ state: '3.30' }); }));
    startBatteryChargeController(settings({}, { controlIntervalSeconds: 5 }));
    await vi.advanceTimersByTimeAsync(0);     // immediate tick starts, hangs in fetch
    await vi.advanceTimersByTimeAsync(5_000); // scheduled tick fires but guard skips it
    // Only the first (hung) tick's voltage fetches were issued (2 voltage sensors).
    expect(fetchHaEntityState).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('logs and survives a thrown tick in the guarded timer callback', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Promise.allSettled never rejects, and runBatteryChargeTick catches internally,
    // so the guard rarely sees a throw — but the catch must still be wired. Force a
    // synchronous throw out of the tick by making Promise.allSettled unavailable.
    const orig = Promise.allSettled;
    Promise.allSettled = () => { throw new Error('allSettled boom'); };
    try {
      startBatteryChargeController(settings());
      await vi.advanceTimersByTimeAsync(0);
      expect(errSpy).toHaveBeenCalledWith(
        '[battery-charge-controller] tick error:',
        'allSettled boom',
      );
    } finally {
      Promise.allSettled = orig;
      errSpy.mockRestore();
    }
  });

  it('stop is idempotent — stopping a stopped loop is a no-op', () => {
    startBatteryChargeController(settings());
    stopBatteryChargeController();
    expect(isBatteryChargeControllerRunning()).toBe(false);
    stopBatteryChargeController();
    expect(isBatteryChargeControllerRunning()).toBe(false);
  });
});
