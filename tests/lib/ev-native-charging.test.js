// @ts-nocheck
import { describe, it, expect, beforeAll } from 'vitest';
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

const T = 8;
const base = {
  load_W: Array(T).fill(400),
  pv_W: Array(T).fill(0),
  importPrice: Array(T).fill(20),
  exportPrice: Array(T).fill(5),
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 30000, // generous so the EV charger never starves the house
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  initialSoc_percent: 50,
};

// 16 A × 3 phase × 230 V = 11040 W; 60 kWh pack; 90% onboard charger.
const evBase = {
  evMinChargePower_W: 1380,
  evMaxChargePower_W: 11040,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 50, // 30 000 Wh
  evTargetSoc_percent: 80,  // 48 000 Wh → 18 000 Wh deficit
  evDepartureSlot: 8,
  evChargeEfficiency_percent: 90,
  evChargePhases: 3,
};

const OPTS = { startMs: 0, stepMin: 15 };
const GAPS = { mip_rel_gap: 0.001, mip_abs_gap: 0.01 };

describe('EV native charging — soft target', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('meets the target when cheap slots are sufficient', () => {
    const result = highs.solve(buildLP({ ...base, ev: { ...evBase } }), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, { ...base, ev: { ...evBase } }, OPTS);
    const dep = rows[7]; // depSlot - 1
    expect(dep.ev_soc_percent).toBeGreaterThan(79.5);
    expect(dep.ev_target_met).toBe(true);
    expect(dep.ev_target_shortfall_Wh).toBeLessThan(2);
  });

  it('anchors the SoC trajectory to the initial SoC for a small deficit (78% -> 80%)', () => {
    // Regression for the "EV SoC graph shows 0% while the car is at 78%" report:
    // when the EV is in the plan, the SoC series must START at the real initial
    // SoC, never 0. (A 0 in production means the EV was excluded from the plan.)
    const cfg = {
      ...base,
      ev: { ...evBase, evBatteryCapacity_Wh: 75000, evInitialSoc_percent: 78, evTargetSoc_percent: 80 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[0].ev_soc_percent).toBeGreaterThan(77.5); // starts at ~78, NOT 0
    expect(rows[7].ev_soc_percent).toBeGreaterThan(79.5); // reaches the 80% target
    expect(rows.some(r => r.ev_charge > 1)).toBe(true);   // a (small) charge is planned
  });

  it('stays FEASIBLE with a shortfall when the price mask leaves too few slots', () => {
    // Only slots 0,1 are below the 10 c€ ceiling; the rest are masked. Two slots
    // cannot deliver the 18 kWh deficit, so the (soft) target is missed — but the
    // LP must remain feasible (the old hard cardinality bound went infeasible).
    const cfg = {
      ...base,
      importPrice: [5, 5, 50, 50, 50, 50, 50, 50],
      ev: { ...evBase, evApplyPriceLimit: true, evMaxPrice_cents_per_kWh: 10 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[7].ev_target_met).toBe(false);
    expect(rows[7].ev_target_shortfall_Wh).toBeGreaterThan(0);
    // Masked slots (2..7) carry no EV charge.
    for (let t = 2; t < 8; t++) expect(rows[t].ev_charge).toBeLessThan(1);
    // Unmasked slots charged.
    expect(rows[0].ev_charge + rows[1].ev_charge).toBeGreaterThan(100);
  });

  it('reports NOT met when the requested target exceeds what is reachable', () => {
    // 2 slots available, 18 kWh deficit — unreachable. Guards the removed
    // achievableTargetWh clamp that used to mask the shortfall as "met".
    const cfg = { ...base, ev: { ...evBase, evDepartureSlot: 2 } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[1].ev_target_met).toBe(false);
    expect(rows[1].ev_target_shortfall_Wh).toBeGreaterThan(1000);
  });
});

describe('EV native charging — masks', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('earliest-start window masks slots before the start slot', () => {
    const cfg = { ...base, ev: { ...evBase, evStartSlot: 4 } };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    for (let t = 0; t < 4; t++) expect(rows[t].ev_charge).toBeLessThan(1);
    expect(rows.slice(4).reduce((s, r) => s + r.ev_charge, 0)).toBeGreaterThan(100);
  });

  it('price-limit masks over-ceiling slots for normal charging', () => {
    const cfg = {
      ...base,
      importPrice: [5, 50, 5, 50, 5, 50, 5, 50],
      ev: { ...evBase, evApplyPriceLimit: true, evMaxPrice_cents_per_kWh: 10 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    for (let t = 1; t < 8; t += 2) expect(rows[t].ev_charge).toBeLessThan(1);
  });
});

describe('EV native charging — minimum-SoC floor', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('reaches the floor even when every slot is over the price limit (mask-exempt)', () => {
    // evMaxPrice = 0 masks ALL slots (prices are 20). Floor 60% (36 kWh) is above
    // the 50% start, so the mask-exempt floor flow must still reach it.
    const cfg = {
      ...base,
      ev: {
        ...evBase,
        evApplyPriceLimit: true,
        evMaxPrice_cents_per_kWh: 0,
        evMinSocFloor_percent: 60,
      },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    // Reaches the floor (~60%) but NOT the masked target (80%).
    expect(rows[7].ev_soc_percent).toBeGreaterThan(59);
    expect(rows[7].ev_soc_percent).toBeLessThan(70);
    // Floor charging is labelled min_soc.
    expect(rows.some(r => r.ev_plan_mode === 'min_soc' && r.ev_charge > 1)).toBe(true);
  });

  it('floor caps at the deficit — does NOT bypass the mask to hit the target', () => {
    const cfg = {
      ...base,
      ev: {
        ...evBase,
        evApplyPriceLimit: true,
        evMaxPrice_cents_per_kWh: 0,
        evMinSocFloor_percent: 60,
      },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    const rows = parseSolution(result, cfg, OPTS);
    // Floor delivers ~6 kWh (50→60%); never the 18 kWh needed for the target.
    const evWh = rows.reduce((s, r) => s + r.ev_charge * 0.25, 0);
    expect(evWh).toBeGreaterThan(5000);
    expect(evWh).toBeLessThan(9000);
  });

  it('min-SoC at/above target is price-exempt by design (safety floor independent of price)', () => {
    // A min-SoC equal to the target, with a price limit masking ALL slots. The
    // floor is a HARD safety floor independent of price, so it reaches that SoC
    // even through masked (expensive) slots — the price limit governs only
    // charging ABOVE the floor, of which there is none here. This is intended:
    // min-SoC means "I must have this SoC regardless of price".
    const cfg = {
      ...base,
      ev: {
        ...evBase,
        evTargetSoc_percent: 60,
        evApplyPriceLimit: true,
        evMaxPrice_cents_per_kWh: 0, // masks every slot (prices are 20)
        evMinSocFloor_percent: 60,   // == target
      },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[7].ev_soc_percent).toBeGreaterThan(59);
    expect(rows[7].ev_target_met).toBe(true);
  });

  it('stays FEASIBLE when the floor is physically unreachable', () => {
    // Tiny grid cap + no PV → the floor cannot be reached, but the SOFT floor
    // keeps the LP feasible (shortfall absorbs the gap).
    const cfg = {
      ...base,
      maxGridImport_W: 500,
      ev: { ...evBase, evMinSocFloor_percent: 90 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[7].ev_soc_percent).toBeLessThan(90);
  });
});

describe('EV native charging — opportunistic band', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('tops up beyond target from surplus PV', () => {
    // Big PV surplus, low export price → storing in the EV beats exporting.
    const cfg = {
      ...base,
      pv_W: Array(T).fill(20000),
      importPrice: Array(T).fill(20),
      exportPrice: Array(T).fill(1),
      ev: { ...evBase, evTargetSoc_percent: 60, evOpportunisticCap_percent: 100 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[7].ev_soc_percent).toBeGreaterThan(64); // above the 60% target
    expect(rows.some(r => r.ev_plan_mode === 'opportunistic')).toBe(true);
  });

  it('does NOT top up beyond target from grid (no surplus)', () => {
    const cfg = {
      ...base,
      pv_W: Array(T).fill(0),
      ev: { ...evBase, evTargetSoc_percent: 60, evOpportunisticCap_percent: 100 },
    };
    const result = highs.solve(buildLP(cfg), GAPS);
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, OPTS);
    expect(rows[7].ev_soc_percent).toBeLessThan(61); // stops at the 60% target
  });
});

describe('EV native charging — continuity + three-phase', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('emits transition vars and stays feasible with evContinuous', () => {
    const cfg = { ...base, ev: { ...evBase, evContinuous: true } };
    const lp = buildLP(cfg);
    expect(lp).toContain('c_ev_trans_a_1');
    const result = highs.solve(lp, GAPS);
    expect(result.Status).toBe('Optimal');
  });

  it('three-phase charger: max power maps back to ~16 A; single-phase ~3× the amps', () => {
    const cfg3 = { ...base, ev: { ...evBase, evChargePhases: 3 } };
    const r3 = parseSolution(highs.solve(buildLP(cfg3), GAPS), cfg3, OPTS);
    const charging3 = r3.find(r => r.ev_charge > 5000);
    expect(charging3.ev_charge_A).toBeGreaterThan(14);
    expect(charging3.ev_charge_A).toBeLessThan(18);

    // Same power, single-phase config → ~3× the amps reported.
    const cfg1 = { ...base, ev: { ...evBase, evChargePhases: 1 } };
    const r1 = parseSolution(highs.solve(buildLP(cfg1), GAPS), cfg1, OPTS);
    const charging1 = r1.find(r => r.ev_charge > 5000);
    expect(charging1.ev_charge_A).toBeGreaterThan(charging3.ev_charge_A * 2.5);
  });
});

describe('EV opportunistic bands + degenerate efficiency (LP construction)', () => {
  it('emits a second opportunistic band only when a type-2 cap above the type-1 cap is set', () => {
    // target 80% (48 000 Wh), band-1 cap 90% (54 000 Wh), band-2 cap 100% (60 000 Wh).
    const withBand2 = buildLP({
      ...base,
      ev: { ...evBase, evOpportunisticCap_percent: 90, evOpportunisticType2Cap_percent: 100 },
    });
    expect(withBand2).toContain('ev_opp_band2');
    // band-2 width = cap2 - cap1 = 60 000 - 54 000 = 6000 Wh upper bound.
    expect(withBand2).toMatch(/ev_opp_band2 <= 6000\b/);

    // Without a type-2 cap, only the first band exists.
    const band1Only = buildLP({
      ...base,
      ev: { ...evBase, evOpportunisticCap_percent: 90 },
    });
    expect(band1Only).toContain('ev_opp_band');
    expect(band1Only).not.toContain('ev_opp_band2');
  });

  it('builds a finite LP when EV charge efficiency is 0 (no divide-by-zero)', () => {
    // eta_ev = 0 ⇒ evChargeWhPerW = 0; the per-Wh cost guards must avoid 1/0.
    const lp = buildLP({ ...base, ev: { ...evBase, evChargeEfficiency_percent: 0 } });
    expect(typeof lp).toBe('string');
    expect(lp.length).toBeGreaterThan(0);
    expect(lp).not.toMatch(/Infinity|NaN/);
  });
});
