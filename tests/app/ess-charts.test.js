// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core.js so renderChart/getBaseOptions/buildTimeAxisFromTimestamps are
// spies. This lets us assert on the CONFIG object the module hands to
// renderChart without needing a real canvas/Chart instance. colors.js is left
// REAL so toRGBA / SOLUTION_COLORS produce genuine values.
vi.mock('../../app/src/charts/core.js', () => ({
  renderChart: vi.fn(),
  getBaseOptions: vi.fn((axisCbs, overrides) => ({ __axisCbs: axisCbs, __overrides: overrides })),
  buildTimeAxisFromTimestamps: vi.fn((timestamps) => ({
    labels: timestamps.map((t) => `L${t}`),
    ticksCb: () => 'tick',
    tooltipTitleCb: () => 'title',
    gridCb: () => 'grid',
  })),
}));

import {
  BATTERY_COLORS,
  batteryColor,
  cellColor,
  buildUnifiedSeries,
  renderLineChart,
  renderCellSnapshot,
} from '../../app/src/ess-charts.js';
import { renderChart, getBaseOptions, buildTimeAxisFromTimestamps } from '../../app/src/charts/core.js';
import { SOLUTION_COLORS, toRGBA } from '../../app/src/charts/colors.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BATTERY_COLORS / batteryColor / cellColor', () => {
  it('exposes the documented four-colour palette', () => {
    expect(BATTERY_COLORS).toEqual([
      SOLUTION_COLORS.soc,
      SOLUTION_COLORS.pv2b,
      SOLUTION_COLORS.pv2g,
      SOLUTION_COLORS.g2l,
    ]);
  });

  it('indexes the palette directly within range', () => {
    expect(batteryColor(0)).toBe(SOLUTION_COLORS.soc);
    expect(batteryColor(1)).toBe(SOLUTION_COLORS.pv2b);
    expect(batteryColor(3)).toBe(SOLUTION_COLORS.g2l);
  });

  it('wraps around the palette using modulo', () => {
    // index 4 wraps to index 0
    expect(batteryColor(4)).toBe(SOLUTION_COLORS.soc);
    expect(batteryColor(5)).toBe(SOLUTION_COLORS.pv2b);
  });

  it('cellColor rotates hue across the count', () => {
    expect(cellColor(0, 4)).toBe('hsl(0, 72%, 52%)');
    // hue = round(300 * 2 / 4) = 150
    expect(cellColor(2, 4)).toBe('hsl(150, 72%, 52%)');
    // hue = round(300 * 4 / 4) = 300
    expect(cellColor(4, 4)).toBe('hsl(300, 72%, 52%)');
  });

  it('cellColor guards against a zero count with Math.max(1, count)', () => {
    expect(cellColor(1, 0)).toBe('hsl(300, 72%, 52%)');
  });
});

describe('buildUnifiedSeries', () => {
  it('merges series onto a sorted shared time axis, filling gaps with null', () => {
    const entries = [
      { label: 'A', color: 'rgb(1, 2, 3)', points: [{ t: 30, v: 10 }, { t: 10, v: 5 }] },
      { label: 'B', color: 'rgb(4, 5, 6)', points: [{ t: 20, v: 7 }] },
    ];
    const { timestamps, datasets } = buildUnifiedSeries(entries);

    expect(timestamps).toEqual([10, 20, 30]);
    expect(datasets).toHaveLength(2);
    // A has points at 10 and 30, gap (null) at 20.
    expect(datasets[0]).toEqual({ label: 'A', color: 'rgb(1, 2, 3)', data: [5, null, 10] });
    // B has a point at 20 only.
    expect(datasets[1]).toEqual({ label: 'B', color: 'rgb(4, 5, 6)', data: [null, 7, null] });
  });

  it('treats a missing points array as empty (?? [])', () => {
    const entries = [
      { label: 'has', color: 'c1', points: [{ t: 100, v: 1 }] },
      { label: 'nopoints', color: 'c2' }, // points undefined
    ];
    const { timestamps, datasets } = buildUnifiedSeries(entries);
    expect(timestamps).toEqual([100]);
    expect(datasets[1]).toEqual({ label: 'nopoints', color: 'c2', data: [null] });
  });

  it('returns empty axis when there are no entries', () => {
    expect(buildUnifiedSeries([])).toEqual({ timestamps: [], datasets: [] });
  });

  it('ignores a point whose timestamp is not on the shared axis (indexByT miss is unreachable but guarded)', () => {
    // Every point's t is always added to tset, so indexByT.get never misses;
    // this just confirms duplicate timestamps collapse to a single column.
    const entries = [{ label: 'dup', color: 'c', points: [{ t: 5, v: 1 }, { t: 5, v: 2 }] }];
    const { timestamps, datasets } = buildUnifiedSeries(entries);
    expect(timestamps).toEqual([5]);
    expect(datasets[0].data).toEqual([2]); // last write wins
  });
});

describe('renderLineChart', () => {
  const entries = [
    { label: 'SoC', color: 'rgb(71, 144, 208)', points: [{ t: 1000, v: 40 }, { t: 2000, v: 55 }] },
  ];

  it('returns false and skips rendering when canvas is null', () => {
    expect(renderLineChart(null, entries)).toBe(false);
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('returns false when there are no timestamps to plot', () => {
    const canvas = document.createElement('canvas');
    expect(renderLineChart(canvas, [])).toBe(false);
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('renders a line chart with per-entry styling and returns true', () => {
    const canvas = document.createElement('canvas');
    const result = renderLineChart(canvas, entries, { showLegend: true, yTitle: 'kWh' });
    expect(result).toBe(true);

    expect(buildTimeAxisFromTimestamps).toHaveBeenCalledWith([1000, 2000]);
    expect(renderChart).toHaveBeenCalledTimes(1);

    const [passedCanvas, config] = renderChart.mock.calls[0];
    expect(passedCanvas).toBe(canvas);
    expect(config.type).toBe('line');
    expect(config.data.labels).toEqual(['L1000', 'L2000']);

    const ds = config.data.datasets[0];
    expect(ds.label).toBe('SoC');
    expect(ds.data).toEqual([40, 55]);
    expect(ds.borderColor).toBe('rgb(71, 144, 208)');
    expect(ds.backgroundColor).toBe(toRGBA('rgb(71, 144, 208)', 0.12));
    expect(ds.borderWidth).toBe(1.2);
    expect(ds.pointRadius).toBe(0);
    expect(ds.tension).toBe(0.25);
    expect(ds.spanGaps).toBe(true);
  });

  it('shows the legend when showLegend is true', () => {
    const canvas = document.createElement('canvas');
    renderLineChart(canvas, entries, { showLegend: true });
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.plugins.legend).toEqual({});
    expect(overrides.animation).toBe(false);
  });

  it('hides the legend when showLegend is falsy', () => {
    const canvas = document.createElement('canvas');
    renderLineChart(canvas, entries);
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.plugins.legend).toEqual({ display: false });
  });

  it('applies y-axis min/max from opts', () => {
    const canvas = document.createElement('canvas');
    renderLineChart(canvas, entries, { yMin: 0, yMax: 100 });
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y).toEqual({ min: 0, max: 100 });
  });

  it('leaves y-scale empty when no min/max supplied', () => {
    const canvas = document.createElement('canvas');
    renderLineChart(canvas, entries, {});
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y).toEqual({});
  });

  it('passes axis callbacks and yTitle into getBaseOptions', () => {
    const canvas = document.createElement('canvas');
    renderLineChart(canvas, entries, { yTitle: 'kWh' });
    const axisArg = getBaseOptions.mock.calls[0][0];
    expect(axisArg.yTitle).toBe('kWh');
    expect(typeof axisArg.ticksCb).toBe('function');
    expect(typeof axisArg.tooltipTitleCb).toBe('function');
    expect(typeof axisArg.gridCb).toBe('function');
  });
});

describe('renderCellSnapshot', () => {
  it('returns false when canvas is null', () => {
    expect(renderCellSnapshot(null, [{ value: 3.3 }])).toBe(false);
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('returns false when no finite values exist', () => {
    const canvas = document.createElement('canvas');
    expect(renderCellSnapshot(canvas, [{ value: null }, { value: NaN }, { value: undefined }])).toBe(false);
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('renders a zoomed bar chart of cell voltages and returns true', () => {
    const canvas = document.createElement('canvas');
    const cells = [{ value: 3.0 }, { value: 3.6 }, { value: 3.3 }];
    const result = renderCellSnapshot(canvas, cells);
    expect(result).toBe(true);

    const [passedCanvas, config] = renderChart.mock.calls[0];
    expect(passedCanvas).toBe(canvas);
    expect(config.type).toBe('bar');
    expect(config.data.labels).toEqual(['1', '2', '3']);
    expect(config.data.datasets[0].data).toEqual([3.0, 3.6, 3.3]);
    // Default colour is the SoC blue.
    expect(config.data.datasets[0].borderColor).toBe(SOLUTION_COLORS.soc);
    expect(config.data.datasets[0].backgroundColor).toBe(toRGBA(SOLUTION_COLORS.soc, 0.75));
  });

  it('zooms the y-axis around the observed range with padding', () => {
    const canvas = document.createElement('canvas');
    // range = 0.6, pad = max(0.02, 0.6 * 0.35) = 0.21
    renderCellSnapshot(canvas, [{ value: 3.0 }, { value: 3.6 }]);
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y.beginAtZero).toBe(false);
    expect(overrides.scales.y.min).toBeCloseTo(2.79, 5); // 3.0 - 0.21
    expect(overrides.scales.y.max).toBeCloseTo(3.81, 5); // 3.6 + 0.21
  });

  it('uses the minimum padding floor when the range is tiny', () => {
    const canvas = document.createElement('canvas');
    // identical values -> range 0 -> pad floor 0.02
    renderCellSnapshot(canvas, [{ value: 3.3 }, { value: 3.3 }]);
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y.min).toBeCloseTo(3.28, 5);
    expect(overrides.scales.y.max).toBeCloseTo(3.32, 5);
  });

  it('clamps the y-axis min at zero for very low voltages', () => {
    const canvas = document.createElement('canvas');
    // min 0.01, pad floor 0.02 -> 0.01 - 0.02 = -0.01 -> clamped to 0
    renderCellSnapshot(canvas, [{ value: 0.01 }, { value: 0.01 }]);
    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y.min).toBe(0);
  });

  it('accepts a custom bar colour', () => {
    const canvas = document.createElement('canvas');
    renderCellSnapshot(canvas, [{ value: 3.3 }], SOLUTION_COLORS.pv2b);
    const config = renderChart.mock.calls[0][1];
    expect(config.data.datasets[0].borderColor).toBe(SOLUTION_COLORS.pv2b);
    expect(config.data.datasets[0].backgroundColor).toBe(toRGBA(SOLUTION_COLORS.pv2b, 0.75));
  });

  it('wires x ticks and tooltip title callbacks for cell labels', () => {
    const canvas = document.createElement('canvas');
    renderCellSnapshot(canvas, [{ value: 3.1 }, { value: 3.2 }]);
    const axisArg = getBaseOptions.mock.calls[0][0];
    // ticksCb maps a (value, index) pair to the 1-based cell label.
    expect(axisArg.ticksCb(null, 1)).toBe('2');
    expect(axisArg.tooltipTitleCb([{ dataIndex: 0 }])).toBe('Cell 1');
    expect(axisArg.tooltipTitleCb([{ dataIndex: 2 }])).toBe('Cell 3');
    // tooltipTitleCb falls back to index 0 when items are missing.
    expect(axisArg.tooltipTitleCb()).toBe('Cell 1');
    expect(axisArg.tooltipTitleCb([{}])).toBe('Cell 1');
    expect(axisArg.gridCb()).toBe('transparent');
    expect(axisArg.yTitle).toBe('V');

    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.x).toEqual({ ticks: { autoSkip: false } });
    expect(overrides.plugins.legend).toEqual({ display: false });
    expect(overrides.animation).toBe(false);
  });
});
