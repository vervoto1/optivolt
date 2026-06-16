export type EvDepartureDay = 'today' | 'tomorrow';

/**
 * Resolve a "ready by" deadline to an absolute epoch-ms instant relative to
 * `nowMs`. The deadline is stored as a wall-clock time-of-day (`"HH:MM"`) plus a
 * `today`/`tomorrow` selector, so it can never drift into the past the way an
 * absolute datetime did — the day is re-applied on every plan/decision.
 *
 * - `"HH:MM"` + day → today or tomorrow at that wall-clock time (server local TZ,
 *   which the add-on inherits from the Home Assistant timezone).
 * - Empty/unset → `null` (no deadline; callers charge to target by end of horizon).
 * - Legacy absolute datetime (e.g. `"2026-06-15T23:45"`, pre-0.7.38) is still
 *   parsed for backward compatibility; once elapsed it returns a past instant and
 *   callers treat that as "no deadline" (see config-builder's fallback).
 *
 * Returns `null` for empty or unparseable input.
 */
export function resolveDepartureMs(
  timeStr: string | undefined | null,
  day: EvDepartureDay | undefined,
  nowMs: number,
): number | null {
  const s = (timeStr ?? '').trim();
  if (!s) return null;

  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    if (day === 'tomorrow') d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // Legacy absolute datetime.
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}
