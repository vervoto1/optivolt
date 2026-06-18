import { describe, it, expect, vi } from 'vitest';
import {
  debounce,
  toDatetimeLocal,
  resolveDepartureMs,
  escapeHtml,
} from '../../app/src/utils.js';

describe('toDatetimeLocal', () => {
  it('formats a date as a zero-padded local datetime-local string', () => {
    // March is month index 2 → "03"; single-digit day/hours/minutes get padded.
    const d = new Date(2024, 2, 5, 9, 4, 30);
    expect(toDatetimeLocal(d)).toBe('2024-03-05T09:04');
  });

  it('keeps two-digit components without extra padding', () => {
    const d = new Date(2024, 10, 25, 14, 38);
    expect(toDatetimeLocal(d)).toBe('2024-11-25T14:38');
  });
});

describe('resolveDepartureMs', () => {
  const NOW = new Date(2024, 5, 18, 8, 30).getTime(); // 2024-06-18 08:30 local

  it('returns null for empty, whitespace, or nullish input', () => {
    expect(resolveDepartureMs('', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs('   ', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs(null, 'today', NOW)).toBeNull();
    expect(resolveDepartureMs(undefined, 'today', NOW)).toBeNull();
  });

  it('resolves an HH:MM time today relative to now', () => {
    const expected = new Date(2024, 5, 18, 7, 15, 0, 0).getTime();
    expect(resolveDepartureMs('07:15', 'today', NOW)).toBe(expected);
  });

  it('shifts an HH:MM time to the next day when day is tomorrow', () => {
    const expected = new Date(2024, 5, 19, 7, 15, 0, 0).getTime();
    expect(resolveDepartureMs('7:15', 'tomorrow', NOW)).toBe(expected);
  });

  it('rejects out-of-range hours and minutes', () => {
    expect(resolveDepartureMs('24:00', 'today', NOW)).toBeNull();
    expect(resolveDepartureMs('12:60', 'today', NOW)).toBeNull();
  });

  it('parses a legacy absolute datetime string as-is', () => {
    const iso = '2024-12-01T18:00';
    expect(resolveDepartureMs(iso, 'today', NOW)).toBe(new Date(iso).getTime());
  });

  it('returns null for an unparseable non-HH:MM string', () => {
    expect(resolveDepartureMs('not-a-time', 'today', NOW)).toBeNull();
  });

  it('defaults now to Date.now() when omitted', () => {
    const before = Date.now();
    const result = resolveDepartureMs('00:00', 'today');
    const after = Date.now();
    const midnightBefore = new Date(before).setHours(0, 0, 0, 0);
    const midnightAfter = new Date(after).setHours(0, 0, 0, 0);
    expect(result).toBeGreaterThanOrEqual(midnightBefore);
    expect(result).toBeLessThanOrEqual(midnightAfter);
  });
});

describe('escapeHtml', () => {
  it('escapes all HTML-sensitive characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('coerces non-string values to a string before escaping', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
  });
});

describe('debounce', () => {
  it('executes the function after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(51);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('resets the timer on subsequent calls', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced(); // reset
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(51);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels the execution', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(101);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
