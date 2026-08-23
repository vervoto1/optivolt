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

type JsonRecord = Record<string, unknown>;

/** `lookbackWeeks` bounds: at least one week of history, at most a year. */
export const LOOKBACK_WEEKS_MIN = 1;
export const LOOKBACK_WEEKS_MAX = 52;

const DAY_FILTERS: readonly DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'];
const AGGREGATIONS: readonly Aggregation[] = ['mean', 'median'];
const ACTIVE_TYPES = ['historical', 'fixed'] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is JsonRecord {
  if (!isRecord(value)) throw new HttpError(400, `${label} must be an object`);
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${label} must be a non-empty string`);
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a finite number`);
  return value;
}

function expectIntegerInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeHistoricalPredictor(value: unknown): PredictionConfig['historicalPredictor'] {
  assertRecord(value, 'historicalPredictor');
  return {
    sensor: expectNonEmptyString(value.sensor, 'historicalPredictor.sensor'),
    lookbackWeeks: expectIntegerInRange(value.lookbackWeeks, LOOKBACK_WEEKS_MIN, LOOKBACK_WEEKS_MAX, 'historicalPredictor.lookbackWeeks'),
    dayFilter: expectEnum(value.dayFilter, DAY_FILTERS, 'historicalPredictor.dayFilter'),
    aggregation: expectEnum(value.aggregation, AGGREGATIONS, 'historicalPredictor.aggregation'),
  };
}

function normalizeFixedPredictor(value: unknown): PredictionConfig['fixedPredictor'] {
  assertRecord(value, 'fixedPredictor');
  const load_W = expectFiniteNumber(value.load_W, 'fixedPredictor.load_W');
  if (load_W < 0) throw new HttpError(400, 'fixedPredictor.load_W must be >= 0');
  return { load_W };
}

function normalizeSensorList(value: unknown, label: string, keyField: 'id' | 'name'): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  value.forEach((entry, i) => {
    assertRecord(entry, `${label}[${i}]`);
    expectNonEmptyString(entry[keyField], `${label}[${i}].${keyField}`);
  });
  return value;
}

function normalizePvConfig(value: unknown): JsonRecord {
  assertRecord(value, 'pvConfig');
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
  assertRecord(incoming, 'prediction config payload');
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
