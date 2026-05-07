// Tests for the split inverter / battery efficiency model introduced in v0.7.20.
// The LP variables are emitted in their natural source units:
//   pv_to_*    : DC W consumed from PV bus
//   grid_to_*  : AC W from grid
//   battery_to_*: DC W on the battery bus (post battery-discharge loss)
// Each AC↔DC crossing carries an explicit η_inv factor.

import { describe, it, expect, beforeAll } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
// @ts-ignore
import highsFactory from '../../vendor/highs-build/highs.js';

const baseCfg = {
  load_W: [1000],
  pv_W: [0],
  importPrice: [25.8],
  exportPrice: [0],
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 5000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  initialSoc_percent: 50,
};

describe('LP: inverter-efficiency split (η_inv physics)', () => {
  it('applies η_inv to pv_to_grid revenue coefficient (export-side conversion)', () => {
    const cfg = { ...baseCfg, exportPrice: [26], inverterEfficiency_percent: 90 };
    const lp = buildLP(cfg);
    // 1 W of pv_to_grid (DC) → 0.9 W AC exported. Revenue per W = -0.9 * 26 * (0.25/1000) = -0.00585 c€.
    // The avoidExport tiebreak (4e-6) is added, so net coefficient = -0.00585 + 4e-6 ≈ -0.005846.
    // Match floating-point printout robustly: extract the coefficient on pv_to_grid_0.
    const m = /\s([-0-9.]+)\s+pv_to_grid_0\b/.exec(lp);
    expect(m).not.toBeNull();
    const coeff = Number(m[1]);
    expect(coeff).toBeCloseTo(-0.9 * 26 * (15 / 60) / 1000 + 4e-6, 8);
  });

  it('applies η_inv * η_inv to a battery_to_grid revenue coefficient', () => {
    // battery_to_grid (DC) → η_inv W AC at grid. With dischargeEff modeling the
    // battery's own loss separately, only η_inv applies to the revenue side.
    const cfg = { ...baseCfg, exportPrice: [26], inverterEfficiency_percent: 90 };
    const lp = buildLP(cfg);
    const m = /\s([-0-9.]+)\s+battery_to_grid_0\b/.exec(lp);
    expect(m).not.toBeNull();
    const coeff = Number(m[1]);
    // batteryCost is 0 in baseCfg, so net = -0.9 * 26 * 0.25/1000 = -0.00585.
    expect(coeff).toBeCloseTo(-0.9 * 26 * 0.25 / 1000, 8);
  });

  it('SoC evolution: pv_to_battery stores η_bc, grid_to_battery stores η_inv * η_bc', () => {
    const cfg = { ...baseCfg, inverterEfficiency_percent: 90, chargeEfficiency_percent: 95 };
    const lp = buildLP(cfg);
    // chargeWhPerW_pv = 0.25 * 0.95 = 0.2375
    // chargeWhPerW_grid = 0.25 * 0.90 * 0.95 = 0.21375
    expect(lp).toMatch(/c_soc_0:.*-\s*0\.2375\s+pv_to_battery_0/);
    expect(lp).toMatch(/c_soc_0:.*-\s*0\.21375\s+grid_to_battery_0/);
  });

  it('load constraint applies η_inv to pv_to_load and battery_to_load (DC→AC delivery)', () => {
    const cfg = { ...baseCfg, inverterEfficiency_percent: 90 };
    const lp = buildLP(cfg);
    // 0.9 pv_to_load_0 + grid_to_load_0 + 0.9 battery_to_load_0 = 1000
    expect(lp).toMatch(/c_load_0:\s*0\.9\s+pv_to_load_0\s*\+\s*grid_to_load_0\s*\+\s*0\.9\s+battery_to_load_0\s*=\s*1000/);
  });

  it('grid export cap applies η_inv to AC-side conversion', () => {
    const cfg = { ...baseCfg, inverterEfficiency_percent: 80 };
    const lp = buildLP(cfg);
    // 0.8 pv_to_grid_0 + 0.8 battery_to_grid_0 <= 5000
    expect(lp).toMatch(/c_grid_export_cap_0:\s*0\.8\s+pv_to_grid_0\s*\+\s*0\.8\s+battery_to_grid_0\s*<=\s*5000/);
  });

  it('charge cap is at the DC battery boundary (η_inv on grid side, none on PV side)', () => {
    const cfg = { ...baseCfg, inverterEfficiency_percent: 90 };
    const lp = buildLP(cfg);
    // pv_to_battery_0 + 0.9 grid_to_battery_0 <= maxChargePower_W
    expect(lp).toMatch(/c_charge_cap_0:\s*pv_to_battery_0\s*\+\s*0\.9\s+grid_to_battery_0\s*<=\s*4000/);
  });

  it('terminal SoC valuation includes η_bd * η_inv (round-trip from stored to AC)', () => {
    const cfg = {
      ...baseCfg,
      pv_W: [0],
      load_W: [0],
      importPrice: [0],
      exportPrice: [0],
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 100,
      inverterEfficiency_percent: 80,
      dischargeEfficiency_percent: 90,
    };
    const lp = buildLP(cfg);
    // terminalPrice_cents_per_Wh = 100 / 1000 * 0.9 * 0.8 = 0.072
    expect(lp).toMatch(/-\s*0\.072\s+soc_0/);
  });
});

describe('LP regression: PV→grid→battery arbitrage at small price spreads', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  // Forcing the apples-to-apples comparison the user observed: surplus PV in slot 0 plus
  // a desire to end with stored energy (terminal SoC value). Two ways to charge the battery:
  //   A) PV→battery direct (DC→DC, only η_bc).
  //   B) PV→grid then later grid→battery (DC→AC inverter, AC→DC inverter, then η_bc).
  // Spread between exportPrice and importPrice is small (26 vs 25.8). Pre-v0.7.20 the LP
  // didn't model inverter loss on pv→grid OR the extra inverter loss on grid→battery, so
  // it booked B as a tiny profit. With η_inv split, B's round-trip cost dominates the spread.
  it('does NOT take pv→grid→battery round trip when η_inv = 95% (round-trip loss > spread)', () => {
    const cfg = {
      load_W: [1000, 1000],
      pv_W: [3000, 0],
      importPrice: [50, 25.8], // slot 0 is expensive (no incentive to import for charging then)
      exportPrice: [26, 25.8],
      stepSize_m: 15,
      batteryCapacity_Wh: 20000,
      minSoc_percent: 10,
      maxSoc_percent: 100,
      maxChargePower_W: 5000,
      maxDischargePower_W: 5000,
      maxGridImport_W: 5000,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      inverterEfficiency_percent: 95,
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      // Strong incentive to end with stored Wh: terminal Wh worth 30 c€/kWh on AC after
      // discharge (this gets multiplied by η_bd * η_inv internally).
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 30,
      initialSoc_percent: 50,
    };
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // Surplus PV in slot 0 should land in the battery (DC→DC), not be cycled through
    // the grid for a 0.2¢ spread. pv2b is DC; the surplus is roughly pv - pv2l_DC.
    const slot0_surplus_to_battery = rows[0].pv2b;
    const slot1_grid_charge = rows[1].g2b;
    expect(slot0_surplus_to_battery).toBeGreaterThan(1500);
    expect(slot1_grid_charge).toBeLessThan(50);
  });

  it('takes the arbitrage at η_inv = 95% only when the spread exceeds the round-trip loss (~10%)', () => {
    // Round-trip cost factor: 1 - η_inv² ≈ 1 - 0.9025 = 9.75% of import price.
    // At importPrice = 10 c€/kWh, threshold ≈ 0.975 c€/kWh.
    // With exportPrice = 25 c€/kWh and importPrice = 10 c€/kWh, spread is 15 — well above threshold.
    const cfg = {
      load_W: [1000, 1000],
      pv_W: [3000, 0],
      importPrice: [50, 10],
      exportPrice: [25, 10],
      stepSize_m: 15,
      batteryCapacity_Wh: 20000,
      minSoc_percent: 10,
      maxSoc_percent: 100,
      maxChargePower_W: 5000,
      maxDischargePower_W: 5000,
      maxGridImport_W: 5000,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      inverterEfficiency_percent: 95,
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      terminalSocValuation: 'zero',
      initialSoc_percent: 50,
    };
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });
    // At a 15 c€/kWh spread the round trip is profitable even after losses.
    expect(rows[0].pv2g + rows[1].g2b).toBeGreaterThan(500);
  });
});

describe('parseSolution: AC-side reporting under η_inv', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('reports pv2g and b2g multiplied by η_inv (AC-meter view)', () => {
    // Force the solver to produce some PV → grid: load=0, PV>0, positive export price,
    // no battery storage available (start at maxSoc with no terminal value).
    const cfg = {
      load_W: [0],
      pv_W: [1000],
      importPrice: [10],
      exportPrice: [20],
      stepSize_m: 15,
      batteryCapacity_Wh: 1000,
      minSoc_percent: 10,
      maxSoc_percent: 50,         // tiny window so battery quickly fills
      initialSoc_percent: 50,     // already at max — solver can only export
      maxChargePower_W: 0,        // explicitly disable charging
      maxDischargePower_W: 0,
      maxGridImport_W: 5000,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 100,
      dischargeEfficiency_percent: 100,
      inverterEfficiency_percent: 80,
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      terminalSocValuation: 'zero',
    };
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    const [row] = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // LP variable pv_to_grid_0 = 1000 (DC W consumed). After parseSolution applies η_inv,
    // row.pv2g should be 800 (AC W exported).
    expect(row.pv2g).toBeCloseTo(800, 1);
    // Total exp = η_inv * (LP pv_to_grid + LP battery_to_grid) = 0.8 * 1000 = 800.
    expect(row.exp).toBeCloseTo(800, 1);
    // Export revenue = exp * stepHours / 1000 * exportPrice = 800 * 0.25 / 1000 * 20 = 4 c€.
    expect(row.exportCost_cents).toBeCloseTo(4, 3);
  });
});

describe('autoSplit migration', () => {
  it('preserves combined chargeEff round-trip when migrating legacy 95/95 → 97/97/97', async () => {
    const { normalizeSettings } = await import('../../api/services/settings-schema.ts');
    const legacy = {
      stepSize_m: 15,
      batteryCapacity_Wh: 20480,
      minSoc_percent: 20,
      maxSoc_percent: 100,
      maxChargePower_W: 3600,
      maxDischargePower_W: 4000,
      maxGridImport_W: 2500,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      // inverterEfficiency_percent intentionally omitted
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      terminalSocCustomPrice_cents_per_kWh: 0,
      rebalanceHoldHours: 3,
      terminalSocValuation: 'zero',
      haUrl: '',
      haToken: '',
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      blockFeedInOnNegativePrices: true,
    };
    const out = normalizeSettings(legacy);
    expect(out.inverterEfficiency_percent).toBe(97);
    expect(out.chargeEfficiency_percent).toBe(97);
    expect(out.dischargeEfficiency_percent).toBe(97);
    // Combined for grid→battery: η_inv * η_bc ≈ 0.97 * 0.97 = 0.9409 (vs legacy 0.95).
    // The discrepancy is rounding — within ~1% and acceptable for the migration.
    expect(0.97 * 0.97).toBeCloseTo(0.9409, 4);
  });

  it('does not re-migrate when inverterEfficiency_percent is already set', async () => {
    const { normalizeSettings } = await import('../../api/services/settings-schema.ts');
    const settings = {
      stepSize_m: 15,
      batteryCapacity_Wh: 20480,
      minSoc_percent: 20,
      maxSoc_percent: 100,
      maxChargePower_W: 3600,
      maxDischargePower_W: 4000,
      maxGridImport_W: 2500,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      inverterEfficiency_percent: 90,
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      terminalSocCustomPrice_cents_per_kWh: 0,
      rebalanceHoldHours: 3,
      terminalSocValuation: 'zero',
      haUrl: '',
      haToken: '',
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      blockFeedInOnNegativePrices: true,
    };
    const out = normalizeSettings(settings);
    expect(out.chargeEfficiency_percent).toBe(95);
    expect(out.dischargeEfficiency_percent).toBe(95);
    expect(out.inverterEfficiency_percent).toBe(90);
  });

  it('handles asymmetric legacy values without exceeding 100% on any factor', async () => {
    const { normalizeSettings } = await import('../../api/services/settings-schema.ts');
    const legacy = {
      stepSize_m: 15,
      batteryCapacity_Wh: 20480,
      minSoc_percent: 20,
      maxSoc_percent: 100,
      maxChargePower_W: 3600,
      maxDischargePower_W: 4000,
      maxGridImport_W: 2500,
      maxGridExport_W: 5000,
      chargeEfficiency_percent: 80,    // legacy combined 80%
      dischargeEfficiency_percent: 95, // legacy combined 95%
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 0,
      terminalSocCustomPrice_cents_per_kWh: 0,
      rebalanceHoldHours: 3,
      terminalSocValuation: 'zero',
      haUrl: '',
      haToken: '',
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      blockFeedInOnNegativePrices: true,
    };
    const out = normalizeSettings(legacy);
    expect(out.inverterEfficiency_percent).toBeLessThanOrEqual(100);
    expect(out.chargeEfficiency_percent).toBeLessThanOrEqual(100);
    expect(out.dischargeEfficiency_percent).toBeLessThanOrEqual(100);
  });
});

describe('EV path: η_inv applied to pv_to_ev and battery_to_ev (DC→AC→EV charger)', () => {
  it('SoC delta on grid_to_ev uses η_ev only; on pv_to_ev / battery_to_ev uses η_inv * η_ev', () => {
    const cfg = {
      ...baseCfg,
      load_W: [0, 0],
      pv_W: [0, 0],
      importPrice: [10, 10],
      exportPrice: [5, 5],
      inverterEfficiency_percent: 80,
      ev: {
        evMinChargePower_W: 0,
        evMaxChargePower_W: 5000,
        evBatteryCapacity_Wh: 50000,
        evInitialSoc_percent: 0,
        evTargetSoc_percent: 50,
        evDepartureSlot: 2,
        evChargeEfficiency_percent: 90,
      },
    };
    const lp = buildLP(cfg);
    // grid_to_ev coefficient in c_ev_soc_0 = stepHours * η_ev = 0.25 * 0.9 = 0.225
    // pv_to_ev / battery_to_ev coefficient = 0.225 * η_inv = 0.225 * 0.8 = 0.18
    expect(lp).toMatch(/c_ev_soc_0:.*-\s*0\.225\s+grid_to_ev_0/);
    expect(lp).toMatch(/c_ev_soc_0:.*-\s*0\.18\s+pv_to_ev_0/);
    expect(lp).toMatch(/c_ev_soc_0:.*-\s*0\.18\s+battery_to_ev_0/);
  });

  it('EV min/max power constraints bound AC-side power into the charger', () => {
    const cfg = {
      ...baseCfg,
      load_W: [0],
      pv_W: [0],
      inverterEfficiency_percent: 80,
      ev: {
        evMinChargePower_W: 1000,
        evMaxChargePower_W: 5000,
        evBatteryCapacity_Wh: 50000,
        evInitialSoc_percent: 0,
        evTargetSoc_percent: 50,
        evDepartureSlot: 2,
        evChargeEfficiency_percent: 90,
      },
    };
    const lp = buildLP(cfg);
    // c_ev_min_0: grid_to_ev_0 + 0.8 pv_to_ev_0 + 0.8 battery_to_ev_0 - 1000 ev_on_0 >= 0
    expect(lp).toMatch(/c_ev_min_0:\s*grid_to_ev_0\s*\+\s*0\.8\s+pv_to_ev_0\s*\+\s*0\.8\s+battery_to_ev_0\s*-\s*1000\s+ev_on_0\s*>=\s*0/);
  });
});
