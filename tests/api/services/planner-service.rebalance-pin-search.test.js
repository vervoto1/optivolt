import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The search that relaxes a started hold's slot-0 pin when it is infeasible.
// Real HiGHS and the real planner pipeline; the vendored highs factory is
// wrapped so a test can override the answer for a given start cap (read back
// from the LP's c_balance_start row), rewrite the real answer (`post`), and
// record which caps were solved with which time limit.
const solverCtl = vi.hoisted(() => ({
  hook: null,
  post: null,
  caps: [],
  timeLimits_s: [],
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
          solverCtl.timeLimits_s.push(options?.time_limit);
          const override = solverCtl.hook?.(cap);
          if (override) return override;
          const real = instance.solve(lp, options);
          return solverCtl.post ? solverCtl.post(cap, real) : real;
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
import { SOLVE_TIME_LIMIT_S } from '../../../lib/solve-options.ts';
import { Strategy, Restrictions } from '../../../lib/dess-mapper.ts';

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
  solverCtl.post = null;
  solverCtl.caps = [];
  solverCtl.timeLimits_s = [];
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

    // gallop 1, 2, 4, 8, then the next step reaches T - D = 11: the unpinned
    // solve, then bisect (8, 11]: 9, 10 both infeasible
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 11, 9, 10]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(SLOTS - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no start cap below slot 11 found, 6 relaxed solves); hold window free to move'));
  });

  it('bisects below T - D when the gallop overshoots to it', async () => {
    // Caps below 9 infeasible: the gallop jumps from 8 straight to T - D = 11,
    // but 9 still holds, so the window must not be freed.
    solverCtl.hook = (cap) => (cap != null && cap < 9 ? INFEASIBLE : undefined);

    const result = await computePlan();

    // gallop 1, 2, 4, 8, unpinned 11 (feasible); bisect (8, 11]: 9
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 11, 9]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBe(9);
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(9);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowed to start up to slot 9 (5 relaxed solves)'));
  });

  it('does not bisect below a free-window solve that is not Optimal', async () => {
    solverCtl.hook = (cap) => {
      if (cap === SLOTS - 1) return NO_INCUMBENT;
      return cap != null ? INFEASIBLE : undefined;
    };

    // The free-window answer is returned as is; with no incumbent the plan
    // fails exactly as an unpinned solve without one would.
    await expect(computePlan()).rejects.toThrow('without a feasible incumbent');

    // gallop up to T - D, whose solve has no answer: no bisection
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 11]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('free window solved with status "Time limit reached"'));
  });

  it('a pinned solve that stops without an incumbent is re-solved unpinned', async () => {
    solverCtl.hook = (cap) => (cap === 0 ? NO_INCUMBENT : undefined);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, SLOTS - 1]);
    // The free fallback gets half the time limit (the pinned solve may have used all of it).
    expect(solverCtl.timeLimits_s).toEqual([SOLVE_TIME_LIMIT_S, SOLVE_TIME_LIMIT_S / 2]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('solver status "Time limit reached"'));
  });

  it('a pinned solve that stops with only an incumbent frees the window (re-solved unpinned)', async () => {
    // Battery at target: the pin is feasible, but the pinned solve hits the
    // time limit with a usable incumbent.
    loadData.mockResolvedValue({ ...structuredClone(data), soc: { timestamp: NOW_STRING, value: 100 } });
    solverCtl.post = (cap, real) => (cap === 0 ? { ...real, Status: 'Time limit reached' } : real);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, SLOTS - 1]);
    expect(solverCtl.timeLimits_s).toEqual([30, 15]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.summary.rebalanceHoldMaxStartSlot).toBe(SLOTS - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('solver status "Time limit reached"); re-solving with the hold window free to move'));
  });

  it('does not re-solve the same LP when the hold covers the whole horizon (T - D = 0)', async () => {
    // A 24 h hold started an hour ago: 23 slots remain on a 12-slot horizon,
    // so the pin at slot 0 is the only possible start.
    loadSettings.mockResolvedValue({ ...settings, rebalanceHoldHours: 24 });
    solverCtl.hook = (cap) => (cap === 0 ? INFEASIBLE : undefined);

    await expect(computePlan()).rejects.toThrow('"Infeasible"');

    expect(solverCtl.caps).toEqual([0]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the hold covers the whole horizon'));
  });

  it('says the search stopped on the budget when it frees the window before bisecting', async () => {
    // Every solve "takes" 6 s: the gallop (1, 2, 4, 8) uses up the 20 s
    // budget, reaches T - D with the free solve, and cannot bisect below it.
    let clock_ms = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock_ms);
    solverCtl.hook = (cap) => {
      clock_ms += 6_000;
      return cap != null && cap < SLOTS - 1 ? INFEASIBLE : undefined;
    };

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, SLOTS - 1]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('search stopped (budget/time limit) before finding a start cap below slot 11, 4 relaxed solves'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no start cap below slot'));
  });

  it('does not start the hold clock from a non-Optimal (display-only) plan', async () => {
    // Battery full, hold not started: an Optimal plan holding from slot 0
    // would stamp the clock; a time-limited incumbent must not.
    loadData.mockResolvedValue({ ...structuredClone(data), soc: { timestamp: NOW_STRING, value: 100 }, rebalanceState: { startMs: null } });
    solverCtl.post = (_cap, real) => ({ ...real, Status: 'Time limit reached' });

    const result = await computePlan();

    expect(result.result.Status).toBe('Time limit reached');
    expect(result.rebalanceWindow?.startIdx).toBe(0);
    expect(result.data.rebalanceState).toEqual({ startMs: null });
    for (const [saved] of saveData.mock.calls) {
      expect(saved.rebalanceState).toEqual({ startMs: null });
    }

    // The same plan, Optimal, does stamp it.
    solverCtl.post = null;
    const optimal = await computePlan();
    expect(optimal.data.rebalanceState).toEqual({ startMs: NOW_MS });
  });

  it('a relaxed probe that stops without an incumbent releases the pin', async () => {
    solverCtl.hook = (cap) => (cap === 0 ? INFEASIBLE : cap === 1 ? NO_INCUMBENT : undefined);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, SLOTS - 1]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaxed probe ended with solver status'));
  });

  it('a time-limited incumbent never counts as a feasible cap', async () => {
    // Caps below 3 infeasible; cap 3 stops at the time limit with an
    // incumbent, cap 4 is Optimal.
    solverCtl.hook = (cap) => (cap != null && cap < 3 ? INFEASIBLE : undefined);
    solverCtl.post = (cap, real) => (cap === 3 ? { ...real, Status: 'Time limit reached' } : real);

    const result = await computePlan();

    // gallop 1, 2, 4 (Optimal); bisect (2, 4]: 3 is only an incumbent, keep 4
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 3]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBe(4);
  });

  it('a gallop probe with only an incumbent releases the pin', async () => {
    solverCtl.hook = (cap) => (cap === 0 ? INFEASIBLE : undefined);
    solverCtl.post = (cap, real) => (cap === 1 ? { ...real, Status: 'Time limit reached' } : real);

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0, 1, SLOTS - 1]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaxed probe ended with solver status "Time limit reached"'));
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

  const evPreviewSettings = {
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
  };

  it('the EV preview starts its search at the main plan cap and does not repeat the warning', async () => {
    // Native EV mode, car unplugged: computePlan runs a second (preview) solve
    // on the same sagged hold.
    fetchHaEntityState.mockImplementation(async ({ entityId }) =>
      entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
    solverCtl.hook = (cap) => (cap != null && cap < 3 ? INFEASIBLE : undefined);
    loadSettings.mockResolvedValue({ ...evPreviewSettings });

    const result = await computePlan();

    // main: pin 0, gallop 1, 2, 4 (feasible), bisect 3; preview: no pinned
    // solve, straight to the hint 3
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 3, 3]);
    expect(result.cfg.rebalanceMaxStartSlot).toBe(3);
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
    const rebalanceWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('rebalance hold'));
    expect(rebalanceWarnings).toHaveLength(1);
  });

  it('the EV preview goes straight to the free window when the main plan freed it', async () => {
    fetchHaEntityState.mockImplementation(async ({ entityId }) =>
      entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
    solverCtl.hook = (cap) => (cap != null && cap < SLOTS - 1 ? INFEASIBLE : undefined);
    loadSettings.mockResolvedValue({ ...evPreviewSettings });

    const result = await computePlan();

    // main: pin 0, gallop 1, 2, 4, 8, free 11, bisect 9, 10; preview: free 11 only
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, 8, 11, 9, 10, 11]);
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
  });

  it('cuts each relaxed probe time limit to the remaining budget', async () => {
    // Every solve "takes" 7 s: the pinned solve and the free-window solve get
    // the full 30 s; probes get what is left of the 20 s budget.
    let clock_ms = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock_ms);
    solverCtl.hook = (cap) => {
      clock_ms += 7_000;
      return cap != null && cap < 9 ? INFEASIBLE : undefined;
    };

    await computePlan();

    // pin 0 (30), gallop 1 (20), 2 (13), 4 (6), budget gone -> free solve (30)
    expect(solverCtl.caps).toEqual([0, 1, 2, 4, SLOTS - 1]);
    expect(solverCtl.timeLimits_s).toEqual([30, 20, 13, 6, 30]);
  });

  it('never gives a relaxed probe less than a 1 s time limit', async () => {
    let clock_ms = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock_ms);
    solverCtl.hook = (cap) => {
      clock_ms += cap === 1 ? 19_900 : 0;
      return cap != null && cap < 5 ? INFEASIBLE : undefined;
    };

    await computePlan();

    // probe 2 starts with 0.1 s of budget left
    expect(solverCtl.caps.slice(0, 3)).toEqual([0, 1, 2]);
    expect(solverCtl.timeLimits_s.slice(0, 3)).toEqual([30, 20, 1]);
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

describe('computePlan — a hold within the start tolerance is reachable from slot 0', () => {
  // A large pack on 15-min slots: the last 1 % (600 Wh, plus idle drain) does
  // not fit in one slot at the 2 kW charge cap, and the top band (>= 97 %)
  // charges at only 800 W, so an LP holding at the full 100 % can never start
  // the window at slot 0. Within the start tolerance the LP holds at
  // target − 1 % instead, while the DESS target stays 100 %.
  const QUARTERS = 16;
  const quarter = (v) => ({ start: NOW_STRING, step: 15, values: new Array(QUARTERS).fill(v) });
  const largePackSettings = {
    ...settings,
    stepSize_m: 15,
    batteryCapacity_Wh: 60000,
    maxChargePower_W: 2000,
    maxDischargePower_W: 10000,
    idleDrain_W: 40,
    rebalanceHoldHours: 1, // 4 slots
    cvPhase: { enabled: true, thresholds: [{ soc_percent: 97, maxChargePower_W: 800 }] },
  };
  const largePackData = (rebalanceState) => ({
    load: quarter(500),
    pv: quarter(0),
    importPrice: quarter(10),
    exportPrice: quarter(5),
    soc: { timestamp: NOW_STRING, value: 99 },
    rebalanceState,
  });
  const HOLD = { strategy: Strategy.proBattery, restrictions: Restrictions.batteryToGrid, socTarget_percent: 100 };

  beforeEach(() => {
    loadSettings.mockResolvedValue({ ...largePackSettings });
  });

  it('stamps the hold start in one cycle at 99 %', async () => {
    loadData.mockResolvedValue(largePackData({ startMs: null }));

    const result = await computePlan();

    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceTargetSoc_percent).toBe(100);
    expect(result.cfg.rebalanceHoldSoc_percent).toBe(99);
    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 3 });
    expect(result.data.rebalanceState).toEqual({ startMs: NOW_MS });
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ rebalanceState: { startMs: NOW_MS } }));
    // Victron is still asked to top the pack up to 100 %.
    for (let i = 0; i <= 3; i++) expect(result.rows[i].dess).toMatchObject(HOLD);
    expect(result.summary.rebalanceStatus).toBe('active');
  });

  it('the started hold\'s slot-0 pin is feasible: one solve, no relaxation search', async () => {
    loadData.mockResolvedValue(largePackData({ startMs: NOW_MS }));

    const result = await computePlan();

    expect(solverCtl.caps).toEqual([0]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.cfg.rebalanceMaxStartSlot).toBe(0);
    expect(result.summary.rebalanceHoldMaxStartSlot).toBeUndefined();
    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 3 });
    expect(result.rows[0].dess).toMatchObject(HOLD);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('rebalance hold cannot be held'));
  });

  it('a started hold at 98.9 % keeps the relaxed level: the pin stays feasible at slot 0', async () => {
    // Once started, a reading just below the tolerance must not restore the
    // full target: from 98.9 % the 100 % level is out of reach within slot 0,
    // so the pin would turn infeasible and the window move later while the
    // hold clock runs.
    loadData.mockResolvedValue({ ...largePackData({ startMs: NOW_MS }), soc: { timestamp: NOW_STRING, value: 98.9 } });

    const result = await computePlan();

    expect(result.cfg.rebalanceHoldSoc_percent).toBe(99);
    expect(solverCtl.caps).toEqual([0]);
    expect(result.result.Status).toBe('Optimal');
    expect(result.summary.rebalanceHoldMaxStartSlot).toBeUndefined();
    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 3 });
    for (let i = 0; i <= 3; i++) expect(result.rows[i].dess).toMatchObject(HOLD);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('rebalance hold cannot be held'));
  });

  it('control: before the hold starts, 98.9 % keeps the full target and the window starts later', async () => {
    loadData.mockResolvedValue({ ...largePackData({ startMs: null }), soc: { timestamp: NOW_STRING, value: 98.9 } });

    const result = await computePlan();

    expect(result.cfg.rebalanceHoldSoc_percent).toBeUndefined();
    expect(result.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(result.rebalanceWindow.startIdx).toBeGreaterThan(0);
    expect(result.data.rebalanceState).toEqual({ startMs: null, pendingSinceMs: NOW_MS });
  });
});
