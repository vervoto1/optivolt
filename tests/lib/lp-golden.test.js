// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildLP } from '../../lib/build-lp.ts';

// Golden LP fixtures: sha256 of the exact LP text buildLP emits for a set of
// representative SolverConfigs. The hashes pin the LP of v0.7.71 (generated
// from the unmodified lib/build-lp.ts of that release).
//
// Any change to these hashes must be deliberate: an LP edit that alters a
// coefficient, a constraint name, the order of rows or the number formatting
// shows up here, and the hash is only updated together with a CHANGELOG entry
// that explains the plan change.
//
// The multi-day horizon (plans/multi-day-horizon-plan.md) must keep every
// hash green: with extendedHorizon off, `firmSlots` is absent from the config
// and buildLP must emit byte-identical text to 0.7.71.
//
// The configs are fully deterministic: integer-arithmetic profiles, no
// Date.now(), no Math.random(), no floating-point transcendental functions.

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Hour-of-day profiles (24 entries) — a winter-ish day-ahead shape.
const PRICE_BY_HOUR = [18, 17, 16, 16, 17, 20, 26, 33, 31, 24, 15, 9, 6, 5, 7, 12, 22, 38, 42, 36, 29, 25, 22, 20];
const PV_BY_HOUR = [0, 0, 0, 0, 0, 0, 0, 150, 900, 2100, 3400, 4300, 4700, 4500, 3700, 2500, 1200, 300, 0, 0, 0, 0, 0, 0];
const LOAD_BY_HOUR = [320, 300, 290, 290, 300, 380, 650, 900, 700, 520, 480, 500, 560, 520, 480, 520, 800, 1400, 1650, 1300, 1000, 800, 550, 400];

/** Deterministic day-shaped series; `day` shifts prices so day 2 differs from day 1. */
function series(T, stepSize_m, { startHour = 0 } = {}) {
  const load_W = [];
  const pv_W = [];
  const importPrice = [];
  const exportPrice = [];
  for (let t = 0; t < T; t++) {
    const minutes = startHour * 60 + t * stepSize_m;
    const hour = Math.floor(minutes / 60) % 24;
    const day = Math.floor(minutes / 1440);
    const wiggle = ((t * 7 + day * 3) % 5) - 2; // −2..+2, integer
    const price = PRICE_BY_HOUR[hour] + wiggle + day * 2 + 0.125;
    importPrice.push(price);
    exportPrice.push(price - 0.5);
    load_W.push(LOAD_BY_HOUR[hour] + ((t * 13) % 7) * 10);
    pv_W.push(day === 1 ? Math.round(PV_BY_HOUR[hour] * 0.6) : PV_BY_HOUR[hour]);
  }
  return { load_W, pv_W, importPrice, exportPrice };
}

/** Production-like scalars (default-settings.json style, a little perturbed). */
const SCALARS = {
  stepSize_m: 15,
  batteryCapacity_Wh: 20480,
  minSoc_percent: 5,
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
  initialSoc_percent: 42,
};

function cfg(T, stepSize_m, extra = {}, seriesOpts = {}) {
  return { ...SCALARS, ...series(T, stepSize_m, seriesOpts), stepSize_m, ...extra };
}

const CV = [
  { soc_percent: 85, maxChargePower_W: 2800 },
  { soc_percent: 92, maxChargePower_W: 1800 },
  { soc_percent: 97, maxChargePower_W: 900 },
];
const DP = [
  { soc_percent: 15, maxDischargePower_W: 2500 },
  { soc_percent: 8, maxDischargePower_W: 1200 },
];

const EV_BASE = {
  evMinChargePower_W: 4140,
  evMaxChargePower_W: 11040,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 45,
  evTargetSoc_percent: 80,
  evChargeEfficiency_percent: 90,
  evChargePhases: 3,
};

// Export-tariff style: market price minus a fee for export (can go negative),
// 0 c for slots with no market price, import stays the all-in tariff.
function exportTariffSeries(T) {
  const s = series(T, 15, { startHour: 6 });
  const exportPrice = s.importPrice.map((p, t) => {
    if (t >= 60 && t < 64) return 0; // missing market price → 0 c
    const market = (p - 14.25) / 1.21;
    return Math.round((market - 1.75) * 1000) / 1000;
  });
  return { ...s, exportPrice };
}

// Variable families whose presence each fixture asserts (name prefix before `_<index>`).
const FEATURES = ['cv', 'dp', 'floor_recovered', 'start_balance', 'ev_on', 'ev_cv', 'ev_trans', 'ev_tgt', 'ev_floor_shortfall'];

const GOLDEN = [
  {
    name: '15-min, 96 slots, plain (no CV/DP/ratchet/rebalance/EV)',
    config: () => cfg(96, 15),
    hash: 'e77b3df26ecf0ae47ae34d0375981608e1d4262755399246c29db40ddbe4393a',
    features: [],
  },
  {
    name: '5-min, 144 slots, CV thresholds',
    config: () => cfg(144, 5, { cvPhaseThresholds: CV, initialSoc_percent: 80 }, { startHour: 9 }),
    hash: 'fda7a7b8d43a476ba16f7d31ac074f7f539237db6db09fce349bb65f0565c2a1',
    features: ['cv'],
  },
  {
    name: '60-min, 36 slots, CV + discharge phase, terminal avg',
    config: () => cfg(36, 60, { cvPhaseThresholds: CV, dischargePhaseThresholds: DP, terminalSocValuation: 'avg' }, { startHour: 12 }),
    hash: '6571fb9b6d9983972ad20bef8d837849a0030b39680f6b307bfa8d755883a64c',
    features: ['cv', 'dp'],
  },
  {
    name: '15-min, 192-slot api horizon, CV + discharge phase, evLoad series',
    config: () => cfg(192, 15, {
      cvPhaseThresholds: CV,
      dischargePhaseThresholds: DP,
      evLoad_W: Array.from({ length: 192 }, (_, t) => (t >= 80 && t < 92 ? 7360 : 0)),
    }),
    hash: 'bfa1b30de1ade582818ae88b69f8028c2f97ebf3b0f7516cb4c348592e69e766',
    features: ['cv', 'dp'],
  },
  {
    name: '15-min, discharge-phase thresholds only, terminal max',
    config: () => cfg(96, 15, { dischargePhaseThresholds: DP, initialSoc_percent: 18, terminalSocValuation: 'max' }, { startHour: 15 }),
    hash: 'c93ac5f6ebd917e58da44c9ac03ab579428963c050f28165ed5c267fecb065c7',
    features: ['dp'],
  },
  {
    name: '15-min, floor ratchet (initial SoC below minSoc)',
    config: () => cfg(96, 15, { minSoc_percent: 10, initialSoc_percent: 7, cvPhaseThresholds: CV }, { startHour: 22 }),
    hash: 'f93870b8d587440f2290df4b49a11c72788e6f1fc0503e986018fc8d39f0003d',
    features: ['cv', 'floor_recovered'],
  },
  {
    name: '15-min, rebalance free window',
    config: () => cfg(96, 15, {
      cvPhaseThresholds: CV,
      rebalanceHoldSlots: 12,
      rebalanceRemainingSlots: 12,
      rebalanceTargetSoc_percent: 100,
    }),
    hash: 'd52cf7e1ae50aec3808e510325138fe89506c439a82466b74e4c85b14e2a1889',
    features: ['cv', 'start_balance'],
  },
  {
    name: '15-min, rebalance pinned (maxStartSlot 0, hold SoC 99)',
    config: () => cfg(96, 15, {
      cvPhaseThresholds: CV,
      initialSoc_percent: 99,
      rebalanceHoldSlots: 12,
      rebalanceRemainingSlots: 7,
      rebalanceTargetSoc_percent: 100,
      rebalanceHoldSoc_percent: 99,
      rebalanceMaxStartSlot: 0,
    }, { startHour: 13 }),
    hash: '4e15b18d903dcf21bbb724125227fab33417456372c42472dc1d8cdfe68b492f',
    features: ['cv', 'start_balance'],
  },
  {
    name: '15-min, EV native, no departure',
    config: () => cfg(96, 15, { ev: { ...EV_BASE, evDepartureSlot: 97 } }),
    hash: 'd673485ee88ab278c74e20d81f129e8a90d4ac7c3bd93a2fdb0942f3606d3fac',
    features: ['ev_on'],
  },
  {
    name: '15-min, EV with departure, floor, opportunistic caps, start slot, price limit',
    config: () => cfg(96, 15, {
      ev: {
        ...EV_BASE,
        evDepartureSlot: 40,
        evStartSlot: 4,
        evApplyPriceLimit: true,
        evMaxPrice_cents_per_kWh: 30,
        evMinSocFloor_percent: 55,
        evOpportunisticCap_percent: 90,
        evOpportunisticType2Cap_percent: 100,
      },
    }, { startHour: 18 }),
    hash: 'd42e16fa188bb065169d38388890c77407e9c41e3123f287833b15e66cb44408',
    features: ['ev_on', 'ev_tgt', 'ev_floor_shortfall'],
  },
  {
    name: '15-min, EV continuous with taper thresholds and departure',
    config: () => cfg(96, 15, {
      cvPhaseThresholds: CV,
      ev: {
        ...EV_BASE,
        evMinChargePower_W: 1380,
        evDepartureSlot: 60,
        evContinuous: true,
        evChargeThresholds: [
          { soc_percent: 80, maxChargePower_W: 7360 },
          { soc_percent: 92, maxChargePower_W: 3680 },
        ],
        evTargetSoc_percent: 95,
      },
    }, { startHour: 20 }),
    hash: '1b4ad1073340a8dfb6b9b148c6a731fcdc008329934ee5cde4f640c150eedb4c',
    features: ['cv', 'ev_on', 'ev_cv', 'ev_trans'],
  },
  {
    name: '15-min, export-tariff asymmetric prices (market minus fee, zero gaps), terminal custom',
    config: () => ({
      ...SCALARS,
      ...exportTariffSeries(96),
      cvPhaseThresholds: CV,
      terminalSocValuation: 'custom',
      terminalSocCustomPrice_cents_per_kWh: 12.5,
    }),
    hash: '0b9faef8d255230b63275ac19ee97e75e96da960bb36c2df9d42d3e131ec7099',
    features: ['cv'],
  },
  {
    name: '15-min, worst case: ratchet + rebalance + EV continuous + CV + DP',
    config: () => cfg(96, 15, {
      cvPhaseThresholds: CV,
      dischargePhaseThresholds: DP,
      minSoc_percent: 10,
      initialSoc_percent: 6,
      rebalanceHoldSlots: 12,
      rebalanceRemainingSlots: 12,
      rebalanceTargetSoc_percent: 100,
      ev: { ...EV_BASE, evDepartureSlot: 50, evContinuous: true },
    }, { startHour: 17 }),
    hash: 'bdaf81cff1ded275d4f3ee19c82eb7016cff4c8c7825b92a4704224669544fdb',
    features: ['cv', 'dp', 'floor_recovered', 'start_balance', 'ev_on', 'ev_trans', 'ev_tgt'],
  },
];

describe('buildLP golden fixtures (LP text of v0.7.71)', () => {
  it.each(GOLDEN)('$name', ({ config, hash }) => {
    expect(sha256(buildLP(config()))).toBe(hash);
  });

  // Guards the fixtures themselves: each one must keep exercising the LP
  // feature it was chosen for (and only those binaries), so a hash cannot
  // silently go green on a config that no longer reaches the code under test.
  it.each(GOLDEN)('exercises its features: $name', ({ config, features }) => {
    const lp = buildLP(config());
    for (const feature of FEATURES) {
      expect(new RegExp(`\\b${feature}_\\d`).test(lp), feature).toBe(features.includes(feature));
    }
  });

  it('builds each config from a fresh object (fixtures are not mutated by buildLP)', () => {
    for (const { config } of GOLDEN) {
      const a = config();
      const before = JSON.stringify(a);
      buildLP(a);
      expect(JSON.stringify(a)).toBe(before);
    }
  });
});
