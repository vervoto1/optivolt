import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/open-meteo-client.ts');

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { fetchTemperatureSeries } from '../../../api/services/open-meteo-client.ts';
import {
  runForecast,
  runValidation,
  scoreStrategies,
  scoreTemperatureStrategyPredictions,
  clearValidationHistory,
} from '../../../api/services/load-prediction-service.ts';
import { dayKey, temperaturePastDays } from '../../../lib/load-predictor-temperature.ts';

// A synthetic house whose load is driven by outside temperature: a base
// profile plus heating that grows as the (deliberately erratic) daily
// temperature drops. The historical predictor cannot know tomorrow's
// temperature; the temperature predictor can.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const NOW_STRING = '2026-03-21T10:00:00.000Z';
const NOW_MS = new Date(NOW_STRING).getTime();

/** Deterministic, erratic daily mean temperature (°C) for a local day key. */
function dayTemp(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return (h % 17) - 2; // -2 … 14 °C
}

/** kWh in one hour: 0.2 base, plus heating during the local day. */
function loadKwh(timeMs) {
  const local = new Date(timeMs);
  const hour = local.getHours();
  const heating = hour >= 6 && hour < 22 ? Math.max(0, 15 - dayTemp(dayKey(timeMs))) * 0.08 : 0;
  return 0.2 + heating;
}

function haHistory({ startTime }) {
  const start = Math.ceil(new Date(startTime).getTime() / HOUR_MS) * HOUR_MS;
  const readings = [];
  for (let t = start; t < NOW_MS - HOUR_MS; t += HOUR_MS) readings.push({ start: t, change: loadKwh(t) });
  return Promise.resolve({ 'sensor.load': readings });
}

/** Hourly temperatures from `pastDays` UTC days before today through `forecastDays` UTC days. */
function openMeteo(_lat, _lon, pastDays, forecastDays) {
  const todayUtc = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
  const records = [];
  for (let t = todayUtc - Math.min(pastDays, 92) * DAY_MS; t < todayUtc + Math.min(forecastDays, 16) * DAY_MS; t += HOUR_MS) {
    records.push({ time: t, temp_C: dayTemp(dayKey(t)) });
  }
  return Promise.resolve(records);
}

/**
 * Open-Meteo as it really behaves: `past_days` is accepted up to 92, but
 * hours older than `retainedDays` come back null, which the parser drops.
 */
function openMeteoRetaining(retainedDays) {
  return async (lat, lon, pastDays, forecastDays) => {
    const oldest = Math.floor(NOW_MS / DAY_MS) * DAY_MS - retainedDays * DAY_MS;
    return (await openMeteo(lat, lon, pastDays, forecastDays)).filter(r => r.time >= oldest);
  };
}

const window7 = { start: '2026-03-14T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' };

const located = {
  haUrl: 'ws://ha:8123/api/websocket',
  haToken: 'token',
  sensors: [{ id: 'sensor.load', name: 'Load', unit: 'kWh' }],
  derived: [],
  activeType: 'historical',
  historicalPredictor: { sensor: 'Load', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'median' },
  temperaturePredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'all', bins: 3 },
  validationWindow: window7,
  pvConfig: { latitude: 50.85, longitude: 4.35, historyDays: 14, pvSensor: 'PV' },
};
const unlocated = { ...located, pvConfig: { ...located.pvConfig, latitude: 0, longitude: 0 } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_STRING));
  vi.resetAllMocks();
  clearValidationHistory();
  fetchHaStats.mockImplementation(haHistory);
  fetchTemperatureSeries.mockImplementation(openMeteo);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runValidation — temperature strategies', () => {
  it('adds the temperature grid next to the historical rows and leaves those untouched', async () => {
    const withTemp = await runValidation(located);
    const historicalOnly = await runValidation(unlocated);

    const histWith = withTemp.results.filter(r => r.type === 'historical');
    const tempRows = withTemp.results.filter(r => r.type === 'temperature');
    expect(histWith).toHaveLength(80);
    expect(tempRows).toHaveLength(64);
    expect(tempRows[0]).toMatchObject({ sensor: 'Load', lookbackWeeks: 2, dayFilter: 'same', bins: 2 });
    expect(tempRows.every(r => r.validationPredictions.length === 0)).toBe(true);

    // Same historical numbers with or without the temperature part.
    const key = r => `${r.lookbackWeeks}|${r.dayFilter}|${r.aggregation}`;
    const byKey = new Map(historicalOnly.results.map(r => [key(r), r]));
    for (const r of histWith) {
      expect(r.mae).toBe(byKey.get(key(r)).mae);
      expect(r.n).toBe(byKey.get(key(r)).n);
    }
    expect(withTemp.warnings).toEqual([]);
  });

  it('scores temperature rows on the historical rows’ common hours, never more', async () => {
    const { results } = await runValidation(located);
    const histN = Math.max(...results.filter(r => r.type === 'historical').map(r => r.n));
    const temp = results.filter(r => r.type === 'temperature');
    expect(histN).toBeGreaterThan(0);
    expect(temp.every(r => r.n <= histN)).toBe(true);
    // Rows with enough anchors cover every scored hour: same n, head-to-head.
    expect(temp.some(r => r.n === histN)).toBe(true);
  });

  it('beats the historical grid on a temperature-driven load (sanity check of the backtest)', async () => {
    const { results } = await runValidation(located);
    const best = type => Math.min(...results.filter(r => r.type === type && Number.isFinite(r.mae)).map(r => r.mae));
    expect(best('temperature')).toBeLessThan(best('historical'));
  });

  it('fetches temperatures once, covering the longest grid lookback before the window', async () => {
    await runValidation(located);
    expect(fetchTemperatureSeries).toHaveBeenCalledOnce();
    const [lat, lon, pastDays, forecastDays] = fetchTemperatureSeries.mock.calls[0];
    expect([lat, lon]).toEqual([50.85, 4.35]);
    // Window start is 7.4 days back → 8 extra days on top of the 8-week lookback.
    expect(pastDays).toBe(temperaturePastDays(8, 8));
    expect(pastDays).toBeLessThanOrEqual(92);
    expect(forecastDays).toBe(2);
  });

  it('skips the temperature rows with a warning when the site has no coordinates', async () => {
    const result = await runValidation(unlocated);
    expect(fetchTemperatureSeries).not.toHaveBeenCalled();
    expect(result.results.every(r => r.type === 'historical')).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('latitude/longitude')]);
  });

  it('warns when Open-Meteo returned no temperatures for the oldest lookback days', async () => {
    fetchTemperatureSeries.mockImplementation(openMeteoRetaining(50));
    const result = await runValidation(located);
    expect(result.results.filter(r => r.type === 'temperature')).toHaveLength(64);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^Temperature strategies: \d+ of \d+ days behind the temperature rows .* have no Open-Meteo temperature/),
    ]);
  });

  it('keeps the historical rows when Open-Meteo fails', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo temperature request returned status 503'));
    const result = await runValidation(located);
    expect(result.results).toHaveLength(80);
    expect(result.warnings).toEqual(['Temperature strategies skipped: Open-Meteo temperature request returned status 503']);
  });

  it('never runs for the auto-selector’s scoring (historical only)', async () => {
    await scoreStrategies(located, [{ sensor: 'Load', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'median' }], window7);
    expect(fetchTemperatureSeries).not.toHaveBeenCalled();
  });
});

describe('scoreTemperatureStrategyPredictions', () => {
  const strategy = { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'all', bins: 3 };

  it('serves the chart from the last comparison run’s history and temperatures', async () => {
    await runValidation(located);
    const { validationPredictions } = await scoreTemperatureStrategyPredictions(located, strategy);
    expect(fetchHaStats).toHaveBeenCalledOnce();
    expect(fetchTemperatureSeries).toHaveBeenCalledOnce();
    expect(validationPredictions.length).toBeGreaterThan(100);
    expect(validationPredictions.every(p => p.time >= Date.parse(window7.start) && p.time < Date.parse(window7.end))).toBe(true);
  });

  it('refetches when there is no run, the coordinates changed, or the lookback is past the grid', async () => {
    await scoreTemperatureStrategyPredictions(located, strategy);
    expect(fetchHaStats).toHaveBeenCalledTimes(1);
    expect(fetchTemperatureSeries).toHaveBeenCalledTimes(1);

    await runValidation(located);
    const moved = { ...located, pvConfig: { ...located.pvConfig, latitude: 51 } };
    await scoreTemperatureStrategyPredictions(moved, strategy);
    expect(fetchTemperatureSeries).toHaveBeenCalledTimes(3);

    await scoreTemperatureStrategyPredictions(located, { ...strategy, lookbackWeeks: 11 });
    expect(fetchTemperatureSeries).toHaveBeenCalledTimes(4);
    expect(fetchTemperatureSeries.mock.calls[3][2]).toBe(temperaturePastDays(11, 8));
  });

  it('throws without coordinates', async () => {
    await expect(scoreTemperatureStrategyPredictions(unlocated, strategy)).rejects.toThrow('latitude/longitude');
  });
});

describe('runForecast — temperature predictor (opt-in)', () => {
  const temperatureActive = { ...located, activeType: 'temperature' };
  /** After 13:00 local the horizon runs through tomorrow (getForecastTimeRange). */
  const afternoon = () => vi.setSystemTime(new Date('2026-03-21T14:00:00.000Z'));

  it('does not touch Open-Meteo while the historical predictor is active', async () => {
    await runForecast(located);
    expect(fetchTemperatureSeries).not.toHaveBeenCalled();
  });

  it('forecasts from temperature anchors with an out-of-sample recent backtest', async () => {
    const result = await runForecast(temperatureActive);

    expect(result.warnings).toBeUndefined();
    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    expect(result.forecast.values.every(v => v > 0)).toBe(true);
    expect(result.recent.length).toBeGreaterThan(100);
    expect(result.metrics.n).toBeGreaterThan(100);

    const call = fetchHaStats.mock.calls[0][0];
    expect(call.entityIds).toEqual(['sensor.load']);
    expect(Math.abs(Date.parse(call.startTime) - (NOW_MS - 5 * WEEK_MS))).toBeLessThan(60_000);
    const [, , pastDays, forecastDays] = fetchTemperatureSeries.mock.calls[0];
    expect(pastDays).toBe(temperaturePastDays(4, 7));
    expect(forecastDays).toBeGreaterThanOrEqual(2);
  });

  it('predicts tomorrow’s heating from tomorrow’s temperature', async () => {
    afternoon();
    const { forecast } = await runForecast({ ...temperatureActive, includeRecent: false });
    const start = Date.parse(forecast.start);
    const slotAt = ms => forecast.values[Math.round((ms - start) / (15 * 60 * 1000))];
    // A cold and a mild local day in the horizon: noon load follows the temperature.
    const tomorrowNoon = new Date(2026, 2, 22, 12).getTime();
    const expected_W = loadKwh(tomorrowNoon) * 1000;
    expect(slotAt(tomorrowNoon)).toBeGreaterThan(expected_W * 0.7);
    expect(slotAt(tomorrowNoon)).toBeLessThan(expected_W * 1.3);
  });

  it('falls back to the historical forecast with a warning when Open-Meteo fails', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo temperature request timed out after 15000ms'));
    const result = await runForecast(temperatureActive);
    const historical = await runForecast(located);

    expect(result.forecast).toEqual(historical.forecast);
    expect(result.warnings).toEqual([expect.stringContaining('Open-Meteo temperature request timed out')]);
    expect(result.warnings[0]).toContain('historical predictor was used instead');
  });

  it('falls back without calling Open-Meteo when the site has no coordinates', async () => {
    const result = await runForecast({ ...temperatureActive, pvConfig: undefined });
    expect(fetchTemperatureSeries).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([expect.stringContaining('latitude/longitude')]);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    // Only the historical forecast's own query: no history fetched for a model that cannot run.
    expect(fetchHaStats).toHaveBeenCalledOnce();
    const call = fetchHaStats.mock.calls[0][0];
    expect(Math.abs(Date.parse(call.startTime) - (NOW_MS - 3 * WEEK_MS))).toBeLessThan(60_000);
  });

  it('reuses the fetched history for the fallback when it covers the historical lookback', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo temperature request returned status 503'));
    const result = await runForecast(temperatureActive);
    expect(fetchHaStats).toHaveBeenCalledOnce();
    fetchHaStats.mockClear();
    const historical = await runForecast(located);
    expect(result.forecast).toEqual(historical.forecast);
    expect(result.recent).toEqual(historical.recent);
    expect(result.metrics).toEqual(historical.metrics);
  });

  it('refetches for the fallback when the historical predictor reads further back or another sensor', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo temperature request returned status 503'));
    await runForecast({ ...temperatureActive, historicalPredictor: { ...located.historicalPredictor, lookbackWeeks: 6 } });
    expect(fetchHaStats).toHaveBeenCalledTimes(2);
    expect(Math.abs(Date.parse(fetchHaStats.mock.calls[1][0].startTime) - (NOW_MS - 7 * WEEK_MS))).toBeLessThan(60_000);
  });

  it('warns when Open-Meteo returned no temperatures for the oldest lookback days', async () => {
    // 8-week lookback + recent week reaches 63 days back; only 50 have data.
    fetchTemperatureSeries.mockImplementation(openMeteoRetaining(50));
    const result = await runForecast({ ...temperatureActive, temperaturePredictor: { ...located.temperaturePredictor, lookbackWeeks: 8 } });
    expect(result.warnings).toEqual([
      expect.stringMatching(/^1[0-9] of 63 days in the temperature lookback \(\d{4}-\d\d-\d\d…\d{4}-\d\d-\d\d\) have no Open-Meteo temperature/),
    ]);
    // Still a temperature forecast from the days that remain, not a fallback.
    expect(result.warnings[0]).not.toContain('historical predictor was used');
    expect(result.forecast.values.every(v => v > 0)).toBe(true);
  });

  it('adds no coverage warning when Open-Meteo returns the whole 8-week window (68 days of data)', async () => {
    fetchTemperatureSeries.mockImplementation(openMeteoRetaining(68));
    const result = await runForecast({ ...temperatureActive, temperaturePredictor: { ...located.temperaturePredictor, lookbackWeeks: 8 } });
    expect(result.warnings).toBeUndefined();
  });

  it('fills hours without a temperature prediction from the historical predictor, never with 0', async () => {
    afternoon();
    // Temperatures stop at the end of today (UTC): tomorrow has no effective temperature.
    fetchTemperatureSeries.mockImplementation((lat, lon, pastDays) => openMeteo(lat, lon, pastDays, 1));
    const result = await runForecast({ ...temperatureActive, includeRecent: false });
    const historical = await runForecast({ ...located, includeRecent: false });

    expect(result.warnings).toEqual([expect.stringMatching(/^\d+ of \d+ forecast hours had no temperature prediction/)]);
    expect(result.forecast.values.every(v => v > 0)).toBe(true);
    // The last slot is tomorrow: identical to the historical forecast there.
    const last = result.forecast.values.length - 1;
    expect(result.forecast.values[last]).toBe(historical.forecast.values[last]);
  });

  it('falls back entirely when no forecast hour can be predicted', async () => {
    fetchTemperatureSeries.mockResolvedValue([]);
    const result = await runForecast(temperatureActive);
    expect(result.warnings).toEqual([expect.stringContaining('no temperature anchors or forecast temperatures')]);
  });

  it('throws (keeping the stored series) when there is no historical predictor to fall back on', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo temperature request returned status 500'));
    await expect(runForecast({ ...temperatureActive, historicalPredictor: undefined }))
      .rejects.toThrow(/Open-Meteo.*no historical predictor/);
  });

  it('throws when partial hours are missing and there is no historical predictor', async () => {
    afternoon();
    fetchTemperatureSeries.mockImplementation((lat, lon, pastDays) => openMeteo(lat, lon, pastDays, 1));
    await expect(runForecast({ ...temperatureActive, historicalPredictor: undefined, includeRecent: false }))
      .rejects.toThrow('no historical predictor is configured to fill them');
  });

  it('propagates an HA failure like the historical path', async () => {
    fetchHaStats.mockRejectedValue(new Error('WebSocket connection refused'));
    await expect(runForecast(temperatureActive)).rejects.toThrow('WebSocket connection refused');
  });

  it('requires a temperaturePredictor', async () => {
    await expect(runForecast({ ...temperatureActive, temperaturePredictor: undefined }))
      .rejects.toThrow('temperaturePredictor is required');
  });
});
