#!/usr/bin/env -S npx --no-install tsx
/**
 * What-if for the multi-day planning horizon (plans/multi-day-horizon-plan.md).
 *
 * Solves one snapshot the way the planner does with `extendedHorizon.mode`
 * `on`: first the firm-only plan (the fallback, solveOptionsFor), then the
 * extended plan built from it by buildExtendedSolverConfig (firm SoC at the
 * firm end, the rebalance start the firm plan chose) with
 * extendedSolveOptions, and prints for both the SoC at each local midnight,
 * grid→battery per local day, the firm-part net cost, the solve time and
 * status, and the first 48 slots side by side; for the extension its slot
 * counts, end and end reason, the import fit and the resolution, or why it
 * was skipped.
 *
 * Usage:
 *   npx --no-install tsx scripts/horizon-whatif.ts data.json settings.json
 *       [--calibration <file>]... [--forecast forecast.json] [--extra-days n]
 *       [--synthetic-tail] [--ref <git-rev>]
 *
 * data.json / settings.json are GET /data and GET /settings (or the DATA_DIR
 * files); the firm config is built like the solver gate's
 * (scripts/solver-gate-config.ts: prediction adjustments, then the learned
 * taper with --calibration). The snapshot's mode is overridden in memory to
 * `on` (and --extra-days, 1–4, when given); nothing is written anywhere.
 * NOW=<ISO> overrides the plan start (default: the start of the load series).
 * Local days are the process time zone's: run with TZ=<the box's zone>.
 *
 * --forecast takes a saved EpexPredictor response
 *   (GET https://epexpredictor.batzill.com/prices?region=NL&unit=CT_PER_KWH&startTs=<local midnight>)
 *   and injects it as data.priceForecast, fetched "at" the plan start;
 *   otherwise the snapshot's data.priceForecast is used (and must be fresher
 *   than 12 h at the plan start).
 * --synthetic-tail extends load and PV past the snapshot's end, up to the
 *   load/PV planning-window end (as the predictors would in `collect`/`on`;
 *   the extended solve itself ends at the firm end's local midnight plus
 *   extraDays), by repeating their last 24 h. Only for exercising the
 *   extension on a snapshot taken before load/PV were collected that far; the
 *   output is labelled SYNTHETIC. The firm plan is solved on the real data.
 * --ref <rev> first builds the LP with mode `off` with the working tree and
 *   with <rev> (a temporary git worktree, run in a child process each, removed
 *   afterwards) and fails when the two LP strings differ: `off` must be
 *   byte-identical to the release before the horizon.
 *
 * Exit code 1: the --ref LPs differ, or the firm-only solve has no usable
 * solution. A skipped or non-Optimal extension is reported, not failed (the
 * planner then keeps the firm-only plan). Exit code 2: bad invocation or
 * unreadable input.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildGateConfig, mergeCalibrationSnapshots, parseCalibrationSnapshot, type CalibrationSnapshot } from './solver-gate-config.ts';
import {
  firstLpDifference, forecastFromResponse, gridToBatteryByDay, localLabel, localMidnightsBetween,
  netCostEuros, parseExtraDays, rebalanceStartFromColumns, settingsWithHorizon, sideBySideLines, socAt, withSyntheticTail,
} from './horizon-whatif-config.ts';
import { buildExtendedSolverConfig, preparePlanData } from '../api/services/config-builder.ts';
import { getPriceForecastStatus } from '../api/services/price-forecast-service.ts';
import { buildLP, isRebalanceHoldDeferred } from '../lib/build-lp.ts';
import { extendedSolveOptions, solveOptionsFor } from '../lib/solve-options.ts';
import { parseSolution, SolverStatusError, type HighsSolution } from '../lib/parse-solution.ts';
import { extendedWindowEndMs, resolvePlanningWindow } from '../lib/time-series-utils.ts';
import type { PlanRow, SolverConfig } from '../lib/types.ts';
import type { Data, Settings } from '../api/types.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const usage = 'usage: npx --no-install tsx scripts/horizon-whatif.ts data.json settings.json '
  + '[--calibration <file>]... [--forecast forecast.json] [--extra-days n] [--synthetic-tail] [--ref <git-rev>]';
const args = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        calibration: { type: 'string', multiple: true },
        forecast: { type: 'string' },
        'extra-days': { type: 'string' },
        'synthetic-tail': { type: 'boolean' },
        ref: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    process.exit(2);
  }
})();
const [dataArg, settingsArg, ...extra] = args.positionals;
if (!dataArg || !settingsArg || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    process.exit(2);
  }
}

const data = readJson(dataArg) as Data;
const snapshotSettings = readJson(settingsArg) as Settings;
const startMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.parse(data.load?.start);
if (!Number.isFinite(startMs)) {
  console.error(`cannot tell the plan start: ${process.env.NOW ? `NOW=${process.env.NOW}` : 'data.load.start'} is not a timestamp`);
  process.exit(2);
}
let calibration: CalibrationSnapshot | undefined;
let extraDays: number | undefined;
try {
  calibration = args.values.calibration
    ? mergeCalibrationSnapshots(args.values.calibration.map(f => parseCalibrationSnapshot(readJson(f), f)))
    : undefined;
  extraDays = parseExtraDays(args.values['extra-days']);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`plan start ${new Date(startMs).toISOString()} (${localLabel(startMs)} ${tz})`);

// ----------------------------- --ref: LP identity with mode off -----------

function git(argv: string[]): string {
  const res = spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${argv.join(' ')}: ${res.stderr.trim() || `exit ${res.status}`}`);
  return res.stdout.trim();
}

/** Build the mode-off LP with the code at `checkout` in a child process. */
function dumpLp(checkout: string, dir: string, label: string, inputs: { data: string; settings: string; calibration?: string }): string {
  const out = path.join(dir, `${label}.lp`);
  const res = spawnSync(process.execPath, [
    path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/horizon-lp-dump.ts'),
    '--root', checkout, '--data', inputs.data, '--settings', inputs.settings, '--start-ms', String(startMs), '--out', out,
    ...(inputs.calibration ? ['--calibration', inputs.calibration] : []),
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, DATA_DIR: path.join(dir, 'data-dir') } });
  if (res.status !== 0) throw new Error(`building the ${label} LP failed:\n${res.stderr.trim()}`);
  return readFileSync(out, 'utf8');
}

if (args.values.ref) {
  const ref = args.values.ref;
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'horizon-ref-'));
  const worktree = path.join(dir, 'worktree');
  let worktreeAdded = false;
  let failed = false;
  try {
    const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
    git(['worktree', 'add', '--detach', worktree, sha]);
    worktreeAdded = true;
    // The revision's npm imports resolve through the working tree's node_modules.
    symlinkSync(path.join(root, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');
    const inputs = {
      data: path.join(dir, 'data.json'),
      settings: path.join(dir, 'settings.json'),
      ...(calibration ? { calibration: path.join(dir, 'calibration.json') } : {}),
    };
    writeFileSync(inputs.data, JSON.stringify(data));
    writeFileSync(inputs.settings, JSON.stringify(settingsWithHorizon(snapshotSettings, 'off')));
    if (calibration) writeFileSync(inputs.calibration!, JSON.stringify(calibration));
    const head = dumpLp(root, dir, 'working-tree', inputs);
    const atRef = dumpLp(worktree, dir, 'ref', inputs);
    const diff = firstLpDifference(atRef, head);
    if (diff) {
      failed = true;
      console.error(`FAIL: the mode-off LP differs from ${ref} (${sha.slice(0, 10)}) at line ${diff.line}, column ${diff.column} `
        + `(${diff.linesA} vs ${diff.linesB} lines)\n  ${ref}: ${diff.a}\n  working tree: ${diff.b}`);
    } else {
      console.log(`--ref ${ref} (${sha.slice(0, 10)}): the mode-off LP is identical (${head.length} chars)`);
    }
  } catch (err) {
    console.error(`--ref ${ref}: ${(err as Error).message}`);
    process.exitCode = 2;
  } finally {
    if (worktreeAdded) {
      try { git(['worktree', 'remove', '--force', worktree]); } catch (err) { console.warn((err as Error).message); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  if (process.exitCode) process.exit(process.exitCode);
}

// ----------------------------- Firm-only solve ----------------------------

const settings = settingsWithHorizon(snapshotSettings, 'on', extraDays);
const horizon = settings.extendedHorizon!;
const { cfg: firmCfg, notes } = await buildGateConfig({ settings, data, startMs, calibration });
for (const note of notes) (note.startsWith('WARNING') ? console.warn : console.log)(note);

interface HighsModule { solve(lp: string, options?: Record<string, unknown>): HighsSolution & { Status: string; ObjectiveValue: number } }
const factory = require(path.join(root, 'vendor/highs-build/highs.js')) as () => Promise<HighsModule>;
const timing = { startMs, stepMin: settings.stepSize_m };

interface Run { label: string; cfg: SolverConfig; status: string; objective: number; solveMs: number; rows: PlanRow[] | null; columns?: Record<string, { Primal?: number }> }

async function solve(label: string, cfg: SolverConfig, options: Record<string, unknown>): Promise<Run> {
  const highs = await factory();
  const lp = buildLP(cfg);
  const t0 = performance.now();
  const result = highs.solve(lp, options);
  const solveMs = performance.now() - t0;
  let rows: PlanRow[] | null = null;
  try {
    rows = parseSolution(result, cfg, timing);
  } catch (err) {
    if (!(err instanceof SolverStatusError)) throw err;
    console.error(`${label}: ${err.message}`);
  }
  return { label, cfg, status: result.Status, objective: result.ObjectiveValue, solveMs, rows, columns: result.Columns as Run['columns'] };
}

const firm = await solve('firm-only', firmCfg, solveOptionsFor(firmCfg));
if (!firm.rows) {
  console.error('FAIL: the firm-only plan has no usable solution');
  process.exit(1);
}
const firmRows = firm.rows;
const F = firmRows.length;
const stepMs = settings.stepSize_m * 60_000;
const firmEndMs = startMs + F * stepMs;

// ----------------------------- Extended solve -----------------------------

let planData = preparePlanData(data, startMs);
const region = horizon.region;
if (args.values.forecast) {
  try {
    const { forecast, truncated } = forecastFromResponse(readJson(args.values.forecast), {
      region, fetchedAt: new Date(startMs).toISOString(), stored: planData.priceForecast,
    });
    planData = { ...planData, priceForecast: forecast };
    console.log(`forecast: ${args.values.forecast}, ${forecast.series.values.length} slots from ${forecast.series.start}, `
      + `published until ${forecast.publishedEnd}${truncated ? ' (cut at a gap)' : ''}; treated as fetched at the plan start`);
  } catch (err) {
    console.error(`${args.values.forecast}: ${(err as Error).message}`);
    process.exit(2);
  }
} else {
  const status = getPriceForecastStatus(planData, horizon, startMs);
  const pf = planData.priceForecast;
  console.log(pf
    ? `forecast: data.json priceForecast (${pf.region}), fetched ${pf.fetchedAt}, published until ${pf.publishedEnd}: ${status.state}`
    : 'forecast: none in data.json (pass --forecast <saved EpexPredictor response>)');
}

// The load/PV predictor window (what a synthetic tail emulates) and the end
// the extended solve itself uses (the firm end's local midnight + extraDays).
const windowEndMs = Date.parse(resolvePlanningWindow(settings, startMs, firmEndMs).endIso);
console.log(`firm part: ${F} slots to ${localLabel(firmEndMs)}; extended end ${localLabel(extendedWindowEndMs(settings, firmEndMs))}, `
  + `load/PV window to ${localLabel(windowEndMs)} (extraDays ${horizon.extraDays}, risk margin ${horizon.riskMargin_cents_per_kWh} c/kWh)`);
console.log(`load to ${localLabel(Date.parse(planData.load.start) + planData.load.values.length * (planData.load.step || 15) * 60_000)}, `
  + `pv to ${localLabel(Date.parse(planData.pv.start) + planData.pv.values.length * (planData.pv.step || 15) * 60_000)} in the snapshot`);
if (args.values['synthetic-tail']) {
  try {
    const synthetic = withSyntheticTail(planData, windowEndMs);
    planData = synthetic.data;
    for (const note of synthetic.notes) console.log(note);
  } catch (err) {
    console.error(`--synthetic-tail: ${(err as Error).message}`);
    process.exit(2);
  }
}

// As the planner (planner-service.ts solveExtendedHorizon): only an Optimal firm-only plan is extended.
const firmRebalanceStart = rebalanceStartFromColumns(firm.columns);
const built = firm.status !== 'Optimal'
  ? { skipped: 'firmNotOptimal', message: 'the published-price plan is not Optimal', endReason: undefined, fitRejection: undefined }
  : buildExtendedSolverConfig({
    firmCfg, settings, data: planData, nowMs: startMs,
    firmResult: {
      objective: firm.objective,
      socAtFirmEnd_Wh: firmRows[F - 1].soc,
      ...((firmCfg.rebalanceRemainingSlots ?? 0) > 0 && firmRebalanceStart !== undefined ? { rebalanceStartSlot: firmRebalanceStart } : {}),
    },
  });

let ext: Run | null = null;
if ('skipped' in built) {
  console.log(`extension SKIPPED (${built.skipped}${built.endReason ? `, ended by ${built.endReason}` : ''}): ${built.message}`);
  if (built.fitRejection) {
    console.log(`  fit rejection: ${built.fitRejection.reason} (${built.fitRejection.message}); stored fit: ${built.fitRejection.storedRejection}`);
  }
} else {
  const { info } = built;
  console.log(`extension: ${info.firmSlots} firm + ${info.extendedSlots} forecast = ${info.totalSlots} slots to ${localLabel(Date.parse(info.end))} `
    + `(ended by ${info.endReason}${args.values['synthetic-tail'] ? ', SYNTHETIC load/PV tail' : ''})`);
  console.log(`  import fit: a ${info.fit.a.toFixed(3)}, b ${info.fit.b.toFixed(2)} c, n ${info.fit.n}, mad ${info.fit.mad.toFixed(3)} c `
    + `(${info.fit.source}${info.fit.method ? `, ${info.fit.method}` : ''}); resolution ${info.resolution}`);
  if (info.freshFitRejection) console.log(`  fresh fit rejected: ${info.freshFitRejection.reason} (${info.freshFitRejection.message})`);
  const rel = info.exportRelation;
  console.log(`  export relation: ${rel ? (rel.kind === 'offset' ? `offset ${rel.offset_cents_per_kWh.toFixed(2)} c` : rel.kind) : 'none (market-priced)'}`);
  if (isRebalanceHoldDeferred(built.cfg)) console.log('  rebalance: the hold does not fit in the published-price part; it stays pending (deferred)');
  ext = await solve('extended', built.cfg, extendedSolveOptions({ firmObjective: firm.objective ?? NaN }));
  if (ext.status !== 'Optimal') {
    console.log(`  extended solve is ${ext.status}: the planner would keep the firm-only plan`);
  }
}

// ----------------------------- Report -------------------------------------

const runs = [firm, ...(ext ? [ext] : [])];
const num = (x: number | null, digits = 1) => (x != null && Number.isFinite(x) ? x.toFixed(digits) : '-');
const extRows = ext?.rows ?? null;
const lastEnd = (rows: PlanRow[]) => rows[rows.length - 1].timestampMs + stepMs;

console.log('');
for (const run of runs) {
  const rows = run.rows;
  const firmCost = rows ? netCostEuros(rows, 0, F) : NaN;
  const tailCost = rows && rows.length > F ? `, forecast part ${netCostEuros(rows, F).toFixed(2)} €` : '';
  console.log(`${run.label.padEnd(10)} ${run.status.padEnd(18)} ${String(run.cfg.load_W.length).padStart(4)} slots  `
    + `${Math.round(run.solveMs)} ms  objective ${num(run.objective, 2)}  firm-part net cost ${num(firmCost, 2)} €${tailCost}`);
}

const horizonEnd = Math.max(lastEnd(firmRows), extRows ? lastEnd(extRows) : 0);
const midnights = localMidnightsBetween(startMs, horizonEnd);
console.log('\nSoC % at local midnight (and at the plan end):');
console.log(`  ${''.padEnd(22)} ${'firm'.padStart(6)} ${extRows ? 'ext'.padStart(6) : ''}`);
for (const m of midnights) {
  console.log(`  ${localLabel(m).padEnd(22)} ${num(socAt(firmRows, settings.stepSize_m, m)).padStart(6)} `
    + `${extRows ? num(socAt(extRows, settings.stepSize_m, m)).padStart(6) : ''}${m === firmEndMs ? '  ← firm end' : ''}`);
}
console.log(`  ${'firm plan end'.padEnd(22)} ${num(firmRows[F - 1].soc_percent).padStart(6)} ${extRows ? num(extRows[F - 1].soc_percent).padStart(6) : ''}`);
if (extRows) console.log(`  ${'extended plan end'.padEnd(22)} ${''.padStart(6)} ${num(extRows[extRows.length - 1].soc_percent).padStart(6)}`);

console.log('\ngrid→battery kWh per local day:');
const firmG2b = gridToBatteryByDay(firmRows, settings.stepSize_m);
const extG2b = extRows ? gridToBatteryByDay(extRows, settings.stepSize_m) : null;
for (const day of new Set([...firmG2b.keys(), ...(extG2b?.keys() ?? [])])) {
  const label = localLabel(new Date(`${day}T12:00:00`).getTime(), false);
  console.log(`  ${label.padEnd(22)} ${num(firmG2b.get(day) ?? null, 2).padStart(6)} ${extG2b ? num(extG2b.get(day) ?? null, 2).padStart(6) : ''}`);
}

console.log('\nfirst 48 slots (W, %; f = forecast-priced slot):');
for (const line of sideBySideLines(firmRows, extRows, 48)) console.log(`  ${line}`);
if (args.values['synthetic-tail'] && ext) {
  console.log('\nNOTE: load/PV past the snapshot\'s end are SYNTHETIC (its last 24 h repeated); the extended plan is illustrative only.');
}
