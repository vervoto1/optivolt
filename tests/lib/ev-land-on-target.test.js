// @ts-nocheck
/**
 * Target-landing for a forced-rate EV charger. A 16 A-only charger (evMin == evMax)
 * can only move SoC in whole 15-min slot chunks, so meeting the soft target floor
 * used to force a full slot that OVERSHOOTS the target (e.g. land on 83% for an 80%
 * target). The target-landing relaxation lets the single crossing slot charge
 * partially, so the plan lands ON the target instead of stepping past it.
 *
 * Ascending prices front-load charging into a unique contiguous block (kills MIP
 * symmetry, keeps the forced-rate solve fast).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

const T = 12;
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

// Forced-rate charger: evMin == evMax == 11040 W. 75 kWh pack ⇒ one full slot adds
// 11040 × (0.25 h × 0.9) / 75000 ≈ 3.31% — so 80% is NOT reachable on a slot boundary
// from 72% (72 → 75.31 → 78.62 → would overshoot to ~81.9% without the relaxation).
const evForced = {
  evMinChargePower_W: 11040,
  evMaxChargePower_W: 11040,
  evBatteryCapacity_Wh: 75000,
  evInitialSoc_percent: 72,
  evTargetSoc_percent: 80,
  evDepartureSlot: T,
  evChargeEfficiency_percent: 90,
  evChargePhases: 3,
};

const OPTS = { startMs: 0, stepMin: 15 };
const GAPS = { mip_rel_gap: 0.01, mip_abs_gap: 0.5 };

describe('EV target-landing (forced-rate charger)', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('lands on the target instead of overshooting a full slot', () => {
    const cfg = { ...base, ev: { ...evForced } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);

    const finalSoc = rows[rows.length - 1].ev_soc_percent;
    // Reaches the target...
    expect(finalSoc).toBeGreaterThanOrEqual(79.5);
    // ...without overshooting it by (most of) a full ~3.31% slot.
    expect(finalSoc).toBeLessThanOrEqual(80.6);
  });

  it('lands via full-rate slots + a SINGLE partial top-off (no sub-rate dribble)', () => {
    const cfg = { ...base, ev: { ...evForced } };
    const result = highs.solve(buildLP(cfg), GAPS);
    const rows = parseSolution(result, cfg, OPTS);

    const FULL = evForced.evMaxChargePower_W;
    // Classify each charging slot: full (≈ forced rate), partial, or off.
    const partial = rows.filter(r => r.ev_charge > 50 && r.ev_charge < FULL - 50);
    const full = rows.filter(r => r.ev_charge >= FULL - 50);
    // The charger runs at its forced rate, then takes at most ONE partial slot to
    // top off onto the target — never a trickle smeared across several slots.
    expect(partial.length).toBeLessThanOrEqual(1);
    expect(full.length).toBeGreaterThanOrEqual(1);
  });

  it('still charges at the full forced rate well below the target', () => {
    const cfg = { ...base, ev: { ...evForced } };
    const result = highs.solve(buildLP(cfg), GAPS);
    const rows = parseSolution(result, cfg, OPTS);
    // The relaxation only applies within one slot of the target; earlier slots still
    // charge at the full forced 11 kW.
    const fullEarly = rows.some((r, i) => {
      const startSoc = i === 0 ? cfg.ev.evInitialSoc_percent : rows[i - 1].ev_soc_percent;
      return startSoc < 76 && r.ev_charge > 10000;
    });
    expect(fullEarly).toBe(true);
  });
});
