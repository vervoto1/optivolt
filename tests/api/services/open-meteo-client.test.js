import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchArchiveIrradiance, fetchForecastIrradiance } from '../../../api/services/open-meteo-client.ts';

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
