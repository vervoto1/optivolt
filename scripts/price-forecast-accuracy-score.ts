/**
 * Scoring for the price forecast accuracy script (scripts/price-forecast-accuracy.ts).
 *
 * The add-on logs, once per local day after the day-ahead publication, the
 * hourly mean forecast market price for the next 5 days after the published
 * end (DATA_DIR/price-forecast-log.json, see api/services/price-forecast-service.ts).
 * This compares those values with the prices that were published later
 * (hourly means of the feed's quarter-hourly published prices) and reports
 * the mean absolute error and the bias (forecast − actual) by lead day and by
 * hour of day. Pure: the script does the file and HTTP I/O.
 *
 * Lead day 1 is the first local day after the published end at fetch time
 * (the day the next auction prices), lead day 2 the day after, and so on.
 * Days and hours are the process time zone's, as the log's `day` key: run
 * with TZ=<the box's zone>.
 */
import { parsePriceForecastResponse, type ParsedPriceForecast } from '../lib/price-forecast.ts';

const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;

/** One log entry (PriceForecastLogEntry in api/services/price-forecast-service.ts). */
export interface ForecastLogEntry {
  day: string;
  fetchedAt: string;
  region: string;
  publishedEnd: string;
  start: string;
  step: number;
  values: number[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read price-forecast-log.json (`{ entries }`, or a bare array of entries). Throws on a malformed entry. */
export function parseForecastLog(json: unknown, source = 'forecast log'): ForecastLogEntry[] {
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.entries) ? json.entries : null;
  if (!list) throw new Error(`${source}: not a price-forecast-log.json ({ entries: [...] })`);
  return list.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const ok = isObject(entry)
      && typeof e.region === 'string'
      && typeof e.start === 'string' && Number.isFinite(Date.parse(e.start))
      && typeof e.publishedEnd === 'string' && Number.isFinite(Date.parse(e.publishedEnd))
      && e.step === 60
      && Array.isArray(e.values) && e.values.every(v => typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new Error(`${source}: entries[${i}] is not an hourly forecast log entry`);
    return entry as unknown as ForecastLogEntry;
  });
}

/**
 * Published hourly prices from a feed response: the mean of the four
 * quarter-hours of every whole hour that ends at or before the published end.
 * Keyed by hour start (ms).
 */
export function actualHourlyPrices(parsed: ParsedPriceForecast): Map<number, number> {
  const out = new Map<number, number>();
  const startMs = Date.parse(parsed.series.start);
  const values = parsed.series.values;
  const firstHour = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  for (let hour = firstHour; hour + HOUR_MS <= parsed.publishedEndMs; hour += HOUR_MS) {
    const i = (hour - startMs) / QUARTER_MS;
    if (i + 4 > values.length) break;
    out.set(hour, (values[i] + values[i + 1] + values[i + 2] + values[i + 3]) / 4);
  }
  return out;
}

/**
 * `actualHourlyPrices` of a feed response (an `actualsRequests` fetch or a
 * saved `--actuals` file). Parsed without the planner's 10-day slot cap: a
 * history response spans up to `actualsRequests`' 30 days.
 */
export function actualsFromResponse(body: unknown): Map<number, number> {
  return actualHourlyPrices(parsePriceForecastResponse(body, { maxSlots: Infinity }));
}

/** The hour range [startMs, endMs) the entries forecast. Null without any values. */
export function forecastRange(entries: ForecastLogEntry[]): { startMs: number; endMs: number } | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const e of entries) {
    if (e.values.length === 0) continue;
    const s = Date.parse(e.start);
    startMs = Math.min(startMs, s);
    endMs = Math.max(endMs, s + e.values.length * HOUR_MS);
  }
  return Number.isFinite(startMs) ? { startMs, endMs } : null;
}

/**
 * Feed requests for the published prices of the forecast range: from its
 * start to its end, but never past `nowMs` + 2 days (nothing later is
 * published), in chunks of at most `maxDays` days.
 */
export function actualsRequests(entries: ForecastLogEntry[], nowMs: number, maxDays = 30): Array<{ startMs: number; hours: number }> {
  const range = forecastRange(entries);
  if (!range) return [];
  const endMs = Math.min(range.endMs, Math.ceil((nowMs + 2 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS);
  const out: Array<{ startMs: number; hours: number }> = [];
  for (let s = range.startMs; s < endMs; s += maxDays * 24 * HOUR_MS) {
    out.push({ startMs: s, hours: Math.ceil((Math.min(endMs, s + maxDays * 24 * HOUR_MS) - s) / HOUR_MS) });
  }
  return out;
}

/** The feed URL for published prices from `startMs` for `hours` hours (quarter-hourly, c/kWh ex VAT). */
export function actualsUrl(baseUrl: string, region: string, startMs: number, hours: number): string {
  const url = new URL(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/prices`;
  url.searchParams.set('region', region);
  url.searchParams.set('unit', 'CT_PER_KWH');
  url.searchParams.set('startTs', new Date(startMs).toISOString());
  url.searchParams.set('hours', String(hours));
  return url.toString();
}

function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * HOUR_MS));
}

/** Lead day of the hour starting at `hourMs` for a forecast whose published prices ended at `publishedEndMs` (1 = the first day after). */
export function leadDay(hourMs: number, publishedEndMs: number): number {
  return localDayIndex(hourMs) - localDayIndex(publishedEndMs) + 1;
}

export interface ErrorStats {
  n: number;
  /** Mean |forecast − actual|, c/kWh. NaN when n = 0. */
  mae: number;
  /** Mean (forecast − actual), c/kWh: positive means the forecast was too high. */
  bias: number;
  /** Root mean square error, c/kWh. */
  rmse: number;
}

class Accumulator {
  n = 0;
  abs = 0;
  sum = 0;
  sq = 0;
  add(error: number) { this.n++; this.abs += Math.abs(error); this.sum += error; this.sq += error * error; }
  stats(): ErrorStats {
    return this.n === 0
      ? { n: 0, mae: NaN, bias: NaN, rmse: NaN }
      : { n: this.n, mae: this.abs / this.n, bias: this.sum / this.n, rmse: Math.sqrt(this.sq / this.n) };
  }
}

export interface AccuracyScore {
  overall: ErrorStats;
  /** Index 0 is lead day 1. */
  byLead: ErrorStats[];
  /** Local hour of day 0–23. */
  byHour: ErrorStats[];
  /** Entries with at least one scored hour. */
  entriesScored: number;
  /** Forecast hours without a published price (not yet published, or missing from the actuals). */
  unscoredHours: number;
}

/** Score the log entries against the published hourly prices (`actuals`, keyed by hour start). */
export function scoreForecastLog(entries: ForecastLogEntry[], actuals: Map<number, number>, maxLead = 5): AccuracyScore {
  const overall = new Accumulator();
  const byLead = Array.from({ length: maxLead }, () => new Accumulator());
  const byHour = Array.from({ length: 24 }, () => new Accumulator());
  let entriesScored = 0;
  let unscoredHours = 0;
  for (const e of entries) {
    const startMs = Date.parse(e.start);
    const publishedEndMs = Date.parse(e.publishedEnd);
    let scored = false;
    e.values.forEach((forecast, h) => {
      const hourMs = startMs + h * HOUR_MS;
      const lead = leadDay(hourMs, publishedEndMs);
      if (lead < 1 || lead > maxLead) return;
      const actual = actuals.get(hourMs);
      if (actual === undefined) {
        unscoredHours++;
        return;
      }
      const error = forecast - actual;
      overall.add(error);
      byLead[lead - 1].add(error);
      byHour[new Date(hourMs).getHours()].add(error);
      scored = true;
    });
    if (scored) entriesScored++;
  }
  return {
    overall: overall.stats(),
    byLead: byLead.map(a => a.stats()),
    byHour: byHour.map(a => a.stats()),
    entriesScored,
    unscoredHours,
  };
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const statCells = (s: ErrorStats) => [String(s.n).padStart(6), fmt(s.mae).padStart(7), fmt(s.bias).padStart(7), fmt(s.rmse).padStart(7)].join(' ');

/** The score as text tables (c/kWh ex VAT). */
export function formatScore(score: AccuracyScore): string[] {
  const header = (label: string) => `${label.padEnd(10)} ${'n'.padStart(6)} ${'MAE'.padStart(7)} ${'bias'.padStart(7)} ${'RMSE'.padStart(7)}`;
  return [
    `entries scored: ${score.entriesScored}; forecast hours without a published price: ${score.unscoredHours}`,
    '',
    header('lead day'),
    ...score.byLead.map((s, i) => `${String(i + 1).padEnd(10)} ${statCells(s)}`),
    `${'all'.padEnd(10)} ${statCells(score.overall)}`,
    '',
    header('hour'),
    ...score.byHour.map((s, h) => `${`${String(h).padStart(2, '0')}:00`.padEnd(10)} ${statCells(s)}`),
    '',
    'c/kWh ex VAT; bias = forecast − actual (positive: forecast too high).',
  ];
}
