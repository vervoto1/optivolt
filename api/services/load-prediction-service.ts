/**
 * load-prediction-service.ts
 *
 * Orchestrates HA data fetch → postprocess → predict/validate.
 */

import { fetchHaStats } from './ha-client.ts';
import { postprocess, getSensorNames } from '../../lib/ha-postprocess.ts';
import type { StatRecord } from '../../lib/ha-postprocess.ts';
import {
  predict,
  validate,
  buildPredictIndex,
  generateAllConfigs,
  DEFAULT_LOOKBACK_WEEKS,
} from '../../lib/load-predictor-historical.ts';
import type { DayFilter, Aggregation, PredictConfig, PredictIndex, PredictTarget } from '../../lib/load-predictor-historical.ts';
import type { PredictionRunConfig } from '../types.ts';
import { getForecastTimeRange, buildForecastSeries, computeErrorMetrics, type ForecastSeries, type PredictionResult } from '../../lib/time-series-utils.ts';

export interface ValidationEntry {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
  mae: number;
  rmse: number;
  mape: number;
  /** Window hours scored — the same for every strategy of a sensor (see scoreOnData). */
  n: number;
  /** Window hours this strategy could not predict at all (its own gaps, before the common-hour intersection). */
  nSkipped: number;
  validationPredictions: PredictionResult[];
}

/* v8 ignore start — type-only interface property assignments */
interface ValidationRunResult {
  sensorNames: string[];
  // v8 ignore next — type-only interface property
  results: ValidationEntry[];
}
/* v8 ignore end */

export interface ForecastRunResult {
  forecast: ForecastSeries;
  recent: PredictionResult[];
  metrics: { mae: number; rmse: number; mape: number; n: number };
}

export interface ValidationWindow {
  start: string;
  end: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

async function fetchHistory(config: PredictionRunConfig, weeks: number): Promise<StatRecord[]> {
  const { haUrl, haToken, sensors, derived } = config;
  const startTime = new Date(Date.now() - weeks * WEEK_MS).toISOString();
  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds: sensors.map(s => s.id),
    startTime,
    timeoutMs: BACKTEST_FETCH_TIMEOUT_MS,
  });
  return postprocess(rawData, sensors, derived);
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
 */
function scoreOnData(
  data: StatRecord[],
  strategies: PredictConfig[],
  validationWindow: ValidationWindow,
  includePredictions: boolean,
): ValidationEntry[] {
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
    return { cfg, predictions: predict(data, cfg, entry.targets, entry.index) };
  });

  // Hours every strategy of the sensor could predict.
  const commonHoursBySensor = new Map<string, Set<number>>();
  for (const { cfg, predictions } of predicted) {
    const own = new Set(predictions.filter(p => p.predicted !== null).map(p => p.time));
    const common = commonHoursBySensor.get(cfg.sensor);
    commonHoursBySensor.set(cfg.sensor, common ? new Set([...common].filter(t => own.has(t))) : own);
  }

  return predicted.map(({ cfg, predictions }) => {
    const common = commonHoursBySensor.get(cfg.sensor)!;
    const metrics = validate(predictions.filter(p => common.has(p.time)), validationWindow);

    return {
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
  { includePredictions = false }: { includePredictions?: boolean } = {},
): Promise<ValidationEntry[]> {
  const weeks = fetchHorizonWeeks(strategies.map(s => s.lookbackWeeks), validationWindow);
  const data = await fetchHistory(config, weeks);
  return scoreOnData(data, strategies, validationWindow, includePredictions);
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
  const data = await fetchHistory(config, fetchHorizonWeeks(DEFAULT_LOOKBACK_WEEKS, validationWindow));
  const sensorNames = getSensorNames(data);
  const results = scoreOnData(data, generateAllConfigs(sensorNames), validationWindow, false);
  return { sensorNames, results };
}

/**
 * Per-hour actual vs predicted for one strategy over the comparison window
 * (the data behind the comparison table's Chart button). Scored alone, so its
 * metrics are not on the table's common-hour basis — only the predictions are
 * returned.
 */
export async function scoreStrategyPredictions(
  config: PredictionRunConfig,
  strategy: PredictConfig,
): Promise<{ strategy: PredictConfig; validationPredictions: PredictionResult[] }> {
  const validationWindow = config.validationWindow!;
  const [entry] = await scoreStrategies(config, [strategy], validationWindow, { includePredictions: true });
  return { strategy, validationPredictions: entry.validationPredictions };
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
    const matchingSensor = sensors.find(s => (s.name || s.id) === historicalPredictor!.sensor);
    const entityIds = matchingSensor ? [matchingSensor.id] : sensors.map(s => s.id);
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

  const entityIds = sensors.map(s => s.id);

  const extraWeeks = config.includeRecent !== false ? 1 : 0;
  const totalWeeks = historicalPredictor!.lookbackWeeks + extraWeeks;
  const startTime = new Date(Date.now() - totalWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);

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
