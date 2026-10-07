// @ts-nocheck
/**
 * LP-format hygiene: every constant must sit on the right-hand side.
 *
 * The HiGHS LP-format reader silently DROPS a bare numeric constant on the
 * left-hand side of a constraint (`59340 - 1800 b <= 58200` is read as
 * `-1800 b <= 58200`). Before v0.7.68 the slot-0 CV rows (battery `c_cv_k_0`
 * and EV `c_ev_cv_k_0`) were written that way, so neither charge taper was
 * enforced in slot 0. These tests guard the whole writer against the pattern
 * and prove on the vendored solver that the slot-0 taper now binds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Returns the bare numeric constants in a linear expression (tokens that are a
 * number not followed by a variable). Throws on anything that is neither a
 * sign, a number nor a variable name so a malformed row cannot slip through.
 */
function lhsConstants(expr) {
  const tokens = expr.trim().split(/\s+/).filter(Boolean);
  const constants = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '+' || tok === '-') continue;
    if (NUM.test(tok)) {
      if (!(i + 1 < tokens.length && VAR.test(tokens[i + 1]) && !NUM.test(tokens[i + 1]))) {
        constants.push(tok);
      }
      continue;
    }
    if (VAR.test(tok)) continue;
    throw new Error(`unexpected token "${tok}" in "${expr}"`);
  }
  return constants;
}

/** Every `name: lhs <op> rhs` row in the Subject To section, plus the objective. */
function constraintRows(lp) {
  const lines = lp.split('\n');
  const rows = [];
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(Minimize|Maximize)$/.test(line)) { section = 'obj'; continue; }
    if (line === 'Subject To') { section = 'st'; continue; }
    if (/^(Bounds|Binaries|General|End)$/.test(line)) { section = null; continue; }
    if (!section || line === '') continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) throw new Error(`unlabelled row in ${section}: "${line}"`);
    const [, name, body] = m;
    if (section === 'obj') {
      rows.push({ name, lhs: body });
      continue;
    }
    const cmp = body.match(/^(.*?)(<=|>=|=<|=>|<|>|=)\s*(\S+)$/);
    if (!cmp) throw new Error(`row without a comparator: "${line}"`);
    expect(cmp[3]).toMatch(NUM);
    rows.push({ name, lhs: cmp[1] });
  }
  return rows;
}

function rowsWithLhsConstants(lp) {
  return constraintRows(lp)
    .map(r => ({ name: r.name, constants: lhsConstants(r.lhs) }))
    .filter(r => r.constants.length > 0);
}

const T = 8;
const base = {
  load_W: Array(T).fill(1500),
  pv_W: [0, 0, 2000, 4000, 4000, 2000, 0, 0],
  importPrice: [5, 30, 10, 8, 12, 40, 35, 20],
  exportPrice: [2, 25, 6, 4, 8, 35, 30, 15],
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 10000,
  maxDischargePower_W: 10000,
  maxGridImport_W: 17000,
  maxGridExport_W: 10000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 96,
  batteryCost_cent_per_kWh: 2,
  idleDrain_W: 40,
  terminalSocValuation: 'max',
  terminalSocCustomPrice_cents_per_kWh: 0,
  initialSoc_percent: 96,
};

const cv = [
  { soc_percent: 90, maxChargePower_W: 4000 },
  { soc_percent: 95, maxChargePower_W: 800 },
];
const dp = [
  { soc_percent: 30, maxDischargePower_W: 6000 },
  { soc_percent: 15, maxDischargePower_W: 2000 },
];
const evTaper = {
  evMinChargePower_W: 4140,
  evMaxChargePower_W: 11040,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 85,
  evTargetSoc_percent: 95,
  evDepartureSlot: T,
  evChargeEfficiency_percent: 90,
  evChargePhases: 3,
  evChargeThresholds: [
    { soc_percent: 80, maxChargePower_W: 5000 },
    { soc_percent: 90, maxChargePower_W: 2000 },
  ],
};

const CONFIGS = {
  'CV taper (initial SoC above both thresholds)': { ...base, cvPhaseThresholds: cv },
  'CV taper (initial SoC below thresholds)': { ...base, initialSoc_percent: 50, cvPhaseThresholds: cv },
  'discharge phases (initial SoC above / below thresholds)': { ...base, initialSoc_percent: 20, dischargePhaseThresholds: dp },
  'floor ratchet (initial SoC below minSoc)': { ...base, initialSoc_percent: 5, cvPhaseThresholds: cv, dischargePhaseThresholds: dp },
  'rebalance hold': {
    ...base, initialSoc_percent: 80, rebalanceRemainingSlots: 3, rebalanceTargetSoc_percent: 100,
    rebalanceHoldSoc_percent: 98, rebalanceMaxStartSlot: 4, cvPhaseThresholds: cv,
  },
  'terminal valuation custom': { ...base, terminalSocValuation: 'custom', terminalSocCustomPrice_cents_per_kWh: 12 },
  'EV with charge taper + floor + opportunistic bands + contiguity': {
    ...base,
    cvPhaseThresholds: cv,
    dischargePhaseThresholds: dp,
    ev: {
      ...evTaper,
      evInitialSoc_percent: 30,
      evMinSocFloor_percent: 50,
      evOpportunisticCap_percent: 97,
      evOpportunisticType2Cap_percent: 99,
      evContinuous: true,
      evStartSlot: 1,
      evApplyPriceLimit: true,
      evMaxPrice_cents_per_kWh: 35,
    },
  },
  'EV taper with initial EV SoC above a threshold': { ...base, ev: evTaper },
  'EV target-landing relaxation (forced-rate, no taper)': {
    ...base,
    ev: { ...evTaper, evChargeThresholds: [], evMinChargePower_W: 11040, evInitialSoc_percent: 60, evTargetSoc_percent: 80 },
  },
  'EV with load + everything on': {
    ...base,
    initialSoc_percent: 5,
    evLoad_W: Array(T).fill(500),
    rebalanceRemainingSlots: 2,
    rebalanceTargetSoc_percent: 100,
    cvPhaseThresholds: cv,
    dischargePhaseThresholds: dp,
    ev: { ...evTaper, evMinSocFloor_percent: 90, evContinuous: true },
  },
};

describe('LP writer emits no constant on a constraint left-hand side', () => {
  it('the checker itself flags an LHS constant', () => {
    expect(lhsConstants('59340 - 1800 cv_0_0')).toEqual(['59340']);
    expect(lhsConstants('soc_0 - 2.5 grid_to_battery_0 + 3')).toEqual(['3']);
    expect(lhsConstants('- 1800 cv_0_0')).toEqual([]);
    expect(lhsConstants('- -1800 cv_0_0 + soc_1')).toEqual([]);
  });

  for (const [label, cfg] of Object.entries(CONFIGS)) {
    it(label, () => {
      const lp = buildLP(cfg);
      // Sanity: the config actually exercises the rows it is named after.
      if (cfg.cvPhaseThresholds) expect(lp).toContain('c_cv_0_0:');
      if (cfg.dischargePhaseThresholds) expect(lp).toContain('c_dp_0_0:');
      if (cfg.rebalanceRemainingSlots) expect(lp).toContain('c_rebalance_');
      if (cfg.initialSoc_percent < cfg.minSoc_percent) expect(lp).toContain('c_floor_rec_0:');
      if (cfg.ev?.evChargeThresholds?.length) expect(lp).toContain('c_ev_cv_0_0:');
      expect(rowsWithLhsConstants(lp)).toEqual([]);
    });
  }
});

describe('slot-0 charge taper binds on the real solver', () => {
  let highs;
  beforeAll(async () => { highs = await highsFactory({}); });

  it('battery: initial SoC just above a CV threshold limits slot-0 charging to the taper power', () => {
    // 96% start, taper at 95% → 600 W. Slot 0 is by far the cheapest and the
    // terminal SoC is valued highly, so without the taper the solver would
    // fill the remaining 4% (800 Wh) in slot 0 at ~3.4 kW.
    const N = 4;
    const cfg = {
      ...base,
      load_W: Array(N).fill(0),
      pv_W: Array(N).fill(0),
      importPrice: [1, 60, 60, 60],
      exportPrice: [0, 0, 0, 0],
      idleDrain_W: 0,
      batteryCost_cent_per_kWh: 0,
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 50,
      initialSoc_percent: 96,
      cvPhaseThresholds: [{ soc_percent: 95, maxChargePower_W: 600 }],
    };
    const result = highs.solve(buildLP(cfg));
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });
    const dcCharge0 = rows[0].pv2b + (cfg.inverterEfficiency_percent / 100) * rows[0].g2b;
    expect(dcCharge0).toBeGreaterThan(500);
    expect(dcCharge0).toBeLessThanOrEqual(600 + 1);
    expect(result.Columns.cv_0_0.Primal).toBeCloseTo(1, 6);
  });

  it('EV: initial EV SoC above a taper threshold limits slot-0 EV charging to the taper power', () => {
    const N = 4;
    const cfg = {
      ...base,
      load_W: Array(N).fill(0),
      pv_W: Array(N).fill(0),
      importPrice: [1, 60, 60, 60],
      exportPrice: [0, 0, 0, 0],
      initialSoc_percent: 50,
      terminalSocValuation: 'zero',
      ev: {
        ...evTaper,
        evInitialSoc_percent: 85,
        evTargetSoc_percent: 99,
        evDepartureSlot: N,
      },
    };
    const result = highs.solve(buildLP(cfg));
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });
    expect(rows[0].ev_charge).toBeGreaterThan(4000);
    expect(rows[0].ev_charge).toBeLessThanOrEqual(5000 + 1);
    expect(result.Columns.ev_cv_0_0.Primal).toBeCloseTo(1, 6);
  });
});
