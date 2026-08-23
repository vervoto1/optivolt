import { describe, it, expect } from 'vitest';
import { findDailyWindowStart, isInDailyWindow } from '../../../api/services/daily-window.ts';

// vitest runs with TZ=Europe/Amsterdam (see vitest.config.js); the Date
// constructor calls below are local time in that zone.
const local = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);

describe('findDailyWindowStart', () => {
  it('matches inside [time, time + duration) and nowhere else', () => {
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 29, 59), '03:30', 5)).toBeNull();
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 30, 0), '03:30', 5)).toEqual(local(2026, 8, 23, 3, 30));
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 34, 59), '03:30', 5)).toEqual(local(2026, 8, 23, 3, 30));
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 35, 0), '03:30', 5)).toBeNull();
    expect(isInDailyWindow(local(2026, 8, 23, 3, 32), '03:30', 5)).toBe(true);
    expect(isInDailyWindow(local(2026, 8, 23, 12, 0), '03:30', 5)).toBe(false);
  });

  it('never matches an unparseable time', () => {
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 32), 'xx:yy', 5)).toBeNull();
    expect(findDailyWindowStart(local(2026, 8, 23, 3, 32), '', 5)).toBeNull();
  });

  it('wraps across midnight instead of truncating the window at 23:59', () => {
    // 23:58 + 5 min runs to 00:03 the next day; the start is yesterday's 23:58.
    expect(findDailyWindowStart(local(2026, 8, 24, 0, 1), '23:58', 5)).toEqual(local(2026, 8, 23, 23, 58));
    expect(findDailyWindowStart(local(2026, 8, 24, 0, 3), '23:58', 5)).toBeNull();
    expect(findDailyWindowStart(local(2026, 8, 23, 23, 59), '23:58', 5)).toEqual(local(2026, 8, 23, 23, 58));
  });

  it('fires on the spring-forward day for a time inside the skipped hour', () => {
    // 2027-03-28 02:00 → 03:00 CEST: 02:30 never appears on the wall clock.
    // The minutes-of-day comparison this replaced produced no run at all that
    // day; the normalised start is the first instant after the jump.
    expect(local(2027, 3, 28, 2, 30).getHours()).toBe(3); // the constructor's normalisation this relies on
    const start = findDailyWindowStart(local(2027, 3, 28, 3, 32), '02:30', 5);
    expect(start).not.toBeNull();
    expect(start.getHours()).toBe(3);
    expect(start.getMinutes()).toBe(30);
    expect(findDailyWindowStart(local(2027, 3, 28, 3, 2), '02:30', 5)).toBeNull();
    expect(findDailyWindowStart(local(2027, 3, 28, 3, 35), '02:30', 5)).toBeNull();
    // The day after, 02:30 exists again and is a different window.
    expect(findDailyWindowStart(local(2027, 3, 29, 2, 31), '02:30', 5)).toEqual(local(2027, 3, 29, 2, 30));
  });

  it('fires once on the fall-back day when the time occurs twice', () => {
    // 2027-10-31 03:00 CEST → 02:00 CET: 02:30 happens twice. The constructor
    // resolves to one of them; the other 02:30 is an hour away and misses.
    const first = findDailyWindowStart(local(2027, 10, 31, 2, 31), '02:30', 5);
    expect(first).not.toBeNull();
    const oneHourLater = new Date(first.getTime() + 61 * 60_000);
    expect(oneHourLater.getHours()).toBe(2); // still 02:31 on the wall clock
    expect(findDailyWindowStart(oneHourLater, '02:30', 5)).toBeNull();
  });
});
