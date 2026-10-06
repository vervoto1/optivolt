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
import { computePlan, planAndMaybeWrite, getLastPlan } from '../../../api/services/planner-service.ts';
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

  it('falls back to a movable window when the pinned hold is infeasible', async () => {
    // Started an hour ago (1 slot left) but the battery sagged to 30 %: at
    // 5 kW into 10 kWh it cannot be back at 100 % by the end of slot 0, so
    // the pinned LP is infeasible. The re-solve lets the window start later
    // instead of failing the plan.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSettings.mockResolvedValue({ ...driftSettings });
    loadData.mockResolvedValue({
      ...baseData,
      soc: { timestamp: NOW_STRING, value: 30 },
      rebalanceState: { startMs: NOW_MS - 3_600_000 },
    });

    const result = await computePlan();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-solving with the hold window free to move'));
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.cfg.rebalanceRemainingSlots).toBe(1);
    expect(result.rebalanceWindow.startIdx).toBeGreaterThan(0);
    expect(result.rows[result.rebalanceWindow.startIdx].dess).toMatchObject(HOLD);
    expect(getLastPlan()).toBe(result);
  });
});
