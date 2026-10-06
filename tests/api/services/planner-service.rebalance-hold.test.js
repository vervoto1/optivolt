import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// computePlan maps the solver-chosen rebalance hold window to a DESS hold
// (proBattery / battery→grid blocked / rebalance target), and a started hold
// is pinned to slot 0 so it cannot drift later in the horizon. Real HiGHS
// solves; only the stores, VRM and MQTT are mocked.
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');

import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { computePlan, planAndMaybeWrite, getLastPlan, REBALANCE_START_TOLERANCE_PERCENT } from '../../../api/services/planner-service.ts';
import { REBALANCE_PENDING_GIVE_UP_MS } from '../../../api/services/config-builder.ts';
import { Strategy, Restrictions } from '../../../lib/dess-mapper.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// 60-min slots for a small LP
const baseSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' },
  rebalanceEnabled: false,
  rebalanceHoldHours: 2, // 2 slots
};

const baseData = {
  load: { start: NOW_STRING, step: 60, values: [500, 500, 500, 500, 500] },
  pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
  importPrice: { start: NOW_STRING, step: 60, values: [10, 10, 10, 10, 10] },
  exportPrice: { start: NOW_STRING, step: 60, values: [5, 5, 5, 5, 5] },
  soc: { timestamp: NOW_STRING, value: 100 },
};

const HOLD = { strategy: Strategy.proBattery, restrictions: Restrictions.batteryToGrid, socTarget_percent: 100 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_STRING));
  vi.resetAllMocks();
  refreshSeriesFromVrmAndPersist.mockResolvedValue();
  setDynamicEssSchedule.mockResolvedValue();
  saveSettings.mockResolvedValue();
  wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
  wireUpdateData({ loadData, saveData, updateData });
  saveData.mockResolvedValue();
  savePlanSnapshot.mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('computePlan — rebalance hold DESS mapping', () => {
  it('maps the solver-chosen hold window to proBattery / batteryToGrid / target 100', async () => {
    // At 100 % the earliest window wins the tie-break.
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs: null } });

    const result = await computePlan();

    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 1 });
    expect(result.rows[0].dess).toMatchObject(HOLD);
    expect(result.rows[1].dess).toMatchObject(HOLD);
    expect(result.rows[2].dess.socTarget_percent).not.toBe(100);
  });

  it('writes the hold slots to Victron via setDynamicEssSchedule', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs: null } });

    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });

    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);
    const [rows] = setDynamicEssSchedule.mock.calls[0];
    expect(rows[0].dess).toMatchObject(HOLD);
    expect(rows[1].dess).toMatchObject(HOLD);
  });

  it('a completed cycle (remaining 0) maps exactly like rebalancing switched off', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: false });
    loadData.mockResolvedValue({ ...baseData });
    const off = await computePlan();

    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs: NOW_MS - 2 * 3_600_000 } });
    const completed = await computePlan();

    expect(completed.cfg.rebalanceRemainingSlots).toBe(0);
    expect(completed.rebalanceWindow).toBeUndefined();
    expect(completed.rows.map(r => r.dess)).toEqual(off.rows.map(r => r.dess));
  });
});

describe('computePlan — a started hold cannot drift later in the horizon', () => {
  // Battery full, a lucrative export in slot 0 and near-free import later:
  // left free, the solver exports now, recharges cheaply and holds later —
  // while a started hold's wall-clock countdown keeps running.
  const driftSettings = {
    ...baseSettings,
    rebalanceEnabled: true,
    maxChargePower_W: 5000,
    maxDischargePower_W: 5000,
    maxGridImport_W: 10000,
    maxGridExport_W: 10000,
  };
  const driftData = {
    ...baseData,
    importPrice: { start: NOW_STRING, step: 60, values: [30, 30, 1, 1, 1] },
    exportPrice: { start: NOW_STRING, step: 60, values: [100, 5, 0, 0, 0] },
  };

  it('control: before the hold starts the window is free to move', async () => {
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({ ...driftData, rebalanceState: { startMs: null } });

    const result = await computePlan();

    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.rebalanceWindow.startIdx).toBeGreaterThan(0);
    expect(result.rows[0].b2g).toBeGreaterThan(0); // drains the full battery to grid first
  });

  it('once started the hold stays at slot 0 and slot 0 is not proGrid', async () => {
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({ ...driftData, rebalanceState: { startMs: NOW_MS } });

    const result = await computePlan();

    expect(result.cfg.rebalanceMaxStartSlot).toBe(0);
    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 1 });
    expect(result.rows[0].dess.strategy).not.toBe(Strategy.proGrid);
    expect(result.rows[0].dess).toMatchObject(HOLD);
    expect(result.rows[1].dess).toMatchObject(HOLD);
  });

  it('first cycle at target: does not start the hold clock on a plan that exports first', async () => {
    // SoC reaches 100 % in a lucrative export slot. Left free, the solver
    // exports now and holds later; the countdown must not start on that plan
    // (it would run while the written schedule drains the battery), and slot 0
    // must not be pinned by a clock that this very plan stamped.
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({ ...driftData, rebalanceState: { startMs: null } });

    const result = await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });

    expect(result.rebalanceWindow.startIdx).toBeGreaterThan(0);
    expect(result.rows[0].b2g).toBeGreaterThan(0);
    // Not started; the pending marker that bounds a never-starting hold is set.
    expect(result.data.rebalanceState).toEqual({ startMs: null, pendingSinceMs: NOW_MS });
    // (saveData does run: the full-SoC observation is recorded pre-solve.)
    for (const [saved] of saveData.mock.calls) {
      expect(saved.rebalanceState?.startMs ?? null).toBeNull();
    }
    expect(result.summary.rebalanceStatus).toBe('scheduled');
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);
  });

  it('first cycle at target: starts the hold clock when the plan holds from slot 0', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs: null } });

    const result = await computePlan();

    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 1 });
    expect(result.data.rebalanceState).toEqual({ startMs: NOW_MS });
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ rebalanceState: { startMs: NOW_MS } }));
    expect(result.summary.rebalanceStatus).toBe('active');
  });

  it('a sagged started hold is relaxed only as far as needed, not released (no export first)', async () => {
    // 3 h hold started an hour ago (2 slots left), SoC sagged to 40 %. Slot 0
    // cannot recover 6 kWh at 5 kW, so the pin is infeasible. Released, the
    // solver would export at 100 c in slot 0 and hold at the end of the
    // horizon; relaxed to the smallest feasible start cap (1) it has to charge
    // from slot 0 and hold from slot 1.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSettings.mockResolvedValue({ ...driftSettings, rebalanceHoldHours: 3 });
    loadData.mockResolvedValue({
      ...driftData,
      soc: { timestamp: NOW_STRING, value: 40 },
      rebalanceState: { startMs: NOW_MS - 3_600_000 },
    });

    const result = await computePlan();

    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceRemainingSlots).toBe(2);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(1);
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(1);
    expect(result.rebalanceWindow).toEqual({ startIdx: 1, endIdx: 2 });
    expect(result.rows[0].b2g).toBe(0);
    expect(result.rows[0].g2b).toBeGreaterThan(0);
    expect(result.rows[0].dess.strategy).not.toBe(Strategy.proGrid);
    expect(result.rows[1].dess).toMatchObject(HOLD);
    expect(result.rows[2].dess).toMatchObject(HOLD);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowed to start up to slot 1'));
    expect(getLastPlan()).toBe(result);
  });

  it('relaxes a 1-slot remainder to the earliest slot the battery can reach target', async () => {
    // 1 slot left, SoC 30 %: 7 kWh at 5 kW needs two slots, so start cap 1.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 30 },
      rebalanceState: { startMs: NOW_MS - 3_600_000 },
    });

    const result = await computePlan();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowed to start up to slot 1'));
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBe(1);
    expect(result.cfg.rebalanceRemainingSlots).toBe(1);
    expect(result.rebalanceWindow).toEqual({ startIdx: 1, endIdx: 1 });
    expect(result.rows[1].dess).toMatchObject(HOLD);
    expect(getLastPlan()).toBe(result);
  });

  it('releases the pin when only the last possible start is feasible', async () => {
    // 1 slot left, SoC 50 % at 1 kW: reaching 100 % takes all 5 slots, so the
    // only feasible start is T - D = 4, which is the unpinned problem.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 50 },
      rebalanceState: { startMs: NOW_MS - 3_600_000 },
    });

    const result = await computePlan();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hold window free to move'));
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(4);
    expect(result.rebalanceWindow).toEqual({ startIdx: 4, endIdx: 4 });
  });

  it('a hold that is feasible from slot 0 reports no relaxation', async () => {
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({ ...driftData, rebalanceState: { startMs: NOW_MS } });

    const result = await computePlan();

    expect(result.cfg.rebalanceMaxStartSlot).toBe(0);
    expect(result.summary.rebalanceHoldMaxStartSlot).toBeUndefined();
  });
});

describe('computePlan — hold start tolerance and the pending give-up', () => {
  const savedStates = () => saveData.mock.calls.map(([saved]) => saved.rebalanceState);

  it('starts the hold clock on a pack that tops out 1 point below the target (99 %)', async () => {
    expect(REBALANCE_START_TOLERANCE_PERCENT).toBe(1);
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 99 },
      rebalanceState: { startMs: null, pendingSinceMs: NOW_MS - 3_600_000 },
    });

    const result = await computePlan();

    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 1 });
    expect(result.data.rebalanceState).toEqual({ startMs: NOW_MS });
    expect(savedStates()).toContainEqual({ startMs: NOW_MS });
    expect(result.summary.rebalanceStatus).toBe('active');
  });

  it('does not start the hold clock more than the tolerance below the target', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 98.9 },
      rebalanceState: { startMs: null },
    });

    const result = await computePlan();

    expect(result.data.rebalanceState).toEqual({ startMs: null, pendingSinceMs: NOW_MS });
    expect(result.summary.rebalanceStatus).toBe('scheduled');
  });

  it('keeps an existing pending marker instead of restamping it', async () => {
    const pendingSinceMs = NOW_MS - 24 * 3_600_000;
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 80 },
      rebalanceState: { startMs: null, pendingSinceMs },
    });

    const result = await computePlan();

    expect(result.data.rebalanceState).toEqual({ startMs: null, pendingSinceMs });
    expect(result.rebalanceWindow).toBeDefined();
    for (const state of savedStates()) expect(state).toEqual({ startMs: null, pendingSinceMs });
  });

  it('still maps the hold just before the give-up period ends', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      rebalanceState: { startMs: null, pendingSinceMs: NOW_MS - REBALANCE_PENDING_GIVE_UP_MS + 3_600_000 },
    });

    const result = await computePlan();

    expect(result.cfg.rebalanceRemainingSlots).toBe(2);
    expect(result.rebalanceWindow).toBeDefined();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('gives up on a hold that never started: no DESS hold, rebalancing switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: false });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 99 } });
    const off = await computePlan();

    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 99 },
      rebalanceState: { startMs: null, pendingSinceMs: NOW_MS - REBALANCE_PENDING_GIVE_UP_MS },
    });
    saveSettings.mockClear();
    const result = await computePlan();

    expect(result.cfg.rebalanceRemainingSlots).toBe(0);
    expect(result.rebalanceWindow).toBeUndefined();
    expect(result.rows.map(r => r.dess)).toEqual(off.rows.map(r => r.dess));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ rebalanceEnabled: false }));
    expect(savedStates()).toContainEqual({ startMs: null });
    expect(result.data.rebalanceState).toEqual({ startMs: null });
    expect(result.summary.rebalanceStatus).toBe('disabled');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rebalance hold did not start within 3 days of being enabled'));
  });

  it('drops a leftover pending marker once rebalancing is switched off', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: false });
    loadData.mockResolvedValue({
      ...baseData,
      rebalanceState: { startMs: null, pendingSinceMs: NOW_MS - 5 * 86_400_000 },
    });

    const result = await computePlan();

    expect(result.data.rebalanceState).toEqual({ startMs: null });
    expect(savedStates()).toContainEqual({ startMs: null });
  });

  it('writes no rebalance state when rebalancing is off and nothing is pending', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: false });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 50 } });

    const result = await computePlan();

    expect(result.data.rebalanceState).toBeUndefined();
    expect(saveData).not.toHaveBeenCalled();
  });
});
