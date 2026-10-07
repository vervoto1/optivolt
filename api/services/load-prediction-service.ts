/**
 * load-prediction-service.ts
 *
 * Orchestrates HA data fetch → postprocess → predict/validate.
 */

import { fetchHaStats } from './ha-client.ts';
import { postprocess, getSensorNames } from '../../lib/ha-postprocess.ts';
import type { HaDerivedSensor, HaSensor, StatRecord } from '../../lib/ha-postprocess.ts';
import {
  predict,
  validate,
  buildPredictIndex,
  generateAllConfigs,
  DEFAULT_LOOKBACK_WEEKS,
} from '../../lib/load-predictor-historical.ts';
import type { DayFilter, Aggregation, PredictConfig, PredictIndex, PredictTarget } from '../../lib/load-predictor-historical.ts';
import {
  buildTemperatureAnchors,
  computeDayMeanTemps,
  computeEffectiveDayTemps,
  dayKey,
  generateTemperatureConfigs,
  missingTemperatureDays,
  predictTemperatureLoad,
  predictTemperatureLoadRolling,
  summarizeTemperatureDays,
  shiftDayKey,
  temperaturePastDays,
  TEMPERATURE_GRID_LOOKBACK_WEEKS,
} from '../../lib/load-predictor-temperature.ts';
import type { TemperaturePredictConfig, TemperatureDaySummary } from '../../lib/load-predictor-temperature.ts';
import { fetchTemperatureSeries } from './open-meteo-client.ts';
import { hasPvCoordinates } from './pv-coordinates.ts';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { PredictionRunConfig } from '../types.ts';
import { getForecastTimeRange, buildForecastSeries, computeErrorMetrics, type ForecastSeries, type PredictionResult } from '../../lib/time-series-utils.ts';

export interface ValidationEntry {
  type: 'historical';
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
  mae: number;
  rmse: number;
  mape: number;
  /** Window hours scored — the same for every strategy of a sensor that takes part in the common-hour intersection (see scoreOnData). */
  n: number;
  /** Window hours this strategy could not predict at all (its own gaps, before the common-hour intersection). */
  nSkipped: number;
  validationPredictions: PredictionResult[];
}

/**
 * A temperature-predictor row of the comparison table. Scored on the hours
 * the sensor's historical rows share (see `scoreTemperatureOnData`), so its
 * metrics compare head-to-head with theirs.
 */
export interface TemperatureValidationEntry {
  type: 'temperature';
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  bins: number;
  mae: number;
  rmse: number;
  mape: number;
  n: number;
  nSkipped: number;
  validationPredictions: PredictionResult[];
}

/* v8 ignore start — type-only interface property assignments */
interface ValidationRunResult {
  sensorNames: string[];
  // v8 ignore next — type-only interface property
  results: Array<ValidationEntry | TemperatureValidationEntry>;
  /** Why part of the grid was not scored (e.g. temperature rows without coordinates). */
  warnings: string[];
}
/* v8 ignore end */

export interface ForecastRunResult {
  forecast: ForecastSeries;
  recent: PredictionResult[];
  metrics: { mae: number; rmse: number; mape: number; n: number };
  /** Set when the forecast was (partly) produced by a fallback, e.g. the temperature predictor's historical fallback. */
  warnings?: string[];
}

export interface ValidationWindow {
  start: string;
  end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * WebSocket timeout for the bulk backtest fetches. The 30 s client default was
 * sized for the live forecast's few-week query; a 27–30-week grid fetch is a
 * 4–5 MB recorder query running on the same host as OptiVolt.
 */
export const BACKTEST_FETCH_TIMEOUT_MS = 120_000;

/**
 * Weeks of HA history needed to backtest strategies with the given lookbacks
 * over `validationWindow`: the longest lookback plus the window itself.
 */
export function fetchHorizonWeeks(lookbackWeeks: readonly number[], validationWindow: ValidationWindow): number {
  const maxLookback = lookbackWeeks.reduce((max, weeks) => Math.max(max, weeks), 0);
  const windowMs = new Date(validationWindow.end).getTime() - new Date(validationWindow.start).getTime();
  return maxLookback + Math.max(1, Math.ceil(windowMs / WEEK_MS));
}

/** The name `postprocess` files a sensor's readings under. */
function sensorNameOf(sensor: HaSensor): string {
  return sensor.name ?? sensor.id;
}

/**
 * HA entity ids needed to build the named series: every configured sensor
 * that maps onto the name (several entities can share one — DSMR tariff 1+2
 * are summed into one "Grid Import") and, for a derived sensor, the ids
 * behind each formula term, followed through nested derived sensors. A name
 * nothing maps onto falls back to every configured entity, which yields the
 * same "no data" result as today for a stale name. `postprocess` silently
 * treats a missing formula reference as 0, so narrowing has to be exact: a
 * derived series built from a partial fetch would be wrong, not empty.
 */
export function entityIdsForSensors(sensors: HaSensor[], derived: HaDerivedSensor[], names: readonly string[]): string[] {
  const wanted = new Set<string>();
  const visit = (name: string) => {
    if (wanted.has(name)) return;
    wanted.add(name);
    const formula = derived.find(d => d.name === name)?.formula ?? [];
    for (const term of formula) visit(term.slice(1));
  };
  names.forEach(visit);
  const ids = sensors.filter(s => wanted.has(sensorNameOf(s))).map(s => s.id);
  return ids.length > 0 ? ids : sensors.map(s => s.id);
}

/**
 * Fetch `weeks` of history for the given entities (every configured sensor
 * when `entityIds` is omitted) and postprocess it with the full sensor and
 * derived config.
 */
async function fetchHistory(config: PredictionRunConfig, weeks: number, entityIds?: string[]): Promise<StatRecord[]> {
  const { haUrl, haToken, sensors, derived } = config;
  const startTime = new Date(Date.now() - weeks * WEEK_MS).toISOString();
  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds: entityIds ?? sensors.map(s => s.id),
    startTime,
    timeoutMs: BACKTEST_FETCH_TIMEOUT_MS,
  });
  return postprocess(rawData, sensors, derived);
}

/**
 * The history behind the last comparison run, kept so the table's Chart
 * button can be served from it (see `scoreStrategyPredictions`). One entry:
 * the UI holds one comparison at a time, and the records are a few hundred
 * kilobytes. There is deliberately no TTL — the chart must agree with the
 * table it was opened from, and the table is whatever the last run produced,
 * however long ago; a new run replaces the entry.
 */
interface ValidationHistory {
  /** Sensor/derived config + fetch horizon the history was built for. */
  key: string;
  weeks: number;
  data: StatRecord[];
  validationWindow: ValidationWindow;
  /** Effective day temperatures behind the temperature rows; null when that part of the grid was skipped. */
  temperature: { coordsKey: string; effTemps: Map<string, number> } | null;
}

let lastValidationHistory: ValidationHistory | null = null;

function historyKey(config: PredictionRunConfig): string {
  return JSON.stringify({ sensors: config.sensors, derived: config.derived });
}

function coordsKey(config: PredictionRunConfig): string {
  return JSON.stringify([config.pvConfig?.latitude ?? null, config.pvConfig?.longitude ?? null]);
}

/** Test hook: forget the history cached by the last `runValidation`. */
export function clearValidationHistory(): void {
  lastValidationHistory = null;
}

export interface ScoreOptions {
  /** Return each strategy's per-hour predictions (the chart data) — off by default, they are large. */
  includePredictions?: boolean;
  /**
   * Window hours a strategy must be able to predict on its own to take part
   * in the common-hour intersection. Strategies below it are scored on their
   * own hours instead, so their `n` stays below the floor and the selector
   * drops them — without dragging every other strategy's `n` down with them.
   * Defaults to 0 (every strategy takes part — the comparison table).
   */
  minCoverage?: number;
}

/**
 * Score strategies against already-fetched history. Only the entries inside
 * the validation window are predicted (passed as `predict()` targets):
 * predicting the whole history is the dominant cost of a validation run and
 * grows with the lookback grid, while everything outside the window is
 * discarded anyway. The per-sensor history index and past-day chains are
 * built once and shared by every strategy of that sensor.
 *
 * Every strategy of a sensor is scored on the same hours — the intersection
 * of the window hours each of them could predict. Without that, a strategy
 * that skipped 20 % of the window (a recorder gap exactly one of its lookback
 * periods before the window) would be ranked head-to-head against one that
 * scored every hour, on means computed over different hour sets. `nSkipped`
 * still reports each strategy's own gaps so a shrunken `n` can be traced.
 *
 * The intersection is taken among the strategies that clear `minCoverage`
 * on their own. Otherwise the most gap-sensitive strategy in the grid —
 * `1w/same`, whose only source for a target hour is the same hour a week
 * earlier — turns one recorder gap into every strategy of the sensor
 * reporting the same shrunken `n`, and when that lands under the selector's
 * floor the whole grid is "no-eligible" for as long as the gap sits inside
 * the lookback.
 */
function scoreOnData(
  data: StatRecord[],
  strategies: PredictConfig[],
  validationWindow: ValidationWindow,
  options: ScoreOptions = {},
): ValidationEntry[] {
  return scoreHistoricalOnData(data, strategies, validationWindow, options).entries;
}

function scoreHistoricalOnData(
  data: StatRecord[],
  strategies: PredictConfig[],
  validationWindow: ValidationWindow,
  { includePredictions = false, minCoverage = 0 }: ScoreOptions = {},
): { entries: ValidationEntry[]; commonHoursBySensor: Map<string, Set<number>> } {
  const windowStart = new Date(validationWindow.start).getTime();
  const windowEnd = new Date(validationWindow.end).getTime();
  const maxLookback = strategies.reduce((max, s) => Math.max(max, s.lookbackWeeks), 0);
  const bySensor = new Map<string, { targets: PredictTarget[]; index: PredictIndex }>();

  const predicted = strategies.map(cfg => {
    let entry = bySensor.get(cfg.sensor);
    if (!entry) {
      const targets = data.filter(d => d.sensor === cfg.sensor && d.time >= windowStart && d.time < windowEnd);
      entry = { targets, index: buildPredictIndex(data, cfg.sensor, targets, maxLookback) };
      bySensor.set(cfg.sensor, entry);
    }
    const predictions = predict(data, cfg, entry.targets, entry.index);
    const own = new Set(predictions.filter(p => p.predicted !== null).map(p => p.time));
    return { cfg, predictions, own, covered: own.size >= minCoverage };
  });

  // Hours every covering strategy of the sensor could predict.
  const commonHoursBySensor = new Map<string, Set<number>>();
  for (const { cfg, own, covered } of predicted) {
    if (!covered) continue;
    const common = commonHoursBySensor.get(cfg.sensor);
    commonHoursBySensor.set(cfg.sensor, common ? new Set([...common].filter(t => own.has(t))) : own);
  }

  const entries = predicted.map(({ cfg, predictions, own, covered }): ValidationEntry => {
    const hours = covered ? commonHoursBySensor.get(cfg.sensor)! : own;
    const metrics = validate(predictions.filter(p => hours.has(p.time)), validationWindow);

    return {
      type: 'historical',
      sensor: cfg.sensor,
      lookbackWeeks: cfg.lookbackWeeks,
      dayFilter: cfg.dayFilter,
      aggregation: cfg.aggregation,
      mae: metrics.mae,
      rmse: metrics.rmse,
      mape: metrics.mape,
      n: metrics.n,
      nSkipped: predictions.filter(p => p.predicted === null).length,
      validationPredictions: includePredictions ? predictions : [],
    };
  });
  return { entries, commonHoursBySensor };
}

/**
 * Score temperature strategies against already-fetched history, rolling the
 * anchors per scored day (`predictTemperatureLoadRolling`) so a day never
 * feeds its own anchors.
 *
 * Hour basis: when `historicalHoursBySensor` is given (the comparison run), a
 * row is scored on the hours its sensor's historical rows share, intersected
 * with the hours it could predict itself. The historical rows — and so every
 * number the table showed before temperature rows existed — are left exactly
 * as they were, and a temperature row that covers the whole basis has the
 * same `n` as the historical rows it is ranked against. A row that could not
 * predict some of those hours (a day without a temperature, too few days for
 * an anchor) shows a smaller `n` instead of shrinking anyone else's.
 */
function scoreTemperatureOnData(
  data: StatRecord[],
  strategies: TemperaturePredictConfig[],
  effTemps: Map<string, number>,
  validationWindow: ValidationWindow,
  historicalHoursBySensor: Map<string, Set<number>> | null,
  { includePredictions = false }: { includePredictions?: boolean } = {},
): TemperatureValidationEntry[] {
  const windowStart = new Date(validationWindow.start).getTime();
  const windowEnd = new Date(validationWindow.end).getTime();
  const bySensor = new Map<string, { targets: PredictTarget[]; summaries: Map<string, TemperatureDaySummary> }>();

  return strategies.map((cfg): TemperatureValidationEntry => {
    let entry = bySensor.get(cfg.sensor);
    if (!entry) {
      entry = {
        targets: data.filter(d => d.sensor === cfg.sensor && d.time >= windowStart && d.time < windowEnd),
        summaries: summarizeTemperatureDays(data, cfg.sensor, effTemps),
      };
      bySensor.set(cfg.sensor, entry);
    }
    const predictions = predictTemperatureLoadRolling(entry.summaries, cfg, entry.targets, effTemps);
    const basis = historicalHoursBySensor?.get(cfg.sensor);
    const scored = predictions.filter(p => p.predicted !== null && (!basis || basis.has(p.time)));
    const metrics = validate(scored, validationWindow);
    return {
      type: 'temperature',
      sensor: cfg.sensor,
      lookbackWeeks: cfg.lookbackWeeks,
      dayFilter: cfg.dayFilter,
      bins: cfg.bins,
      mae: metrics.mae,
      rmse: metrics.rmse,
      mape: metrics.mape,
      n: metrics.n,
      nSkipped: predictions.filter(p => p.predicted === null).length,
      validationPredictions: includePredictions ? predictions : [],
    };
  });
}

/** Message used whenever the temperature predictor is asked to run without a site location. */
export const TEMPERATURE_MISSING_COORDINATES_MESSAGE =
  'the temperature predictor needs the site latitude/longitude (PV forecast settings)';

/**
 * Effective day temperatures covering `lookbackWeeks` of anchors before every
 * day from `fromMs` on, through `forecastDays` UTC days from today. Throws
 * when the site has no coordinates or Open-Meteo fails.
 */
async function fetchEffectiveDayTemps(
  config: PredictionRunConfig,
  lookbackWeeks: number,
  fromMs: number,
  forecastDays: number,
  nowMs: number = Date.now(),
): Promise<Map<string, number>> {
  if (!hasPvCoordinates(config.pvConfig)) throw new Error(TEMPERATURE_MISSING_COORDINATES_MESSAGE);
  const { latitude, longitude } = config.pvConfig!;
  const extraDays = Math.max(0, Math.ceil((nowMs - fromMs) / DAY_MS));
  const temps = await fetchTemperatureSeries(latitude, longitude, temperaturePastDays(lookbackWeeks, extraDays), forecastDays);
  return computeEffectiveDayTemps(computeDayMeanTemps(temps));
}

/**
 * A warning when days in [fromKey, toKey) have no effective temperature, or
 * null when all do. Open-Meteo fills only about the last 68 `past_days`
 * (OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA) and silently drops the null
 * hours, so a window reaching past that would otherwise build its anchors
 * from fewer days than configured without anyone noticing.
 */
function temperatureCoverageWarning(
  effTemps: Map<string, number>,
  fromKey: string,
  toKey: string,
  what: string,
): string | null {
  const { missing, total } = missingTemperatureDays(effTemps, fromKey, toKey);
  if (missing.length === 0) return null;
  const message = `${missing.length} of ${total} days ${what} (${missing[0]}…${missing[missing.length - 1]}) `
    + 'have no Open-Meteo temperature; the temperature anchors use fewer days than configured';
  console.warn(`[predict] ${message}`);
  return message;
}

/**
 * Fetch history once and score an explicit list of strategies over a window.
 * Used by the auto-selector; `runValidation` (the UI comparison) shares the
 * same scoring core so both always agree on the numbers.
 */
export async function scoreStrategies(
  config: PredictionRunConfig,
  strategies: PredictConfig[],
  validationWindow: ValidationWindow,
  options: ScoreOptions = {},
): Promise<ValidationEntry[]> {
  const weeks = fetchHorizonWeeks(strategies.map(s => s.lookbackWeeks), validationWindow);
  // Only the entities behind the scored sensors — the selector scores one
  // sensor, and a 27–30-week query for every configured entity is the
  // dominant cost of a run.
  const entityIds = entityIdsForSensors(config.sensors, config.derived, [...new Set(strategies.map(s => s.sensor))]);
  const data = await fetchHistory(config, weeks, entityIds);
  return scoreOnData(data, strategies, validationWindow, options);
}

/**
 * Run full validation across all config combinations. Returns metrics only:
 * the per-hour predictions of a single strategy are fetched on demand with
 * `scoreStrategyPredictions` (the UI opens one chart at a time, and shipping
 * 80 strategies × every window hour per sensor was ~15 MB uncompressed).
 */
export async function runValidation(config: PredictionRunConfig): Promise<ValidationRunResult> {
  // validationWindow is always set by loadPredictionConfig()
  const validationWindow = config.validationWindow!;
  const weeks = fetchHorizonWeeks(DEFAULT_LOOKBACK_WEEKS, validationWindow);
  const data = await fetchHistory(config, weeks);
  const sensorNames = getSensorNames(data);
  const { entries, commonHoursBySensor } = scoreHistoricalOnData(data, generateAllConfigs(sensorNames), validationWindow);

  // Temperature rows are evaluation only: they never reach the live forecast
  // or the auto-selector. Without coordinates, or when Open-Meteo fails, the
  // table keeps its historical rows and says why the rest is missing.
  const warnings: string[] = [];
  let temperatureRows: TemperatureValidationEntry[] = [];
  let temperature: ValidationHistory['temperature'] = null;
  if (sensorNames.length > 0) {
    try {
      const maxLookback = Math.max(...TEMPERATURE_GRID_LOOKBACK_WEEKS);
      const windowStartMs = new Date(validationWindow.start).getTime();
      const effTemps = await fetchEffectiveDayTemps(config, maxLookback, windowStartMs, 2);
      temperature = { coordsKey: coordsKey(config), effTemps };
      // The longest-lookback rows read back to here from the first window day.
      const coverage = temperatureCoverageWarning(
        effTemps,
        shiftDayKey(dayKey(windowStartMs), maxLookback * 7),
        dayKey(new Date(validationWindow.end).getTime()),
        'behind the temperature rows',
      );
      if (coverage) warnings.push(`Temperature strategies: ${coverage}`);
      // One sensor at a time, yielding in between: the 64-config rolling grid
      // is synchronous work on the process that also drives MQTT, and per
      // sensor it stays a short block instead of one long one.
      for (const sensor of sensorNames) {
        temperatureRows.push(...scoreTemperatureOnData(
          data, generateTemperatureConfigs([sensor]), effTemps, validationWindow, commonHoursBySensor,
        ));
        await yieldToEventLoop();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[predict] temperature strategies skipped:', message);
      warnings.push(`Temperature strategies skipped: ${message}`);
    }
  }

  lastValidationHistory = { key: historyKey(config), weeks, data, validationWindow, temperature };
  return { sensorNames, results: [...entries, ...temperatureRows], warnings };
}

/**
 * Per-hour actual vs predicted for one strategy over the comparison window
 * (the data behind the comparison table's Chart button). Scored alone, so its
 * metrics are not on the table's common-hour basis — only the predictions are
 * returned.
 *
 * Served from the history of the last comparison run whenever that run used
 * the same sensor config and fetched far enough back: the chart is then
 * computed on exactly the data and window behind the row it was opened from
 * (a fresh fetch after a UTC-midnight rollover would plot a different window
 * than the row's metrics), and a click does not cost another multi-week
 * recorder query on the host that is also driving MQTT. Anything else — no
 * run yet in this process, a sensor edit since, a lookback past the grid —
 * falls back to a fetch for the config's own window.
 */
export async function scoreStrategyPredictions(
  config: PredictionRunConfig,
  strategy: PredictConfig,
): Promise<{ strategy: PredictConfig; validationPredictions: PredictionResult[] }> {
  const cached = lastValidationHistory;
  if (
    cached &&
    cached.key === historyKey(config) &&
    fetchHorizonWeeks([strategy.lookbackWeeks], cached.validationWindow) <= cached.weeks
  ) {
    const [entry] = scoreOnData(cached.data, [strategy], cached.validationWindow, { includePredictions: true });
    return { strategy, validationPredictions: entry.validationPredictions };
  }
  const validationWindow = config.validationWindow!;
  const [entry] = await scoreStrategies(config, [strategy], validationWindow, { includePredictions: true });
  return { strategy, validationPredictions: entry.validationPredictions };
}

/**
 * Per-hour actual vs predicted for one temperature strategy over the
 * comparison window — the temperature counterpart of
 * `scoreStrategyPredictions`, served from the last comparison run's history
 * and temperatures when they match, refetched otherwise.
 */
export async function scoreTemperatureStrategyPredictions(
  config: PredictionRunConfig,
  strategy: TemperaturePredictConfig,
): Promise<{ strategy: TemperaturePredictConfig; validationPredictions: PredictionResult[] }> {
  const cached = lastValidationHistory;
  if (
    cached?.temperature &&
    cached.key === historyKey(config) &&
    cached.temperature.coordsKey === coordsKey(config) &&
    strategy.lookbackWeeks <= Math.max(...TEMPERATURE_GRID_LOOKBACK_WEEKS) &&
    fetchHorizonWeeks([strategy.lookbackWeeks], cached.validationWindow) <= cached.weeks
  ) {
    const [entry] = scoreTemperatureOnData(
      cached.data, [strategy], cached.temperature.effTemps, cached.validationWindow, null, { includePredictions: true },
    );
    return { strategy, validationPredictions: entry.validationPredictions };
  }
  const validationWindow = config.validationWindow!;
  const weeks = fetchHorizonWeeks([strategy.lookbackWeeks], validationWindow);
  const entityIds = entityIdsForSensors(config.sensors, config.derived, [strategy.sensor]);
  const [data, effTemps] = await Promise.all([
    fetchHistory(config, weeks, entityIds),
    fetchEffectiveDayTemps(config, strategy.lookbackWeeks, new Date(validationWindow.start).getTime(), 2),
  ]);
  const [entry] = scoreTemperatureOnData(data, [strategy], effTemps, validationWindow, null, { includePredictions: true });
  return { strategy, validationPredictions: entry.validationPredictions };
}

/** Hourly targets from the current hour up to `endMs` (the forecast horizon). */
function buildFutureTargets(nowMs: number, endMs: number): PredictTarget[] {
  const targets: PredictTarget[] = [];
  for (let t = Math.floor(nowMs / 3600000) * 3600000; t < endMs; t += 3600000) {
    const d = new Date(t);
    targets.push({ date: d.toISOString(), time: t, hour: d.getUTCHours(), dayOfWeek: d.getUTCDay(), value: null });
  }
  return targets;
}

/**
 * Live load forecast from the temperature predictor (opt-in: only when the
 * user set `activeType: 'temperature'`).
 *
 * The forecast feeds the LP every auto-calculate tick, so this never hands
 * back a worse series than the historical predictor would:
 *   - no site coordinates, Open-Meteo down, or no anchor for any forecast
 *     hour → the whole forecast comes from `historicalPredictor`;
 *   - some forecast hours without a temperature prediction → those hours
 *     come from `historicalPredictor` (never a silent 0 W);
 * each with a `warnings` entry and a log line. Without a historical
 * predictor to fall back on it throws instead, and the caller keeps the
 * previous series — the same outcome as any other failed forecast.
 * An HA failure throws exactly like the historical path. Lookback days that
 * came back from Open-Meteo without a temperature only add a `warnings`
 * entry: the anchors are built from the days that remain.
 *
 * Recent accuracy is out of sample: anchors are rebuilt per scored day with
 * the cutoff at that day's start.
 */
async function runTemperatureForecast(config: PredictionRunConfig): Promise<ForecastRunResult> {
  const { temperaturePredictor: tp, historicalPredictor: hp, haUrl, haToken, sensors, derived } = config;
  if (!tp) throw new Error('temperaturePredictor is required for the temperature activeType');

  // `prefetched`: the history already fetched for the temperature model, passed
  // on when it covers what the historical forecast reads, so a fallback does
  // not run the same recorder query twice.
  const fallback = async (reason: string, prefetched?: StatRecord[]): Promise<ForecastRunResult> => {
    if (!hp?.sensor) {
      throw new Error(`Temperature load forecast unavailable (${reason}) and no historical predictor is configured to fall back on`);
    }
    console.warn(`[predict] temperature load forecast fell back to the historical predictor: ${reason}`);
    const result = await runHistoricalForecast(config, prefetched);
    return { ...result, warnings: [`Temperature forecast unavailable (${reason}); the historical predictor was used instead`] };
  };

  // Permanent until the user sets a location: fall back before any HA query
  // rather than fetching history the temperature model cannot use.
  if (!hasPvCoordinates(config.pvConfig)) return fallback(TEMPERATURE_MISSING_COORDINATES_MESSAGE);

  const includeRecent = config.includeRecent !== false;
  const extraWeeks = includeRecent ? 1 : 0;
  const nowMs = Date.now();
  const { startIso, endIso } = getForecastTimeRange(nowMs);
  const futureEnd = new Date(endIso).getTime();
  const futureTargets = buildFutureTargets(nowMs, futureEnd);
  const todayStartUtc = Math.floor(nowMs / DAY_MS) * DAY_MS;
  // +1: the last local day of the horizon ends after the UTC day it starts in.
  const forecastDays = Math.max(2, Math.ceil((futureEnd - todayStartUtc) / DAY_MS) + 1);

  const entityIds = entityIdsForSensors(sensors, derived, [tp.sensor]);
  const startTime = new Date(nowMs - (tp.lookbackWeeks + extraWeeks) * WEEK_MS).toISOString();
  const [rawRes, tempRes] = await Promise.allSettled([
    fetchHaStats({ haUrl, haToken, entityIds, startTime }),
    fetchEffectiveDayTemps(config, tp.lookbackWeeks, nowMs - extraWeeks * WEEK_MS, forecastDays, nowMs),
  ]);
  if (rawRes.status === 'rejected') throw rawRes.reason;
  const data = postprocess(rawRes.value, sensors, derived);
  // Same entities and at least the weeks runHistoricalForecast would fetch.
  const reusable = hp?.sensor === tp.sensor && hp.lookbackWeeks <= tp.lookbackWeeks ? data : undefined;
  if (tempRes.status === 'rejected') {
    return fallback(tempRes.reason instanceof Error ? tempRes.reason.message : String(tempRes.reason), reusable);
  }

  const effTemps = tempRes.value;
  const model = buildTemperatureAnchors(data, effTemps, tp, nowMs);
  const future = predictTemperatureLoad(model, tp.dayFilter, futureTargets, effTemps);
  const missing = future.filter(p => p.predicted === null).length;
  if (future.length > 0 && missing === future.length) {
    return fallback('no temperature anchors or forecast temperatures for the forecast window', reusable);
  }

  const warnings: string[] = [];
  // Every day the anchors read: the lookback before today, and before the
  // first recent-accuracy day when that backtest runs.
  const coverage = temperatureCoverageWarning(
    effTemps,
    shiftDayKey(dayKey(includeRecent ? nowMs - WEEK_MS : nowMs), tp.lookbackWeeks * 7),
    dayKey(nowMs),
    'in the temperature lookback',
  );
  if (coverage) warnings.push(coverage);
  let values = future.map(p => p.predicted);
  if (missing > 0) {
    if (!hp?.sensor) {
      throw new Error(`Temperature load forecast could not predict ${missing} of ${future.length} hours and no historical predictor is configured to fill them`);
    }
    // The fetched window already reaches back far enough for the historical
    // predictor when it predicts the same sensor with no longer a lookback.
    const histData = hp.sensor === tp.sensor && hp.lookbackWeeks <= tp.lookbackWeeks + extraWeeks
      ? data
      : postprocess(await fetchHaStats({
        haUrl,
        haToken,
        entityIds: entityIdsForSensors(sensors, derived, [hp.sensor]),
        startTime: new Date(nowMs - hp.lookbackWeeks * WEEK_MS).toISOString(),
      }), sensors, derived);
    const hist = predict(histData, hp, futureTargets);
    values = values.map((v, i) => v ?? hist[i].predicted);
    const message = `${missing} of ${future.length} forecast hours had no temperature prediction; the historical predictor filled them`;
    console.warn(`[predict] ${message}`);
    warnings.push(message);
  }

  const forecast = buildForecastSeries(
    futureTargets.map((t, i) => ({ time: t.time, value: values[i] ?? 0 })),
    startIso,
    endIso,
  );

  let recent: PredictionResult[] = [];
  if (includeRecent) {
    const recentStart = nowMs - WEEK_MS;
    const recentTargets = data.filter(d => d.sensor === tp.sensor && d.time >= recentStart && d.time <= nowMs);
    recent = predictTemperatureLoadRolling(summarizeTemperatureDays(data, tp.sensor, effTemps), tp, recentTargets, effTemps);
  }
  const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);

  return { forecast, recent, metrics, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Run forecast for tomorrow using the active config.
 * Caller must ensure config.activeType is set.
 */
export async function runForecast(config: PredictionRunConfig): Promise<ForecastRunResult> {
  const { activeType, historicalPredictor, fixedPredictor, haUrl, haToken, sensors, derived } = config;

  if (activeType === 'fixed') {
    const load_W = fixedPredictor!.load_W;
    const nowMs = Date.now();
    const { startIso, endIso } = getForecastTimeRange(nowMs);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const nSlots = Math.round((endMs - startMs) / (15 * 60 * 1000));
    const forecast: ForecastSeries = { start: startIso, step: 15, values: Array(nSlots).fill(load_W) };

    const canComputeAccuracy =
      config.includeRecent !== false &&
      historicalPredictor?.sensor &&
      sensors.length > 0 &&
      (!!process.env.SUPERVISOR_TOKEN || (haUrl.length > 0 && haToken.length > 0));

    if (!canComputeAccuracy) {
      return { forecast, recent: [], metrics: { mae: NaN, rmse: NaN, mape: NaN, n: 0 } };
    }

    const past7d = nowMs - 7 * 24 * 60 * 60 * 1000;
    const entityIds = entityIdsForSensors(sensors, derived, [historicalPredictor!.sensor]);
    const rawData = await fetchHaStats({ haUrl, haToken, entityIds, startTime: new Date(past7d).toISOString() });
    const data = postprocess(rawData, sensors, derived);

    const recent: PredictionResult[] = data
      .filter(d => d.sensor === historicalPredictor!.sensor && d.time >= past7d)
      .map(d => ({
        date: d.date,
        time: d.time,
        hour: d.hour,
        /* v8 ignore next — d.value ?? null branch is untestable in jsdom */
        actual: d.value ?? null,
        predicted: load_W,
      }));

    const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);
    return { forecast, recent, metrics };
  }

  if (activeType === 'temperature') return runTemperatureForecast(config);
  return runHistoricalForecast(config);
}

/**
 * Live load forecast from `historicalPredictor` (also the temperature
 * predictor's fallback). `prefetched` is postprocessed history the caller
 * already holds for the same sensor's entities over at least the
 * lookbackWeeks + 1 weeks this would fetch; `predict()` only reads back
 * `lookbackWeeks` from each target, so a longer window changes nothing.
 */
async function runHistoricalForecast(config: PredictionRunConfig, prefetched?: StatRecord[]): Promise<ForecastRunResult> {
  const { historicalPredictor, haUrl, haToken, sensors, derived } = config;

  let data = prefetched;
  if (!data) {
    // Every cycle refetches lookbackWeeks + 1 weeks; only the entities behind
    // the predicted sensor are needed (merge- and derived-aware).
    const entityIds = entityIdsForSensors(sensors, derived, [historicalPredictor!.sensor]);

    const extraWeeks = config.includeRecent !== false ? 1 : 0;
    const totalWeeks = historicalPredictor!.lookbackWeeks + extraWeeks;
    const startTime = new Date(Date.now() - totalWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

    const rawData = await fetchHaStats({
      haUrl,
      haToken,
      entityIds,
      startTime,
    });

    data = postprocess(rawData, sensors, derived);
  }

  const now = new Date();
  const { startIso, endIso } = getForecastTimeRange(now.getTime());
  const end = new Date(endIso);

  const recentStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentEnd = now.getTime();

  const recentTargets = data.filter(d =>
    d.sensor === historicalPredictor!.sensor &&
    d.time >= recentStart &&
    d.time <= recentEnd
  );

  const futureTargets: PredictTarget[] = [];
  const futureStart = Math.floor(now.getTime() / 3600000) * 3600000;
  const futureEnd = end.getTime();

  for (let t = futureStart; t < futureEnd; t += 3600000) {
    const d = new Date(t);
    futureTargets.push({
      date: d.toISOString(),
      time: t,
      hour: d.getUTCHours(),
      dayOfWeek: d.getUTCDay(),
      value: null,
    });
  }

  const allTargets: PredictTarget[] = [...recentTargets, ...futureTargets];
  const predictions = predict(data, historicalPredictor!, allTargets);

  const mappedPoints = predictions.map(p => ({ time: p.time, value: p.predicted ?? 0 }));
  const forecastSeries = buildForecastSeries(mappedPoints, startIso, endIso);

  let recent: PredictionResult[] = [];
  if (config.includeRecent !== false) {
    const nowMs = now.getTime();
    const past7d = nowMs - 7 * 24 * 60 * 60 * 1000;

    recent = predictions
      .filter(p => p.time <= nowMs && p.time >= past7d)
      .map(p => ({
        date: p.date,
        time: p.time,
        hour: p.hour,
        actual: p.actual,
        predicted: p.predicted,
      }));
  }

  const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);

  return { forecast: forecastSeries, recent, metrics };
}
