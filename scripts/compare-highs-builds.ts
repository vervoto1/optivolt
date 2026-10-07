#!/usr/bin/env -S npx --no-install tsx
/**
 * Refresh gate for the vendored HiGHS solver (see vendor/highs-build/PROVENANCE.md).
 *
 * Solves the same LP with the vendored build and a candidate build and reports
 * status, objective, solve time and any per-slot differences in the parsed plan.
 *
 * Usage:
 *   npx --no-install tsx scripts/compare-highs-builds.ts <candidate-highs.js> [data.json] [settings.json]
 *       [--calibration <file>]... [--adjustments <file>]
 *
 * With no data/settings arguments the bundled defaults are used. Point it at a
 * snapshot of a real DATA_DIR (data.json + settings.json) to compare on the
 * plan that actually runs on the box. NOW=<ISO timestamp> overrides the plan
 * start (defaults to the start of the load series so the whole horizon solves).
 *
 * The config is built through the planner's own path (buildPlannerConfig, see
 * scripts/solver-gate-config.ts): prediction adjustments, then the learned
 * charge taper when adaptive learning is in auto mode. Production's calibration
 * lives outside data.json, so pass it with --calibration: the
 * GET /plan-accuracy/calibration response, or the DATA_DIR calibration.json /
 * ev-calibration.json (repeat the flag for both). Without it a box in auto mode
 * is solved UNCALIBRATED, and the gate says so. --adjustments takes the
 * GET /predictions/adjustments response and replaces the adjustments stored in
 * data.json (which are used otherwise). The local DATA_DIR is never read.
 *
 * Exit code is 1 when either build returns no usable solution (parseSolution's
 * SolverStatusError, e.g. infeasible or a time limit hit without an incumbent),
 * either build stops short of Optimal (an early-stop incumbent, e.g. the time
 * limit hit with a feasible plan, proves nothing about equivalence and the
 * planner would never act on it), or the objectives differ by more than the
 * MIP gap the planner solves with; differing rows at an equal objective are
 * alternative optima and are reported, not failed. The solves use the
 * planner's options, time limit included.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildGateConfig, mergeCalibrationSnapshots, parseAdjustmentsSnapshot, parseCalibrationSnapshot } from './solver-gate-config.ts';
import { buildLP } from '../lib/build-lp.ts';
import { MIP_SOLVE_OPTIONS, solveOptionsFor } from '../lib/solve-options.ts';
import { parseSolution, SolverStatusError, type HighsSolution } from '../lib/parse-solution.ts';
import type { Data, Settings } from '../api/types.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const usage = 'usage: npx --no-install tsx scripts/compare-highs-builds.ts <candidate-highs.js> [data.json] [settings.json] [--calibration <file>]... [--adjustments <file>]';
const args = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        calibration: { type: 'string', multiple: true },
        adjustments: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    process.exit(2);
  }
})();
const [candidateArg, dataArg, settingsArg, ...extra] = args.positionals;
if (!candidateArg || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(path.resolve(file), 'utf8'));
const vendoredPath = path.join(root, 'vendor/highs-build/highs.js');
const candidatePath = path.resolve(candidateArg);
const data = readJson(dataArg ?? path.join(root, 'api/defaults/default-data.json')) as Data;
const settings = readJson(settingsArg ?? path.join(root, 'api/defaults/default-settings.json')) as Settings;
const calibration = args.values.calibration
  ? mergeCalibrationSnapshots(args.values.calibration.map(f => parseCalibrationSnapshot(readJson(f), f)))
  : undefined;
const adjustments = args.values.adjustments
  ? parseAdjustmentsSnapshot(readJson(args.values.adjustments), args.values.adjustments)
  : undefined;

const startMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.parse(data.load.start);
const timing = { startMs, stepMin: settings.stepSize_m ?? 15 };
const { cfg, notes, uncalibrated } = await buildGateConfig({ settings, data, startMs, calibration, adjustments });
for (const note of notes) (note.startsWith('WARNING') ? console.warn : console.log)(note);
const lp = buildLP(cfg);
// The planner's own options (lib/solve-options.ts). Every non-empty horizon is a
// MILP; the option count no longer says so, since the time limit is always set.
const solveOptions = solveOptionsFor(cfg);
const hasBinaries = cfg.load_W.length > 0;

interface HighsModule { solve(lp: string, options?: Record<string, unknown>): HighsSolution & { Status: string; ObjectiveValue: number } }

async function solveWith(modulePath: string) {
  const factory = require(modulePath) as () => Promise<HighsModule>;
  const highs = await factory();
  const t0 = performance.now();
  const result = highs.solve(lp, solveOptions);
  const solveMs = performance.now() - t0;
  let rows: ReturnType<typeof parseSolution> = [];
  let unusable: string | null = null;
  try {
    rows = parseSolution(result, cfg, timing);
  } catch (err) {
    if (!(err instanceof SolverStatusError)) throw err;
    unusable = err.message;
  }
  return { status: result.Status, objective: result.ObjectiveValue, solveMs, rows, unusable };
}

const vendored = await solveWith(vendoredPath);
const candidate = await solveWith(candidatePath);

console.log(`LP: ${cfg.load_W.length} slots, ${lp.length} chars, ${hasBinaries ? 'MILP' : 'LP'}`);
console.log(`vendored : ${vendored.status.padEnd(10)} objective ${vendored.objective.toFixed(6)}  ${Math.round(vendored.solveMs)} ms  (${vendoredPath})`);
console.log(`candidate: ${candidate.status.padEnd(10)} objective ${candidate.objective.toFixed(6)}  ${Math.round(candidate.solveMs)} ms  (${candidatePath})`);
for (const [label, run] of [['vendored', vendored], ['candidate', candidate]] as const) {
  if (run.unusable) console.error(`${label}: ${run.unusable}`);
}
if (vendored.unusable || candidate.unusable) {
  console.error('FAIL: a build returned no usable solution');
  process.exit(1);
}
// The planner only acts on Optimal plans. Two builds that both stop early (for
// example both hitting the time limit with an incumbent) can still land within
// the MIP gap of each other, which says nothing about the candidate.
if (vendored.status !== 'Optimal' || candidate.status !== 'Optimal') {
  console.error('FAIL: a build did not reach an Optimal solution (the planner never acts on an early-stop incumbent)');
  process.exit(1);
}

let differingRows = 0;
let maxAbsDiff = 0;
const fields = new Set<string>();
for (let i = 0; i < vendored.rows.length; i++) {
  const a = vendored.rows[i] as unknown as Record<string, unknown>;
  const b = candidate.rows[i] as unknown as Record<string, unknown>;
  let rowDiffers = false;
  for (const key of Object.keys(a)) {
    const x = a[key], y = b?.[key];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    const d = Math.abs(x - y);
    if (d > 1e-6) { rowDiffers = true; fields.add(key); maxAbsDiff = Math.max(maxAbsDiff, d); }
  }
  if (rowDiffers) differingRows++;
}
console.log(`rows: ${vendored.rows.length}, differing: ${differingRows}, max |diff|: ${maxAbsDiff}${fields.size ? `, fields: ${[...fields].join(', ')}` : ''}`);

const objectiveTolerance = Math.max(MIP_SOLVE_OPTIONS.mip_abs_gap, Math.abs(vendored.objective) * MIP_SOLVE_OPTIONS.mip_rel_gap);
if (vendored.status !== candidate.status || Math.abs(vendored.objective - candidate.objective) > objectiveTolerance) {
  console.error('FAIL: solver status or objective differs beyond the planner MIP gap');
  process.exit(1);
}
console.log(differingRows ? 'OK (alternative optimum — review the differing rows)' : 'OK (identical plan)');
if (uncalibrated) console.warn('note: solved UNCALIBRATED (no --calibration), so this did not compare the LP production solves');
