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

  it('converts WebSocket URL to HTTP correctly', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ state: 'off', attributes: {} }));

    await fetchEvLoadFromHA(makeSettings());

    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toMatch(/^http:\/\//);
    expect(calledUrl).not.toMatch(/^ws:\/\//);
    expect(calledUrl).toContain('homeassistant.local:8123');
  });
});
