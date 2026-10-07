import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real HiGHS and the real planner pipeline; only persistence, hardware I/O and
// the PV-curtailment loop are mocked. Two seams steer the solver:
//  - solve options: tests merge extra HiGHS options (time_limit 0 for a stop
//    with no incumbent, objective_target 1e12 for an early stop with one) into
//    what lib/solve-options.ts returns;
//  - the vendored highs factory: wrapped so tests can count instantiations and
//    replace a given solve call (per computePlan) with a throw or a fake result.
const solverCtl = vi.hoisted(() => ({
  extraOptions: {},
  solveIndex: 0,
  solveHook: null,
}));

vi.mock('../../../lib/solve-options.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    solveOptionsFor: (cfg) => ({ ...actual.solveOptionsFor(cfg), ...solverCtl.extraOptions }),
  };
});

vi.mock('../../../vendor/highs-build/highs.js', async (importOriginal) => {
  const actual = await importOriginal();
  const realFactory = actual.default;
  const factory = vi.fn(async (opts) => {
    const instance = await realFactory(opts);
    return {
      solve(lp, options) {
        solverCtl.solveIndex += 1;
        if (solverCtl.solveHook) return solverCtl.solveHook({ index: solverCtl.solveIndex, instance, lp, options });
        return instance.solve(lp, options);
      },
    };
  });
  return { default: factory };
});

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/pv-curtailment.ts');
vi.mock('../../../api/services/ev-decision-service.ts');

import highsFactory from '../../../vendor/highs-build/highs.js';
import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import { computeEvDecision } from '../../../api/services/ev-decision-service.ts';
import { runActuatorTick, resetEvActuatorState } from '../../../api/services/ev-actuator-service.ts';
import { updatePvCurtailmentPlan } from '../../../api/services/pv-curtailment.ts';
import {
  computePlan,
  planAndMaybeWrite,
  getLastPlan,
  getLastEvPreview,
  getCurrentSlotMode,
} from '../../../api/services/planner-service.ts';
import { SolverStatusError } from '../../../lib/parse-solution.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = Date.parse(NOW_STRING);
const SLOTS = 48;

// 48 quarter-hour slots with a price wave and a PV hump.
const baseSettings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 20000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 2,
};

// No grid import and no battery discharge: the hard load balance cannot be met.
const infeasibleSettings = { ...baseSettings, maxGridImport_W: 0, maxDischargePower_W: 0 };

// A pending 1 h rebalance window adds the window-start binaries; with them,
// objective_target 1e12 stops on the first incumbent ("Target for objective
// reached", a worse finite objective) instead of proving optimality.
const rebalanceSettings = { ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 1 };

const series = (values) => ({ start: NOW_STRING, step: 15, values });
const baseData = {
  load: series(Array(SLOTS).fill(800)),
  pv: series(Array.from({ length: SLOTS }, (_, t) => (t > 16 && t < 36 ? 5000 : 0))),
  importPrice: series(Array.from({ length: SLOTS }, (_, t) => 20 + 15 * Math.sin(t / 7))),
  exportPrice: series(Array.from({ length: SLOTS }, (_, t) => 8 + 15 * Math.sin(t / 7))),
  soc: { timestamp: NOW_STRING, value: 50 },
  rebalanceState: { startMs: null },
};

// Native EV mode with the car unplugged: computePlan runs a second (preview) solve.
const evPreviewSettings = {
  ...baseSettings,
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
  evDepartureTime: '2024-01-01T04:00:00Z',
  evStartTime: '',
  evMinSoc_percent: 0,
  evApplyPriceLimit: false,
  evOpportunisticEnabled: false,
};

function resetSolverCtl() {
  solverCtl.extraOptions = {};
  solverCtl.solveIndex = 0;
  solverCtl.solveHook = null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_STRING));
  vi.clearAllMocks();
  resetSolverCtl();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  refreshSeriesFromVrmAndPersist.mockResolvedValue();
  setDynamicEssSchedule.mockResolvedValue();
  saveSettings.mockResolvedValue();
  wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
  wireUpdateData({ loadData, saveData, updateData });
  saveData.mockResolvedValue();
  savePlanSnapshot.mockResolvedValue();
  // Car disconnected; the SoC sensor still reads (only used by the EV tests).
  fetchHaEntityState.mockImplementation(async ({ entityId }) =>
    entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
  loadSettings.mockResolvedValue({ ...baseSettings });
  loadData.mockResolvedValue({ ...baseData });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Solve one Optimal plan, then clear the mocks so the next step's calls stand alone. */
async function seedOptimalPlan() {
  const plan = await computePlan();
  expect(plan.result.Status).toBe('Optimal');
  expect(getLastPlan()).toBe(plan);
  vi.clearAllMocks();
  resetSolverCtl();
  return plan;
}

describe('computePlan — no usable solution (SolverStatusError)', () => {
  it('an infeasible solve rejects and keeps the previous plan for every consumer', async () => {
    const previous = await seedOptimalPlan();
    loadSettings.mockResolvedValue({ ...infeasibleSettings });

    await expect(planAndMaybeWrite({ writeToVictron: true, forceWrite: true }))
      .rejects.toThrow(SolverStatusError);
    await expect(computePlan()).rejects.toThrow(/no usable solution.*"Infeasible"/);

    expect(getLastPlan()).toBe(previous);
    expect(updatePvCurtailmentPlan).not.toHaveBeenCalled();
    expect(savePlanSnapshot).not.toHaveBeenCalled();
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
  });

  it('a time limit hit with no incumbent (time_limit 0) rejects and keeps the previous plan', async () => {
    const previous = await seedOptimalPlan();
    solverCtl.extraOptions = { time_limit: 0 };

    await expect(planAndMaybeWrite({ writeToVictron: true, forceWrite: true }))
      .rejects.toThrow(/without a feasible incumbent.*"Time limit reached"/);

    expect(getLastPlan()).toBe(previous);
    expect(getCurrentSlotMode(NOW_MS)).toBe(getCurrentSlotModeOf(previous));
    expect(updatePvCurtailmentPlan).not.toHaveBeenCalled();
    expect(savePlanSnapshot).not.toHaveBeenCalled();
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
    // A time-limit stop does not throw, so the instance is kept.
    expect(highsFactory).not.toHaveBeenCalled();

    // The same instance solves Optimal again once the limit is lifted.
    solverCtl.extraOptions = {};
    const next = await computePlan();
    expect(next.result.Status).toBe('Optimal');
    expect(next.result.ObjectiveValue).toBeCloseTo(previous.result.ObjectiveValue, 6);
    expect(getLastPlan()).toBe(next);
  });
});

function getCurrentSlotModeOf(plan) {
  const row = plan.rows[0];
  if (row.g2b > 0) return 'grid_charge';
  if (row.b2l + row.b2g + (row.b2ev ?? 0) > 0) return 'discharge';
  return 'idle';
}

describe('EV actuator after a refused solve', () => {
  it('keeps acting on the previous plan, then goes stale_plan (no charger write) once it is too old', async () => {
    resetEvActuatorState();
    loadSettings.mockResolvedValue({
      ...evPreviewSettings,
      evActuationEnabled: true,
      evActuationPaused: false,
      evChargerSwitchEntity: 'switch.charger',
      evMaxPlanAgeSeconds: 1800,
      haUrl: 'ws://h:8123/api/websocket',
      haToken: 'tok',
      autoCalculate: { writeToVictron: false },
    });
    const previous = await seedOptimalPlan();
    computeEvDecision.mockResolvedValue({
      mode: 'idle', is_charging: false, ev_charge_W: 0, ev_charge_A: 0, plugConnected: true, reason: 'test',
    });

    // Ten minutes later the next solve hits the time limit with no incumbent.
    const laterMs = NOW_MS + 10 * 60_000;
    vi.setSystemTime(new Date(laterMs));
    solverCtl.extraOptions = { time_limit: 0 };
    await expect(computePlan()).rejects.toThrow(SolverStatusError);
    expect(getLastPlan()).toBe(previous);

    const fresh = await runActuatorTick(laterMs);
    expect(fresh.status).not.toBe('stale_plan');
    expect(computeEvDecision).toHaveBeenCalledWith(expect.anything(), previous, laterMs);

    computeEvDecision.mockClear();
    const tooOldMs = previous.computedAtMs + 1800 * 1000 + 1;
    const stale = await runActuatorTick(tooOldMs);
    expect(stale.status).toBe('stale_plan');
    expect(computeEvDecision).not.toHaveBeenCalled();
    expect(callHaService).not.toHaveBeenCalled();
  });
});

describe('computePlan — early-stop incumbent is display-only', () => {
  beforeEach(() => {
    loadSettings.mockResolvedValue({ ...rebalanceSettings });
  });

  it('returns the incumbent with its status but never caches, acts on or snapshots it', async () => {
    const previous = await seedOptimalPlan();
    solverCtl.extraOptions = { objective_target: 1e12 };

    const early = await planAndMaybeWrite({ writeToVictron: false });

    expect(early.result.Status).toBe('Target for objective reached');
    expect(Number.isFinite(early.result.ObjectiveValue)).toBe(true);
    expect(early.result.ObjectiveValue).toBeGreaterThanOrEqual(previous.result.ObjectiveValue);
    expect(early.rows).toHaveLength(SLOTS);
    expect(getLastPlan()).toBe(previous);
    expect(updatePvCurtailmentPlan).not.toHaveBeenCalled();
    expect(savePlanSnapshot).not.toHaveBeenCalled();
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
  });

  it('refuses to write the incumbent to Victron', async () => {
    const previous = await seedOptimalPlan();
    solverCtl.extraOptions = { objective_target: 1e12 };

    await expect(planAndMaybeWrite({ writeToVictron: true, forceWrite: true }))
      .rejects.toThrow(/Refusing to write schedule to Victron/);

    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
    expect(getLastPlan()).toBe(previous);
  });

  it('skips the EV preview and keeps the previous one', async () => {
    loadSettings.mockResolvedValue({ ...evPreviewSettings, rebalanceEnabled: true, rebalanceHoldHours: 1 });
    await seedOptimalPlan();
    const previousPreview = getLastEvPreview();
    expect(previousPreview?.hasSchedule).toBe(true);

    solverCtl.extraOptions = { objective_target: 1e12 };
    const early = await computePlan();

    expect(early.result.Status).toBe('Target for objective reached');
    expect(solverCtl.solveIndex).toBe(1); // main solve only, no preview solve
    expect(getLastEvPreview()).toBe(previousPreview);
  });

  it('caches and acts on an Optimal solve as before', async () => {
    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(getLastPlan()).toBe(plan);
    expect(updatePvCurtailmentPlan).toHaveBeenCalledTimes(1);
    expect(savePlanSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('computePlan — EV preview solve failures', () => {
  beforeEach(() => {
    loadSettings.mockResolvedValue({ ...evPreviewSettings });
  });

  it('a throwing preview solve keeps the main plan, clears the preview and resets the HiGHS instance', async () => {
    await seedOptimalPlan();
    solverCtl.solveHook = ({ index, instance, lp, options }) => {
      if (index === 2) throw new Error('RuntimeError: memory access out of bounds');
      return instance.solve(lp, options);
    };

    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(getLastPlan()).toBe(plan);
    expect(getLastEvPreview()).toBeNull();
    expect(console.warn).toHaveBeenCalledWith('[calculate] EV preview solve failed:', expect.stringMatching(/memory access/));
    expect(highsFactory).not.toHaveBeenCalled();

    // The next solve runs on a fresh instance and the preview comes back.
    resetSolverCtl();
    const next = await computePlan();
    expect(highsFactory).toHaveBeenCalledTimes(1);
    expect(next.result.Status).toBe('Optimal');
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
  });

  it('a preview with no usable solution clears the preview but keeps the HiGHS instance', async () => {
    await seedOptimalPlan();
    solverCtl.solveHook = ({ index, instance, lp, options }) =>
      (index === 2 ? { Status: 'Infeasible', Columns: {} } : instance.solve(lp, options));

    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(getLastPlan()).toBe(plan);
    expect(getLastEvPreview()).toBeNull();
    expect(console.warn).toHaveBeenCalledWith('[calculate] EV preview solve failed:', expect.stringMatching(/Infeasible/));

    resetSolverCtl();
    await computePlan();
    expect(highsFactory).not.toHaveBeenCalled();
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
  });
});

describe('computePlan — solve log', () => {
  it('logs the solver status with every solve', async () => {
    await computePlan();

    expect(console.log).toHaveBeenCalledWith('[calculate] solve', expect.objectContaining({
      status: 'Optimal',
      slots: SLOTS,
    }));
  });
});
