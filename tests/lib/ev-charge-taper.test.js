// @ts-nocheck
/**
 * EV charge-acceptance taper (forecast-only). The learned `evChargeThresholds`
 * reduce the planned EV charge power as EV SoC rises, mirroring the home-battery CV
 * taper but keyed on the EV SoC variable. The critical property — because the test
 * charger is forced-rate (evMin == evMax, like a 16 A-only Tesla) — is that the taper
 * makes the car charge SLOWER near full, not stop entirely (which a max-only cap
 * would, by making min > max infeasible).
 *
 * Prices are ascending so charging front-loads into a unique, contiguous block —
 * this kills MIP symmetry and keeps the forced-rate solve fast.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

const T = 16;
const base = {
  load_W: Array(T).fill(400),
  pv_W: Array(T).fill(0),
  importPrice: Array.from({ length: T }, (_, t) => 5 + t), // ascending → charge ASAP
  exportPrice: Array(T).fill(1),
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 30000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  initialSoc_percent: 50,
};

// Forced-rate charger: evMin == evMax == 11040 W (16 A × 3φ × 230 V), 60 kWh pack.
const evForced = {
  evMinChargePower_W: 11040,
  evMaxChargePower_W: 11040,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 75,
  evTargetSoc_percent: 92,
  evDepartureSlot: T,
  evChargeEfficiency_percent: 90,
  evChargePhases: 3,
};

// Taper: ≥80% SoC → 5 kW, ≥90% SoC → 2 kW.
const taper = [
  { soc_percent: 80, maxChargePower_W: 5000 },
  { soc_percent: 90, maxChargePower_W: 2000 },
];

const OPTS = { startMs: 0, stepMin: 15 };
const GAPS = { mip_rel_gap: 0.02, mip_abs_gap: 0.5 };

/** Start-of-slot EV SoC for row i. */
function startSoc(rows, i, cfg) {
  return i === 0 ? cfg.ev.evInitialSoc_percent : rows[i - 1].ev_soc_percent;
}

describe('EV charge-acceptance taper', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('caps planned EV charge to the tapered rate above each SoC threshold', () => {
    const cfg = { ...base, ev: { ...evForced, evChargeThresholds: taper } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);

    for (let i = 0; i < rows.length; i++) {
      const soc = startSoc(rows, i, cfg);
      if (soc >= 90) {
        expect(rows[i].ev_charge).toBeLessThanOrEqual(2000 + 50);
      } else if (soc >= 80) {
        expect(rows[i].ev_charge).toBeLessThanOrEqual(5000 + 50);
      }
    }
  });

  it('keeps charging through the taper (slowdown, not cutoff) and stays feasible', () => {
    const cfg = { ...base, ev: { ...evForced, evChargeThresholds: taper } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);

    // The car must climb past BOTH thresholds — proving the forced-rate charger
    // still charges at the reduced rate rather than stalling at min > max.
    expect(rows[rows.length - 1].ev_soc_percent).toBeGreaterThan(90);
    // And it actually charges in a high-SoC slot (start SoC ≥ 90) at the low rate.
    const highSocCharging = rows.some((r, i) => startSoc(rows, i, cfg) >= 90 && r.ev_charge > 100);
    expect(highSocCharging).toBe(true);
  });

  it('without thresholds the car charges at the full forced rate near full', () => {
    const cfg = { ...base, ev: { ...evForced } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);

    // At least one slot above 80% draws well above the tapered 5 kW cap — confirming
    // the flat behaviour is unchanged when no taper is supplied.
    const fastHighSoc = rows.some((r, i) => startSoc(rows, i, cfg) >= 80 && r.ev_charge > 8000);
    expect(fastHighSoc).toBe(true);
  });
});
