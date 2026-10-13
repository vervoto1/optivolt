import { describe, it, expect, beforeAll } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import { terminalTailMinPrice } from '../../lib/export-tariff.ts';
// @ts-ignore
import highsFactory from '../../vendor/highs-build/highs.js';

// Behaviour of the unchanged LP under the post-net-metering inputs
// (plans/end-of-net-metering-plan.md): export earns the bare market price, well
// below the all-in import price, and the end-of-horizon SoC is valued with
// `tailMin` passed as `custom`. Hourly slots keep the MILP small.

const STEP_M = 60;
const kWh = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0) * (STEP_M / 60) / 1000;

// 10 kWh battery, 95 % charge and discharge, 97.5 % inverter: ~88 % round
// trip PV→battery→load, ~86 % grid→battery→load. No wear cost and no idle
// drain, so nothing but the prices discourages arbitrage.
const battery = {
  stepSize_m: STEP_M,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 10000,
  maxGridExport_W: 10000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 97.5,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
};

/** Expand [count, value] runs into a per-slot array. */
const runs = (...parts) => parts.flatMap(([count, value]) => Array(count).fill(value));

describe('buildLP — export at market price after net metering ends', () => {
  let highs;

  beforeAll(async () => {
    highs = await highsFactory({});
  });

  function solve(cfg) {
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    return parseSolution(result, cfg, { startMs: 0, stepMin: STEP_M });
  }

  describe('a full day with asymmetric import and export prices', () => {
    // 00:00–24:00. Import 27–43 c (all-in), export 10–25 c (market), with the
    // cheapest import and export at midday when PV peaks.
    //            night   morning  midday   evening  late
    const importPrice = runs([6, 30], [3, 38], [7, 27], [5, 43], [3, 33]);
    const marketPrice = runs([6, 14], [3, 20], [7, 10], [5, 25], [3, 16]);
    const load_W = runs([6, 400], [3, 900], [7, 500], [5, 1500], [3, 600]);
    const pv_W = runs([8, 0], [1, 1500], [7, 4000], [1, 1500], [7, 0]);
    const PV_WINDOW = [9, 16]; // slots 9..15: 3.5 kW surplus, far more than the battery holds
    const terminalPrice = terminalTailMinPrice(importPrice, STEP_M, 6);
    const cfg = (exportPrice) => ({
      ...battery,
      load_W,
      pv_W,
      importPrice,
      exportPrice,
      initialSoc_percent: 10, // at the floor: anything exported must have been charged in the plan
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: terminalPrice,
    });

    it('values the end of the horizon at the late-evening import price', () => {
      expect(terminalPrice).toBe(33);
    });

    it('fills the battery from midday PV surplus and exports only what it cannot hold', () => {
      const rows = solve(cfg(marketPrice));
      const midday = rows.slice(...PV_WINDOW);

      // The battery is filled from PV, not from the grid, before the evening.
      expect(Math.max(...midday.map(r => r.soc_percent))).toBeGreaterThan(99.9);
      expect(kWh(midday, 'g2b')).toBeCloseTo(0, 3);
      expect(kWh(midday, 'pv2b')).toBeGreaterThan(9);
      // Export takes only what the full battery cannot, and nothing is curtailed
      // at a positive price.
      expect(kWh(rows, 'pv2g')).toBeGreaterThan(0);
      expect(kWh(rows, 'pvCurtail')).toBeCloseTo(0, 3);
    });

    it('charges the battery from the first PV surplus and exports only once it is full', () => {
      const rows = solve(cfg(marketPrice));
      const midday = rows.slice(...PV_WINDOW);

      // One flat export price across the window leaves the order free on
      // price alone; the preferEarlierPvCharging tiebreak puts charging first,
      // so a PV forecast that falls short in the afternoon still finds a full
      // battery.
      const firstExport = midday.findIndex(r => r.pv2g > 1);
      expect(firstExport).toBeGreaterThan(0);
      expect(kWh(midday.slice(0, firstExport), 'pv2g')).toBeCloseTo(0, 3);
      expect(midday[firstExport].soc_percent).toBeGreaterThan(99.9);
      expect(kWh(midday.slice(firstExport + 1), 'pv2b')).toBeCloseTo(0, 3);
    });

    it('never sells grid-charged (or any) battery energy back to the grid', () => {
      const rows = solve(cfg(marketPrice));

      // Grid charging still happens where it serves later self-consumption:
      // 30 c at night beats 38 c in the morning even after the round trip.
      expect(kWh(rows.slice(0, 6), 'g2b')).toBeGreaterThan(0.5);
      expect(kWh(rows.slice(6, 9), 'b2l')).toBeGreaterThan(0.5);
      // But no battery energy reaches the grid: every export price is below
      // the import price it would displace, and below the terminal value.
      expect(kWh(rows, 'b2g')).toBeCloseTo(0, 3);
    });

    it('does sell grid-charged energy back under net metering (the case the switch removes)', () => {
      const rows = solve(cfg(importPrice));

      // Export = import makes night→morning and midday→evening arbitrage pay.
      expect(kWh(rows.slice(0, 6), 'g2b')).toBeGreaterThan(0.5);
      expect(kWh(rows, 'b2g')).toBeGreaterThan(1);
    });
  });

  describe('end of the horizon valued with tailMin', () => {
    // 12:00–24:00. One cheap midday import slot (8 c, market slightly
    // negative so export is floored at 0) and an evening market price of
    // 22 c, above that slot's import price. The rejected whole-horizon `min`
    // valuation would be 8 c, below the evening export price.
    //            cheap  afternoon  evening   late
    const importPrice = runs([1, 8], [4, 27], [4, 40], [3, 32]);
    const exportPrice = runs([1, 0], [4, 10], [4, 22], [3, 14]);
    const T = importPrice.length;
    const base = {
      ...battery,
      load_W: Array(T).fill(300),
      pv_W: Array(T).fill(0),
      importPrice,
      exportPrice,
      initialSoc_percent: 90,
    };
    const tailMin = terminalTailMinPrice(importPrice, STEP_M, 6);

    it('takes the minimum of the last six hours, not the cheap midday slot', () => {
      expect(tailMin).toBe(32);
      expect(tailMin).toBeGreaterThan(Math.max(...exportPrice));
    });

    it('keeps a full battery instead of draining it to the grid in the evening', () => {
      const rows = solve({ ...base, terminalSocValuation: 'custom', terminalSocCustomPrice_cents_per_kWh: tailMin });

      // The cheap slot tops the battery up for later use…
      expect(rows[0].soc_percent).toBeGreaterThan(99.9);
      // …and none of it is sold, even at 22 c against the 8 c it cost.
      expect(kWh(rows, 'b2g')).toBeCloseTo(0, 3);
      // Only the house load (3.6 kWh at most) comes out of the battery.
      expect(rows[T - 1].soc_percent).toBeGreaterThan(60);
    });

    it('drains it to the grid with the rejected whole-horizon minimum (the dump tailMin prevents)', () => {
      const rows = solve({ ...base, terminalSocValuation: 'min' });

      expect(kWh(rows, 'b2g')).toBeGreaterThan(5);
      expect(rows[T - 1].soc_percent).toBeLessThan(15);
    });
  });
});
