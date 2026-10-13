#!/usr/bin/env -S npx --no-install tsx
/**
 * Accuracy of the logged market price forecasts (plans/multi-day-horizon-plan.md).
 *
 * Reads the accuracy log the add-on keeps with `extendedHorizon.mode`
 * `collect` or `on` (DATA_DIR/price-forecast-log.json: one snapshot per local
 * day after the day-ahead publication, hourly, for the next 5 days), compares
 * it with the prices that were published later, and prints MAE, bias
 * (forecast − actual) and RMSE by lead day (1–5) and by local hour of day,
 * in c/kWh ex VAT. Use it to set `extendedHorizon.riskMargin_cents_per_kWh`.
 *
 * Usage:
 *   npx --no-install tsx scripts/price-forecast-accuracy.ts [price-forecast-log.json]
 *       [--actuals <feed response>]... [--url <feed base URL>]
 *
 * The log defaults to $DATA_DIR/price-forecast-log.json (DATA_DIR defaults to
 * data/). The published prices come from the feed's history (`startTs` reaches
 * about 90 days back): one GET per 30-day range per region, from --url
 * (default https://epexpredictor.batzill.com). --actuals instead takes saved
 * feed responses (GET <feed>/prices?region=..&unit=CT_PER_KWH&startTs=..&hours=..),
 * and nothing is fetched; only their published part (up to knownUntil) counts.
 * Days and hours are the process time zone's: run with TZ=<the box's zone>.
 *
 * Exit code 2: bad invocation, unreadable input or a failed fetch.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataDir } from '../api/services/json-store.ts';
import { fetchWithTimeout } from '../lib/fetch-utils.ts';
import {
  actualsFromResponse, actualsRequests, actualsUrl, formatScore, parseForecastLog, scoreForecastLog, type ForecastLogEntry,
} from './price-forecast-accuracy-score.ts';

const usage = 'usage: npx --no-install tsx scripts/price-forecast-accuracy.ts [price-forecast-log.json] [--actuals <file>]... [--url <feed base URL>]';
const args = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        actuals: { type: 'string', multiple: true },
        url: { type: 'string', default: 'https://epexpredictor.batzill.com' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    process.exit(2);
  }
})();
if (args.positionals.length > 1) {
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

const logPath = args.positionals[0] ?? path.join(resolveDataDir(), 'price-forecast-log.json');
let entries: ForecastLogEntry[];
try {
  entries = parseForecastLog(readJson(logPath), logPath);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`${logPath}: ${entries.length} entries${entries.length ? ` (${entries[0].day} … ${entries[entries.length - 1].day})` : ''}; time zone ${tz}`);
if (entries.length === 0) process.exit(0);

const byRegion = new Map<string, ForecastLogEntry[]>();
for (const e of entries) byRegion.set(e.region, [...(byRegion.get(e.region) ?? []), e]);

const savedActuals = new Map<number, number>();
for (const file of args.values.actuals ?? []) {
  try {
    for (const [hour, price] of actualsFromResponse(readJson(file))) savedActuals.set(hour, price);
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    process.exit(2);
  }
}

for (const [region, list] of byRegion) {
  let actuals = savedActuals;
  if (!args.values.actuals) {
    actuals = new Map();
    for (const { startMs, hours } of actualsRequests(list, Date.now())) {
      const url = actualsUrl(args.values.url!, region, startMs, hours);
      try {
        const res = await fetchWithTimeout(url, {}, { timeoutMs: 30_000, label: 'price feed' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const [hour, price] of actualsFromResponse(await res.json())) actuals.set(hour, price);
      } catch (err) {
        console.error(`${url}: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    console.log(`${region}: ${actuals.size} published hours fetched from ${args.values.url}`);
  }
  console.log(`\n== ${region} ==`);
  for (const line of formatScore(scoreForecastLog(list, actuals))) console.log(line);
}
