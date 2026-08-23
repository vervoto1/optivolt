/**
 * daily-window.ts
 *
 * Shared "is the local time inside today's [time, time + duration) window"
 * check for the once-a-day timer services (DESS price refresh, prediction
 * auto-select).
 */

/**
 * Start of the daily window that `now` falls in, or null when it is outside.
 *
 * The start is built with the local-time `Date` constructor rather than by
 * comparing minutes-of-day, so it is an actual instant and two edge cases
 * that a wall-clock comparison silently gets wrong are handled:
 *
 * - A window that spans midnight (e.g. `23:58` + 5 min) is found through
 *   yesterday's start, instead of being truncated at 23:59.
 * - On the spring-forward day a time inside the skipped hour never appears on
 *   the wall clock; the constructor normalises the non-existent local time
 *   forward (02:30 → 03:30), so the window opens at the first instant after
 *   the jump instead of never.
 *
 * `time` is `HH:MM`; an unparseable value never matches.
 */
export function findDailyWindowStart(now: Date, time: string, durationMinutes: number): Date | null {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const durationMs = durationMinutes * 60_000;
  for (const dayOffset of [0, -1]) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m);
    const elapsed = now.getTime() - start.getTime();
    if (elapsed >= 0 && elapsed < durationMs) return start;
  }
  return null;
}

/** True when the local time is inside today's [time, time + duration) window. */
export function isInDailyWindow(now: Date, time: string, durationMinutes: number): boolean {
  return findDailyWindowStart(now, time, durationMinutes) !== null;
}
