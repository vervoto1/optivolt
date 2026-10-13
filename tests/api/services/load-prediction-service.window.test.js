import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/open-meteo-client.ts');

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { fetchTemperatureSeries } from '../../../api/services/open-meteo-client.ts';
import { runForecast, MIN_HISTORICAL_SAMPLES } from '../../../api/services/load-prediction-service.ts';
import { getForecastTimeRange } from '../../../lib/time-series-utils.ts';
import { dayKey } from '../../../lib/load-predictor-temperature.ts';

// Sat 21 Mar 2026 11:00 CET (before 13:00): the old window ends tonight,
// 2026-03-21T23:00Z. Tests run in Europe/Amsterdam (vitest.config.js).
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW_STRING = '2026-03-21T10:00:00.000Z';
const NOW_MS = Date.parse(NOW_STRING);
const BASE_END_ISO = '2026-03-21T23:00:00.000Z';
const slotsUntil = iso => (Date.parse(iso) - NOW_MS) / (15 * 60_000);

function dayTemp(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return (h % 17) - 2;
}

function loadKwh(timeMs) {
  const hour = new Date(timeMs).getHours();
  return 0.2 + (hour >= 6 && hour < 22 ? Math.max(0, 15 - dayTemp(dayKey(timeMs))) * 0.08 : 0);
}

/** Hourly HA history from the requested start, ending before `untilMs` (default: the last full hour). */
function haHistory(untilMs = NOW_MS - HOUR_MS, fromMs = -Infinity) {
  return ({ startTime }) => {
    const start = Math.max(fromMs, Math.ceil(Date.parse(startTime) / HOUR_MS) * HOUR_MS);
    const readings = [];
    for (let t = start; t < untilMs; t += HOUR_MS) readings.push({ start: t, change: loadKwh(t) });
    return Promise.resolve({ 'sensor.load': readings });
  };
}

function openMeteo(_lat, _lon, pastDays, forecastDays) {
  const todayUtc = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
  const records = [];
  for (let t = todayUtc - Math.min(pastDays, 92) * DAY_MS; t < todayUtc + Math.min(forecastDays, 16) * DAY_MS; t += HOUR_MS) {
    records.push({ time: t, temp_C: dayTemp(dayKey(t)) });
  }
  return Promise.resolve(records);
}

const historical = {
  haUrl: 'ws://ha:8123/api/websocket',
  haToken: 'token',
  sensors: [{ id: 'sensor.load', name: 'Load', unit: 'kWh' }],
  derived: [],
  activeType: 'historical',
  historicalPredictor: { sensor: 'Load', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'median' },
  temperaturePredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'all', bins: 3 },
  pvConfig: { latitude: 50.85, longitude: 4.35, historyDays: 14, pvSensor: 'PV' },
  includeRecent: false,
};
const temperature = { ...historical, activeType: 'temperature' };
const fixed = { ...historical, activeType: 'fixed', fixedPredictor: { load_W: 450 } };
const horizon = (config, mode, extraDays = 1, predictor) => ({
  ...config,
  ...(predictor ? { historicalPredictor: { ...config.historicalPredictor, ...predictor } } : {}),
  extendedHorizon: { mode, extraDays },
});

let warn;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_STRING));
  vi.resetAllMocks();
  fetchHaStats.mockImplementation(haHistory());
  fetchTemperatureSeries.mockImplementation(openMeteo);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runForecast — mode off is today\'s forecast', () => {
  it.each([
    ['fixed', fixed],
    ['historical', historical],
    ['temperature', temperature],
  ])('%s: identical series and result with no block, mode off or an unknown mode', async (_label, config) => {
    const today = await runForecast(config);
    const { startIso, endIso } = getForecastTimeRange(NOW_MS);
    expect(today.forecast.start).toBe(startIso);
    expect(today.forecast.values).toHaveLength(slotsUntil(endIso));
    expect(today).not.toHaveProperty('truncatedAt');
    for (const block of [{ mode: 'off', extraDays: 4 }, { mode: 'later' }, null]) {
      const off = await runForecast({ ...config, extendedHorizon: block });
      expect(JSON.stringify(off)).toBe(JSON.stringify(today));
    }
  });
});

describe('runForecast — extended planning window', () => {
  // extraDays 1: Mon 23 Mar 00:00 CET + 1 day = Tue 24 Mar 00:00 CET.
  const EXTENDED_END_ISO = '2026-03-23T23:00:00.000Z';

  it('fixed: a flat series through the extended end', async () => {
    const result = await runForecast(horizon(fixed, 'collect'));
    expect(result.forecast.values).toHaveLength(slotsUntil(EXTENDED_END_ISO));
    expect(result.forecast.values.every(v => v === 450)).toBe(true);
    expect(result).not.toHaveProperty('truncatedAt');
  });

  it('historical: extends with the old window unchanged when every hour has enough samples', async () => {
    const off = await runForecast(historical);
    const result = await runForecast(horizon(historical, 'on'));
    expect(result.forecast.values).toHaveLength(slotsUntil(EXTENDED_END_ISO));
    expect(result.forecast.values.slice(0, off.forecast.values.length)).toEqual(off.forecast.values);
    expect(result.forecast.values.every(v => v > 0)).toBe(true);
    expect(result).not.toHaveProperty('truncatedAt');
    expect(warn).not.toHaveBeenCalled();
  });

  it(`historical: ends where fewer than ${MIN_HISTORICAL_SAMPLES} lookback days remain`, async () => {
    // HA history stops at Thu 19 Mar 00:00Z. With a 1-week "all" lookback a
    // target on Wed 25 Mar only has Wed 18 left (1 of 7 days).
    fetchHaStats.mockImplementation(haHistory(Date.parse('2026-03-19T00:00:00Z')));
    const result = await runForecast(horizon(historical, 'on', 4, { lookbackWeeks: 1 }));
    expect(result.truncatedAt).toBe('2026-03-25T00:00:00.000Z');
    expect(result.truncationReason).toBe('only 1 of 7 lookback days available for this hour (fewer than 2)');
    expect(result.forecast.values).toHaveLength(slotsUntil('2026-03-25T00:00:00.000Z'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('historical load forecast ends at 2026-03-25T00:00:00.000Z'));
  });

  it('historical: a strategy that only ever reads one day is cut at the first null, not for its one sample', async () => {
    // Same weekday, 1 week: a target on Thu 26 Mar needs Thu 19, which is missing.
    fetchHaStats.mockImplementation(haHistory(Date.parse('2026-03-19T00:00:00Z')));
    const result = await runForecast(horizon(historical, 'on', 4, { lookbackWeeks: 1, dayFilter: 'same' }));
    expect(result.truncatedAt).toBe('2026-03-26T00:00:00.000Z');
    expect(result.truncationReason).toBe('no historical load data for this hour');
  });

  it('historical: hours inside the old window are never cut, whatever their sample count', async () => {
    // Only Sat 14 Mar in the history: today has 1 sample per hour, tomorrow none.
    fetchHaStats.mockImplementation(haHistory(Date.parse('2026-03-15T00:00:00Z'), Date.parse('2026-03-14T00:00:00Z')));
    const config = horizon(historical, 'collect', 1, { lookbackWeeks: 1 });
    const off = await runForecast({ ...config, extendedHorizon: undefined });
    const result = await runForecast(config);
    expect(result.truncatedAt).toBe(BASE_END_ISO);
    expect(result.forecast.values).toEqual(off.forecast.values);
  });

  it('temperature: extends with forecast temperatures for the whole window, old window unchanged', async () => {
    const off = await runForecast(temperature);
    const offDays = fetchTemperatureSeries.mock.calls[0][3];
    fetchTemperatureSeries.mockClear();
    const result = await runForecast(horizon(temperature, 'collect'));
    expect(fetchTemperatureSeries.mock.calls[0][3]).toBeGreaterThan(offDays);
    expect(result.forecast.values).toHaveLength(slotsUntil(EXTENDED_END_ISO));
    expect(result.forecast.values.slice(0, off.forecast.values.length)).toEqual(off.forecast.values);
    expect(result).not.toHaveProperty('truncatedAt');
    expect(result.warnings).toBeUndefined();
  });

  it('temperature: hours past the temperature forecast take the historical value when it has enough samples', async () => {
    // Temperatures end with today (UTC); the historical predictor fills the rest.
    fetchTemperatureSeries.mockImplementation((lat, lon, pastDays) => openMeteo(lat, lon, pastDays, 1));
    const result = await runForecast(horizon(temperature, 'on'));
    expect(result.forecast.values).toHaveLength(slotsUntil(EXTENDED_END_ISO));
    expect(result.forecast.values.every(v => v > 0)).toBe(true);
    expect(result).not.toHaveProperty('truncatedAt');
    expect(result.warnings).toEqual([expect.stringMatching(/forecast hours had no temperature prediction/)]);
  });

  it('temperature: ends where neither a temperature nor enough history is left', async () => {
    fetchTemperatureSeries.mockImplementation((lat, lon, pastDays) => openMeteo(lat, lon, pastDays, 2));
    // History ends Thu 19 Mar; the 1-week fallback reads too few days from Wed 25 Mar on,
    // and temperatures stop at Mon 23 Mar 00:00Z.
    fetchHaStats.mockImplementation(haHistory(Date.parse('2026-03-19T00:00:00Z')));
    const config = horizon({ ...temperature, temperaturePredictor: { ...temperature.temperaturePredictor, lookbackWeeks: 2 } }, 'on', 4, { lookbackWeeks: 1 });
    const result = await runForecast(config);
    expect(result.truncatedAt).toBe('2026-03-25T00:00:00.000Z');
    expect(result.truncationReason).toMatch(/^only 1 of 7 lookback days/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temperature load forecast ends at'));
  });

  it('temperature: the historical fallback uses the extended window too', async () => {
    fetchTemperatureSeries.mockRejectedValue(new Error('Open-Meteo down'));
    const result = await runForecast(horizon(temperature, 'on'));
    expect(result.forecast.values).toHaveLength(slotsUntil(EXTENDED_END_ISO));
    expect(result.warnings).toEqual([expect.stringContaining('Open-Meteo down')]);
  });
});
