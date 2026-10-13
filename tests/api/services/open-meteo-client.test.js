import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  fetchArchiveIrradiance,
  fetchExtendedForecastIrradiance,
  fetchForecastIrradiance,
  fetchTemperatureSeries,
} from '../../../api/services/open-meteo-client.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHourlyResponse(overrides = {}) {
  return {
    hourly: {
      time: ['2026-03-21T12:00', '2026-03-21T13:00'],
      shortwave_radiation: [600, 700],
      ...overrides,
    },
  };
}

function makeMinutely15Response(overrides = {}) {
  return {
    minutely_15: {
      time: ['2026-03-21T12:00', '2026-03-21T12:15'],
      shortwave_radiation: [500, 520],
      ...overrides,
    },
  };
}

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

function makeErrorResponse(status) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  };
}

// ---------------------------------------------------------------------------
// fetchArchiveIrradiance
// ---------------------------------------------------------------------------

describe('fetchArchiveIrradiance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls fetch with the Open-Meteo archive API URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('archive-api.open-meteo.com');
  });

  it('includes latitude and longitude in the archive URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('latitude=51.05');
    expect(url).toContain('longitude=3.71');
  });

  it('includes start_date and end_date in the archive URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('start_date=2026-03-01');
    expect(url).toContain('end_date=2026-03-21');
  });

  it('returns parsed IrradianceRecord array from hourly response', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    const records = await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(2);
    expect(typeof records[0].time).toBe('number');
    expect(typeof records[0].ghi_W_per_m2).toBe('number');
    expect(records[0].intervalMinutes).toBe(60);
  });

  it('clamps negative radiation values to 0', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse({
      shortwave_radiation: [-10, 500],
    })));

    const records = await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    expect(records[0].ghi_W_per_m2).toBe(0);
    expect(records[1].ghi_W_per_m2).toBe(500);
  });

  it('treats null radiation values as 0', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse({
      shortwave_radiation: [null, 400],
    })));

    const records = await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21');

    expect(records[0].ghi_W_per_m2).toBe(0);
  });

  it('throws when the archive API returns a non-ok status', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));

    await expect(
      fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-21')
    ).rejects.toThrow('500');
  });

  it('applies backward-averaging alignment: shifts timestamp back 1 hour', async () => {
    // Open-Meteo labels hour 13:00 = radiation over 12:00–13:00
    // We expect the record's time to represent the interval start (12:00 UTC)
    mockFetch.mockResolvedValue(makeOkResponse({
      hourly: {
        time: ['2026-03-21T13:00'],
        shortwave_radiation: [600],
      },
    }));

    const records = await fetchArchiveIrradiance(51.05, 3.71, '2026-03-21', '2026-03-21');

    const expected = new Date('2026-03-21T12:00:00Z').getTime();
    expect(records[0].time).toBe(expected);
    expect(records[0].hour).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// fetchForecastIrradiance
// ---------------------------------------------------------------------------

describe('fetchForecastIrradiance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls fetch with the Open-Meteo forecast API URL (hourly by default)', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchForecastIrradiance(51.05, 3.71);

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('api.open-meteo.com/v1/forecast');
  });

  it('includes latitude and longitude in the forecast URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchForecastIrradiance(51.05, 3.71);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('latitude=51.05');
    expect(url).toContain('longitude=3.71');
  });

  it('returns parsed IrradianceRecord array for hourly resolution', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    const records = await fetchForecastIrradiance(51.05, 3.71, undefined, 60);

    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0].intervalMinutes).toBe(60);
  });

  it('requests minutely_15 data when resolution is 15', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeMinutely15Response()));

    await fetchForecastIrradiance(51.05, 3.71, undefined, 15);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('minutely_15');
  });

  it('returns 15-min interval records when resolution is 15', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeMinutely15Response()));

    const records = await fetchForecastIrradiance(51.05, 3.71, undefined, 15);

    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0].intervalMinutes).toBe(15);
  });

  it('includes a custom model name in the URL when provided', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchForecastIrradiance(51.05, 3.71, 'gfs_seamless', 60);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('gfs_seamless');
  });

  it('throws when the forecast API returns a non-ok status', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(429));

    await expect(
      fetchForecastIrradiance(51.05, 3.71)
    ).rejects.toThrow('429');
  });

  it('clamps negative radiation values to 0 in forecast response', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse({
      shortwave_radiation: [-5, 300],
    })));

    const records = await fetchForecastIrradiance(51.05, 3.71, undefined, 60);

    expect(records[0].ghi_W_per_m2).toBe(0);
    expect(records[1].ghi_W_per_m2).toBe(300);
  });

  it('includes past_days and forecast_days in the URL', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchForecastIrradiance(51.05, 3.71);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('past_days=1');
    expect(url).toContain('forecast_days=2');
  });
});

describe('open-meteo-client — request deadlines', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('passes an abort signal to the archive request', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-02');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an abort signal to the forecast request', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(makeHourlyResponse()));

    await fetchForecastIrradiance(51.05, 3.71);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a labelled timeout when the archive deadline fires', async () => {
    mockFetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    await expect(fetchArchiveIrradiance(51.05, 3.71, '2026-03-01', '2026-03-02', 5))
      .rejects.toThrow('Open-Meteo Archive API request timed out after 5ms');
  });

  it('surfaces a labelled timeout when the forecast deadline fires', async () => {
    mockFetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    await expect(fetchForecastIrradiance(51.05, 3.71, undefined, 60, 5))
      .rejects.toThrow('Open-Meteo Forecast API request timed out after 5ms');
  });
});

// ---------------------------------------------------------------------------
// fetchTemperatureSeries
// ---------------------------------------------------------------------------

describe('fetchTemperatureSeries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches hourly temperature_2m with capped day counts and parses it', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({
      hourly: { time: ['2026-03-21T12:00'], temperature_2m: [9.5] },
    }));
    const records = await fetchTemperatureSeries(52.1, 5.2, 200, 3);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('hourly=temperature_2m');
    expect(url).toContain('past_days=92');
    expect(url).toContain('forecast_days=3');
    expect(records).toEqual([{ time: Date.UTC(2026, 2, 21, 12), temp_C: 9.5 }]);
  });

  it('throws an Open-Meteo error on a non-ok response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(429));
    await expect(fetchTemperatureSeries(52.1, 5.2, 30, 2)).rejects.toThrow('Open-Meteo temperature request returned status 429');
  });
});

// ---------------------------------------------------------------------------
// fetchExtendedForecastIrradiance (ICON D2 + ICON seamless splice)
// ---------------------------------------------------------------------------

describe('fetchExtendedForecastIrradiance', () => {
  const TODAY_HOURLY_URL = 'https://api.open-meteo.com/v1/forecast?latitude=51.05&longitude=3.71'
    + '&hourly=shortwave_radiation,direct_radiation,diffuse_radiation&models=icon_d2&timezone=GMT&past_days=1&forecast_days=2';
  const d2Hourly = {
    hourly: {
      time: ['2026-10-13T12:00', '2026-10-13T13:00', '2026-10-13T14:00'],
      shortwave_radiation: [600, 0, null],
    },
  };
  const seamlessHourly = {
    hourly: {
      time: ['2026-10-13T12:00', '2026-10-13T13:00', '2026-10-13T14:00', '2026-10-13T15:00', '2026-10-13T16:00'],
      shortwave_radiation: [1, 2, 300, null, 100],
    },
  };
  const routeFetch = (byModel) => mockFetch.mockImplementation(async (url) => {
    const model = /models=([a-z0-9_]+)/.exec(url)[1];
    const body = byModel[model];
    if (body instanceof Error) throw body;
    return typeof body === 'number' ? makeErrorResponse(body) : makeOkResponse(body);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requests ICON D2 exactly as fetchForecastIrradiance does, plus ICON seamless for forecastDays', async () => {
    routeFetch({ icon_d2: d2Hourly, icon_seamless: seamlessHourly });
    await fetchExtendedForecastIrradiance(51.05, 3.71, 60, 5);
    const urls = mockFetch.mock.calls.map(c => c[0]);

    mockFetch.mockClear();
    routeFetch({ icon_d2: d2Hourly });
    await fetchForecastIrradiance(51.05, 3.71, undefined, 60);
    const today = mockFetch.mock.calls[0][0];

    expect(today).toBe(TODAY_HOURLY_URL);
    expect(urls).toEqual([today, today.replace('models=icon_d2', 'models=icon_seamless').replace('forecast_days=2', 'forecast_days=5')]);
  });

  it('splices ICON seamless in after the last ICON D2 value and reports the remaining nulls', async () => {
    routeFetch({ icon_d2: d2Hourly, icon_seamless: seamlessHourly });
    const result = await fetchExtendedForecastIrradiance(51.05, 3.71, 60, 5);
    // Hourly labels are backward-averaged: 12:00 covers 11:00–12:00.
    expect(result.records.map(r => [new Date(r.time).toISOString().slice(11, 16), r.ghi_W_per_m2])).toEqual([
      ['11:00', 600], ['12:00', 0], ['13:00', 300], ['14:00', 0], ['15:00', 100],
    ]);
    expect(result.nullTimes).toEqual([Date.parse('2026-10-13T14:00:00Z')]);
    expect(result.extensionError).toBeUndefined();
  });

  it('splices 15-minute data with minutely_15 requests', async () => {
    routeFetch({
      icon_d2: { minutely_15: { time: ['2026-10-13T12:00', '2026-10-13T12:15'], shortwave_radiation: [500, null] } },
      icon_seamless: { minutely_15: { time: ['2026-10-13T12:00', '2026-10-13T12:15'], shortwave_radiation: [1, 450] } },
    });
    const result = await fetchExtendedForecastIrradiance(51.05, 3.71, 15, 3);
    expect(mockFetch.mock.calls.every(c => c[0].includes('&minutely_15='))).toBe(true);
    expect(result.records.map(r => r.ghi_W_per_m2)).toEqual([500, 450]);
    expect(result.nullTimes).toEqual([]);
  });

  it('keeps ICON D2 alone with extensionError when ICON seamless fails', async () => {
    routeFetch({ icon_d2: d2Hourly, icon_seamless: 503 });
    const result = await fetchExtendedForecastIrradiance(51.05, 3.71, 60, 5);
    expect(result.records).toHaveLength(3);
    expect(result.nullTimes).toEqual([Date.parse('2026-10-13T13:00:00Z')]);
    expect(result.extensionError).toBe('Open-Meteo Forecast API returned status 503');
  });

  it('reports a non-Error ICON seamless failure as text', async () => {
    mockFetch.mockImplementation(async (url) => {
      if (url.includes('icon_seamless')) throw 'boom';
      return makeOkResponse(d2Hourly);
    });
    const result = await fetchExtendedForecastIrradiance(51.05, 3.71, 60, 5);
    expect(result.extensionError).toBe('boom');
  });

  it('throws when ICON D2 fails, as the non-extended request does', async () => {
    routeFetch({ icon_d2: 500, icon_seamless: seamlessHourly });
    await expect(fetchExtendedForecastIrradiance(51.05, 3.71, 60, 5))
      .rejects.toThrow('Open-Meteo Forecast API returned status 500');
  });
});
