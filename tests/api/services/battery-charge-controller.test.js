// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
  callHaService: vi.fn(),
}));

import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import {
  runBatteryChargeTick,
  resetBatteryChargeState,
  getBatteryChargeStatus,
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
