import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchEvLoadFromHA } from '../../../api/services/ha-ev-service.ts';

const makeSettings = (overrides = {}) => ({
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  evConfig: {
    enabled: true,
    chargerPower_W: 11000,
    disableDischargeWhileCharging: true,
    scheduleSensor: 'sensor.ev_smart_charging_charging',
    scheduleAttribute: 'charging_schedule',
    connectedSwitch: 'switch.ev_smart_charging_ev_connected',
  },
  ...overrides,
});

const CHARGING_SCHEDULE = [
  { start: '2026-03-17T00:00:00+01:00', end: '2026-03-17T00:15:00+01:00', value: 0 },
  { start: '2026-03-17T00:15:00+01:00', end: '2026-03-17T00:30:00+01:00', value: 1 },
  { start: '2026-03-17T00:30:00+01:00', end: '2026-03-17T00:45:00+01:00', value: 1 },
];

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

describe('fetchEvLoadFromHA', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('returns null when evConfig is not enabled', async () => {
    const settings = makeSettings({ evConfig: { enabled: false } });
    const result = await fetchEvLoadFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when evConfig is missing', async () => {
    const settings = makeSettings({ evConfig: undefined });
    const result = await fetchEvLoadFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when EV is not connected', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({ state: 'off', attributes: {} }),
    );
    const result = await fetchEvLoadFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('returns TimeSeries when EV is connected and schedule exists', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ state: 'on', attributes: {} }))
      .mockResolvedValueOnce(
        makeOkResponse({
          state: 'on',
          attributes: { charging_schedule: CHARGING_SCHEDULE },
        }),
      );

    const result = await fetchEvLoadFromHA(makeSettings());

    expect(result).not.toBeNull();
    expect(result.step).toBe(15);
    expect(result.values).toEqual([0, 11000, 11000]);
    expect(typeof result.start).toBe('string');
  });

  it('returns null on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network failure'));
    const result = await fetchEvLoadFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('returns null when charging_schedule attribute is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ state: 'on', attributes: {} }))
      .mockResolvedValueOnce(makeOkResponse({ state: 'on', attributes: {} }));

    const result = await fetchEvLoadFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('skips connected check when alwaysApplySchedule is true', async () => {
    // Only one fetch call (schedule sensor) — connected switch is NOT called
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: 'on',
        attributes: { charging_schedule: CHARGING_SCHEDULE },
      }),
    );

    const settings = makeSettings({
      evConfig: {
        enabled: true,
        chargerPower_W: 11000,
        disableDischargeWhileCharging: true,
        scheduleSensor: 'sensor.ev_smart_charging_charging',
        scheduleAttribute: 'charging_schedule',
        connectedSwitch: 'switch.ev_smart_charging_ev_connected',
        alwaysApplySchedule: true,
      },
    });

    const result = await fetchEvLoadFromHA(settings);

    expect(result).not.toBeNull();
    expect(result.values).toEqual([0, 11000, 11000]);
    // Only 1 fetch call (schedule sensor), NOT 2 (no connected switch check)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('sensor.ev_smart_charging_charging');
  });

  it('uses default charging_schedule attribute when scheduleAttribute is not set', async () => {
    // Line 42: evConfig.scheduleAttribute || 'charging_schedule' — right side taken
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ state: 'on', attributes: {} })) // connected switch
      .mockResolvedValueOnce(
        makeOkResponse({
          state: 'on',
          attributes: { charging_schedule: CHARGING_SCHEDULE }, // default attribute name
        }),
      );

    const settings = makeSettings({
      evConfig: {
        enabled: true,
        chargerPower_W: 11000,
        scheduleSensor: 'sensor.ev_smart_charging_charging',
        connectedSwitch: 'switch.ev_smart_charging_ev_connected',
        // scheduleAttribute is omitted → defaults to 'charging_schedule'
      },
    });
    const result = await fetchEvLoadFromHA(settings);

    expect(result).not.toBeNull();
    expect(result.values).toEqual([0, 11000, 11000]);
  });

  it('returns null when haToken is empty and SUPERVISOR_TOKEN is not set', async () => {
    const settings = makeSettings({ haToken: '' });
    delete process.env.SUPERVISOR_TOKEN;
    const result = await fetchEvLoadFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when HA API returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' }),
    });
    const result = await fetchEvLoadFromHA(makeSettings());
    // fetchEvLoadFromHA catches errors and returns null
    expect(result).toBeNull();
  });

  it('converts WebSocket URL to HTTP correctly', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ state: 'off', attributes: {} }));

    await fetchEvLoadFromHA(makeSettings());

    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toMatch(/^http:\/\//);
    expect(calledUrl).not.toMatch(/^ws:\/\//);
    expect(calledUrl).toContain('homeassistant.local:8123');
  });

  it('uses supervisor proxy when SUPERVISOR_TOKEN is set', async () => {
    process.env.SUPERVISOR_TOKEN = 'test-supervisor-token';
    try {
      // Mock connected switch returns 'on', schedule sensor returns schedule
      fetchMock
        .mockResolvedValueOnce(makeOkResponse({ state: 'on', attributes: {} }))
        .mockResolvedValueOnce(
          makeOkResponse({
            state: 'on',
            attributes: { charging_schedule: CHARGING_SCHEDULE },
          }),
        );

      await fetchEvLoadFromHA(makeSettings());

      // Should use supervisor URL, not homeassistant.local
      const calledUrl = fetchMock.mock.calls[0][0];
      expect(calledUrl).toContain('supervisor/core');
      expect(calledUrl).not.toContain('homeassistant.local');

      // Should use SUPERVISOR_TOKEN, not the settings token
      const authHeader = fetchMock.mock.calls[0][1].headers.Authorization;
      expect(authHeader).toBe('Bearer test-supervisor-token');
    } finally {
      delete process.env.SUPERVISOR_TOKEN;
    }
  });
});
