import { zonedParts, zonedWallTimeToMs } from './time-zone.js';

// Instant → "YYYY-MM-DDTHH:MM" for a datetime-local input, in the display zone.
export function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const p = zonedParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Inverse of toDatetimeLocal: a datetime-local value read in the display
// zone → epoch ms. Seconds are optional (a browser may add them), so such a
// value is never left to Date, which would read it in the browser's zone.
// Anything else is parsed by Date as-is. Invalid → null.
export function fromDatetimeLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d{1,3})?))?$/.exec(String(value ?? '').trim());
  if (m) {
    const ms = zonedWallTimeToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    return ms + Math.round(Number(m[6] ?? 0) * 1000);
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Resolve a "ready by" time-of-day ("HH:MM") + today/tomorrow selector to an
// absolute epoch-ms instant relative to `now`, mirroring the backend resolver
// (api/services/ev-departure.ts) so chart/table markers line up with the plan.
// Empty/invalid → null. A legacy absolute datetime is still parsed as-is.
export function resolveDepartureMs(timeStr, day, now = Date.now()) {
  const s = (timeStr ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    // Wall clock in the display (server) zone, so the marker matches the plan
    // even when the browser runs in another zone.
    const today = zonedParts(now);
    const dayOffset = day === 'tomorrow' ? 1 : 0;
    return zonedWallTimeToMs(today.year, today.month, today.day + dayOffset, h, min);
  }
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Effective EV target SoC for display, mirroring the backend resolver
// (api/services/ev-target-soc.ts): the live `evTargetSocEntity` state wins over
// the static Target SoC field whenever it is usable, so the chart's target line
// and the table's departure cell show the number the plan and the charger both
// actually used. Non-numeric or non-positive states fall back to the setting,
// exactly like the server does. Both unusable → null (no target drawn).
export function effectiveTargetSoc(liveState, staticValue) {
  const live = parseFloat(liveState);
  if (Number.isFinite(live) && live > 0) return Math.min(100, live);
  return parseFloat(staticValue) || null;
}

// The EV target as the server pinned it on the plan rows: the row index the
// LP enforces the target on and its value. null when no row carries it (an
// older server, no EV in the plan, or a deadline past the horizon), in which
// case callers fall back to the browser-side departure/target settings.
export function findEvTargetRow(rows) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex(r => Number.isFinite(r?.ev_target_soc_percent));
  return idx < 0 ? null : { idx, targetSoc_percent: rows[idx].ev_target_soc_percent };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function debounce(fn, wait = 250) {
  let timer = null;

  const debounced = (...args) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };

  // v8 ignore next — null path of === check is untestable (timer is always set in tests)
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
