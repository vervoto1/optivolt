/**
 * ess-charts.js
 *
 * Chart.js helpers for the ESS dashboard tab. Kept separate from ess-tab.js so
 * the tab's DOM-building logic can be unit-tested with these mocked out (the
 * vendored Chart global is not available under jsdom).
 */

import { renderChart, getBaseOptions, buildTimeAxisFromTimestamps } from "./charts/core.js";
import { SOLUTION_COLORS, toRGBA } from "./charts/colors.js";
import { createTooltipHandler, ttHeader, ttRow } from "./chart-tooltip.js";

/** Distinguishable per-battery line colours, with a hue-rotation fallback. */
export const BATTERY_COLORS = [
  SOLUTION_COLORS.soc,   // blue
  SOLUTION_COLORS.pv2b,  // green
  SOLUTION_COLORS.pv2g,  // amber
  SOLUTION_COLORS.g2l,   // red
];

export function batteryColor(index) {
  /* v8 ignore next — the `?? cellColor` fallback is unreachable: index % length is always a valid in-range index, so the array access never yields undefined */
  return BATTERY_COLORS[index % BATTERY_COLORS.length] ?? cellColor(index, BATTERY_COLORS.length);
}

/** Rotate hue so up to N cells get visually distinct colours (palette has no 16-ramp). */
export function cellColor(index, count) {
  const hue = Math.round((300 * index) / Math.max(1, count));
  return `hsl(${hue}, 72%, 52%)`;
}

/**
 * Merge a list of `{ label, color, points: [{t, v}] }` series onto one shared,
 * sorted time axis. Series with differing timestamps (statistics vs. raw-history
 * fallback) align by timestamp; gaps become `null` (drawn with spanGaps).
 */
export function buildUnifiedSeries(entries) {
  const tset = new Set();
  for (const entry of entries) {
    for (const point of entry.points ?? []) tset.add(point.t);
  }
  const timestamps = [...tset].sort((a, b) => a - b);
  const indexByT = new Map(timestamps.map((t, i) => [t, i]));

  const datasets = entries.map((entry) => {
    const data = new Array(timestamps.length).fill(null);
    for (const point of entry.points ?? []) {
      const i = indexByT.get(point.t);
      /* v8 ignore next — i is never null: every point.t was added to the timestamp set, so indexByT always resolves it */
      if (i != null) data[i] = point.v;
    }
    return { label: entry.label, color: entry.color, data };
  });

  return { timestamps, datasets };
}

/** Rows that fit one column; beyond this the HTML tooltip lays rows out in two. */
const TOOLTIP_SINGLE_COLUMN_MAX = 8;

/**
 * Tooltip body for a multi-series chart: one row per series at the hovered
 * index. Rows wrap into a two-column grid (column-major, so Cells 1–8 read
 * down the left column) once the series list gets tall.
 */
export function seriesTooltipContent(datasets, { unit = "", decimals = 2 } = {}) {
  const suffix = unit ? ` ${unit}` : "";
  return (idx, tooltip) => {
    const rows = datasets.map((d) => {
      const v = d.data[idx];
      return ttRow(d.color, d.label, v == null ? "—" : `${v.toFixed(decimals)}${suffix}`);
    });
    const body = rows.length > TOOLTIP_SINGLE_COLUMN_MAX
      ? `<div class="ov-tt-cols" style="grid-template-rows:repeat(${Math.ceil(rows.length / 2)},auto)">${rows.join("")}</div>`
      : rows.join("");
    return ttHeader(tooltip.title?.[0] ?? "") + body;
  };
}

/**
 * Generic multi-series line chart over a time axis. Returns false (leaving the
 * `.chart-empty` overlay visible) when there is nothing to plot.
 *
 * `opts.tooltip` ({ unit, decimals }) swaps the built-in canvas tooltip for the
 * shared external HTML one. The canvas tooltip is clipped by the canvas, so on
 * a chart with many series (16 cell voltages in an 11rem-tall chart) only the
 * first ~9 rows were visible; the HTML tooltip overflows the chart freely.
 */
export function renderLineChart(canvas, entries, opts = {}) {
  if (!canvas) return false;
  const { timestamps, datasets } = buildUnifiedSeries(entries);
  if (timestamps.length === 0) return false;

  const axis = buildTimeAxisFromTimestamps(timestamps);
  const chartDatasets = datasets.map((d) => ({
    label: d.label,
    data: d.data,
    borderColor: d.color,
    backgroundColor: toRGBA(d.color, 0.12),
    borderWidth: 1.2,
    pointRadius: 0,
    tension: 0.25,
    spanGaps: true,
  }));

  const yScale = {};
  if (opts.yMin != null) yScale.min = opts.yMin;
  if (opts.yMax != null) yScale.max = opts.yMax;

  const options = getBaseOptions(
    { ticksCb: axis.ticksCb, tooltipTitleCb: axis.tooltipTitleCb, gridCb: axis.gridCb, yTitle: opts.yTitle },
    {
      animation: false,
      plugins: {
        legend: opts.showLegend ? {} : { display: false },
        ...(opts.tooltip
          ? { tooltip: { enabled: false, external: createTooltipHandler({ renderContent: seriesTooltipContent(datasets, opts.tooltip) }) } }
          : {}),
      },
      scales: { y: yScale },
    },
  );

  renderChart(canvas, { type: "line", data: { labels: axis.labels, datasets: chartDatasets }, options });
  return true;
}

/**
 * Snapshot bar chart of current per-cell voltages. The y-axis zooms around the
 * observed range (cell voltages cluster ~3.0–3.6 V, so a zero-based axis would
 * flatten the differences that matter).
 */
export function renderCellSnapshot(canvas, cells, color = SOLUTION_COLORS.soc) {
  if (!canvas) return false;
  const values = cells.map((c) => c.value).filter((v) => v != null && Number.isFinite(v));
  if (values.length === 0) return false;

  const labels = cells.map((_c, i) => `${i + 1}`);
  const data = cells.map((c) => c.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(0.02, (max - min) * 0.35);

  const options = getBaseOptions(
    {
      ticksCb: (_v, i) => labels[i],
      tooltipTitleCb: (items) => `Cell ${(items?.[0]?.dataIndex ?? 0) + 1}`,
      gridCb: () => "transparent",
      yTitle: "V",
    },
    {
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { autoSkip: false } },
        y: { beginAtZero: false, min: Math.max(0, min - pad), max: max + pad },
      },
    },
  );

  renderChart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Cell voltage",
        data,
        backgroundColor: toRGBA(color, 0.75),
        borderColor: color,
        borderWidth: 0.5,
      }],
    },
    options,
  });
  return true;
}
