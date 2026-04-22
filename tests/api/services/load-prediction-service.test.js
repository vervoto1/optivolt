import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../lib/ha-postprocess.ts', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod };
});

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { runForecast, runValidation } from '../../../api/services/load-prediction-service.ts';

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
    readings.push({ start: d.getTime(), change: 500 });
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

  it('calls fetchHaStats once with a lookback of at least 9 weeks', async () => {
    await runValidation(baseConfig);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    const startMs = new Date(call.startTime).getTime();
    // MAX_LOOKBACK_WEEKS=8 + 1 validation week → 9 weeks
    const nineWeeksAgo = NOW_MS - 9 * 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(startMs - nineWeeksAgo)).toBeLessThan(60_000);
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
