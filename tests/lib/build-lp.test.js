import { describe, it, expect } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';

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

  it('terminal SoC valuation "min" uses the minimum import price in the objective', () => {
    const lp = buildLP({ ...mockData, importPrice: [10, 5, 20, 15, 8], terminalSocValuation: 'min' });
    // min price = 5 c/kWh, terminalPrice_cents_per_Wh = 5/1000 * (95/100) = 0.00475
    // The objective should subtract the terminal soc variable
    expect(lp).toContain(`soc_${T - 1}`);
    expect(lp).toMatch(/- \S+ soc_4/);
  });

  it('terminal SoC valuation "avg" uses the average import price in the objective', () => {
    const prices = [10, 20, 30, 40, 50];
    const lp = buildLP({ ...mockData, importPrice: prices, terminalSocValuation: 'avg' });
    // avg = 30 c/kWh → terminalPrice > 0 → objective subtracts soc_4
    expect(lp).toMatch(/- \S+ soc_4/);
  });

  it('terminal SoC valuation "zero" does not subtract soc from objective', () => {
    const lp = buildLP({ ...mockData, terminalSocValuation: 'zero' });
    // terminalPrice = 0 → no terminal term in objective
    expect(lp).not.toMatch(/- \S+ soc_4/);
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

  it('CV phase generates both forward and reverse constraints', () => {
    const lp = buildLP({
      ...mockData,
      cvPhaseThresholds: [{ soc_percent: 95, maxChargePower_W: 9360 }],
    });
    // Forward constraint for slot 1 (k=0, t=1)
    expect(lp).toContain('c_cv_0_1:');
    // Reverse constraint for slot 1 (k=0, t=1)
    expect(lp).toContain('c_cv_rev_0_1:');
    // Slot 1's start-of-slot SoC is soc_0 (the previous slot's SoC variable)
    expect(lp).toMatch(/c_cv_0_1:.*soc_0/);
    expect(lp).toMatch(/c_cv_rev_0_1:.*soc_0/);
  });
});

describe('buildLP — discharge phase', () => {
  const T = 4;
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(0),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxDischargePower_W: 5000,
    initialSoc_percent: 50,
  };

  const twoThresholds = [
    { soc_percent: 30, maxDischargePower_W: 3000 },
    { soc_percent: 20, maxDischargePower_W: 1000 },
  ];

  it('does NOT include dp_ variables when dischargePhaseThresholds is undefined', () => {
    const lp = buildLP(mockData);
    expect(lp).not.toContain('dp_');
  });

  it('does NOT include dp_ variables when dischargePhaseThresholds is empty', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: [] });
    expect(lp).not.toContain('dp_');
  });

  it('generates dp_ binaries for each threshold and slot', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    expect(lp).toContain('Binaries');
    // 2 thresholds x 4 slots = 8 binaries
    for (let k = 0; k < 2; k++) {
      for (let t = 0; t < T; t++) {
        expect(lp).toContain(`dp_${k}_${t}`);
      }
    }
  });

  it('modifies discharge constraint with power step terms', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // power step 0: 5000 - 3000 = 2000
    // power step 1: 3000 - 1000 = 2000
    expect(lp).toMatch(/c_discharge_cap_0:.*\+ 2000 dp_0_0.*\+ 2000 dp_1_0 <= 5000/);
  });

  it('generates big-M forcing constraints referencing SoC thresholds', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // threshold 0: 30% of 10000 = 3000 Wh
    // threshold 1: 20% of 10000 = 2000 Wh
    expect(lp).toContain('c_dp_0_0:');
    expect(lp).toContain('c_dp_1_0:');
    // Slot t>0 should reference soc_{t-1}
    expect(lp).toMatch(/c_dp_0_1:.*soc_0/);
  });

  it('slot 0 uses initialSoc_Wh constant (not soc variable) in big-M constraint', () => {
    // initialSoc_percent = 50, capacity = 10000, so initialSoc_Wh = 5000
    // threshold 0: 30% = 3000 Wh
    // Forward: -tightM * dp <= initialSoc - threshold = 5000 - 3000 = 2000
    // tightM = threshold - minSoc = 3000 - 1000 = 2000
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // c_dp_0_0 should NOT contain soc_ variable
    expect(lp).not.toMatch(/c_dp_0_0:.*soc_/);
    // Forward constraint for slot 0: -2000 dp_0_0 <= 2000
    expect(lp).toMatch(/c_dp_0_0: -2000 dp_0_0 <= 2000/);
  });

  it('generates reverse constraints for slot 0 with initialSoc constant', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // Reverse for k=0: revM = maxSoc - threshold = 10000 - 3000 = 7000
    // 7000 * dp <= maxSoc - initialSoc = 10000 - 5000 = 5000
    expect(lp).toMatch(/c_dp_rev_0_0: 7000 dp_0_0 <= 5000/);
  });

  it('generates forward and reverse constraints for slot t>0', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // Forward for k=0, t=1: -soc_0 - tightM * dp <= -threshold
    // tightM = 3000 - 1000 = 2000, threshold = 3000
    expect(lp).toMatch(/c_dp_0_1: - soc_0 - 2000 dp_0_1 <= -3000/);
    // Reverse for k=0, t=1: revM * dp + soc_{t-1} <= maxSoc
    // revM = 10000 - 3000 = 7000
    expect(lp).toMatch(/c_dp_rev_0_1: 7000 dp_0_1 \+ soc_0 <= 10000/);
  });

  it('works with a single threshold', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: [twoThresholds[0]] });
    expect(lp).toContain('dp_0_0');
    expect(lp).not.toContain('dp_1_0');
    // power step: 5000 - 3000 = 2000
    expect(lp).toMatch(/c_discharge_cap_0:.*\+ 2000 dp_0_0 <= 5000/);
  });

  it('works with multiple thresholds', () => {
    const lp = buildLP({ ...mockData, dischargePhaseThresholds: twoThresholds });
    // Both thresholds should appear in discharge cap
    expect(lp).toMatch(/c_discharge_cap_0:.*dp_0_0.*dp_1_0/);
    // Both thresholds should have big-M constraints
    expect(lp).toContain('c_dp_0_0:');
    expect(lp).toContain('c_dp_1_0:');
    expect(lp).toContain('c_dp_rev_0_0:');
    expect(lp).toContain('c_dp_rev_1_0:');
  });

  it('produces identical LP when dischargePhaseThresholds is undefined vs absent', () => {
    const baselineLP = buildLP(mockData);
    const withUndefinedLP = buildLP({ ...mockData, dischargePhaseThresholds: undefined });
    expect(withUndefinedLP).toBe(baselineLP);
  });

  it('works alongside cvPhaseThresholds simultaneously', () => {
    const lp = buildLP({
      ...mockData,
      cvPhaseThresholds: [{ soc_percent: 95, maxChargePower_W: 3000 }],
      dischargePhaseThresholds: [{ soc_percent: 30, maxDischargePower_W: 3000 }],
      maxChargePower_W: 5000,
    });
    // Both cv and dp binaries should exist
    expect(lp).toContain('cv_0_0');
    expect(lp).toContain('dp_0_0');
    // Charge cap has cv terms
    expect(lp).toMatch(/c_charge_cap_0:.*cv_0_0/);
    // Discharge cap has dp terms
    expect(lp).toMatch(/c_discharge_cap_0:.*dp_0_0/);
    // Both have big-M constraints
    expect(lp).toContain('c_cv_0_0:');
    expect(lp).toContain('c_dp_0_0:');
  });
});

describe('buildLP — zero-coefficient objective terms', () => {
  // Lines 135-140: the `if (coeff !== 0)` guards skip adding terms when coeff is exactly 0.
  // With importPrice=0, exportPrice=0, batteryCost=0, tiebreaks non-zero, most coeffs stay.
  // To get batteryToLoad coeff = 0 we need batteryCost=0 (already default).
  // batteryToGridCoeff = -exportCoeff + batteryCost. With exportPrice=0 and batteryCost=0,
  // batteryToGridCoeff = 0 → the batteryToGrid variable is omitted from the objective.
  it('omits batteryToGrid from objective when its coefficient is exactly zero', () => {
    const T = 2;
    const lp = buildLP({
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(0),
      importPrice: Array(T).fill(0),
      exportPrice: Array(T).fill(0),
      batteryCost_cent_per_kWh: 0,
      terminalSocValuation: 'zero',
    });
    // batteryToGridCoeff = -0 + 0 = 0 → not added
    // batteryToLoadCoeff = 0 → not added
    // pvToBatteryCoeff = 0 → not added
    // pvToGridCoeff = -0 + avoidExport tiebreak (non-zero) → still included
    expect(lp).not.toMatch(/\+ 0 battery_to_grid_/);
    expect(lp).not.toMatch(/\+ 0 battery_to_load_/);
    expect(lp).not.toMatch(/\+ 0 pv_to_battery_/);
  });
});

describe('buildLP — terminal SoC valuation "custom"', () => {
  // Line 286: if (mode === "custom") return customPrice_cents_per_kWh
  it('uses custom price when terminalSocValuation is "custom"', () => {
    const T = 3;
    const lp = buildLP({
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(0),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 20,
    });
    // custom price 20 > 0 → subtracts soc_{T-1} from objective
    expect(lp).toMatch(/- \S+ soc_2/);
  });

  it('omits terminal soc term when custom price is zero', () => {
    const T = 3;
    const lp = buildLP({
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(0),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 0,
    });
    expect(lp).not.toMatch(/- \S+ soc_2/);
  });
});

describe('buildLP — rebalance slot skip (line 225)', () => {
  // Line 225: `if (kLow > kHigh) continue` — skips slots that fall outside
  // any valid rebalance start window. With D=2 and T=4, slot 0 can only be
  // covered by start positions k=0 (kLow=0, kHigh=0). Slots beyond T-D have
  // no valid k and are skipped.
  it('does not generate c_rebalance_ for slots beyond T-D with D=T (only k=0 possible)', () => {
    // D=4 clamped to T=4 means kLow=max(0,t-3), kHigh=min(t,0)
    // For t=1: kLow=max(0,-2)=0, kHigh=min(1,0)=0 → valid
    // For t=3: kLow=max(0,0)=0, kHigh=min(3,0)=0 → valid
    // All slots should get c_rebalance_ when D=T
    const T = 4;
    const lp = buildLP({
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(0),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
      batteryCapacity_Wh: 10000,
      maxSoc_percent: 100,
      rebalanceRemainingSlots: T,
      rebalanceTargetSoc_percent: 80,
    });
    // D = T = 4, only start_balance_0 should exist
    expect(lp).toContain('c_rebalance_0:');
    expect(lp).toContain('c_rebalance_3:');
  });
});

describe('buildPlanSummary — empty rows', () => {
  const cfg = { stepSize_m: 15 };

  it('returns all zero energy totals when rows is empty', () => {
    const summary = buildPlanSummary([], cfg);
    expect(summary.loadTotal_kWh).toBe(0);
    expect(summary.pvTotal_kWh).toBe(0);
    expect(summary.evLoadTotal_kWh).toBe(0);
    expect(summary.loadFromGrid_kWh).toBe(0);
    expect(summary.loadFromBattery_kWh).toBe(0);
    expect(summary.loadFromPv_kWh).toBe(0);
    expect(summary.gridToBattery_kWh).toBe(0);
    expect(summary.batteryToGrid_kWh).toBe(0);
    expect(summary.importEnergy_kWh).toBe(0);
  });

  it('returns null avgImportPrice when rows is empty', () => {
    const summary = buildPlanSummary([], cfg);
    expect(summary.avgImportPrice_cents_per_kWh).toBeNull();
  });

  it('returns null tipping points when rows is empty and no diagnostics provided', () => {
    const summary = buildPlanSummary([], cfg);
    expect(summary.gridBatteryTippingPoint_cents_per_kWh).toBeNull();
    expect(summary.gridChargeTippingPoint_cents_per_kWh).toBeNull();
    expect(summary.batteryExportTippingPoint_cents_per_kWh).toBeNull();
    expect(summary.pvExportTippingPoint_cents_per_kWh).toBeNull();
  });

  it('returns rebalanceStatus "disabled" when no rebalance config provided', () => {
    const summary = buildPlanSummary([], cfg);
    expect(summary.rebalanceStatus).toBe('disabled');
  });
});

describe('buildPlanSummary — stepSize_m edge cases (line 47)', () => {
  // Line 47: `Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes / 60 : 0.25`
  // Falls back to 0.25 when stepSize_m is undefined, 0, or non-finite.
  const row = {
    load: 1000, pv: 0, evLoad: 0,
    g2l: 1000, b2l: 0, pv2l: 0,
    g2b: 0, b2g: 0,
    imp: 1000, exp: 0,
    ic: 20, ec: 5,
    soc: 5000, soc_percent: 50,
  };

  it('falls back to 0.25 h step when stepSize_m is undefined', () => {
    const s1 = buildPlanSummary([row], {});           // stepSize_m undefined
    const s2 = buildPlanSummary([row], { stepSize_m: 15 }); // 0.25 h
    expect(s1.loadTotal_kWh).toBeCloseTo(s2.loadTotal_kWh, 6);
  });

  it('falls back to 0.25 h step when stepSize_m is 0', () => {
    const s1 = buildPlanSummary([row], { stepSize_m: 0 });
    const s2 = buildPlanSummary([row], { stepSize_m: 15 });
    expect(s1.loadTotal_kWh).toBeCloseTo(s2.loadTotal_kWh, 6);
  });

  it('falls back to 0.25 h step when stepSize_m is Infinity', () => {
    const s1 = buildPlanSummary([row], { stepSize_m: Infinity });
    const s2 = buildPlanSummary([row], { stepSize_m: 15 });
    expect(s1.loadTotal_kWh).toBeCloseTo(s2.loadTotal_kWh, 6);
  });

  it('uses 60 min step correctly', () => {
    const s = buildPlanSummary([row], { stepSize_m: 60 });
    // 1000 W * 1 h / 1000 = 1 kWh
    expect(s.loadTotal_kWh).toBeCloseTo(1.0, 6);
  });
});

describe('buildPlanSummary — non-finite tipping points (lines 102, 114)', () => {
  // Lines 102, 114: `Number.isFinite(x) ? x : null` — Infinity/-Infinity → null
  // Need non-empty rows so the early return at line 21 is skipped
  const cfg = { stepSize_m: 15 };
  const row = { g2l: 100, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0, soc: 50, soc_percent: 50, load: 100, pv: 0, ic: 10, ec: 5 };

  it('returns null for non-finite gridBatteryTippingPoint', () => {
    const s = buildPlanSummary([row], cfg, {
      gridBatteryTippingPoint_cents_per_kWh: Infinity,
      gridChargeTippingPoint_cents_per_kWh: -Infinity,
      batteryExportTippingPoint_cents_per_kWh: 5,
      pvExportTippingPoint_cents_per_kWh: 3,
    });
    expect(s.gridBatteryTippingPoint_cents_per_kWh).toBeNull();
    expect(s.gridChargeTippingPoint_cents_per_kWh).toBeNull();
  });

  it('returns null for non-finite batteryExportTippingPoint', () => {
    const s = buildPlanSummary([row], cfg, {
      gridBatteryTippingPoint_cents_per_kWh: 10,
      gridChargeTippingPoint_cents_per_kWh: 8,
      batteryExportTippingPoint_cents_per_kWh: Infinity,
      pvExportTippingPoint_cents_per_kWh: -Infinity,
    });
    expect(s.batteryExportTippingPoint_cents_per_kWh).toBeNull();
    expect(s.pvExportTippingPoint_cents_per_kWh).toBeNull();
  });

  it('passes through finite tipping point values', () => {
    const s = buildPlanSummary([row], cfg, {
      gridBatteryTippingPoint_cents_per_kWh: 25,
      pvExportTippingPoint_cents_per_kWh: 10,
      gridChargeTippingPoint_cents_per_kWh: 8,
      batteryExportTippingPoint_cents_per_kWh: 5,
    });
    expect(s.gridBatteryTippingPoint_cents_per_kWh).toBe(25);
    expect(s.pvExportTippingPoint_cents_per_kWh).toBe(10);
  });
});

describe('buildPlanSummary — rebalanceStatus "active" vs "scheduled" (line 18)', () => {
  const cfg = { stepSize_m: 15 };

  it('returns "active" when rebalance is enabled and startMs is not null', () => {
    const s = buildPlanSummary([], cfg, {}, { enabled: true, startMs: 12345, remainingSlots: 2 });
    expect(s.rebalanceStatus).toBe('active');
  });

  it('returns "scheduled" when rebalance is enabled but startMs is null', () => {
    const s = buildPlanSummary([], cfg, {}, { enabled: true, startMs: null, remainingSlots: 4 });
    expect(s.rebalanceStatus).toBe('scheduled');
  });

  it('returns "disabled" when rebalance.enabled is false', () => {
    const s = buildPlanSummary([], cfg, {}, { enabled: false, startMs: null, remainingSlots: 0 });
    expect(s.rebalanceStatus).toBe('disabled');
  });
});

describe('buildLP — EV charging (MILP)', () => {
  const T = 5;
  const base = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(1000),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    maxDischargePower_W: 4000,
    maxGridImport_W: 2500,
  };
  const evCfg = {
    evMinChargePower_W: 1380,
    evMaxChargePower_W: 3680,
    evBatteryCapacity_Wh: 60000,
    evInitialSoc_percent: 50,  // → 30 000 Wh
    evTargetSoc_percent: 80,   // → 48 000 Wh
    evDepartureSlot: 4,        // deadline at slot index 3 (0-based)
  };

  it('does not include EV variables or Binaries when ev is not set', () => {
    const lp = buildLP(base);
    expect(lp).not.toContain('grid_to_ev_');
    expect(lp).not.toContain('ev_on_');
    expect(lp).not.toContain('Binaries');
  });

  it('includes EV flow variables in Bounds for every slot', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    for (let t = 0; t < T; t++) {
      expect(lp).toContain(`grid_to_ev_${t}`);
      expect(lp).toContain(`pv_to_ev_${t}`);
      expect(lp).toContain(`battery_to_ev_${t}`);
      expect(lp).toContain(`ev_soc_${t}`);
    }
  });

  it('includes ev_on binary variables in the Binaries section', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toContain('Binaries');
    for (let t = 0; t < T; t++) {
      expect(lp).toContain(`ev_on_${t}`);
    }
  });

  it('includes min/max power constraints for each EV slot', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toContain('c_ev_min_0:');
    expect(lp).toContain('c_ev_max_0:');
    expect(lp).toContain(`c_ev_min_${T - 1}:`);
  });

  it('includes EV SoC evolution constraints with correct initial Wh', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    // c_ev_soc_0 RHS = initialWh = 50% of 60000 = 30000
    expect(lp).toContain('c_ev_soc_0:');
    expect(lp).toMatch(/c_ev_soc_0:.*= 30000\b/);
    // chained constraints for t >= 1
    expect(lp).toContain('c_ev_soc_1:');
    expect(lp).toMatch(/c_ev_soc_1:.*= 0\b/);
  });

  it('includes target SoC constraint at departure slot - 1', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    // evDepartureSlot=4 → constraint on ev_soc_3 >= targetWh = 80% of 60000 = 48000
    expect(lp).toContain('c_ev_target:');
    expect(lp).toMatch(/c_ev_target:.*ev_soc_3.*>= 48000\b/);
  });

  it('adds pv_to_ev term to PV split constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_pv_split_0:.*pv_to_ev_0/);
  });

  it('adds battery_to_ev term to discharge cap constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_discharge_cap_0:.*battery_to_ev_0/);
  });

  it('adds grid_to_ev term to grid import cap constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_grid_import_cap_0:.*grid_to_ev_0/);
  });

  it('omits c_ev_target when evDepartureSlot > T', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, evDepartureSlot: T + 5 } });
    expect(lp).not.toContain('c_ev_target:');
  });

  it('applies evChargeEfficiency_percent to EV SoC evolution coefficients', () => {
    // 90% efficiency → evChargeWhPerW = 0.25 * 0.9 = 0.225
    const lp = buildLP({ ...base, ev: { ...evCfg, evChargeEfficiency_percent: 90 } });
    expect(lp).toMatch(/c_ev_soc_0:.*0\.225 grid_to_ev_0/);
    expect(lp).toMatch(/c_ev_soc_1:.*0\.225 grid_to_ev_1/);
  });

  it('uses bare stepHours (0.25) in EV SoC constraints when efficiency is 100%', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, evChargeEfficiency_percent: 100 } });
    expect(lp).toMatch(/c_ev_soc_0:.*0\.25 grid_to_ev_0/);
  });

  it('includes c_ev_min_on cardinality constraint when deficit is achievable', () => {
    // departureSlot=8 → 8 slots, maxPow=3680, eff=0.9
    // evChargeWhPerSlot = 3680 * 0.25 * 0.9 = 828
    // deficit = 33000 - 30000 = 3000 → kMin = ceil(3000/828) = 4
    // depLimit = min(8, 96) = 8, kMin (4) < 8 → constraint added with 8 terms
    const T = 96;
    const largeBase = {
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(1000),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
    };
    const lp = buildLP({
      ...largeBase,
      ev: { ...evCfg, evTargetSoc_percent: 55, evDepartureSlot: 8 },
    });
    expect(lp).toContain('c_ev_min_on:');
    expect(lp).toMatch(/c_ev_min_on:.*ev_on_0.*ev_on_7/);
  });

  it('omits c_ev_min_on when deficit is zero', () => {
    const T = 96;
    const largeBase = {
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(1000),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
    };
    const lp = buildLP({
      ...largeBase,
      ev: { ...evCfg, evTargetSoc_percent: 50 }, // target = initial → deficit = 0
    });
    expect(lp).not.toContain('c_ev_min_on:');
  });

  it('omits c_ev_min_on when departure is in the past (depSlot = 0)', () => {
    const T = 96;
    const largeBase = {
      load_W: Array(T).fill(500),
      pv_W: Array(T).fill(1000),
      importPrice: Array(T).fill(10),
      exportPrice: Array(T).fill(5),
    };
    const lp = buildLP({
      ...largeBase,
      ev: { ...evCfg, evDepartureTime: '2020-01-01T00:00:00Z' },
    });
    expect(lp).not.toContain('c_ev_min_on:');
  });
});
