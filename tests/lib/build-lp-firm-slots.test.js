import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildLP,
  resolveFirmSlots,
  resolveRebalanceWindow,
  isRebalanceHoldDeferred,
  isEvPlannedInLp,
  evModelEnd,
} from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import { extendedSolveOptions, solveOptionsFor } from '../../lib/solve-options.ts';
// @ts-ignore
import highsFactory from '../../vendor/highs-build/highs.js';

// Multi-day horizon (plans/multi-day-horizon-plan.md, "LP (lib/build-lp.ts),
// all gated on firmSlots < T"): slots t >= firmSlots are priced with forecast
// prices and never executed. Everything here is gated on firmSlots < T; the
// byte-identity of the LP without firmSlots is pinned by lp-golden.test.js.

// ---------------------------------------------------------------- helpers ---

/** The `obj:` line's coefficient of `name` (signed), or undefined when absent. */
function objCoeff(lp, name) {
  const obj = lp.split('\n').find(l => l.startsWith(' obj:'));
  const m = new RegExp(`([+-]) (\\S+) ${name}(?= |$)`).exec(obj);
  return m ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : undefined;
}

/** The text of constraint row `name` (after "name: "), or undefined. */
function row(lp, name) {
  const line = lp.split('\n').find(l => l.startsWith(` ${name}: `));
  return line?.slice(name.length + 3);
}

/** Names declared in the Binaries section. */
function binaries(lp) {
  const m = /\nBinaries\n([\s\S]*?)\n\n/.exec(lp);
  return m ? m[1].split('\n').map(s => s.trim()) : [];
}

/** Lines of the Bounds section. */
function bounds(lp) {
  const m = /\nBounds\n([\s\S]*?)\n\n/.exec(lp);
  return m[1].split('\n').map(s => s.trim());
}

const slotIndex = name => Number(/_(\d+)$/.exec(name)[1]);

/** True when any token `<prefix><index>` with index >= from appears in the LP. */
function hasIndexedFrom(lp, prefix, from) {
  const re = new RegExp(`\\b${prefix}(\\d+)\\b`, 'g');
  for (const m of lp.matchAll(re)) if (Number(m[1]) >= from) return true;
  return false;
}

const T = 48;
const F = 20;

function base(extra = {}) {
  return {
    load_W: Array(T).fill(500),
    pv_W: Array.from({ length: T }, (_, t) => (t % 24 >= 8 && t % 24 < 14 ? 3000 : 0)),
    importPrice: Array(T).fill(20),
    exportPrice: Array(T).fill(15),
    stepSize_m: 60,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 4000,
    maxDischargePower_W: 4000,
    maxGridImport_W: 10000,
    maxGridExport_W: 10000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    inverterEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 1,
    idleDrain_W: 40,
    terminalSocValuation: 'zero',
    terminalSocCustomPrice_cents_per_kWh: 0,
    initialSoc_percent: 50,
    ...extra,
  };
}

const CV = [
  { soc_percent: 80, maxChargePower_W: 3000 },
  { soc_percent: 90, maxChargePower_W: 3200 }, // non-monotone: a later threshold raising the cap
  { soc_percent: 95, maxChargePower_W: 1000 },
];
const DP = [
  { soc_percent: 20, maxDischargePower_W: 2500 },
  { soc_percent: 12, maxDischargePower_W: 3000 }, // non-monotone
];
const EV = {
  evMinChargePower_W: 1380,
  evMaxChargePower_W: 7360,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 40,
  evTargetSoc_percent: 80,
  evDepartureSlot: 15,
  evChargeEfficiency_percent: 90,
};

/** Every config the structure tests reuse: all binary families at once. */
const everything = (extra = {}) => base({
  cvPhaseThresholds: CV,
  dischargePhaseThresholds: DP,
  minSoc_percent: 10,
  initialSoc_percent: 6, // floor ratchet
  rebalanceHoldSlots: 4,
  rebalanceRemainingSlots: 4,
  rebalanceTargetSoc_percent: 100,
  ev: { ...EV, evContinuous: true, evMinSocFloor_percent: 50, evOpportunisticCap_percent: 90 },
  ...extra,
});

// ----------------------------------------------------- boundary resolution ---

describe('resolveFirmSlots', () => {
  it('is T when absent or non-finite, and truncates/clamps to [1, T] otherwise', () => {
    expect(resolveFirmSlots(undefined, 10)).toBe(10);
    expect(resolveFirmSlots(Number.NaN, 10)).toBe(10);
    expect(resolveFirmSlots(Infinity, 10)).toBe(10);
    expect(resolveFirmSlots(25, 10)).toBe(10);
    expect(resolveFirmSlots(4.9, 10)).toBe(4);
    expect(resolveFirmSlots(0, 10)).toBe(1);
    expect(resolveFirmSlots(-3, 10)).toBe(1);
  });
});

describe('buildLP — firmSlots absent or >= T leaves the LP unchanged', () => {
  it.each([
    ['absent', undefined],
    ['= T', T],
    ['> T', T + 7],
    ['NaN', Number.NaN],
  ])('firmSlots %s', (_label, firmSlots) => {
    const cfg = everything();
    const plain = buildLP(cfg);
    // socRef and the margin are ignored without a forecast part.
    expect(buildLP({ ...cfg, firmSlots, socRef_Wh: 5000, carryOverMargin_cents_per_kWh: 1 })).toBe(plain);
  });
});

// ------------------------------------------------------------- structure ---

describe('buildLP — forecast slots carry no binaries', () => {
  const lp = buildLP(everything({ firmSlots: F }));

  it('declares no binary indexed at or after firmSlots', () => {
    const names = binaries(lp);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(slotIndex(name), name).toBeLessThan(F);
    // ...while every firm slot keeps its binaries.
    for (const prefix of ['battery_charging_', 'cv_0_', 'cv_2_', 'dp_1_', 'floor_recovered_', 'ev_on_']) {
      expect(names).toContain(`${prefix}${F - 1}`);
    }
  });

  it('bounds the relaxed direction and CV/DP indicators to [0, 1] in forecast slots only', () => {
    const b = bounds(lp);
    for (const t of [F, T - 1]) {
      expect(b).toContain(`0 <= battery_charging_${t} <= 1`);
      for (const k of [0, 1, 2]) expect(b).toContain(`0 <= cv_${k}_${t} <= 1`);
      for (const k of [0, 1]) expect(b).toContain(`0 <= dp_${k}_${t} <= 1`);
    }
    expect(b).not.toContain(`0 <= battery_charging_${F - 1} <= 1`);
    // The mode rows stay in place for forecast slots (continuous indicator).
    expect(row(lp, `c_battery_charge_mode_${F}`)).toContain(`battery_charging_${F}`);
    expect(row(lp, `c_battery_discharge_mode_${F}`)).toContain(`battery_charging_${F}`);
  });

  it('keeps the CV/DP forward rows and drops the reverse rows in forecast slots', () => {
    expect(row(lp, `c_cv_0_${F}`)).toBe(`soc_${F - 1} - 2000 cv_0_${F} <= 8000`);
    expect(row(lp, `c_cv_rev_0_${F}`)).toBeUndefined();
    expect(row(lp, `c_cv_rev_0_${F - 1}`)).toBeDefined();
    expect(row(lp, `c_dp_0_${F}`)).toBe(`- soc_${F - 1} - 2000 dp_0_${F} <= -2000`);
    expect(row(lp, `c_dp_rev_0_${F}`)).toBeUndefined();
    expect(row(lp, `c_dp_rev_0_${F - 1}`)).toBeDefined();
  });

  it('uses running-minimum taper powers in forecast slots only (every step >= 0)', () => {
    // Firm: steps 4000→3000→3200→1000 = 1000, -200, 2200 (as configured).
    expect(row(lp, `c_charge_cap_${F - 1}`)).toContain(`+ 1000 cv_0_${F - 1} + -200 cv_1_${F - 1} + 2200 cv_2_${F - 1} <= 4000`);
    // Forecast: running min 3000, 3000, 1000 → steps 1000, 0, 2000 (concave cap).
    expect(row(lp, `c_charge_cap_${F}`)).toContain(`+ 1000 cv_0_${F} + 0 cv_1_${F} + 2000 cv_2_${F} <= 4000`);
    // Discharge: 4000→2500→3000 = 1500, -500 firm; 1500, 0 forecast.
    expect(row(lp, `c_discharge_cap_${F - 1}`)).toContain(`+ 1500 dp_0_${F - 1} + -500 dp_1_${F - 1} <= 4000`);
    expect(row(lp, `c_discharge_cap_${F}`)).toContain(`+ 1500 dp_0_${F} + 0 dp_1_${F} <= 4000`);
  });
});

describe('buildLP — slot-indexed tie-breaks are capped at firmSlots − 1', () => {
  const cfg = base({ ev: { ...EV, evDepartureSlot: T + 1 } });
  const plain = buildLP(cfg);
  const ext = buildLP({ ...cfg, firmSlots: F });

  it.each(['grid_to_battery_', 'battery_to_grid_', 'pv_to_battery_'])('%s', (prefix) => {
    // Flat prices: the coefficient differs between slots only by the tie-break.
    expect(objCoeff(ext, `${prefix}${F}`)).toBe(objCoeff(ext, `${prefix}${F - 1}`));
    expect(objCoeff(ext, `${prefix}${T - 1}`)).toBe(objCoeff(ext, `${prefix}${F - 1}`));
    // Firm slots keep their escalating tie-break, and the plain LP keeps growing.
    expect(objCoeff(ext, `${prefix}${F - 1}`)).toBe(objCoeff(plain, `${prefix}${F - 1}`));
    expect(objCoeff(ext, `${prefix}${F - 2}`)).toBe(objCoeff(plain, `${prefix}${F - 2}`));
    expect(objCoeff(plain, `${prefix}${T - 1}`)).toBeGreaterThan(objCoeff(plain, `${prefix}${F - 1}`));
  });

  it('applies the EV tie-break in firm slots only (no EV flows past the boundary)', () => {
    expect(objCoeff(ext, `grid_to_ev_${F - 1}`)).toBe(objCoeff(plain, `grid_to_ev_${F - 1}`));
    expect(objCoeff(ext, `grid_to_ev_${F}`)).toBeUndefined();
  });
});

describe('buildLP — floor ratchet past the boundary', () => {
  // 10 kWh, minSoc 10 % = 1000 Wh, initial 6 % = 600 Wh → shortfall 400 Wh;
  // idle drain 40 Wh per 60-min slot. allowance(t) = 400 + 40·(t+1).
  const lp = buildLP(base({ initialSoc_percent: 6, firmSlots: F }));

  it('keeps the growing allowance and the latch in firm slots', () => {
    expect(row(lp, `c_min_soc_${F - 1}`)).toBe(`soc_shortfall_${F - 1} + soc_${F - 1} - 1200 floor_recovered_${F - 1} >= -200`);
    expect(row(lp, `c_floor_rec_${F - 1}`)).toBeDefined();
    expect(row(lp, `c_floor_rec_mono_${F - 1}`)).toBeDefined();
  });

  it('keeps growing the allowance past the boundary, gated by floor_recovered_{F−1}', () => {
    for (const t of [F, F + 1, T - 1]) {
      const allowance = 400 + 40 * (t + 1);
      expect(row(lp, `c_min_soc_${t}`)).toBe(`soc_shortfall_${t} + soc_${t} - ${allowance} floor_recovered_${F - 1} >= ${1000 - allowance}`);
      expect(row(lp, `c_floor_rec_${t}`)).toBeUndefined();
      expect(row(lp, `c_floor_rec_mono_${t}`)).toBeUndefined();
    }
    expect(hasIndexedFrom(lp, 'floor_recovered_', F)).toBe(false);
  });
});

describe('buildLP — rebalance window stays in the firm part', () => {
  const reb = (extra) => base({ rebalanceHoldSlots: 4, rebalanceRemainingSlots: 4, rebalanceTargetSoc_percent: 100, firmSlots: F, ...extra });
  const starts = lp => binaries(lp).filter(n => n.startsWith('start_balance_')).map(slotIndex);

  it('caps the latest start at firmSlots − D', () => {
    const lp = buildLP(reb());
    expect(starts(lp)).toEqual(Array.from({ length: F - 4 + 1 }, (_, k) => k));
    expect(row(lp, 'c_balance_start')).toMatch(new RegExp(`start_balance_${F - 4} = 1$`));
    // The forcing rows end with the last firm slot.
    expect(row(lp, `c_rebalance_${F - 1}`)).toBeDefined();
    expect(row(lp, `c_rebalance_${F}`)).toBeUndefined();
  });

  it('takes the smaller of the pin and firmSlots − D', () => {
    expect(Math.max(...starts(buildLP(reb({ rebalanceMaxStartSlot: 6 }))))).toBe(6);
    expect(Math.max(...starts(buildLP(reb({ rebalanceMaxStartSlot: 30 }))))).toBe(F - 4);
  });

  it('fixes the start when rebalanceMinStartSlot equals the pin', () => {
    const lp = buildLP(reb({ rebalanceMaxStartSlot: 6, rebalanceMinStartSlot: 6 }));
    expect(starts(lp)).toEqual([6]);
    expect(row(lp, 'c_balance_start')).toBe('start_balance_6 = 1');
    expect(row(lp, 'c_rebalance_5')).toBeUndefined();
    expect(row(lp, 'c_rebalance_6')).toBe('soc_6 - 10000 start_balance_6 >= 0');
    expect(row(lp, 'c_rebalance_9')).toBe('soc_9 - 10000 start_balance_6 >= 0');
    expect(row(lp, 'c_rebalance_10')).toBeUndefined();
    expect(objCoeff(lp, 'start_balance_6')).toBeCloseTo(7e-6, 12);
  });

  it('defers a hold that does not fit in the firm part (no hold variables)', () => {
    for (const pin of [undefined, 3]) {
      const cfg = reb({ rebalanceRemainingSlots: F + 2, rebalanceMaxStartSlot: pin });
      const lp = buildLP(cfg);
      expect(lp).not.toContain('start_balance_');
      expect(lp).not.toContain('c_rebalance_');
      expect(isRebalanceHoldDeferred(cfg)).toBe(true);
    }
  });

  it('keeps a slot-0 pin when the hold does not fit (a started hold runs on past the boundary)', () => {
    const cfg = reb({ rebalanceRemainingSlots: F + 2, rebalanceMaxStartSlot: 0 });
    const lp = buildLP(cfg);
    expect(starts(lp)).toEqual([0]);
    expect(row(lp, `c_rebalance_${F + 1}`)).toBe(`soc_${F + 1} - 10000 start_balance_0 >= 0`);
    expect(isRebalanceHoldDeferred(cfg)).toBe(false);
  });

  it('isRebalanceHoldDeferred is false without a forecast part or a hold', () => {
    expect(isRebalanceHoldDeferred(base({ rebalanceRemainingSlots: T + 5 }))).toBe(false);
    expect(isRebalanceHoldDeferred(base({ firmSlots: F }))).toBe(false);
  });

  it('resolveRebalanceWindow matches the single-horizon rule when F is omitted', () => {
    expect(resolveRebalanceWindow({ T: 10, rebalanceRemainingSlots: 4 })).toEqual({ D: 4, KMIN: 0, KMAX: 6, deferred: false });
    expect(resolveRebalanceWindow({ T: 10, rebalanceRemainingSlots: 4, rebalanceMaxStartSlot: -2 })).toEqual({ D: 4, KMIN: 0, KMAX: 0, deferred: false });
    // KMIN is clamped into [0, KMAX].
    expect(resolveRebalanceWindow({ T: 10, rebalanceRemainingSlots: 4, rebalanceMinStartSlot: 9 })).toEqual({ D: 4, KMIN: 6, KMAX: 6, deferred: false });
    expect(resolveRebalanceWindow({ T: 10, F: 3, rebalanceRemainingSlots: 4, rebalanceMaxStartSlot: 2 })).toEqual({ D: 0, KMIN: 0, KMAX: 2, deferred: true });
  });
});

describe('buildLP — EV confined to the firm part', () => {
  /** The LP of the same config cut to its first F slots (the firm-only LP). */
  const firmOnly = cfg => buildLP({
    ...cfg,
    load_W: cfg.load_W.slice(0, F),
    pv_W: cfg.pv_W.slice(0, F),
    importPrice: cfg.importPrice.slice(0, F),
    exportPrice: cfg.exportPrice.slice(0, F),
    firmSlots: undefined,
  });
  const evLines = lp => lp.split('\n').filter(l => /\bev_|_ev_|_to_ev/.test(l) && !l.startsWith(' obj:'));
  const evObj = lp => {
    const obj = lp.split('\n').find(l => l.startsWith(' obj:'));
    return [...obj.matchAll(/([+-] \S+ (?:\S*ev\S*))(?= |$)/g)].map(m => m[1]);
  };

  it.each([
    ['continuous, floor, opportunistic band, departure inside', { ...EV, evContinuous: true, evMinSocFloor_percent: 50, evOpportunisticCap_percent: 90, evOpportunisticType2Cap_percent: 95 }],
    ['taper thresholds, start slot, price limit', { ...EV, evStartSlot: 2, evApplyPriceLimit: true, evMaxPrice_cents_per_kWh: 25, evChargeThresholds: [{ soc_percent: 70, maxChargePower_W: 3680 }] }],
    ['departure past the firm part (clamped, no target)', { ...EV, evDepartureSlot: 40 }],
    ['no departure', { ...EV, evDepartureSlot: undefined }],
  ])('emits exactly the firm-only EV model: %s', (_label, ev) => {
    // Forecast prices far outside the firm range: BIG_PENALTY and the
    // opportunistic reward (cheapest charge cost) must be computed over firm
    // slots only, so they must not move.
    const cfg = base({
      ev,
      importPrice: Array.from({ length: T }, (_, t) => (t < F ? 20 + (t % 3) : (t % 2 ? 900 : -50))),
      exportPrice: Array.from({ length: T }, (_, t) => (t < F ? 15 : -60)),
    });
    const ext = buildLP({ ...cfg, firmSlots: F });
    const ref = firmOnly(cfg);
    expect(evLines(ext)).toEqual(evLines(ref));
    expect(evObj(ext)).toEqual(evObj(ref));
    expect(evLines(ext).length).toBeGreaterThan(0);
    for (const prefix of ['ev_on_', 'ev_soc_', 'grid_to_ev_', 'pv_to_ev_', 'battery_to_ev_', 'ev_trans_', 'ev_cv_', 'ev_tgt_', 'ev_floor_shortfall_']) {
      expect(hasIndexedFrom(ext, prefix, F), prefix).toBe(false);
    }
  });

  it('enforces the target only when the departure lies within the firm part', () => {
    expect(row(buildLP(base({ ev: EV, firmSlots: F })), 'c_ev_target')).toBe('ev_soc_14 + ev_target_shortfall >= 48000');
    expect(row(buildLP(base({ ev: { ...EV, evDepartureSlot: F + 1 }, firmSlots: F })), 'c_ev_target')).toBeUndefined();
    // Without firmSlots, the same departure is enforced at slot F.
    expect(row(buildLP(base({ ev: { ...EV, evDepartureSlot: F + 1 } })), 'c_ev_target')).toBe(`ev_soc_${F} + ev_target_shortfall >= 48000`);
  });

  it('drops the EV entirely when its earliest start is at or after firmSlots', () => {
    const cfg = base({ ev: { ...EV, evStartSlot: F, evDepartureSlot: 40 }, firmSlots: F });
    expect(isEvPlannedInLp(cfg)).toBe(false);
    const lp = buildLP(cfg);
    expect(lp).not.toMatch(/_ev_|\bev_/);
    // One slot earlier it is modelled; without firmSlots it always is.
    expect(isEvPlannedInLp({ ...cfg, ev: { ...cfg.ev, evStartSlot: F - 1 } })).toBe(true);
    expect(isEvPlannedInLp({ ...cfg, firmSlots: undefined })).toBe(true);
    expect(isEvPlannedInLp(base())).toBe(false);
  });
});

describe('buildLP — EV without a deadline planned through forecast slots (evDeferToForecast)', () => {
  const deferred = (extra = {}) => base({
    ev: { ...EV, evDepartureSlot: T, evDeferToForecast: true },
    firmSlots: F,
    carryOverMargin_cents_per_kWh: 2,
    ...extra,
  });

  it('models the EV over the whole horizon with the target due at the last slot', () => {
    const cfg = deferred();
    expect(evModelEnd(cfg)).toBe(T);
    const lp = buildLP(cfg);
    expect(row(lp, 'c_ev_target')).toBe(`ev_soc_${T - 1} + ev_target_shortfall >= 48000`);
    expect(row(lp, `c_ev_soc_${T - 1}`)).toMatch(new RegExp(`^ev_soc_${T - 1} - ev_soc_${T - 2} `));
    expect(row(lp, `c_pv_split_${F + 3}`)).toContain(`pv_to_ev_${F + 3}`);
    expect(row(lp, `c_grid_import_cap_${T - 1}`)).toContain(`grid_to_ev_${T - 1}`);
    expect(row(lp, `c_discharge_cap_${F}`)).toContain(`battery_to_ev_${F}`);
  });

  it('keeps EV binaries in firm slots and relaxes them to [0, 1] in forecast slots', () => {
    const lp = buildLP(deferred({ ev: { ...EV, evDepartureSlot: T, evDeferToForecast: true, evChargeThresholds: [{ soc_percent: 70, maxChargePower_W: 3680 }] } }));
    const bins = binaries(lp);
    expect(bins).toContain(`ev_on_${F - 1}`);
    expect(bins).toContain(`ev_cv_0_${F - 1}`);
    expect(bins.filter(n => /^ev_/.test(n) && slotIndex(n) >= F)).toEqual([]);
    expect(bounds(lp)).toEqual(expect.arrayContaining([`0 <= ev_on_${F} <= 1`, `0 <= ev_on_${T - 1} <= 1`, `0 <= ev_cv_0_${F} <= 1`]));
    expect(bounds(lp)).not.toContain(`0 <= ev_on_${F - 1} <= 1`);
  });

  it('adds the risk margin to EV charge in forecast slots only and caps the on/off tie-break', () => {
    const lp = buildLP(deferred());
    const noMargin = buildLP(deferred({ carryOverMargin_cents_per_kWh: 0 }));
    // Hourly slots: r = 2 c€/kWh is 0.002 c€ per W over the slot (AC into the charger).
    expect(objCoeff(lp, `grid_to_ev_${F}`) - objCoeff(noMargin, `grid_to_ev_${F}`)).toBeCloseTo(0.002, 12);
    expect(objCoeff(lp, `pv_to_ev_${F}`) - objCoeff(noMargin, `pv_to_ev_${F}`)).toBeCloseTo(0.95 * 0.002, 12);
    expect(objCoeff(lp, `battery_to_ev_${F}`) - objCoeff(noMargin, `battery_to_ev_${F}`)).toBeCloseTo(0.95 * 0.002, 12);
    expect(objCoeff(lp, `grid_to_ev_${F - 1}`)).toBe(objCoeff(noMargin, `grid_to_ev_${F - 1}`));
    expect(objCoeff(lp, `ev_on_${T - 1}`)).toBe(objCoeff(lp, `ev_on_${F - 1}`));
  });

  it('changes nothing without a forecast part', () => {
    const cfg = base({ ev: { ...EV, evDepartureSlot: T } });
    expect(buildLP({ ...cfg, ev: { ...cfg.ev, evDeferToForecast: true } })).toBe(buildLP(cfg));
    expect(evModelEnd({ ...cfg, ev: { ...cfg.ev, evDeferToForecast: true } })).toBe(T);
  });

  it('plans an EV whose earliest start lies in the forecast part', () => {
    const cfg = deferred({ ev: { ...EV, evStartSlot: F + 2, evDepartureSlot: T, evDeferToForecast: true } });
    expect(isEvPlannedInLp(cfg)).toBe(true);
    expect(isEvPlannedInLp({ ...cfg, ev: { ...cfg.ev, evDeferToForecast: false } })).toBe(false);
  });
});

describe('buildLP — carry-over dead-band', () => {
  it('ties carry_dev_pos − carry_dev_neg to soc_{F−1} − socRef_Wh at r/1000 c€ per Wh', () => {
    const lp = buildLP(base({ firmSlots: F, socRef_Wh: 4321.5, carryOverMargin_cents_per_kWh: 1.5 }));
    expect(row(lp, 'c_carry_over')).toBe(`soc_${F - 1} - carry_dev_pos + carry_dev_neg = 4321.5`);
    expect(objCoeff(lp, 'carry_dev_pos')).toBe(0.0015);
    expect(objCoeff(lp, 'carry_dev_neg')).toBe(0.0015);
    expect(bounds(lp)).toEqual(expect.arrayContaining(['carry_dev_pos >= 0', 'carry_dev_neg >= 0']));
    // parseSolution reads every soc_* column as SoC: the new names must not be soc_*.
    expect(lp).not.toMatch(/\bsoc_(?!shortfall_)\D/);
  });

  it.each([
    ['no socRef', { carryOverMargin_cents_per_kWh: 1 }],
    ['non-finite socRef', { socRef_Wh: Number.NaN, carryOverMargin_cents_per_kWh: 1 }],
    ['no margin', { socRef_Wh: 5000 }],
    ['zero margin', { socRef_Wh: 5000, carryOverMargin_cents_per_kWh: 0 }],
  ])('is absent with %s', (_label, extra) => {
    expect(buildLP(base({ firmSlots: F, ...extra }))).not.toContain('carry_dev');
  });
});

// ------------------------------------------------------------- behaviour ---

describe('buildLP — multi-day behaviour (HiGHS)', () => {
  let highs;
  beforeAll(async () => {
    highs = await highsFactory({});
  });

  // Hourly slots, a 10 kWh battery, no PV, no wear cost or idle drain; net
  // metering (export = import). The firm day is flat at 30 c, so the
  // firm-only plan (terminal "zero") exports its charge and ends at the floor.
  const FIRM = 12;
  const DAY = 12;
  const plain = (forecastPrice) => ({
    load_W: Array(FIRM + DAY).fill(500),
    pv_W: Array(FIRM + DAY).fill(0),
    importPrice: [...Array(FIRM).fill(30), ...Array(DAY).fill(forecastPrice)],
    exportPrice: [...Array(FIRM).fill(30), ...Array(DAY).fill(forecastPrice)],
    stepSize_m: 60,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 5000,
    maxDischargePower_W: 5000,
    maxGridImport_W: 10000,
    maxGridExport_W: 10000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    inverterEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 0,
    idleDrain_W: 0,
    terminalSocValuation: 'zero',
    terminalSocCustomPrice_cents_per_kWh: 0,
    initialSoc_percent: 80,
  });
  const firmPart = cfg => ({
    ...cfg,
    load_W: cfg.load_W.slice(0, FIRM),
    pv_W: cfg.pv_W.slice(0, FIRM),
    importPrice: cfg.importPrice.slice(0, FIRM),
    exportPrice: cfg.exportPrice.slice(0, FIRM),
  });

  function solve(cfg, options = { mip_rel_gap: 0, mip_abs_gap: 0 }) {
    const result = highs.solve(buildLP(cfg), options);
    expect(result.Status).toBe('Optimal');
    return { result, rows: parseSolution(result, cfg, { startMs: 0, stepMin: 60 }) };
  }

  let firmOnly;
  beforeAll(() => {
    firmOnly = solve(firmPart(plain(30)));
  });
  const socRef = () => firmOnly.rows[FIRM - 1].soc;
  const extended = (forecastPrice, extra = {}) => solve({
    ...plain(forecastPrice),
    firmSlots: FIRM,
    socRef_Wh: socRef(),
    carryOverMargin_cents_per_kWh: 1,
    ...extra,
  });

  it('the firm-only plan drains to the floor', () => {
    expect(socRef()).toBeCloseTo(1000, 0);
  });

  it('an expensive forecast day keeps charge at the boundary', () => {
    const { rows } = extended(60);
    expect(rows[FIRM - 1].soc).toBeGreaterThan(8000);
    expect(rows[FIRM - 1].priceForecast).toBeUndefined();
    expect(rows[FIRM].priceForecast).toBe(true);
    expect(rows[FIRM].ev_soc_percent).toBeNull();
    expect(rows[FIRM - 1].ev_soc_percent).toBe(0);
  });

  it('a cheap forecast day lets it run down', () => {
    const { rows } = extended(10);
    expect(rows[FIRM - 1].soc).toBeCloseTo(socRef(), 0);
  });

  it('a spread smaller than the margin changes nothing, a wider one does', () => {
    // Holding over to 30.5 c gains ~0.45 c per stored kWh (after losses) < r = 1.
    expect(extended(30.5).rows[FIRM - 1].soc).toBeCloseTo(socRef(), 0);
    // Without the margin the same spread is worth carrying over.
    // (It keeps its 8 kWh; buying more at 30 c does not pay after losses.)
    expect(extended(30.5, { carryOverMargin_cents_per_kWh: undefined }).rows[FIRM - 1].soc).toBeCloseTo(8000, 0);
  });

  it('the dead-band works in both directions', () => {
    const cols = r => [r.Columns.carry_dev_pos.Primal, r.Columns.carry_dev_neg.Primal];
    // Above the reference: an expensive day pays more than r → carry_dev_pos > 0.
    const up = extended(60, { socRef_Wh: 5000 });
    expect(up.rows[FIRM - 1].soc).toBeGreaterThan(8000);
    expect(cols(up.result)[0]).toBeGreaterThan(3000);
    expect(cols(up.result)[1]).toBeCloseTo(0, 6);
    // ...unless r outweighs the spread: then it stays on the reference.
    expect(extended(60, { socRef_Wh: 5000, carryOverMargin_cents_per_kWh: 100 }).rows[FIRM - 1].soc).toBeCloseTo(5000, 0);
    // Below the reference: a cheap day makes running down worth more than r → carry_dev_neg > 0.
    const down = extended(10, { socRef_Wh: 5000 });
    expect(down.rows[FIRM - 1].soc).toBeCloseTo(1000, 0);
    expect(cols(down.result)[0]).toBeCloseTo(0, 6);
    expect(cols(down.result)[1]).toBeCloseTo(4000, 0);
    expect(extended(10, { socRef_Wh: 5000, carryOverMargin_cents_per_kWh: 100 }).rows[FIRM - 1].soc).toBeCloseTo(5000, 0);
  });

  it('relaxing the direction binary in forecast slots leaves the plan physical at positive prices', () => {
    const { rows } = extended(60);
    for (const r of rows.slice(FIRM)) {
      const charging = r.g2b + r.pv2b > 1;
      const discharging = r.b2l + r.b2g > 1;
      expect(charging && discharging).toBe(false);
    }
  });
});

// Floor ratchet across the boundary (HiGHS). Hourly slots, a 10 kWh battery,
// minSoc 10 % = 1000 Wh; the battery starts below the floor, so the firm part
// carries the inherited deficit with the binary recovery latch and forecast
// slots reuse floor_recovered_{F−1} with an allowance that keeps growing with
// idle drain.
describe('buildLP — EV without a deadline waits for a cheaper forecast day (HiGHS)', () => {
  let highs;
  beforeAll(async () => {
    highs = await highsFactory({});
  });

  // Hourly slots, a 12-slot firm day at 30 c, a 12-slot forecast day, no PV;
  // the car needs 40 → 80 % of 60 kWh (≈ 26.7 kWh AC, four slots at 7.36 kW).
  const FIRM = 12;
  const N = 24;
  const cfgFor = (forecastPrice, ev) => ({
    load_W: Array(N).fill(500),
    pv_W: Array(N).fill(0),
    importPrice: [...Array(FIRM).fill(30), ...Array(N - FIRM).fill(forecastPrice)],
    exportPrice: Array(N).fill(5),
    stepSize_m: 60,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 5000,
    maxDischargePower_W: 5000,
    maxGridImport_W: 17000,
    maxGridExport_W: 10000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    inverterEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 0,
    idleDrain_W: 0,
    terminalSocValuation: 'zero',
    terminalSocCustomPrice_cents_per_kWh: 0,
    initialSoc_percent: 10,
    firmSlots: FIRM,
    carryOverMargin_cents_per_kWh: 1,
    ev: { ...EV, ...ev },
  });
  const firmDeadline = { evDepartureSlot: FIRM };
  const noDeadline = (n = N) => ({ evDepartureSlot: n, evDeferToForecast: true });

  function solve(cfg) {
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    return parseSolution(result, cfg, { startMs: 0, stepMin: 60 });
  }
  const evKWh = rows => rows.reduce((s, r) => s + r.ev_charge, 0) / 1000;

  it('charges in the firm part when the target is due there', () => {
    const rows = solve(cfgFor(10, firmDeadline));
    expect(evKWh(rows.slice(0, FIRM))).toBeGreaterThan(26);
    expect(evKWh(rows.slice(FIRM))).toBe(0);
    expect(rows[FIRM].ev_soc_percent).toBeNull();
  });

  it('moves the charge to the cheaper forecast day without a deadline', () => {
    const rows = solve(cfgFor(10, noDeadline()));
    expect(evKWh(rows.slice(0, FIRM))).toBeCloseTo(0, 6);
    expect(evKWh(rows.slice(FIRM))).toBeGreaterThan(26);
    expect(rows[N - 1].ev_soc_percent).toBeCloseTo(80, 3);
    expect(rows[N - 1].ev_target_met).toBe(true);
    expect(rows[FIRM - 1].ev_soc_percent).toBeCloseTo(40, 6);
    expect(rows.slice(FIRM).every(r => r.priceForecast)).toBe(true);
  });

  it('keeps charging in the firm part when the forecast saving is within the risk margin', () => {
    expect(evKWh(solve(cfgFor(29.5, noDeadline())).slice(0, FIRM))).toBeGreaterThan(26);
    expect(evKWh(solve(cfgFor(28.5, noDeadline())).slice(0, FIRM))).toBeCloseTo(0, 6);
  });

  it('tops a nearly empty car up to the floor in the firm part and lets the rest wait', () => {
    const rows = solve(cfgFor(10, { ...noDeadline(), evInitialSoc_percent: 10, evMinSocFloor_percent: 20 }));
    // 10 → 20 % of 60 kWh is 6 kWh stored, 6/0.9 ≈ 6.67 kWh AC, from slot 0.
    expect(rows[0].ev_charge).toBeGreaterThan(0);
    expect(rows[FIRM - 1].ev_soc_percent).toBeCloseTo(20, 3);
    expect(evKWh(rows.slice(0, FIRM))).toBeCloseTo(6 / 0.9, 2);
    expect(rows[N - 1].ev_soc_percent).toBeCloseTo(80, 3);
  });

  it('meets a deadline inside the forecast part, charging only before it', () => {
    const dep = FIRM + 6;
    const rows = solve(cfgFor(10, { evDepartureSlot: dep, evDeferToForecast: true }));
    expect(evKWh(rows.slice(0, FIRM))).toBeCloseTo(0, 6);
    expect(evKWh(rows.slice(FIRM, dep))).toBeGreaterThan(26);
    expect(evKWh(rows.slice(dep))).toBe(0);
    expect(rows[dep - 1].ev_target_met).toBe(true);
    expect(rows[dep - 1].ev_soc_percent).toBeCloseTo(80, 3);
  });

  it('keeps charging in the firm part when the forecast day is dearer', () => {
    const rows = solve(cfgFor(40, noDeadline()));
    expect(evKWh(rows.slice(0, FIRM))).toBeGreaterThan(26);
    expect(rows[N - 1].ev_target_met).toBe(true);
  });
});

describe('buildLP — floor ratchet past the boundary (HiGHS)', () => {
  let highs;
  beforeAll(async () => {
    highs = await highsFactory({});
  });

  const MIN_SOC_WH = 1000;
  const ratchetCfg = (extra = {}) => {
    const n = extra.load_W?.length ?? 84;
    return {
      load_W: Array(n).fill(500),
      pv_W: Array(n).fill(0),
      stepSize_m: 60,
      batteryCapacity_Wh: 10000,
      minSoc_percent: 10,
      maxSoc_percent: 100,
      maxChargePower_W: 5000,
      maxDischargePower_W: 5000,
      maxGridImport_W: 10000,
      maxGridExport_W: 10000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      inverterEfficiency_percent: 95,
      batteryCost_cent_per_kWh: 0,
      idleDrain_W: 40,
      terminalSocValuation: 'zero',
      terminalSocCustomPrice_cents_per_kWh: 0,
      initialSoc_percent: 4,
      ...extra,
    };
  };
  // Run A: a 40 c firm half-day (no recovery in the firm part), then three
  // forecast days at 10 / 25 / 40 c (8 h each).
  const RA_F = 12;
  const forecastDay = [...Array(8).fill(10), ...Array(8).fill(25), ...Array(8).fill(40)];
  const runAPrice = [...Array(RA_F).fill(40), ...forecastDay, ...forecastDay, ...forecastDay];
  const runA = (extra = {}) => ratchetCfg({ importPrice: runAPrice, exportPrice: runAPrice, firmSlots: RA_F, ...extra });

  const OPTS = { mip_rel_gap: 0, mip_abs_gap: 0 };
  const solveLp = (lp, cfg) => {
    const result = highs.solve(lp, OPTS);
    expect(result.Status).toBe('Optimal');
    return { result, rows: parseSolution(result, cfg, { startMs: 0, stepMin: 60 }) };
  };
  const solve = cfg => solveLp(buildLP(cfg), cfg);
  const sum = xs => xs.reduce((a, b) => a + b, 0);

  /**
   * The shipped LP with a per-slot recovery latch added to the forecast slots
   * (mirroring the firm rows): floor_recovered_t gates c_min_soc_t, is
   * monotone from floor_recovered_{F−1} and is forced to 1 by soc_t > minSoc.
   * `binary` declares it binary (the reference model), `relaxed` bounds it to
   * [0, 1] (the binary-free candidate).
   */
  function withForecastLatch(cfg, mode) {
    const T = cfg.load_W.length;
    const F = cfg.firmSlots;
    const minSoc = cfg.minSoc_percent / 100 * cfg.batteryCapacity_Wh;
    const maxSoc = cfg.maxSoc_percent / 100 * cfg.batteryCapacity_Wh;
    const lines = buildLP(cfg).split('\n');
    const rows = [];
    const extraBounds = [];
    const extraBinaries = [];
    for (let t = F; t < T; t++) {
      const i = lines.findIndex(l => l.startsWith(` c_min_soc_${t}: `));
      lines[i] = lines[i].replace(`floor_recovered_${F - 1}`, `floor_recovered_${t}`);
      rows.push(` c_floor_rec_${t}: soc_${t} - ${maxSoc - minSoc} floor_recovered_${t} <= ${minSoc}`);
      rows.push(` c_floor_rec_mono_${t}: floor_recovered_${t} - floor_recovered_${t - 1} >= 0`);
      if (mode === 'binary') extraBinaries.push(` floor_recovered_${t}`);
      else extraBounds.push(` 0 <= floor_recovered_${t} <= 1`);
    }
    const b = lines.indexOf('Bounds');
    lines.splice(b + 1, 0, ...extraBounds);
    lines.splice(b - 1, 0, ...rows); // before the blank line that ends Subject To
    const bin = lines.indexOf('Binaries');
    lines.splice(bin + 1, 0, ...extraBinaries);
    return lines.join('\n');
  }

  /** Lowest SoC from the first forecast slot above minSoc on (Infinity if none). */
  function minAfterForecastRecovery(rows, F) {
    const k = rows.findIndex((r, t) => t >= F && r.soc > MIN_SOC_WH + 1);
    return k < 0 ? Infinity : Math.min(...rows.slice(k).map(r => r.soc));
  }

  it('Run A: the firm part does not recover; forecast slots never go below the no-intervention bound', () => {
    const cfg = runA();
    const { result, rows } = solve(cfg);
    expect(result.Columns[`floor_recovered_${RA_F - 1}`].Primal).toBeCloseTo(0, 6);
    // The forecast days recover (charge at 10 c)...
    expect(Math.max(...rows.slice(RA_F).map(r => r.soc))).toBeGreaterThan(MIN_SOC_WH);
    // ...and every slot stays on or above its documented floor: no shortfall
    // anywhere, soc_t >= minSoc − allowance(t) (the no-intervention trajectory).
    for (let t = 0; t < rows.length; t++) {
      expect(result.Columns[`soc_shortfall_${t}`].Primal).toBeCloseTo(0, 6);
      const allowance = 600 + 40 * (t + 1);
      expect(rows[t].soc).toBeGreaterThanOrEqual(MIN_SOC_WH - allowance - 1e-6);
    }
    // Known limitation (comment in buildLP): a forecast-day recovery does not
    // restore the full floor, so later forecast days may drain below minSoc.
    expect(minAfterForecastRecovery(rows, RA_F)).toBeLessThan(MIN_SOC_WH);
  });

  // Run B: no load, flat prices, a small idle drain. Starting at 8 % (200 Wh
  // short) the battery just sits; nothing is worth buying.
  const RB_F = 12;
  const RB_T = 48;
  const runB = (firmPrice, forecastPrice, extra = {}) => {
    const price = [...Array(RB_F).fill(firmPrice), ...Array(RB_T - RB_F).fill(forecastPrice)];
    return ratchetCfg({
      load_W: Array(RB_T).fill(0),
      pv_W: Array(RB_T).fill(0),
      importPrice: price,
      exportPrice: price,
      idleDrain_W: 10,
      initialSoc_percent: 8,
      firmSlots: RB_F,
      ...extra,
    });
  };
  const firmOnlyOf = cfg => ({
    ...cfg,
    firmSlots: undefined,
    load_W: cfg.load_W.slice(0, RB_F),
    pv_W: cfg.pv_W.slice(0, RB_F),
    importPrice: cfg.importPrice.slice(0, RB_F),
    exportPrice: cfg.exportPrice.slice(0, RB_F),
  });

  it('Run B: idle drain past the boundary needs no trickle charge', () => {
    const cfg = runB(20, 20);
    const { result, rows } = solve(cfg);
    expect(sum(rows.map(r => r.g2b))).toBeLessThan(1);
    for (let t = 0; t < RB_T; t++) expect(result.Columns[`soc_shortfall_${t}`].Primal).toBeCloseTo(0, 6);
    // The battery follows the idle-drain trajectory: 800 − 10·(t+1).
    expect(rows[RB_T - 1].soc).toBeCloseTo(800 - 10 * RB_T, 3);
  });

  it('Run B: a cheaper firm part does not pull charging into firm slots', () => {
    // No export value: stored energy is only worth something to the floor.
    const cfg = runB(10, 20, { exportPrice: Array(RB_T).fill(0) });
    const firmOnly = solve(firmOnlyOf(cfg)).rows;
    const ext = solve(cfg).rows;
    const firmG2b = rows => sum(rows.slice(0, RB_F).map(r => r.g2b));
    expect(firmG2b(ext)).toBeCloseTo(firmG2b(firmOnly), 3);
    expect(firmG2b(ext)).toBeLessThan(1);
    expect(ext[RB_F - 1].soc).toBeCloseTo(firmOnly[RB_F - 1].soc, 3);
  });

  // Proof that a binary-free latch in forecast slots is exploitable. Relaxing
  // floor_recovered_t (t >= F) to [0, 1] only raises the floor in proportion
  // to (soc − minSoc)/(maxSoc − minSoc) — the convex hull of the binary latch
  // — so after a partial recovery the relaxed model plans below minSoc where
  // the binary model holds it, and it charges less to keep the floor low.
  it('a continuous forecast latch drains below minSoc where the binary latch holds it', () => {
    // Run A without export (the battery only serves a 300 W load): the
    // forecast days charge only what the evenings need.
    const cfg = runA({ load_W: Array(84).fill(300), exportPrice: Array(84).fill(0) });
    const binary = solveLp(withForecastLatch(cfg, 'binary'), cfg).rows;
    const relaxed = solveLp(withForecastLatch(cfg, 'relaxed'), cfg).rows;
    expect(minAfterForecastRecovery(binary, RA_F)).toBeGreaterThanOrEqual(MIN_SOC_WH - 1e-6);
    expect(minAfterForecastRecovery(relaxed, RA_F)).toBeLessThan(MIN_SOC_WH - 500);
    const peak = rows => Math.max(...rows.slice(RA_F).map(r => r.soc));
    expect(peak(relaxed)).toBeLessThan(peak(binary) - 500);
  });

  it('across random prices the relaxed latch sits between the shipped LP and the binary latch, and is exploited', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let exploited = 0;
    for (let i = 0; i < 30; i++) {
      const F = 6 + Math.floor(rnd() * 10);
      const T = F + 24 + Math.floor(rnd() * 12);
      const importPrice = Array.from({ length: T }, () => Math.round(50 + rnd() * 450) / 10);
      const exportMode = rnd();
      const exportPrice = importPrice.map(p => (exportMode < 0.4 ? p : exportMode < 0.7 ? Math.max(0, p - 10) : 0));
      const cfg = ratchetCfg({
        load_W: Array.from({ length: T }, () => Math.round(100 + rnd() * 900)),
        pv_W: Array.from({ length: T }, (_, t) => (t % 24 >= 9 && t % 24 < 16 && rnd() < 0.7 ? Math.round(rnd() * 3000) : 0)),
        importPrice,
        exportPrice,
        firmSlots: F,
        initialSoc_percent: Math.round(rnd() * 90) / 10,
        idleDrain_W: Math.round(rnd() * 60),
        batteryCost_cent_per_kWh: Math.round(rnd() * 3),
        maxChargePower_W: 1000 + Math.round(rnd() * 4000),
      });
      const shipped = solve(cfg).result.ObjectiveValue;
      const relaxed = solveLp(withForecastLatch(cfg, 'relaxed'), cfg);
      const binary = solveLp(withForecastLatch(cfg, 'binary'), cfg);
      // Nested feasible regions: shipped ⊇ relaxed ⊇ binary.
      expect(shipped).toBeLessThanOrEqual(relaxed.result.ObjectiveValue + 1e-6);
      expect(relaxed.result.ObjectiveValue).toBeLessThanOrEqual(binary.result.ObjectiveValue + 1e-6);
      expect(minAfterForecastRecovery(binary.rows, F)).toBeGreaterThanOrEqual(MIN_SOC_WH - 1);
      if (minAfterForecastRecovery(relaxed.rows, F) < MIN_SOC_WH - 5) exploited++;
    }
    expect(exploited).toBeGreaterThan(0);
  });
});

// Worst case (plans/multi-day-horizon-plan.md "Solver"): ratchet + rebalance +
// continuous EV with CV thresholds, 524 15-min slots with 140 firm slots.
// The extended solve inherits the firm-only plan's rebalance start (fixed via
// rebalanceMinStartSlot = rebalanceMaxStartSlot) and its end-of-firm SoC.
describe('buildLP — worst-case extended solve', () => {
  const PRICE_BY_HOUR = [18, 17, 16, 16, 17, 20, 26, 33, 31, 24, 15, 9, 6, 5, 7, 12, 22, 38, 42, 36, 29, 25, 22, 20];
  const PV_BY_HOUR = [0, 0, 0, 0, 0, 0, 0, 150, 900, 2100, 3400, 4300, 4700, 4500, 3700, 2500, 1200, 300, 0, 0, 0, 0, 0, 0];
  const LOAD_BY_HOUR = [320, 300, 290, 290, 300, 380, 650, 900, 700, 520, 480, 500, 560, 520, 480, 520, 800, 1400, 1650, 1300, 1000, 800, 550, 400];
  const PV_SCALE_BY_DAY = [1, 0.6, 0.9, 0.35, 0.75, 1, 0.5];
  const WT = 524;
  const WF = 140;

  function worst(n) {
    const load_W = [];
    const pv_W = [];
    const importPrice = [];
    const exportPrice = [];
    for (let t = 0; t < n; t++) {
      const minutes = 9 * 60 + t * 15;
      const hour = Math.floor(minutes / 60) % 24;
      const day = Math.floor(minutes / 1440);
      const price = PRICE_BY_HOUR[hour] + (((t * 7 + day * 3) % 5) - 2) + ((day * 5) % 9) - 4 + 0.125;
      importPrice.push(price);
      exportPrice.push(price - 0.5);
      load_W.push(LOAD_BY_HOUR[hour] + ((t * 13) % 7) * 10);
      pv_W.push(Math.round(PV_BY_HOUR[hour] * PV_SCALE_BY_DAY[day % PV_SCALE_BY_DAY.length]));
    }
    return {
      load_W, pv_W, importPrice, exportPrice,
      stepSize_m: 15,
      batteryCapacity_Wh: 20480,
      minSoc_percent: 10,
      maxSoc_percent: 100,
      maxChargePower_W: 3600,
      maxDischargePower_W: 4000,
      maxGridImport_W: 17250,
      maxGridExport_W: 10000,
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      inverterEfficiency_percent: 96.5,
      batteryCost_cent_per_kWh: 2,
      idleDrain_W: 40,
      terminalSocValuation: 'zero',
      terminalSocCustomPrice_cents_per_kWh: 0,
      initialSoc_percent: 6, // floor ratchet
      cvPhaseThresholds: [
        { soc_percent: 80, maxChargePower_W: 3000 },
        { soc_percent: 88, maxChargePower_W: 2200 },
        { soc_percent: 94, maxChargePower_W: 1400 },
        { soc_percent: 98, maxChargePower_W: 700 },
      ],
      rebalanceHoldSlots: 12,
      rebalanceRemainingSlots: 12,
      rebalanceTargetSoc_percent: 100,
      ev: {
        evMinChargePower_W: 4140,
        evMaxChargePower_W: 11040,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 45,
        evTargetSoc_percent: 80,
        evDepartureSlot: 92,
        evChargeEfficiency_percent: 90,
        evChargePhases: 3,
        evContinuous: true,
      },
    };
  }

  it('is Optimal with the extended solve options', async () => {
    const highs = await highsFactory({});
    const firmCfg = worst(WF);
    const firm = highs.solve(buildLP(firmCfg), solveOptionsFor(firmCfg));
    expect(firm.Status).toBe('Optimal');
    const firmRows = parseSolution(firm, firmCfg, { startMs: 0, stepMin: 15 });
    const start = Number(Object.keys(firm.Columns)
      .find(k => k.startsWith('start_balance_') && firm.Columns[k].Primal > 0.5)
      .slice('start_balance_'.length));

    const extCfg = {
      ...worst(WT),
      firmSlots: WF,
      rebalanceMaxStartSlot: start,
      rebalanceMinStartSlot: start,
      socRef_Wh: firmRows[WF - 1].soc,
      carryOverMargin_cents_per_kWh: 1,
    };
    const lp = buildLP(extCfg);
    for (const name of binaries(lp)) expect(slotIndex(name)).toBeLessThan(WF);
    const highs2 = await highsFactory({});
    const ext = highs2.solve(lp, extendedSolveOptions({ firmObjective: firm.ObjectiveValue }));
    expect(ext.Status).toBe('Optimal');
    const rows = parseSolution(ext, extCfg, { startMs: 0, stepMin: 15 });
    expect(rows).toHaveLength(WT);
    expect(rows.filter(r => r.priceForecast)).toHaveLength(WT - WF);
    // The hold sits where the firm-only plan put it.
    for (let t = start; t < start + 12; t++) expect(rows[t].soc).toBeGreaterThanOrEqual(20480 - 1);
  }, 120_000);
});
