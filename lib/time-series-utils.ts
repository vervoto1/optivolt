/**
 * Utility functions for handling time series data.
 */

import type { TimeSeries } from './types.ts';

export interface ForecastSeries {
  start: string;
  step: number;
  values: number[];
}

export interface ValidationMetrics {
  mae: number;
  rmse: number;
  mape: number;
  n: number;
}

export interface PredictionResult {
  date?: string;
  time: number;
  hour: number;
  actual: number | null;
  predicted: number | null;
}

/**
 * Rounds a date down to the nearest step (default 15 minutes).
 */
export function getQuarterStart(date: Date | number | string = new Date(), stepMinutes = 15): number {
  const d = new Date(date);
  const q = Math.floor(d.getMinutes() / stepMinutes) * stepMinutes;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}

/**
 * Rounds a date up to the next step boundary.
 * If already aligned exactly to the step, the same timestamp is returned.
 */
export function getNextQuarterStart(date: Date | number | string = new Date(), stepMinutes = 15): number {
  const d = new Date(date);
  const alignedMs = getQuarterStart(d, stepMinutes);
  if (d.getTime() === alignedMs) return alignedMs;
  return alignedMs + stepMinutes * 60_000;
}

/**
 * Index of the first value that is not a finite number, or -1. The data store
 * rejects a written series with one, so the forecast writers check predicted
 * series with this first and keep the stored series instead of failing the
 * whole write.
 */
export function firstNonFiniteIndex(values: readonly unknown[]): number {
  return values.findIndex(v => typeof v !== 'number' || !Number.isFinite(v));
}

/**
 * Timestamp (ms) just after the last slot of a series.
 */
export function getSeriesEndMs(source: TimeSeries): number {
  const step = source.step ?? 15;
  return new Date(source.start).getTime() + source.values.length * step * 60_000;
}

/**
 * Extracts a window of data from a source time series to match a target start time.
 * Missing slots are padded with 0.
 */
export function extractWindow(source: TimeSeries, targetStartMs: number, targetEndMs: number): number[] {
  const sourceStartMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;

  // Calculate offset in slots
  // If source starts BEFORE target, offset is positive (we skip some source data)
  // If source starts AFTER target, offset is negative (we need padding)
  const offsetMs = targetStartMs - sourceStartMs;
  const offsetSlots = Math.floor(offsetMs / stepMs);

  const targetDurationMs = targetEndMs - targetStartMs;
  const targetSlots = Math.floor(targetDurationMs / stepMs);

  const result: number[] = [];

  for (let i = 0; i < targetSlots; i++) {
    const sourceIndex = offsetSlots + i;

    if (sourceIndex >= 0 && sourceIndex < source.values.length) {
      result.push(source.values[sourceIndex]);
    } else {
      // Pad with 0 for missing data
      result.push(0);
    }
  }

  return result;
}

/**
 * The source value covering each target instant, matched by timestamp in the
 * source's own step (an hourly series gives each 15-minute slot its hour's
 * value). Instants outside the series, and non-numeric values, read as NaN so
 * a missing slot never passes for a real 0 (e.g. the market price).
 */
export function sampleSeriesAt(source: TimeSeries, timesMs: number[]): number[] {
  const sourceStartMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;
  return timesMs.map(timeMs => {
    const index = Math.floor((timeMs - sourceStartMs) / stepMs);
    const value: unknown = index >= 0 && index < source.values.length ? source.values[index] : undefined;
    return typeof value === 'number' ? value : NaN;
  });
}

/**
 * Calculates the standard forecast time window.
 * Forecast duration:
 * < 13:00 -> until midnight tonight
 * >= 13:00 -> until midnight tomorrow
 *
 * @param nowMs The current time in milliseconds (defaults to Date.now())
 * @returns An object containing the startIso (aligned to 15m) and endIso (midnight)
 */
export function getForecastTimeRange(nowMs = Date.now()): { startIso: string; endIso: string } {
  const now = new Date(nowMs);
  const currentHour = now.getHours();

  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  if (currentHour < 13) {
    end.setDate(end.getDate() + 1);
    end.setHours(0, 0, 0, 0);
  } else {
    end.setDate(end.getDate() + 2);
    end.setHours(0, 0, 0, 0);
  }

  const startMs = Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const startIso = new Date(startMs).toISOString();
  const endIso = end.toISOString();

  return { startIso, endIso };
}

/** The `extendedHorizon` settings fields the planning window reads. */
export interface PlanningWindowHorizon {
  mode?: string;
  extraDays?: number;
}

/** Anything carrying the optional `extendedHorizon` settings block (Settings, a prediction run config). */
export interface PlanningWindowSettings {
  extendedHorizon?: PlanningWindowHorizon | null;
}

export interface PlanningWindow {
  /** Start of the current 15-minute slot, exactly as getForecastTimeRange. */
  startIso: string;
  /** End of the planning window: the old window end with mode off, the extended end otherwise. */
  endIso: string;
  /** The old (getForecastTimeRange) window end. Past it a missing value ends a series instead of reading as 0. */
  baseEndIso: string;
  /** True when `mode` is `collect` or `on`. */
  extended: boolean;
  /** Extra days after the base day(s); 0 when not extended. */
  extraDays: number;
}

export const EXTENDED_HORIZON_DEFAULT_EXTRA_DAYS = 3;
export const EXTENDED_HORIZON_MIN_EXTRA_DAYS = 1;
export const EXTENDED_HORIZON_MAX_EXTRA_DAYS = 4;

/**
 * The `extendedHorizon` block of a settings-like object, read without
 * requiring the type to declare it.
 */
export function extendedHorizonOf(settings: object | null | undefined): PlanningWindowHorizon | undefined {
  const horizon = (settings as PlanningWindowSettings | null | undefined)?.extendedHorizon;
  return horizon ?? undefined;
}

function normalizeExtraDays(extraDays: unknown): number {
  if (typeof extraDays !== 'number' || !Number.isFinite(extraDays)) return EXTENDED_HORIZON_DEFAULT_EXTRA_DAYS;
  return Math.min(EXTENDED_HORIZON_MAX_EXTRA_DAYS, Math.max(EXTENDED_HORIZON_MIN_EXTRA_DAYS, Math.round(extraDays)));
}

/** The first local midnight at or after `ms` (server time zone). */
function localMidnightAtOrAfter(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() >= ms) return d.getTime();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The window load and PV forecasts are built for.
 *
 * - `extendedHorizon.mode` `off` (or absent/unknown): exactly
 *   `getForecastTimeRange(nowMs)`.
 * - `collect` / `on`: from the same start to the local midnight at or after
 *   max(tomorrow 24:00, `firmEndMs`), plus `extraDays` local days (1–4,
 *   default 3). Days are added in local calendar time, so a DST switch gives
 *   a 23 h or 25 h day and the end stays on local midnight.
 *
 * Tomorrow 24:00 is the latest the published (firm) prices reach, so the
 * window always covers what the extended solve can use, before and after the
 * daily publication: it reaches at least `extendedWindowEndMs`, the end the
 * extended solve itself uses.
 */
export function resolvePlanningWindow(
  settings: PlanningWindowSettings | null | undefined,
  nowMs: number = Date.now(),
  firmEndMs?: number,
): PlanningWindow {
  const { startIso, endIso: baseEndIso } = getForecastTimeRange(nowMs);
  const horizon = extendedHorizonOf(settings);
  if (!horizon || (horizon.mode !== 'collect' && horizon.mode !== 'on')) {
    return { startIso, endIso: baseEndIso, baseEndIso, extended: false, extraDays: 0 };
  }

  const extraDays = normalizeExtraDays(horizon.extraDays);
  const tomorrowEnd = new Date(nowMs);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
  tomorrowEnd.setHours(0, 0, 0, 0);
  const anchorMs = typeof firmEndMs === 'number' && Number.isFinite(firmEndMs)
    ? Math.max(tomorrowEnd.getTime(), firmEndMs)
    : tomorrowEnd.getTime();

  const end = new Date(localMidnightAtOrAfter(anchorMs));
  end.setDate(end.getDate() + extraDays);
  end.setHours(0, 0, 0, 0);

  return { startIso, endIso: end.toISOString(), baseEndIso, extended: true, extraDays };
}

/**
 * End of the extended solve's horizon (multi-day horizon, mode `on`): the
 * local midnight at or after `firmEndMs` plus `extraDays` local calendar days
 * (1–4, default 3; a DST switch gives a 23 h or 25 h day and the end stays on
 * local midnight). The forecast reach past the published prices is therefore
 * constant: it moves with the firm end (the daily publication), not with the
 * date, so it does not jump a day at midnight.
 *
 * `resolvePlanningWindow` (the load/PV predictor window) is anchored at
 * max(tomorrow 24:00, firm end) instead, so it always reaches at least this
 * end: before publication it runs a day further, and after midnight the old
 * firm end is still covered.
 */
export function extendedWindowEndMs(settings: PlanningWindowSettings | null | undefined, firmEndMs: number): number {
  const end = new Date(localMidnightAtOrAfter(firmEndMs));
  end.setDate(end.getDate() + normalizeExtraDays(extendedHorizonOf(settings)?.extraDays));
  end.setHours(0, 0, 0, 0);
  return end.getTime();
}

export interface SeriesTruncation {
  series: ForecastSeries;
  /** Start of the first slot that was dropped, when the series was cut. */
  truncatedAt?: string;
  /** Why the slot at `truncatedAt` has no value. */
  reason?: string;
}

/**
 * Cut a forecast series at its first slot, at or after `keepUntilIso`, that
 * has no real value (`gapAt` returns why, or null/undefined when the slot is
 * covered).
 * Slots before `keepUntilIso` are kept whatever `gapAt` says, so the old
 * window keeps its zero fill; past it a gap never passes for 0 W.
 */
export function truncateAtFirstGap(
  series: ForecastSeries,
  keepUntilIso: string,
  gapAt: (slotStartMs: number) => string | null | undefined,
): SeriesTruncation {
  const startMs = new Date(series.start).getTime();
  const stepMs = series.step * 60_000;
  const keepUntilMs = new Date(keepUntilIso).getTime();
  for (let i = 0; i < series.values.length; i++) {
    const slotMs = startMs + i * stepMs;
    if (slotMs < keepUntilMs) continue;
    const reason = gapAt(slotMs);
    if (reason != null) {
      return {
        series: { ...series, values: series.values.slice(0, i) },
        truncatedAt: new Date(slotMs).toISOString(),
        reason,
      };
    }
  }
  return { series };
}

/**
 * Build a 15-min forecast series for a specific time range.
 * Missing slots → 0.
 *
 * @param points Array of timestamp/value pairs.
 * @param startIso ISO string for the start of the 15-min series.
 * @param endIso ISO string for the end of the 15-min series.
 * @param inputStep Minutes per input point: 60 (hourly, default) or 15.
 *   - 60: each hourly value is repeated for all four 15-min slots in that hour.
 *   - 15: each 15-min point maps directly to its slot.
 */
export function buildForecastSeries(
  points: { time: number; value: number }[],
  startIso: string,
  endIso: string,
  inputStep: number = 60,
): ForecastSeries {
  const startTs = new Date(startIso).getTime();
  const endTs = new Date(endIso).getTime();
  const stepMs = 15 * 60 * 1000;

  const predMap = new Map<number, number>();
  if (inputStep === 15) {
    // Map by 15-min bucket
    for (const p of points) {
      if (p.value !== null && p.value !== undefined) {
        const bucket = Math.floor(p.time / 900000) * 900000;
        predMap.set(bucket, p.value);
      }
    }
  } else {
    // Map by hour start (each hourly value covers all four 15-min slots)
    for (const p of points) {
      if (p.value !== null && p.value !== undefined) {
        const h = Math.floor(p.time / 3600000) * 3600000;
        predMap.set(h, p.value);
      }
    }
  }

  const values: number[] = [];
  if (inputStep === 15) {
    for (let t = startTs; t < endTs; t += stepMs) {
      values.push(predMap.get(t) ?? 0);
    }
  } else {
    for (let t = startTs; t < endTs; t += stepMs) {
      values.push(predMap.get(Math.floor(t / 3600000) * 3600000) ?? 0);
    }
  }

  return { start: startIso, step: 15, values };
}

// ---------------------------------------------------------------------------
// Error Metrics
// ---------------------------------------------------------------------------

/**
 * Compute Mean Absolute Error (MAE) and Root Mean Square Error (RMSE).
 * If there are no valid pairs, MAE and RMSE return 0, and MAPE returns NaN.
 *
 * @param pairs Array of objects containing actual and predicted values.
 * @param getActual Function to extract the actual value from a pair.
 * @param getPredicted Function to extract the predicted value from a pair.
 */
export function computeErrorMetrics<T>(
  pairs: T[],
  getActual: (d: T) => number | null | undefined,
  getPredicted: (d: T) => number | null | undefined
): { mae: number; rmse: number; mape: number; n: number } {
  let sumAbs = 0;
  let sumSq = 0;
  let sumAPE = 0;
  let mapeCount = 0;
  let n = 0;

  for (const pair of pairs) {
    const actual = getActual(pair);
    const predicted = getPredicted(pair);
    if (actual != null && predicted != null) {
      const err = actual - predicted;
      sumAbs += Math.abs(err);
      sumSq += err * err;
      n++;

      if (Math.abs(actual) > 5) {
        sumAPE += Math.abs(err / actual);
        mapeCount++;
      }
    }
  }

  if (n === 0) return { mae: 0, rmse: 0, mape: NaN, n: 0 };
  return {
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    mape: mapeCount > 0 ? (sumAPE / mapeCount) * 100 : NaN,
    n
  };
}
