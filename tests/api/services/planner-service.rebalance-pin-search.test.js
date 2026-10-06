import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The search that relaxes a started hold's slot-0 pin when it is infeasible.
// Real HiGHS and the real planner pipeline; the vendored highs factory is
// wrapped so a test can override the answer for a given start cap (read back
// from the LP's c_balance_start row) and record which caps were solved.
const solverCtl = vi.hoisted(() => ({
  hook: null,
  caps: [],
}));

vi.mock('../../../vendor/highs-build/highs.js', async (importOriginal) => {
  const actual = await importOriginal();
  const realFactory = actual.default;
  return {
    default: async (opts) => {
      const instance = await realFactory(opts);
      return {
        solve(lp, options) {
          const row = /c_balance_start:([^\n]*)/.exec(lp);
          const cap = row ? row[1].split('start_balance_').length - 2 : null;
          solverCtl.caps.push(cap);
          const override = solverCtl.hook?.(cap);
          return override ?? instance.solve(lp, options);
        },
      };
    },
  };
});

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/pv-curtailment.ts');

import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';
import { computePlan, getLastEvPreview } from '../../../api/services/planner-service.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = Date.parse(NOW_STRING);
const SLOTS = 12;

// 60-min slots, 10 kWh at 5 kW: a 1-slot remainder of a started hold with the
// battery sagged to 40 % needs two slots to recover, so the physical lower
// bound on the start cap is 1 and the pin (cap 0) is infeasible.
const settings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 10000,
  maxGridExport_W: 10000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' },
  rebalanceEnabled: true,
  rebalanceHoldHours: 2,
};

const series = (v) => ({ start: NOW_STRING, step: 60, values: new Array(SLOTS).fill(v) });
const data = {
  load: series(500),
  pv: series(0),
  importPrice: series(10),
  exportPrice: series(5),
  soc: { timestamp: NOW_STRING, value: 40 },
  rebalanceState: { startMs: NOW_MS - 3_600_000 }, // 1 slot left
};

const INFEASIBLE = { Status: 'Infeasible', ObjectiveValue: Infinity, Columns: {} };
const NO_INCUMBENT = { Status: 'Time limit reached', ObjectiveValue: Infinity, Columns: {} };

let warn;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_STRING));
  vi.resetAllMocks();
  solverCtl.hook = null;
  solverCtl.caps = [];
  refreshSeriesFromVrmAndPersist.mockResolvedValue();
  saveSettings.mockResolvedValue();
  wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
  saveData.mockResolvedValue();
  wireUpdateData({ loadData, saveData, updateData });
  savePlanSnapshot.mockResolvedValue();
  loadSettings.mockResolvedValue({ ...settings });
  loadData.mockResolvedValue(structuredClone(data));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('computePlan — relaxing an infeasible slot-0 pin', () => {
  it('without overrides the lower bound is the answer: one relaxed solve', async () => {
    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1]);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(1);
    expect(result.rebalanceWindow).toEqual({ startIdx: 1, endIdx: 1 });
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(1);
  });

  it('gallops past the lower bound, then bisects down to the smallest feasible cap', async () => {
    // Pretend caps below 5 are infeasible (e.g. a taper the bound ignores).
    solverCtl.hook = (cap) => (cap != null && cap < 5 ? INFEASIBLE : undefined);

    const result = await computePlan();

    // gallop 1, 2, 4, 8 (feasible); bisect (4, 8]: 6, then 5
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 6, 5]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBe(5);
    expect(result.rebalanceWindow.startIdx).toBeLessThanOrEqual(5);
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowed to start up to slot 5 (6 relaxed solves)'));
  });

  it('releases the pin when no cap below T - D is feasible', async () => {
    solverCtl.hook = (cap) => (cap != null && cap < SLOTS - 1 ? INFEASIBLE : undefined);

    const result = await computePlan();

    // gallop 1, 2, 4, 8, then the next step reaches T - D = 11: the unpinned solve
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 11]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(SLOTS - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-solving with the hold window free to move'));
  });

  it('a pinned solve that stops without an incumbent is re-solved unpinned', async () => {
    solverCtl.hook = (cap) => (cap === 0 ? NO_INCUMBENT : undefined);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, SLOTS - 1]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('solver status "Time limit reached"'));
  });

  it('a relaxed probe that stops without an incumbent releases the pin', async () => {
    solverCtl.hook = (cap) => (cap === 0 ? INFEASIBLE : cap === 1 ? NO_INCUMBENT : undefined);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, SLOTS - 1]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaxed probe ended with solver status'));
  });

  it('a bisection probe without an answer keeps the feasible cap already found', async () => {
    solverCtl.hook = (cap) => {
      if (cap === 0 || cap === 1 || cap === 2) return INFEASIBLE;
      if (cap === 3) return NO_INCUMBENT;
      return undefined;
    };

    const result = await computePlan();

    // gallop 1, 2, 4 (feasible); bisect (2, 4]: 3 gives no answer, keep 4
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 3]);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(4);
  });

  it('stops bisecting at the probe budget and keeps the best cap found', async () => {
    // 48-slot horizon, caps below 21 infeasible: gallop 1, 2, 4, 8, 16, 32
    // (feasible), bisect (16, 32]: 24 (feasible), 20 (infeasible) — that is
    // the eighth relaxed probe, so the search stops at 24 rather than 21.
    solverCtl.hook = (cap) => (cap != null && cap < 21 ? INFEASIBLE : undefined);
    const long = (v) => ({ start: NOW_STRING, step: 60, values: new Array(48).fill(v) });
    loadData.mockResolvedValue({
      ...structuredClone(data),
      load: long(500), pv: long(0), importPrice: long(10), exportPrice: long(5),
    });

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 16, 32, 24, 20]);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(24);
  });

  it('the EV preview seeds its search with the main plan cap and does not repeat the warning', async () => {
    // Native EV mode, car unplugged: computePlan runs a second (preview) solve
    // on the same sagged hold.
    fetchHaEntityState.mockImplementation(async ({ entityId }) =>
      entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
    solverCtl.hook = (cap) => (cap != null && cap < 3 ? INFEASIBLE : undefined);
    loadSettings.mockResolvedValue({
      ...settings,
      evEnabled: true,
      evSource: 'native',
      evSocSensor: 'sensor.ev_soc',
      evPlugSensor: 'binary_sensor.ev_plug',
      evChargePhases: 1,
      evMinChargeCurrent_A: 6,
      evMaxChargeCurrent_A: 16,
      evBatteryCapacity_kWh: 10,
      evTargetSoc_percent: 80,
      evChargeEfficiency_percent: 100,
      evDepartureTime: '2024-01-01T08:00:00Z',
      evStartTime: '',
      evMinSoc_percent: 0,
      evApplyPriceLimit: false,
      evOpportunisticEnabled: false,
    });

    const result = await computePlan();

    // main: pin 0, gallop 1, 2, 4 (feasible), bisect 3; preview: pin 0, then the hint 3
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 3, 0, 3]);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(3);
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
    const rebalanceWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('rebalance hold'));
    expect(rebalanceWarnings).toHaveLength(1);
  });

  it('releases the pin when the search runs out of wall-clock budget', async () => {
    // Every solve "takes" 15 s; the 20 s budget allows two relaxed probes.
    let clock_ms = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock_ms);
    solverCtl.hook = (cap) => {
      clock_ms += 15_000;
      return cap != null && cap < 5 ? INFEASIBLE : undefined;
    };

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, 2, SLOTS - 1]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaxation search budget exhausted'));
  });
});
