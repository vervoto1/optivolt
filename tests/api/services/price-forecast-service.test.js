import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub fetch before importing the service (as open-meteo-client.test.js does).
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../../api/services/json-store.ts', async (importOriginal) => {
  const actual = await importOriginal();
  let store = {};
  return {
    resolveDataDir: () => '/tmp/test-data',
    withJsonLock: actual.withJsonLock,
    readJson: vi.fn(async (filePath) => {
      if (store[filePath] === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return JSON.parse(JSON.stringify(store[filePath]));
    }),
    writeJson: vi.fn(async (filePath, data) => {
      store[filePath] = JSON.parse(JSON.stringify(data));
    }),
    _reset: () => { store = {}; },
    _set: (filePath, data) => { store[filePath] = JSON.parse(JSON.stringify(data)); },
    _get: (filePath) => store[filePath],
  };
});

// The real data-store contract, on an in-memory document.
const dataState = vi.hoisted(() => ({ current: null }));
vi.mock('../../../api/services/data-store.ts', () => ({
  updateData: vi.fn(async (mutate) => {
    const next = mutate(JSON.parse(JSON.stringify(dataState.current)));
    if (!next) return dataState.current;
    dataState.current = next;
    return next;
  }),
}));

// No back-off delay between the two attempts; record the options.
const retryCalls = vi.hoisted(() => []);
vi.mock('../../../api/services/retry.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    withRetry: (fn, opts) => {
      retryCalls.push(opts);
      return actual.withRetry(fn, { ...opts, baseDelayMs: 0 });
    },
  };
});

import {
  FAILURE_BACKOFF_MS,
  MAX_REFRESH_AGE_MS,
  PRICE_FORECAST_ATTEMPTS,
  PRICE_FORECAST_LOG_LIMIT,
  PRICE_FORECAST_STALE_MS,
  PRICE_FORECAST_TIMEOUT_MS,
  PUBLICATION_REFETCH_MIN_MS,
  buildPriceForecastLogEntry,
  decidePriceForecastRefresh,
  fetchPriceForecast,
  getPriceForecastStatus,
  loadPriceForecastLog,
  localDayKey,
  maybeRefreshPriceForecast,
  publishedImportEndMs,
  recordPriceForecastSnapshot,
  refreshPriceForecast,
  resetPriceForecastServiceState,
  waitForPriceForecastRefresh,
} from '../../../api/services/price-forecast-service.ts';
import { updateData } from '../../../api/services/data-store.ts';
import { resetForecastSourceCache } from '../../../api/services/forecast-source.ts';
import { readJson, writeJson, _reset, _set, _get } from '../../../api/services/json-store.ts';

const LOG_PATH = '/tmp/test-data/price-forecast-log.json';
const MIN = 60_000;
const HOUR = 60 * MIN;

// TZ=Europe/Amsterdam. 2026-10-13 is CEST (UTC+2).
const NOW = Date.parse('2026-10-13T12:00:00Z'); // 14:00 local
const MIDNIGHT = Date.parse('2026-10-12T22:00:00Z');
const AFTER_TOMORROW = Date.parse('2026-10-14T22:00:00Z'); // local midnight after tomorrow

const cfg = (overrides = {}) => ({
  mode: 'collect',
  extraDays: 3,
  forecastUrl: 'https://epexpredictor.batzill.com',
  region: 'NL',
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1,
  refreshMinutes: 60,
  ...overrides,
});

const settings = (eh = cfg(), prices = 'ha') => ({ extendedHorizon: eh, dataSources: { load: 'api', pv: 'api', prices, soc: 'mqtt' } });

/** A feed body: `slots` quarter-hours from local midnight, published through `knownUntilMs`. */
function feedBody({ slots = 7 * 96, knownUntilMs = AFTER_TOMORROW - 15 * MIN, value = (i) => 10 + (i % 96) / 10 } = {}) {
  return {
    prices: Array.from({ length: slots }, (_, i) => ({ startsAt: new Date(MIDNIGHT + i * 15 * MIN).toISOString(), total: value(i) })),
    knownUntil: new Date(knownUntilMs).toISOString(),
  };
}

const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

function storedForecast(overrides = {}) {
  return {
    fetchedAt: new Date(NOW - 10 * MIN).toISOString(),
    publishedEnd: new Date(AFTER_TOMORROW).toISOString(),
    region: 'NL',
    series: { start: new Date(MIDNIGHT).toISOString(), step: 15, values: [1, 2, 3] },
    ...overrides,
  };
}

function importSeries(endMs, { trailingZeros = 0, step = 15 } = {}) {
  const n = (endMs - MIDNIGHT) / (step * MIN);
  return { start: new Date(MIDNIGHT).toISOString(), step, values: [...Array(n).fill(20), ...Array(trailingZeros).fill(0)] };
}

let warn;
let log;
beforeEach(() => {
  vi.clearAllMocks();
  retryCalls.length = 0;
  _reset();
  resetPriceForecastServiceState();
  resetForecastSourceCache();
  vi.stubEnv('SUPERVISOR_TOKEN', '');
  dataState.current = { importPrice: importSeries(AFTER_TOMORROW) };
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await waitForPriceForecastRefresh();
  vi.unstubAllEnvs();
  warn.mockRestore();
  log.mockRestore();
});

describe('getPriceForecastStatus', () => {
  it('is missing without a stored forecast', () => {
    expect(getPriceForecastStatus({}, cfg(), NOW)).toEqual({ state: 'missing', forecast: null, ageMs: null });
  });

  it('is fresh up to 12 h, stale after', () => {
    const pf = storedForecast({ fetchedAt: new Date(NOW - PRICE_FORECAST_STALE_MS).toISOString() });
    expect(getPriceForecastStatus({ priceForecast: pf }, cfg(), NOW)).toEqual({ state: 'fresh', forecast: pf, ageMs: PRICE_FORECAST_STALE_MS });
    expect(getPriceForecastStatus({ priceForecast: pf }, cfg(), NOW + 1)).toMatchObject({ state: 'stale', forecast: null });
  });

  it('is unusable when fetched for another region, and ignores the region without a config', () => {
    const pf = storedForecast({ region: 'DE' });
    expect(getPriceForecastStatus({ priceForecast: pf }, cfg(), NOW)).toMatchObject({ state: 'region', forecast: null, ageMs: 10 * MIN });
    expect(getPriceForecastStatus({ priceForecast: pf }, undefined, NOW).state).toBe('fresh');
  });

  it('counts a fetchedAt in the future as age 0', () => {
    const pf = storedForecast({ fetchedAt: new Date(NOW + HOUR).toISOString() });
    expect(getPriceForecastStatus({ priceForecast: pf }, cfg(), NOW)).toMatchObject({ state: 'fresh', ageMs: 0 });
  });
});

describe('publishedImportEndMs', () => {
  it('is the series end for HA/api prices and drops VRM trailing zeros', () => {
    const data = { importPrice: importSeries(AFTER_TOMORROW - 24 * HOUR, { trailingZeros: 96 }) };
    expect(publishedImportEndMs(data, 'ha')).toBe(AFTER_TOMORROW);
    expect(publishedImportEndMs(data, 'vrm')).toBe(AFTER_TOMORROW - 24 * HOUR);
  });

  it('uses the stored VRM publishedUntil when present and parseable', () => {
    const data = { importPrice: importSeries(AFTER_TOMORROW), importPricePublishedUntil: new Date(AFTER_TOMORROW - 24 * HOUR).toISOString() };
    expect(publishedImportEndMs(data, 'vrm')).toBe(AFTER_TOMORROW - 24 * HOUR);
    expect(publishedImportEndMs(data, 'ha')).toBe(AFTER_TOMORROW);
    expect(publishedImportEndMs({ ...data, importPricePublishedUntil: 'x' }, 'vrm')).toBe(AFTER_TOMORROW);
  });

  it('honours the step and defaults a missing one to 15 minutes', () => {
    expect(publishedImportEndMs({ importPrice: importSeries(MIDNIGHT + 2 * HOUR, { step: 60 }) }, 'ha')).toBe(MIDNIGHT + 2 * HOUR);
    expect(publishedImportEndMs({ importPrice: { start: new Date(MIDNIGHT).toISOString(), values: [1, 2] } }, 'ha')).toBe(MIDNIGHT + 30 * MIN);
  });

  it('is null without a usable series', () => {
    expect(publishedImportEndMs({}, 'ha')).toBeNull();
    expect(publishedImportEndMs({ importPrice: { start: 'x', values: [1] } }, 'ha')).toBeNull();
    expect(publishedImportEndMs({ importPrice: { start: new Date(MIDNIGHT).toISOString(), values: 'x' } }, 'ha')).toBeNull();
    expect(publishedImportEndMs({ importPrice: { start: new Date(MIDNIGHT).toISOString(), values: [] } }, 'ha')).toBeNull();
    expect(publishedImportEndMs({ importPrice: { start: new Date(MIDNIGHT).toISOString(), values: [0, 0] } }, 'vrm')).toBeNull();
  });
});

describe('decidePriceForecastRefresh', () => {
  const decide = (s, data, now = NOW, opts = {}) => decidePriceForecastRefresh(s, data, now, { jitterMs: 0, lastFailureMs: null, ...opts });

  it('never refreshes when the block is absent or the mode is off', () => {
    expect(decide({ dataSources: settings().dataSources }, {})).toEqual({ refresh: false, reason: 'off' });
    expect(decide(settings(cfg({ mode: 'off' })), {})).toEqual({ refresh: false, reason: 'off' });
  });

  it('refreshes a missing forecast in collect and on modes', () => {
    expect(decide(settings(), {})).toEqual({ refresh: true, reason: 'missing' });
    expect(decide(settings(cfg({ mode: 'on' })), {})).toEqual({ refresh: true, reason: 'missing' });
  });

  it('refreshes a forecast for another region', () => {
    expect(decide(settings(), { priceForecast: storedForecast({ region: 'BE' }) })).toEqual({ refresh: true, reason: 'region' });
  });

  it('refreshes once older than refreshMinutes plus jitter', () => {
    const at = (ageMin) => ({ priceForecast: storedForecast({ fetchedAt: new Date(NOW - ageMin * MIN).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) });
    expect(decide(settings(), at(59))).toEqual({ refresh: false, reason: 'fresh' });
    expect(decide(settings(), at(60))).toEqual({ refresh: true, reason: 'age' });
    expect(decide(settings(), at(64), NOW, { jitterMs: 5 * MIN })).toEqual({ refresh: false, reason: 'fresh' });
    expect(decide(settings(), at(65), NOW, { jitterMs: 5 * MIN })).toEqual({ refresh: true, reason: 'age' });
  });

  it('is always due 2 h before the forecast turns stale, whatever refreshMinutes and the jitter say', () => {
    expect(MAX_REFRESH_AGE_MS).toBe(PRICE_FORECAST_STALE_MS - 2 * HOUR);
    const at = (ageMs) => ({ priceForecast: storedForecast({ fetchedAt: new Date(NOW - ageMs).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) });
    // The largest allowed interval (600 min) plus the largest jitter (10 min) is capped at 10 h.
    const longest = settings(cfg({ refreshMinutes: 600 }));
    expect(decide(longest, at(MAX_REFRESH_AGE_MS - 1), NOW, { jitterMs: 10 * MIN })).toEqual({ refresh: false, reason: 'fresh' });
    expect(decide(longest, at(MAX_REFRESH_AGE_MS), NOW, { jitterMs: 10 * MIN })).toEqual({ refresh: true, reason: 'age' });
    // A stored setting past the limit (as the old 720) would still be due at 10 h, not at 12 h.
    expect(decide(settings(cfg({ refreshMinutes: 720 })), at(MAX_REFRESH_AGE_MS))).toEqual({ refresh: true, reason: 'age' });
    // Just under the cap, refreshMinutes plus jitter still decides.
    const ninePointFive = settings(cfg({ refreshMinutes: 570 }));
    expect(decide(ninePointFive, at(575 * MIN - 1), NOW, { jitterMs: 5 * MIN })).toEqual({ refresh: false, reason: 'fresh' });
    expect(decide(ninePointFive, at(575 * MIN), NOW, { jitterMs: 5 * MIN })).toEqual({ refresh: true, reason: 'age' });
  });

  it('applies a default jitter of at most 10 % of the interval', () => {
    const at = (ageMin) => ({ priceForecast: storedForecast({ fetchedAt: new Date(NOW - ageMin * MIN).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) });
    const decideDefault = (data) => decidePriceForecastRefresh(settings(), data, NOW, { lastFailureMs: null });
    expect(decideDefault(at(59)).refresh).toBe(false);
    expect(decideDefault(at(66)).refresh).toBe(true);
  });

  it('refreshes a forecast fetched in the future (clock stepped back)', () => {
    const data = { priceForecast: storedForecast({ fetchedAt: new Date(NOW + HOUR).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) };
    expect(decide(settings(), data)).toEqual({ refresh: true, reason: 'age' });
  });

  it('refreshes when the published import prices reach past publishedEnd, at most every 30 minutes', () => {
    const publishedEnd = new Date(AFTER_TOMORROW - 24 * HOUR).toISOString();
    const at = (ageMs) => ({ priceForecast: storedForecast({ publishedEnd, fetchedAt: new Date(NOW - ageMs).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) });
    expect(decide(settings(), at(PUBLICATION_REFETCH_MIN_MS))).toEqual({ refresh: true, reason: 'published' });
    expect(decide(settings(), at(PUBLICATION_REFETCH_MIN_MS - 1))).toEqual({ refresh: false, reason: 'fresh' });
  });

  it('does not take VRM zero-fill for a publication', () => {
    const publishedEnd = new Date(AFTER_TOMORROW - 24 * HOUR).toISOString();
    const data = {
      priceForecast: storedForecast({ publishedEnd, fetchedAt: new Date(NOW - 40 * MIN).toISOString() }),
      importPrice: importSeries(AFTER_TOMORROW - 24 * HOUR, { trailingZeros: 96 }),
    };
    expect(decide(settings(cfg(), 'vrm'), data)).toEqual({ refresh: false, reason: 'fresh' });
    expect(decide(settings(cfg(), 'ha'), data)).toEqual({ refresh: true, reason: 'published' });
  });

  it('takes an explicit published import end, and ignores a missing one', () => {
    const data = { priceForecast: storedForecast({ fetchedAt: new Date(NOW - 40 * MIN).toISOString() }), importPrice: importSeries(AFTER_TOMORROW) };
    expect(decide(settings(), data, NOW, { publishedImportEndMs: AFTER_TOMORROW + HOUR })).toEqual({ refresh: true, reason: 'published' });
    expect(decide(settings(), data, NOW, { publishedImportEndMs: null })).toEqual({ refresh: false, reason: 'fresh' });
  });

  it('backs off for 30 minutes after a failure', () => {
    expect(decide(settings(), {}, NOW, { lastFailureMs: NOW - FAILURE_BACKOFF_MS + 1 })).toEqual({ refresh: false, reason: 'backoff' });
    expect(decide(settings(), {}, NOW, { lastFailureMs: NOW - FAILURE_BACKOFF_MS })).toEqual({ refresh: true, reason: 'missing' });
  });
});

describe('fetchPriceForecast', () => {
  it('requests the region from local midnight with a 10 s timeout and parses the response', async () => {
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT + 15 * MIN })));
    const result = await fetchPriceForecast(cfg(), NOW);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://epexpredictor.batzill.com/prices?region=NL&unit=CT_PER_KWH&startTs=2026-10-12T22%3A00%3A00.000Z');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(PRICE_FORECAST_TIMEOUT_MS).toBe(10_000);
    expect(retryCalls).toEqual([{ attempts: PRICE_FORECAST_ATTEMPTS, label: 'price forecast' }]);
    expect(PRICE_FORECAST_ATTEMPTS).toBe(2);
    expect(result).toEqual({
      fetchedAt: new Date(NOW).toISOString(),
      publishedEnd: new Date(MIDNIGHT + 30 * MIN).toISOString(),
      region: 'NL',
      series: { start: new Date(MIDNIGHT).toISOString(), step: 15, values: [10, 10.1, 10.2, 10.3] },
    });
  });

  it('retries once and throws on a second HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    await expect(fetchPriceForecast(cfg(), NOW)).rejects.toThrow('Price forecast request returned status 503');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('recovers on the second attempt', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok(feedBody({ slots: 1, knownUntilMs: MIDNIGHT })));
    await expect(fetchPriceForecast(cfg(), NOW)).resolves.toMatchObject({ region: 'NL' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('turns a timeout into a labelled error', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      c.abort();
      return c.signal;
    });
    await expect(fetchPriceForecast(cfg(), NOW)).rejects.toThrow('Price forecast request timed out after 10000ms');
    timeout.mockRestore();
  });
});

describe('refreshPriceForecast', () => {
  it('persists data.priceForecast under the data lock and keeps the other fields', async () => {
    dataState.current = { importPrice: importSeries(AFTER_TOMORROW), soc: { value: 50 } };
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 8, knownUntilMs: MIDNIGHT + 15 * MIN })));

    const result = await refreshPriceForecast(cfg(), NOW);

    expect(result.ok).toBe(true);
    expect(result.logged).toBe(false); // tomorrow not yet published in this body
    expect(updateData).toHaveBeenCalledTimes(1);
    expect(dataState.current.soc).toEqual({ value: 50 });
    expect(dataState.current.priceForecast).toEqual(result.forecast);
    expect(dataState.current.priceForecast.series.values).toHaveLength(8);
  });

  it('records a configured URL as the source', async () => {
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT })));
    const result = await refreshPriceForecast(cfg({ forecastUrl: 'http://192.0.2.10:8000' }), NOW);

    expect(mockFetch.mock.calls[0][0]).toMatch(/^http:\/\/192\.0\.2\.10:8000\/prices\?/);
    expect(result.forecast).toMatchObject({ source: 'configured', url: 'http://192.0.2.10:8000' });
    expect(result.forecast).not.toHaveProperty('sourceReason');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('from http://192.0.2.10:8000;'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('auto outside Home Assistant fetches from the public server, warns and stores why', async () => {
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT })));
    await refreshPriceForecast(cfg({ forecastUrl: 'auto' }), NOW);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/epexpredictor\.batzill\.com\/prices\?/);
    expect(dataState.current.priceForecast).toMatchObject({
      source: 'public', url: 'https://epexpredictor.batzill.com', sourceReason: 'no Supervisor',
    });
    expect(warn).toHaveBeenCalledWith('[price-forecast] local EpexPredictor add-on not used (no Supervisor): fetching from the public server');
  });

  it('auto in Home Assistant fetches from the running add-on and drops a stored fallback reason', async () => {
    vi.stubEnv('SUPERVISOR_TOKEN', 'sup-token');
    dataState.current = { priceForecast: storedForecast({ source: 'public', url: 'https://epexpredictor.batzill.com', sourceReason: 'not installed' }) };
    mockFetch.mockImplementation(async (url) => {
      if (url === 'http://supervisor/addons/self/info') return ok({ result: 'ok', data: { slug: '601a68d0_optivolt' } });
      if (url === 'http://supervisor/addons/601a68d0_epexpredictor/info') {
        return ok({ result: 'ok', data: { state: 'started', hostname: '601a68d0-epexpredictor' } });
      }
      return ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT }));
    });

    const result = await refreshPriceForecast(cfg({ forecastUrl: 'auto' }), NOW);

    expect(result.ok).toBe(true);
    expect(mockFetch.mock.calls[2][0]).toBe('http://601a68d0-epexpredictor/prices?region=NL&unit=CT_PER_KWH&startTs=2026-10-12T22%3A00%3A00.000Z');
    expect(dataState.current.priceForecast).toMatchObject({ source: 'local', url: 'http://601a68d0-epexpredictor' });
    expect(dataState.current.priceForecast).not.toHaveProperty('sourceReason');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the stored import fit for the same region and drops it for another', async () => {
    const fit = { a: 1.21, b: 14.3, n: 24, mad: 0.2, fittedAt: new Date(NOW - HOUR).toISOString() };
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT })));

    dataState.current = { priceForecast: storedForecast({ fit }) };
    await refreshPriceForecast(cfg(), NOW);
    expect(dataState.current.priceForecast.fit).toEqual(fit);

    dataState.current = { priceForecast: storedForecast({ fit, region: 'DE' }) };
    await refreshPriceForecast(cfg(), NOW);
    expect(dataState.current.priceForecast.fit).toBeUndefined();
    expect(dataState.current.priceForecast.region).toBe('NL');
  });

  it('keeps the stored forecast, warns and backs off on failure', async () => {
    const stored = storedForecast();
    dataState.current = { priceForecast: stored };
    mockFetch.mockResolvedValue(ok({ prices: [] }));

    const result = await refreshPriceForecast(cfg(), NOW);

    expect(result).toEqual({ ok: false, error: 'Price forecast: response has no prices' });
    expect(dataState.current.priceForecast).toEqual(stored);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refresh failed — keeping the stored forecast'));
    // The back-off now applies to the default decision ...
    expect(decidePriceForecastRefresh(settings(), {}, NOW + FAILURE_BACKOFF_MS - 1).reason).toBe('backoff');
    // ... and a success clears it.
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT })));
    await refreshPriceForecast(cfg(), NOW + 1);
    expect(decidePriceForecastRefresh(settings(), {}, NOW + 2, { jitterMs: 0 }).reason).toBe('missing');
  });

  it('reports a non-Error rejection', async () => {
    updateData.mockRejectedValueOnce('disk full');
    mockFetch.mockResolvedValue(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT })));
    expect(await refreshPriceForecast(cfg(), NOW)).toEqual({ ok: false, error: 'disk full' });
  });

  it('logs the first fetch after publication of the day', async () => {
    mockFetch.mockResolvedValue(ok(feedBody()));
    const result = await refreshPriceForecast(cfg(), NOW);
    expect(result.logged).toBe(true);
    expect(_get(LOG_PATH).entries).toHaveLength(1);
  });
});

describe('maybeRefreshPriceForecast', () => {
  it('does nothing when no refresh is due', async () => {
    expect(await maybeRefreshPriceForecast(settings(cfg({ mode: 'off' })), {}, NOW)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('starts one background refresh, joins concurrent calls, and can be awaited', async () => {
    let release;
    mockFetch.mockImplementation(() => new Promise(resolve => { release = () => resolve(ok(feedBody({ slots: 4, knownUntilMs: MIDNIGHT }))); }));

    const first = maybeRefreshPriceForecast(settings(), {}, NOW);
    const second = maybeRefreshPriceForecast(settings(), {}, NOW);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    release();
    await waitForPriceForecastRefresh();
    expect((await first).ok).toBe(true);
    expect(dataState.current.priceForecast.region).toBe('NL');
    expect(log).toHaveBeenCalledWith('[price-forecast] refreshing (missing)');

    // Settled: a later call decides afresh (the stored forecast is now fresh).
    expect(await maybeRefreshPriceForecast(settings(), dataState.current, NOW, { jitterMs: 0 })).toBeNull();
  });

  it('never rejects, even when the fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    await expect(maybeRefreshPriceForecast(settings(), {}, NOW)).resolves.toEqual({ ok: false, error: 'offline' });
  });

  it('never throws when the decision itself fails, and defaults now to the clock', async () => {
    const broken = { get extendedHorizon() { throw new Error('bad settings'); }, dataSources: {} };
    await expect(maybeRefreshPriceForecast(broken, {})).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[price-forecast] could not decide on a refresh:', 'bad settings');
  });
});

describe('accuracy log', () => {
  const published = (overrides = {}) => ({
    ...storedForecast(),
    fetchedAt: new Date(NOW).toISOString(),
    series: { start: new Date(MIDNIGHT).toISOString(), step: 15, values: Array.from({ length: 7 * 96 }, (_, i) => Math.floor(i / 4)) },
    ...overrides,
  });

  it('localDayKey is the local calendar day', () => {
    expect(localDayKey(Date.parse('2026-10-12T22:30:00Z'))).toBe('2026-10-13');
    expect(localDayKey(Date.parse('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });

  it('builds hourly means for 5 days after the published end', () => {
    const entry = buildPriceForecastLogEntry(published(), NOW);
    expect(entry).toMatchObject({
      day: '2026-10-13',
      fetchedAt: new Date(NOW).toISOString(),
      region: 'NL',
      publishedEnd: new Date(AFTER_TOMORROW).toISOString(),
      start: new Date(AFTER_TOMORROW).toISOString(),
      step: 60,
    });
    expect(entry.values).toHaveLength(120);
    expect(entry.values[0]).toBe(48); // hour 48 after local midnight today
  });

  it('logs nothing before the day\'s publication or without forecast slots', () => {
    expect(buildPriceForecastLogEntry(published({ publishedEnd: new Date(AFTER_TOMORROW - 15 * MIN).toISOString() }), NOW)).toBeNull();
    const short = published({ series: { start: new Date(MIDNIGHT).toISOString(), step: 15, values: Array(192).fill(5) } });
    expect(buildPriceForecastLogEntry(short, NOW)).toBeNull();
  });

  it('keeps one snapshot per local day and region', async () => {
    expect(await recordPriceForecastSnapshot(published(), NOW)).toBe(true);
    expect(await recordPriceForecastSnapshot(published(), NOW + HOUR)).toBe(false);
    expect(await recordPriceForecastSnapshot(published({ region: 'BE' }), NOW + HOUR)).toBe(true);
    const next = Date.parse('2026-10-14T12:00:00Z');
    expect(await recordPriceForecastSnapshot(published({ publishedEnd: new Date(AFTER_TOMORROW + 24 * HOUR).toISOString() }), next)).toBe(true);
    expect((await loadPriceForecastLog()).entries.map(e => `${e.day}/${e.region}`)).toEqual(['2026-10-13/NL', '2026-10-13/BE', '2026-10-14/NL']);
    expect(await recordPriceForecastSnapshot(published({ publishedEnd: new Date(MIDNIGHT).toISOString() }), NOW)).toBe(false);
  });

  it('keeps a ring of the newest 60 entries', async () => {
    const entries = Array.from({ length: PRICE_FORECAST_LOG_LIMIT }, (_, i) => ({ day: `2026-08-${String(i).padStart(2, '0')}`, region: 'NL', values: [] }));
    _set(LOG_PATH, { entries });
    expect(await recordPriceForecastSnapshot(published(), NOW)).toBe(true);
    const stored = _get(LOG_PATH).entries;
    expect(stored).toHaveLength(PRICE_FORECAST_LOG_LIMIT);
    expect(stored[0].day).toBe('2026-08-01');
    expect(stored.at(-1).day).toBe('2026-10-13');
  });

  it('starts a new log when the file is malformed or unreadable', async () => {
    _set(LOG_PATH, { nope: true });
    expect(await loadPriceForecastLog()).toEqual({ entries: [] });
    expect(warn).toHaveBeenCalledWith('[price-forecast] price-forecast-log.json is malformed; starting a new log');

    _set(LOG_PATH, null);
    expect(await loadPriceForecastLog()).toEqual({ entries: [] });

    readJson.mockRejectedValueOnce(new SyntaxError('Unexpected token'));
    expect(await loadPriceForecastLog()).toEqual({ entries: [] });
    expect(warn).toHaveBeenCalledWith('[price-forecast] could not read price-forecast-log.json; starting a new log:', 'Unexpected token');
  });

  it('never throws when the log cannot be written', async () => {
    writeJson.mockRejectedValueOnce(new Error('EACCES'));
    expect(await recordPriceForecastSnapshot(published(), NOW)).toBe(false);
    expect(warn).toHaveBeenCalledWith('[price-forecast] could not write the accuracy log:', 'EACCES');
  });
});
