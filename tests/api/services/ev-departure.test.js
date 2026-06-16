import { describe, expect, it } from 'vitest';
import { resolveDepartureMs } from '../../../api/services/ev-departure.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A fixed "now" at a whole minute so setHours(...,0,0) round-trips exactly.
const NOW = new Date('2024-06-01T10:00:00Z').getTime();

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('resolveDepartureMs', () => {
  it('returns null for empty/whitespace/unset input', () => {
    expect(resolveDepartureMs('', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs('   ', 'tomorrow', NOW)).toBeNull();
    expect(resolveDepartureMs(null, 'today', NOW)).toBeNull();
    expect(resolveDepartureMs(undefined, 'today', NOW)).toBeNull();
  });

  it('returns null for an out-of-range or unparseable time', () => {
    expect(resolveDepartureMs('99:99', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs('24:00', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs('not-a-time', 'today', NOW)).toBeNull();
  });

  it('resolves a future time-of-day today to that instant', () => {
    const target = NOW + 2 * HOUR; // still "today" in any plausible TZ
    expect(resolveDepartureMs(hhmm(target), 'today', NOW)).toBe(target);
  });

  it('resolves an already-past time-of-day today to that past instant', () => {
    // The resolver does not roll a past "today" forward — the caller treats a
    // past instant as "no deadline". Verify it returns the elapsed instant.
    const past = NOW - 2 * HOUR;
    expect(resolveDepartureMs(hhmm(past), 'today', NOW)).toBe(past);
  });

  it('puts the tomorrow selector exactly one day after the today selector', () => {
    const target = NOW + 2 * HOUR;
    const today = resolveDepartureMs(hhmm(target), 'today', NOW);
    const tomorrow = resolveDepartureMs(hhmm(target), 'tomorrow', NOW);
    expect(tomorrow - today).toBe(DAY);
  });

  it('defaults a missing day selector to "today"', () => {
    const target = NOW + 2 * HOUR;
    expect(resolveDepartureMs(hhmm(target), undefined, NOW)).toBe(target);
  });

  it('still parses a legacy absolute datetime (day selector ignored)', () => {
    const legacy = '2024-06-01T14:00:00Z';
    const expected = new Date(legacy).getTime();
    expect(resolveDepartureMs(legacy, 'tomorrow', NOW)).toBe(expected);
    expect(resolveDepartureMs(legacy, 'today', NOW)).toBe(expected);
  });
});
