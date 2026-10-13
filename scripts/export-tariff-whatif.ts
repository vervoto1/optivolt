#!/usr/bin/env -S npx --no-install tsx
/**
 * What-if for the end of net metering (plans/end-of-net-metering-plan.md).
 *
 * Solves one snapshot three times with the vendored HiGHS, changing only
 * `settings.exportTariff`: the block absent, `netMetering`, and `marketPrice`
 * (see scripts/export-tariff-whatif-config.ts), and prints per mode the planned
 * battery→grid, PV→grid, PV→battery and grid→battery energy (kWh), the final
 * SoC and the planned net grid cost.
 *
 * Usage:
 *   npx --no-install tsx scripts/export-tariff-whatif.ts data.json settings.json
 *       [--calibration <file>]... [--market market-entity.json] [--allow-fallback]
 *
 * data.json / settings.json are GET /data and GET /settings (or the DATA_DIR
 * files). The config is built through the planner's own path, as the solver
 * gate does (scripts/solver-gate-config.ts): prediction adjustments from
 * data.json, then the learned charge taper when adaptive learning is in auto
 * mode; pass production's calibration with --calibration (the
 * GET /plan-accuracy/calibration response, or calibration.json /
 * ev-calibration.json; repeat the flag for both). NOW=<ISO timestamp> overrides
 * the plan start (default: the start of the load series).
 *
 * --market takes the GET /ha/entity/sensor.gespot_hourly_market_average_price_nl
 * response from the add-on and injects it as data.marketPrice, read with the
 * snapshot's haPriceConfig attribute/key/multiplier/interval settings, and
 * counts as the market source whatever the snapshot's price source. Without
 * it a data.marketPrice already in data.json is used when the snapshot's price
 * source supplies one (as the planner decides). Market slots without a
 * price fall back to 0 c; the marketPrice comparison is refused when there are
 * any, unless --allow-fallback.
 *
 * Exit code 1: the absent and netMetering LPs differ (net metering must be
 * byte-identical to the pre-tariff plan), the marketPrice run has fallback
 * slots without --allow-fallback, or a mode returns no usable solution.
 * Exit code 2: bad invocation or unreadable input.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildGateConfig, mergeCalibrationSnapshots, parseCalibrationSnapshot } from './solver-gate-config.ts';
import {
  marketSeriesFromEntity, settingsForMode, summarizeFlows, withInjectedMarketSource, WHATIF_MODES, type WhatIfMode,
} from './export-tariff-whatif-config.ts';
import { isMarketSourceConfigured } from '../api/services/config-builder.ts';
import { buildLP } from '../lib/build-lp.ts';
import { solveOptionsFor } from '../lib/solve-options.ts';
import { parseSolution, SolverStatusError, type HighsSolution } from '../lib/parse-solution.ts';
import type { SolverConfig } from '../lib/types.ts';
import type { Data, Settings } from '../api/types.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const usage = 'usage: npx --no-install tsx scripts/export-tariff-whatif.ts data.json settings.json '
  + '[--calibration <file>]... [--market market-entity.json] [--allow-fallback]';
const args = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        calibration: { type: 'string', multiple: true },
        market: { type: 'string' },
        'allow-fallback': { type: 'boolean' },
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
const settings = readJson(settingsArg) as Settings;
const startMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.parse(data.load?.start);
if (!Number.isFinite(startMs)) {
  console.error(`cannot tell the plan start: ${process.env.NOW ? `NOW=${process.env.NOW}` : 'data.load.start'} is not a timestamp`);
  process.exit(2);
}
let calibration: ReturnType<typeof mergeCalibrationSnapshots> | undefined;
try {
  calibration = args.values.calibration
    ? mergeCalibrationSnapshots(args.values.calibration.map(f => parseCalibrationSnapshot(readJson(f), f)))
    : undefined;
  if (args.values.market) {
    data.marketPrice = marketSeriesFromEntity(readJson(args.values.market), settings, startMs, args.values.market);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const planSettings = args.values.market ? withInjectedMarketSource(settings) : settings;
const marketNote = args.values.market ? `from ${args.values.market}`
  : !data.marketPrice ? 'none'
    : isMarketSourceConfigured(settings, data) ? 'data.json marketPrice'
      : `data.json marketPrice ignored (no market source with ${settings.dataSources.prices} prices)`;
console.log(`plan start ${new Date(startMs).toISOString()}; market prices: ${marketNote}`);

interface ModeRun { mode: WhatIfMode; cfg: SolverConfig; lp: string }
const runs: ModeRun[] = [];
for (const mode of WHATIF_MODES) {
  const { cfg, notes } = await buildGateConfig({ settings: settingsForMode(planSettings, mode), data, startMs, calibration });
  // The notes describe the snapshot, not the mode: print them once.
  if (mode === 'absent') for (const note of notes) (note.startsWith('WARNING') ? console.warn : console.log)(note);
  runs.push({ mode, cfg, lp: buildLP(cfg) });
}
const byMode = (mode: WhatIfMode) => runs.find(r => r.mode === mode)!;

if (byMode('absent').lp !== byMode('netMetering').lp) {
  console.error('FAIL: the netMetering LP differs from the LP without an exportTariff block');
  process.exit(1);
}
console.log('netMetering LP is identical to the LP without an exportTariff block');

const market = byMode('marketPrice').cfg;
const info = market.exportTariffInfo;
console.log(`marketPrice: ${info?.marketPricedSlots ?? 0} market-priced slots, fallbackSlots ${info?.fallbackSlots ?? 0} of ${market.exportPrice.length}`
  + (info?.terminalOverride
    ? `; terminal SoC valued ${info.terminalOverride.terminalSocValuation} ${info.terminalOverride.terminalSocCustomPrice_cents_per_kWh.toFixed(2)} c/kWh`
    : ''));
if ((info?.fallbackSlots ?? 0) > 0 && !args.values['allow-fallback']) {
  console.error('REFUSED: the marketPrice run has fallback slots (export valued at 0 c for lack of a market price); '
    + 'pass --market with the market entity, or --allow-fallback to compare anyway');
  process.exit(1);
}

interface HighsModule { solve(lp: string, options?: Record<string, unknown>): HighsSolution & { Status: string; ObjectiveValue: number } }
const factory = require(path.join(root, 'vendor/highs-build/highs.js')) as () => Promise<HighsModule>;

const pad = (s: string, n: number) => s.padStart(n);
const num = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : '-');
console.log(['mode'.padEnd(12), pad('status', 10), pad('bat→grid', 9), pad('pv→grid', 9), pad('pv→bat', 9), pad('grid→bat', 9),
  pad('final SoC', 10), pad('net cost €', 11), pad('objective', 11)].join(' '));
let unusable = false;
for (const { mode, cfg, lp } of runs) {
  const highs = await factory();
  const result = highs.solve(lp, solveOptionsFor(cfg));
  let rows: ReturnType<typeof parseSolution>;
  try {
    rows = parseSolution(result, cfg, { startMs, stepMin: cfg.stepSize_m });
  } catch (err) {
    if (!(err instanceof SolverStatusError)) throw err;
    console.error(`${mode}: ${err.message}`);
    unusable = true;
    continue;
  }
  const t = summarizeFlows(rows, cfg.stepSize_m);
  console.log([mode.padEnd(12), pad(result.Status, 10), pad(num(t.batteryToGrid_kWh), 9), pad(num(t.pvToGrid_kWh), 9),
    pad(num(t.pvToBattery_kWh), 9), pad(num(t.gridToBattery_kWh), 9), pad(`${num(t.finalSoc_percent, 1)} %`, 10),
    pad(num(t.netGridCost_cents / 100), 11), pad(num(result.ObjectiveValue), 11)].join(' '));
}
console.log('kWh over the horizon; net cost = import cost − export revenue at each mode\'s own export prices; objective in c€.');
if (unusable) {
  console.error('FAIL: a mode returned no usable solution');
  process.exit(1);
}
