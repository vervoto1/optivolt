/**
 * schema-validators.ts
 *
 * The type/shape checks shared by the settings and prediction-config
 * normalisers. Every check throws `HttpError(400)` with the offending label,
 * so a failed `POST` reports the first bad field; the clamps never throw, for
 * normalisers that also run on load (a stored out-of-range value must not
 * fail startup).
 */

import { HttpError } from '../http-errors.ts';

export type JsonRecord = Record<string, unknown>;

export function isObject(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function assertObject(value: unknown, label: string): asserts value is JsonRecord {
  if (!isObject(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${label} must be a boolean`);
  }
  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a string`);
  }
  return value;
}

export function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${label} must be a non-empty string`);
  }
  return value;
}

export function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${label} must be a finite number`);
  }
  return value;
}

export function expectIntegerInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function expectEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Round to an integer inside [min, max]; a non-numeric value becomes `fallback` (then clamped). */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}
