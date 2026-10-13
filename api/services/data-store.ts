import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson, withJsonLock } from './json-store.ts';
import type { Data, PriceForecastData, TimeSeries } from '../types.ts';
import { validatePredictionAdjustment } from './prediction-adjustments.ts';
import { PRICE_FORECAST_REGIONS, PRICE_FORECAST_SOURCES, PRICE_FORECAST_STEP_M } from '../../lib/price-forecast.ts';

const DATA_DIR = resolveDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-data.json', import.meta.url));

type SeriesKey = 'load' | 'pv' | 'importPrice' | 'exportPrice' | 'marketPrice' | 'evLoad';

/**
 * How `validateData` treats values (see `ValidateDataOptions`):
 * - `strict`: every value must be a finite number (a `marketPrice` value may
 *   also be `null`, its documented "no price for this slot" marker);
 * - `lenient`: a non-finite value is logged once and kept (load path).
 */
type ValueCheck = 'strict' | 'lenient';

export interface ValidateDataOptions {
  /**
   * Load path. A series with a non-finite value is logged instead of
   * rejected, and an invalid `priceForecast` (a refetchable cache) is dropped
   * with a warning: data.json files written before 0.7.72 were never checked
   * for this, and a throw here would fail every plan and `GET /data`.
   */
  lenient?: boolean;
  /**
   * The data a write started from. A series that is still the same object as
   * there was accepted when it was loaded and is only checked structurally,
   * so a legacy value in a series nobody touched cannot block an unrelated
   * write (a SoC update, a prediction adjustment). Changed series are strict.
   */
  unchangedFrom?: Data;
}

const warnedSeries = new Set<string>();

function validateTimeSeries(ts: TimeSeries, label: string, values: ValueCheck = 'strict', allowNull = false): void {
  if (!ts || typeof ts !== 'object') {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  if (Number.isNaN(new Date(ts.start).getTime())) {
    throw new Error(`Invalid ${label}: 'start' is not a valid timestamp (${ts.start})`);
  }
  if (!Array.isArray(ts.values)) {
    throw new Error(`Invalid ${label}: 'values' must be an array`);
  }
  if (ts.step !== undefined && !(Number.isFinite(ts.step) && ts.step > 0)) {
    throw new Error(`Invalid ${label}: 'step' must be a positive number`);
  }
  const bad = ts.values.findIndex(v => !(typeof v === 'number' && Number.isFinite(v)) && !(allowNull && v === null));
  if (bad === -1) return;
  const message = `Invalid ${label}: values[${bad}] is not a finite number (${JSON.stringify(ts.values[bad])})`;
  if (values === 'strict') throw new Error(message);
  const key = `${label}@${ts.start}`;
  if (!warnedSeries.has(key)) {
    warnedSeries.add(key);
    console.warn(`[data-store] ${message}; kept as stored`);
  }
}

function assertTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`Invalid ${label}: must be a valid timestamp (${JSON.stringify(value)})`);
  }
}

function assertFinite(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: must be a finite number`);
  }
}

/** `data.priceForecast`: timestamps, a 15-minute series of finite values, an optional fit. */
export function validatePriceForecast(pf: PriceForecastData): void {
  if (!pf || typeof pf !== 'object' || Array.isArray(pf)) {
    throw new Error('Invalid priceForecast: must be an object');
  }
  assertTimestamp(pf.fetchedAt, 'priceForecast.fetchedAt');
  assertTimestamp(pf.publishedEnd, 'priceForecast.publishedEnd');
  if (!(PRICE_FORECAST_REGIONS as readonly unknown[]).includes(pf.region)) {
    throw new Error(`Invalid priceForecast.region: must be one of ${PRICE_FORECAST_REGIONS.join(', ')}`);
  }
  validateTimeSeries(pf.series, 'priceForecast.series');
  if (pf.series.step !== PRICE_FORECAST_STEP_M) {
    throw new Error(`Invalid priceForecast.series: 'step' must be ${PRICE_FORECAST_STEP_M}`);
  }
  if (pf.fit !== undefined) {
    const fit = pf.fit;
    if (!fit || typeof fit !== 'object' || Array.isArray(fit)) {
      throw new Error('Invalid priceForecast.fit: must be an object');
    }
    assertFinite(fit.a, 'priceForecast.fit.a');
    assertFinite(fit.b, 'priceForecast.fit.b');
    assertFinite(fit.mad, 'priceForecast.fit.mad');
    if (!Number.isInteger(fit.n) || fit.n < 0) {
      throw new Error('Invalid priceForecast.fit.n: must be a whole number ≥ 0');
    }
    assertTimestamp(fit.fittedAt, 'priceForecast.fit.fittedAt');
  }
  // Optional: a forecast stored before 0.7.73 has none of these.
  if (pf.source !== undefined && !(PRICE_FORECAST_SOURCES as readonly unknown[]).includes(pf.source)) {
    throw new Error(`Invalid priceForecast.source: must be one of ${PRICE_FORECAST_SOURCES.join(', ')}`);
  }
  if (pf.url !== undefined && (typeof pf.url !== 'string' || pf.url === '')) {
    throw new Error('Invalid priceForecast.url: must be a non-empty string');
  }
  if (pf.sourceReason !== undefined && typeof pf.sourceReason !== 'string') {
    throw new Error('Invalid priceForecast.sourceReason: must be a string');
  }
}

/**
 * Validate a data object. Without options every series must hold finite
 * numbers only (write paths); see `ValidateDataOptions` for the load path and
 * for writes that start from loaded data. Returns `d` (on the lenient path an
 * invalid `priceForecast` has been removed from it).
 */
export function validateData(d: Data, options: ValidateDataOptions = {}): Data {
  const { lenient = false, unchangedFrom } = options;
  const check = (key: SeriesKey): ValueCheck =>
    lenient || (unchangedFrom !== undefined && unchangedFrom[key] === d[key]) ? 'lenient' : 'strict';

  validateTimeSeries(d.load, 'load', check('load'));
  validateTimeSeries(d.pv, 'pv', check('pv'));
  validateTimeSeries(d.importPrice, 'importPrice', check('importPrice'));
  validateTimeSeries(d.exportPrice, 'exportPrice', check('exportPrice'));
  if (d.marketPrice !== undefined) {
    validateTimeSeries(d.marketPrice, 'marketPrice', check('marketPrice'), true);
  }
  if (!Number.isFinite(d.soc.value)) {
    throw new Error('Invalid soc: value must be a finite number; refresh VRM data first');
  }
  if (Number.isNaN(new Date(d.soc.timestamp).getTime())) {
    throw new Error(`Invalid soc: 'timestamp' is not a valid timestamp (${d.soc.timestamp})`);
  }
  if (d.evLoad) {
    validateTimeSeries(d.evLoad, 'evLoad', check('evLoad'));
  }
  if (d.importPricePublishedUntil !== undefined) {
    try {
      assertTimestamp(d.importPricePublishedUntil, 'importPricePublishedUntil');
    } catch (err) {
      // Server-derived (VRM refresh) and rewritten on the next refresh: drop it
      // on load rather than fail every plan.
      if (!lenient) throw err;
      console.warn(`[data-store] ${(err as Error).message}; dropping it`);
      delete d.importPricePublishedUntil;
    }
  }
  if (d.lastFullSocAt !== undefined && d.lastFullSocAt !== null) {
    if (typeof d.lastFullSocAt !== 'string' || Number.isNaN(new Date(d.lastFullSocAt).getTime())) {
      throw new Error(`Invalid lastFullSocAt: must be null or a valid timestamp (${d.lastFullSocAt})`);
    }
  }
  if (d.predictionAdjustments !== undefined) {
    if (!Array.isArray(d.predictionAdjustments)) {
      throw new Error("Invalid predictionAdjustments: must be an array");
    }
    for (const adjustment of d.predictionAdjustments) {
      validatePredictionAdjustment(adjustment);
    }
  }
  if (d.priceForecast !== undefined) {
    try {
      validatePriceForecast(d.priceForecast);
    } catch (err) {
      if (!lenient) throw err;
      console.warn(`[data-store] ${(err as Error).message}; dropping the stored price forecast`);
      delete d.priceForecast;
    }
  }
  return d;
}

/**
 * Load stored data or fall back to defaults.
 */
export async function loadData(): Promise<Data> {
  try {
    return validateData(await readJson<Data>(DATA_PATH), { lenient: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const defaults = await readJson<Data>(DEFAULT_PATH);

    // Shift defaults to "start of current hour" so we have full 24h of future data
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startTimeStr = now.toISOString();

    defaults.load.start = startTimeStr;
    defaults.pv.start = startTimeStr;
    defaults.importPrice.start = startTimeStr;
    defaults.exportPrice.start = startTimeStr;
    defaults.soc.timestamp = startTimeStr;
    if (defaults.evLoad) {
      defaults.evLoad.start = startTimeStr;
    }

    return validateData(defaults);
  }
}

/**
 * Persist data to DATA_DIR/data.json (pretty-printed).
 *
 * Prefer `updateData`: a plain save writes back whatever snapshot the caller
 * loaded, so anything another writer persisted in between is lost. The save
 * still queues behind the store's lock so it never interleaves with an
 * in-flight `updateData`.
 */
export async function saveData(data: Data): Promise<void> {
  validateData(data);
  await withJsonLock(DATA_PATH, () => writeJson(DATA_PATH, data));
}

/**
 * Read-modify-write data.json under the store's lock.
 *
 * Several writers share this file: the planner (live SoC, rebalance state,
 * pruned adjustments), the VRM/forecast refresh, prediction-adjustment CRUD,
 * forecast persists and `POST /data`. Some of them load the file, await
 * multi-second HA/MQTT/forecast round-trips, then used to save the whole
 * object back — silently reverting any write that landed in between (e.g. a
 * prediction adjustment created mid-plan). `mutate` receives the freshly
 * loaded data and returns what to persist, or `null` to leave the file
 * untouched. It must be synchronous and must not call back into this store
 * (that would wait on the lock it is running under). Returns the data as it
 * stands afterwards: the persisted value, or the loaded one when `mutate`
 * returned `null`. A throwing `mutate` or a failed validation rejects without
 * writing.
 */
export async function updateData(mutate: (current: Data) => Data | null): Promise<Data> {
  return withJsonLock(DATA_PATH, async () => {
    const current = await loadData();
    const next = mutate(current);
    if (!next) return current;
    validateData(next, { unchangedFrom: current });
    await writeJson(DATA_PATH, next);
    return next;
  });
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultData(): Promise<Data> {
  return readJson<Data>(DEFAULT_PATH);
}
