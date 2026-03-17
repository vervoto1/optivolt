import { describe, it, expect } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';

describe('buildLP', () => {
  const T = 5;
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(1000),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
  };

  it('throws if arrays have mismatched lengths', () => {
    expect(() => buildLP({
      ...mockData,
      load_W: [500] // Length 1 vs 5
    })).toThrow('Arrays must have same length');
  });

  it('generates a valid LP string structure', () => {
    const lp = buildLP(mockData);
    expect(lp).toBeTypeOf('string');
    expect(lp).toContain('Minimize');
    expect(lp).toContain('Subject To');
    expect(lp).toContain('Bounds');
    expect(lp).toContain('End');
  });

  it('includes expected variables for T=5', () => {
    const lp = buildLP(mockData);
    // Check for variables at t=0 and t=4
    expect(lp).toContain('grid_to_load_0');
    expect(lp).toContain('pv_to_grid_4');
    expect(lp).toContain('soc_shortfall_0');
  });

  it('handles custom step size', () => {
    // Just checking it doesn't crash; logic verification would require parsing the coefficients
    const lp = buildLP({ ...mockData, stepSize_m: 60 });
    expect(lp).toBeTypeOf('string');
  });

  it('handles terminal SOC valuation', () => {
    const lp = buildLP({ ...mockData, terminalSocValuation: 'max' });
    expect(lp).toContain('soc_4'); // Should be in objective if valued
  });

  it('subtracts default idle drain (40 W) from SOC constraints', () => {
    const lp = buildLP(mockData);
    // Default: 40 W * 0.25 h = 10 Wh per slot
    // initialSoc default is 20% of 204800 = 40960 Wh; soc_0 RHS = 40960 - 10 = 40950
    expect(lp).toContain('c_soc_0:');
    expect(lp).toMatch(/c_soc_0:.*= 40950\b/);
    // soc_1..soc_4 RHS = -10
    expect(lp).toMatch(/c_soc_1:.*= -10\b/);
  });

  it('applies custom idle drain to SOC constraints', () => {
    const lp = buildLP({ ...mockData, idleDrain_W: 100 });
    // 100 W * 0.25 h = 25 Wh per slot
    // soc_0 RHS = 40960 - 25 = 40935
    expect(lp).toMatch(/c_soc_0:.*= 40935\b/);
    expect(lp).toMatch(/c_soc_1:.*= -25\b/);
  });

  it('produces zero RHS for SOC evolution when idle drain is 0', () => {
    const lp = buildLP({ ...mockData, idleDrain_W: 0 });
    // soc_0 RHS = 40960 (no drain)
    expect(lp).toMatch(/c_soc_0:.*= 40960\b/);
    // soc_1..soc_4 RHS = 0
    expect(lp).toMatch(/c_soc_1:.*= 0\b/);
  });

  it('gridToLoad coefficient includes avoidGridRoundTrip tiebreak', () => {
    // When importPrice is 0, the gridToLoad coefficient should still be > 0
    // due to the avoidGridRoundTrip tiebreak (5e-7), preventing degeneracy
    // when importPrice == exportPrice. Must exceed HiGHS dual_feasibility_tolerance (1e-7).
    const lp = buildLP({
      ...mockData,
      importPrice: Array(T).fill(0),
      exportPrice: Array(T).fill(0),
    });
    // With importPrice=0, gridToLoadCoeff = 0 * priceCoeff + 5e-7 = 5e-7
    // The objective should contain a positive coefficient for grid_to_load
    // (if the tiebreak were absent, gridToLoad would have coeff 0 and be omitted)
    expect(lp).toMatch(/\+ 0\.0000005\d* grid_to_load_0/);
  });
});

describe('buildLP — MILP rebalancing', () => {
  const T = 8;
  const D = 3; // hold window in slots
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(0),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    maxSoc_percent: 100,
  };

  it('does NOT include Binaries block when rebalanceRemainingSlots is 0', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 0 });
    expect(lp).not.toContain('Binaries');
    expect(lp).not.toContain('start_balance_');
  });

  it('does NOT include Binaries block when rebalanceRemainingSlots is undefined', () => {
    const lp = buildLP(mockData);
    expect(lp).not.toContain('Binaries');
    expect(lp).not.toContain('start_balance_');
  });

  it('includes a Binaries block with start_balance_k variables when D > 0', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    expect(lp).toContain('Binaries');
    // T=8, D=3 → start positions 0..5 (T-D = 5)
    for (let k = 0; k <= T - D; k++) {
      expect(lp).toContain(`start_balance_${k}`);
    }
    // No variable beyond T-D
    expect(lp).not.toContain(`start_balance_${T - D + 1}`);
  });

  it('includes exactly-one-start constraint', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    // All T-D+1 start variables must appear in c_balance_start
    expect(lp).toContain('c_balance_start:');
    expect(lp).toMatch(/c_balance_start:.*= 1/);
  });

  it('includes per-slot SoC forcing constraints referencing targetSoc_Wh', () => {
    const targetSoc_Wh = (100 / 100) * 10000; // = 10000
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    // Every slot that can be in the window should have a c_rebalance_t constraint
    expect(lp).toContain('c_rebalance_0:');
    expect(lp).toContain(`${targetSoc_Wh}`);
  });

  it('clamps D to T when rebalanceRemainingSlots > T, constraining the entire horizon', () => {
    // D = 20 > T = 8 → clamp to T=8; only one start position (k=0), whole horizon constrained
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 20, rebalanceTargetSoc_percent: 100 });
    expect(lp).toContain('Binaries');
    expect(lp).toContain('start_balance_0');
    // No start_balance_1 — only k=0 is valid when D=T
    expect(lp).not.toContain('start_balance_1');
    expect(lp).toContain('c_balance_start: start_balance_0 = 1');
  });

  it('truncates fractional rebalanceRemainingSlots to integer', () => {
    // 2.9 should be treated as 2, not 3
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 2.9, rebalanceTargetSoc_percent: 100 });
    // With D=2, T=8: start positions 0..6 (T-D=6)
    expect(lp).toContain('start_balance_6');
    expect(lp).not.toContain('start_balance_7'); // would only exist if D were treated as 1
  });

  it('clamps rebalanceTargetSoc_percent to maxSoc_percent to prevent infeasible models', () => {
    // If target exceeds max, model would be infeasible (soc_t >= targetSoc > maxSoc_Wh upper bound).
    // Clamping ensures the forced target == max bound.
    const targetAboveMax = 120; // > maxSoc_percent=100
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: targetAboveMax });
    // The actual Wh coefficient in constraints must be based on maxSoc_percent (100%), not 120%
    const expectedTargetSoc_Wh = (100 / 100) * 10000; // = 10000
    expect(lp).toContain(`${expectedTargetSoc_Wh} start_balance_`);
    // Should NOT contain the unclamped 12000 (120% of 10000)
    expect(lp).not.toContain('12000 start_balance_');
  });
});

describe('buildLP — EV charging', () => {
  const T = 4;
  const mockData = {
    load_W: [500, 500, 500, 500],
    pv_W: Array(T).fill(1000),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
  };

  it('includes evLoad in load balance constraint', () => {
    const lp = buildLP({ ...mockData, evLoad_W: [0, 0, 11000, 11000] });
    // Slot 2: 500 + 11000 = 11500
    expect(lp).toMatch(/c_load_2:.*= 11500\b/);
    // Slot 0: no EV load, just 500
    expect(lp).toMatch(/c_load_0:.*= 500\b/);
  });

  it('constrains battery discharge to 0 when EV is charging and disableDischargeWhileEvCharging is true', () => {
    const lp = buildLP({ ...mockData, evLoad_W: [0, 0, 11000, 0], disableDischargeWhileEvCharging: true });
    // Slot 2 (EV active): battery_to_load_2 and battery_to_grid_2 upper bound = 0
    expect(lp).toMatch(/0 <= battery_to_load_2 <= 0\b/);
    expect(lp).toMatch(/0 <= battery_to_grid_2 <= 0\b/);
    // Slot 0 (no EV): battery_to_load_0 and battery_to_grid_0 should have non-zero upper bounds
    expect(lp).toMatch(/0 <= battery_to_load_0 <= [1-9]/);
    expect(lp).toMatch(/0 <= battery_to_grid_0 <= [1-9]/);
  });

  it('produces identical LP when evLoad_W is undefined', () => {
    const baselineLP = buildLP(mockData);
    const withUndefinedLP = buildLP({ ...mockData, evLoad_W: undefined });
    expect(withUndefinedLP).toBe(baselineLP);
  });
});

describe('buildLP — CV phase', () => {
  const T = 4;
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(0),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    maxSoc_percent: 100,
    maxChargePower_W: 5000,
    initialSoc_percent: 90,
  };

  const twoThresholds = [
    { soc_percent: 95, maxChargePower_W: 3000 },
    { soc_percent: 97, maxChargePower_W: 1000 },
  ];

  it('does NOT include cv_ variables when cvPhaseThresholds is undefined', () => {
    const lp = buildLP(mockData);
    expect(lp).not.toContain('cv_');
  });

  it('does NOT include cv_ variables when cvPhaseThresholds is empty', () => {
    const lp = buildLP({ ...mockData, cvPhaseThresholds: [] });
    expect(lp).not.toContain('cv_');
  });

  it('generates cv_ binaries for each threshold and slot', () => {
    const lp = buildLP({ ...mockData, cvPhaseThresholds: twoThresholds });
    expect(lp).toContain('Binaries');
    // 2 thresholds × 4 slots = 8 binaries
    for (let k = 0; k < 2; k++) {
      for (let t = 0; t < T; t++) {
        expect(lp).toContain(`cv_${k}_${t}`);
      }
    }
  });

  it('modifies charge constraint with CV power step terms', () => {
    const lp = buildLP({ ...mockData, cvPhaseThresholds: twoThresholds });
    // power step 0: 5000 - 3000 = 2000
    // power step 1: 3000 - 1000 = 2000
    expect(lp).toMatch(/c_charge_cap_0:.*\+ 2000 cv_0_0.*\+ 2000 cv_1_0 <= 5000/);
  });

  it('generates big-M forcing constraints referencing SoC thresholds', () => {
    const lp = buildLP({ ...mockData, cvPhaseThresholds: twoThresholds });
    // threshold 0: 95% of 10000 = 9500 Wh
    // threshold 1: 97% of 10000 = 9700 Wh
    // M = maxSoc_Wh = 10000
    expect(lp).toContain('c_cv_0_0:');
    expect(lp).toContain('c_cv_1_0:');
    // Slot t>0 should reference soc_{t-1}
    expect(lp).toMatch(/c_cv_0_1:.*soc_0/);
    expect(lp).toMatch(/c_cv_0_1:.*<= 9500/);
  });

  it('slot 0 uses initialSoc_Wh constant (not soc variable) in big-M constraint', () => {
    // initialSoc_percent = 90, capacity = 10000, so initialSoc_Wh = 9000
    const lp = buildLP({ ...mockData, cvPhaseThresholds: twoThresholds });
    // c_cv_0_0 should contain the constant 9000, not a soc_ variable
    expect(lp).toMatch(/c_cv_0_0: 9000/);
    expect(lp).not.toMatch(/c_cv_0_0:.*soc_/);
  });

  it('works with a single threshold', () => {
    const lp = buildLP({ ...mockData, cvPhaseThresholds: [twoThresholds[0]] });
    expect(lp).toContain('cv_0_0');
    expect(lp).not.toContain('cv_1_0');
    // power step: 5000 - 3000 = 2000
    expect(lp).toMatch(/c_charge_cap_0:.*\+ 2000 cv_0_0 <= 5000/);
  });

  it('produces identical LP when cvPhaseThresholds is undefined vs absent', () => {
    const baselineLP = buildLP(mockData);
    const withUndefinedLP = buildLP({ ...mockData, cvPhaseThresholds: undefined });
    expect(withUndefinedLP).toBe(baselineLP);
  });
});
