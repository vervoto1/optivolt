import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateForecastKwh,
  applyAdjustmentsToForecastSeries,
  buildForecastSelectionRange,
  forecastSeriesFromCategoryX,
  futureForecastSeries,
} from '../../app/src/predictions/forecast-series.js';

describe('forecast-series: aggregateForecastKwh', () => {
  it('aggregates 15-minute watt samples into hourly kWh buckets', () => {
    // Four 15-minute slots of 1000 W -> 0.25 kWh each -> 1.0 kWh in the hour bucket.
    const forecast = {
      start: '2099-01-01T00:00:00.000Z',
      step: 15,
      values: [1000, 1000, 1000, 1000],
    };

    const result = aggregateForecastKwh(forecast, 60);

    expect(result.timestamps).toEqual([Date.parse('2099-01-01T00:00:00.000Z')]);
    expect(result.values).toEqual([1]);
  });

  it('keeps separate 15-minute buckets when stepMinutes matches the input step', () => {
    const forecast = {
      start: '2099-01-01T00:00:00.000Z',
      step: 15,
      values: [2000, 4000],
    };

    const result = aggregateForecastKwh(forecast, 15);

    expect(result.timestamps).toEqual([
      Date.parse('2099-01-01T00:00:00.000Z'),
      Date.parse('2099-01-01T00:15:00.000Z'),
    ]);
    // 2000 W * 0.25 h = 0.5 kWh; 4000 W * 0.25 h = 1.0 kWh
    expect(result.values).toEqual([0.5, 1]);
  });

  it('defaults step and stepMinutes when omitted and tolerates missing values', () => {
    // forecast.step defaults to 15, target stepMinutes defaults to 60.
    const forecast = { start: '2099-01-01T00:00:00.000Z' };

    expect(aggregateForecastKwh(forecast)).toEqual({ timestamps: [], values: [] });
  });
});

describe('forecast-series: applyAdjustmentsToForecastSeries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the forecast unchanged when there are no values', () => {
    const forecast = { start: '2099-01-01T19:00:00.000Z', step: 15 };
    expect(applyAdjustmentsToForecastSeries(forecast, [], 'load')).toBe(forecast);
  });

  it('treats a null adjustments argument as an empty list', () => {
    const forecast = { start: '2099-01-01T19:00:00.000Z', step: 15, values: [100] };
    // null adjustments -> (adjustments || []) -> nothing relevant -> returns the same forecast.
    expect(applyAdjustmentsToForecastSeries(forecast, null, 'load')).toBe(forecast);
  });

  it('keeps the earlier set adjustment when a later iteration has a smaller updatedAt', () => {
    const forecast = { start: '2099-01-01T19:00:00.000Z', step: 15, values: [100] };

    // First set has the larger updatedAt; the second iteration (updatedAt 1) does not beat it.
    const adjusted = applyAdjustmentsToForecastSeries(forecast, [
      { series: 'load', mode: 'set', value_W: 700, updatedAt: 9, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:15:00.000Z' },
      { series: 'load', mode: 'set', value_W: 200, updatedAt: 1, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:15:00.000Z' },
    ], 'load');

    expect(adjusted.values).toEqual([700]);
  });

  it('defaults the forecast step to 15 minutes when omitted', () => {
    const forecast = { start: '2099-01-01T19:00:00.000Z', values: [100, 100] };

    const adjusted = applyAdjustmentsToForecastSeries(forecast, [
      { series: 'load', mode: 'add', value_W: 25, start: '2099-01-01T19:15:00.000Z', end: '2099-01-01T19:30:00.000Z' },
    ], 'load');

    // With the default 15-minute step, slot 1 starts at 19:15 and is adjusted.
    expect(adjusted.values).toEqual([100, 125]);
  });

  it('leaves slots without an overlapping adjustment untouched (no set, add-only with missing value_W)', () => {
    const forecast = {
      start: '2099-01-01T19:00:00.000Z',
      step: 15,
      values: [100, 100, 100],
    };

    // Only `add` adjustments (no `set` -> base falls back to raw), and one add has no value_W.
    const adjusted = applyAdjustmentsToForecastSeries(forecast, [
      { series: 'load', mode: 'add', value_W: 40, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:15:00.000Z' },
      { series: 'load', mode: 'add', start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:15:00.000Z' },
    ], 'load');

    // slot 0: raw 100 + 40 + 0 = 140; slot 1 & 2: no overlap -> raw 100
    expect(adjusted.values).toEqual([140, 100, 100]);
  });

  it('returns the forecast unchanged when no adjustments are relevant', () => {
    const forecast = { start: '2099-01-01T19:00:00.000Z', step: 15, values: [100] };
    // Wrong series + already-expired adjustment are both filtered out.
    const adjustments = [
      { series: 'pv', mode: 'add', value_W: 50, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T20:00:00.000Z' },
      { series: 'load', mode: 'add', value_W: 50, start: '2098-01-01T00:00:00.000Z', end: '2098-01-01T01:00:00.000Z' },
    ];
    expect(applyAdjustmentsToForecastSeries(forecast, adjustments, 'load')).toBe(forecast);
  });

  it('applies the most recent set adjustment then layers add deltas, clamped to zero', () => {
    const forecast = {
      start: '2099-01-01T19:00:00.000Z',
      step: 15,
      values: [100, 100, 100],
    };

    // Two overlapping `set` adjustments: the one with the larger updatedAt wins (line 41 tie-break).
    const adjusted = applyAdjustmentsToForecastSeries(forecast, [
      { series: 'load', mode: 'set', value_W: 500, updatedAt: 1, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:45:00.000Z' },
      { series: 'load', mode: 'set', value_W: 200, updatedAt: 2, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:45:00.000Z' },
      { series: 'load', mode: 'add', value_W: -300, start: '2099-01-01T19:00:00.000Z', end: '2099-01-01T19:15:00.000Z' },
      { series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T19:15:00.000Z', end: '2099-01-01T19:30:00.000Z' },
    ], 'load');

    // slot 0: set=200 + add(-300) -> max(0, -100) = 0
    // slot 1: set=200 + add(50) -> 250
    // slot 2: no adjustment overlaps (set window ends at 19:45 exclusive of 19:30 slot... 19:30 < 19:45) -> set=200
    expect(adjusted.values).toEqual([0, 250, 200]);
    // Original forecast is not mutated.
    expect(forecast.values).toEqual([100, 100, 100]);
  });
});

describe('forecast-series: buildForecastSelectionRange', () => {
  it('returns null for an empty timestamp list', () => {
    expect(buildForecastSelectionRange(0, 0, [], 60)).toBeNull();
  });

  it('orders and clamps indexes and builds ISO bounds spanning one step beyond the last bucket', () => {
    const timestamps = [
      Date.parse('2099-01-01T18:00:00.000Z'),
      Date.parse('2099-01-01T19:00:00.000Z'),
      Date.parse('2099-01-01T20:00:00.000Z'),
    ];

    expect(buildForecastSelectionRange(99, -5, timestamps, 60)).toEqual({
      startIndex: 0,
      endIndex: 2,
      start: '2099-01-01T18:00:00.000Z',
      end: '2099-01-01T21:00:00.000Z',
    });
  });
});

describe('forecast-series: forecastSeriesFromCategoryX', () => {
  it('defaults to load when bounds are missing or x is not finite', () => {
    expect(forecastSeriesFromCategoryX(120, null)).toBe('load');
    expect(forecastSeriesFromCategoryX(Number.NaN, { left: 0, right: 100 })).toBe('load');
  });

  it('picks the pv lane on the right half and the load lane on the left half', () => {
    const bounds = { left: 100, right: 200 };
    expect(forecastSeriesFromCategoryX(120, bounds)).toBe('load');
    expect(forecastSeriesFromCategoryX(150, bounds)).toBe('pv');
    expect(forecastSeriesFromCategoryX(180, bounds)).toBe('pv');
  });
});

describe('forecast-series: futureForecastSeries', () => {
  it('returns null for empty, invalid start, or invalid step inputs', () => {
    expect(futureForecastSeries(null)).toBeNull();
    expect(futureForecastSeries({ values: [] })).toBeNull();
    expect(futureForecastSeries({ start: 'not-a-date', step: 15, values: [1] })).toBeNull();
    expect(futureForecastSeries({ start: '2099-01-01T00:00:00.000Z', step: -5, values: [1] })).toBeNull();
    expect(futureForecastSeries({ start: '2099-01-01T00:00:00.000Z', step: 'x', values: [1] })).toBeNull();
  });

  it('slices off the past slots and re-bases start to the first future slot', () => {
    const series = {
      start: '2099-01-01T18:00:00.000Z',
      step: 15,
      values: [10, 20, 30, 40, 50],
    };

    expect(futureForecastSeries(series, Date.parse('2099-01-01T18:32:00.000Z'))).toEqual({
      start: '2099-01-01T18:30:00.000Z',
      step: 15,
      values: [30, 40, 50],
    });
  });

  it('defaults the step to 15 minutes when the series omits it', () => {
    const series = {
      start: '2099-01-01T18:00:00.000Z',
      values: [10, 20, 30],
    };

    expect(futureForecastSeries(series, Date.parse('2099-01-01T18:20:00.000Z'))).toEqual({
      start: '2099-01-01T18:15:00.000Z',
      step: 15,
      values: [20, 30],
    });
  });

  it('returns null when every slot is in the past', () => {
    const series = {
      start: '2099-01-01T18:00:00.000Z',
      step: 15,
      values: [10, 20],
    };

    expect(futureForecastSeries(series, Date.parse('2099-01-01T19:00:00.000Z'))).toBeNull();
  });
});
