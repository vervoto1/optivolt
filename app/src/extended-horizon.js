import { fmtZonedHHMM, fmtZonedWeekday, withDisplayTimeZone } from "./time-zone.js";

// Multi-day horizon card: the status line saying how far the last plan
// reaches and where forecast prices take over. The server validates and
// applies the settings and reports what it did in summary.extendedHorizon;
// this only explains it.

// Mirrors EXTENDED_HORIZON_DEFAULTS in api/services/settings-schema.ts.
export const EXTENDED_HORIZON_DEFAULTS = Object.freeze({
  mode: "off",
  extraDays: 3,
  forecastUrl: "https://epexpredictor.batzill.com",
  region: "NL",
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1.0,
  refreshMinutes: 60,
});

const TONE_CLASSES = {
  neutral: "text-slate-600 dark:text-slate-400",
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
};

// The last summary.extendedHorizon seen (null: no plan reported one).
let lastInfo = null;

// "Fri 17 Oct" in the display (server) zone.
export function formatHorizonDay(ms) {
  return new Date(ms).toLocaleDateString("en-GB", withDisplayTimeZone({
    weekday: "short",
    day: "numeric",
    month: "short",
  }));
}

// "Wed 00:00" in the display (server) zone.
export function formatHorizonInstant(ms) {
  return `${fmtZonedWeekday(ms)} ${fmtZonedHHMM(ms)}`;
}

function formatFit(fit) {
  const a = Number(fit?.a);
  const b = Number(fit?.b);
  if (fit?.a == null || fit?.b == null || !Number.isFinite(a) || !Number.isFinite(b)) return "";
  const which = fit.source === "stored" ? "stored fit" : "fit";
  return `; ${which} a ${a.toFixed(2)}, b ${b.toFixed(1)} c`;
}

/**
 * The status line for the multi-day horizon.
 * `mode` is the form's mode; `info` is the last plan's summary.extendedHorizon
 * ({ mode: "on", firmEndMs, endMs, extendedSlots, fit?: { a, b, source },
 * status: "extended" | "firmOnly", reason? }), or null. The server reports it
 * only in `on` mode, and a plan made before the form switched to `on` says
 * nothing about it yet.
 * → { text, tone } with tone one of neutral | ok | warn.
 */
export function describeExtendedHorizonStatus({ mode, info }) {
  if (mode === "collect") {
    return { tone: "neutral", text: "Collecting forecasts only: plans are unchanged" };
  }
  if (mode !== "on") {
    return { tone: "neutral", text: "Off: plans end where the published prices end" };
  }
  if (info?.mode !== "on") {
    return { tone: "neutral", text: "On: the next plan shows how far it reaches" };
  }

  const firmEndMs = Number(info.firmEndMs);
  const endMs = Number(info.endMs);
  if (info.status !== "extended" || !Number.isFinite(firmEndMs) || !Number.isFinite(endMs) || endMs <= firmEndMs) {
    const reason = typeof info.reason === "string" ? info.reason.trim() : "";
    return { tone: "warn", text: `Published prices only${reason ? `: ${reason}` : ""}` };
  }
  // endMs is exclusive: the plan's last slot ends there.
  return {
    tone: "ok",
    text: `Planning through ${formatHorizonDay(endMs - 1)} `
      + `(forecast prices after ${formatHorizonInstant(firmEndMs)}${formatFit(info.fit)})`,
  };
}

/**
 * Refresh the card's status line from the form's mode and the last plan's
 * summary.extendedHorizon. Pass `info` (an object or null) when a plan
 * arrives; leave it out to reuse the last one (a form change).
 */
export function updateExtendedHorizonUI(els, info) {
  if (info !== undefined) lastInfo = info && typeof info === "object" ? info : null;
  if (!els?.extendedHorizonStatus) return;
  const { text, tone } = describeExtendedHorizonStatus({
    mode: els.extendedHorizonMode?.value || EXTENDED_HORIZON_DEFAULTS.mode,
    info: lastInfo,
  });
  els.extendedHorizonStatus.textContent = text;
  els.extendedHorizonStatus.className = `text-xs font-medium ${TONE_CLASSES[tone]}`;
}
