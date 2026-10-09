// Display time zone for every clock time and date the UI shows.
//
// The server plans in its own local time (EV departure, price days, the DESS
// price refresh), so the UI shows times in the server's zone, fetched once at
// boot from GET /timezone. Until then, or when that fails, the browser's own
// zone is used. A browser that reports UTC (Firefox/LibreWolf
// resistFingerprinting, Brave/Mullvad, a UTC kiosk) would otherwise show
// every slot hours off from the plan.

let displayTimeZone; // undefined → the browser's zone
let partsFmt = null;

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Set the zone used for display. An invalid or empty zone resets to the
// browser's zone. Returns the zone now in use (undefined = browser).
export function setDisplayTimeZone(tz) {
  displayTimeZone = isValidTimeZone(tz) ? tz : undefined;
  partsFmt = null;
  return displayTimeZone;
}

export function getDisplayTimeZone() {
  return displayTimeZone;
}

// Options for toLocale*String / Intl.DateTimeFormat, with the display zone.
export function withDisplayTimeZone(options = {}) {
  return displayTimeZone ? { ...options, timeZone: displayTimeZone } : { ...options };
}

function getPartsFormatter() {
  if (!partsFmt) {
    partsFmt = new Intl.DateTimeFormat("en-GB", withDisplayTimeZone({
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }));
  }
  return partsFmt;
}

// Wall-clock fields of an instant (Date or epoch ms) in the display zone.
// month is 1-based, like the strings the UI prints.
export function zonedParts(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  // An invalid instant gives NaN fields (like Date#getHours), not a throw.
  if (!Number.isFinite(ms)) return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN };
  const out = {};
  for (const p of getPartsFormatter().formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24, // older engines print midnight as 24
    minute: out.minute,
  };
}

// Epoch ms of a wall-clock time in the display zone, resolved like
// Date#setHours: a repeated time (autumn DST change) is its first occurrence,
// a nonexistent one (spring gap) moves forward by the gap.
export function zonedWallTimeToMs(year, month, day, hour, minute) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms) => {
    const p = zonedParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  // The zone's offsets a day either side cover both sides of any DST change.
  const offsetBefore = offsetAt(asUtc - 86_400_000);
  const offsetAfter = offsetAt(asUtc + 86_400_000);
  const matches = [asUtc - offsetBefore, asUtc - offsetAfter]
    .filter(ms => offsetAt(ms) === asUtc - ms)
    .sort((a, b) => a - b);
  return matches.length > 0 ? matches[0] : asUtc - offsetBefore;
}

const pad2 = (n) => String(n).padStart(2, "0");

export function fmtZonedHHMM(value) {
  const p = zonedParts(value);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function fmtZonedDDMM(value) {
  const p = zonedParts(value);
  return `${pad2(p.day)}/${pad2(p.month)}`;
}

// "YYYY-MM-DD" calendar day of an instant in the display zone.
export function zonedDateKey(value) {
  const p = zonedParts(value);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isZonedMidnight(value) {
  const p = zonedParts(value);
  return p.hour === 0 && p.minute === 0;
}
