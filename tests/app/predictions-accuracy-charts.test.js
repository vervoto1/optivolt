// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every renderChart call so we can inspect the Chart.js config that was built.
const renderChartCalls = [];

vi.mock('../../app/src/charts.js', () => ({
  renderChart: vi.fn((canvas, config) => {
    renderChartCalls.push({ canvas, config });
  }),
  getBaseOptions: vi.fn((axis, overrides) => ({ axis, overrides })),
  buildTimeAxisFromTimestamps: vi.fn((timestamps) => ({
    labels: timestamps.map((_, i) => `L${i}`),
    tooltipTitleCb: vi.fn(() => 'AXIS_TITLE'),
  })),
}));

// Capture the tooltip handler factory so we can drive renderContent directly.
const tooltipHandlers = [];

vi.mock('../../app/src/chart-tooltip.js', () => ({
  createTooltipHandler: vi.fn((arg) => {
    tooltipHandlers.push(arg);
    return `handler-${tooltipHandlers.length - 1}`;
  }),
  fmtKwh: vi.fn((v) => `K${v}`),
  getChartAnimations: vi.fn(() => ({ animation: false })),
  ttHeader: vi.fn((time) => `HEAD(${time})`),
  ttRow: vi.fn((color, label, value) => `ROW(${color}|${label}|${value})`),
  ttDivider: vi.fn(() => 'DIV'),
}));

import { renderLoadAccuracyChart, renderPvAccuracyChart } from '../../app/src/predictions/accuracy-charts.js';

function setupDom() {
  document.body.innerHTML = `
    <canvas id="load-accuracy-chart"></canvas>
    <canvas id="load-accuracy-diff-chart"></canvas>
    <div id="load-daily-net-error" class="hidden"></div>
    <canvas id="pv-accuracy-chart"></canvas>
    <canvas id="pv-accuracy-diff-chart"></canvas>
    <div id="pv-daily-net-error" class="hidden"></div>
  `;
}

beforeEach(() => {
  renderChartCalls.length = 0;
  tooltipHandlers.length = 0;
  vi.clearAllMocks();
  setupDom();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.classList.remove('dark');
});

// Two days of samples so the day-dividers plugin draws a divider between days.
function sampleData() {
  return [
    // Day 1 (2099-01-02 local)
    { time: Date.parse('2099-01-02T10:00:00.000Z'), actual: 2000, predicted: 2500 },
    { time: Date.parse('2099-01-02T11:00:00.000Z'), actual: 3000, predicted: 2000 },
    // Day 2 (2099-01-03 local)
    { time: Date.parse('2099-01-03T10:00:00.000Z'), actual: 1000, predicted: 1500 },
  ];
}

describe('accuracy-charts: renderLoadAccuracyChart', () => {
  it('does nothing when the overlay canvas is missing', () => {
    document.getElementById('load-accuracy-chart').remove();
    renderLoadAccuracyChart(sampleData());
    expect(renderChartCalls).toHaveLength(0);
  });

  it('does nothing when there is no data', () => {
    renderLoadAccuracyChart([]);
    renderLoadAccuracyChart(null);
    expect(renderChartCalls).toHaveLength(0);
  });

  it('builds overlay and diff charts with kWh-scaled datasets sorted by time', () => {
    // Pass data out of order to prove it gets sorted.
    const data = [
      { time: Date.parse('2099-01-03T10:00:00.000Z'), actual: 1000, predicted: 1500 },
      { time: Date.parse('2099-01-02T10:00:00.000Z'), actual: 2000, predicted: 2500 },
    ];
    renderLoadAccuracyChart(data);

    expect(renderChartCalls).toHaveLength(2);
    const [overlay, diff] = renderChartCalls;

    expect(overlay.canvas.id).toBe('load-accuracy-chart');
    expect(overlay.config.type).toBe('line');
    const [actualDs, predDs] = overlay.config.data.datasets;
    expect(actualDs.label).toBe('Actual');
    expect(predDs.label).toBe('Prediction');
    // Sorted ascending by time: 2099-01-02 first (2000 W -> 2 kWh), then 2099-01-03 (1000 -> 1).
    expect(actualDs.data).toEqual([2, 1]);
    expect(predDs.data).toEqual([2.5, 1.5]);
    expect(actualDs.borderColor).toBe('rgb(14, 165, 233)');
    expect(predDs.borderColor).toBe('rgb(249, 115, 22)');

    expect(diff.canvas.id).toBe('load-accuracy-diff-chart');
    const diffDs = diff.config.data.datasets[0];
    expect(diffDs.label).toBe('Difference (pred − actual)');
    // (pred - actual) / 1000 for each sorted slot.
    expect(diffDs.data).toEqual([0.5, 0.5]);
  });

  it('skips the diff chart when its canvas is absent but still draws the overlay', () => {
    document.getElementById('load-accuracy-diff-chart').remove();
    renderLoadAccuracyChart(sampleData());
    expect(renderChartCalls).toHaveLength(1);
    expect(renderChartCalls[0].canvas.id).toBe('load-accuracy-chart');
  });

  it('renders overlay tooltip rows for each data point', () => {
    renderLoadAccuracyChart(sampleData());
    // First tooltip handler belongs to the overlay chart.
    const renderContent = tooltipHandlers[0].renderContent;
    const html = renderContent(0, {
      title: ['12:00'],
      dataPoints: [
        { dataset: { borderColor: 'rgb(1,2,3)', label: 'Actual' }, raw: 2 },
        { dataset: { borderColor: 'rgb(4,5,6)', label: 'Prediction' }, raw: 2.5 },
      ],
    });
    expect(html).toContain('HEAD(12:00)');
    expect(html).toContain('ROW(rgb(1,2,3)|Actual|K2 kWh)');
    expect(html).toContain('ROW(rgb(4,5,6)|Prediction|K2.5 kWh)');
  });

  it('renders overlay tooltip with empty title and no points', () => {
    renderLoadAccuracyChart(sampleData());
    const renderContent = tooltipHandlers[0].renderContent;
    expect(renderContent(0, {})).toBe('HEAD()');
  });

  it('renders the diff tooltip for positive and negative differences', () => {
    renderLoadAccuracyChart(sampleData());
    // Second handler belongs to the diff chart.
    const renderContent = tooltipHandlers[1].renderContent;

    const positive = renderContent(0, { title: ['13:00'], dataPoints: [{ raw: 1.2 }] });
    expect(positive).toContain('HEAD(13:00)');
    expect(positive).toContain('DIV');
    expect(positive).toContain('ROW(rgb(139,201,100)|Pred − Actual|+K1.2 kWh)');

    const negative = renderContent(0, { dataPoints: [{ raw: -0.5 }] });
    expect(negative).toContain('ROW(rgb(233,122,131)|Pred − Actual|K0.5 kWh)');
  });

  it('returns just the header from the diff tooltip when there is no data point', () => {
    renderLoadAccuracyChart(sampleData());
    const renderContent = tooltipHandlers[1].renderContent;
    expect(renderContent(0, { title: ['09:00'] })).toBe('HEAD(09:00)');
    expect(renderContent(0, {})).toBe('HEAD()');
  });
});

describe('accuracy-charts: day dividers plugin', () => {
  function fakeChart() {
    const calls = { strokes: 0, texts: [], fills: 0 };
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(() => { calls.strokes++; }),
      fillText: vi.fn((text) => { calls.texts.push(text); }),
      setLineDash: vi.fn(),
      fillRect: vi.fn(() => { calls.fills++; }),
      set strokeStyle(_v) {},
      set lineWidth(_v) {},
      set font(_v) {},
      set fillStyle(_v) {},
      set textAlign(_v) {},
    };
    return {
      calls,
      chart: {
        ctx,
        chartArea: { top: 0, bottom: 100, left: 10, right: 200, height: 100 },
        scales: { x: { getPixelForValue: (i) => 10 + i * 20 } },
      },
    };
  }

  it('draws weekday labels, an inter-day divider, and the net-error overlay', () => {
    renderLoadAccuracyChart(sampleData());
    // The overlay chart carries the net-error plugin (dayNetWh + container id).
    const plugin = renderChartCalls[0].config.plugins[0];
    expect(plugin.id).toBe('dayDividers');

    const { chart, calls } = fakeChart();
    plugin.afterDraw(chart);

    // Two days -> one divider stroke (the first day has no leading divider).
    expect(calls.strokes).toBe(1);
    // A weekday label is drawn per day.
    expect(calls.texts.length).toBe(2);

    const container = document.getElementById('load-daily-net-error');
    expect(container.classList.contains('hidden')).toBe(false);
    expect(container.innerHTML).toContain('net error (kWh)');
    // Day 1 net = (2500-2000)+(2000-3000) = -500 Wh -> negative color + minus sign.
    expect(container.innerHTML).toContain('rgb(233,122,131)');
    expect(container.innerHTML).toContain('−');
    // Day 2 net = (1500-1000) = +500 Wh -> positive color + plus sign.
    expect(container.innerHTML).toContain('rgb(139,201,100)');
    expect(container.innerHTML).toContain('+');
  });

  it('skips rebuilding the net-error overlay when chart geometry is unchanged', () => {
    renderLoadAccuracyChart(sampleData());
    const plugin = renderChartCalls[0].config.plugins[0];
    const { chart } = fakeChart();

    plugin.afterDraw(chart);
    const container = document.getElementById('load-daily-net-error');
    container.innerHTML = 'SENTINEL';
    // Same geometry on the next draw -> early return, container untouched.
    plugin.afterDraw(chart);
    expect(container.innerHTML).toBe('SENTINEL');
  });

  it('returns early when scales or chartArea are unavailable', () => {
    renderLoadAccuracyChart(sampleData());
    const plugin = renderChartCalls[0].config.plugins[0];
    const ctx = { save: vi.fn(), restore: vi.fn() };
    // No scales.x -> bail before any drawing.
    expect(() => plugin.afterDraw({ ctx, chartArea: { left: 0, right: 1 }, scales: {} })).not.toThrow();
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('does not touch a container that is missing from the DOM', () => {
    renderLoadAccuracyChart(sampleData());
    const plugin = renderChartCalls[0].config.plugins[0];
    document.getElementById('load-daily-net-error').remove();
    const { chart } = fakeChart();
    expect(() => plugin.afterDraw(chart)).not.toThrow();
  });

  it('falls back to zero net error for a day whose samples were all skipped', () => {
    // Day 1 has a null value -> skipped from the net-error map (line 117 continue),
    // so when the overlay renders that day it falls back to 0 (line 89 `?? 0`).
    const data = [
      { time: Date.parse('2099-01-02T10:00:00.000Z'), actual: null, predicted: 2500 },
      { time: Date.parse('2099-01-03T10:00:00.000Z'), actual: 1000, predicted: 1500 },
    ];
    renderLoadAccuracyChart(data);
    const plugin = renderChartCalls[0].config.plugins[0];
    const { chart } = fakeChart();
    plugin.afterDraw(chart);

    const container = document.getElementById('load-daily-net-error');
    // Day 1 net error fell back to 0 -> rendered as a non-negative "+0" (closed by </div>).
    expect(container.innerHTML).toContain('+K0</div>');
  });

  it('diff chart plugin draws dividers but writes no net-error overlay (null container)', () => {
    renderLoadAccuracyChart(sampleData());
    const diffPlugin = renderChartCalls[1].config.plugins[0];
    const { chart, calls } = fakeChart();
    diffPlugin.afterDraw(chart);
    // Dividers + weekday labels still drawn, but no DOM container is touched.
    expect(calls.strokes).toBe(1);
    expect(calls.texts.length).toBe(2);
  });
});

describe('accuracy-charts: renderPvAccuracyChart', () => {
  it('coerces null actual/predicted PV values to zero', () => {
    const data = [
      { time: Date.parse('2099-01-02T10:00:00.000Z'), actual: null, predicted: 1000 },
      { time: Date.parse('2099-01-02T11:00:00.000Z'), actual: 2000, predicted: null },
    ];
    renderPvAccuracyChart(data);

    expect(renderChartCalls).toHaveLength(2);
    const [overlay] = renderChartCalls;
    expect(overlay.canvas.id).toBe('pv-accuracy-chart');
    const [actualDs, predDs] = overlay.config.data.datasets;
    expect(predDs.label).toBe('Predicted');
    // null actual -> 0 kWh; 2000 W -> 2 kWh.
    expect(actualDs.data).toEqual([0, 2]);
    // 1000 W -> 1 kWh; null predicted -> 0 kWh.
    expect(predDs.data).toEqual([1, 0]);
  });
});
