import { describe, it, expect } from 'vitest';
import { parseSolution, SolverStatusError } from '../../lib/parse-solution.ts';

describe('parseSolution', () => {
  // η_inv = 100 keeps the legacy lossless behavior so the numeric assertions
  // below ("rows[0].pv2l === 100", "exportCost_cents === 2.5") match without
  // accounting for AC↔DC inverter loss. Tests that exercise the inverter
  // efficiency path live in build-lp-inverter-efficiency.test.js.
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
    inverterEfficiency_percent: 100,
  };

  const opts = {
    startMs: 1700000000000,
    stepMin: 60,
  };

  it('correctly parses HiGHS columns into rows', () => {
    const result = {
      Status: 'Optimal',
      Columns: {
        'grid_to_load_0': { Primal: 400 },
        'pv_to_load_0': { Primal: 100 },
        'pv_curtail_0': { Primal: 250 },
        'grid_to_load_1': { Primal: 600 },
        'soc_0': { Primal: 200 },
        'soc_1': { Primal: 200 },
      },
    };

    const rows = parseSolution(result, cfg, opts);

    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
    expect(rows[0].pv2l).toBe(100);
    expect(rows[0].pvCurtail).toBe(250);
    expect(rows[1].g2l).toBe(600);
    expect(rows[0].soc).toBe(200);
    expect(rows[0].soc_percent).toBe(20);
    expect(rows[0].timestampMs).toBe(1700000000000);
    expect(rows[1].timestampMs).toBe(1700000000000 + 3600000);
  });

  it('handles null/missing Columns gracefully (line 36: Columns ?? {})', () => {
    // Line 36: `Object.entries(result.Columns ?? {})` — null Columns → empty entries
    const result = { Status: 'Optimal', Columns: null };
    const rows = parseSolution(result, cfg, opts);
    expect(rows).toHaveLength(2);
    // All flows should be 0
    expect(rows[0].g2l).toBe(0);
    expect(rows[0].soc).toBe(0);
  });

  it('skips columns with out-of-range index (line 40: t < 0 || t >= T)', () => {
    // Line 40: `if (t == null || t < 0 || t >= T) continue`
    const result = {
      Status: 'Optimal',
      Columns: {
        'grid_to_load_99': { Primal: 999 }, // t=99 >= T=2 → skipped
        'grid_to_load_0': { Primal: 200 },
      },
    };
    const rows = parseSolution(result, cfg, opts);
    expect(rows[0].g2l).toBe(200);
    // t=99 was skipped, so no rows[99]
    expect(rows).toHaveLength(2);
  });

  it('uses 0 when Primal is undefined (line 91: Primal ?? 0)', () => {
    // Line 91 (valueOf): `col.Primal ?? 0`
    const result = {
      Status: 'Optimal',
      Columns: {
        'grid_to_load_0': {}, // no Primal field
      },
    };
    const rows = parseSolution(result, cfg, opts);
    expect(rows[0].g2l).toBe(0);
  });

  it('includes evLoad in PlanRow from cfg.evLoad_W', () => {
    const cfgWithEv = {
      load_W: [100, 100, 100, 100],
      pv_W: [0, 0, 0, 0],
      importPrice: [10, 10, 10, 10],
      exportPrice: [5, 5, 5, 5],
      batteryCapacity_Wh: 1000,
      evLoad_W: [0, 500, 11000, 0],
    };

    const result = {
      Status: 'Optimal',
      Columns: {
        'soc_0': { Primal: 500 },
        'soc_1': { Primal: 500 },
        'soc_2': { Primal: 500 },
        'soc_3': { Primal: 500 },
      },
    };

    const rows = parseSolution(result, cfgWithEv, { startMs: 1700000000000, stepMin: 15 });

    expect(rows).toHaveLength(4);
    expect(rows[0].evLoad).toBe(0);
    expect(rows[1].evLoad).toBe(500);
    expect(rows[2].evLoad).toBe(11000);
    expect(rows[3].evLoad).toBe(0);
  });

  it('computes per-slot import and export costs', () => {
    const result = {
      Status: 'Optimal',
      Columns: {
        'grid_to_load_0': { Primal: 1000 },
        'pv_to_grid_0': { Primal: 500 },
        'grid_to_battery_1': { Primal: 500 },
        'battery_to_grid_1': { Primal: 1000 },
      },
    };
    const cfgWithSignedExport = {
      ...cfg,
      exportPrice: [5, -2],
      inverterEfficiency_percent: 100,
    };

    const rows = parseSolution(result, cfgWithSignedExport, opts);

    expect(rows[0].importCost_cents).toBeCloseTo(10);
    expect(rows[0].exportCost_cents).toBeCloseTo(2.5);
    expect(rows[1].importCost_cents).toBeCloseTo(10);
    expect(rows[1].exportCost_cents).toBeCloseTo(-2);
  });

});

describe('parseSolution — ev_charge_A phase conversion', () => {
  const baseEv = {
    evMinChargePower_W: 0,
    evMaxChargePower_W: 11040,
    evBatteryCapacity_Wh: 60000,
    evInitialSoc_percent: 50,
    evTargetSoc_percent: 80,
    evDepartureSlot: 4,
  };
  const opts = { startMs: 1700000000000, stepMin: 15 };
  // grid_to_ev is AC into the charger, so ev_charge ≈ g2ev (no inverter factor).
  const result = {
    Status: 'Optimal',
    Columns: {
      'grid_to_ev_0': { Primal: 3450 }, // 15 A single-phase, or 5 A three-phase
      'ev_soc_0':     { Primal: 30000 },
    },
  };

  it('single-phase: 3450 W → 15 A (default when phases unset)', () => {
    const cfg = { load_W: [500], pv_W: [0], importPrice: [10], exportPrice: [5], batteryCapacity_Wh: 1000, ev: baseEv };
    const [row] = parseSolution(result, cfg, opts);
    expect(row.ev_charge_A).toBeCloseTo(15, 3);
  });

  it('three-phase: 3450 W → 5 A (÷ 230 × 3)', () => {
    const cfg = { load_W: [500], pv_W: [0], importPrice: [10], exportPrice: [5], batteryCapacity_Wh: 1000, ev: { ...baseEv, evChargePhases: 3 } };
    const [row] = parseSolution(result, cfg, opts);
    expect(row.ev_charge_A).toBeCloseTo(5, 3);
  });
});

describe('parseSolution — ev_charge_mode derivation', () => {
  const evCfg = {
    load_W: [500],
    pv_W: [300],
    importPrice: [10],
    exportPrice: [5],
    batteryCapacity_Wh: 1000,
    ev: {
      evMinChargePower_W: 1380,
      evMaxChargePower_W: 3680,
      evBatteryCapacity_Wh: 60000,
      evInitialSoc_percent: 50,
      evTargetSoc_percent: 80,
      evDepartureSlot: 4,
    },
  };
  const opts = { startMs: 1700000000000, stepMin: 15 };

  function makeResult(g2ev, pv2ev, b2ev, pv2b = 0) {
    return {
      Status: 'Optimal',
      Columns: {
        'grid_to_ev_0':    { Primal: g2ev },
        'pv_to_ev_0':      { Primal: pv2ev },
        'battery_to_ev_0': { Primal: b2ev },
        'pv_to_battery_0': { Primal: pv2b },
        'ev_soc_0':        { Primal: 30000 },
      },
    };
  }

  it('off — no EV flows', () => {
    const [row] = parseSolution(makeResult(0, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('off');
  });

  it('fixed — grid only at minimum charge rate', () => {
    const [row] = parseSolution(makeResult(1380, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV + tiny grid at minimum charge rate', () => {
    // Solver tops up minimum with a small grid contribution
    const [row] = parseSolution(makeResult(200, 1180, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('solar_grid — grid only, above minimum (same mode as PV+grid)', () => {
    const [row] = parseSolution(makeResult(2000, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_grid');
  });

  it('solar_only — PV only, no grid or battery', () => {
    const [row] = parseSolution(makeResult(0, 2000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_only');
  });

  it('solar_grid — PV + grid above minimum, no battery', () => {
    const [row] = parseSolution(makeResult(1000, 1000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_grid');
  });

  // The PV and battery legs are reported AC-side (scaled by eta_inv, 95% by default), so
  // these charger-ceiling cases pin efficiency to 100% to keep the watt arithmetic direct.
  const losslessCfg = { ...evCfg, inverterEfficiency_percent: 100 };

  it('max — battery involved at configured charger maximum (+ grid + PV)', () => {
    const [row] = parseSolution(makeResult(1000, 500, 2180), losslessCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('max — battery only, at configured charger maximum', () => {
    const [row] = parseSolution(makeResult(0, 0, 3680), losslessCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('fixed — battery assists a partial planned rate below charger maximum', () => {
    const cfg = {
      ...losslessCfg,
      ev: { ...evCfg.ev, evMinChargePower_W: 1840, evMaxChargePower_W: 5750 }, // 8 A .. 25 A
    };
    // 1200 W PV + 1468 W battery = 2668 W = 11.6 A, well below the 25 A ceiling. Even
    // though the battery is a limiting source, HA can reproduce the plan with exact amps;
    // telling it "max" would charge at 25 A and blow past the planned rate.
    const [row] = parseSolution(makeResult(0, 1200, 1468), cfg, opts);
    expect(row.ev_charge_A).toBeCloseTo(11.6, 1);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — battery assist with no configured charger maximum', () => {
    const cfg = { ...losslessCfg, ev: { ...evCfg.ev, evMaxChargePower_W: 0 } };
    const [row] = parseSolution(makeResult(0, 1000, 1000), cfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — battery tops up to reach minimum charge rate (not max)', () => {
    // PV delivers 1150W, battery chips in 230W to reach 1380W minimum; not "max" speed
    const [row] = parseSolution(makeResult(0, 1150, 230), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV to EV and PV to battery simultaneously (split PV)', () => {
    // Solver splits PV between EV and house battery; solar tracking would conflict
    const [row] = parseSolution(makeResult(0, 2000, 0, 500), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV + grid to EV with PV also going to battery', () => {
    const [row] = parseSolution(makeResult(500, 1000, 0, 800), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('solar_only — PV only to EV, no competing battery sink', () => {
    const [row] = parseSolution(makeResult(0, 2000, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_only');
  });
});

describe('parseSolution — solver status guard', () => {
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
    inverterEfficiency_percent: 100,
  };
  const opts = { startMs: 1700000000000, stepMin: 60 };
  const columns = {
    'grid_to_load_0': { Primal: 400 },
    'pv_to_load_0': { Primal: 100 },
    'grid_to_load_1': { Primal: 600 },
    'soc_0': { Primal: 200 },
    'soc_1': { Primal: 200 },
  };
  // The exact shape the vendored HiGHS 1.15.1 returns for a time limit hit
  // before any incumbent: every column present with Primal 0, objective Infinity.
  const allZeroColumns = Object.fromEntries(Object.keys(columns).map(name => [name, { Primal: 0 }]));

  it('throws a SolverStatusError naming the status for an infeasible solve', () => {
    const result = { Status: 'Infeasible', Columns: {} };
    expect(() => parseSolution(result, cfg, opts)).toThrow(SolverStatusError);
    expect(() => parseSolution(result, cfg, opts)).toThrow(/no usable solution.*"Infeasible"/);
    let caught;
    try {
      parseSolution(result, cfg, opts);
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe('Infeasible');
    expect(caught.name).toBe('SolverStatusError');
  });

  it('throws for an infeasible-or-unbounded and an unbounded solve', () => {
    expect(() => parseSolution({ Status: 'Primal infeasible or unbounded', Columns: {} }, cfg, opts))
      .toThrow(/Primal infeasible or unbounded/);
    expect(() => parseSolution({ Status: 'Unbounded', Columns: {} }, cfg, opts)).toThrow(SolverStatusError);
  });

  it('throws for an "Unknown" status, even with a finite objective and no primal values', () => {
    expect(() => parseSolution({ Status: 'Unknown', Columns: columns }, cfg, opts)).toThrow(/Unknown/);
    // mip_max_improving_sols-style stop: finite objective, columns without Primal.
    const noPrimal = Object.fromEntries(Object.keys(columns).map(name => [name, {}]));
    expect(() => parseSolution({ Status: 'Unknown', ObjectiveValue: 77562.9, Columns: noPrimal }, cfg, opts))
      .toThrow(SolverStatusError);
  });

  it('throws when the status is missing entirely', () => {
    expect(() => parseSolution({ ObjectiveValue: 1, Columns: columns }, cfg, opts)).toThrow(/"missing"/);
  });

  it('throws for "Time limit reached" with an Infinity objective and all-zero primals (no incumbent)', () => {
    // A verbatim upstream port (soc_* finiteness only) would accept this: zeros are finite.
    const result = { Status: 'Time limit reached', ObjectiveValue: Infinity, Columns: allZeroColumns };
    expect(() => parseSolution(result, cfg, opts)).toThrow(SolverStatusError);
    expect(() => parseSolution(result, cfg, opts)).toThrow(/without a feasible incumbent.*Time limit reached/);
  });

  it('throws for an early stop whose objective is missing or NaN', () => {
    expect(() => parseSolution({ Status: 'Time limit reached', Columns: columns }, cfg, opts)).toThrow(SolverStatusError);
    expect(() => parseSolution({ Status: 'Iteration limit reached', ObjectiveValue: NaN, Columns: columns }, cfg, opts))
      .toThrow(SolverStatusError);
  });

  it('throws for an early stop with a finite objective but a missing or non-finite soc primal', () => {
    const missingSoc = { ...columns };
    delete missingSoc.soc_1;
    expect(() => parseSolution({ Status: 'Time limit reached', ObjectiveValue: 5, Columns: missingSoc }, cfg, opts))
      .toThrow(SolverStatusError);
    expect(() => parseSolution({
      Status: 'Time limit reached', ObjectiveValue: 5, Columns: { ...columns, soc_0: { Primal: Infinity } },
    }, cfg, opts)).toThrow(SolverStatusError);
  });

  it('parses a feasible incumbent under an early-stop status (finite objective and soc primals)', () => {
    for (const Status of ['Time limit reached', 'Iteration limit reached', 'Bound on objective reached', 'Target for objective reached']) {
      const rows = parseSolution({ Status, ObjectiveValue: 12.5, Columns: columns }, cfg, opts);
      expect(rows).toHaveLength(2);
      expect(rows[0].soc).toBe(200);
      expect(rows[0].g2l).toBe(400);
    }
  });

  it('parses an Optimal result unchanged, without requiring an objective value', () => {
    const rows = parseSolution({ Status: 'Optimal', Columns: columns }, cfg, opts);
    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
    expect(rows[1].g2l).toBe(600);
  });
});
