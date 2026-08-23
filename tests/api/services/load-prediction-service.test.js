import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../lib/ha-postprocess.ts', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod };
});

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import {
  runForecast,
  runValidation,
  scoreStrategies,
  scoreStrategyPredictions,
  fetchHorizonWeeks,
  BACKTEST_FETCH_TIMEOUT_MS,
} from '../../../api/services/load-prediction-service.ts';
import { DEFAULT_LOOKBACK_WEEKS, generateAllConfigs } from '../../../lib/load-predictor-historical.ts';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const NOW_STRING = '2026-03-21T10:00:00.000Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// A minimal PredictionRunConfig with historicalPredictor set
const baseConfig = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  sensors: [{ id: 'sensor.load', name: 'Load', unit: 'kWh' }],
  derived: [],
  activeType: 'historical',
  historicalPredictor: {
    sensor: 'Load',
    lookbackWeeks: 4,
    dayFilter: 'weekday-weekend',
    aggregation: 'mean',
  },
  validationWindow: {
    start: '2026-03-14T00:00:00.000Z',
    end: '2026-03-21T00:00:00.000Z',
  },
};

// Build a small HA history: 4 weeks of hourly Monday readings for sensor.load
function buildHaHistory() {
  const result = {};
  const readings = [];
  // 4 Mondays prior to 2026-03-21 (a Saturday), starting at 10:00 UTC
  const mondays = [
    new Date('2026-03-16T10:00:00.000Z'), // most recent Monday
    new Date('2026-03-09T10:00:00.000Z'),
    new Date('2026-03-02T10:00:00.000Z'),
    new Date('2026-02-23T10:00:00.000Z'),
  ];
  for (const d of mondays) {
    // 0.5 kWh per hour → 500 Wh after unit scaling (a 500 kWh/h sample would be
    // dropped by postprocess as an implausible counter jump).
    readings.push({ start: d.getTime(), change: 0.5 });
  }
  result['sensor.load'] = readings;
  return result;
}

// ---------------------------------------------------------------------------
// runForecast
// ---------------------------------------------------------------------------

describe('runForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    fetchHaStats.mockResolvedValue(buildHaHistory());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls fetchHaStats with sensor entity ids from config', async () => {
    await runForecast(baseConfig);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    expect(call.entityIds).toContain('sensor.load');
    expect(call.haUrl).toBe(baseConfig.haUrl);
    expect(call.haToken).toBe(baseConfig.haToken);
  });

  it('returns a forecast series with 15-min step', async () => {
    const result = await runForecast(baseConfig);

    expect(result.forecast).toBeDefined();
    expect(result.forecast.step).toBe(15);
    expect(Array.isArray(result.forecast.values)).toBe(true);
    expect(result.forecast.values.length).toBeGreaterThan(0);
  });

  it('returns a forecast series with a valid ISO start timestamp', async () => {
    const result = await runForecast(baseConfig);

    expect(() => new Date(result.forecast.start)).not.toThrow();
    expect(new Date(result.forecast.start).getTime()).toBeGreaterThan(0);
  });

  it('returns recent predictions array', async () => {
    const result = await runForecast(baseConfig);

    expect(Array.isArray(result.recent)).toBe(true);
  });

  it('returns metrics object with mae, rmse, mape, n properties', async () => {
    const result = await runForecast(baseConfig);

    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics.mae).toBe('number');
    expect(typeof result.metrics.rmse).toBe('number');
    expect(typeof result.metrics.n).toBe('number');
  });

  it('uses lookbackWeeks from historicalPredictor to compute startTime passed to fetchHaStats', async () => {
    const config = { ...baseConfig, historicalPredictor: { ...baseConfig.historicalPredictor, lookbackWeeks: 2 } };
    await runForecast(config);

    const call = fetchHaStats.mock.calls[0][0];
    const startTime = new Date(call.startTime).getTime();
    // startTime should be roughly 3 weeks ago (lookbackWeeks + 1 extra week for recent data)
    const expectedStart = NOW_MS - 3 * 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(startTime - expectedStart)).toBeLessThan(60_000);
  });

  it('omits recent array when includeRecent is false', async () => {
    const config = { ...baseConfig, includeRecent: false };
    const result = await runForecast(config);

    expect(result.recent).toEqual([]);
  });

  it('returns empty forecast values array when fetchHaStats returns empty history', async () => {
    fetchHaStats.mockResolvedValue({});
    const result = await runForecast(baseConfig);

    expect(Array.isArray(result.forecast.values)).toBe(true);
    // All values should be 0 since there is no history to predict from
    expect(result.forecast.values.every(v => v === 0)).toBe(true);
  });

  it('returns empty recent when includeRecent is false in historical mode', async () => {
    const config = { ...baseConfig, includeRecent: false };
    const result = await runForecast(config);

    expect(result.recent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runValidation
// ---------------------------------------------------------------------------

describe('runValidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    fetchHaStats.mockResolvedValue(buildHaHistory());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls fetchHaStats once with the longest grid lookback plus the validation week, and a backtest-sized timeout', async () => {
    await runValidation(baseConfig);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    const startMs = new Date(call.startTime).getTime();
    // max(DEFAULT_LOOKBACK_WEEKS)=26 + 1 validation week → 27 weeks
    const expected = NOW_MS - 27 * 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(startMs - expected)).toBeLessThan(60_000);
    expect(Math.max(...DEFAULT_LOOKBACK_WEEKS)).toBe(26);
    // A 27-week, multi-MB recorder query on the same host as OptiVolt; the
    // client's 30 s default was sized for the live forecast's few-week fetch.
    expect(call.timeoutMs).toBe(BACKTEST_FETCH_TIMEOUT_MS);
    expect(BACKTEST_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('returns metrics only — no per-hour predictions in the comparison payload', async () => {
    // 80 strategies × every window hour per sensor was ~15 MB per run; the
    // chart fetches its single strategy on demand (scoreStrategyPredictions).
    const result = await runValidation(baseConfig);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(entry => entry.validationPredictions.length === 0)).toBe(true);
  });

  it('returns sensorNames array containing the configured sensor', async () => {
    const result = await runValidation(baseConfig);

    expect(Array.isArray(result.sensorNames)).toBe(true);
    // When HA returns data for 'Load', it should appear in sensorNames
    // (may be empty array if no postprocessed data — that is acceptable too)
    expect(result.sensorNames).toBeDefined();
  });

  it('returns results array', async () => {
    const result = await runValidation(baseConfig);

    expect(Array.isArray(result.results)).toBe(true);
  });

  it('each result entry has required fields', async () => {
    const result = await runValidation(baseConfig);

    if (result.results.length > 0) {
      const entry = result.results[0];
      expect(typeof entry.sensor).toBe('string');
      expect(typeof entry.lookbackWeeks).toBe('number');
      expect(typeof entry.dayFilter).toBe('string');
      expect(typeof entry.aggregation).toBe('string');
      expect(typeof entry.mae).toBe('number');
      expect(typeof entry.rmse).toBe('number');
      expect(Array.isArray(entry.validationPredictions)).toBe(true);
    }
  });

  it('returns empty results when fetchHaStats returns no data', async () => {
    fetchHaStats.mockResolvedValue({});
    const result = await runValidation(baseConfig);

    // With no sensor data, all configs produce metrics with n=0
    expect(Array.isArray(result.results)).toBe(true);
    if (result.results.length > 0) {
      expect(result.results.every(r => r.n === 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchHorizonWeeks / scoreStrategies
// ---------------------------------------------------------------------------

describe('fetchHorizonWeeks', () => {
  const window7 = { start: '2026-03-14T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };
  const window28 = { start: '2026-02-21T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };

  it('adds the window length (in whole weeks) to the longest lookback', () => {
    expect(fetchHorizonWeeks([1, 2, 8], window7)).toBe(9);
    expect(fetchHorizonWeeks([26, 4], window28)).toBe(30);
  });

  it('rounds partial weeks up and never adds less than one week', () => {
    const window10 = { start: '2026-03-11T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };
    expect(fetchHorizonWeeks([4], window10)).toBe(6);
    const window0 = { start: '2026-03-21T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };
    expect(fetchHorizonWeeks([4], window0)).toBe(5);
    expect(fetchHorizonWeeks([], window7)).toBe(1);
  });
});

describe('scoreStrategies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    fetchHaStats.mockResolvedValue(buildHaHistory());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const window = { start: '2026-03-14T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };
  const strategies = [
    { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
    { sensor: 'Load', lookbackWeeks: 5, dayFilter: 'all', aggregation: 'median' }, // off-grid
  ];

  it('fetches max lookback + window weeks of history once', async () => {
    await scoreStrategies(baseConfig, strategies, window);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    expect(call.entityIds).toEqual(['sensor.load']);
    const startMs = new Date(call.startTime).getTime();
    expect(Math.abs(startMs - (NOW_MS - 6 * 7 * 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
  });

  it('returns one entry per strategy, without predictions by default', async () => {
    const results = await scoreStrategies(baseConfig, strategies, window);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(results[1]).toMatchObject({ lookbackWeeks: 5 });
    // Monday 2026-03-16 10:00 is the only in-window point; predicted from the 3 earlier Mondays (500 each)
    expect(results[0].n).toBe(1);
    expect(results[0].mae).toBe(0);
    expect(results[0].validationPredictions).toEqual([]);
  });

  it('includes in-window predictions when asked', async () => {
    const results = await scoreStrategies(baseConfig, strategies, window, { includePredictions: true });
    expect(results[0].validationPredictions).toHaveLength(1);
    expect(results[0].validationPredictions[0]).toMatchObject({ actual: 500, predicted: 500 });
  });

  it('agrees with runValidation for the same strategy (shared scoring core)', async () => {
    const grid = generateAllConfigs(['Load']);
    const scored = await scoreStrategies(baseConfig, grid, baseConfig.validationWindow);
    fetchHaStats.mockResolvedValue(buildHaHistory());
    const validation = await runValidation(baseConfig);

    expect(scored).toHaveLength(grid.length);
    const byKey = new Map(validation.results.map(r => [`${r.lookbackWeeks}/${r.dayFilter}/${r.aggregation}`, r]));
    for (const entry of scored) {
      const twin = byKey.get(`${entry.lookbackWeeks}/${entry.dayFilter}/${entry.aggregation}`);
      expect(twin).toBeDefined();
      expect(twin).toEqual(entry);
    }
  });

  it('scores every strategy of a sensor on the hours all of them could predict', async () => {
    // Window: Mon 16 10:00 and Tue 17 10:00. History has Mondays only, so
    // `same/4w` can predict the Monday but not the Tuesday while `all/4w` can
    // predict both. Ranking the two on different hour sets would compare a
    // 1-hour mean against a 2-hour mean; instead both are scored on the
    // common hour and the Tuesday shows up as `same`'s own skip.
    const history = buildHaHistory();
    history['sensor.load'].push({ start: new Date('2026-03-17T10:00:00.000Z').getTime(), change: 0.9 });
    fetchHaStats.mockResolvedValue(history);
    const [same, all] = await scoreStrategies(baseConfig, [
      { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'all', aggregation: 'mean' },
    ], window);

    expect(same.n).toBe(1);
    expect(all.n).toBe(1);
    expect(same.nSkipped).toBe(1);
    expect(all.nSkipped).toBe(0);
    // `all` predicts Tue 900 Wh from the Monday 500s — an error of 400 that
    // must not enter its score, since `same` has no Tuesday to be judged on.
    expect(all.mae).toBe(0);
  });
});

describe('scoreStrategyPredictions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    fetchHaStats.mockResolvedValue(buildHaHistory());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the per-hour predictions of one strategy over the config window', async () => {
    const strategy = { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' };
    const result = await scoreStrategyPredictions(baseConfig, strategy);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const startMs = new Date(fetchHaStats.mock.calls[0][0].startTime).getTime();
    expect(Math.abs(startMs - (NOW_MS - 5 * 7 * 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
    expect(result.strategy).toEqual(strategy);
    expect(result.validationPredictions).toHaveLength(1);
    expect(result.validationPredictions[0]).toMatchObject({ actual: 500, predicted: 500 });
    expect(result).not.toHaveProperty('mae');
  });
});

// ---------------------------------------------------------------------------
// Upstream tests: fixed predictor
// ---------------------------------------------------------------------------

import { beforeAll, afterAll } from 'vitest';

describe('runForecast (fixed predictor)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T22:00:00.000Z'));
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns a flat ForecastSeries with all values equal to load_W', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);

    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    expect(result.forecast.values.every(v => v === 300)).toBe(true);
    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBe(0);
  });

  it('uses the fixed load_W value verbatim', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 50 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);
    expect(result.forecast.values.every(v => v === 50)).toBe(true);
  });

  it('returns empty recent and NaN metrics when canComputeAccuracy is false (sensors empty)', async () => {
    // Lines 113-120: canComputeAccuracy false → early return, no fetchHaStats call
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);

    // Early-exit path: recent is [], metrics are all NaN
    expect(result.recent).toEqual([]);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(Number.isNaN(result.metrics.rmse)).toBe(true);
    expect(Number.isNaN(result.metrics.mape)).toBe(true);
    expect(result.metrics.n).toBe(0);
  });

  it('returns empty recent and NaN metrics when haUrl is empty (line 117)', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: { sensor: 'Load', lookbackWeeks: 4 },
      sensors: [{ id: 'sensor.load', name: 'Load', unit: 'W' }],
      derived: [],
      haUrl: '',  // empty URL → canComputeAccuracy false
      haToken: 'some-token',
    };

    const result = await runForecast(config);

    // Early-exit path: recent is [], metrics are all NaN
    expect(result.recent).toEqual([]);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
  });
});

describe('runForecast (fixed predictor with accuracy)', () => {
  const baseTime = new Date('2026-04-01T22:00:00.000Z').getTime();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T22:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
  });

  function makeRawData(entityId, hoursAgoList, values) {
    return {
      [entityId]: hoursAgoList.map((hoursAgo, i) => ({
        start: baseTime - hoursAgo * 3600 * 1000,
        change: values[i],
      })),
    };
  }

  const sensors = [{ id: 'sensor.load', name: 'Load', unit: 'W' }];
  const haConfig = { haUrl: 'http://ha.local', haToken: 'tok', sensors, derived: [] };

  it('returns recent accuracy data when sensor and HA are configured', async () => {
    fetchHaStats.mockResolvedValue(
      makeRawData('sensor.load', [2, 4, 6], [280, 320, 300])
    );

    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.forecast.values.every(v => v === 300)).toBe(true);
    expect(result.recent.length).toBeGreaterThan(0);
    expect(result.recent.every(r => r.predicted === 300)).toBe(true);
    expect(Number.isFinite(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBeGreaterThan(0);
  });

  it('skips accuracy when includeRecent is false', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      includeRecent: false,
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(fetchHaStats).not.toHaveBeenCalled();
  });
});
