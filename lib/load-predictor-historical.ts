/**
 * load-predictor-historical.ts
 *
 * Pure prediction/validation/forecast logic for load prediction.
 */

import type { StatRecord } from './ha-postprocess.ts';
import { type ForecastSeries, computeErrorMetrics, type PredictionResult, type ValidationMetrics } from './time-series-utils.ts';

export type DayFilter = 'same' | 'all' | 'weekday-weekend' | 'weekday-sat-sun';
export type Aggregation = 'mean' | 'median';

export interface PredictConfig {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
}

export interface LoadValidationMetrics extends ValidationMetrics {
  nSkipped: number;
}



/**
 * Map a day-of-week (0=Sun … 6=Sat) to a bucket string based on the filter strategy.
 */
export function getDayBucket(dayOfWeek: number, dayFilter: DayFilter): string | number {
  switch (dayFilter) {
    case 'same':
      return dayOfWeek;
    case 'weekday-weekend':
      return (dayOfWeek >= 1 && dayOfWeek <= 5) ? 'weekday' : 'weekend';
    case 'weekday-sat-sun':
      if (dayOfWeek >= 1 && dayOfWeek <= 5) return 'weekday';
      return dayOfWeek === 6 ? 'saturday' : 'sunday';
    case 'all':
    default:
      return 'all';
  }
}

/** @param values */
export function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** @param values */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type PredictTarget = Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null };

/**
 * Per-sensor lookup tables shared by every strategy scored against the same
 * targets — see `buildPredictIndex`.
 */
export interface PredictIndex {
  sensor: string;
  valueByDate: Map<string, StatRecord>;
  /** For each target date, the ISO keys of the days 1..N before it (N = the longest lookback the index was built for). */
  pastDatesByTarget: Map<string, string[]>;
}

/**
 * ISO key of the record `days` days before `date` at the same wall-clock
 * hour. setDate() subtracts in local time, which preserves the hour across DST
 * boundaries — the behaviour the DST tests pin.
 */
function isoDaysBefore(date: Date, days: number): string {
  const past = new Date(date);
  past.setDate(past.getDate() - days);
  return past.toISOString();
}

/**
 * Precompute what `predict()` would otherwise rebuild on every call: the
 * sensor's history index and, per target, the chain of past-day keys up to
 * `maxLookbackWeeks`. The chain is identical for every strategy of a sensor
 * and each shorter lookback walks a prefix of it, so scoring an 80-strategy
 * grid with the index does the date arithmetic once instead of 80 times.
 * Strategies with a longer lookback than the index was built for still work —
 * `predict()` falls back to computing the missing days itself.
 */
export function buildPredictIndex(
  data: StatRecord[],
  sensor: string,
  targets: PredictTarget[],
  maxLookbackWeeks: number,
): PredictIndex {
  const valueByDate = new Map(data.filter(d => d.sensor === sensor).map(d => [d.date, d]));
  const maxDays = maxLookbackWeeks * 7;
  const pastDatesByTarget = new Map<string, string[]>();
  for (const target of targets) {
    if (pastDatesByTarget.has(target.date)) continue;
    const targetDate = new Date(target.date);
    const chain: string[] = new Array(maxDays);
    for (let d = 1; d <= maxDays; d++) chain[d - 1] = isoDaysBefore(targetDate, d);
    pastDatesByTarget.set(target.date, chain);
  }
  return { sensor, valueByDate, pastDatesByTarget };
}

/**
 * Compute predictions for specific target points using history data.
 * Pass a `PredictIndex` (built for the same sensor and targets) when scoring
 * many strategies; the result is identical either way.
 */
export function predict(
  data: StatRecord[],
  { sensor, lookbackWeeks, dayFilter, aggregation }: PredictConfig,
  targets: PredictTarget[] | null = null,
  index: PredictIndex | null = null,
): PredictionResult[] {
  const useIndex = index !== null && index.sensor === sensor;
  const sensorHistory = useIndex && targets ? [] : data.filter(d => d.sensor === sensor);
  const valueByDate = useIndex ? index.valueByDate : new Map(sensorHistory.map(d => [d.date, d]));
  const aggregate = aggregation === 'median' ? median : mean;

  // Predict for explicit targets if provided, otherwise for all history entries
  const entriesToPredict = targets ?? sensorHistory;
  const results: PredictionResult[] = [];

  for (const entry of entriesToPredict) {
    const entryDate = new Date(entry.date);
    const entryBucket = getDayBucket(entry.dayOfWeek, dayFilter);
    const chain = useIndex ? index.pastDatesByTarget.get(entry.date) : undefined;

    const historicalValues: number[] = [];
    const maxDays = lookbackWeeks * 7;

    for (let d = 1; d <= maxDays; d++) {
      const pastISO = chain && d <= chain.length ? chain[d - 1] : isoDaysBefore(entryDate, d);
      const pastEntry = valueByDate.get(pastISO);

      if (!pastEntry) continue;

      if (dayFilter === 'same') {
        if (pastEntry.dayOfWeek !== entry.dayOfWeek) continue;
      } else {
        const pastBucket = getDayBucket(pastEntry.dayOfWeek, dayFilter);
        if (entryBucket !== pastBucket) continue;
      }

      historicalValues.push(pastEntry.value);
    }

    results.push({
      date: entry.date,
      time: entry.time,
      hour: entry.hour,
      actual: entry.value ?? null,
      predicted: historicalValues.length > 0 ? aggregate(historicalValues) : null,
    });
  }

  return results;
}

/**
 * Compute error metrics for predictions within the given validation window.
 */
export function validate(
  predictions: PredictionResult[],
  validationWindow: { start: string; end: string },
): LoadValidationMetrics {
  const windowStart = new Date(validationWindow.start).getTime();
  const windowEnd = new Date(validationWindow.end).getTime();

  const inWindow = predictions.filter(p => p.time >= windowStart && p.time < windowEnd);
  const valid = inWindow.filter(p => p.predicted !== null) as Array<PredictionResult & { actual: number; predicted: number }>;
  const n = valid.length;
  let nSkipped = inWindow.length - n;

  if (n === 0) return { mae: NaN, rmse: NaN, mape: NaN, n: 0, nSkipped };

  const baseMetrics = computeErrorMetrics(
    valid,
    p => p.actual,
    p => p.predicted
  );

  return {
    mae: baseMetrics.mae,
    rmse: baseMetrics.rmse,
    mape: baseMetrics.mape,
    n: baseMetrics.n,
    nSkipped,
  };
}

/**
 * Default lookback grid (weeks). Extends past the historical 8-week cap: HA
 * long-term statistics are kept indefinitely and the fetch is cheap, and on
 * real data 12–26-week medians regularly score as well as or better than 8w.
 */
export const DEFAULT_LOOKBACK_WEEKS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 20, 26];

/**
 * Generate all combinations of prediction configurations.
 */
export function generateAllConfigs(
  sensorNames: string[],
  lookbacks: readonly number[] = DEFAULT_LOOKBACK_WEEKS,
  dayFilters: DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'],
  aggregations: Aggregation[] = ['mean', 'median'],
): PredictConfig[] {
  const configs: PredictConfig[] = [];
  for (const sensor of sensorNames) {
    for (const lookbackWeeks of lookbacks) {
      for (const dayFilter of dayFilters) {
        for (const aggregation of aggregations) {
          configs.push({ sensor, lookbackWeeks, dayFilter, aggregation });
        }
      }
    }
  }
  return configs;
}
