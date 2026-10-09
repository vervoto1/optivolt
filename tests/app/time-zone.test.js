import { describe, it, expect, afterEach } from 'vitest';
import {
  setDisplayTimeZone,
  getDisplayTimeZone,
  isValidTimeZone,
  withDisplayTimeZone,
  zonedParts,
  zonedWallTimeToMs,
  fmtZonedHHMM,
  fmtZonedDDMM,
  zonedDateKey,
  isZonedMidnight,
} from '../../app/src/time-zone.js';
import { toDatetimeLocal, fromDatetimeLocal, resolveDepartureMs } from '../../app/src/utils.js';
import { buildTimeAxisFromTimestamps } from '../../app/src/charts/core.js';

// The suite runs with TZ=Europe/Amsterdam (vitest.config.js), so these tests
// stand in for a browser whose zone differs from the server's by pinning the
// display zone to something else and checking the browser zone is ignored.
const SLOT_MS = Date.parse('2026-10-09T10:45:00Z'); // 12:45 CEST

afterEach(() => setDisplayTimeZone(undefined));

describe('display time zone', () => {
  it('defaults to the browser zone', () => {
    expect(getDisplayTimeZone()).toBeUndefined();
    expect(fmtZonedHHMM(SLOT_MS)).toBe('12:45');
    expect(withDisplayTimeZone({ hour: '2-digit' })).toEqual({ hour: '2-digit' });
  });

  it('formats in the set zone, not the browser zone', () => {
    setDisplayTimeZone('UTC');
    expect(fmtZonedHHMM(SLOT_MS)).toBe('10:45');
    setDisplayTimeZone('Europe/Amsterdam');
    expect(fmtZonedHHMM(new Date(SLOT_MS))).toBe('12:45');
    expect(fmtZonedDDMM(SLOT_MS)).toBe('09/10');
    expect(withDisplayTimeZone({ hour: '2-digit' })).toEqual({ hour: '2-digit', timeZone: 'Europe/Amsterdam' });
  });

  it('rejects an invalid zone and falls back to the browser zone', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    setDisplayTimeZone('UTC');
    expect(setDisplayTimeZone('Mars/Olympus')).toBeUndefined();
    expect(fmtZonedHHMM(SLOT_MS)).toBe('12:45');
  });

  it('gives NaN fields for an invalid instant instead of throwing', () => {
    expect(fmtZonedHHMM(undefined)).toBe('NaN:NaN');
    expect(zonedParts(NaN).hour).toBeNaN();
  });

  it('finds midnight and the calendar day in the display zone', () => {
    const utcMidnight = Date.parse('2026-10-09T00:00:00Z');
    setDisplayTimeZone('UTC');
    expect(isZonedMidnight(utcMidnight)).toBe(true);
    expect(zonedDateKey(utcMidnight - 1)).toBe('2026-10-08');
    setDisplayTimeZone('Europe/Amsterdam');
    expect(isZonedMidnight(utcMidnight)).toBe(false);
    expect(zonedDateKey(utcMidnight - 1)).toBe('2026-10-09');
  });

  it('labels the chart axis in the display zone', () => {
    setDisplayTimeZone('UTC');
    const ts = [0, 1, 2, 3].map(i => SLOT_MS + i * 15 * 60_000);
    expect(buildTimeAxisFromTimestamps(ts).labels).toEqual(['10:45', '11:00', '11:15', '11:30']);
  });
});

describe('wall time ↔ instant in the display zone', () => {
  it('round-trips through a datetime-local value', () => {
    setDisplayTimeZone('America/New_York');
    expect(toDatetimeLocal(new Date(SLOT_MS))).toBe('2026-10-09T06:45');
    expect(fromDatetimeLocal('2026-10-09T06:45')).toBe(SLOT_MS);
    // With seconds it is still read in the display zone, not by Date.
    expect(fromDatetimeLocal('2026-10-09T06:45:00')).toBe(SLOT_MS);
    expect(fromDatetimeLocal('2026-10-09T06:45:30.5')).toBe(SLOT_MS + 30_500);
    expect(fromDatetimeLocal('2026-10-09T10:45:00Z')).toBe(SLOT_MS);
    expect(fromDatetimeLocal('nope')).toBeNull();
  });

  it('handles both DST changes', () => {
    setDisplayTimeZone('Europe/Amsterdam');
    // Autumn overlap (02:30 happens twice): the first occurrence, CEST.
    expect(zonedWallTimeToMs(2026, 10, 25, 2, 30)).toBe(Date.parse('2026-10-25T00:30:00Z'));
    // Spring gap: 02:30 does not exist; resolves forward to 03:30 CEST.
    expect(zonedWallTimeToMs(2026, 3, 29, 2, 30)).toBe(Date.parse('2026-03-29T01:30:00Z'));
    expect(zonedWallTimeToMs(2026, 3, 29, 12, 0)).toBe(Date.parse('2026-03-29T10:00:00Z'));
  });

  it('resolves an EV departure time in the display zone', () => {
    setDisplayTimeZone('UTC');
    expect(resolveDepartureMs('14:00', 'today', SLOT_MS)).toBe(Date.parse('2026-10-09T14:00:00Z'));
    expect(resolveDepartureMs('14:00', 'tomorrow', SLOT_MS)).toBe(Date.parse('2026-10-10T14:00:00Z'));
    setDisplayTimeZone('Europe/Amsterdam');
    expect(resolveDepartureMs('14:00', 'today', SLOT_MS)).toBe(Date.parse('2026-10-09T12:00:00Z'));
  });
});
