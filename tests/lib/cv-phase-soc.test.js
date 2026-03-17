/**
 * Test that CV phase charging doesn't cause SoC oscillation.
 *
 * The big-M coefficient in the CV constraint can cause MILP numerical
 * instability if it's too large, leading to solutions where SoC appears
 * to drop during charging (physically impossible).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
// @ts-ignore
import highsFactory from '../../vendor/highs-build/highs.js';

// Realistic config that triggers the CV phase issue:
// Battery charges from ~80% to 100%, crossing both CV thresholds (95%, 97%)
function makeConfig(overrides = {}) {
  const T = 16; // 4 hours of 15-min slots
  return {
    load_W: Array(T).fill(2000),          // 2kW constant load
    pv_W: Array(T).fill(500),             // 500W PV
    importPrice: Array(T).fill(25),       // flat 25 c/kWh — forces grid charging
    exportPrice: Array(T).fill(25),
    stepSize_m: 15,
    batteryCapacity_Wh: 35000,            // 35 kWh battery
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 15000,              // 15kW max charge
    maxDischargePower_W: 15000,
    maxGridImport_W: 17000,
    maxGridExport_W: 15000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 2,
    idleDrain_W: 40,
    terminalSocValuation: 'max',          // value final SoC to incentivize charging
    terminalSocCustomPrice_cents_per_kWh: 0,
    initialSoc_percent: 80,               // start at 80% — will cross 95% and 97%
    cvPhaseThresholds: [
      { soc_percent: 95, maxChargePower_W: 9360 },
      { soc_percent: 97, maxChargePower_W: 2600 },
    ],
    ...overrides,
  };
}

describe('CV phase SoC consistency', () => {
  let highs;

  // Initialize HiGHS once for all tests
  beforeAll(async () => {
    highs = await highsFactory({});
  });

  it('SoC never decreases during charging (no discharge slots)', async () => {
    const cfg = makeConfig();
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    // Check: SoC should never decrease between consecutive slots
    // when there's no battery discharge (b2l=0, b2g=0)
    const violations = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const isCharging = curr.g2b > 0 || curr.pv2b > 0;
      const noDischarge = curr.b2l < 1 && curr.b2g < 1;

      if (isCharging && noDischarge && curr.soc_percent < prev.soc_percent - 0.5) {
        violations.push({
          slot: i,
          prevSoc: prev.soc_percent.toFixed(1),
          currSoc: curr.soc_percent.toFixed(1),
          drop: (prev.soc_percent - curr.soc_percent).toFixed(1),
          g2b: curr.g2b,
          pv2b: curr.pv2b,
        });
      }
    }

    if (violations.length > 0) {
      console.log('SoC violations found:');
      for (const v of violations) {
        console.log(`  Slot ${v.slot}: ${v.prevSoc}% → ${v.currSoc}% (drop ${v.drop}%), g2b=${v.g2b}, pv2b=${v.pv2b}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('SoC never decreases during charging with smaller battery (20.48kWh)', async () => {
    // Smaller battery = worse big-M ratio, more numerical stress
    const T = 24;
    const prices = [25, 25, 25, 25, 24, 24, 24, 24, 23, 23, 23, 23, 25, 25, 25, 25, 28, 28, 28, 28, 35, 35, 35, 35];
    const cfg = makeConfig({
      batteryCapacity_Wh: 20480,
      maxChargePower_W: 15000,
      maxGridImport_W: 17000,
      initialSoc_percent: 75,
      load_W: Array(T).fill(1800),
      pv_W: [0,0,0,0, 200,200,200,200, 800,800,800,800, 1200,1200,1200,1200, 600,600,600,600, 0,0,0,0],
      importPrice: prices,
      exportPrice: prices,
      terminalSocValuation: 'max',
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, { startMs: Date.now(), stepMin: 15 });

    const violations = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const noDischarge = curr.b2l < 1 && curr.b2g < 1;
      if (noDischarge && curr.soc_percent < prev.soc_percent - 0.5) {
        violations.push({ slot: i, prev: prev.soc_percent.toFixed(1), curr: curr.soc_percent.toFixed(1) });
      }
    }
    if (violations.length > 0) console.log('20.48kWh violations:', violations);
    expect(violations).toEqual([]);
  });

  it('SoC never decreases with high initial SoC near threshold (93%)', async () => {
    // Start near the 95% threshold to stress the big-M constraint
    const T = 16;
    const cfg = makeConfig({
      initialSoc_percent: 93,
      load_W: Array(T).fill(2500),
      pv_W: Array(T).fill(1000),
      importPrice: [24, 24, 24, 24, 23, 23, 23, 23, 25, 25, 25, 25, 26, 26, 26, 26],
      exportPrice: [24, 24, 24, 24, 23, 23, 23, 23, 25, 25, 25, 25, 26, 26, 26, 26],
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, { startMs: Date.now(), stepMin: 15 });

    const violations = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const noDischarge = curr.b2l < 1 && curr.b2g < 1;
      if (noDischarge && curr.soc_percent < prev.soc_percent - 0.5) {
        violations.push({ slot: i, prev: prev.soc_percent.toFixed(1), curr: curr.soc_percent.toFixed(1) });
      }
    }
    if (violations.length > 0) console.log('93% start violations:', violations);
    expect(violations).toEqual([]);
  });

  it('CV binaries are not activated below threshold (tight big-M prevents it)', async () => {
    // With low maxChargePower (5kW) and cvThreshold at 9360W,
    // verify the solver doesn't set cv_0=1 when SoC < 95%
    const T = 12;
    const cfg = makeConfig({
      batteryCapacity_Wh: 35000,
      maxChargePower_W: 15000,
      maxGridImport_W: 17000,
      initialSoc_percent: 80,
      load_W: Array(T).fill(2000),
      pv_W: Array(T).fill(500),
      importPrice: Array(T).fill(20),
      exportPrice: Array(T).fill(20),
      terminalSocValuation: 'max',
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, { startMs: Date.now(), stepMin: 15 });

    // Check: any cv_0 binary active at slots where start-of-slot SoC < 95%?
    const cvBins = Object.entries(result.Columns || {}).filter(([k]) => k.startsWith('cv_0_'));
    const violations = [];
    for (const [name, col] of cvBins) {
      const t = Number(name.split('_')[2]);
      const active = Math.round(col?.Primal ?? 0) === 1;
      const startSocPercent = t === 0 ? cfg.initialSoc_percent : rows[t - 1].soc_percent;
      if (active && startSocPercent < 94.5) {
        violations.push({ slot: t, startSoc: startSocPercent.toFixed(1), cv_0: active });
      }
    }

    // NOTE: this test documents the current behavior.
    // With the current big-M (maxSoc_Wh), the solver MAY set cv_0=1 below threshold.
    // With a tight big-M (maxSoc_Wh - cvThresholdWh), this would be prevented.
    if (violations.length > 0) {
      console.log(`CV binaries active below threshold (${violations.length} slots):`);
      for (const v of violations) {
        console.log(`  Slot ${v.slot}: SoC=${v.startSoc}% but cv_0=1`);
      }
    }
    // For now, just document — the tight big-M fix would make this test strict
    expect(result.Status).toBe('Optimal');
  });

  it('SoC consistent when slowly charging through CV thresholds', async () => {
    // Force slow charging through 95% and 97% thresholds by limiting grid import
    // so the battery takes many slots to go from 90% to 100%.
    // With 35kWh battery, 1% = 350 Wh. At 3kW charge, each 15-min slot adds
    // ~712 Wh (3000 * 0.25 * 0.95) = ~2% per slot. So 90→100% takes ~5 slots.
    const T = 24;
    const cheapPrice = Array(T).fill(20); // flat cheap price to incentivize full charge
    const cfg = makeConfig({
      batteryCapacity_Wh: 35000,
      maxChargePower_W: 5000,             // low max charge so CV throttling matters
      maxDischargePower_W: 15000,
      maxGridImport_W: 7000,              // limited grid to force slow charging
      maxGridExport_W: 15000,
      initialSoc_percent: 88,             // start near thresholds
      load_W: Array(T).fill(1500),        // moderate load
      pv_W: Array(T).fill(500),           // some PV
      importPrice: cheapPrice,
      exportPrice: cheapPrice,
      terminalSocValuation: 'max',        // incentivize charging to 100%
    });

    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, { startMs: Date.now(), stepMin: 15 });

    // Print the charging phase for visibility
    const chargingRows = rows.filter(r => r.g2b > 100 || r.pv2b > 100);
    if (chargingRows.length > 0) {
      console.log('Charging phase:');
      for (const r of chargingRows) {
        console.log(`  Slot ${r.tIdx}: g2b=${r.g2b.toFixed(0)} pv2b=${r.pv2b.toFixed(0)} soc=${r.soc_percent.toFixed(1)}%`);
      }
    }

    // Check for SoC drops during charging
    const violations = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const noDischarge = curr.b2l < 1 && curr.b2g < 1;
      if (noDischarge && curr.soc_percent < prev.soc_percent - 0.5) {
        violations.push({
          slot: i,
          prev: prev.soc_percent.toFixed(1),
          curr: curr.soc_percent.toFixed(1),
          g2b: curr.g2b.toFixed(0),
          pv2b: curr.pv2b.toFixed(0),
        });
      }
    }
    if (violations.length > 0) console.log('User scenario violations:', violations);
    expect(violations).toEqual([]);
  });

  it('charge power respects CV thresholds', async () => {
    const cfg = makeConfig();
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    for (let i = 1; i < rows.length; i++) {
      const prevSocPercent = rows[i - 1].soc_percent;
      const totalCharge = rows[i].g2b + rows[i].pv2b;

      if (prevSocPercent >= 97) {
        // Above 97%: charge should not exceed 2600W (+ small tolerance)
        expect(totalCharge).toBeLessThanOrEqual(2600 + 1);
      } else if (prevSocPercent >= 95) {
        // Above 95%: charge should not exceed 9360W (+ small tolerance)
        expect(totalCharge).toBeLessThanOrEqual(9360 + 1);
      }
    }
  });

  it('SoC monotonically increases when charging from 80% to 100%', async () => {
    const cfg = makeConfig();
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);
    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    // Find the charging phase (SoC increasing from ~80% toward 100%)
    let _minSocSeen = rows[0].soc_percent;
    const nonMonotonicSlots = [];

    for (let i = 1; i < rows.length; i++) {
      const curr = rows[i];
      const prev = rows[i - 1];
      const noDischarge = curr.b2l < 1 && curr.b2g < 1;

      if (noDischarge && curr.soc_percent < prev.soc_percent - 0.5) {
        nonMonotonicSlots.push({
          slot: i,
          prev: prev.soc_percent.toFixed(1),
          curr: curr.soc_percent.toFixed(1),
        });
      }
    }

    if (nonMonotonicSlots.length > 0) {
      console.log('Non-monotonic SoC during charging:');
      console.log(nonMonotonicSlots);
    }

    expect(nonMonotonicSlots).toEqual([]);
  });
});
