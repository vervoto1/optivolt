import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VRMClient } from '../../lib/vrm-api.ts';

// ---------------------------------------------------------------------------
// Helper: build a minimal fetch mock that returns JSON
// ---------------------------------------------------------------------------
function makeFetch(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe('VRMClient — constructor', () => {
  it('sets default baseURL with /v2 suffix', () => {
    const client = new VRMClient();
    expect(client.baseURL).toBe('https://vrmapi.victronenergy.com/v2');
  });

  it('strips trailing slashes from custom baseURL', () => {
    const client = new VRMClient({ baseURL: 'https://myvrm.example.com///' });
    expect(client.baseURL).toBe('https://myvrm.example.com/v2');
  });

  it('stores installationId and token', () => {
    const client = new VRMClient({ installationId: '12345', token: 'tok' });
    expect(client.installationId).toBe('12345');
    expect(client.token).toBe('tok');
  });

  it('defaults empty installationId and token', () => {
    const client = new VRMClient();
    expect(client.installationId).toBe('');
    expect(client.token).toBe('');
  });
});

describe('VRMClient — setAuth / setBaseURL', () => {
  it('updates installationId and token via setAuth', () => {
    const client = new VRMClient();
    client.setAuth({ installationId: '999', token: 'new-tok' });
    expect(client.installationId).toBe('999');
    expect(client.token).toBe('new-tok');
  });

  it('leaves fields unchanged when setAuth receives null', () => {
    const client = new VRMClient({ installationId: 'orig', token: 'orig-tok' });
    client.setAuth({ installationId: null, token: null });
    expect(client.installationId).toBe('orig');
    expect(client.token).toBe('orig-tok');
  });

  it('updates baseURL via setBaseURL', () => {
    const client = new VRMClient();
    client.setBaseURL('https://other.api.com');
    expect(client.baseURL).toBe('https://other.api.com/v2');
  });

  it('setBaseURL with empty string falls back to /v2', () => {
    const client = new VRMClient();
    client.setBaseURL('');
    expect(client.baseURL).toBe('/v2');
  });
});

describe('VRMClient — _fetch', () => {
  it('throws when token is missing', async () => {
    const client = new VRMClient({ installationId: '123' });
    await expect(client._fetch('/installations/123/stats')).rejects.toThrow('Missing VRM API token');
  });

  it('sends X-Authorization header with token', async () => {
    const client = new VRMClient({ installationId: '123', token: 'my-token' });
    const mockFetch = makeFetch({ success: true, data: {} });
    vi.stubGlobal('fetch', mockFetch);

    await client._fetch('/installations/123/dynamic-ess-settings');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/installations/123/dynamic-ess-settings'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Authorization': 'Token my-token' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('throws on non-ok response', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch('Not Found', { ok: false, status: 404, statusText: 'Not Found' }));

    await expect(client._fetch('/bad-path')).rejects.toThrow('VRM 404');
    vi.unstubAllGlobals();
  });

  it('appends query parameters to the URL', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const mockFetch = makeFetch({ success: true, records: {} });
    vi.stubGlobal('fetch', mockFetch);

    await client._fetch('/installations/123/stats', { query: { type: 'forecast', interval: '15mins' } });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('type=forecast');
    expect(calledUrl).toContain('interval=15mins');
    vi.unstubAllGlobals();
  });

  it('skips null/undefined query params', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const mockFetch = makeFetch({ success: true });
    vi.stubGlobal('fetch', mockFetch);

    await client._fetch('/path', { query: { a: 'val', b: null, c: undefined } });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('a=val');
    expect(calledUrl).not.toContain('b=');
    expect(calledUrl).not.toContain('c=');
    vi.unstubAllGlobals();
  });

  it('sends Content-Type and serialized body for POST requests with a body', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const mockFetch = makeFetch({ success: true });
    vi.stubGlobal('fetch', mockFetch);

    const body = { mode: 4 };
    await client._fetch('/installations/123/dynamic-ess-settings', { method: 'PUT', body });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(body));
    vi.unstubAllGlobals();
  });

  it('accepts path without leading slash', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const mockFetch = makeFetch({ success: true });
    vi.stubGlobal('fetch', mockFetch);

    await client._fetch('installations/123/dynamic-ess-settings');

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('/installations/123/dynamic-ess-settings');
    vi.unstubAllGlobals();
  });

  it('uses "Request failed" fallback when res.text() throws on non-ok response', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => { throw new Error('body read error'); },
    }));

    await expect(client._fetch('/bad')).rejects.toThrow('Request failed');
    vi.unstubAllGlobals();
  });
});

describe('VRMClient — fetchDynamicEssSettings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when installationId is missing', async () => {
    const client = new VRMClient({ token: 'tok' });
    await expect(client.fetchDynamicEssSettings()).rejects.toThrow('Missing installationId');
  });

  it('throws when API returns success=false', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({ success: false }));
    await expect(client.fetchDynamicEssSettings()).rejects.toThrow('success=false');
  });

  it('normalizes kW values to W', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      data: {
        batteryCapacity: 10,       // kWh
        dischargePower: 5,         // kW
        chargePower: 4,            // kW
        maxPowerFromGrid: 3,       // kW
        maxPowerToGrid: 2,         // kW
        batteryCosts: 0.05,        // €/kWh
      },
    }));

    const result = await client.fetchDynamicEssSettings();

    expect(result.batteryCapacity_kWh).toBe(10);
    expect(result.batteryCapacity_Wh).toBe(10000);
    expect(result.dischargePower_W).toBe(5000);
    expect(result.chargePower_W).toBe(4000);
    expect(result.maxPowerFromGrid_W).toBe(3000);
    expect(result.maxPowerToGrid_W).toBe(2000);
    expect(result.batteryCosts_eur_per_kWh).toBeCloseTo(0.05);
    expect(result.batteryCosts_cents_per_kWh).toBeCloseTo(5);
  });

  it('parses flags correctly', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      data: {
        isOn: true,
        isGreenModeOn: 1,
        isPeriodicFullChargeOn: false,
        alwaysApplyBatteryFlowRestriction: '1',
      },
    }));

    const result = await client.fetchDynamicEssSettings();

    expect(result.flags.isOn).toBe(true);
    expect(result.flags.isGreenModeOn).toBe(true);
    expect(result.flags.isPeriodicFullChargeOn).toBe(false);
    expect(result.flags.alwaysApplyBatteryFlowRestriction).toBe(true);
  });

  it('handles missing data field by defaulting to empty object', async () => {
    // data.data is undefined — the `|| {}` fallback path
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({ success: true })); // no `data` key

    const result = await client.fetchDynamicEssSettings();
    expect(result.batteryCapacity_kWh).toBe(0);
    expect(result.gridSell).toBe(false);
  });

  it('boolish: numeric 1 is truthy, string "1" is truthy, other values are false', async () => {
    // Exercise the v === 1 and v === '1' branches of boolish()
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      data: {
        isOn: 1,            // numeric 1 → true
        isGreenModeOn: '1', // string '1' → true
        isPeriodicFullChargeOn: 'yes', // anything else → false
        alwaysApplyBatteryFlowRestriction: 0, // 0 → false
      },
    }));

    const result = await client.fetchDynamicEssSettings();
    expect(result.flags.isOn).toBe(true);
    expect(result.flags.isGreenModeOn).toBe(true);
    expect(result.flags.isPeriodicFullChargeOn).toBe(false);
    expect(result.flags.alwaysApplyBatteryFlowRestriction).toBe(false);
  });

  it('limits are null when VRM fields are zero/missing', async () => {
    // safeMul(0, 1000) = 0, and 0 || null = null for the limits fields
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      data: { gridExportLimit: 0, gridImportLimit: 0, batteryChargeLimit: 0, batteryDischargeLimit: 0 },
    }));

    const result = await client.fetchDynamicEssSettings();
    expect(result.limits.gridExportLimit_W).toBeNull();
    expect(result.limits.gridImportLimit_W).toBeNull();
    expect(result.limits.batteryChargeLimit_W).toBeNull();
    expect(result.limits.batteryDischargeLimit_W).toBeNull();
  });

  it('buyPriceSamplingRate_mins is null when field is absent', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({ success: true, data: {} }));

    const result = await client.fetchDynamicEssSettings();
    expect(result.buyPriceSamplingRate_mins).toBeNull();
    expect(result.sellPriceSamplingRate_mins).toBeNull();
  });
});

describe('VRMClient — fetchForecasts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when installationId is missing', async () => {
    const client = new VRMClient({ token: 'tok' });
    await expect(client.fetchForecasts({ startSec: 0, endSec: 3600 })).rejects.toThrow('Missing installationId');
  });

  it('throws when API returns success=false', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({ success: false }));
    await expect(client.fetchForecasts({ startSec: 0, endSec: 3600 })).rejects.toThrow('success=false');
  });

  it('uses default window when no params are passed (ensureWindow fallback)', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const now = new Date('2024-06-01T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      records: {
        vrm_consumption_fc: [[now.getTime(), 500]],
        solar_yield_forecast: [[now.getTime(), 200]],
      },
    }));

    const result = await client.fetchForecasts();
    // Should succeed without explicit window — ensureWindow uses windowOptimizationHorizon()
    expect(result.timestamps.length).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('load_W');
    expect(result).toHaveProperty('pv_W');
    vi.useRealTimers();
  });

  it('returns load_W and pv_W arrays matching the timeline length', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T11:00:00Z').getTime(); // 4 slots
    const startSec = startMs / 1000;
    const endSec = endMs / 1000;

    // VRM returns load value at the hour mark
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      records: {
        vrm_consumption_fc: [[startMs, 500]],
        solar_yield_forecast: [[startMs, 1000]],
      },
    }));

    const result = await client.fetchForecasts({ startMs, endMs, startSec, endSec });

    expect(result.load_W).toHaveLength(4);
    expect(result.pv_W).toHaveLength(4);
    expect(result.step_minutes).toBe(15);
    expect(result.timestamps).toHaveLength(4);
  });

  it('fills all four quarter-hour slots with the hourly W value', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T11:00:00Z').getTime();

    vi.stubGlobal('fetch', makeFetch({
      success: true,
      records: {
        vrm_consumption_fc: [[startMs, 800]],
        solar_yield_forecast: [],
      },
    }));

    const result = await client.fetchForecasts({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    // All 4 slots in the 10:00 hour should be filled with 800
    expect(result.load_W).toEqual([800, 800, 800, 800]);
    expect(result.pv_W).toEqual([0, 0, 0, 0]);
  });

  it('returns timestamps_iso as ISO strings', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime(); // 1 slot

    vi.stubGlobal('fetch', makeFetch({ success: true, records: {} }));

    const result = await client.fetchForecasts({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    expect(result.timestamps_iso[0]).toBe('2024-06-01T10:00:00.000Z');
  });

  it('handles missing records field by defaulting to empty object', async () => {
    // data.records is undefined — the `|| {}` fallback path
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime();
    vi.stubGlobal('fetch', makeFetch({ success: true })); // no `records` key

    const result = await client.fetchForecasts({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    expect(result.load_W).toEqual([0]);
    expect(result.pv_W).toEqual([0]);
  });

  it('accepts window via startSec/endSec (ensureWindow sec path)', async () => {
    // Exercises the startSec/endSec branch in ensureWindow
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime();
    vi.stubGlobal('fetch', makeFetch({ success: true, records: {} }));

    const result = await client.fetchForecasts({ startSec: startMs / 1000, endSec: endMs / 1000 });
    expect(result.timestamps).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('ignores non-finite values in forecast series', async () => {
    // toSeries skips entries where t or v is not finite
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime();
    vi.stubGlobal('fetch', makeFetch({
      success: true,
      records: {
        vrm_consumption_fc: [[null, 500], [NaN, 300], [startMs, NaN], [startMs, 800]],
        solar_yield_forecast: [],
      },
    }));

    const result = await client.fetchForecasts({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    // Only the valid [startMs, 800] entry survives; NaN/null entries are skipped
    expect(result.load_W[0]).toBe(800);
    vi.unstubAllGlobals();
  });
});

describe('VRMClient — fetchPrices', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when installationId is missing', async () => {
    const client = new VRMClient({ token: 'tok' });
    await expect(client.fetchPrices({ startSec: 0, endSec: 3600 })).rejects.toThrow('Missing installationId');
  });

  it('throws when API returns success=false', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    vi.stubGlobal('fetch', makeFetch({ success: false }));
    await expect(client.fetchPrices({ startSec: 0, endSec: 3600 })).rejects.toThrow('success=false');
  });

  it('converts eur/kWh to cents/kWh', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime(); // 1 slot

    vi.stubGlobal('fetch', makeFetch({
      success: true,
      records: {
        deGb: [[startMs, 0.10]],   // €0.10/kWh = 10 c/kWh
        deGs: [[startMs, 0.05]],   // €0.05/kWh = 5 c/kWh
      },
    }));

    const result = await client.fetchPrices({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });

    expect(result.importPrice_eur_per_kwh[0]).toBeCloseTo(0.10);
    expect(result.importPrice_cents_per_kwh[0]).toBeCloseTo(10);
    expect(result.exportPrice_eur_per_kwh[0]).toBeCloseTo(0.05);
    expect(result.exportPrice_cents_per_kwh[0]).toBeCloseTo(5);
  });

  it('fills missing slots with 0 when records are empty', async () => {
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T11:00:00Z').getTime(); // 4 slots

    vi.stubGlobal('fetch', makeFetch({ success: true, records: {} }));

    const result = await client.fetchPrices({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    expect(result.importPrice_eur_per_kwh).toEqual([0, 0, 0, 0]);
    expect(result.exportPrice_eur_per_kwh).toEqual([0, 0, 0, 0]);
  });

  it('handles missing records field by defaulting to empty object', async () => {
    // data.records is undefined — the `|| {}` fallback path
    const client = new VRMClient({ installationId: '123', token: 'tok' });
    const startMs = new Date('2024-06-01T10:00:00Z').getTime();
    const endMs = new Date('2024-06-01T10:15:00Z').getTime();
    vi.stubGlobal('fetch', makeFetch({ success: true })); // no `records` key

    const result = await client.fetchPrices({ startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
    expect(result.importPrice_eur_per_kwh).toEqual([0]);
    expect(result.exportPrice_eur_per_kwh).toEqual([0]);
  });
});

describe('VRMClient — static helpers', () => {
  it('buildTimeline15Min produces slots at 15-min intervals', () => {
    const startMs = new Date('2024-01-01T10:00:00Z').getTime();
    const endMs = new Date('2024-01-01T11:00:00Z').getTime();
    const timeline = VRMClient.buildTimeline15Min(startMs, endMs);
    expect(timeline).toHaveLength(4);
    expect(timeline[1] - timeline[0]).toBe(15 * 60 * 1000);
  });

  it('buildTimeline15Min returns empty array when start >= end', () => {
    const ms = new Date('2024-01-01T10:00:00Z').getTime();
    expect(VRMClient.buildTimeline15Min(ms, ms)).toEqual([]);
  });

  it('toISO converts ms to ISO string', () => {
    const ms = new Date('2024-06-01T10:00:00.000Z').getTime();
    expect(VRMClient.toISO(ms)).toBe('2024-06-01T10:00:00.000Z');
  });

  it('windowOptimizationHorizon returns object with startMs, endMs, startSec, endSec', () => {
    const win = VRMClient.windowOptimizationHorizon();
    expect(win).toHaveProperty('startMs');
    expect(win).toHaveProperty('endMs');
    expect(win).toHaveProperty('startSec');
    expect(win).toHaveProperty('endSec');
    expect(win.endMs).toBeGreaterThan(win.startMs);
  });

  it('windowOptimizationHorizon startSec and endSec are integer seconds derived from ms', () => {
    const win = VRMClient.windowOptimizationHorizon();
    expect(win.startSec).toBe(Math.floor(win.startMs / 1000));
    expect(win.endSec).toBe(Math.floor(win.endMs / 1000));
  });

  it('windowOptimizationHorizon uses dayOffset=2 when hour >= 13', () => {
    // Fake the clock to 14:00 local to exercise the hr >= 13 branch
    const fakeNow = new Date();
    fakeNow.setHours(14, 0, 0, 0);
    vi.setSystemTime(fakeNow);

    const win = VRMClient.windowOptimizationHorizon();
    // end should be at least 24h after start (dayOffset=2 pushes end to midnight of day+2)
    expect(win.endMs - win.startMs).toBeGreaterThan(24 * 60 * 60 * 1000);

    vi.useRealTimers();
  });

  it('windowOptimizationHorizon uses dayOffset=1 when hour < 13', () => {
    // Fake the clock to 10:00 local to exercise the hr < 13 branch
    const fakeNow = new Date();
    fakeNow.setHours(10, 0, 0, 0);
    vi.setSystemTime(fakeNow);

    const win = VRMClient.windowOptimizationHorizon();
    // end should be at most 24h after start (dayOffset=1)
    expect(win.endMs - win.startMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    vi.useRealTimers();
  });
});
