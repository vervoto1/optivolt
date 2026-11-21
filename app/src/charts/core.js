/* global Chart */
import { dim } from './colors.js';
import { fmtZonedDDMM, fmtZonedHHMM, fmtZonedWeekday, spansMultipleDays, zonedParts } from '../time-zone.js';

export function fmtHHMM(dt) {
  return fmtZonedHHMM(dt);
}

function fmtTickHourOrDate(dt) {
  const { hour, minute } = zonedParts(dt);
  /* v8 ignore next — unreachable: fmtTickHourOrDate is only called via ticksCb when isLabeledHour(dt) is true, which already requires minutes === 0 */
  if (minute !== 0) return "";
  if (hour === 0) return fmtZonedDDMM(dt);
  return `${String(hour).padStart(2, "0")}:00`;
}

export function buildTimeAxisFromTimestamps(timestampsMs) {
  const times = timestampsMs.map(ms => new Date(ms));
  let hoursSpan = 0;
  if (times.length > 1) {
    hoursSpan = (times[times.length - 1] - times[0]) / (3600 * 1000);
  }

  const daysSpan = hoursSpan / 24;

  let labelEveryH = 3;
  const sparseMode = hoursSpan > 12;

  if (daysSpan > 2) {
    labelEveryH = 24;
  } else if (hoursSpan > 12) {
    labelEveryH = 4;
  } else {
    labelEveryH = 2;
  }

  function isMidnight(dt) { const p = zonedParts(dt); return p.hour === 0 && p.minute === 0; }
  function isFullMinute(dt) { return zonedParts(dt).minute === 0; }

  function isLabeledHour(dt) {
    if (isMidnight(dt)) return true;
    if (!isFullMinute(dt)) return false;
    return !sparseMode || (zonedParts(dt).hour % labelEveryH) === 0;
  }

  const labels = times.map(dt => fmtHHMM(dt));
  // Past 24 hours a clock time repeats, so the tooltip names the day too.
  const withWeekday = spansMultipleDays(timestampsMs);

  return {
    labels,
    timestampsMs,
    ticksCb: (_val, idx) => {
      const dt = times[idx];
      return (dt && isLabeledHour(dt)) ? fmtTickHourOrDate(dt) : "";
    },
    tooltipTitleCb: (items) => {
      const idx = items?.[0]?.dataIndex;
      if (!times[idx]) return "";
      return withWeekday ? `${fmtZonedWeekday(times[idx])} ${fmtHHMM(times[idx])}` : fmtHHMM(times[idx]);
    },
    gridCb: (ctx) => {
      const idx = ctx.index ?? ctx.tick?.index ?? ctx.tick?.value;
      if (idx == null || !times[idx]) return "transparent";
      const dt = times[idx];
      const { majorGridColor, minorGridColor } = getChartTheme();
      if (isMidnight(dt)) return majorGridColor;
      if (isLabeledHour(dt) && isFullMinute(dt)) return minorGridColor;
      return "transparent";
    }
  };
}

/**
 * Generates the standard Chart.js options object used by all charts.
 * Allows overriding specific sections via `overrides`.
 */
export function getBaseOptions({ ticksCb, tooltipTitleCb, gridCb, yTitle, stacked = false, timestampsMs }, overrides = {}) {
  const theme = getChartTheme();
  const fontFamily = getComputedStyle(document.documentElement).fontFamily;
  const { ticks: xTicks, grid: xGrid, ...xRest } = overrides.scales?.x || {};

  const legendSquare = {
    position: "bottom",
    labels: {
      color: theme.axisTickColor,
      usePointStyle: true,
      pointStyle: "rect",
      boxWidth: 10,
      padding: 12,
      font: { size: 12, family: fontFamily }
    }
  };
  const { legend: legendOverrides, tooltip: tooltipOverrides, ...pluginOverrides } = overrides.plugins || {};

  return {
    maintainAspectRatio: false,
    responsive: true,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { bottom: overrides.layout?.padding?.bottom ?? -6 } },
    ...('animation' in overrides ? { animation: overrides.animation } : {}),
    plugins: {
      legend: {
        ...legendSquare,
        ...(legendOverrides || {}),
        labels: {
          ...legendSquare.labels,
          ...(legendOverrides?.labels || {}),
        },
      },
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: { title: tooltipTitleCb },
        ...(tooltipOverrides || {}),
      },
      // Slot start times, so the shared crosshair can place one moment on every chart.
      ...(timestampsMs ? { [SHARED_CROSSHAIR_ID]: { timestampsMs } } : {}),
      ...pluginOverrides
    },
    scales: {
      x: {
        stacked,
        ...xRest,
        ticks: {
          color: theme.axisTickColor,
          callback: ticksCb,
          autoSkip: false,
          maxRotation: 0,
          minRotation: 0,
          ...(xTicks || {})
        },
        grid: { color: gridCb, drawTicks: true, ...(xGrid || {}) }
      },
      y: {
        stacked,
        beginAtZero: true,
        ticks: { color: theme.axisTickColor },
        grid: {
          color: theme.gridColor,
          drawTicks: false,
          zeroLineColor: theme.zeroLineColor
        },
        title: { display: !!yTitle, text: yTitle, color: theme.axisTickColor },
        ...(overrides.scales?.y || {})
      }
    }
  };
}

export function getChartTheme() {
  const dark = document.documentElement.classList.contains('dark');
  if (dark) {
    return {
      axisTickColor: 'rgba(226, 232, 240, 0.9)',
      gridColor: 'rgba(148, 163, 184, 0.28)',
      zeroLineColor: 'rgba(148, 163, 184, 0.6)',
      majorGridColor: 'rgba(226, 232, 240, 0.32)',
      minorGridColor: 'rgba(226, 232, 240, 0.10)',
    };
  }
  return {
    axisTickColor: 'rgba(71, 85, 105, 0.95)',
    gridColor: 'rgba(148, 163, 184, 0.22)',
    zeroLineColor: 'rgba(148, 163, 184, 0.6)',
    majorGridColor: 'rgba(0, 0, 0, 0.25)',
    minorGridColor: 'rgba(0, 0, 0, 0.08)',
  };
}

const chartRegistry = new Set();

// ---------------------------------------------------------------------------
// Shared crosshair: hovering one chart marks the same moment on all the others
// ---------------------------------------------------------------------------

const SHARED_CROSSHAIR_ID = "sharedCrosshair";
const SHARED_CROSSHAIR_KEY = "optivolt:sharedCrosshair";
const sharedCrosshair = { enabled: false, timeMs: null };

function crosshairTimestamps(chart) {
  // Read from the config we handed Chart.js: `chart.options` is a resolved proxy.
  return chart.config?.options?.plugins?.[SHARED_CROSSHAIR_ID]?.timestampsMs ?? null;
}

function repaintCrosshair(except) {
  for (const chart of chartRegistry) {
    if (chart !== except && chart.canvas?.isConnected && chart.chartArea?.width > 0) chart.draw();
  }
}

/** Turn the shared crosshair on or off. */
export function setSharedCrosshairEnabled(enabled) {
  sharedCrosshair.enabled = !!enabled;
  sharedCrosshair.timeMs = null;
  repaintCrosshair(null);
}

export function getStoredSharedCrosshair() {
  try {
    return localStorage.getItem(SHARED_CROSSHAIR_KEY) === "on";
  } catch {
    return false; // storage blocked (private mode etc.): off
  }
}

function storeSharedCrosshair(enabled) {
  try {
    localStorage.setItem(SHARED_CROSSHAIR_KEY, enabled ? "on" : "off");
  } catch { /* storage blocked: the choice just won't persist */ }
}

/**
 * Bind the crosshair checkbox: it starts from the stored choice (per browser,
 * off by default) and stores every change.
 */
export function initSharedCrosshairToggle(input) {
  if (!input) return;
  input.checked = getStoredSharedCrosshair();
  setSharedCrosshairEnabled(input.checked);
  input.addEventListener("change", () => {
    storeSharedCrosshair(input.checked);
    setSharedCrosshairEnabled(input.checked);
  });
}

export const sharedCrosshairPlugin = {
  id: SHARED_CROSSHAIR_ID,
  afterEvent(chart, args) {
    if (!sharedCrosshair.enabled) return;
    const times = crosshairTimestamps(chart);
    if (!times?.length) return;
    const { type, x } = args.event;
    let timeMs;
    if (type === "mouseout") {
      timeMs = null;
    } else if ((type === "mousemove" || type === "touchstart" || type === "touchmove") && args.inChartArea) {
      const idx = Math.round(chart.scales.x.getValueForPixel(x));
      timeMs = times[Math.max(0, Math.min(times.length - 1, idx))];
    } else {
      return;
    }
    if (timeMs === sharedCrosshair.timeMs) return;
    sharedCrosshair.timeMs = timeMs;
    args.changed = true;
    repaintCrosshair(chart);
  },
  afterDatasetsDraw(chart) {
    const timeMs = sharedCrosshair.timeMs;
    if (!sharedCrosshair.enabled || timeMs == null) return;
    const times = crosshairTimestamps(chart);
    const xScale = chart.scales?.x;
    // A slot's width comes from its neighbour, so a one-slot chart has nothing to place by.
    if (!(times?.length > 1) || !xScale) return;
    // Last slot starting at or before the moment; charts can differ in resolution (15 min vs
    // 1 h bars), so the line sits proportionally between two slots rather than snapping.
    let i = -1;
    for (let k = 0; k < times.length && times[k] <= timeMs; k++) i = k;
    const step = times[1] - times[0];
    if (i < 0 || timeMs >= times[times.length - 1] + step) return;
    const from = xScale.getPixelForValue(i);
    // The last slot has no next tick: assume it is as wide as the one before it.
    const to = i + 1 < times.length
      ? xScale.getPixelForValue(i + 1)
      : 2 * from - xScale.getPixelForValue(i - 1);
    const span = (times[i + 1] ?? times[i] + step) - times[i];
    const xPx = from + ((timeMs - times[i]) / span) * (to - from);

    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = getChartTheme().axisTickColor;
    ctx.moveTo(xPx, chartArea.top);
    ctx.lineTo(xPx, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function updateLegendTheme(options, theme, fontFamily) {
  const legend = options.plugins?.legend;
  if (!legend) return;
  legend.labels = {
    ...(legend.labels || {}),
    color: theme.axisTickColor,
    font: {
      ...(legend.labels?.font || {}),
      family: fontFamily,
    },
  };
}

function updateScaleTheme(scaleOptions, theme, scaleId) {
  if (!scaleOptions) return;

  if (scaleId !== "y2") {
    scaleOptions.ticks = {
      ...(scaleOptions.ticks || {}),
      color: theme.axisTickColor,
    };
  }

  if (scaleOptions.title) {
    scaleOptions.title = {
      ...scaleOptions.title,
      color: theme.axisTickColor,
    };
  }

  if (scaleOptions.grid) {
    scaleOptions.grid = {
      ...scaleOptions.grid,
      ...(typeof scaleOptions.grid.color === "function" ? {} : { color: theme.gridColor }),
      ...(Object.hasOwn(scaleOptions.grid, "zeroLineColor") ? { zeroLineColor: theme.zeroLineColor } : {}),
    };
  }
}

function getRenderedCharts() {
  const charts = new Set();
  for (const chart of chartRegistry) {
    if (chart?.canvas?.isConnected) charts.add(chart);
    else chartRegistry.delete(chart);
  }
  // Pick up charts created directly with new Chart(...) outside renderChart (e.g. predictions-validation.js)
  /* v8 ignore next — environment guard: document is always defined in the browser/jsdom contexts this runs in */
  if (typeof document !== "undefined") {
    for (const canvas of document.querySelectorAll("canvas")) {
      const chart = canvas._chart || Chart.getChart?.(canvas);
      if (chart) charts.add(chart);
    }
  }
  return charts;
}

export function refreshAllChartThemes() {
  const theme = getChartTheme();
  const fontFamily = getComputedStyle(document.documentElement).fontFamily;

  for (const chart of getRenderedCharts()) {
    // Recolour config.options, the object Chart.js resolves from on update.
    // chart.options is the resolved view: there a scriptable x-axis colour
    // reads back as the string it last returned, so the callback would be
    // overwritten with one colour and a line drawn at every slot.
    const options = chart.config?.options ?? chart.options ?? {};
    updateLegendTheme(options, theme, fontFamily);

    for (const [scaleId, scaleOptions] of Object.entries(options.scales || {})) {
      updateScaleTheme(scaleOptions, theme, scaleId);
    }

    chart.update("none");
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("optivolt:themechange", refreshAllChartThemes);
}

/**
 * Clear the hover state (tooltip, highlighted bars, shared crosshair) of every chart except
 * `except`. On a touch screen a tap leaves the tooltip up, as there is no "mouse leaves" to
 * clear it; this is what takes it down again.
 */
export function dismissChartHighlights(except) {
  for (const chart of getRenderedCharts()) {
    if (chart === except) continue;
    const active = chart.getActiveElements?.().length || chart.tooltip?.getActiveElements?.().length;
    if (!active) continue;
    chart.setActiveElements([]);
    chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
    chart.update("none");
  }
  if (!except && sharedCrosshair.timeMs != null) {
    sharedCrosshair.timeMs = null;
    repaintCrosshair(null);
  }
}

/* v8 ignore next — environment guard: document is always defined in the browser/jsdom contexts this runs in */
if (typeof document !== "undefined") {
  // A tap or click anywhere but on a chart closes the open tooltips; one on a chart closes the
  // others. Scrolling closes them too, so a tooltip never rides along over unrelated content.
  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof HTMLCanvasElement ? event.target : null;
    const hit = target ? (target._chart ?? (typeof Chart !== "undefined" ? Chart.getChart?.(target) : null) ?? null) : null;
    dismissChartHighlights(hit);
  }, { passive: true });
  window.addEventListener("scroll", () => dismissChartHighlights(null), { passive: true, capture: true });
}

/**
 * Handles the destruction of old chart instances and creation of new ones.
 */
export function renderChart(canvas, config) {
  if (canvas._chart) {
    chartRegistry.delete(canvas._chart);
    canvas._chart.destroy();
  }
  canvas._chart = new Chart(canvas.getContext("2d"), {
    ...config,
    plugins: [...(config.plugins ?? []), sharedCrosshairPlugin],
  });
  chartRegistry.add(canvas._chart);
  const overlay = canvas.parentElement?.querySelector('.chart-empty');
  if (overlay) overlay.style.display = 'none';
}

export const dsBar = (label, data, color, stack) => ({
  label, data, stack,
  type: "bar",
  backgroundColor: color,
  hoverBackgroundColor: dim(color),
  borderColor: color,
  borderWidth: 0.5
});
