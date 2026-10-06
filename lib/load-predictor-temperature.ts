/**
 * load-predictor-temperature.ts
 *
 * Pure temperature-anchored load prediction, for loads driven by outside
 * temperature (e.g. a heat pump on a schedule). Ported from upstream
 * (bmesuere/optivolt #191 + #193, final form at e318148) with one fork change:
 * days and hours are keyed on the process's local calendar (like the
 * historical predictor, which walks local days so a routine keeps its
 * wall-clock hour across DST) instead of UTC. Upstream's UTC keys shift every
 * anchor profile by an hour for the weeks after a DST switch, which would bias
 * a comparison against the historical predictor exactly when heating-season
 * data starts to accumulate.
 *
 * Algorithm overview:
 *   1. Summarize each historical day as an effective temperature (inertia-
 *      weighted mean over the last 3 days) and its per-hour load values.
 *   2. Per day bucket (getDayBucket), sort days by effective temperature and
 *      cut them into quantile bins; each bin becomes an anchor: its median
 *      temperature plus a median load profile per hour.
 *   3. Predict a target hour by piecewise-linear interpolation between the
 *      two anchors bracketing the target day's effective temperature
 *      (extrapolating along the outermost segment for unseen temperatures,
 *      clamped, and floored at the lowest anchor value).
 *
 * Like the PV predictors, this is stateless: anchors are rebuilt from raw
 * history on every forecast run — nothing is fitted or persisted.
 */

import type { StatRecord } from './ha-postprocess.ts';
import type { PredictionResult } from './time-series-utils.ts';
import { getDayBucket, median, type DayFilter } from './load-predictor-historical.ts';

export interface TemperatureRecord {
  time: number;    // ms epoch, start of the hour
  temp_C: number;
}

export interface TemperaturePredictConfig {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  bins: number;
}

export interface TemperatureAnchor {
  temp_C: number;
  /** Median load per local clock hour (same unit as the input records, Wh/h ≈ W). */
  profile: (number | null)[];
  dayCount: number;
}

export interface TemperatureModel {
  /** Anchors per day bucket; a bucket without enough days is absent. */
  buckets: Map<string | number, TemperatureAnchor[]>;
  /** Anchors over all days, used when a bucket is absent. */
  pooled: TemperatureAnchor[];
}

export interface TemperatureDaySummary {
  dayOfWeek: number;
  effTemp_C: number;
  /** Load per local clock hour; null where the hour is missing. */
  hours: (number | null)[];
  hourCount: number;
}

type Target = Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null };

/** Thermal inertia: today weighs 4/7, yesterday 2/7, the day before 1/7. */
const INERTIA_WEIGHTS = [4 / 7, 2 / 7, 1 / 7];

/** A bin needs at least this many days to make a stable anchor. */
const MIN_DAYS_PER_BIN = 4;

/** A day needs at least this many hourly load readings to count as observed. */
const MIN_HOURS_PER_DAY = 20;

/**
 * A day needs at least this many hourly temperatures for its mean to count.
 * The first and last day of an Open-Meteo window are partial in local time;
 * a mean over only the night (or only the afternoon) hours would be biased.
 */
const MIN_TEMP_HOURS_PER_DAY = 20;

/** Lookbacks the comparison grid evaluates. Kept within Open-Meteo's 92-day `past_days`. */
export const TEMPERATURE_GRID_LOOKBACK_WEEKS: readonly number[] = [2, 4, 6, 8];
/** Bin counts the comparison grid evaluates. */
export const TEMPERATURE_GRID_BINS: readonly number[] = [2, 3, 4, 6];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar-day key ('YYYY-MM-DD', process time zone) for an epoch-ms timestamp. */
export function dayKey(timeMs: number): string {
  const d = new Date(timeMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDayKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m - 1, d];
}

/** Epoch ms of the local midnight that starts the day `key`. */
export function dayStartMs(key: string): number {
  const [y, m, d] = parseDayKey(key);
  return new Date(y, m, d).getTime();
}

/** Key of the calendar day `days` days before `key` (DST-safe: steps calendar days, not 24 h). */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = parseDayKey(key);
  // Noon never falls in a DST gap, so the day arithmetic lands on the right date.
  return dayKey(new Date(y, m, d - days, 12).getTime());
}

/**
 * Mean temperature per local day from hourly records. Days with fewer than
 * MIN_TEMP_HOURS_PER_DAY readings are left out.
 */
export function computeDayMeanTemps(temps: TemperatureRecord[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const t of temps) {
    if (!Number.isFinite(t.temp_C)) continue;
    const key = dayKey(t.time);
    const entry = sums.get(key) ?? { sum: 0, n: 0 };
    entry.sum += t.temp_C;
    entry.n += 1;
    sums.set(key, entry);
  }
  const means = new Map<string, number>();
  for (const [key, { sum, n }] of sums) {
    if (n >= MIN_TEMP_HOURS_PER_DAY) means.set(key, sum / n);
  }
  return means;
}

/**
 * Inertia-weighted effective temperature per day: 4:2:1 blend of the day and
 * the two days before it, renormalized over the days actually available.
 */
export function computeEffectiveDayTemps(dayMeans: Map<string, number>): Map<string, number> {
  const eff = new Map<string, number>();
  for (const key of dayMeans.keys()) {
    let sum = 0;
    let weight = 0;
    for (let k = 0; k < INERTIA_WEIGHTS.length; k++) {
      const mean = dayMeans.get(shiftDayKey(key, k));
      if (mean === undefined) continue;
      sum += INERTIA_WEIGHTS[k] * mean;
      weight += INERTIA_WEIGHTS[k];
    }
    // v8 ignore next — the day itself always has a mean, so weight > 0
    if (weight > 0) eff.set(key, sum / weight);
  }
  return eff;
}

/**
 * Summarize one sensor's load history into per-day profiles, keyed by local
 * day and local clock hour. One pass over the raw records; the result feeds
 * buildAnchorsFromDaySummaries() for arbitrary cutoffs without rescanning.
 * The repeated hour of a DST fall-back day is averaged, not summed.
 */
export function summarizeTemperatureDays(
  data: StatRecord[],
  sensor: string,
  effTemps: Map<string, number>,
): Map<string, TemperatureDaySummary> {
  const acc = new Map<string, { dayOfWeek: number; effTemp_C: number; sums: number[]; counts: number[] }>();
  for (const rec of data) {
    if (rec.sensor !== sensor) continue;
    const key = dayKey(rec.time);
    const effTemp = effTemps.get(key);
    if (effTemp === undefined) continue;

    let day = acc.get(key);
    if (!day) {
      day = { dayOfWeek: new Date(rec.time).getDay(), effTemp_C: effTemp, sums: Array(24).fill(0), counts: Array(24).fill(0) };
      acc.set(key, day);
    }
    const hour = new Date(rec.time).getHours();
    day.sums[hour] += rec.value;
    day.counts[hour] += 1;
  }

  const days = new Map<string, TemperatureDaySummary>();
  for (const [key, { dayOfWeek, effTemp_C, sums, counts }] of acc) {
    const hours = sums.map((sum, h) => (counts[h] > 0 ? sum / counts[h] : null));
    days.set(key, { dayOfWeek, effTemp_C, hours, hourCount: hours.filter(v => v !== null).length });
  }
  return days;
}

/**
 * Build a temperature model from precomputed day summaries: the full local
 * days strictly before the day containing `cutoffMs`, back `lookbackWeeks`
 * weeks (the same days 1..7N the historical predictor walks).
 */
export function buildAnchorsFromDaySummaries(
  summaries: Map<string, TemperatureDaySummary>,
  { lookbackWeeks, dayFilter, bins }: TemperaturePredictConfig,
  cutoffMs: number,
): TemperatureModel {
  const cutoffKey = dayKey(cutoffMs);
  const earliestKey = shiftDayKey(cutoffKey, lookbackWeeks * 7);
  const days = [...summaries.entries()]
    .filter(([key]) => key >= earliestKey && key < cutoffKey)
    .map(([, day]) => day);
  return anchorsFromDays(days, dayFilter, bins);
}

/**
 * Build temperature anchors from load history and effective day temperatures.
 * Only full days before today (local) and within the lookback window count.
 */
export function buildTemperatureAnchors(
  data: StatRecord[],
  effTemps: Map<string, number>,
  config: TemperaturePredictConfig,
  nowMs: number,
): TemperatureModel {
  return buildAnchorsFromDaySummaries(summarizeTemperatureDays(data, config.sensor, effTemps), config, nowMs);
}

function anchorsFromDays(
  days: TemperatureDaySummary[],
  dayFilter: DayFilter,
  bins: number,
): TemperatureModel {
  const usable = days.filter(d => d.hourCount >= MIN_HOURS_PER_DAY);

  const byBucket = new Map<string | number, TemperatureDaySummary[]>();
  for (const day of usable) {
    const bucket = getDayBucket(day.dayOfWeek, dayFilter);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push(day);
  }

  const buckets = new Map<string | number, TemperatureAnchor[]>();
  for (const [bucket, bucketDays] of byBucket) {
    const anchors = binIntoAnchors(bucketDays, bins);
    if (anchors.length > 0) buckets.set(bucket, anchors);
  }

  return { buckets, pooled: binIntoAnchors(usable, bins) };
}

function binIntoAnchors(days: TemperatureDaySummary[], bins: number): TemperatureAnchor[] {
  const nBins = Math.min(bins, Math.floor(days.length / MIN_DAYS_PER_BIN));
  if (nBins < 1) return [];

  const sorted = [...days].sort((a, b) => a.effTemp_C - b.effTemp_C);
  const anchors: TemperatureAnchor[] = [];
  for (let b = 0; b < nBins; b++) {
    const start = Math.floor((b * sorted.length) / nBins);
    const end = Math.floor(((b + 1) * sorted.length) / nBins);
    const binDays = sorted.slice(start, end);

    const profile: (number | null)[] = [];
    for (let h = 0; h < 24; h++) {
      const values = binDays.map(d => d.hours[h]).filter((v): v is number => v !== null);
      profile.push(values.length > 0 ? median(values) : null);
    }

    anchors.push({
      temp_C: median(binDays.map(d => d.effTemp_C)),
      profile,
      dayCount: binDays.length,
    });
  }
  return anchors;
}

/**
 * Predicted load for one local clock hour on a day with the given effective
 * temperature, interpolating between the bracketing anchors. Extrapolation
 * beyond the outermost anchors follows the outermost segment, with the
 * temperature clamped to half the anchor span beyond the extremes so a
 * freak forecast cannot run the line off to absurd values, and the result
 * floored at the lowest value anywhere in the anchors — a device's idle
 * draw is time- and temperature-independent, so extrapolation flattens
 * out there instead of running down to 0.
 */
export function predictHourFromAnchors(
  anchors: TemperatureAnchor[],
  effTemp_C: number,
  hour: number,
): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  let floor_W = Infinity;
  for (const anchor of anchors) {
    for (const value of anchor.profile) {
      if (value !== null && value < floor_W) floor_W = value;
    }
  }
  floor_W = floor_W === Infinity ? 0 : Math.max(0, floor_W);

  if (anchors.length === 1) return clampToFloor(first.profile[hour], floor_W);

  const span = last.temp_C - first.temp_C;
  const t = Math.min(Math.max(effTemp_C, first.temp_C - span / 2), last.temp_C + span / 2);

  // Find the segment to interpolate on; outside the anchor range, the
  // outermost segment extends linearly.
  let lo = first;
  let hi = anchors[1];
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].temp_C >= t || i === anchors.length - 1) {
      lo = anchors[i - 1];
      hi = anchors[i];
      break;
    }
  }

  const loVal = lo.profile[hour];
  const hiVal = hi.profile[hour];
  if (loVal === null || hiVal === null) return clampToFloor(loVal ?? hiVal, floor_W);

  const dt = hi.temp_C - lo.temp_C;
  if (Math.abs(dt) < 0.5) return clampToFloor((loVal + hiVal) / 2, floor_W);

  const frac = (t - lo.temp_C) / dt;
  return clampToFloor(loVal + frac * (hiVal - loVal), floor_W);
}

function clampToFloor(value: number | null, floor_W: number): number | null {
  return value === null ? null : Math.max(floor_W, value);
}

/**
 * Compute predictions for target hours, mirroring the historical predictor's
 * predict() shape. The target's day, weekday bucket and clock hour are taken
 * from its timestamp in local time; the returned rows keep the target's own
 * `date`/`hour` fields so they line up with the historical results.
 */
export function predictTemperatureLoad(
  model: TemperatureModel,
  dayFilter: DayFilter,
  targets: Target[],
  effTemps: Map<string, number>,
): PredictionResult[] {
  return targets.map(target => {
    const local = new Date(target.time);
    const effTemp = effTemps.get(dayKey(target.time));
    let predicted: number | null = null;
    if (effTemp !== undefined) {
      const bucket = getDayBucket(local.getDay(), dayFilter);
      const anchors = model.buckets.get(bucket) ?? model.pooled;
      predicted = predictHourFromAnchors(anchors, effTemp, local.getHours());
    }
    return {
      date: target.date,
      time: target.time,
      hour: target.hour,
      actual: target.value ?? null,
      predicted,
    };
  });
}

/**
 * Backtest variant of predictTemperatureLoad: anchors are rebuilt per target
 * day with the cutoff at that day's start, so each day is predicted from
 * exactly the history available before it — the same rolling information set
 * the historical predictor uses. A target day never feeds its own anchors.
 * Takes precomputed day summaries (summarizeTemperatureDays) so callers
 * evaluating many configs scan the raw records only once per sensor.
 *
 * Note the one advantage this backtest still has over live use: it reads the
 * observed (re-analysed) temperature of the scored day, where the live
 * forecast has to use a weather forecast.
 */
export function predictTemperatureLoadRolling(
  summaries: Map<string, TemperatureDaySummary>,
  config: TemperaturePredictConfig,
  targets: Target[],
  effTemps: Map<string, number>,
): PredictionResult[] {
  const models = new Map<string, TemperatureModel>();
  for (const target of targets) {
    const key = dayKey(target.time);
    if (!models.has(key)) models.set(key, buildAnchorsFromDaySummaries(summaries, config, dayStartMs(key)));
  }
  return targets.flatMap(target =>
    predictTemperatureLoad(models.get(dayKey(target.time))!, config.dayFilter, [target], effTemps),
  );
}

/**
 * Generate all temperature-predictor configurations to evaluate in a
 * comparison run, mirroring generateAllConfigs() for historical predictors.
 */
export function generateTemperatureConfigs(
  sensorNames: string[],
  lookbacks: readonly number[] = TEMPERATURE_GRID_LOOKBACK_WEEKS,
  dayFilters: DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'],
  binCounts: readonly number[] = TEMPERATURE_GRID_BINS,
): TemperaturePredictConfig[] {
  const configs: TemperaturePredictConfig[] = [];
  for (const sensor of sensorNames) {
    for (const lookbackWeeks of lookbacks) {
      for (const dayFilter of dayFilters) {
        for (const bins of binCounts) {
          configs.push({ sensor, lookbackWeeks, dayFilter, bins });
        }
      }
    }
  }
  return configs;
}

/**
 * Open-Meteo `past_days` needed so every day a temperature model with this
 * lookback reads — `extraDays` of scored/recent days plus the lookback before
 * them — has its own mean and the two inertia days before it. The +1 covers
 * the local day starting before the UTC day Open-Meteo counts from.
 */
export function temperaturePastDays(lookbackWeeks: number, extraDays: number): number {
  return lookbackWeeks * 7 + extraDays + 2 + 1;
}
