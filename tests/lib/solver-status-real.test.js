import { describe, it, expect, beforeAll } from 'vitest';
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, SolverStatusError } from '../../lib/parse-solution.ts';
import { solveOptionsFor } from '../../lib/solve-options.ts';

// Real-solver checks of the shapes the vendored HiGHS returns on an early stop,
// and that parseSolution handles each one. Real timers on purpose: under
// frozen clocks a tiny positive time_limit no longer stops, but 0 always does.
const T = 48;
const cfg = {
  load_W: Array(T).fill(800),
  pv_W: Array.from({ length: T }, (_, t) => (t > 16 && t < 36 ? 5000 : 0)),
  importPrice: Array.from({ length: T }, (_, t) => 20 + 15 * Math.sin(t / 7)),
  exportPrice: Array.from({ length: T }, (_, t) => 8 + 15 * Math.sin(t / 7)),
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
  inverterEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  initialSoc_percent: 50,
  rebalanceRemainingSlots: 4,
  rebalanceTargetSoc_percent: 100,
  ev: {
    evMinChargePower_W: 1380,
    evMaxChargePower_W: 11040,
    evBatteryCapacity_Wh: 60000,
    evInitialSoc_percent: 50,
    evTargetSoc_percent: 80,
    evDepartureSlot: 40,
    evChargeEfficiency_percent: 90,
    evChargePhases: 3,
    evContinuous: true,
  },
};
const timing = { startMs: Date.UTC(2024, 0, 1), stepMin: 15 };

describe('parseSolution against real HiGHS early stops', () => {
  let highs;
  let lp;
  let optimal;

  beforeAll(async () => {
    highs = await highsFactory({});
    lp = buildLP(cfg);
    optimal = highs.solve(lp, solveOptionsFor(cfg));
  });

  it('time_limit 0: no incumbent (Infinity objective, all-zero primals) is a SolverStatusError, and the instance still solves Optimal afterwards', () => {
    expect(optimal.Status).toBe('Optimal');

    const stopped = highs.solve(lp, { ...solveOptionsFor(cfg), time_limit: 0 });
    expect(stopped.Status).toBe('Time limit reached');
    expect(stopped.ObjectiveValue).toBe(Infinity);
    const primals = Object.values(stopped.Columns).map(c => c.Primal);
    expect(primals.length).toBeGreaterThan(0);
    expect(primals.every(v => v === 0)).toBe(true);
    expect(() => parseSolution(stopped, cfg, timing)).toThrow(SolverStatusError);

    // A time-limit stop does not throw or poison the instance.
    const again = highs.solve(lp, solveOptionsFor(cfg));
    expect(again.Status).toBe('Optimal');
    expect(again.ObjectiveValue).toBeCloseTo(optimal.ObjectiveValue, 6);
    expect(parseSolution(again, cfg, timing)).toHaveLength(T);
  });

  it('objective_target 1e12: an early stop with a finite (worse) incumbent parses into rows', () => {
    const early = highs.solve(lp, { ...solveOptionsFor(cfg), objective_target: 1e12 });
    expect(early.Status).toBe('Target for objective reached');
    expect(Number.isFinite(early.ObjectiveValue)).toBe(true);
    expect(early.ObjectiveValue).toBeGreaterThanOrEqual(optimal.ObjectiveValue);

    const rows = parseSolution(early, cfg, timing);
    expect(rows).toHaveLength(T);
    expect(rows.every(r => Number.isFinite(r.soc_percent))).toBe(true);
  });
});
