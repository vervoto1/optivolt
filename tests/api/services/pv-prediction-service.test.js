import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/open-meteo-client.ts');

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { fetchArchiveIrradiance, fetchForecastIrradiance } from '../../../api/services/open-meteo-client.ts';
import { runPvForecast } from '../../../api/services/pv-prediction-service.ts';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const NOW_STRING = '2026-03-21T10:00:00.000Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// Minimal valid PredictionRunConfig with pvConfig set
const baseConfig = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  sensors: [{ id: 'sensor.pv', name: 'PV', unit: 'kWh' }],
  derived: [],
  pvConfig: {
    latitude: 51.05,
    longitude: 3.71,
    historyDays: 30,
    pvSensor: 'PV',
    pvMode: 'hourly',
  },
};

// Build minimal HA PV history: a few daytime hourly readings
function buildHaPvHistory() {
  const readings = [];
  // Simulate 3 weeks of noon readings with decent production
  for (let i = 0; i < 21; i++) {
    const t = NOW_MS - i * 24 * 60 * 60 * 1000;
    readings.push({ start: t, change: 800 });
  }
  return { 'sensor.pv': readings };
}

// Build minimal irradiance records for noon hour over several days
function buildArchiveIrradiance() {
  const records = [];
  for (let i = 1; i <= 7; i++) {
    const t = NOW_MS - i * 24 * 60 * 60 * 1000;
    records.push({ time: t, hour: 11, ghi_W_per_m2: 600, intervalMinutes: 60 });
  }
  return records;
}

// Build minimal forecast irradiance for the next 2 days
function buildForecastIrradiance() {
  const records = [];
  for (let i = 0; i < 48; i++) {
    const t = NOW_MS + i * 60 * 60 * 1000;
    const hour = new Date(t).getUTCHours();
    records.push({ time: t, hour, ghi_W_per_m2: hour >= 6 && hour <= 18 ? 500 : 0, intervalMinutes: 60 });
  }
  return records;
}

// ---------------------------------------------------------------------------
// runPvForecast
// ---------------------------------------------------------------------------

describe('runPvForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    fetchHaStats.mockResolvedValue(buildHaPvHistory());
    fetchArchiveIrradiance.mockResolvedValue(buildArchiveIrradiance());
    fetchForecastIrradiance.mockResolvedValue(buildForecastIrradiance());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when pvConfig is missing', async () => {
    const config = { ...baseConfig, pvConfig: undefined };
    await expect(runPvForecast(config)).rejects.toThrow('pvConfig is required');
  });

  it('throws when latitude is missing', async () => {
    const config = { ...baseConfig, pvConfig: { ...baseConfig.pvConfig, latitude: null } };
    await expect(runPvForecast(config)).rejects.toThrow('Latitude and longitude must be configured');
  });

  it('throws when longitude is missing', async () => {
    const config = { ...baseConfig, pvConfig: { ...baseConfig.pvConfig, longitude: null } };
    await expect(runPvForecast(config)).rejects.toThrow('Latitude and longitude must be configured');
  });

  it('fetches HA stats with sensor entity ids', async () => {
    await runPvForecast(baseConfig);

    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    expect(call.entityIds).toContain('sensor.pv');
    expect(call.haUrl).toBe(baseConfig.haUrl);
  });

  it('fetches archive and forecast irradiance in parallel (both called once)', async () => {
    await runPvForecast(baseConfig);

    expect(fetchArchiveIrradiance).toHaveBeenCalledOnce();
    expect(fetchForecastIrradiance).toHaveBeenCalledOnce();
  });

  it('passes latitude and longitude to fetchArchiveIrradiance', async () => {
    await runPvForecast(baseConfig);

    const [lat, lon] = fetchArchiveIrradiance.mock.calls[0];
    expect(lat).toBe(51.05);
    expect(lon).toBe(3.71);
  });

  it('passes latitude and longitude to fetchForecastIrradiance', async () => {
    await runPvForecast(baseConfig);

    const [lat, lon] = fetchForecastIrradiance.mock.calls[0];
    expect(lat).toBe(51.05);
    expect(lon).toBe(3.71);
  });

  it('returns a forecast series with 15-min step', async () => {
    const result = await runPvForecast(baseConfig);

    expect(result.forecast).toBeDefined();
    expect(result.forecast.step).toBe(15);
    expect(Array.isArray(result.forecast.values)).toBe(true);
    expect(result.forecast.values.length).toBeGreaterThan(0);
  });

  it('returns a forecast series with a valid ISO start timestamp', async () => {
    const result = await runPvForecast(baseConfig);

    expect(() => new Date(result.forecast.start)).not.toThrow();
    expect(new Date(result.forecast.start).getTime()).toBeGreaterThan(0);
  });

  it('returns points array', async () => {
    const result = await runPvForecast(baseConfig);

    expect(Array.isArray(result.points)).toBe(true);
  });

  it('returns recent array', async () => {
    const result = await runPvForecast(baseConfig);

    expect(Array.isArray(result.recent)).toBe(true);
  });

  it('returns metrics object with mae, rmse and n', async () => {
    const result = await runPvForecast(baseConfig);

    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics.mae).toBe('number');
    expect(typeof result.metrics.rmse).toBe('number');
    expect(typeof result.metrics.n).toBe('number');
  });

  it('forecast values are all non-negative', async () => {
    const result = await runPvForecast(baseConfig);

    expect(result.forecast.values.every(v => v >= 0)).toBe(true);
  });

  it('uses 15-min resolution when pvMode is 15min', async () => {
    const config = {
      ...baseConfig,
      pvConfig: { ...baseConfig.pvConfig, pvMode: '15min' },
    };
    // For 15min mode fetchForecastIrradiance is called with resolution=15
    await runPvForecast(config);

    const call = fetchForecastIrradiance.mock.calls[0];
    // args: (lat, lon, model, resolution)
    expect(call[3]).toBe(15);
  });

  it('uses hourly resolution when pvMode is hourly', async () => {
    await runPvForecast(baseConfig);

    const call = fetchForecastIrradiance.mock.calls[0];
    expect(call[3]).toBe(60);
  });

  it('caps historyDays at 10 in 15min mode', async () => {
    const config = {
      ...baseConfig,
      pvConfig: { ...baseConfig.pvConfig, pvMode: '15min', historyDays: 30 },
    };
    await runPvForecast(config);

    // HA fetch startTime should be at most 10 days ago
    const call = fetchHaStats.mock.calls[0][0];
    const startMs = new Date(call.startTime).getTime();
    const tenDaysAgo = NOW_MS - 10 * 24 * 60 * 60 * 1000;
    // Allow 60s tolerance
    expect(startMs).toBeGreaterThanOrEqual(tenDaysAgo - 60_000);
  });

  it('falls back to hourly mode when pvMode is undefined and forecastResolution is 60', async () => {
    const config = {
      ...baseConfig,
      pvConfig: { ...baseConfig.pvConfig, pvMode: undefined, forecastResolution: 60 },
    };
    const result = await runPvForecast(config);

    expect(result.forecast.step).toBe(15);
    expect(fetchForecastIrradiance.mock.calls[0][3]).toBe(60);
  });

  it('uses hybrid mode when pvMode is undefined and forecastResolution is 15', async () => {
    // Line 49: pvConfig.forecastResolution === 15 → pvMode becomes 'hybrid' (non-15min, non-hourly)
    const config = {
      ...baseConfig,
      pvConfig: { ...baseConfig.pvConfig, pvMode: undefined, forecastResolution: 15 },
    };
    const result = await runPvForecast(config);

    // hybrid mode: forecastResolution=15 → fetchForecastIrradiance called with resolution=15
    expect(result.forecast.step).toBe(15);
    expect(fetchForecastIrradiance.mock.calls[0][3]).toBe(15);
  });

  it('runs 15min slot-based forecast pipeline when pvMode is 15min', async () => {
    // Line 104: is15MinMode=true branch — uses slot capacity estimation
    const config = {
      ...baseConfig,
      pvConfig: { ...baseConfig.pvConfig, pvMode: '15min', historyDays: 7 },
    };

    // 15min mode uses period='5minute' for HA stats
    await runPvForecast(config);

    const haCall = fetchHaStats.mock.calls[0][0];
    expect(haCall.period).toBe('5minute');
  });

  it('returns empty forecast when HA returns no PV data', async () => {
    fetchHaStats.mockResolvedValue({});
    const result = await runPvForecast(baseConfig);

    // Forecast should still be a valid series, all zeros
    expect(result.forecast.values.every(v => v === 0)).toBe(true);
  });
});
