import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeErrorMetrics,
  getForecastTimeRange,
  getQuarterStart,
  extractWindow,
} from '../../lib/time-series-utils.ts';

// ---------------------------------------------------------------------------
// computeErrorMetrics
// ---------------------------------------------------------------------------

describe('computeErrorMetrics', () => {
  const getActual = (d) => d.actual;
  const getPredicted = (d) => d.predicted;

  it('returns zero mae/rmse and NaN mape for an empty array', () => {
    const result = computeErrorMetrics([], getActual, getPredicted);
    expect(result.n).toBe(0);
    expect(result.mae).toBe(0);
    expect(result.rmse).toBe(0);
    expect(Number.isNaN(result.mape)).toBe(true);
  });

  it('skips pairs where actual is null', () => {
    const pairs = [
      { actual: null, predicted: 10 },
      { actual: 20, predicted: 20 },
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.n).toBe(1);
    expect(result.mae).toBe(0);
  });

  it('skips pairs where predicted is null', () => {
    const pairs = [
      { actual: 10, predicted: null },
      { actual: 20, predicted: 20 },
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.n).toBe(1);
    expect(result.mae).toBe(0);
  });

  it('computes MAE correctly', () => {
    // errors: 10, 0, 10 → mean = 20/3 ≈ 6.667
    const pairs = [
      { actual: 100, predicted: 110 },
      { actual: 200, predicted: 200 },
      { actual: 300, predicted: 290 },
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.n).toBe(3);
    expect(result.mae).toBeCloseTo(20 / 3, 5);
  });

  it('computes RMSE correctly', () => {
    // errors: 10, 0, 10 → sqrt((100+0+100)/3) = sqrt(200/3)
    const pairs = [
      { actual: 100, predicted: 110 },
      { actual: 200, predicted: 200 },
      { actual: 300, predicted: 290 },
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.rmse).toBeCloseTo(Math.sqrt(200 / 3), 5);
  });

  it('computes MAPE correctly for values above the 5W threshold', () => {
    // actual=100, predicted=90 → APE=10/100=0.10 → MAPE=10%
    const pairs = [{ actual: 100, predicted: 90 }];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.mape).toBeCloseTo(10, 5);
  });

  it('excludes values <= 5 from MAPE but not from MAE/RMSE', () => {
    // actual=2 (small, excluded from MAPE), actual=100 (included)
    const pairs = [
      { actual: 2, predicted: 4 },   // error=2, excluded from MAPE (actual <=5)
      { actual: 100, predicted: 90 }, // APE=10%
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.n).toBe(2);
    // MAE includes both: (2 + 10) / 2 = 6
    expect(result.mae).toBeCloseTo(6, 5);
    // MAPE uses only second pair: 10%
    expect(result.mape).toBeCloseTo(10, 5);
  });

  it('returns NaN mape when all actuals are <= 5', () => {
    const pairs = [
      { actual: 1, predicted: 2 },
      { actual: 3, predicted: 5 },
    ];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.n).toBe(2);
    expect(Number.isNaN(result.mape)).toBe(true);
  });

  it('works with custom accessor functions', () => {
    const data = [
      { a: 100, b: 80 },
      { a: 200, b: 200 },
    ];
    const result = computeErrorMetrics(data, (d) => d.a, (d) => d.b);
    // errors: 20, 0 → mae = 10
    expect(result.mae).toBeCloseTo(10, 5);
    expect(result.n).toBe(2);
  });

  it('handles a single exact match', () => {
    const pairs = [{ actual: 50, predicted: 50 }];
    const result = computeErrorMetrics(pairs, getActual, getPredicted);
    expect(result.mae).toBe(0);
    expect(result.rmse).toBe(0);
    expect(result.mape).toBe(0);
    expect(result.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getForecastTimeRange
// ---------------------------------------------------------------------------

describe('getForecastTimeRange', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns startIso aligned to the current 15-min slot', () => {
    // 10:22 → should align to 10:15
    const now = new Date('2024-06-15T10:22:00Z').getTime();
    const { startIso } = getForecastTimeRange(now);
    expect(startIso).toBe('2024-06-15T10:15:00.000Z');
  });

  it('returns endIso at next midnight when hour < 13', () => {
    // 08:00 local → before 13:00 → end = midnight tonight (start of tomorrow)
    const now = new Date('2024-06-15T08:00:00Z').getTime();
    const { endIso } = getForecastTimeRange(now);
    const end = new Date(endIso);
    // End should be midnight (00:00 hours, 0 minutes, 0 seconds)
    expect(end.getMinutes()).toBe(0);
    expect(end.getSeconds()).toBe(0);
    expect(end.getMilliseconds()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(now);
  });

  it('returns endIso at midnight tomorrow when hour >= 13', () => {
    // 14:00 local → at or after 13:00 → end = midnight the day after tomorrow
    const now = new Date('2024-06-15T14:00:00Z').getTime();
    const { endIso } = getForecastTimeRange(now);
    const end = new Date(endIso);
    const _start = new Date(now);
    // End must be at least ~24h after start
    const diffHours = (end.getTime() - now) / (1000 * 3600);
    expect(diffHours).toBeGreaterThan(20);
    expect(end.getMinutes()).toBe(0);
    expect(end.getSeconds()).toBe(0);
  });

  it('end is always after start', () => {
    const testTimes = [
      '2024-06-15T00:00:00Z',
      '2024-06-15T06:30:00Z',
      '2024-06-15T12:59:00Z',
      '2024-06-15T13:00:00Z',
      '2024-06-15T23:45:00Z',
    ];
    for (const t of testTimes) {
      const now = new Date(t).getTime();
      const { startIso, endIso } = getForecastTimeRange(now);
      expect(new Date(endIso).getTime()).toBeGreaterThan(new Date(startIso).getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// getQuarterStart — additional edge cases
// ---------------------------------------------------------------------------

describe('getQuarterStart — additional cases', () => {
  it('accepts a numeric timestamp', () => {
    const ms = new Date('2024-01-01T10:07:00Z').getTime();
    const result = getQuarterStart(ms);
    expect(new Date(result).toISOString()).toBe('2024-01-01T10:00:00.000Z');
  });

  it('accepts an ISO string', () => {
    const result = getQuarterStart('2024-01-01T10:52:00Z');
    expect(new Date(result).toISOString()).toBe('2024-01-01T10:45:00.000Z');
  });

  it('handles a custom step of 30 minutes', () => {
    const d = new Date('2024-01-01T10:22:00Z');
    const result = getQuarterStart(d, 30);
    expect(new Date(result).toISOString()).toBe('2024-01-01T10:00:00.000Z');
  });

  it('handles a custom step of 60 minutes', () => {
    const d = new Date('2024-01-01T10:45:00Z');
    const result = getQuarterStart(d, 60);
    expect(new Date(result).toISOString()).toBe('2024-01-01T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// extractWindow — additional edge cases
// ---------------------------------------------------------------------------

describe('extractWindow — additional edge cases', () => {
  const stepMs = 15 * 60 * 1000;
  const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

  it('returns empty array when targetStart equals targetEnd', () => {
    const source = { start: new Date(baseTime).toISOString(), step: 15, values: [10, 20] };
    const result = extractWindow(source, baseTime, baseTime);
    expect(result).toEqual([]);
  });

  it('returns all zeros when window is entirely before source', () => {
    const source = { start: new Date(baseTime).toISOString(), step: 15, values: [10, 20] };
    // Request window 2 hours before source
    const start = baseTime - 2 * 4 * stepMs;
    const end = baseTime - 1 * stepMs;
    const result = extractWindow(source, start, end);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('returns all zeros when window is entirely after source', () => {
    const source = { start: new Date(baseTime).toISOString(), step: 15, values: [10, 20] };
    // Request window 10 hours after source ends
    const start = baseTime + 100 * stepMs;
    const end = baseTime + 102 * stepMs;
    const result = extractWindow(source, start, end);
    expect(result).toEqual([0, 0]);
  });

  it('defaults step to 15 when source.step is undefined', () => {
    const source = { start: new Date(baseTime).toISOString(), values: [10, 20, 30] };
    // Window exactly matching source
    const result = extractWindow(source, baseTime, baseTime + 3 * stepMs);
    expect(result).toEqual([10, 20, 30]);
  });
});
