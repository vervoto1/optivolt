import { describe, it, expect } from 'vitest';
import {
  AUTO_FORECAST_URL,
  PRICE_FORECAST_REGIONS,
  PRICE_FORECAST_MAX_SLOTS,
  PRICE_FORECAST_SOURCES,
  PUBLIC_FORECAST_URL,
  buildPriceForecastUrl,
  forecastUrlError,
  forecastUrlSettingError,
  isAutoForecastUrl,
  hourlyMeans,
  localMidnightMs,
  parsePriceForecastResponse,
} from '../../lib/price-forecast.ts';

// Tests run with TZ=Europe/Amsterdam (vitest.config.js).
const NOW = Date.parse('2026-10-13T09:50:00Z'); // 11:50 CEST
const MIDNIGHT = Date.parse('2026-10-12T22:00:00Z'); // 00:00 CEST

function quarterPoints(startIso, totals) {
  const startMs = Date.parse(startIso);
  return totals.map((total, i) => ({ startsAt: new Date(startMs + i * 900_000).toISOString(), total }));
}

describe('PRICE_FORECAST_REGIONS', () => {
  it('lists the feed\'s bidding zones', () => {
    expect(PRICE_FORECAST_REGIONS).toEqual(['DE', 'AT', 'BE', 'FR', 'NL', 'SE1', 'SE2', 'SE3', 'SE4', 'DK1', 'DK2', 'ES', 'PT']);
  });
});

describe('forecastUrlError', () => {
  it('accepts http(s) URLs, with or without a path', () => {
    for (const ok of ['https://epexpredictor.batzill.com', 'http://192.0.2.10:8000', ' https://host/epex/ ']) {
      expect(forecastUrlError(ok)).toBeNull();
    }
  });

  it('rejects non-strings, empty strings, unparseable URLs, other schemes and credentials', () => {
    expect(forecastUrlError(42)).toBe('must be a non-empty string');
    expect(forecastUrlError('  ')).toBe('must be a non-empty string');
    expect(forecastUrlError('not a url')).toBe('is not a valid URL');
    expect(forecastUrlError('ftp://host')).toBe('must use http or https');
    expect(forecastUrlError('javascript:alert(1)')).toBe('must use http or https');
    expect(forecastUrlError(['https://user', 'pw@host'].join(':'))).toBe('must not contain credentials');
    expect(forecastUrlError(['https://user', 'host'].join('@'))).toBe('must not contain credentials');
  });
});

describe('localMidnightMs', () => {
  it('is local (server time zone) midnight of the current day', () => {
    expect(localMidnightMs(NOW)).toBe(MIDNIGHT);
    expect(localMidnightMs(MIDNIGHT)).toBe(MIDNIGHT);
  });

  it('follows DST: the day after the autumn change starts at 23:00 UTC', () => {
    expect(new Date(localMidnightMs(Date.parse('2026-10-26T12:00:00Z'))).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});

describe('the forecastUrl setting', () => {
  it('names the public server, auto and the stored sources', () => {
    expect(PUBLIC_FORECAST_URL).toBe('https://epexpredictor.batzill.com');
    expect(forecastUrlError(PUBLIC_FORECAST_URL)).toBeNull();
    expect(AUTO_FORECAST_URL).toBe('auto');
    expect(PRICE_FORECAST_SOURCES).toEqual(['configured', 'local', 'public']);
  });

  it('recognises auto trimmed and in any case', () => {
    for (const auto of ['auto', ' AUTO ', 'Auto']) expect(isAutoForecastUrl(auto)).toBe(true);
    for (const other of ['', 'autos', 'http://auto', null, 42]) expect(isAutoForecastUrl(other)).toBe(false);
  });

  it('accepts auto besides the URLs forecastUrlError accepts', () => {
    expect(forecastUrlSettingError(' Auto ')).toBeNull();
    expect(forecastUrlSettingError('http://192.0.2.10:8000')).toBeNull();
    expect(forecastUrlSettingError('automatic')).toBe('must be "auto" or a valid http(s) URL');
    expect(forecastUrlSettingError('ftp://host')).toBe('must use http or https');
    expect(forecastUrlSettingError('')).toBe('must be a non-empty string');
  });
});

describe('buildPriceForecastUrl', () => {
  it('asks for the region in c/kWh from local midnight today, without hours, surcharge or tax', () => {
    const url = new URL(buildPriceForecastUrl({ baseUrl: 'https://epexpredictor.batzill.com', region: 'NL', nowMs: NOW }));
    expect(url.origin + url.pathname).toBe('https://epexpredictor.batzill.com/prices');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      region: 'NL',
      unit: 'CT_PER_KWH',
      startTs: '2026-10-12T22:00:00.000Z',
    });
  });

  it('appends /prices to a base path and tolerates a trailing slash', () => {
    expect(new URL(buildPriceForecastUrl({ baseUrl: 'http://host:8000/epex/', region: 'DE', nowMs: NOW })).pathname)
      .toBe('/epex/prices');
  });
});

describe('parsePriceForecastResponse', () => {
  it('parses a quarter-hourly response; knownUntil is the start of the last published slot', () => {
    const body = {
      prices: quarterPoints('2026-10-13T00:00:00+02:00', [17.5, 16.9, 16.4, 16.0, 15.8]),
      knownUntil: '2026-10-13T00:30:00+02:00',
    };
    const parsed = parsePriceForecastResponse(body);
    expect(parsed.series).toEqual({ start: '2026-10-12T22:00:00.000Z', step: 15, values: [17.5, 16.9, 16.4, 16.0, 15.8] });
    // knownUntil is inclusive: the slot starting at 00:30 is published, so the end is 00:45.
    expect(new Date(parsed.publishedEndMs).toISOString()).toBe('2026-10-12T22:45:00.000Z');
    expect(parsed.truncated).toBe(false);
  });

  it('expands an hourly response to quarters and ends the published part one hour after knownUntil', () => {
    const body = {
      prices: [
        { startsAt: '2026-10-13T00:00:00+02:00', total: 10 },
        { startsAt: '2026-10-13T01:00:00+02:00', total: 12 },
      ],
      knownUntil: '2026-10-13T00:00:00+02:00',
    };
    const parsed = parsePriceForecastResponse(body);
    expect(parsed.series.step).toBe(15);
    expect(parsed.series.values).toEqual([10, 10, 10, 10, 12, 12, 12, 12]);
    expect(new Date(parsed.publishedEndMs).toISOString()).toBe('2026-10-12T23:00:00.000Z');
  });

  it('treats a single point as quarter-hourly', () => {
    const parsed = parsePriceForecastResponse({ prices: [{ startsAt: '2026-10-13T00:00:00Z', total: 3 }], knownUntil: '2026-10-13T00:00:00Z' });
    expect(parsed.series.values).toEqual([3]);
    expect(parsed.publishedEndMs).toBe(Date.parse('2026-10-13T00:15:00Z'));
  });

  it('ends the series at the first gap', () => {
    const points = quarterPoints('2026-10-13T00:00:00Z', [1, 2, 3]);
    points.push({ startsAt: '2026-10-13T01:00:00Z', total: 9 });
    const parsed = parsePriceForecastResponse({ prices: points, knownUntil: '2026-10-13T00:00:00Z' });
    expect(parsed.series.values).toEqual([1, 2, 3]);
    expect(parsed.truncated).toBe(true);
  });

  it('caps the series at PRICE_FORECAST_MAX_SLOTS', () => {
    const totals = Array.from({ length: PRICE_FORECAST_MAX_SLOTS + 5 }, (_, i) => i);
    const parsed = parsePriceForecastResponse({ prices: quarterPoints('2026-10-13T00:00:00Z', totals), knownUntil: '2026-10-13T00:00:00Z' });
    expect(parsed.series.values).toHaveLength(PRICE_FORECAST_MAX_SLOTS);
    expect(parsed.truncated).toBe(true);
  });

  it('takes the slot cap from options.maxSlots (default PRICE_FORECAST_MAX_SLOTS)', () => {
    const totals = Array.from({ length: PRICE_FORECAST_MAX_SLOTS + 5 }, (_, i) => i);
    const body = { prices: quarterPoints('2026-10-13T00:00:00Z', totals), knownUntil: '2026-10-13T00:00:00Z' };
    expect(parsePriceForecastResponse(body, {}).series.values).toHaveLength(PRICE_FORECAST_MAX_SLOTS);
    const small = parsePriceForecastResponse(body, { maxSlots: 4 });
    expect(small.series.values).toEqual([0, 1, 2, 3]);
    expect(small.truncated).toBe(true);
    const all = parsePriceForecastResponse(body, { maxSlots: Infinity });
    expect(all.series.values).toEqual(totals);
    expect(all.truncated).toBe(false);
  });

  it('rejects malformed responses', () => {
    const good = quarterPoints('2026-10-13T00:00:00Z', [1, 2]);
    const cases = [
      [null, 'response is not an object'],
      [[], 'response is not an object'],
      ['x', 'response is not an object'],
      [{ knownUntil: '2026-10-13T00:00:00Z' }, 'response has no prices'],
      [{ prices: [], knownUntil: '2026-10-13T00:00:00Z' }, 'response has no prices'],
      [{ prices: [null], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[0] is not an object'],
      [{ prices: [{ startsAt: 'nope', total: 1 }], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[0].startsAt is not a valid timestamp'],
      [{ prices: [{ startsAt: 5, total: 1 }], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[0].startsAt is not a valid timestamp'],
      [{ prices: [{ startsAt: '2026-10-13T00:00:00Z', total: '1' }], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[0].total is not a finite number'],
      [{ prices: [{ startsAt: '2026-10-13T00:00:00Z', total: null }], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[0].total is not a finite number'],
      [{ prices: [good[1], good[0]], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[1].startsAt does not follow prices[0]'],
      [{ prices: [good[0], good[0]], knownUntil: '2026-10-13T00:00:00Z' }, 'prices[1].startsAt does not follow prices[0]'],
      [{ prices: [{ startsAt: '2026-10-13T00:05:00Z', total: 1 }], knownUntil: '2026-10-13T00:00:00Z' }, 'not on a 15-minute boundary'],
      [{ prices: quarterPoints('2026-10-13T00:00:00Z', [1, 2]).filter((_, i) => i === 0).concat([{ startsAt: '2026-10-13T00:30:00Z', total: 2 }]), knownUntil: '2026-10-13T00:00:00Z' }, 'unsupported resolution of 30 minutes'],
      [{ prices: good }, 'knownUntil is not a valid timestamp'],
      [{ prices: good, knownUntil: 'later' }, 'knownUntil is not a valid timestamp'],
    ];
    for (const [body, message] of cases) {
      expect(() => parsePriceForecastResponse(body), message).toThrow(message);
    }
  });
});

describe('hourlyMeans', () => {
  const series = { start: '2026-10-13T00:00:00.000Z', step: 15, values: [1, 2, 3, 4, 10, 10, 10, 10, 6] };

  it('averages the quarters of each hour from the given instant', () => {
    expect(hourlyMeans(series, Date.parse('2026-10-13T00:00:00Z'), 5)).toEqual({
      startMs: Date.parse('2026-10-13T00:00:00Z'),
      values: [2.5, 10, 6],
    });
  });

  it('rounds the start up to a whole hour and stops after `hours`', () => {
    expect(hourlyMeans(series, Date.parse('2026-10-13T00:15:00Z'), 1)).toEqual({
      startMs: Date.parse('2026-10-13T01:00:00Z'),
      values: [10],
    });
  });

  it('skips non-finite values, ends at an hour without any, and defaults a missing step to 15', () => {
    const holes = { start: '2026-10-13T00:00:00.000Z', values: [null, 4, Number.NaN, 'x', null, null, null, null, 5] };
    expect(hourlyMeans(holes, Date.parse('2026-10-13T00:00:00Z'), 3).values).toEqual([4]);
    expect(hourlyMeans(series, Date.parse('2026-10-12T22:00:00Z'), 3).values).toEqual([]);
  });

  it('rounds to 4 decimals', () => {
    const s = { start: '2026-10-13T00:00:00.000Z', step: 15, values: [1, 1, 1, 2] };
    expect(hourlyMeans(s, Date.parse('2026-10-13T00:00:00Z'), 1).values).toEqual([1.25]);
    const t = { start: '2026-10-13T00:00:00.000Z', step: 15, values: [0.1, 0.2, 0.2, 0.2] };
    expect(hourlyMeans(t, Date.parse('2026-10-13T00:00:00Z'), 1).values).toEqual([0.175]);
  });
});
