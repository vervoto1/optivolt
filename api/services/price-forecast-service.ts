/**
 * Background refresh of the market price forecast (EpexPredictor) used by the
 * multi-day planning horizon (plans/multi-day-horizon-plan.md).
 *
 * The solve never waits on this: the data refresh calls
 * `maybeRefreshPriceForecast` without awaiting it, the refresh persists
 * `data.priceForecast` under the data store's lock, and the next solve reads
 * whatever is stored. A failed fetch keeps the stored forecast and warns; a
 * forecast older than 12 h counts as missing (`getPriceForecastStatus`).
 *
 * Each local day the first fetch after the day-ahead publication is also
 * logged (hourly, next 5 days) to DATA_DIR/price-forecast-log.json for the
 * offline accuracy script.
 */

import path from 'node:path';
import { resolveDataDir, readJson, writeJson, withJsonLock } from './json-store.ts';
import { updateData } from './data-store.ts';
import { withRetry } from './retry.ts';
import { fetchWithTimeout } from '../../lib/fetch-utils.ts';
import { resolveForecastSource } from './forecast-source.ts';
import {
  buildPriceForecastUrl,
  parsePriceForecastResponse,
  hourlyMeans,
  localMidnightMs,
} from '../../lib/price-forecast.ts';
import type { Data, Settings, ExtendedHorizonConfig, PriceForecastData } from '../types.ts';

export const PRICE_FORECAST_TIMEOUT_MS = 10_000;
export const PRICE_FORECAST_ATTEMPTS = 2;
/** A stored forecast older than this counts as missing. */
export const PRICE_FORECAST_STALE_MS = 12 * 60 * 60_000;
/**
 * Publication-triggered refetches are at least this far apart: VRM zero-fills
 * unpublished prices, and the feed can lag the EPEX publication, so "the
 * import prices reach past `publishedEnd`" may stay true for a while.
 */
export const PUBLICATION_REFETCH_MIN_MS = 30 * 60_000;
/** After a failed refresh, no new attempt for this long (fair use). */
export const FAILURE_BACKOFF_MS = 30 * 60_000;
/** Upper bound of the per-process jitter added to `refreshMinutes`. */
export const MAX_REFRESH_JITTER_MS = 10 * 60_000;
/**
 * A stored forecast is always due for a refresh by this age, whatever
 * `refreshMinutes` and the jitter say: 2 h before it turns stale, so a
 * refresh (and a retry after a failure back-off) lands before the extension
 * would stop for lack of a fresh forecast.
 */
export const MAX_REFRESH_AGE_MS = PRICE_FORECAST_STALE_MS - 2 * 60 * 60_000;
export const PRICE_FORECAST_LOG_LIMIT = 60;
export const PRICE_FORECAST_LOG_DAYS = 5;

const LOG_PATH = path.join(resolveDataDir(), 'price-forecast-log.json');
const DAY_MS = 24 * 60 * 60_000;

/** Per-process share of the jitter window, so installs do not refresh in lockstep. */
const JITTER_FRACTION = Math.random();

let inFlight: Promise<PriceForecastRefreshResult | null> | null = null;
let lastFailureMs: number | null = null;

// ----------------------------- Status -----------------------------------

export type PriceForecastState = 'fresh' | 'missing' | 'stale' | 'region';

export interface PriceForecastStatus {
  state: PriceForecastState;
  /** The forecast to plan with, or null when it is missing, stale or for another region. */
  forecast: PriceForecastData | null;
  /** Age of the stored forecast in ms (null when there is none). */
  ageMs: number | null;
}

/**
 * Whether the stored forecast may be used at `nowMs`: present, fetched for
 * the configured region, and at most 12 h old. A `fetchedAt` in the future
 * (a clock step) counts as age 0.
 */
export function getPriceForecastStatus(
  data: Pick<Data, 'priceForecast'>,
  cfg: Pick<ExtendedHorizonConfig, 'region'> | undefined,
  nowMs: number,
): PriceForecastStatus {
  const pf = data.priceForecast;
  if (!pf) return { state: 'missing', forecast: null, ageMs: null };
  const ageMs = Math.max(0, nowMs - Date.parse(pf.fetchedAt));
  if (cfg && pf.region !== cfg.region) return { state: 'region', forecast: null, ageMs };
  if (ageMs > PRICE_FORECAST_STALE_MS) return { state: 'stale', forecast: null, ageMs };
  return { state: 'fresh', forecast: pf, ageMs };
}

// ----------------------------- Refresh decision -------------------------

/**
 * End (ms) of the import prices that are actually published. VRM zero-fills
 * the unpublished slots, so for VRM it is `importPricePublishedUntil` when
 * stored, else the series end without its trailing zeros; for the other
 * sources it is the series end. Null without a usable series.
 */
export function publishedImportEndMs(
  data: Pick<Data, 'importPrice' | 'importPricePublishedUntil'>,
  priceSource: string,
): number | null {
  if (priceSource === 'vrm' && data.importPricePublishedUntil !== undefined) {
    const ms = Date.parse(data.importPricePublishedUntil);
    if (Number.isFinite(ms)) return ms;
  }
  const ts = data.importPrice;
  if (!ts || !Array.isArray(ts.values)) return null;
  const startMs = Date.parse(ts.start);
  if (!Number.isFinite(startMs)) return null;
  let n = ts.values.length;
  if (priceSource === 'vrm') {
    while (n > 0 && ts.values[n - 1] === 0) n--;
  }
  if (n === 0) return null;
  return startMs + n * (ts.step || 15) * 60_000;
}

export type RefreshReason = 'off' | 'backoff' | 'missing' | 'region' | 'age' | 'published' | 'fresh';

export interface RefreshDecision {
  refresh: boolean;
  reason: RefreshReason;
}

export interface RefreshDecisionOptions {
  /** Added to `refreshMinutes`; defaults to a per-process share of up to 10 min (10 % of the interval). */
  jitterMs?: number;
  /** Overrides the end of the published import prices (see `publishedImportEndMs`). */
  publishedImportEndMs?: number | null;
  /** Time of the last failed refresh (defaults to this process's record). */
  lastFailureMs?: number | null;
}

function defaultJitterMs(cfg: ExtendedHorizonConfig): number {
  return Math.round(JITTER_FRACTION * Math.min(MAX_REFRESH_JITTER_MS, cfg.refreshMinutes * 60_000 * 0.1));
}

/**
 * Refresh when there is no stored forecast (or it is for another region),
 * when it is older than `refreshMinutes` plus jitter (at most
 * `MAX_REFRESH_AGE_MS`, 2 h before it turns stale), or when the published
 * import prices reach past its `publishedEnd` (a new day was published since
 * the fetch). Never within `FAILURE_BACKOFF_MS` of a failed attempt.
 */
export function decidePriceForecastRefresh(
  settings: Pick<Settings, 'extendedHorizon' | 'dataSources'>,
  data: Pick<Data, 'priceForecast' | 'importPrice' | 'importPricePublishedUntil'>,
  nowMs: number,
  options: RefreshDecisionOptions = {},
): RefreshDecision {
  const cfg = settings.extendedHorizon;
  if (!cfg || cfg.mode === 'off') return { refresh: false, reason: 'off' };
  const failedAt = options.lastFailureMs === undefined ? lastFailureMs : options.lastFailureMs;
  if (failedAt != null && nowMs - failedAt < FAILURE_BACKOFF_MS) return { refresh: false, reason: 'backoff' };

  const pf = data.priceForecast;
  if (!pf) return { refresh: true, reason: 'missing' };
  if (pf.region !== cfg.region) return { refresh: true, reason: 'region' };

  const ageMs = nowMs - Date.parse(pf.fetchedAt);
  const jitterMs = options.jitterMs ?? defaultJitterMs(cfg);
  // A fetchedAt in the future (the clock was stepped back) or unparseable also refreshes.
  const dueAgeMs = Math.min(cfg.refreshMinutes * 60_000 + jitterMs, MAX_REFRESH_AGE_MS);
  if (!(ageMs >= 0 && ageMs < dueAgeMs)) return { refresh: true, reason: 'age' };

  const importEndMs = options.publishedImportEndMs !== undefined
    ? options.publishedImportEndMs
    : publishedImportEndMs(data, settings.dataSources.prices);
  if (importEndMs != null && importEndMs > Date.parse(pf.publishedEnd) && ageMs >= PUBLICATION_REFETCH_MIN_MS) {
    return { refresh: true, reason: 'published' };
  }
  return { refresh: false, reason: 'fresh' };
}

// ----------------------------- Fetch + persist --------------------------

export interface PriceForecastRefreshResult {
  ok: boolean;
  forecast?: PriceForecastData;
  /** Whether this fetch was written to the accuracy log. */
  logged?: boolean;
  error?: string;
}

/**
 * Fetch and parse the feed (10 s timeout, 2 attempts). `forecastUrl` is the
 * base URL to fetch from (already resolved: not `auto`). Throws on failure.
 */
export async function fetchPriceForecast(
  cfg: Pick<ExtendedHorizonConfig, 'forecastUrl' | 'region'>,
  nowMs: number,
): Promise<Omit<PriceForecastData, 'fit'>> {
  const url = buildPriceForecastUrl({ baseUrl: cfg.forecastUrl, region: cfg.region, nowMs });
  const parsed = await withRetry(async () => {
    const response = await fetchWithTimeout(
      url,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: PRICE_FORECAST_TIMEOUT_MS, label: 'Price forecast request' },
    );
    if (!response.ok) throw new Error(`Price forecast request returned status ${response.status}`);
    return parsePriceForecastResponse(await response.json());
  }, { attempts: PRICE_FORECAST_ATTEMPTS, label: 'price forecast' });

  return {
    fetchedAt: new Date(nowMs).toISOString(),
    publishedEnd: new Date(parsed.publishedEndMs).toISOString(),
    region: cfg.region,
    series: parsed.series,
  };
}

/**
 * Resolve the source (`forecastUrl` `auto`: the local add-on or the public
 * server), fetch, persist `data.priceForecast` with its source (keeping the
 * stored import fit when the region is unchanged) and log the daily snapshot.
 * Never throws: a failure keeps the stored forecast, warns, and starts the
 * failure back-off.
 */
export async function refreshPriceForecast(
  cfg: ExtendedHorizonConfig,
  nowMs: number,
): Promise<PriceForecastRefreshResult> {
  let forecast: PriceForecastData;
  try {
    const resolved = await resolveForecastSource(cfg.forecastUrl, { nowMs });
    if (resolved.source === 'public') {
      console.warn(`[price-forecast] local EpexPredictor add-on not used (${resolved.reason}): fetching from the public server`);
    }
    const fetched = await fetchPriceForecast({ forecastUrl: resolved.url, region: cfg.region }, nowMs);
    const source = {
      source: resolved.source,
      url: resolved.url,
      ...(resolved.reason !== undefined ? { sourceReason: resolved.reason } : {}),
    };
    const persisted = await updateData(current => {
      const previous = current.priceForecast;
      const fit = previous?.fit && previous.region === fetched.region ? { fit: previous.fit } : {};
      return { ...current, priceForecast: { ...fetched, ...fit, ...source } };
    });
    // v8 ignore next — updateData always returns the persisted object; ?? is defensive
    forecast = persisted.priceForecast ?? fetched;
  } catch (err) {
    lastFailureMs = nowMs;
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[price-forecast] refresh failed — keeping the stored forecast: ${error}`);
    return { ok: false, error };
  }
  lastFailureMs = null;
  const logged = await recordPriceForecastSnapshot(forecast, nowMs);
  console.log(`[price-forecast] fetched ${forecast.series.values.length} slots for ${forecast.region} from ${forecast.url}; published until ${forecast.publishedEnd}`);
  return { ok: true, forecast, logged };
}

/**
 * Start a background refresh when `decidePriceForecastRefresh` says so.
 * Returns a promise the caller should NOT await in the solve path; it never
 * rejects and resolves to the result, or null when nothing was started. While
 * a refresh is running, further calls join it instead of starting another.
 */
export function maybeRefreshPriceForecast(
  settings: Pick<Settings, 'extendedHorizon' | 'dataSources'>,
  data: Pick<Data, 'priceForecast' | 'importPrice' | 'importPricePublishedUntil'>,
  nowMs: number = Date.now(),
  options: RefreshDecisionOptions = {},
): Promise<PriceForecastRefreshResult | null> {
  if (inFlight) return inFlight;
  let decision: RefreshDecision;
  try {
    decision = decidePriceForecastRefresh(settings, data, nowMs, options);
  } catch (err) {
    console.warn('[price-forecast] could not decide on a refresh:', (err as Error).message);
    return Promise.resolve(null);
  }
  if (!decision.refresh) return Promise.resolve(null);
  console.log(`[price-forecast] refreshing (${decision.reason})`);
  const run = refreshPriceForecast(settings.extendedHorizon!, nowMs).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Resolves when the running background refresh (if any) has settled. For tests and shutdown. */
export async function waitForPriceForecastRefresh(): Promise<void> {
  await inFlight;
}

/** Test hook: forget the in-process failure record. */
export function resetPriceForecastServiceState(): void {
  lastFailureMs = null;
}

// ----------------------------- Accuracy log -----------------------------

export interface PriceForecastLogEntry {
  /** Local calendar day (server time zone) of the fetch, YYYY-MM-DD. */
  day: string;
  fetchedAt: string;
  region: string;
  publishedEnd: string;
  /** ISO start of the first hourly value: `publishedEnd` rounded up to the hour. */
  start: string;
  step: 60;
  /** Hourly mean forecast market price, c/kWh ex VAT, for up to 5 days. */
  values: number[];
}

export interface PriceForecastLog {
  entries: PriceForecastLogEntry[];
}

/** Local (server time zone) calendar day of `ms`, as YYYY-MM-DD. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The log entry for this fetch, or null before the day's publication (the
 * published prices must reach the local midnight after tomorrow) or when
 * there is no forecast past the published end.
 */
export function buildPriceForecastLogEntry(forecast: PriceForecastData, nowMs: number): PriceForecastLogEntry | null {
  const afterTomorrow = new Date(localMidnightMs(nowMs));
  afterTomorrow.setDate(afterTomorrow.getDate() + 2);
  const publishedEndMs = Date.parse(forecast.publishedEnd);
  if (publishedEndMs < afterTomorrow.getTime()) return null;
  const { startMs, values } = hourlyMeans(forecast.series, publishedEndMs, PRICE_FORECAST_LOG_DAYS * DAY_MS / 3_600_000);
  if (values.length === 0) return null;
  return {
    day: localDayKey(nowMs),
    fetchedAt: forecast.fetchedAt,
    region: forecast.region,
    publishedEnd: forecast.publishedEnd,
    start: new Date(startMs).toISOString(),
    step: 60,
    values,
  };
}

/** Read the accuracy log; a missing file is empty, an unreadable one is reset with a warning. */
export async function loadPriceForecastLog(): Promise<PriceForecastLog> {
  try {
    const log = await readJson<PriceForecastLog>(LOG_PATH);
    if (log && typeof log === 'object' && Array.isArray(log.entries)) return log;
    console.warn('[price-forecast] price-forecast-log.json is malformed; starting a new log');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[price-forecast] could not read price-forecast-log.json; starting a new log:', (err as Error).message);
    }
  }
  return { entries: [] };
}

/**
 * Append the day's snapshot when this is the first fetch after publication
 * for the local day (and region); keep the newest `PRICE_FORECAST_LOG_LIMIT`.
 * Returns whether an entry was written. Never throws.
 */
export async function recordPriceForecastSnapshot(forecast: PriceForecastData, nowMs: number): Promise<boolean> {
  const entry = buildPriceForecastLogEntry(forecast, nowMs);
  if (!entry) return false;
  try {
    return await withJsonLock(LOG_PATH, async () => {
      const log = await loadPriceForecastLog();
      if (log.entries.some(e => e.day === entry.day && e.region === entry.region)) return false;
      const entries = [...log.entries, entry].slice(-PRICE_FORECAST_LOG_LIMIT);
      await writeJson(LOG_PATH, { entries });
      return true;
    });
  } catch (err) {
    console.warn('[price-forecast] could not write the accuracy log:', (err as Error).message);
    return false;
  }
}
