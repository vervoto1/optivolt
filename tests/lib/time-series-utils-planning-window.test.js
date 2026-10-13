import { describe, it, expect } from 'vitest';
import {
  extendedHorizonOf,
  extendedWindowEndMs,
  getForecastTimeRange,
  resolvePlanningWindow,
  truncateAtFirstGap,
} from '../../lib/time-series-utils.ts';

// Tests run in Europe/Amsterdam (vitest.config.js).
const HOUR_MS = 3600_000;
const localParts = iso => {
  const d = new Date(iso);
  return { date: d.getDate(), hours: d.getHours(), minutes: d.getMinutes() };
};

describe('extendedHorizonOf', () => {
  it('reads the block from any settings-like object', () => {
    expect(extendedHorizonOf(null)).toBeUndefined();
    expect(extendedHorizonOf(undefined)).toBeUndefined();
    expect(extendedHorizonOf({})).toBeUndefined();
    expect(extendedHorizonOf({ extendedHorizon: null })).toBeUndefined();
    expect(extendedHorizonOf({ extendedHorizon: { mode: 'on', extraDays: 2 } })).toEqual({ mode: 'on', extraDays: 2 });
  });
});

describe('resolvePlanningWindow', () => {
  // Tue 2026-10-13 10:07 CEST (before 13:00) and 14:07 CEST (after).
  const MORNING = Date.parse('2026-10-13T08:07:00Z');
  const AFTERNOON = Date.parse('2026-10-13T12:07:00Z');

  it.each([
    ['no settings', undefined],
    ['no block', {}],
    ['a null block', { extendedHorizon: null }],
    ['mode off', { extendedHorizon: { mode: 'off', extraDays: 4 } }],
    ['an unknown mode', { extendedHorizon: { mode: 'sometimes', extraDays: 4 } }],
  ])('is exactly getForecastTimeRange with %s', (_label, settings) => {
    for (const now of [MORNING, AFTERNOON]) {
      const { startIso, endIso } = getForecastTimeRange(now);
      // A firm end is ignored when not extended.
      expect(resolvePlanningWindow(settings, now, now + 5 * 24 * HOUR_MS)).toEqual({
        startIso, endIso, baseEndIso: endIso, extended: false, extraDays: 0,
      });
    }
  });

  it('defaults nowMs to the current time', () => {
    const before = getForecastTimeRange();
    const window = resolvePlanningWindow({});
    const after = getForecastTimeRange();
    expect([before.endIso, after.endIso]).toContain(window.endIso);
  });

  it('collect/on end at the local midnight after tomorrow plus extraDays, before and after 13:00', () => {
    for (const mode of ['collect', 'on']) {
      const settings = { extendedHorizon: { mode, extraDays: 3 } };
      const morning = resolvePlanningWindow(settings, MORNING);
      expect(morning).toEqual({
        startIso: getForecastTimeRange(MORNING).startIso,
        // Thu 15 Oct 00:00 CEST + 3 days = Sun 18 Oct 00:00 CEST.
        endIso: '2026-10-17T22:00:00.000Z',
        baseEndIso: getForecastTimeRange(MORNING).endIso,
        extended: true,
        extraDays: 3,
      });
      // The base end before 13:00 is tonight; the extended end does not move at publication.
      expect(morning.baseEndIso).toBe('2026-10-13T22:00:00.000Z');
      const afternoon = resolvePlanningWindow(settings, AFTERNOON);
      expect(afternoon.endIso).toBe(morning.endIso);
      expect(afternoon.baseEndIso).toBe('2026-10-14T22:00:00.000Z');
    }
  });

  it('extends from a firm end past tomorrow 24:00, rounded up to local midnight', () => {
    const settings = { extendedHorizon: { mode: 'on', extraDays: 1 } };
    // Thu 15 Oct 06:00 CEST → Fri 16 Oct 00:00 CEST → + 1 day.
    const firmEnd = Date.parse('2026-10-15T04:00:00Z');
    expect(resolvePlanningWindow(settings, AFTERNOON, firmEnd).endIso).toBe('2026-10-16T22:00:00.000Z');
    // A firm end exactly on local midnight is its own midnight.
    const midnight = Date.parse('2026-10-15T22:00:00Z');
    expect(resolvePlanningWindow(settings, AFTERNOON, midnight).endIso).toBe('2026-10-16T22:00:00.000Z');
  });

  it('never ends before tomorrow 24:00 + extraDays, whatever the firm end', () => {
    const settings = { extendedHorizon: { mode: 'collect', extraDays: 2 } };
    const expected = '2026-10-16T22:00:00.000Z'; // Thu 15 Oct 00:00 CEST + 2 days
    expect(resolvePlanningWindow(settings, MORNING, Date.parse('2026-10-13T22:00:00Z')).endIso).toBe(expected);
    expect(resolvePlanningWindow(settings, MORNING, NaN).endIso).toBe(expected);
    expect(resolvePlanningWindow(settings, MORNING, undefined).endIso).toBe(expected);
  });

  it('normalises extraDays to a whole number of days in 1–4 (default 3)', () => {
    const endFor = extraDays => resolvePlanningWindow({ extendedHorizon: { mode: 'on', extraDays } }, MORNING);
    expect(endFor(undefined).extraDays).toBe(3);
    expect(endFor(Infinity).extraDays).toBe(3);
    expect(endFor('2').extraDays).toBe(3);
    expect(endFor(0).extraDays).toBe(1);
    expect(endFor(9).extraDays).toBe(4);
    expect(endFor(2.4).extraDays).toBe(2);
    expect(endFor(4).endIso).toBe('2026-10-18T22:00:00.000Z');
  });

  it('adds local days across the October DST switch (a 25 h day)', () => {
    // Fri 23 Oct 2026 12:00 CEST; DST ends Sun 25 Oct 03:00 CEST.
    const now = Date.parse('2026-10-23T10:00:00Z');
    const window = resolvePlanningWindow({ extendedHorizon: { mode: 'on', extraDays: 1 } }, now);
    // Sun 25 Oct 00:00 CEST (= Sat 22:00Z) + 1 local day = Mon 26 Oct 00:00 CET (= Sun 23:00Z).
    expect(window.endIso).toBe('2026-10-25T23:00:00.000Z');
    expect(localParts(window.endIso)).toEqual({ date: 26, hours: 0, minutes: 0 });
  });

  it('adds local days across the March DST switch (a 23 h day)', () => {
    // Fri 26 Mar 2027 10:00 CET; DST starts Sun 28 Mar 02:00 CET.
    const now = Date.parse('2027-03-26T09:00:00Z');
    const window = resolvePlanningWindow({ extendedHorizon: { mode: 'collect', extraDays: 1 } }, now);
    // Sun 28 Mar 00:00 CET (= Sat 23:00Z) + 1 local day = Mon 29 Mar 00:00 CEST (= Sun 22:00Z).
    expect(window.endIso).toBe('2027-03-28T22:00:00.000Z');
    expect(localParts(window.endIso)).toEqual({ date: 29, hours: 0, minutes: 0 });
  });
});

describe('extendedWindowEndMs', () => {
  const on = extraDays => ({ extendedHorizon: { mode: 'on', extraDays } });

  it('is the local midnight at or after the firm end plus extraDays', () => {
    // Firm end Wed 14 Oct 00:00 CEST (published through today) + 3 days.
    expect(extendedWindowEndMs(on(3), Date.parse('2026-10-13T22:00:00Z'))).toBe(Date.parse('2026-10-16T22:00:00Z'));
    // A firm end inside a day rounds up to the next local midnight first.
    expect(extendedWindowEndMs(on(1), Date.parse('2026-10-13T21:30:00Z'))).toBe(Date.parse('2026-10-14T22:00:00Z'));
    // extraDays is normalised as for the planning window (default 3, 1–4).
    expect(extendedWindowEndMs({}, Date.parse('2026-10-13T22:00:00Z'))).toBe(Date.parse('2026-10-16T22:00:00Z'));
    expect(extendedWindowEndMs(on(9), Date.parse('2026-10-13T22:00:00Z'))).toBe(Date.parse('2026-10-17T22:00:00Z'));
  });

  it('does not jump a day at midnight while the firm end stays the same', () => {
    // Prices published through Thu 15 Oct 24:00 (= 15 Oct 22:00Z).
    const firmEnd = Date.parse('2026-10-15T22:00:00Z');
    const beforeMidnight = Date.parse('2026-10-14T21:45:00Z'); // Wed 23:45 CEST
    const afterMidnight = Date.parse('2026-10-14T22:00:00Z');  // Thu 00:00 CEST
    const settings = on(2);
    const end = extendedWindowEndMs(settings, firmEnd);
    expect(end).toBe(Date.parse('2026-10-17T22:00:00Z')); // Sun 18 Oct 00:00 CEST
    // The predictor window moves with the date (tomorrow 24:00 + extraDays)
    // but always covers the extended end.
    expect(Date.parse(resolvePlanningWindow(settings, beforeMidnight, firmEnd).endIso)).toBe(end);
    expect(Date.parse(resolvePlanningWindow(settings, afterMidnight, firmEnd).endIso)).toBe(end + 24 * HOUR_MS);
  });

  it('is never later than the predictor window, before and after publication', () => {
    const settings = on(3);
    // 10:07 CEST, published through tonight; 14:07 CEST, through tomorrow.
    for (const [now, firmEnd] of [
      [Date.parse('2026-10-13T08:07:00Z'), Date.parse('2026-10-13T22:00:00Z')],
      [Date.parse('2026-10-13T12:07:00Z'), Date.parse('2026-10-14T22:00:00Z')],
    ]) {
      expect(extendedWindowEndMs(settings, firmEnd)).toBeLessThanOrEqual(Date.parse(resolvePlanningWindow(settings, now, firmEnd).endIso));
    }
  });

  it('adds local calendar days across the DST switches', () => {
    // Firm end Sat 24 Oct 00:00 CEST + 2 days = Mon 26 Oct 00:00 CET (a 25 h Sunday).
    const october = extendedWindowEndMs(on(2), Date.parse('2026-10-23T22:00:00Z'));
    expect(october).toBe(Date.parse('2026-10-25T23:00:00Z'));
    expect(localParts(october)).toEqual({ date: 26, hours: 0, minutes: 0 });
    // Firm end Sat 27 Mar 2027 00:00 CET + 2 days = Mon 29 Mar 00:00 CEST (a 23 h Sunday).
    const march = extendedWindowEndMs(on(2), Date.parse('2027-03-26T23:00:00Z'));
    expect(march).toBe(Date.parse('2027-03-28T22:00:00Z'));
    expect(localParts(march)).toEqual({ date: 29, hours: 0, minutes: 0 });
  });
});

describe('truncateAtFirstGap', () => {
  const series = { start: '2026-10-13T22:00:00.000Z', step: 15, values: [1, 2, 3, 4, 5, 6] };
  const slot = i => Date.parse(series.start) + i * 15 * 60_000;
  const keepUntil = new Date(slot(2)).toISOString();

  it('keeps the series whole when every slot past keepUntil is covered', () => {
    const result = truncateAtFirstGap(series, keepUntil, ms => (ms < slot(2) ? 'ignored' : null));
    expect(result).toEqual({ series });
  });

  it('treats undefined as covered', () => {
    expect(truncateAtFirstGap(series, keepUntil, () => undefined)).toEqual({ series });
  });

  it('keeps gaps before keepUntil and cuts at the first gap at or after it', () => {
    const gaps = new Map([[slot(0), 'early'], [slot(4), 'late'], [slot(5), 'later']]);
    const result = truncateAtFirstGap(series, keepUntil, ms => gaps.get(ms) ?? null);
    expect(result).toEqual({
      series: { ...series, values: [1, 2, 3, 4] },
      truncatedAt: new Date(slot(4)).toISOString(),
      reason: 'late',
    });
    // The input is not modified.
    expect(series.values).toHaveLength(6);
  });

  it('cuts at keepUntil itself when that slot is a gap', () => {
    const result = truncateAtFirstGap(series, keepUntil, () => 'missing');
    expect(result.series.values).toEqual([1, 2]);
    expect(result.truncatedAt).toBe(keepUntil);
  });
});
