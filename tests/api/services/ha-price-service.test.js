import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPricesFromHA, parseStrictPrice, pricePointsToSeries } from '../../../api/services/ha-price-service.ts';

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

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * One local day of hourly prices shaped like GE-Spot's hourly-average sensor
 * (vitest pins TZ=Europe/Amsterdam): one entry per wall-clock hour that exists,
 * stamped with the first occurrence's offset (Python fold=0). The repeated
 * autumn 02:00 hour therefore appears once (24 entries for 25 hours) and the
 * skipped spring 02:00 hour not at all (23 entries). value = base + hour/100.
 */
function geSpotDay(date, baseValue) {
  const entries = [];
  for (let h = 0; h < 24; h++) {
    const local = new Date(`${date}T${pad2(h)}:00:00`);
    if (local.getHours() !== h) continue; // nonexistent (spring-forward) hour
    const offsetMin = -local.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const offset = `${sign}${pad2(Math.floor(Math.abs(offsetMin) / 60))}:${pad2(Math.abs(offsetMin) % 60)}`;
    entries.push({ time: `${date}T${pad2(h)}:00:00${offset}`, value: Math.round((baseValue + h / 100) * 1e4) / 1e4 });
  }
  return entries;
}

/** Read the 15-min slot value at an ISO instant (undefined when outside the series). */
function slotReader(series) {
  const startMs = Date.parse(series.start);
  return (iso) => series.values[(Date.parse(iso) - startMs) / (series.step * 60_000)];
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

  it('never turns a non-numeric price into 0 c/kWh', async () => {
    // A non-numeric value used to become 0 (free electricity). Now it is a
    // defect: the series uses the contiguous run around now and stops there.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-17T00:30:00+01:00'));
    try {
      const todayPrices = [
        { time: '2026-03-17T00:00:00+01:00', value: 0.20 },
        { time: '2026-03-17T01:00:00+01:00', value: 'not-a-number' },
        { time: '2026-03-17T02:00:00+01:00', value: 0.30 },
      ];
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          state: '0',
          attributes: { today_hourly_prices: todayPrices },
        }),
      );

      const result = await fetchPricesFromHA(makeSettings());

      expect(result).not.toBeNull();
      expect(result.importPrice.start).toBe('2026-03-16T23:00:00.000Z');
      expect(result.importPrice.values).toEqual([20, 20, 20, 20]);
      expect(result.exportPrice.values).toEqual([20, 20, 20, 20]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null (keeping previous prices) when the only valid run does not cover now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-17T01:30:00+01:00')); // inside the invalid hour
    try {
      const todayPrices = [
        { time: '2026-03-17T00:00:00+01:00', value: 0.20 },
        { time: '2026-03-17T01:00:00+01:00', value: null },
        { time: '2026-03-17T02:00:00+01:00', value: 0.30 },
      ];
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ state: '0', attributes: { today_hourly_prices: todayPrices } }),
      );

      expect(await fetchPricesFromHA(makeSettings())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('places 2026-10-25 GE-Spot prices by timestamp (fall-back day, merged 02:00 hour)', async () => {
    // Production sensor shape: GE-Spot's hourly average merges the two 02:00
    // hours of the 25-hour day into one +02:00 entry (24 entries). The prices
    // after it must stay on their own hours, not move one hour earlier.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T14:00:00+02:00'));
    try {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          state: '0.23',
          attributes: {
            today_hourly_prices: geSpotDay('2026-10-24', 0.10),
            tomorrow_hourly_prices: geSpotDay('2026-10-25', 0.50),
          },
        }),
      );

      const result = await fetchPricesFromHA(makeSettings());

      expect(result).not.toBeNull();
      expect(result.importPrice.start).toBe('2026-10-23T22:00:00.000Z');
      // 24 h on Oct 24 + 25 h on Oct 25, ending at local midnight (23:00Z).
      expect(result.importPrice.values).toHaveLength((24 + 25) * 4);
      const at = slotReader(result.importPrice);
      expect(at('2026-10-25T00:00:00Z')).toBeCloseTo(52); // 02:00 CEST
      expect(at('2026-10-25T01:00:00Z')).toBeCloseTo(52); // 02:00 CET, the merged hour
      expect(at('2026-10-25T02:00:00Z')).toBeCloseTo(53); // 03:00 CET
      expect(at('2026-10-25T16:00:00Z')).toBeCloseTo(67); // 17:00 CET
      expect(at('2026-10-25T22:45:00Z')).toBeCloseTo(73); // 23:45 CET, last slot
      expect(result.exportPrice.values).toEqual(result.importPrice.values);
    } finally {
      vi.useRealTimers();
    }
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

describe('parseStrictPrice', () => {
  it('accepts finite numbers and strictly numeric strings, keeping 0 and negatives', () => {
    expect(parseStrictPrice(0)).toBe(0);
    expect(parseStrictPrice(-0.05)).toBe(-0.05);
    expect(parseStrictPrice(0.2534)).toBe(0.2534);
    expect(parseStrictPrice('0.25')).toBe(0.25);
    expect(parseStrictPrice(' -0.05 ')).toBe(-0.05);
    expect(parseStrictPrice('1e-2')).toBe(0.01);
    expect(parseStrictPrice('.5')).toBe(0.5);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['blank string', '   '],
    ['false', false],
    ['true', true],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['non-numeric string', 'n/a'],
    ['partially numeric string', '0.25 EUR'],
    ['hex string', '0x10'],
    ['overflowing numeric string', '1e999'],
    ['array', []],
    ['object', {}],
  ])('rejects %s', (_label, raw) => {
    expect(parseStrictPrice(raw)).toBeNull();
  });
});

describe('pricePointsToSeries', () => {
  const opts = (overrides = {}) => ({
    timeKey: 'time',
    valueKey: 'value',
    multiplier: 100,
    interval: 60,
    nowMs: Date.parse('2026-10-24T14:00:00+02:00'),
    ...overrides,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a clean normal-day feed unchanged (single contiguous run)', () => {
    const series = pricePointsToSeries(geSpotDay('2026-10-24', 0.10), opts());
    expect(series.start).toBe('2026-10-23T22:00:00.000Z');
    expect(series.step).toBe(15);
    expect(series.values).toHaveLength(96);
    expect(series.values.slice(0, 5)).toEqual([10, 10, 10, 10, 11]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fills the merged repeated hour on 2026-10-25 and keeps Oct 26 on its own hours', () => {
    // Oct 25 (25 h, 24 entries) + Oct 26 (24 h), as on the afternoon of Oct 25.
    const points = [...geSpotDay('2026-10-25', 0.50), ...geSpotDay('2026-10-26', 0.10)];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-25T14:00:00+01:00') }));

    expect(series.start).toBe('2026-10-24T22:00:00.000Z');
    expect(series.values).toHaveLength((25 + 24) * 4);
    const at = slotReader(series);
    expect(at('2026-10-25T00:30:00Z')).toBeCloseTo(52); // 02:30 CEST
    expect(at('2026-10-25T01:30:00Z')).toBeCloseTo(52); // 02:30 CET
    expect(at('2026-10-25T02:00:00Z')).toBeCloseTo(53); // 03:00 CET
    expect(at('2026-10-25T23:00:00Z')).toBeCloseTo(10); // 00:00 CET Oct 26
    expect(at('2026-10-26T22:45:00Z')).toBeCloseTo(33); // 23:45 CET Oct 26
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fills a merged repeated hour on a 15-min feed with that wall-clock hour\'s prices', () => {
    // 15-min points 01:00..03:45 local on Oct 25 with the second 02:xx hour merged away.
    const points = [];
    for (const [h, off] of [[1, '+02:00'], [2, '+02:00'], [3, '+01:00']]) {
      for (const m of [0, 15, 30, 45]) {
        points.push({ time: `2026-10-25T${pad2(h)}:${pad2(m)}:00${off}`, value: h + m / 100 });
      }
    }
    const series = pricePointsToSeries(points, opts({
      interval: 15, multiplier: 1, nowMs: Date.parse('2026-10-24T23:30:00Z'),
    }));

    expect(series.start).toBe('2026-10-24T23:00:00.000Z');
    expect(series.values).toEqual([
      1, 1.15, 1.3, 1.45, // 01:xx CEST
      2, 2.15, 2.3, 2.45, // 02:xx CEST
      2, 2.15, 2.3, 2.45, // 02:xx CET (filled)
      3, 3.15, 3.3, 3.45, // 03:xx CET
    ]);
  });

  it('resolves bare wall-clock timestamps through the repeated hour by feed order', () => {
    // A generic sensor with naive local timestamps listing 02:00 twice (25 entries).
    const points = [];
    for (let h = 0; h < 24; h++) {
      points.push({ time: `2026-10-25T${pad2(h)}:00:00`, value: h / 100 });
      if (h === 2) points.push({ time: '2026-10-25T02:00:00', value: 0.99 });
    }
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-25T00:00:00Z') }));

    expect(series.start).toBe('2026-10-24T22:00:00.000Z');
    expect(series.values).toHaveLength(25 * 4);
    const at = slotReader(series);
    expect(at('2026-10-25T00:00:00Z')).toBe(2);  // 02:00 CEST
    expect(at('2026-10-25T01:00:00Z')).toBe(99); // 02:00 CET
    expect(at('2026-10-25T02:00:00Z')).toBe(3);  // 03:00 CET
  });

  it('fills a merged repeated hour in a bare wall-clock feed (24 entries)', () => {
    const points = Array.from({ length: 24 }, (_, h) => ({ time: `2026-10-25T${pad2(h)}:00:00`, value: h / 100 }));
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-25T00:00:00Z') }));

    expect(series.values).toHaveLength(25 * 4);
    const at = slotReader(series);
    expect(at('2026-10-25T01:00:00Z')).toBe(2);
    expect(at('2026-10-25T02:00:00Z')).toBe(3);
  });

  it('keeps the spring-forward day (23 entries) contiguous', () => {
    const points = [...geSpotDay('2026-03-29', 0.10), ...geSpotDay('2026-03-30', 0.40)];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-03-29T12:00:00+02:00') }));

    expect(series.start).toBe('2026-03-28T23:00:00.000Z');
    expect(series.values).toHaveLength((23 + 24) * 4);
    const at = slotReader(series);
    expect(at('2026-03-29T00:00:00Z')).toBeCloseTo(11); // 01:00 CET
    expect(at('2026-03-29T01:00:00Z')).toBeCloseTo(13); // 03:00 CEST
    expect(at('2026-03-29T21:45:00Z')).toBeCloseTo(33); // 23:45 CEST
    expect(at('2026-03-29T22:00:00Z')).toBeCloseTo(40); // 00:00 CEST Mar 30
    expect(console.warn).not.toHaveBeenCalled();
  });

  describe('a dropped hour on a normal day (07:00 missing)', () => {
    const points = geSpotDay('2026-10-06', 0.10).filter(p => !p.time.includes('T07:'));

    it('truncates at the gap when now is before it', () => {
      const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T05:30:00+02:00') }));
      expect(series.start).toBe('2026-10-05T22:00:00.000Z');
      expect(series.values).toHaveLength(7 * 4); // 00:00..06:59 local
      expect(slotReader(series)('2026-10-06T04:45:00Z')).toBeCloseTo(16);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('using the contiguous run around now'),
        expect.anything(),
      );
    });

    it('starts after the gap when now is past it, never shifting later hours', () => {
      const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T12:00:00+02:00') }));
      expect(series.start).toBe('2026-10-06T06:00:00.000Z'); // 08:00 local
      expect(series.values).toHaveLength(16 * 4);
      expect(slotReader(series)('2026-10-06T06:00:00Z')).toBeCloseTo(18);
      expect(slotReader(series)('2026-10-06T21:45:00Z')).toBeCloseTo(33);
    });

    it('returns null when now falls inside the gap', () => {
      expect(pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T07:30:00+02:00') }))).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('keeping previous prices'),
        expect.anything(),
      );
    });
  });

  it('stops at a duplicate or out-of-order timestamp', () => {
    const points = [
      { time: '2026-10-06T00:00:00+02:00', value: 0.1 },
      { time: '2026-10-06T01:00:00+02:00', value: 0.2 },
      { time: '2026-10-06T01:00:00+02:00', value: 0.9 },
      { time: '2026-10-06T02:00:00+02:00', value: 0.3 },
    ];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T00:30:00+02:00') }));
    expect(series.values).toEqual([10, 10, 10, 10, 20, 20, 20, 20]);

    const reversed = pricePointsToSeries([points[1], points[0]], opts({ nowMs: Date.parse('2026-10-06T01:30:00+02:00') }));
    expect(reversed.start).toBe('2026-10-05T23:00:00.000Z');
    expect(reversed.values).toEqual([20, 20, 20, 20]);
  });

  it('does not fill a one-hour gap that is not a DST fold', () => {
    // UTC timestamps: a missing hour has no offset change, so it is a real gap.
    const points = [
      { time: '2026-10-25T00:00:00Z', value: 0.1 },
      { time: '2026-10-25T02:00:00Z', value: 0.3 },
    ];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-25T00:30:00Z') }));
    expect(series.start).toBe('2026-10-25T00:00:00.000Z');
    expect(series.values).toEqual([10, 10, 10, 10]);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['false', false],
    ['true', true],
    ['missing', undefined],
    ['non-numeric string', 'n/a'],
  ])('treats a %s price as a defect, never as 0 or 1', (_label, bad) => {
    const points = [
      { time: '2026-10-06T00:00:00+02:00', value: 0.1 },
      { time: '2026-10-06T01:00:00+02:00', value: bad },
      { time: '2026-10-06T02:00:00+02:00', value: 0.3 },
    ];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T00:30:00+02:00') }));
    expect(series.values).toEqual([10, 10, 10, 10]);
  });

  it('treats an unparseable timestamp as a defect', () => {
    const points = [
      { time: '2026-10-06T00:00:00+02:00', value: 0.1 },
      { time: 'not a time', value: 0.2 },
      { time: 12345, value: 0.2 },
      { time: '2026-10-06T03:00:00+02:00', value: 0.3 },
    ];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T03:30:00+02:00') }));
    expect(series.start).toBe('2026-10-06T01:00:00.000Z');
    expect(series.values).toEqual([30, 30, 30, 30]);
  });

  it('returns null when no point is valid', () => {
    expect(pricePointsToSeries([{ time: '2026-10-06T00:00:00+02:00', value: null }], opts())).toBeNull();
    expect(pricePointsToSeries([null, { time: '  ' }], opts())).toBeNull();
  });

  it('accepts numeric-string prices and keeps zero and negative prices', () => {
    const points = [
      { time: '2026-10-06T12:00:00+02:00', value: '0' },
      { time: '2026-10-06T13:00:00+02:00', value: -0.05 },
      { time: '2026-10-06T14:00:00+02:00', value: ' 0.2 ' },
    ];
    const hourly = pricePointsToSeries(points, opts({ multiplier: 1 }));
    expect(hourly.values).toEqual([0, 0, 0, 0, -0.05, -0.05, -0.05, -0.05, 0.2, 0.2, 0.2, 0.2]);
  });

  it('ends the feed when a point overlaps the previous one (hourly interval given 15-min data)', () => {
    const points = [
      { time: '2026-10-06T12:00:00+02:00', value: 0.1 },
      { time: '2026-10-06T12:15:00+02:00', value: 0.2 },
    ];
    const series = pricePointsToSeries(points, opts({ nowMs: Date.parse('2026-10-06T12:30:00+02:00') }));
    expect(series.values).toEqual([10, 10, 10, 10]);
  });
});
