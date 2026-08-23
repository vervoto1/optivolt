import { assertCondition, toHttpError } from '../http-errors.ts';
import type { PredictionAdjustmentSeries, PredictionRunConfig, TimeSeries } from '../types.ts';
import { loadPredictionConfig } from './prediction-config-store.ts';
import { runValidation, runForecast as runLoadForecast, scoreStrategyPredictions } from './load-prediction-service.ts';
import type { PredictConfig } from '../../lib/load-predictor-historical.ts';
import { formatStrategy } from '../../lib/strategy-selector.ts';
import type { ForecastRunResult } from './load-prediction-service.ts';
import { runPvForecast } from './pv-prediction-service.ts';
import type { PvForecastRunResult } from './pv-prediction-service.ts';
import { loadData, saveData } from './data-store.ts';
import { loadSettings } from './settings-store.ts';
import { applyPredictionAdjustmentsToSeries, pruneExpiredPredictionAdjustments } from './prediction-adjustments.ts';
import { loadActiveAdjustmentsAndPrune } from './prediction-adjustment-store.ts';

export async function buildPredictionRunConfig(): Promise<PredictionRunConfig> {
  const [config, settings] = await Promise.all([loadPredictionConfig(), loadSettings()]);
  return { ...config, haUrl: settings.haUrl, haToken: settings.haToken };
}

/**
 * The guards every HA-backed prediction call shares: an HA connection and at
 * least one sensor (400), a log line, and one error mapping — HA connection
 * failures become a 502 so the UI can tell "HA is down" from a bug. The
 * mapping lives in `mapPredictionError` only; the validation and chart paths
 * used to carry their own copies that had already drifted from it.
 */
async function runWithHaGuards<T>(
  config: PredictionRunConfig,
  type: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
  { isPv = false }: { isPv?: boolean } = {},
): Promise<T> {
  assertHaConnection(config);
  assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(type, meta);

  try {
    return await fn();
  } catch (err) {
    throw mapPredictionError(err, isPv);
  }
}

export function executePredictionValidation(config: PredictionRunConfig) {
  return runWithHaGuards(config, 'validate', { sensors: config.sensors.length }, () => runValidation(config));
}

/** Per-hour predictions for one strategy (the comparison table's Chart button); same guards and HA error mapping as validation. */
export function executeStrategyPredictions(config: PredictionRunConfig, strategy: PredictConfig) {
  return runWithHaGuards(
    config,
    'validate/strategy',
    { strategy: `${strategy.sensor}/${formatStrategy(strategy)}` },
    () => scoreStrategyPredictions(config, strategy),
  );
}

export async function runCombinedPredictionForecast(config: PredictionRunConfig, endpoint: string) {
  const [loadResult, pvResult] = await Promise.all([
    executeLoadForecast(config, endpoint).catch(handleCombinedForecastError('load', endpoint)),
    executePvForecast(config, endpoint).catch(handleCombinedForecastError('pv', endpoint)),
  ]);
  let adjustments: ReturnType<typeof pruneExpiredPredictionAdjustments>['adjustments'] = [];
  try {
    adjustments = await persistForecastAndPrune({ load: loadResult?.forecast, pv: pvResult?.forecast });
  } catch (err) {
    console.warn('[predict] forecast persistence failed:', err instanceof Error ? err.message : err);
  }
  return {
    load: applyForecastAdjustments(loadResult, 'load', adjustments),
    pv: applyForecastAdjustments(pvResult, 'pv', adjustments),
  };
}

export async function executeLoadForecast(config: PredictionRunConfig, logLabel: string): Promise<ForecastRunResult> {
  assertCondition(config.activeType != null, 400, 'activeType is required');
  if (config.activeType === 'historical') {
    assertHaConnection(config);
    assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');
    assertCondition(config.historicalPredictor != null, 400, 'historicalPredictor is required for historical activeType');
  }
  if (config.activeType === 'fixed') {
    assertCondition(config.fixedPredictor != null, 400, 'fixedPredictor is required for fixed activeType');
    assertCondition(
      Number.isFinite(config.fixedPredictor!.load_W) && config.fixedPredictor!.load_W >= 0,
      400,
      'fixedPredictor.load_W must be a non-negative finite number'
    );
  }

  logPredictionCall(logLabel + ' (load)', { activeType: config.activeType });

  try {
    return await runLoadForecast(config);
  } catch (err) {
    throw mapPredictionError(err, false);
  }
}

export async function executePvForecast(config: PredictionRunConfig, logLabel: string): Promise<PvForecastRunResult | null> {
  if (
    !config.pvConfig ||
    config.pvConfig.latitude == null || Number.isNaN(config.pvConfig.latitude) ||
    config.pvConfig.longitude == null || Number.isNaN(config.pvConfig.longitude)
  ) {
    return null;
  }

  return runWithHaGuards(config, logLabel + ' (pv)', { pvConfig: config.pvConfig }, () => runPvForecast(config), { isPv: true });
}

export async function persistForecastData(updates: { load?: TimeSeries; pv?: TimeSeries }) {
  if (!updates.load?.values && !updates.pv?.values) return;
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const setLoad = !!updates.load?.values && settings.dataSources.load === 'api';
  const setPv   = !!updates.pv?.values   && settings.dataSources.pv   === 'api';
  if (!setLoad && !setPv) return;
  if (setLoad) data.load = updates.load!;
  if (setPv)   data.pv   = updates.pv!;
  await saveData(data);
}

async function persistForecastAndPrune(updates: { load?: TimeSeries; pv?: TimeSeries }) {
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const setLoad = !!updates.load?.values && settings.dataSources.load === 'api';
  const setPv   = !!updates.pv?.values   && settings.dataSources.pv   === 'api';
  if (setLoad) data.load = updates.load!;
  if (setPv)   data.pv   = updates.pv!;
  const { data: pruned, adjustments, changed } = pruneExpiredPredictionAdjustments(data);
  if (setLoad || setPv || changed) await saveData(pruned);
  return adjustments;
}

export async function withAdjustedForecast<T extends { forecast?: TimeSeries } | null>(
  result: T,
  series: PredictionAdjustmentSeries,
): Promise<(T & { rawForecast?: TimeSeries }) | T> {
  const { adjustments } = await loadActiveAdjustmentsAndPrune();
  return applyForecastAdjustments(result, series, adjustments);
}

function logPredictionCall(type: string, meta: Record<string, unknown>): void {
  console.log(`[predict] ${type}`, {
    timestamp: new Date().toISOString(),
    ...meta,
  });
}

function assertHaConnection(config: PredictionRunConfig): void {
  assertCondition(
    !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
    400,
    'haUrl and haToken are required when not running as an add-on'
  );
}

function handleCombinedForecastError(type: string, logLabel: string = 'combined') {
  return (err: Error) => {
    console.warn(`[predict] ${type} forecast failed in ${logLabel}:`, err.message);
    return null;
  };
}

function applyForecastAdjustments<T extends { forecast?: TimeSeries } | null>(
  result: T,
  series: PredictionAdjustmentSeries,
  adjustments: ReturnType<typeof pruneExpiredPredictionAdjustments>['adjustments'],
): (T & { rawForecast?: TimeSeries }) | T {
  if (!result?.forecast) return result;
  const rawForecast = result.forecast;
  return {
    ...result,
    rawForecast,
    forecast: applyPredictionAdjustmentsToSeries(rawForecast, adjustments, series),
  };
}

function mapPredictionError(err: unknown, isPv: boolean): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isPv && msg.includes('Open-Meteo')) {
    return toHttpError(err, 502, `Open-Meteo error: ${msg}`);
  }
  if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out') || msg.includes('connection refused')) {
    return toHttpError(err, 502, `HA connection error: ${msg}`);
  }
  return err instanceof Error ? err : new Error(msg);
}
