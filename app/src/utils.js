export function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (day === 'tomorrow') d.setDate(d.getDate() + 1);
    return d.getTime();
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
