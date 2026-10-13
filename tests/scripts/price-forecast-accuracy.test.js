import { describe, it, expect } from 'vitest';

import {
  actualHourlyPrices,
  actualsFromResponse,
  actualsRequests,
  actualsUrl,
  forecastRange,
  formatScore,
  leadDay,
  parseForecastLog,
  scoreForecastLog,
} from '../../scripts/price-forecast-accuracy-score.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Local (process time zone) instants, so the tests hold in any TZ.
const local = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();
const iso = (ms) => new Date(ms).toISOString();

function entry(publishedEndMs, values, over = {}) {
  return {
    day: '2026-10-01', fetchedAt: iso(publishedEndMs - 10 * HOUR), region: 'NL',
    publishedEnd: iso(publishedEndMs), start: iso(publishedEndMs), step: 60, values, ...over,
  };
}

describe('parseForecastLog', () => {
  it('accepts { entries } and a bare array', () => {
    const e = entry(local(2026, 10, 2), [1, 2]);
    expect(parseForecastLog({ entries: [e] })).toEqual([e]);
    expect(parseForecastLog([e])).toEqual([e]);
  });

  it('rejects anything else, naming the bad entry', () => {
    expect(() => parseForecastLog({}, 'log.json')).toThrow(/log\.json: not a price-forecast-log/);
    const good = entry(local(2026, 10, 2), [1]);
    expect(() => parseForecastLog([good, { ...good, values: [1, null] }])).toThrow(/entries\[1\]/);
    expect(() => parseForecastLog([{ ...good, step: 15 }])).toThrow(/entries\[0\]/);
    expect(() => parseForecastLog([{ ...good, publishedEnd: 'never' }])).toThrow(/entries\[0\]/);
  });
});

describe('actual prices', () => {
  const startMs = Date.UTC(2026, 9, 12, 22);
  const series = (n) => ({ start: iso(startMs), step: 15, values: Array.from({ length: n }, (_, i) => i) });

  it('averages whole published hours only', () => {
    const map = actualHourlyPrices({ series: series(12), publishedEndMs: startMs + 2 * HOUR, truncated: false });
    expect([...map]).toEqual([[startMs, 1.5], [startMs + HOUR, 5.5]]);
    // A last hour that is not complete in the series is dropped.
    expect(actualHourlyPrices({ series: series(7), publishedEndMs: startMs + 3 * HOUR, truncated: false }).size).toBe(1);
  });

  it('starts at the first whole hour', () => {
    const map = actualHourlyPrices({
      series: { start: iso(startMs + 30 * 60_000), step: 15, values: [9, 9, 1, 2, 3, 4] },
      publishedEndMs: startMs + 5 * HOUR, truncated: false,
    });
    expect([...map]).toEqual([[startMs + HOUR, 2.5]]);
  });

  it('reads a whole 30-day history response (one actualsRequests chunk), past the planner\'s 10-day cap', () => {
    const quarters = 30 * 96;
    const prices = Array.from({ length: quarters }, (_, i) => ({ startsAt: iso(startMs + i * 15 * 60_000), total: Math.floor(i / 4) }));
    const map = actualsFromResponse({ prices, knownUntil: iso(startMs + (quarters - 1) * 15 * 60_000) });
    expect(map.size).toBe(30 * 24);
    expect(map.get(startMs + (30 * 24 - 1) * HOUR)).toBe(30 * 24 - 1);
  });

  it('reads a saved feed response up to knownUntil', () => {
    const prices = Array.from({ length: 12 }, (_, i) => ({ startsAt: iso(startMs + i * 15 * 60_000), total: i < 4 ? 10 : 20 }));
    const map = actualsFromResponse({ prices, knownUntil: iso(startMs + 7 * 15 * 60_000) });
    expect([...map]).toEqual([[startMs, 10], [startMs + HOUR, 20]]);
  });
});

describe('actuals requests', () => {
  it('covers the forecast range, capped at what can be published, in chunks', () => {
    const a = entry(local(2026, 9, 1), new Array(120).fill(1));
    const b = entry(local(2026, 10, 1), new Array(120).fill(1));
    expect(forecastRange([a, b])).toEqual({ startMs: local(2026, 9, 1), endMs: local(2026, 10, 1) + 120 * HOUR });
    expect(forecastRange([entry(0, [])])).toBeNull();

    const now = local(2026, 10, 2, 12);
    const reqs = actualsRequests([a, b], now, 30);
    expect(reqs[0]).toEqual({ startMs: local(2026, 9, 1), hours: 720 });
    const last = reqs[reqs.length - 1];
    expect(last.startMs + last.hours * HOUR).toBe(Math.ceil((now + 2 * DAY) / HOUR) * HOUR);
    expect(reqs.reduce((sum, r) => sum + r.hours, 0) * HOUR).toBe(last.startMs + last.hours * HOUR - reqs[0].startMs);
    expect(actualsRequests([], now)).toEqual([]);
  });

  it('builds the feed URL with startTs and hours', () => {
    const url = new URL(actualsUrl('https://feed.example/base/', 'NL', Date.UTC(2026, 9, 1, 22), 48));
    expect(url.pathname).toBe('/base/prices');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      region: 'NL', unit: 'CT_PER_KWH', startTs: '2026-10-01T22:00:00.000Z', hours: '48',
    });
  });
});

describe('scoreForecastLog', () => {
  it('counts lead days in local calendar days after the published end', () => {
    const end = local(2026, 10, 3);
    expect(leadDay(end, end)).toBe(1);
    expect(leadDay(local(2026, 10, 3, 23), end)).toBe(1);
    expect(leadDay(local(2026, 10, 4, 0), end)).toBe(2);
    expect(leadDay(local(2026, 10, 2, 23), end)).toBe(0);
  });

  it('scores MAE, bias and RMSE by lead day and hour of day, skipping unpublished hours', () => {
    const end = local(2026, 10, 3);
    // 48 hours: lead day 1 forecasts 2 c too high, lead day 2 alternates ±4.
    const values = Array.from({ length: 48 }, (_, h) => (h < 24 ? 12 : h % 2 === 0 ? 14 : 6));
    const actuals = new Map(Array.from({ length: 40 }, (_, h) => [end + h * HOUR, 10])); // hours 40–47 unpublished
    const score = scoreForecastLog([entry(end, values)], actuals, 5);

    expect(score.entriesScored).toBe(1);
    expect(score.unscoredHours).toBe(8);
    expect(score.byLead[0]).toEqual({ n: 24, mae: 2, bias: 2, rmse: 2 });
    expect(score.byLead[1]).toEqual({ n: 16, mae: 4, bias: 0, rmse: 4 });
    expect(score.byLead[2]).toEqual({ n: 0, mae: NaN, bias: NaN, rmse: NaN });
    expect(score.overall.n).toBe(40);
    expect(score.overall.mae).toBeCloseTo((24 * 2 + 16 * 4) / 40, 9);
    expect(score.byHour[0]).toEqual({ n: 2, mae: 3, bias: 3, rmse: Math.sqrt((4 + 16) / 2) });
    expect(score.byHour[1]).toEqual({ n: 2, mae: 3, bias: -1, rmse: Math.sqrt((4 + 16) / 2) });
  });

  it('ignores hours outside lead days 1..maxLead', () => {
    const end = local(2026, 10, 3);
    const e = entry(end, [99, 10], { start: iso(end - HOUR) }); // the first hour lies before the published end
    const score = scoreForecastLog([e], new Map([[end - HOUR, 10], [end, 10]]), 5);
    expect(score.overall).toEqual({ n: 1, mae: 0, bias: 0, rmse: 0 });
    expect(scoreForecastLog([entry(end, [11])], new Map([[end, 10]]), 0).overall.n).toBe(0);
  });

  it('formats the tables', () => {
    const end = local(2026, 10, 3);
    const lines = formatScore(scoreForecastLog([entry(end, [12])], new Map([[end, 10]]), 2));
    expect(lines[0]).toBe('entries scored: 1; forecast hours without a published price: 0');
    expect(lines.some(l => /^1\s+1\s+2\.00\s+2\.00\s+2\.00$/.test(l))).toBe(true);
    expect(lines.some(l => /^2\s+0\s+-\s+-\s+-$/.test(l))).toBe(true);
    expect(lines.filter(l => /^\d\d:00/.test(l))).toHaveLength(24);
  });
});
