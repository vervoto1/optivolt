#!/usr/bin/env -S npx --no-install tsx
/**
 * Solve-time benchmark for long planning horizons (plans/multi-day-horizon-plan.md).
 *
 * Builds and solves synthetic LPs with the vendored HiGHS build and the
 * planner's own options (lib/solve-options.ts, time limit included) for
 * horizons of 96, 192, 384, 480 and 524 15-minute slots across scenarios:
 *
 *   base       4 CV thresholds (production-like charge taper)
 *   ratchet    base + floor ratchet (initial SoC below minSoc)
 *   rebalance  base + a free 3 h rebalance hold window
 *   ev         base + native EV charging with a departure
 *   worst      base + ratchet + rebalance + continuous EV
 *
 * Usage:
 *   npx --no-install tsx scripts/bench-horizon.ts [--firm-slots <n>] [--slots 96,192,...] [--scenarios base,worst]
 *
 * --firm-slots sets cfg.firmSlots (the multi-day horizon's firm/forecast
 * boundary: forecast slots carry no binaries). The rebalance window is a cap
 * here, not a fixed start (rebalanceMinStartSlot = rebalanceMaxStartSlot), so
 * "rebalance"/"worst" are the pessimistic case. The profiles are
 * deterministic, so runs are comparable across revisions.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildLP } from '../lib/build-lp.ts';
import { solveOptionsFor } from '../lib/solve-options.ts';
import type { SolverConfig } from '../lib/types.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const usage = 'usage: npx --no-install tsx scripts/bench-horizon.ts [--firm-slots <n>] [--slots 96,192,...] [--scenarios base,ratchet,rebalance,ev,worst]';

const args = (() => {
  try {
    return parseArgs({
      options: {
        'firm-slots': { type: 'string' },
        slots: { type: 'string' },
        scenarios: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    process.exit(2);
  }
})();

const parseIntList = (s: string): number[] => s.split(',').map(v => Number(v.trim()));
const firmSlots = args.values['firm-slots'] != null ? Number(args.values['firm-slots']) : undefined;
if (firmSlots != null && (!Number.isInteger(firmSlots) || firmSlots < 0)) {
  console.error(`--firm-slots must be a non-negative integer\n${usage}`);
  process.exit(2);
}
const horizons = args.values.slots ? parseIntList(args.values.slots) : [96, 192, 384, 480, 524];
if (horizons.some(T => !Number.isInteger(T) || T <= 0)) {
  console.error(`--slots must be positive integers\n${usage}`);
  process.exit(2);
}

// Hour-of-day profiles; each later day shifts prices and dims PV so days differ.
const PRICE_BY_HOUR = [18, 17, 16, 16, 17, 20, 26, 33, 31, 24, 15, 9, 6, 5, 7, 12, 22, 38, 42, 36, 29, 25, 22, 20];
const PV_BY_HOUR = [0, 0, 0, 0, 0, 0, 0, 150, 900, 2100, 3400, 4300, 4700, 4500, 3700, 2500, 1200, 300, 0, 0, 0, 0, 0, 0];
const LOAD_BY_HOUR = [320, 300, 290, 290, 300, 380, 650, 900, 700, 520, 480, 500, 560, 520, 480, 520, 800, 1400, 1650, 1300, 1000, 800, 550, 400];
const PV_SCALE_BY_DAY = [1, 0.6, 0.9, 0.35, 0.75, 1, 0.5];
const START_HOUR = 9; // a morning solve: today's remainder plus the following days

function baseConfig(T: number): SolverConfig {
  const stepSize_m = 15;
  const load_W: number[] = [];
  const pv_W: number[] = [];
  const importPrice: number[] = [];
  const exportPrice: number[] = [];
  for (let t = 0; t < T; t++) {
    const minutes = START_HOUR * 60 + t * stepSize_m;
    const hour = Math.floor(minutes / 60) % 24;
    const day = Math.floor(minutes / 1440);
    const wiggle = ((t * 7 + day * 3) % 5) - 2;
    const price = PRICE_BY_HOUR[hour] + wiggle + ((day * 5) % 9) - 4 + 0.125;
    importPrice.push(price);
    exportPrice.push(price - 0.5);
    load_W.push(LOAD_BY_HOUR[hour] + ((t * 13) % 7) * 10);
    pv_W.push(Math.round(PV_BY_HOUR[hour] * PV_SCALE_BY_DAY[day % PV_SCALE_BY_DAY.length]));
  }
  return {
    load_W, pv_W, importPrice, exportPrice,
    stepSize_m,
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
    cvPhaseThresholds: [
      { soc_percent: 80, maxChargePower_W: 3000 },
      { soc_percent: 88, maxChargePower_W: 2200 },
      { soc_percent: 94, maxChargePower_W: 1400 },
      { soc_percent: 98, maxChargePower_W: 700 },
    ],
  };
}

const withRatchet = (c: SolverConfig): SolverConfig => ({ ...c, minSoc_percent: 10, initialSoc_percent: 6 });
const withRebalance = (c: SolverConfig): SolverConfig => ({
  ...c,
  rebalanceHoldSlots: 12,
  rebalanceRemainingSlots: 12,
  rebalanceTargetSoc_percent: 100,
});
const withEv = (c: SolverConfig, continuous: boolean): SolverConfig => ({
  ...c,
  ev: {
    evMinChargePower_W: 4140,
    evMaxChargePower_W: 11040,
    evBatteryCapacity_Wh: 60000,
    evInitialSoc_percent: 45,
    evTargetSoc_percent: 80,
    evDepartureSlot: Math.min(c.load_W.length, 92), // next morning 08:00 from a 09:00 start
    evChargeEfficiency_percent: 90,
    evChargePhases: 3,
    ...(continuous ? { evContinuous: true } : {}),
  },
});

const SCENARIOS: Record<string, (T: number) => SolverConfig> = {
  base: T => baseConfig(T),
  ratchet: T => withRatchet(baseConfig(T)),
  rebalance: T => withRebalance(baseConfig(T)),
  ev: T => withEv(baseConfig(T), false),
  worst: T => withEv(withRebalance(withRatchet(baseConfig(T))), true),
};
const scenarioNames = args.values.scenarios ? args.values.scenarios.split(',').map(s => s.trim()) : Object.keys(SCENARIOS);
const unknown = scenarioNames.filter(n => !(n in SCENARIOS));
if (unknown.length > 0) {
  console.error(`unknown scenario(s): ${unknown.join(', ')}\n${usage}`);
  process.exit(2);
}

interface HighsResult { Status: string; ObjectiveValue: number }
interface HighsModule { solve(lp: string, options?: Record<string, unknown>): HighsResult }

// A fresh module per solve: a HiGHS WASM instance can be left in a bad state
// after a failed solve, and a fresh heap keeps the timings independent.
const factory = require(path.join(root, 'vendor/highs-build/highs.js')) as () => Promise<HighsModule>;

console.log(`bench-horizon: 15-min slots, start ${String(START_HOUR).padStart(2, '0')}:00, firmSlots ${firmSlots ?? '(absent)'}`);
console.log(`options: ${JSON.stringify(solveOptionsFor({ load_W: [0] }))}`);
console.log('');
const header = ['scenario', 'T', 'LP chars', 'build ms', 'solve ms', 'status', 'objective'];
const widths = [10, 5, 10, 9, 9, 22, 12];
const fmt = (cells: string[]) => cells.map((c, i) => (i < 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(fmt(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));

let failures = 0;
for (const name of scenarioNames) {
  for (const T of horizons) {
    const cfg = SCENARIOS[name](T) as SolverConfig & { firmSlots?: number };
    if (firmSlots != null) cfg.firmSlots = firmSlots;
    const tb = performance.now();
    const lp = buildLP(cfg);
    const buildMs = performance.now() - tb;
    const highs = await factory();
    const t0 = performance.now();
    let status: string;
    let objective = '';
    try {
      const result = highs.solve(lp, solveOptionsFor(cfg));
      status = result.Status;
      objective = Number.isFinite(result.ObjectiveValue) ? result.ObjectiveValue.toFixed(3) : String(result.ObjectiveValue);
    } catch (err) {
      status = `error: ${(err as Error).message}`.slice(0, widths[5]);
    }
    const solveMs = performance.now() - t0;
    if (status !== 'Optimal') failures++;
    console.log(fmt([name, String(T), String(lp.length), buildMs.toFixed(0), solveMs.toFixed(0), status, objective]));
  }
}

if (failures > 0) {
  console.error(`\n${failures} solve(s) did not return Optimal`);
  process.exit(1);
}
