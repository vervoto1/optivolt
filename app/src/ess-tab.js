/**
 * ess-tab.js
 *
 * Coordinator for the ESS dashboard tab. Lazily initialised the first time the
 * tab is activated (no HA traffic at startup). Builds per-battery cards from the
 * `/ess/state` response so it scales to N batteries, renders trend charts from
 * `/ess/history`, and polls live state on an interval while the tab is visible.
 *
 * Resilient by design: a 422 (HA unconfigured / ESS disabled) shows a friendly
 * empty state instead of throwing, and an entity that resolves to `null`
 * (renamed/dropped sensor) renders an explicit placeholder rather than blanking
 * the tab.
 */

import { getEssState, getEssHistory } from "./api/api.js";
import {
  renderCellSnapshot,
  renderLineChart,
  cellColor,
  batteryColor,
} from "./ess-charts.js";

// ---------- Module state ----------
let refreshTimer = null;
let views = []; // per-battery DOM refs, index-aligned with the state response

// ---------- Small DOM helpers ----------
function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function byId(id) {
  return document.getElementById(id);
}

// ---------- Value formatting ----------
const MISSING_HTML =
  '<span class="ess-missing text-slate-400 dark:text-slate-600" title="Sensor unavailable or not found">—</span>';

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function formatScalar(scalar) {
  if (!scalar || scalar.value == null || !Number.isFinite(scalar.value)) return MISSING_HTML;
  const unit = scalar.unit ? ` ${escapeHtml(scalar.unit)}` : "";
  return `${formatNumber(scalar.value)}${unit}`;
}

function formatExtra(extra) {
  if (!extra || extra.value == null || extra.value === "") return MISSING_HTML;
  const unit = extra.unit ? ` ${escapeHtml(extra.unit)}` : "";
  return `${escapeHtml(extra.value)}${unit}`;
}

function formatBalancing(value) {
  if (value == null) return MISSING_HTML;
  const on = value === "on" || value === "true";
  const cls = on ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500";
  return `<span class="${cls}">${on ? "On" : "Off"}</span>`;
}

function tileHtml(label, valueHtml) {
  return `<div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${valueHtml}</div></div>`;
}

const BATTERY_SCALAR_SPEC = [
  { key: "soc", label: "SoC" },
  { key: "capacityRemaining", label: "Capacity left" },
  { key: "capacitySetting", label: "Capacity" },
  { key: "totalVoltage", label: "Total voltage" },
  { key: "current", label: "Pack current" },
  { key: "chargingPower", label: "Charging" },
  { key: "dischargingPower", label: "Discharging" },
  { key: "minCellVoltage", label: "Min cell" },
  { key: "maxCellVoltage", label: "Max cell" },
  { key: "balancingCurrent", label: "Balancing I" },
];

const SYSTEM_SCALAR_SPEC = [
  { key: "soc", label: "System SoC" },
  { key: "batteryPower", label: "Battery power" },
  { key: "batteryCurrent", label: "DC current" },
  { key: "batteryVoltage", label: "DC voltage" },
  { key: "maxChargeCurrent", label: "Max charge I" },
];

// ---------- Chart overlay ----------
function setChartMessage(canvas, message) {
  const overlay = canvas?.parentElement?.querySelector(".chart-empty");
  if (!overlay) return;
  overlay.style.display = "";
  const span = overlay.querySelector("span");
  if (span && message) span.textContent = message;
}

// ---------- Skeleton (built once per battery count) ----------
function buildBatteryCard(name) {
  return el(`
    <section class="card revealed">
      <div class="flex items-center justify-between mb-3">
        <h3 class="sidebar-label">${escapeHtml(name)}</h3>
        <span data-soc class="hidden rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 px-2.5 py-0.5 text-sm font-semibold"></span>
      </div>
      <div class="grid gap-6 lg:grid-cols-3">
        <div data-overview class="lg:col-span-1 grid grid-cols-2 gap-x-4 gap-y-2.5 self-start"></div>
        <div class="lg:col-span-2 space-y-4 min-w-0">
          <div>
            <div class="stat-label mb-1">Cell voltages — now</div>
            <div class="h-44 w-full chart-wrap">
              <canvas data-snapshot class="h-full w-full"></canvas>
              <div class="chart-empty"><span>Waiting for data…</span></div>
            </div>
          </div>
          <div>
            <div class="stat-label mb-1">Cell voltages — trend</div>
            <div class="h-44 w-full chart-wrap">
              <canvas data-trend class="h-full w-full"></canvas>
              <div class="chart-empty"><span>Waiting for data…</span></div>
            </div>
          </div>
          <div>
            <div class="stat-label mb-1">Temperatures — trend</div>
            <div class="h-44 w-full chart-wrap">
              <canvas data-temp class="h-full w-full"></canvas>
              <div class="chart-empty"><span>Waiting for data…</span></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `);
}

function buildSkeleton(batteries) {
  const container = byId("ess-batteries");
  if (!container) return;
  container.innerHTML = "";
  views = batteries.map((battery) => {
    const card = buildBatteryCard(battery.name);
    container.appendChild(card);
    return {
      card,
      socChip: card.querySelector("[data-soc]"),
      overviewEl: card.querySelector("[data-overview]"),
      snapshotCanvas: card.querySelector("[data-snapshot]"),
      trendCanvas: card.querySelector("[data-trend]"),
      tempCanvas: card.querySelector("[data-temp]"),
    };
  });
}

// ---------- State rendering ----------
function renderBatteryState(battery, view, index) {
  // SoC chip
  const soc = battery.scalars?.soc;
  /* v8 ignore next — view.socChip is always present: buildSkeleton populates it from a fixed card template, so the null-guard's false arm is unreachable */
  if (view.socChip) {
    if (soc && soc.value != null && Number.isFinite(soc.value)) {
      view.socChip.textContent = `${Math.round(soc.value)}%`;
      view.socChip.classList.remove("hidden");
    } else {
      view.socChip.classList.add("hidden");
    }
  }

  // Overview tiles
  /* v8 ignore next — view.overviewEl is always present (fixed card template); the null-guard's false arm is unreachable */
  if (view.overviewEl) {
    const tiles = BATTERY_SCALAR_SPEC.map((spec) => tileHtml(spec.label, formatScalar(battery.scalars?.[spec.key])));
    if (battery.balancing) tiles.push(tileHtml("Balancing", formatBalancing(battery.balancing.value)));
    for (const extra of battery.extras ?? []) tiles.push(tileHtml(extra.name, formatExtra(extra)));
    view.overviewEl.innerHTML = tiles.join("");
  }

  // Snapshot bars (re-rendered every poll to reflect the latest cell voltages)
  /* v8 ignore next — view.snapshotCanvas is always present (fixed card template); the null-guard's false arm is unreachable */
  if (view.snapshotCanvas) {
    const drawn = renderCellSnapshot(view.snapshotCanvas, battery.cells ?? [], batteryColor(index));
    if (!drawn) setChartMessage(view.snapshotCanvas, "Cell sensors not found");
  }
}

function renderSystem(state) {
  const card = byId("ess-system-card");
  const scalarsEl = byId("ess-system-scalars");
  const nameEl = byId("ess-system-name");
  if (!card || !scalarsEl) return;

  if (!state.system) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  card.classList.add("revealed");
  if (nameEl) nameEl.textContent = state.system.name;

  const tiles = SYSTEM_SCALAR_SPEC.map((spec) => tileHtml(spec.label, formatScalar(state.system.scalars?.[spec.key])));
  for (const extra of state.system.extras ?? []) tiles.push(tileHtml(extra.name, formatExtra(extra)));
  scalarsEl.innerHTML = tiles.join("");
}

function renderState(state) {
  const container = byId("ess-batteries");
  const batteries = state.batteries ?? [];
  // (Re)build the skeleton when the battery count changes or the DOM was reset.
  if (!container || container.childElementCount !== batteries.length || views.length !== batteries.length) {
    buildSkeleton(batteries);
  }
  batteries.forEach((battery, i) => {
    const view = views[i];
    if (view) renderBatteryState(battery, view, i);
  });
  renderSystem(state);
}

// ---------- History rendering ----------
function pointsFor(history, entity) {
  return history.series?.[entity]?.points ?? [];
}

function renderHistory(state, history) {
  const batteries = state.batteries ?? [];

  batteries.forEach((battery, i) => {
    const view = views[i];
    if (!view) return;

    // Cell voltage trends — one thin line per cell, legend hidden. Pin the axis
    // to the LiFePO4 operating window (~2.75–3.75 V) so normal cell variation is
    // visible instead of being flattened against a 0–4 V auto-range.
    const cells = battery.cells ?? [];
    const cellEntries = cells.map((cell, idx) => ({
      label: `Cell ${idx + 1}`,
      color: cellColor(idx, cells.length),
      points: pointsFor(history, cell.entity),
    }));
    const cellsDrawn = renderLineChart(view.trendCanvas, cellEntries, { yTitle: "V", yMin: 2.75, yMax: 3.75, showLegend: false });
    if (!cellsDrawn) setChartMessage(view.trendCanvas, "No trend data");

    // Temperature trends — legend shown, y pinned to the 20–80 °C operating band.
    const temps = battery.temperatures ?? [];
    const tempEntries = temps.map((temp, idx) => ({
      label: temp.name,
      color: cellColor(idx, Math.max(temps.length, 5)),
      points: pointsFor(history, temp.entity),
    }));
    const tempsDrawn = renderLineChart(view.tempCanvas, tempEntries, {
      yTitle: "°C", yMin: 20, yMax: 80, showLegend: true,
    });
    if (!tempsDrawn) setChartMessage(view.tempCanvas, "No trend data");
  });

  // Combined SoC development across batteries.
  const socCard = byId("ess-soc-card");
  const socCanvas = byId("ess-soc-chart");
  if (socCard) {
    socCard.classList.remove("hidden");
    socCard.classList.add("revealed");
  }
  const socEntries = batteries
    .map((battery, i) => {
      const entity = battery.scalars?.soc?.entity;
      return entity ? { label: battery.name, color: batteryColor(i), points: pointsFor(history, entity) } : null;
    })
    .filter(Boolean);
  const socDrawn = renderLineChart(socCanvas, socEntries, { yTitle: "%", yMin: 0, yMax: 100, showLegend: true });
  if (!socDrawn) setChartMessage(socCanvas, "No SoC history");
}

// ---------- Empty / content states ----------
function showEmpty(message) {
  const empty = byId("ess-empty");
  const msg = byId("ess-empty-message");
  if (msg && message) msg.textContent = message;
  if (empty) empty.classList.remove("hidden");
  for (const id of ["ess-batteries", "ess-soc-card", "ess-system-card"]) {
    byId(id)?.classList.add("hidden");
  }
}

function showContent() {
  byId("ess-empty")?.classList.add("hidden");
  byId("ess-batteries")?.classList.remove("hidden");
}

// ---------- Polling lifecycle ----------
function stopPolling() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startPolling(seconds) {
  stopPolling();
  const intervalMs = Math.max(5, Number(seconds) || 30) * 1000;
  refreshTimer = setInterval(() => { void pollState(); }, intervalMs);
}

async function pollState() {
  let state;
  try {
    state = await getEssState();
  } catch {
    // Transient failure — keep the last good render rather than blanking the tab.
    return;
  }
  renderState(state);
}

// ---------- Public entry points ----------
/**
 * Activate the ESS tab: fetch live state + history, render, and (re)start the
 * live-state poll. Idempotent — safe to call on every activation. History is
 * (re)fetched here, not on the poll interval.
 */
export async function initEssTab() {
  const panel = byId("panel-ess");
  if (!panel) return;
  stopPolling();

  let state;
  let history;
  try {
    // History is best-effort: a stats/history failure must not blank the tab.
    [state, history] = await Promise.all([
      getEssState(),
      getEssHistory().catch(() => null),
    ]);
  } catch (err) {
    showEmpty(err?.message || "Home Assistant is not configured.");
    return;
  }

  showContent();
  renderState(state);
  if (history) renderHistory(state, history);
  startPolling(state.refreshIntervalSeconds);
}

/** Called when the ESS tab is deactivated — stops the live-state poll. */
export function deactivateEssTab() {
  stopPolling();
}
