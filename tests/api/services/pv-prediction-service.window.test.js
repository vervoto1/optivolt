import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/open-meteo-client.ts');

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import {
  fetchArchiveIrradiance,
  fetchExtendedForecastIrradiance,
  fetchForecastIrradiance,
} from '../../../api/services/open-meteo-client.ts';
import { extendedForecastDays, runPvForecast } from '../../../api/services/pv-prediction-service.ts';
import { getForecastTimeRange, resolvePlanningWindow } from '../../../lib/time-series-utils.ts';

// Sat 21 Mar 2026 11:00 CET (before 13:00): the old window ends tonight,
// 2026-03-21T23:00Z. With extraDays 1 the window ends Tue 24 Mar 00:00 CET.
const NOW_STRING = '2026-03-21T10:00:00.000Z';
const NOW_MS = Date.parse(NOW_STRING);
const HOUR_MS = 3600_000;
const BASE_END_MS = Date.parse('2026-03-21T23:00:00Z');
const EXTENDED_END_MS = Date.parse('2026-03-23T23:00:00Z');
const slotsBetween = (a, b) => (b - a) / (15 * 60_000);

const baseConfig = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  sensors: [{ id: 'sensor.pv', name: 'PV', unit: 'kWh' }],
  derived: [],
  pvConfig: { latitude: 51.05, longitude: 3.71, historyDays: 30, pvSensor: 'PV', pvMode: 'hourly' },
};
const withHorizon = (mode, extraDays = 1, config = baseConfig) => ({ ...config, extendedHorizon: { mode, extraDays } });

function haHistory() {
  const readings = [];
  for (let i = 1; i <= 8; i++) {
    const dayStart = Math.floor((NOW_MS - i * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
    for (let h = 7; h <= 17; h++) readings.push({ start: dayStart + h * HOUR_MS, change: 0.5 });
  }
  return { 'sensor.pv': readings };
}

function archiveIrradiance() {
  const records = [];
  for (let i = 1; i <= 8; i++) {
    const dayStart = Math.floor((NOW_MS - i * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
    for (let h = 7; h <= 17; h++) records.push({ time: dayStart + h * HOUR_MS, hour: h, ghi_W_per_m2: 600, intervalMinutes: 60 });
  }
  return records;
}

/** Records every `stepMin` minutes from now for `hours` hours, sunlit 06–18 UTC. */
function forecastIrradiance(hours, stepMin = 60) {
  const records = [];
  for (let t = NOW_MS; t < NOW_MS + hours * HOUR_MS; t += stepMin * 60_000) {
    const hour = new Date(t).getUTCHours();
    records.push({ time: t, hour, ghi_W_per_m2: hour >= 6 && hour <= 18 ? 500 : 0, intervalMinutes: stepMin });
  }
  return records;
}

describe('runPvForecast — planning window', () => {
  let warn;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchHaStats.mockResolvedValue(haHistory());
    fetchArchiveIrradiance.mockResolvedValue(archiveIrradiance());
    fetchForecastIrradiance.mockResolvedValue(forecastIrradiance(48));
    fetchExtendedForecastIrradiance.mockResolvedValue({ records: forecastIrradiance(72), nullTimes: [] });
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('mode off makes exactly today\'s request and series', async () => {
    const today = await runPvForecast(baseConfig);
    const todayCalls = fetchForecastIrradiance.mock.calls.map(c => [...c]);
    fetchForecastIrradiance.mockClear();

    const off = await runPvForecast(withHorizon('off', 4));

    expect(fetchForecastIrradiance.mock.calls).toEqual(todayCalls);
    expect(todayCalls).toEqual([[51.05, 3.71, undefined, 60]]);
    expect(fetchExtendedForecastIrradiance).not.toHaveBeenCalled();
    expect(JSON.stringify(off)).toBe(JSON.stringify(today));
    const { startIso, endIso } = getForecastTimeRange(NOW_MS);
    expect(off.forecast.start).toBe(startIso);
    expect(off.forecast.values).toHaveLength(slotsBetween(Date.parse(startIso), Date.parse(endIso)));
    expect(off.forecast.values.some(v => v > 0)).toBe(true);
    expect(off).not.toHaveProperty('truncatedAt');
  });

  it('collect splices in the extended irradiance and keeps the old window identical', async () => {
    const off = await runPvForecast(baseConfig);
    const extended = await runPvForecast(withHorizon('collect'));

    // Open-Meteo counts forecast_days from today's UTC midnight (timezone=GMT):
    // the window ends 2 d 23 h after it, so 3 days, +1 for the last local day.
    expect(fetchExtendedForecastIrradiance).toHaveBeenCalledWith(51.05, 3.71, 60, 4);
    expect(fetchForecastIrradiance).toHaveBeenCalledOnce(); // the off run only
    expect(extended.forecast.start).toBe(off.forecast.start);
    expect(extended.forecast.values).toHaveLength(slotsBetween(NOW_MS, EXTENDED_END_MS));
    expect(extended.forecast.values.slice(0, off.forecast.values.length)).toEqual(off.forecast.values);
    expect(extended).not.toHaveProperty('truncatedAt');
    expect(warn).not.toHaveBeenCalled();
  });

  it('ends the series at the first null past the old window end, zero-filling nulls before it', async () => {
    const inWindowNull = NOW_MS + 2 * HOUR_MS; // 12:00Z, inside the old window
    const lateNull = Date.parse('2026-03-22T12:00:00Z');
    fetchExtendedForecastIrradiance.mockResolvedValue({
      records: forecastIrradiance(72).map(r => (r.time === inWindowNull || r.time === lateNull ? { ...r, ghi_W_per_m2: 0 } : r)),
      nullTimes: [inWindowNull, lateNull],
    });

    const result = await runPvForecast(withHorizon('on'));

    expect(result.forecast.values).toHaveLength(slotsBetween(NOW_MS, lateNull));
    expect(result.forecast.values.slice(8, 12)).toEqual([0, 0, 0, 0]);
    expect(result.truncatedAt).toBe('2026-03-22T12:00:00.000Z');
    expect(result.truncationReason).toBe('no irradiance forecast for this slot');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PV forecast ends at 2026-03-22T12:00:00.000Z'));
  });

  it('ends the series where the irradiance records run out', async () => {
    // Records through 2026-03-22T20:00Z (34 h from now): the slot at 21:00Z has none.
    fetchExtendedForecastIrradiance.mockResolvedValue({ records: forecastIrradiance(35), nullTimes: [] });
    const result = await runPvForecast(withHorizon('on'));
    expect(result.truncatedAt).toBe('2026-03-22T21:00:00.000Z');
    expect(result.forecast.values).toHaveLength(slotsBetween(NOW_MS, Date.parse('2026-03-22T21:00:00Z')));
  });

  it('keeps today\'s zero fill when the records end inside the old window', async () => {
    fetchExtendedForecastIrradiance.mockResolvedValue({ records: forecastIrradiance(5), nullTimes: [] });
    const result = await runPvForecast(withHorizon('on'));
    // Cut at the old window end, never before it.
    expect(result.truncatedAt).toBe(new Date(BASE_END_MS).toISOString());
    expect(result.forecast.values).toHaveLength(slotsBetween(NOW_MS, BASE_END_MS));
    expect(result.forecast.values.slice(-4)).toEqual([0, 0, 0, 0]);
  });

  it('warns when ICON seamless was unavailable and uses what ICON D2 covers', async () => {
    fetchExtendedForecastIrradiance.mockResolvedValue({ records: forecastIrradiance(45), nullTimes: [], extensionError: 'status 503' });
    const result = await runPvForecast(withHorizon('collect'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ICON seamless irradiance unavailable'));
    expect(result.truncatedAt).toBe(new Date(NOW_MS + 45 * HOUR_MS).toISOString());
  });

  it('checks coverage per 15-minute slot in 15min mode', async () => {
    const config = withHorizon('on', 1, { ...baseConfig, pvConfig: { ...baseConfig.pvConfig, pvMode: '15min', historyDays: 7 } });
    const gap = Date.parse('2026-03-22T09:15:00Z');
    fetchExtendedForecastIrradiance.mockResolvedValue({ records: forecastIrradiance(72, 15), nullTimes: [gap] });
    const result = await runPvForecast(config);
    expect(fetchExtendedForecastIrradiance).toHaveBeenCalledWith(51.05, 3.71, 15, 4);
    expect(result.truncatedAt).toBe('2026-03-22T09:15:00.000Z');
  });
});

describe('runPvForecast — forecast days just after local midnight', () => {
  const DAY = 24 * HOUR_MS;
  // Thu 15 Oct 2026 00:30 CEST = 14 Oct 22:30Z: the UTC day (and so
  // Open-Meteo's day count with timezone=GMT) started 22.5 h earlier than
  // the local one.
  const now = Date.parse('2026-10-14T22:30:00Z');
  let warn;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    vi.resetAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchHaStats.mockResolvedValue(haHistory());
    fetchArchiveIrradiance.mockResolvedValue(archiveIrradiance());
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('requests enough days from the UTC midnight to reach the window end', async () => {
    const config = withHorizon('collect', 3);
    const windowEndMs = Date.parse(resolvePlanningWindow(config, now).endIso);
    // Tomorrow 24:00 (17 Oct 00:00 CEST) + 3 days = 20 Oct 00:00 CEST.
    expect(windowEndMs).toBe(Date.parse('2026-10-19T22:00:00Z'));
    const records = [];
    for (let t = Math.floor(now / HOUR_MS) * HOUR_MS; t < windowEndMs; t += HOUR_MS) {
      const hour = new Date(t).getUTCHours();
      records.push({ time: t, hour, ghi_W_per_m2: hour >= 6 && hour <= 16 ? 400 : 0, intervalMinutes: 60 });
    }
    fetchExtendedForecastIrradiance.mockResolvedValue({ records, nullTimes: [] });

    const result = await runPvForecast(config);

    const forecastDays = fetchExtendedForecastIrradiance.mock.calls[0][3];
    // 5 d 22 h from 14 Oct 00:00Z → 6 days, +1. (extraDays + 2 = 5 days ended on 19 Oct 00:00Z, 22 h short.)
    expect(forecastDays).toBe(7);
    const utcMidnight = Date.parse('2026-10-14T00:00:00Z');
    expect(utcMidnight + forecastDays * DAY).toBeGreaterThanOrEqual(windowEndMs);
    expect(utcMidnight + (forecastDays - 2) * DAY).toBeLessThan(windowEndMs);
    expect(result).not.toHaveProperty('truncatedAt');
    expect(Date.parse(result.forecast.start) + result.forecast.values.length * 15 * 60_000).toBe(windowEndMs);
  });

  it('caps the request at Open-Meteo\'s 16 days', () => {
    expect(extendedForecastDays(now, now + 30 * DAY)).toBe(16);
    expect(extendedForecastDays(Date.parse('2026-03-21T10:00:00Z'), Date.parse('2026-03-23T23:00:00Z'))).toBe(4);
  });
});
