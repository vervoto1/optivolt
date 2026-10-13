import { serverNowMs } from "./server-clock.js";
import { getDisplayTimeZone, withDisplayTimeZone } from "./time-zone.js";

// Export tariff card: the hint under the "net metering ends at" field and
// the status line saying which export rule the planner applies right now.
// The server validates and applies the settings; this only explains them.

export const EXPORT_TARIFF_DEFAULT_EFFECTIVE_FROM = "2027-01-01T00:00:00+01:00";

const QUARTER_HOUR_MS = 15 * 60_000;
// The planner warns about a missing market-price source from this long
// before the switch (MISSING_MARKET_SOURCE_LEAD_MS in lib/export-tariff.ts).
const MISSING_SOURCE_LEAD_MS = 7 * 24 * 60 * 60_000;
const EFFECTIVE_FROM_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

const TONE_CLASSES = {
  neutral: "text-slate-600 dark:text-slate-400",
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

/**
 * Parse an effective-from value the way the server does (parseEffectiveFrom
 * in lib/export-tariff.ts): an ISO date-time with an explicit offset, a real
 * calendar date, on a 15-minute boundary in UTC.
 * → { ok: true, ms } or { ok: false, error }.
 */
export function parseEffectiveFromInput(value) {
  const text = String(value ?? "").trim();
  const match = EFFECTIVE_FROM_RE.exec(text);
  if (!match) {
    return { ok: false, error: "must be an ISO date-time with an explicit offset (Z or ±hh:mm)" };
  }
  const ms = Date.parse(text);
  const offset_m = match[2] === "Z"
    ? 0
    : (match[3] === "-" ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]));
  // A rolled-over date (Feb 30, 24:00) no longer matches its own wall clock.
  const local = Number.isFinite(ms) ? new Date(ms + offset_m * 60_000).toISOString().slice(0, 16) : "";
  if (local !== match[1]) return { ok: false, error: "is not a valid date-time" };
  if (ms % QUARTER_HOUR_MS !== 0) return { ok: false, error: "must fall on a 15-minute boundary in UTC" };
  return { ok: true, ms };
}

// "1 Jan 2027, 00:00" in the display (server) zone.
export function formatTariffInstant(ms) {
  return new Date(ms).toLocaleString("en-GB", withDisplayTimeZone({
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }));
}

// Where market prices come from, by the server's rule (isMarketSourceConfigured
// in api/services/config-builder.ts): "sensor" (the HA export market-price
// sensor), "data" (API prices: a marketPrice series posted to /data, which
// the form cannot see, so it is only a possible source) or "none" (VRM).
function marketSource(pricesSource, exportSensor) {
  if (pricesSource === "ha") return String(exportSensor ?? "").trim() !== "" ? "sensor" : "none";
  return pricesSource === "api" ? "data" : "none";
}

/**
 * The status line for the export-tariff settings, mirroring how the server
 * resolves them (resolveExportPrices): `auto` switches to market prices at
 * `effectiveFrom` only when a market-price source exists. With API prices that
 * depends on a posted series the form cannot see, so it never claims "active".
 * → { text, tone } with tone one of neutral | ok | warn | error.
 */
export function describeExportTariffStatus({ mode, effectiveFrom, pricesSource, exportSensor, nowMs }) {
  if (mode === "netMetering") {
    return { tone: "neutral", text: "Net metering: export valued at the import price" };
  }
  const source = marketSource(pricesSource, exportSensor);
  if (mode === "marketPrice") {
    if (source === "none") {
      return { tone: "warn", text: "Market-price export, but no market-price source is configured: export valued at 0" };
    }
    if (source === "data") {
      return { tone: "neutral", text: "Market-price export from the marketPrice posted to /data (export valued at 0 without one)" };
    }
    return { tone: "ok", text: "Market-price export active" };
  }

  const parsed = parseEffectiveFromInput(effectiveFrom);
  if (source === "none") {
    const near = parsed.ok && nowMs >= parsed.ms - MISSING_SOURCE_LEAD_MS;
    const what = pricesSource === "ha" ? "sensor" : "source";
    return { tone: near ? "warn" : "neutral", text: `Net metering (no market-price ${what} configured)` };
  }
  if (!parsed.ok) return { tone: "error", text: `End time ${parsed.error}` };
  const when = formatTariffInstant(parsed.ms);
  if (source === "data") {
    const verb = nowMs < parsed.ms ? "switches" : "switched";
    return { tone: "neutral", text: `Net metering ${verb} to market-price export at ${when} only if marketPrice is posted to /data` };
  }
  if (nowMs < parsed.ms) return { tone: "neutral", text: `Net metering active until ${when}` };
  return { tone: "ok", text: `Market-price export active since ${when}` };
}

function showText(el, text, tone, baseClass) {
  el.textContent = text;
  el.className = `${baseClass} ${TONE_CLASSES[tone]}`;
}

// Refresh the card's derived parts from the form: the tail-hours field is
// only used by the tailMin valuation, the hint shows the switch instant in
// the server's zone, and the status line says which rule applies now.
export function updateExportTariffUI(els, nowMs = serverNowMs()) {
  if (els.exportTariffTail) {
    els.exportTariffTail.disabled = (els.exportTariffTerminal?.value || "tailMin") !== "tailMin";
  }
  const effectiveFrom = els.exportTariffEffectiveFrom?.value ?? EXPORT_TARIFF_DEFAULT_EFFECTIVE_FROM;

  if (els.exportTariffEffectiveFromHint) {
    const parsed = parseEffectiveFromInput(effectiveFrom);
    const zone = getDisplayTimeZone() ?? "browser time";
    if (parsed.ok) {
      showText(els.exportTariffEffectiveFromHint, `${formatTariffInstant(parsed.ms)} (${zone})`, "neutral", "mt-1 block text-xs");
    } else {
      showText(els.exportTariffEffectiveFromHint, `End time ${parsed.error}`, "error", "mt-1 block text-xs");
    }
  }

  if (els.exportTariffStatus) {
    const { text, tone } = describeExportTariffStatus({
      mode: els.exportTariffMode?.value || "auto",
      effectiveFrom,
      pricesSource: els.sourcePrices?.value,
      exportSensor: els.haPriceExportSensor?.value,
      nowMs,
    });
    showText(els.exportTariffStatus, text, tone, "text-xs font-medium");
  }
}
