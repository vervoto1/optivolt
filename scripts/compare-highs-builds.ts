#!/usr/bin/env npx tsx
/**
 * Refresh gate for the vendored HiGHS solver (see vendor/highs-build/PROVENANCE.md).
 *
 * Solves the same LP with the vendored build and a candidate build and reports
 * status, objective, solve time and any per-slot differences in the parsed plan.
 *
 * Usage:
 *   npx tsx scripts/compare-highs-builds.ts <candidate-highs.js> [data.json] [settings.json]
 *
 * With no data/settings arguments the bundled defaults are used. Point it at a
 * snapshot of a real DATA_DIR (data.json + settings.json) to compare on the
 * plan that actually runs on the box. NOW=<ISO timestamp> overrides the plan
 * start (defaults to the start of the load series so the whole horizon solves).
 *
 * Exit code is 1 only when the solver statuses differ or the objectives differ
 * by more than the MIP gap the planner solves with; differing rows at an equal
 * objective are alternative optima and are reported, not failed.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSolverConfigFromSettings } from '../api/services/config-builder.ts';
import { buildLP } from '../lib/build-lp.ts';
import { MIP_SOLVE_OPTIONS, solveOptionsFor } from '../lib/solve-options.ts';
import { parseSolution, type HighsSolution } from '../lib/parse-solution.ts';
import type { Data, Settings } from '../api/types.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const [candidateArg, dataArg, settingsArg] = process.argv.slice(2);
if (!candidateArg) {
  console.error('usage: npx tsx scripts/compare-highs-builds.ts <candidate-highs.js> [data.json] [settings.json]');
  process.exit(2);
}

const vendoredPath = path.join(root, 'vendor/highs-build/highs.js');
const candidatePath = path.resolve(candidateArg);
const data = JSON.parse(readFileSync(dataArg ? path.resolve(dataArg) : path.join(root, 'api/defaults/default-data.json'), 'utf8')) as Data;
const settings = JSON.parse(readFileSync(settingsArg ? path.resolve(settingsArg) : path.join(root, 'api/defaults/default-settings.json'), 'utf8')) as Settings;

const startMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.parse(data.load.start);
const timing = { startMs, stepMin: settings.stepSize_m ?? 15 };
const cfg = buildSolverConfigFromSettings(settings, data, startMs);
const lp = buildLP(cfg);
// The planner's own options and binaries predicate (lib/solve-options.ts).
const solveOptions = solveOptionsFor(cfg);
const hasBinaries = Object.keys(solveOptions).length > 0;

interface HighsModule { solve(lp: string, options?: Record<string, unknown>): HighsSolution & { Status: string; ObjectiveValue: number } }

async function solveWith(modulePath: string) {
  const factory = require(modulePath) as () => Promise<HighsModule>;
  const highs = await factory();
  const t0 = performance.now();
  const result = highs.solve(lp, solveOptions);
  const solveMs = performance.now() - t0;
  return { status: result.Status, objective: result.ObjectiveValue, solveMs, rows: parseSolution(result, cfg, timing) };
}

const vendored = await solveWith(vendoredPath);
const candidate = await solveWith(candidatePath);

console.log(`LP: ${cfg.load_W.length} slots, ${lp.length} chars, ${hasBinaries ? 'MILP' : 'LP'}`);
console.log(`vendored : ${vendored.status.padEnd(10)} objective ${vendored.objective.toFixed(6)}  ${Math.round(vendored.solveMs)} ms  (${vendoredPath})`);
console.log(`candidate: ${candidate.status.padEnd(10)} objective ${candidate.objective.toFixed(6)}  ${Math.round(candidate.solveMs)} ms  (${candidatePath})`);

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
