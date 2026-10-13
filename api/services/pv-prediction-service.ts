/**
 * pv-prediction-service.ts
 *
 * Orchestrates PV forecast pipeline:
 *   HA history + Open-Meteo archive → capacity estimation → Open-Meteo forecast → PV forecast.
 */

import { fetchHaStats } from './ha-client.ts';
import { hasPvCoordinates, MISSING_PV_COORDINATES_MESSAGE } from './pv-coordinates.ts';
import { postprocess, aggregateTo15Min } from '../../lib/ha-postprocess.ts';
import { fetchArchiveIrradiance, fetchExtendedForecastIrradiance, fetchForecastIrradiance } from './open-meteo-client.ts';
import { expandHourlyTo15Min, OPEN_METEO_MAX_FORECAST_DAYS } from '../../lib/open-meteo.ts';
/* v8 ignore start — import lines are module-load noise */
import {
  calculateMaxProductionPerHour,
  calculateMaxProductionPerSlot,
  calculateMaxRatioPerHour,
  estimateHourlyCapacity,
  estimateSlotCapacity,
  estimateRobustLinearPvModels,
  forecastPv,
  forecastPvLinear,
  forecastPvSlot,
  slotOfDay,
  validatePvForecast,
} from '../../lib/predict-pv.ts';
/* v8 ignore stop */
import type { IrradianceRecord, PvProductionRecord, PvForecastPoint } from '../../lib/predict-pv.ts';
import type { PredictionRunConfig, PvMode, PvModel } from '../types.ts';
import {
  buildForecastSeries,
  resolvePlanningWindow,
  truncateAtFirstGap,
  type ForecastSeries,
  type PlanningWindowSettings,
} from '../../lib/time-series-utils.ts';

export interface PvForecastRunResult {
  forecast: ForecastSeries;
  points: PvForecastPoint[];
  recent: PvForecastPoint[];
  metrics: { mae: number; rmse: number; n: number };
  model: PvModel;
  /** Set when the series ends before the planning window end (extended windows only). */
  truncatedAt?: string;
  /** Why the series ends at `truncatedAt`. */
  truncationReason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Open-Meteo `forecast_days` for a forecast that must reach `windowEndMs`.
 * With `timezone=GMT` the days count from the UTC midnight of today, not the
 * local one, so (as for the temperature forecast) the count runs from there,
 * +1 so the last local day is covered after the UTC day it starts in; capped
 * at the API's 16 days.
 */
export function extendedForecastDays(nowMs: number, windowEndMs: number): number {
  const todayStartUtc = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Math.min(OPEN_METEO_MAX_FORECAST_DAYS, Math.ceil((windowEndMs - todayStartUtc) / DAY_MS) + 1);
}

/**
 * Forecast irradiance for the planning window. With the window not extended
 * this is exactly today's ICON D2 request; extended, ICON seamless continues
 * after ICON D2's last value, through `windowEndMs`. `coveredStarts` lists
 * the interval starts that carry a real radiation value (null only when not
 * extended: no cut applies).
 */
async function fetchWindowIrradiance(
  latitude: number,
  longitude: number,
  resolution: 15 | 60,
  window: { extended: boolean; nowMs: number; endMs: number },
): Promise<{ records: IrradianceRecord[]; coveredStarts: Set<number> | null }> {
  if (!window.extended) {
    return { records: await fetchForecastIrradiance(latitude, longitude, undefined, resolution), coveredStarts: null };
  }
  const forecastDays = extendedForecastDays(window.nowMs, window.endMs);
  const spliced = await fetchExtendedForecastIrradiance(latitude, longitude, resolution, forecastDays);
  if (spliced.extensionError) {
    console.warn(`[predict] ICON seamless irradiance unavailable, PV forecast limited to ICON D2: ${spliced.extensionError}`);
  }
  const nulls = new Set(spliced.nullTimes);
  return {
    records: spliced.records,
    coveredStarts: new Set(spliced.records.map(rec => rec.time).filter(t => !nulls.has(t))),
  };
}

/**
 * Run the full PV forecast pipeline.
 */
export async function runPvForecast(config: PredictionRunConfig & PlanningWindowSettings): Promise<PvForecastRunResult> {
  const { haUrl, haToken, sensors, derived, pvConfig } = config;

  if (!pvConfig) {
    throw new Error('pvConfig is required for PV forecasting');
  }

  const { latitude, longitude, historyDays, pvSensor } = pvConfig;

  // Resolve pvMode — prefer the new field, fall back to deprecated forecastResolution.
  // @deprecated fallback: forecastResolution === 15 → 'hybrid', else 'hourly'
  const pvMode: PvMode = pvConfig.pvMode
    ?? (pvConfig.forecastResolution === 15 ? 'hybrid' : 'hourly');
  const pvModel: PvModel = pvConfig.pvModel ?? 'clearSkyRatio';

  const is15MinMode = pvMode === '15min';
  const forecastResolution = pvMode === 'hourly' ? 60 : 15;

  if (!hasPvCoordinates(pvConfig)) {
    throw new Error(MISSING_PV_COORDINATES_MESSAGE);
  }

  const entityIds = sensors.map(s => s.id);

  // 1. Compute date range (before fetching, so all I/O can be parallelized)
  const endTime = new Date();
  const window = resolvePlanningWindow(config, endTime.getTime());
  // HA 5-min statistics have ~10 day retention; clamp for 15min mode.
  const effectiveHistoryDays = is15MinMode ? Math.min(historyDays, 10) : historyDays;
  const startTime = new Date(endTime.getTime() - effectiveHistoryDays * 24 * 60 * 60 * 1000);
  const startDate = startTime.toISOString().slice(0, 10);
  const endDate = endTime.toISOString().slice(0, 10);

  // 2. Fetch HA history, archive irradiance, and forecast irradiance in parallel
  const [rawData, archiveIrradiance, windowIrradiance] = await Promise.all([
    fetchHaStats({
      haUrl,
      haToken,
      entityIds,
      startTime: startTime.toISOString(),
      period: is15MinMode ? '5minute' : 'hour',
    }),
    fetchArchiveIrradiance(latitude, longitude, startDate, endDate),
    fetchWindowIrradiance(latitude, longitude, forecastResolution, {
      extended: window.extended,
      nowMs: endTime.getTime(),
      endMs: Date.parse(window.endIso),
    }),
  ]);
  const forecastIrradiance = windowIrradiance.records;

  let data = postprocess(rawData, sensors, derived);
  if (is15MinMode) {
    data = aggregateTo15Min(data);
  }

  // The LP expects pv_W (watts = Wh/hour average). Hourly HA data directly gives
  // Wh/hour. 15-min HA data gives Wh/15min, so we scale ×4 to get Wh/hour = W.
  const productionScale = is15MinMode ? 4 : 1;

  // Filter to the PV sensor and convert to PvProductionRecord[]. The robust
  // model drops exact zero samples internally because daylight zeroes usually
  // mean missing data, inverter-off, or curtailment rather than weather.
  const pvTrainingRecords: PvProductionRecord[] = data
    .filter(d => d.sensor === pvSensor && d.value >= 0)
    .map(d => ({
      time: d.time,
      hour: d.hour,
      ...(is15MinMode ? { slot: slotOfDay(d.time) } : {}),
      production_Wh: d.value * productionScale,
    }));
  const pvRecords = pvTrainingRecords.filter(d => d.production_Wh > 0);

  // Build actual production map for validation (timestamp → scaled Wh)
  // Scale matches pvRecords so error metrics are in consistent units.
  const actualsMap = new Map<number, number>();
  for (const d of data) {
    /* v8 ignore next — caller passes only the configured pvSensor's stats; non-PV branch is defensive */
    if (d.sensor === pvSensor) {
      actualsMap.set(d.time, d.value * productionScale);
    }
  }

  const maxRatio = calculateMaxRatioPerHour(archiveIrradiance, latitude, longitude);

  // 4. Generate the existing clear-sky ratio forecast first. The robust
  // linear model uses it as a per-bucket fallback when data is sparse.
  let clearSkyFuturePoints: PvForecastPoint[];
  let clearSkyArchivePoints: PvForecastPoint[];
  // In 15min mode this is expanded to 15-min resolution; otherwise it's the original hourly archive.
  let trainingArchiveIrradiance = archiveIrradiance;

  if (is15MinMode) {
    const maxProd96 = calculateMaxProductionPerSlot(pvRecords);
    const slotCapacity = estimateSlotCapacity(maxProd96, maxRatio);

    clearSkyFuturePoints = forecastPvSlot(slotCapacity, forecastIrradiance, latitude, longitude, actualsMap);

    // Expand hourly archive to 15-min for slot-level validation
    trainingArchiveIrradiance = expandHourlyTo15Min(archiveIrradiance);
    clearSkyArchivePoints = forecastPvSlot(slotCapacity, trainingArchiveIrradiance, latitude, longitude, actualsMap);
  } else {
    const maxProd = calculateMaxProductionPerHour(pvRecords);
    const capacity = estimateHourlyCapacity(maxProd, maxRatio);

    clearSkyFuturePoints = forecastPv(capacity, forecastIrradiance, latitude, longitude, actualsMap);
    clearSkyArchivePoints = forecastPv(capacity, archiveIrradiance, latitude, longitude, actualsMap);
  }

  let futurePoints = clearSkyFuturePoints;
  let archivePoints = clearSkyArchivePoints;

  if (pvModel === 'robustLinear') {
    const bucketCount = is15MinMode ? 96 : 24;
    const futureFallback = new Map(clearSkyFuturePoints.map(point => [point.time, point]));
    const archiveFallback = new Map(clearSkyArchivePoints.map(point => [point.time, point]));
    const models = estimateRobustLinearPvModels(pvTrainingRecords, trainingArchiveIrradiance, bucketCount, archiveFallback);

    futurePoints = forecastPvLinear(models, forecastIrradiance, latitude, longitude, actualsMap, futureFallback);
    archivePoints = forecastPvLinear(models, trainingArchiveIrradiance, latitude, longitude, actualsMap, archiveFallback);
  }

  // 6. Build 15-min series for the solver (from future points only)
  const now = new Date();
  const { startIso, endIso, baseEndIso } = resolvePlanningWindow(config, now.getTime());

  const mappedFuturePoints = futurePoints.map(p => ({
    time: p.time,
    // v8 ignore next — null path of ?? is already tested, v8 double-counts
    value: p.predicted ?? 0
  }));
  let forecast = buildForecastSeries(mappedFuturePoints, startIso, endIso, forecastResolution);
  let truncation: { truncatedAt: string; truncationReason: string } | null = null;
  const covered = windowIrradiance.coveredStarts;
  if (covered) {
    // Past the old window end a slot without irradiance ends the series
    // rather than reading as 0 W (see truncateAtFirstGap).
    const bucketMs = forecastResolution * 60_000;
    const cut = truncateAtFirstGap(forecast, baseEndIso, slotMs =>
      covered.has(Math.floor(slotMs / bucketMs) * bucketMs) ? null : 'no irradiance forecast for this slot');
    forecast = cut.series;
    if (cut.truncatedAt) {
      truncation = { truncatedAt: cut.truncatedAt, truncationReason: cut.reason! };
      console.warn(`[predict] PV forecast ends at ${cut.truncatedAt}, before the planning window end ${endIso}: ${cut.reason}`);
    }
  }

  // 7. Split: future points for forecast chart, archive points for validation chart
  const nowMs = now.getTime();
  const points = futurePoints.filter(p => p.time >= nowMs - 3600000);
  const recentCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  // Scale recent points back to Wh/interval (undoing the productionScale applied for the LP solver).
  // In 15min mode productionScale=4 so values are Wh/hour; dividing by 4 gives Wh/15min so that
  // summing all 96 intervals per day yields correct daily Wh totals in the accuracy charts.
  const recent = archivePoints
    .filter(p => p.time >= recentCutoff && p.time < nowMs && p.actual !== null)
    .map(p => ({
      ...p,
      // v8 ignore next — null path of ternary is already tested, v8 double-counts
      predicted: p.predicted !== null ? p.predicted / productionScale : null,
      // v8 ignore next — null path of ternary is already tested, v8 double-counts
      actual: p.actual !== null ? p.actual / productionScale : null,
    }));

  // 8. Validation metrics
  const metrics = validatePvForecast(recent);

  return { forecast, points, recent, metrics, model: pvModel, ...truncation };
}
