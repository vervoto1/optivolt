import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FORECAST_SOURCE_CACHE_MS,
  SUPERVISOR_TIMEOUT_MS,
  resetForecastSourceCache,
  resolveForecastSource,
} from '../../../api/services/forecast-source.ts';
import { PUBLIC_FORECAST_URL } from '../../../lib/price-forecast.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const ENV = { SUPERVISOR_TOKEN: 'sup-token' };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const okInfo = (data) => json(200, { result: 'ok', data });

/**
 * A Supervisor stub: `self` answers /addons/self/info, `addon` answers
 * /addons/<slug>/info (a response, or a function of the slug).
 */
function supervisor({ self = okInfo({ slug: '601a68d0_optivolt' }), addon = okInfo({ state: 'started', hostname: '601a68d0-epexpredictor' }) } = {}) {
  return vi.fn(async (url) => {
    if (url === 'http://supervisor/addons/self/info') return typeof self === 'function' ? self() : self;
    const match = /^http:\/\/supervisor\/addons\/([^/]+)\/info$/.exec(url);
    if (match) return typeof addon === 'function' ? addon(decodeURIComponent(match[1])) : addon;
    throw new Error(`unexpected ${url}`);
  });
}

const resolve = (fetchImpl, { forecastUrl = 'auto', nowMs = NOW, env = ENV } = {}) =>
  resolveForecastSource(forecastUrl, { nowMs, env, fetchImpl });

beforeEach(() => {
  resetForecastSourceCache();
});

describe('resolveForecastSource', () => {
  it('uses a configured URL as is, without asking the Supervisor', async () => {
    const fetchImpl = supervisor();
    expect(await resolve(fetchImpl, { forecastUrl: ' http://192.0.2.10:8000 ' }))
      .toEqual({ url: 'http://192.0.2.10:8000', source: 'configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the public server outside Home Assistant', async () => {
    const fetchImpl = supervisor();
    expect(await resolve(fetchImpl, { env: {} }))
      .toEqual({ url: PUBLIC_FORECAST_URL, source: 'public', reason: 'no Supervisor' });
    expect(await resolve(fetchImpl, { env: { SUPERVISOR_TOKEN: '' } })).toMatchObject({ reason: 'no Supervisor' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads process.env by default', async () => {
    vi.stubEnv('SUPERVISOR_TOKEN', '');
    expect(await resolveForecastSource('auto', { nowMs: NOW, fetchImpl: supervisor() })).toMatchObject({ reason: 'no Supervisor' });
    vi.unstubAllEnvs();
  });

  it('uses the started sibling add-on by its hostname, asking with the Supervisor token', async () => {
    const fetchImpl = supervisor();
    expect(await resolve(fetchImpl)).toEqual({ url: 'http://601a68d0-epexpredictor', source: 'local' });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://supervisor/addons/self/info',
      'http://supervisor/addons/601a68d0_epexpredictor/info',
    ]);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer sup-token', Accept: 'application/json' });
  });

  it('derives the sibling slug from a local install as well', async () => {
    const fetchImpl = supervisor({
      self: okInfo({ slug: 'local_optivolt' }),
      addon: (slug) => okInfo({ state: 'started', hostname: slug.replace('_', '-') }),
    });
    expect(await resolve(fetchImpl)).toEqual({ url: 'http://local-epexpredictor', source: 'local' });
  });

  it('falls back when the add-on is not installed (404 or 400)', async () => {
    for (const status of [404, 400]) {
      resetForecastSourceCache();
      const fetchImpl = supervisor({ addon: json(status, { result: 'error', message: 'Addon is not installed' }) });
      expect(await resolve(fetchImpl)).toEqual({ url: PUBLIC_FORECAST_URL, source: 'public', reason: 'not installed' });
    }
  });

  it('falls back when the add-on is not started', async () => {
    const fetchImpl = supervisor({ addon: okInfo({ state: 'stopped', hostname: '601a68d0-epexpredictor' }) });
    expect(await resolve(fetchImpl)).toEqual({ url: PUBLIC_FORECAST_URL, source: 'public', reason: 'not started (state stopped)' });

    resetForecastSourceCache();
    expect(await resolve(supervisor({ addon: okInfo({ hostname: 'h' }) }))).toMatchObject({ reason: 'not started (state undefined)' });
  });

  it('falls back with the Supervisor failure as the reason', async () => {
    const cases = [
      [{ self: json(403, { result: 'error' }) }, 'Supervisor lookup failed: /addons/self/info returned status 403'],
      [{ self: okInfo({}) }, 'Supervisor lookup failed: unexpected own add-on slug undefined'],
      [{ self: okInfo({ slug: 'optivolt_dev' }) }, 'Supervisor lookup failed: unexpected own add-on slug "optivolt_dev"'],
      [{ self: json(200, { result: 'error' }) }, 'Supervisor lookup failed: unexpected own add-on slug undefined'],
      [{ self: json(200, null) }, 'Supervisor lookup failed: unexpected own add-on slug undefined'],
      [{ addon: json(500, {}) }, 'Supervisor lookup failed: /addons/601a68d0_epexpredictor/info returned status 500'],
      [{ addon: json(200, { result: 'ok', data: 'started' }) }, 'Supervisor lookup failed: no add-on info for 601a68d0_epexpredictor'],
      [{ addon: json(200, { result: 'ok' }) }, 'Supervisor lookup failed: no add-on info for 601a68d0_epexpredictor'],
      [{ addon: okInfo({ state: 'started' }) }, 'Supervisor lookup failed: 601a68d0_epexpredictor reports no hostname'],
      [{ addon: okInfo({ state: 'started', hostname: '' }) }, 'Supervisor lookup failed: 601a68d0_epexpredictor reports no hostname'],
      [{ self: () => { throw new Error('getaddrinfo ENOTFOUND supervisor'); } }, 'Supervisor lookup failed: getaddrinfo ENOTFOUND supervisor'],
      [{ self: () => { throw 'boom'; } }, 'Supervisor lookup failed: boom'],
      [{ self: { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token')) } }, 'Supervisor lookup failed: Unexpected token'],
    ];
    for (const [stub, reason] of cases) {
      resetForecastSourceCache();
      expect(await resolve(supervisor(stub)), reason).toEqual({ url: PUBLIC_FORECAST_URL, source: 'public', reason });
    }
  });

  it('caches the resolution, positive and negative, for 10 minutes per forecastUrl', async () => {
    expect(FORECAST_SOURCE_CACHE_MS).toBe(10 * 60_000);
    const fetchImpl = supervisor({ addon: okInfo({ state: 'stopped' }) });
    expect(await resolve(fetchImpl)).toMatchObject({ source: 'public' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Started meanwhile: still the cached fallback until the cache runs out.
    const started = supervisor();
    expect(await resolve(started, { nowMs: NOW + FORECAST_SOURCE_CACHE_MS - 1 })).toMatchObject({ source: 'public' });
    expect(started).not.toHaveBeenCalled();
    expect(await resolve(started, { nowMs: NOW + FORECAST_SOURCE_CACHE_MS })).toMatchObject({ source: 'local' });
    expect(started).toHaveBeenCalledTimes(2);

    // The positive answer is cached as well.
    const stopped = supervisor({ addon: okInfo({ state: 'stopped' }) });
    expect(await resolve(stopped, { nowMs: NOW + FORECAST_SOURCE_CACHE_MS + 1 })).toMatchObject({ source: 'local' });
    expect(stopped).not.toHaveBeenCalled();

    // Another spelling of the setting, or a clock stepped back, asks again.
    expect(await resolve(stopped, { forecastUrl: 'AUTO', nowMs: NOW + FORECAST_SOURCE_CACHE_MS + 1 })).toMatchObject({ source: 'public' });
    expect(await resolve(started, { forecastUrl: 'AUTO', nowMs: NOW })).toMatchObject({ source: 'local' });
  });

  it('defaults to fetch with a 5 s deadline', async () => {
    expect(SUPERVISOR_TIMEOUT_MS).toBe(5_000);
    const fetchMock = vi.fn(async (url) => (url.endsWith('/self/info')
      ? okInfo({ slug: '601a68d0_optivolt' })
      : okInfo({ state: 'started', hostname: '601a68d0-epexpredictor' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await resolveForecastSource('auto', { nowMs: NOW, env: ENV })).toEqual({ url: 'http://601a68d0-epexpredictor', source: 'local' });
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
