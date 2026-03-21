import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPricesFromHA } from '../../../api/services/ha-price-service.ts';

const makeSettings = (overrides = {}) => ({
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  haPriceConfig: {
    sensor: 'sensor.gespot_hourly_average_price_nl',
    todayAttribute: 'today_hourly_prices',
    tomorrowAttribute: 'tomorrow_hourly_prices',
    timeKey: 'time',
    valueKey: 'value',
    valueMultiplier: 100,
    importEqualsExport: true,
    priceInterval: 60,
  },
  ...overrides,
});

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

/** Generate N hourly price slots starting from a base hour offset. */
function makeHourlyPrices(count, baseDate = '2026-03-17', startHour = 0, baseValue = 0.10) {
  return Array.from({ length: count }, (_, i) => ({
    time: `${baseDate}T${String(startHour + i).padStart(2, '0')}:00:00+01:00`,
    value: baseValue + i * 0.01,
  }));
}

describe('fetchPricesFromHA', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('returns null when haPriceConfig sensor is empty', async () => {
    const settings = makeSettings({
      haPriceConfig: { ...makeSettings().haPriceConfig, sensor: '' },
    });
    const result = await fetchPricesFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when haToken is empty', async () => {
    const settings = makeSettings({ haToken: '' });
    const result = await fetchPricesFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when haPriceConfig is missing', async () => {
    const settings = makeSettings({ haPriceConfig: undefined });
    const result = await fetchPricesFromHA(settings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('converts hourly prices to 15-min slots', async () => {
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
      { time: '2026-03-17T01:00:00+01:00', value: 0.30 },
      { time: '2026-03-17T02:00:00+01:00', value: 0.20 },
    ];

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());

    expect(result).not.toBeNull();
    expect(result.importPrice.step).toBe(15);
    expect(result.importPrice.values).toEqual([
      25, 25, 25, 25,
      30, 30, 30, 30,
      20, 20, 20, 20,
    ]);
  });

  it('passes through 15-min prices without expansion', async () => {
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.10 },
      { time: '2026-03-17T00:15:00+01:00', value: 0.20 },
      { time: '2026-03-17T00:30:00+01:00', value: 0.30 },
      { time: '2026-03-17T00:45:00+01:00', value: 0.40 },
    ];

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.10',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const settings = makeSettings({
      haPriceConfig: { ...makeSettings().haPriceConfig, priceInterval: 15 },
    });
    const result = await fetchPricesFromHA(settings);

    expect(result).not.toBeNull();
    expect(result.importPrice.values).toHaveLength(4);
    expect(result.importPrice.values).toEqual([10, 20, 30, 40]);
  });

  it('sets exportPrice equal to importPrice when importEqualsExport is true', async () => {
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
      { time: '2026-03-17T01:00:00+01:00', value: 0.30 },
    ];

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());

    expect(result.importPrice.values).toEqual(result.exportPrice.values);
  });

  it('sets exportPrice to zeros when importEqualsExport is false', async () => {
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
      { time: '2026-03-17T01:00:00+01:00', value: 0.30 },
    ];

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const settings = makeSettings({
      haPriceConfig: { ...makeSettings().haPriceConfig, importEqualsExport: false },
    });
    const result = await fetchPricesFromHA(settings);

    expect(result.exportPrice.values).toEqual(new Array(8).fill(0));
  });

  it('handles missing tomorrow prices gracefully', async () => {
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
      { time: '2026-03-17T01:00:00+01:00', value: 0.30 },
    ];

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: { today_hourly_prices: todayPrices },
        // no tomorrow_hourly_prices
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());

    expect(result).not.toBeNull();
    expect(result.importPrice.values).toHaveLength(8); // 2 hours * 4 slots
  });

  it('combines today + tomorrow prices', async () => {
    const todayPrices = makeHourlyPrices(24, '2026-03-17', 0, 0.10);
    const tomorrowPrices = makeHourlyPrices(24, '2026-03-18', 0, 0.20);

    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.10',
        attributes: {
          today_hourly_prices: todayPrices,
          tomorrow_hourly_prices: tomorrowPrices,
        },
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());

    expect(result).not.toBeNull();
    expect(result.importPrice.values).toHaveLength((24 + 24) * 4);
  });

  it('returns null when sensor entity has no attributes', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: null,
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('returns null when HA API returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' }),
    });

    const result = await fetchPricesFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network failure'));
    const result = await fetchPricesFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('returns null when today prices attribute is empty array', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0',
        attributes: { today_hourly_prices: [] },
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());
    expect(result).toBeNull();
  });

  it('uses default attribute names when config attributes are omitted', async () => {
    // Lines 36-41: the || right-hand side is taken when config properties are absent
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
    ];
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0.25',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const settings = makeSettings({
      haPriceConfig: {
        sensor: 'sensor.gespot_hourly_average_price_nl',
        // todayAttribute, tomorrowAttribute, timeKey, valueKey, valueMultiplier, priceInterval all omitted
      },
    });
    const result = await fetchPricesFromHA(settings);

    expect(result).not.toBeNull();
    // valueMultiplier defaults to 100, priceInterval defaults to 60 → 4 slots
    expect(result.importPrice.values).toHaveLength(4);
    // 0.25 * 100 = 25
    expect(result.importPrice.values[0]).toBe(25);
  });

  it('substitutes 0 for non-finite price values', async () => {
    // Line 68: Number.isFinite(rawValue) ? rawValue : 0
    const todayPrices = [
      { time: '2026-03-17T00:00:00+01:00', value: 'not-a-number' },
      { time: '2026-03-17T01:00:00+01:00', value: 0.20 },
    ];
    fetchMock.mockResolvedValueOnce(
      makeOkResponse({
        state: '0',
        attributes: { today_hourly_prices: todayPrices },
      }),
    );

    const result = await fetchPricesFromHA(makeSettings());

    expect(result).not.toBeNull();
    // First slot: NaN * 100 → not finite → 0
    expect(result.importPrice.values[0]).toBe(0);
    expect(result.importPrice.values[1]).toBe(0);
    expect(result.importPrice.values[2]).toBe(0);
    expect(result.importPrice.values[3]).toBe(0);
    // Second slot: 0.20 * 100 = 20
    expect(result.importPrice.values[4]).toBe(20);
  });

  it('uses supervisor proxy when SUPERVISOR_TOKEN is set', async () => {
    process.env.SUPERVISOR_TOKEN = 'test-supervisor-token';
    try {
      const todayPrices = [
        { time: '2026-03-17T00:00:00+01:00', value: 0.25 },
      ];
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          state: 'on',
          attributes: { today_hourly_prices: todayPrices },
        }),
      );

      await fetchPricesFromHA(makeSettings());

      const calledUrl = fetchMock.mock.calls[0][0];
      expect(calledUrl).toContain('supervisor/core');
      expect(calledUrl).not.toContain('homeassistant.local');

      const authHeader = fetchMock.mock.calls[0][1].headers.Authorization;
      expect(authHeader).toBe('Bearer test-supervisor-token');
    } finally {
      delete process.env.SUPERVISOR_TOKEN;
    }
  });
});
