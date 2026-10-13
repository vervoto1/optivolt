import { describe, it, expect } from 'vitest';
import { buildPlanSummary } from '../../lib/plan-summary.ts';

const cfg = { stepSize_m: 60 }; // 1-hour slots → W = kWh per slot

// Minimal row with all required PlanRow fields
function makeRow(overrides = {}) {
  return {
    tIdx: 0, timestampMs: 0,
    load: 0, pv: 0, ic: 0, ec: 0,
    g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, pvCurtail: 0, b2l: 0, b2g: 0,
    imp: 0, exp: 0, soc: 0, soc_percent: 0,
    g2ev: 0, pv2ev: 0, b2ev: 0,
    ev_charge: 0, ev_charge_A: 0, ev_charge_mode: 'off', ev_soc_percent: 0,
    ...overrides,
  };
}

describe('buildPlanSummary — EV energy totals', () => {
  it('returns zero EV totals for an empty row array', () => {
    const s = buildPlanSummary([], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
    expect(s.evChargeFromGrid_kWh).toBe(0);
    expect(s.evChargeFromPv_kWh).toBe(0);
    expect(s.evChargeFromBattery_kWh).toBe(0);
    expect(s.importCost_cents).toBe(0);
    expect(s.exportCost_cents).toBe(0);
    expect(s.netGridCost_cents).toBe(0);
  });

  it('sums curtailed PV energy', () => {
    const rows = [
      makeRow({ pvCurtail: 1000 }),
      makeRow({ pvCurtail: 500 }),
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.pvCurtailed_kWh).toBeCloseTo(1.5);
  });

  it('returns zero EV totals when all EV fields are zero', () => {
    const s = buildPlanSummary([makeRow(), makeRow()], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
    expect(s.evChargeFromGrid_kWh).toBe(0);
  });

  it('sums EV energy from grid across slots', () => {
    const rows = [
      makeRow({ g2ev: 1000 }),  // 1000 W × 1 h = 1 kWh
      makeRow({ g2ev: 2000 }),  // 2 kWh
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromGrid_kWh).toBeCloseTo(3);
    expect(s.evChargeTotal_kWh).toBeCloseTo(3);
  });

  it('sums EV energy from PV and battery separately', () => {
    const rows = [
      makeRow({ pv2ev: 1500, b2ev: 500 }),
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromPv_kWh).toBeCloseTo(1.5);
    expect(s.evChargeFromBattery_kWh).toBeCloseTo(0.5);
    expect(s.evChargeTotal_kWh).toBeCloseTo(2);
  });

  it('totals all three EV sources combined', () => {
    const rows = [
      makeRow({ g2ev: 1000, pv2ev: 500, b2ev: 250 }),
      makeRow({ g2ev: 500,  pv2ev: 0,   b2ev: 0   }),
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromGrid_kWh).toBeCloseTo(1.5);
    expect(s.evChargeFromPv_kWh).toBeCloseTo(0.5);
    expect(s.evChargeFromBattery_kWh).toBeCloseTo(0.25);
    expect(s.evChargeTotal_kWh).toBeCloseTo(2.25);
  });

  it('handles rows where g2ev/pv2ev/b2ev are absent (undefined)', () => {
    // PlanRow without EV fields — summary should not throw and EV totals = 0
    const row = makeRow();
    delete row.g2ev;
    delete row.pv2ev;
    delete row.b2ev;
    const s = buildPlanSummary([row], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
  });
});

describe('buildPlanSummary — grid cost totals', () => {
  it('totals import, export, and net grid costs from slot rates and energy', () => {
    const rows = [
      makeRow({ imp: 1000, exp: 500, ic: 20, ec: 8 }),
      makeRow({ imp: 500, exp: 1000, ic: 10, ec: -2 }),
    ];

    const s = buildPlanSummary(rows, cfg);

    expect(s.importCost_cents).toBeCloseTo(25);
    expect(s.exportCost_cents).toBeCloseTo(2);
    expect(s.netGridCost_cents).toBeCloseTo(23);
  });

  it('uses parsed row costs when present', () => {
    const rows = [
      makeRow({ imp: 1000, exp: 1000, ic: 99, ec: 99, importCost_cents: 3, exportCost_cents: 1 }),
      makeRow({ imp: 1000, exp: 1000, ic: 99, ec: 99, importCost_cents: 4, exportCost_cents: -2 }),
    ];

    const s = buildPlanSummary(rows, cfg);

    expect(s.importCost_cents).toBeCloseTo(7);
    expect(s.exportCost_cents).toBeCloseTo(-1);
    expect(s.netGridCost_cents).toBeCloseTo(8);
  });
});

describe('buildPlanSummary — multi-day forecast rows', () => {
  const firm = [
    makeRow({ evLoad: 0, load: 1000, imp: 1000, g2l: 1000, ic: 10 }),
    makeRow({ evLoad: 0, load: 2000, imp: 2000, g2l: 2000, ic: 20, exp: 500, ec: 4 }),
  ];
  const forecast = [
    makeRow({ evLoad: 0, load: 3000, imp: 3000, g2l: 3000, ic: 30, g2ev: 1000, priceForecast: true }),
  ];

  it('totals the firm rows as before and reports the forecast rows separately', () => {
    const alone = buildPlanSummary(firm, cfg, { gridChargeTippingPoint_cents_per_kWh: 7 });
    const s = buildPlanSummary([...firm, ...forecast], cfg, { gridChargeTippingPoint_cents_per_kWh: 7 });
    const { forecast: block, ...firmPart } = s;
    expect(firmPart).toEqual(alone);
    expect(block).toEqual({
      loadTotal_kWh: 3,
      pvTotal_kWh: 0,
      evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 3,
      loadFromBattery_kWh: 0,
      loadFromPv_kWh: 0,
      gridToBattery_kWh: 0,
      batteryToGrid_kWh: 0,
      pvCurtailed_kWh: 0,
      importEnergy_kWh: 3,
      importCost_cents: 90,
      exportCost_cents: 0,
      netGridCost_cents: 90,
      avgImportPrice_cents_per_kWh: 30,
      evChargeTotal_kWh: 1,
      evChargeFromGrid_kWh: 1,
      evChargeFromPv_kWh: 0,
      evChargeFromBattery_kWh: 0,
    });
  });

  it('has no forecast block, and the same key order, without forecast rows', () => {
    const s = buildPlanSummary(firm, cfg);
    expect(s).not.toHaveProperty('forecast');
    expect(Object.keys(s)).toEqual([
      'loadTotal_kWh', 'pvTotal_kWh', 'evLoadTotal_kWh', 'loadFromGrid_kWh', 'loadFromBattery_kWh', 'loadFromPv_kWh',
      'gridToBattery_kWh', 'batteryToGrid_kWh', 'pvCurtailed_kWh', 'importEnergy_kWh', 'importCost_cents',
      'exportCost_cents', 'netGridCost_cents', 'avgImportPrice_cents_per_kWh',
      'gridBatteryTippingPoint_cents_per_kWh', 'gridChargeTippingPoint_cents_per_kWh',
      'batteryExportTippingPoint_cents_per_kWh', 'pvExportTippingPoint_cents_per_kWh', 'rebalanceStatus',
      'evChargeTotal_kWh', 'evChargeFromGrid_kWh', 'evChargeFromPv_kWh', 'evChargeFromBattery_kWh',
    ]);
  });
});
