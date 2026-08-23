/**
 * prediction-config-schema.ts
 *
 * Validation for `POST /predictions/config` patches. The persisted file is
 * consumed by date math and by `predict()`'s synchronous day loop, so an
 * unchecked `lookbackWeeks` is not just a bad forecast: a huge value pins the
 * single-threaded process that is also driving MQTT setpoints. Only the keys
 * present in the patch are checked (the form omits `historicalPredictor`
 * unless the user changed it), unknown keys pass through untouched, and
 * server-owned keys are stripped.
 */

import { HttpError } from '../http-errors.ts';
import type { PredictionConfig } from '../types.ts';
import type { Aggregation, DayFilter } from '../../lib/load-predictor-historical.ts';
import {
  assertObject,
  clampInt,
  expectEnum,
  expectFiniteNumber,
  expectIntegerInRange,
  expectNonEmptyString,
  isObject,
  type JsonRecord,
} from './schema-validators.ts';

/** `lookbackWeeks` bounds: at least one week of history, at most a year. */
export const LOOKBACK_WEEKS_MIN = 1;
export const LOOKBACK_WEEKS_MAX = 52;

const DAY_FILTERS: readonly DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'];
const AGGREGATIONS: readonly Aggregation[] = ['mean', 'median'];
const ACTIVE_TYPES = ['historical', 'fixed'] as const;

/** Fallbacks for a stored strategy field that is missing or not a valid value (see `clampHistoricalPredictor`). */
const DEFAULT_LOOKBACK_WEEKS = 4;
const DEFAULT_DAY_FILTER: DayFilter = 'same';
const DEFAULT_AGGREGATION: Aggregation = 'mean';

function normalizeHistoricalPredictor(value: unknown): PredictionConfig['historicalPredictor'] {
  assertObject(value, 'historicalPredictor');
  return {
    sensor: expectNonEmptyString(value.sensor, 'historicalPredictor.sensor'),
    lookbackWeeks: expectIntegerInRange(value.lookbackWeeks, LOOKBACK_WEEKS_MIN, LOOKBACK_WEEKS_MAX, 'historicalPredictor.lookbackWeeks'),
    dayFilter: expectEnum(value.dayFilter, DAY_FILTERS, 'historicalPredictor.dayFilter'),
    aggregation: expectEnum(value.aggregation, AGGREGATIONS, 'historicalPredictor.aggregation'),
  };
}

/**
 * Coerce an already-persisted `historicalPredictor` into range without
 * throwing — the load-time counterpart of `normalizeHistoricalPredictor`.
 *
 * `POST /predictions/config` has only validated the strategy since 0.7.56; a
 * file written by an older UI (whose input had no `max`) can hold a
 * `lookbackWeeks` that `predict()`'s synchronous day loop would still walk on
 * every auto-calculate tick, and that every later form save would be
 * rejected for with a 400 the user never sees. Only the three strategy
 * fields are touched (a missing or non-numeric/non-enum value becomes the
 * form's default); an absent or non-object value is returned as-is.
 */
export function clampHistoricalPredictor<T>(value: T): T {
  if (!isObject(value)) return value;
  const lookbackWeeks = clampInt(value.lookbackWeeks, LOOKBACK_WEEKS_MIN, LOOKBACK_WEEKS_MAX, DEFAULT_LOOKBACK_WEEKS);
  const dayFilter = DAY_FILTERS.includes(value.dayFilter as DayFilter) ? value.dayFilter : DEFAULT_DAY_FILTER;
  const aggregation = AGGREGATIONS.includes(value.aggregation as Aggregation) ? value.aggregation : DEFAULT_AGGREGATION;
  if (lookbackWeeks === value.lookbackWeeks && dayFilter === value.dayFilter && aggregation === value.aggregation) {
    return value;
  }
  return { ...value, lookbackWeeks, dayFilter, aggregation } as T;
}

function normalizeFixedPredictor(value: unknown): PredictionConfig['fixedPredictor'] {
  assertObject(value, 'fixedPredictor');
  const load_W = expectFiniteNumber(value.load_W, 'fixedPredictor.load_W');
  if (load_W < 0) throw new HttpError(400, 'fixedPredictor.load_W must be >= 0');
  return { load_W };
}

function normalizeSensorList(value: unknown, label: string, keyField: 'id' | 'name'): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  value.forEach((entry, i) => {
    assertObject(entry, `${label}[${i}]`);
    expectNonEmptyString(entry[keyField], `${label}[${i}].${keyField}`);
  });
  return value;
}

function normalizePvConfig(value: unknown): JsonRecord {
  assertObject(value, 'pvConfig');
  if ('latitude' in value) expectFiniteNumber(value.latitude, 'pvConfig.latitude');
  if ('longitude' in value) expectFiniteNumber(value.longitude, 'pvConfig.longitude');
  if ('historyDays' in value) expectIntegerInRange(value.historyDays, 1, 365, 'pvConfig.historyDays');
  return value;
}

/**
 * Validate a `POST /predictions/config` body. Throws `HttpError(400)` on the
 * first problem; returns the patch with server-owned keys removed.
 */
export function normalizePredictionConfigPatch(incoming: unknown): Partial<PredictionConfig> {
  assertObject(incoming, 'prediction config payload');
  // haUrl/haToken live in settings; validationWindow is recomputed on every load.
  const { haUrl: _haUrl, haToken: _haToken, validationWindow: _vw, ...patch } = incoming;

  if ('activeType' in patch) patch.activeType = expectEnum(patch.activeType, ACTIVE_TYPES, 'activeType');
  if ('historicalPredictor' in patch) patch.historicalPredictor = normalizeHistoricalPredictor(patch.historicalPredictor);
  if ('fixedPredictor' in patch) patch.fixedPredictor = normalizeFixedPredictor(patch.fixedPredictor);
  if ('sensors' in patch) patch.sensors = normalizeSensorList(patch.sensors, 'sensors', 'id');
  if ('derived' in patch) patch.derived = normalizeSensorList(patch.derived, 'derived', 'name');
  if ('pvConfig' in patch) patch.pvConfig = normalizePvConfig(patch.pvConfig);

  return patch as Partial<PredictionConfig>;
}
