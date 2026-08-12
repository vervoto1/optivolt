import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../../api/app.ts';
import essRouter from '../../api/routes/ess.ts';
import { get, post } from './helpers/express-test-client.js';
import { HttpError } from '../../api/http-errors.ts';

vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/ess-service.ts');

import { loadSettings } from '../../api/services/settings-store.ts';
import { getEssState, getEssHistory, calibrateBatterySoc } from '../../api/services/ess-service.ts';

const mockSettings = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  essConfig: { enabled: true, historyWindowHours: 24, historyPeriod: '5minute', refreshIntervalSeconds: 30, batteries: [] },
};

beforeEach(() => {
  vi.resetAllMocks();
  loadSettings.mockResolvedValue(mockSettings);
});

describe('GET /ess/state', () => {
  it('returns the live snapshot shape', async () => {
    getEssState.mockResolvedValue({
      batteries: [{ name: 'Basen Green', cells: [], temperatures: [], scalars: {}, balancing: null, extras: [] }],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 123,
    });

    const res = await get(app, '/ess/state');

    expect(res.status).toBe(200);
    expect(res.body.batteries).toHaveLength(1);
    expect(res.body.batteries[0].name).toBe('Basen Green');
    expect(getEssState).toHaveBeenCalledWith(mockSettings);
  });

  it('propagates a 422 when HA is unconfigured / ESS disabled', async () => {
    getEssState.mockRejectedValue(new HttpError(422, 'Home Assistant is not configured'));

    const res = await get(app, '/ess/state');

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Home Assistant');
  });
});

describe('POST /ess/battery/:index/soc-calibration', () => {
  // POSTs go through the router directly (like the other POST route tests):
  // the helper's own express.json has already consumed the body stream, so
  // routing through `app` would double-parse it.
  it('passes the battery index and body SoC through to the service', async () => {
    calibrateBatterySoc.mockResolvedValue({ entity: 'number.bms0_soc_calibration', value: 85 });

    const res = await post(essRouter, '/battery/1/soc-calibration', { socPercent: 85 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entity: 'number.bms0_soc_calibration', value: 85 });
    expect(calibrateBatterySoc).toHaveBeenCalledWith(mockSettings, 1, 85);
  });

  it('tolerates a missing body by passing socPercent as undefined', async () => {
    calibrateBatterySoc.mockResolvedValue({ entity: 'number.x', value: 50 });
    const res = await post(essRouter, '/battery/0/soc-calibration');
    expect(res.status).toBe(200);
    expect(calibrateBatterySoc).toHaveBeenCalledWith(mockSettings, 0, undefined);
  });

  it.each(['abc', '-1', '1.5'])('rejects the non-index path segment %s with 400', async (index) => {
    const res = await post(essRouter, `/battery/${index}/soc-calibration`, { socPercent: 50 });
    expect(res.status).toBe(400);
    expect(calibrateBatterySoc).not.toHaveBeenCalled();
  });

  it('propagates service HttpErrors (e.g. 422 unconfigured entity)', async () => {
    calibrateBatterySoc.mockRejectedValue(new HttpError(422, 'Battery "B0" has no SoC calibration entity configured'));
    const res = await post(essRouter, '/battery/0/soc-calibration', { socPercent: 50 });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('no SoC calibration entity');
  });
});

describe('GET /ess/history', () => {
  beforeEach(() => {
    getEssHistory.mockResolvedValue({
      hours: 24,
      period: '5minute',
      series: { 'sensor.cell_1': { source: 'statistics', points: [{ t: 1, v: 3.3 }] } },
      noStatistics: ['sensor.cell_2'],
      fetchedAtMs: 123,
    });
  });

  it('returns the history shape including which entities lack statistics', async () => {
    const res = await get(app, '/ess/history');
    expect(res.status).toBe(200);
    expect(res.body.series['sensor.cell_1'].source).toBe('statistics');
    expect(res.body.noStatistics).toContain('sensor.cell_2');
  });

  it('defaults hours/period from essConfig when no query is given', async () => {
    await get(app, '/ess/history');
    expect(getEssHistory).toHaveBeenCalledWith(mockSettings, { hours: 24, period: '5minute' });
  });

  it('falls back to the built-in 24h/5minute defaults when essConfig is absent', async () => {
    // essConfig?.historyWindowHours / historyPeriod resolve to undefined, so the
    // `?? 24` and `?? '5minute'` literal defaults must apply.
    const noEss = { ...mockSettings, essConfig: undefined };
    loadSettings.mockResolvedValue(noEss);
    await get(app, '/ess/history');
    expect(getEssHistory).toHaveBeenCalledWith(noEss, { hours: 24, period: '5minute' });
  });

  it('uses essConfig defaults that differ from the built-in literals', async () => {
    // Distinct values prove the essConfig branch (not the `??` literal) is taken.
    const customEss = { ...mockSettings, essConfig: { ...mockSettings.essConfig, historyWindowHours: 12, historyPeriod: 'hour' } };
    loadSettings.mockResolvedValue(customEss);
    await get(app, '/ess/history');
    expect(getEssHistory).toHaveBeenCalledWith(customEss, { hours: 12, period: 'hour' });
  });

  it('clamps an out-of-range hours value to 168', async () => {
    await get(app, '/ess/history?hours=9999');
    expect(getEssHistory).toHaveBeenCalledWith(mockSettings, { hours: 168, period: '5minute' });
  });

  it('floors hours to a minimum of 1', async () => {
    await get(app, '/ess/history?hours=0');
    expect(getEssHistory).toHaveBeenCalledWith(mockSettings, { hours: 1, period: '5minute' });
  });

  it('falls back to the default period for an invalid period', async () => {
    await get(app, '/ess/history?period=weekly');
    expect(getEssHistory).toHaveBeenCalledWith(mockSettings, { hours: 24, period: '5minute' });
  });

  it('accepts a valid hours + period query', async () => {
    await get(app, '/ess/history?hours=6&period=hour');
    expect(getEssHistory).toHaveBeenCalledWith(mockSettings, { hours: 6, period: 'hour' });
  });

  it('propagates a 422 when HA is unconfigured', async () => {
    getEssHistory.mockRejectedValue(new HttpError(422, 'Home Assistant is not configured'));
    const res = await get(app, '/ess/history');
    expect(res.status).toBe(422);
  });
});
