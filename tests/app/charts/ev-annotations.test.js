// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// core.js exports fmtHHMM (used for the departure label). Mock it so the label
// is deterministic regardless of test timezone.
vi.mock('../../../app/src/charts/core.js', () => ({
  fmtHHMM: vi.fn((dt) => `HH:MM(${dt.getTime()})`),
}));

import {
  findDepartureSlotIdx,
  makeEvDeparturePlugin,
  makeEvTargetPlugin,
} from '../../../app/src/charts/ev-annotations.js';
import { fmtHHMM } from '../../../app/src/charts/core.js';

// A canvas 2d context recorder. Each method pushes its call onto `calls`.
function makeCtx() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    setLineDash: rec('setLineDash'),
    fillText: rec('fillText'),
    set strokeStyle(v) { calls.push(['strokeStyle', v]); },
    set lineWidth(v) { calls.push(['lineWidth', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set font(v) { calls.push(['font', v]); },
    set textAlign(v) { calls.push(['textAlign', v]); },
  };
}

function makeChart(ctx, { chartArea = { top: 0, bottom: 100, left: 10, right: 200 }, xPx = 50, yPx = 30 } = {}) {
  return {
    ctx,
    chartArea,
    scales: {
      x: { getPixelForValue: vi.fn(() => xPx) },
      y: { getPixelForValue: vi.fn(() => yPx) },
    },
  };
}

const rows = [
  { timestampMs: 1000 },
  { timestampMs: 2000 },
  { timestampMs: 3000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findDepartureSlotIdx', () => {
  it('returns -1 when no departure time is given', () => {
    expect(findDepartureSlotIdx(rows, undefined)).toBe(-1);
    expect(findDepartureSlotIdx(rows, null)).toBe(-1);
    expect(findDepartureSlotIdx(rows, '')).toBe(-1);
  });

  it('returns the first slot at or after the departure timestamp', () => {
    // departure at ms 2000 -> first row with timestampMs >= 2000 is index 1
    expect(findDepartureSlotIdx(rows, new Date(2000).toISOString())).toBe(1);
    // departure right before slot 2
    expect(findDepartureSlotIdx(rows, new Date(2001).toISOString())).toBe(2);
    // departure at or before the first slot
    expect(findDepartureSlotIdx(rows, new Date(500).toISOString())).toBe(0);
  });

  it('returns -1 when the departure is after every slot', () => {
    expect(findDepartureSlotIdx(rows, new Date(9999).toISOString())).toBe(-1);
  });
});

describe('makeEvDeparturePlugin', () => {
  it('returns null when the departure slot is not found', () => {
    expect(makeEvDeparturePlugin(rows, undefined)).toBeNull();
    expect(makeEvDeparturePlugin(rows, new Date(9999).toISOString())).toBeNull();
  });

  it('builds a plugin with the formatted departure label', () => {
    const depIso = new Date(2000).toISOString();
    const plugin = makeEvDeparturePlugin(rows, depIso);
    expect(plugin).not.toBeNull();
    expect(plugin.id).toBe('evDeparture');
    expect(typeof plugin.afterDatasetsDraw).toBe('function');
    // The label is derived via fmtHHMM(new Date(departureTime)).
    expect(fmtHHMM).toHaveBeenCalledWith(new Date(depIso));
  });

  it('does nothing when chartArea is missing', () => {
    const ctx = makeCtx();
    const plugin = makeEvDeparturePlugin(rows, new Date(2000).toISOString());
    const chart = makeChart(ctx, { chartArea: null });
    plugin.afterDatasetsDraw(chart);
    expect(ctx.calls).toEqual([]);
  });

  it('draws a dashed vertical line and label at the departure slot', () => {
    const ctx = makeCtx();
    const depIso = new Date(2000).toISOString(); // index 1
    const plugin = makeEvDeparturePlugin(rows, depIso);
    const chart = makeChart(ctx, { xPx: 77 });

    plugin.afterDatasetsDraw(chart);

    // Resolved the pixel for the departure slot index (1).
    expect(chart.scales.x.getPixelForValue).toHaveBeenCalledWith(1);

    const names = ctx.calls.map((c) => c[0]);
    expect(names).toContain('save');
    expect(names).toContain('restore');
    expect(names).toContain('stroke');

    const color = 'rgba(16, 185, 129, 0.75)';
    expect(ctx.calls).toContainEqual(['strokeStyle', color]);
    expect(ctx.calls).toContainEqual(['lineWidth', 1.5]);
    expect(ctx.calls).toContainEqual(['setLineDash', [4, 4]]);
    // Vertical line spans the chart area at the departure x.
    expect(ctx.calls).toContainEqual(['moveTo', 77, 0]);
    expect(ctx.calls).toContainEqual(['lineTo', 77, 100]);
    // Dash reset before the label.
    expect(ctx.calls).toContainEqual(['setLineDash', []]);
    expect(ctx.calls).toContainEqual(['fillStyle', color]);
    expect(ctx.calls).toContainEqual(['textAlign', 'center']);
    // Label drawn near the top of the chart at the departure x.
    expect(ctx.calls).toContainEqual(['fillText', `HH:MM(${new Date(depIso).getTime()})`, 77, 10]);
  });
});

describe('makeEvTargetPlugin', () => {
  it('returns null when departure time is missing', () => {
    expect(makeEvTargetPlugin(rows, undefined, 80)).toBeNull();
  });

  it('returns null when target SoC is not positive', () => {
    const depIso = new Date(2000).toISOString();
    expect(makeEvTargetPlugin(rows, depIso, 0)).toBeNull();
    expect(makeEvTargetPlugin(rows, depIso, -5)).toBeNull();
    expect(makeEvTargetPlugin(rows, depIso, undefined)).toBeNull();
  });

  it('builds a plugin with a draw hook', () => {
    const plugin = makeEvTargetPlugin(rows, new Date(2000).toISOString(), 80);
    expect(plugin).not.toBeNull();
    expect(plugin.id).toBe('evTarget');
    expect(typeof plugin.afterDatasetsDraw).toBe('function');
  });

  it('does nothing when chartArea is missing', () => {
    const ctx = makeCtx();
    const plugin = makeEvTargetPlugin(rows, new Date(2000).toISOString(), 80);
    plugin.afterDatasetsDraw(makeChart(ctx, { chartArea: null }));
    expect(ctx.calls).toEqual([]);
  });

  it('draws a horizontal target line plus a departure line when the slot exists', () => {
    const ctx = makeCtx();
    const depIso = new Date(2000).toISOString(); // index 1
    const plugin = makeEvTargetPlugin(rows, depIso, 80);
    const chart = makeChart(ctx, { xPx: 88, yPx: 42 });

    plugin.afterDatasetsDraw(chart);

    expect(chart.scales.y.getPixelForValue).toHaveBeenCalledWith(80);
    expect(chart.scales.x.getPixelForValue).toHaveBeenCalledWith(1);

    // Horizontal target line across the full width at the target y.
    expect(ctx.calls).toContainEqual(['moveTo', 10, 42]);
    expect(ctx.calls).toContainEqual(['lineTo', 200, 42]);
    // Vertical departure line at the slot x.
    expect(ctx.calls).toContainEqual(['moveTo', 88, 0]);
    expect(ctx.calls).toContainEqual(['lineTo', 88, 100]);
    // Right-aligned percentage label above the target line.
    expect(ctx.calls).toContainEqual(['textAlign', 'right']);
    expect(ctx.calls).toContainEqual(['fillText', '80%', 196, 38]); // right-4, yPx-4
  });

  it('omits the departure line when no slot matches but still draws the target line', () => {
    const ctx = makeCtx();
    // departure after all slots -> depIdx is -1, target still positive
    const depIso = new Date(9999).toISOString();
    const plugin = makeEvTargetPlugin(rows, depIso, 90);
    const chart = makeChart(ctx, { yPx: 20 });

    plugin.afterDatasetsDraw(chart);

    // Target line is still drawn.
    expect(ctx.calls).toContainEqual(['moveTo', 10, 20]);
    expect(ctx.calls).toContainEqual(['lineTo', 200, 20]);
    // No departure x lookup happened (depIdx < 0).
    expect(chart.scales.x.getPixelForValue).not.toHaveBeenCalled();
    // Only the horizontal line was stroked (target), then the label.
    const strokeCount = ctx.calls.filter((c) => c[0] === 'stroke').length;
    expect(strokeCount).toBe(1);
    expect(ctx.calls).toContainEqual(['fillText', '90%', 196, 16]);
  });
});
