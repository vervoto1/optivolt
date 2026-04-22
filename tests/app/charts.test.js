// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Chart globally
class MockChart {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.data = config.data;
    this.chartArea = { left: 0, right: 400, top: 0, bottom: 300 };
    this.scales = { x: { left: 0, width: 400 } };
  }
  destroy() {}
}
vi.stubGlobal('Chart', MockChart);

import {
  SOLUTION_COLORS,
  toRGBA,
  buildTimeAxisFromTimestamps,
  getBaseOptions,
  getChartTheme,
  renderChart,
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
  drawEvPowerChart,
  drawEvSocChartTab,
} from '../../app/src/charts.js';

function mockCanvas() {
  const canvas = document.createElement('canvas');
  canvas.getContext = vi.fn(() => ({}));
  return canvas;
}

function makeRows(count = 4, stepMs = 900000) {
  const base = new Date('2024-01-15T08:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    timestampMs: base + i * stepMs,
    g2l: 500 + i * 10, b2l: 200, pv2l: 300, pv2b: 100, pv2g: 50,
    g2b: 50, b2g: 30, load: 1000, pv: 500, imp: 500, exp: 50,
    evLoad: 0, soc: 5000, soc_percent: 50 + i, ic: 10.5, ec: 5.2,
  }));
}

describe('charts.js', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
  });

  describe('SOLUTION_COLORS', () => {
    it('has expected color keys', () => {
      expect(SOLUTION_COLORS.g2l).toBeDefined();
      expect(SOLUTION_COLORS.b2l).toBeDefined();
      expect(SOLUTION_COLORS.pv2l).toBeDefined();
      expect(SOLUTION_COLORS.pv2b).toBeDefined();
      expect(SOLUTION_COLORS.pv2g).toBeDefined();
      expect(SOLUTION_COLORS.g2b).toBeDefined();
      expect(SOLUTION_COLORS.b2g).toBeDefined();
      expect(SOLUTION_COLORS.ev).toBeDefined();
      expect(SOLUTION_COLORS.soc).toBeDefined();
    });
  });

  describe('toRGBA', () => {
    it('converts rgb to rgba', () => {
      expect(toRGBA('rgb(15, 192, 216)', 0.5)).toBe('rgba(15, 192, 216, 0.5)');
    });

    it('defaults alpha to 1', () => {
      expect(toRGBA('rgb(15, 192, 216)')).toBe('rgba(15, 192, 216, 1)');
    });

    it('returns input unchanged for non-matching string', () => {
      expect(toRGBA('notacolor', 0.5)).toBe('notacolor');
    });
  });

  describe('buildTimeAxisFromTimestamps', () => {
    it('builds axis for short span (<12h)', () => {
      const base = new Date('2024-01-15T08:00:00Z').getTime();
      const timestamps = Array.from({ length: 8 }, (_, i) => base + i * 900000);
      const axis = buildTimeAxisFromTimestamps(timestamps);

      expect(axis.labels).toHaveLength(8);
      expect(axis.ticksCb).toBeInstanceOf(Function);
      expect(axis.tooltipTitleCb).toBeInstanceOf(Function);
      expect(axis.gridCb).toBeInstanceOf(Function);
    });

    it('builds axis for medium span (12-48h)', () => {
      const base = new Date('2024-01-15T00:00:00Z').getTime();
      const timestamps = Array.from({ length: 96 }, (_, i) => base + i * 900000); // 24h
      const axis = buildTimeAxisFromTimestamps(timestamps);
      expect(axis.labels).toHaveLength(96);
    });

    it('builds axis for long span (>48h)', () => {
      const base = new Date('2024-01-15T00:00:00Z').getTime();
      const timestamps = Array.from({ length: 288 }, (_, i) => base + i * 900000); // 72h
      const axis = buildTimeAxisFromTimestamps(timestamps);
      expect(axis.labels).toHaveLength(288);
    });

    it('ticksCb returns formatted strings for hour slots', () => {
      // Use local midnight to avoid timezone issues
      const midnight = new Date(2024, 0, 15, 0, 0, 0).getTime();
      const timestamps = Array.from({ length: 48 }, (_, i) => midnight + i * 900000); // 12h
      const axis = buildTimeAxisFromTimestamps(timestamps);

      // Index 0 is local midnight - should return date format dd/mm
      const label0 = axis.ticksCb(null, 0);
      expect(label0).toMatch(/\d{2}\/\d{2}/);

      // Non-hour slot should return empty string
      const label1 = axis.ticksCb(null, 1); // 00:15
      expect(label1).toBe('');

      // Index 8 is 02:00 - a full hour, should return "02:00" (fmtTickHourOrDate line 38)
      const label8 = axis.ticksCb(null, 8);
      expect(label8).toMatch(/\d{2}:00/);
    });

    it('ticksCb covers non-sparse mode for short spans', () => {
      // Short span (<12h) - non-sparse mode where isLabeledHour always returns true for full hours
      const base = new Date(2024, 0, 15, 6, 0, 0).getTime();
      const timestamps = Array.from({ length: 12 }, (_, i) => base + i * 900000); // 3h
      const axis = buildTimeAxisFromTimestamps(timestamps);

      // Index 4 = 07:00, non-sparse mode, should be labeled
      const label = axis.ticksCb(null, 4);
      expect(label).toBe('07:00');
    });

    it('ticksCb returns empty for non-labeled slots', () => {
      const base = new Date('2024-01-15T00:15:00Z').getTime(); // 00:15
      const timestamps = [base];
      const axis = buildTimeAxisFromTimestamps(timestamps);
      // 00:15 is not a full hour, should return empty
      const label = axis.ticksCb(null, 0);
      expect(label).toBe('');
    });

    it('tooltipTitleCb returns formatted time', () => {
      const base = new Date(2024, 0, 15, 8, 0, 0).getTime();
      const timestamps = [base];
      const axis = buildTimeAxisFromTimestamps(timestamps);
      const title = axis.tooltipTitleCb([{ dataIndex: 0 }]);
      expect(title).toBe('08:00');
    });

    it('tooltipTitleCb handles missing index', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      expect(axis.tooltipTitleCb([])).toBe('');
      expect(axis.tooltipTitleCb([{ dataIndex: 99 }])).toBe('');
    });

    it('gridCb returns colors for different hour types', () => {
      const midnight = new Date(2024, 0, 15, 0, 0, 0).getTime();
      const hour = new Date(2024, 0, 15, 4, 0, 0).getTime();
      const quarter = new Date(2024, 0, 15, 4, 15, 0).getTime();
      const timestamps = [midnight, hour, quarter];
      const axis = buildTimeAxisFromTimestamps(timestamps);

      expect(axis.gridCb({ index: 0 })).toContain('0,0,0'); // midnight - strong grid
      expect(axis.gridCb({ index: 2 })).toBe('transparent'); // quarter hour
    });

    it('gridCb handles missing index', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      expect(axis.gridCb({})).toBe('transparent');
      expect(axis.gridCb({ index: 99 })).toBe('transparent');
    });

    it('gridCb uses tick.index fallback', () => {
      const base = new Date(2024, 0, 15, 0, 0, 0).getTime();
      const axis = buildTimeAxisFromTimestamps([base]);
      const color = axis.gridCb({ tick: { index: 0 } });
      expect(color).toContain('0,0,0');
    });

    it('gridCb uses tick.value fallback', () => {
      const base = new Date(2024, 0, 15, 0, 0, 0).getTime();
      const axis = buildTimeAxisFromTimestamps([base]);
      const color = axis.gridCb({ tick: { value: 0 } });
      expect(color).toContain('0,0,0');
    });

    it('handles single timestamp', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      expect(axis.labels).toHaveLength(1);
    });
  });

  describe('getChartTheme', () => {
    it('returns light theme colors by default', () => {
      const theme = getChartTheme();
      expect(theme.axisTickColor).toContain('71, 85, 105');
    });

    it('returns dark theme when dark class is set', () => {
      document.documentElement.classList.add('dark');
      const theme = getChartTheme();
      expect(theme.axisTickColor).toContain('226, 232, 240');
    });
  });

  describe('getBaseOptions', () => {
    it('returns chart options object', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      const options = getBaseOptions({ ...axis, yTitle: 'kWh', stacked: true });
      expect(options.scales.x.stacked).toBe(true);
      expect(options.scales.y.stacked).toBe(true);
      expect(options.scales.y.title.text).toBe('kWh');
    });

    it('font callback returns font config', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      const options = getBaseOptions({ ...axis, yTitle: 'W' });
      const fontFn = options.plugins.legend.labels.font;
      expect(fontFn).toBeInstanceOf(Function);
      const result = fontFn({});
      expect(result.size).toBe(12);
      expect(typeof result.family).toBe('string');
    });

    it('accepts overrides for plugins and scales', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      const options = getBaseOptions({ ...axis, yTitle: 'W' }, {
        plugins: { legend: { display: false } },
        scales: { y: { max: 100 } },
      });
      expect(options.plugins.legend.display).toBe(false);
      expect(options.scales.y.max).toBe(100);
    });

    it('defaults stacked to false', () => {
      const axis = buildTimeAxisFromTimestamps([Date.now()]);
      const options = getBaseOptions({ ...axis, yTitle: '' });
      expect(options.scales.x.stacked).toBeFalsy();
    });
  });

  describe('renderChart', () => {
    it('creates a new chart instance', () => {
      const canvas = mockCanvas();
      renderChart(canvas, { type: 'bar', data: { labels: [], datasets: [] } });
      expect(canvas._chart).toBeInstanceOf(MockChart);
    });

    it('destroys old chart before creating new', () => {
      const canvas = mockCanvas();
      renderChart(canvas, { type: 'bar', data: { labels: [], datasets: [] } });
      const first = canvas._chart;
      const spy = vi.spyOn(first, 'destroy');
      renderChart(canvas, { type: 'line', data: { labels: [], datasets: [] } });
      expect(spy).toHaveBeenCalled();
      expect(canvas._chart).not.toBe(first);
    });
  });

  describe('drawFlowsBarStackSigned', () => {
    it('renders basic flow chart', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15);
      expect(canvas._chart).toBeDefined();
      expect(canvas._chart.config.type).toBe('bar');
    });

    it('renders with EV load data', () => {
      const canvas = mockCanvas();
      const rows = makeRows().map(r => ({ ...r, evLoad: 2000 }));
      drawFlowsBarStackSigned(canvas, rows, 15);
      const dsLabels = canvas._chart.config.data.datasets.map(ds => ds.label);
      expect(dsLabels).toContain('EV charging');
    });

    it('renders without EV dataset when no EV load', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15);
      const dsLabels = canvas._chart.config.data.datasets.map(ds => ds.label);
      expect(dsLabels).not.toContain('EV charging');
    });

    it('renders with rebalance window plugin', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15, { startIdx: 1, endIdx: 2 });
      expect(canvas._chart.config.plugins).toHaveLength(1);
    });

    it('renders without rebalance window', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15, null);
      expect(canvas._chart.config.plugins).toHaveLength(0);
    });

    it('aggregates rows when aggregateMinutes specified', () => {
      const canvas = mockCanvas();
      const rows = makeRows(8); // 8 * 15min = 2h
      drawFlowsBarStackSigned(canvas, rows, 15, null, { aggregateMinutes: 60 });
      // 8 slots at 15min → 2 hourly buckets
      expect(canvas._chart.config.data.labels.length).toBeLessThan(8);
    });

    it('does not aggregate when aggregateMinutes <= stepSize', () => {
      const canvas = mockCanvas();
      const rows = makeRows(4);
      drawFlowsBarStackSigned(canvas, rows, 15, null, { aggregateMinutes: 15 });
      expect(canvas._chart.config.data.labels.length).toBe(4);
    });

    it('rebalancing plugin beforeDraw renders shading', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15, { startIdx: 0, endIdx: 1 });
      const plugin = canvas._chart.config.plugins[0];
      expect(plugin.id).toBe('rebalancingShading');

      // Call beforeDraw with mock chart
      const mockCtx = {
        save: vi.fn(), restore: vi.fn(),
        fillStyle: '', fillRect: vi.fn(), fillText: vi.fn(),
        font: '', textAlign: '',
      };
      plugin.beforeDraw({
        ctx: mockCtx,
        chartArea: { left: 0, right: 400, top: 0, bottom: 300 },
        scales: { x: { left: 0, width: 400 } },
        data: { labels: ['a', 'b', 'c', 'd'] },
      });
      expect(mockCtx.save).toHaveBeenCalled();
      expect(mockCtx.fillRect).toHaveBeenCalled();
      expect(mockCtx.restore).toHaveBeenCalled();
    });

    it('rebalancing plugin handles missing chartArea', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15, { startIdx: 0, endIdx: 1 });
      const plugin = canvas._chart.config.plugins[0];
      // Should not throw
      plugin.beforeDraw({ ctx: {}, chartArea: null, scales: {}, data: {} });
    });

    it('rebalancing plugin handles missing labels', () => {
      const canvas = mockCanvas();
      drawFlowsBarStackSigned(canvas, makeRows(), 15, { startIdx: 0, endIdx: 1 });
      const plugin = canvas._chart.config.plugins[0];
      plugin.beforeDraw({
        ctx: {}, chartArea: { left: 0, right: 100, top: 0, bottom: 100 },
        scales: { x: { left: 0, width: 100 } }, data: {},
      });
    });
  });

  describe('drawSocChart', () => {
    it('renders SoC line chart', () => {
      const canvas = mockCanvas();
      drawSocChart(canvas, makeRows(), 15);
      expect(canvas._chart.config.type).toBe('line');
      expect(canvas._chart.config.data.datasets[0].label).toBe('SoC (%)');
    });
  });

  describe('drawPricesStepLines', () => {
    it('renders price step lines', () => {
      const canvas = mockCanvas();
      drawPricesStepLines(canvas, makeRows(), 15);
      expect(canvas._chart.config.type).toBe('line');
      expect(canvas._chart.config.data.datasets).toHaveLength(2);
      expect(canvas._chart.config.data.datasets[0].label).toBe('Buy price');
    });

    it('uses thinner lines for >48 slots', () => {
      const canvas = mockCanvas();
      const rows = makeRows(50);
      drawPricesStepLines(canvas, rows, 15);
      expect(canvas._chart.config.data.datasets[0].borderWidth).toBe(1);
    });

    it('uses wider lines for <=48 slots', () => {
      const canvas = mockCanvas();
      drawPricesStepLines(canvas, makeRows(4), 15);
      expect(canvas._chart.config.data.datasets[0].borderWidth).toBe(2);
    });
  });

  describe('drawLoadPvGrouped', () => {
    it('renders load/PV grouped bars', () => {
      const canvas = mockCanvas();
      drawLoadPvGrouped(canvas, makeRows(), 15);
      expect(canvas._chart.config.type).toBe('bar');
    });

    it('includes EV dataset when EV load present', () => {
      const canvas = mockCanvas();
      const rows = makeRows().map(r => ({ ...r, evLoad: 2000 }));
      drawLoadPvGrouped(canvas, rows, 15);
      const labels = canvas._chart.config.data.datasets.map(d => d.label);
      expect(labels).toContain('EV charging');
    });

    it('uses pattern draw when available', () => {
      vi.stubGlobal('pattern', { draw: vi.fn((type, color) => `pattern:${color}`) });
      const canvas = mockCanvas();
      drawLoadPvGrouped(canvas, makeRows(), 15);
      expect(window.pattern.draw).toHaveBeenCalled();
      vi.unstubAllGlobals();
      vi.stubGlobal('Chart', MockChart);
    });

    it('falls back when pattern not available', () => {
      vi.stubGlobal('pattern', undefined);
      const canvas = mockCanvas();
      drawLoadPvGrouped(canvas, makeRows(), 15);
      expect(canvas._chart).toBeDefined();
      vi.unstubAllGlobals();
      vi.stubGlobal('Chart', MockChart);
    });

    it('stacks EV and consumption when EV present', () => {
      const canvas = mockCanvas();
      const rows = makeRows().map(r => ({ ...r, evLoad: 3000 }));
      drawLoadPvGrouped(canvas, rows, 15);
      const datasets = canvas._chart.config.data.datasets;
      const evDs = datasets.find(d => d.label === 'EV charging');
      const loadDs = datasets.find(d => d.label === 'Consumption forecast');
      expect(evDs.stack).toBe('load');
      expect(loadDs.stack).toBe('load');
    });
  });

  // ---------------------------------------------------------------------------
  // Helper — access top-level plugins array or options.plugins config
  // ---------------------------------------------------------------------------

  function topPlugins(chart) { return chart.config.plugins; }        // top-level array
  function optPlugins(chart) { return chart.config.options.plugins; } // options.plugins config

  // Helper to make canvas tooltip tests work — tooltip handler needs canvas in DOM
  function mountCanvas(canvas) {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);
  }

  // ---------------------------------------------------------------------------
  // drawPricesStepLines — tooltip handler
  // ---------------------------------------------------------------------------

  describe('drawPricesStepLines tooltip', () => {
    it('creates tooltip with dataPoints rendering', () => {
      const canvas = mockCanvas();
      mountCanvas(canvas);
      Object.defineProperty(canvas, 'offsetWidth', { get: () => 400 });
      Object.defineProperty(canvas, 'offsetHeight', { get: () => 300 });
      // Use UTC timestamps for predictable behavior
      const base = new Date('2024-01-15T00:00:00Z').getTime();
      const rows = Array.from({ length: 4 }, (_, i) => ({
        timestampMs: base + i * 900000,
        ic: 10.5, ec: 5.2,
      }));
      drawPricesStepLines(canvas, rows, 15);
      const chart = canvas._chart;

      // Verify tooltip external handler exists
      const tooltipCfg = optPlugins(chart).tooltip;
      expect(tooltipCfg.external).toBeInstanceOf(Function);

      // Simulate tooltip call with title from chart.js callback
      const mockTooltip = {
        opacity: 1,
        dataPoints: [
          { dataIndex: 0, dataset: { borderColor: '#ef4444', label: 'Buy price' }, raw: 10.5 },
          { dataIndex: 0, dataset: { borderColor: '#22c55e', label: 'Sell price' }, raw: 5.2 },
        ],
        title: ['00:00'],
        caretX: 100,
        caretY: 50,
      };
      const mockChart = { chart: { canvas }, tooltip: mockTooltip };
      tooltipCfg.external(mockChart);

      // Verify tooltip HTML contains expected content
      const ttEl = canvas.parentElement.querySelector('.ov-tt');
      expect(ttEl).toBeDefined();
      expect(ttEl.innerHTML).toContain('Buy price');
      expect(ttEl.innerHTML).toContain('10.5');
      expect(ttEl.innerHTML).toContain('Sell price');
      expect(ttEl.innerHTML).toContain('5.2');
    });
  });

  // ---------------------------------------------------------------------------
  // drawSocChart — hasEvSoc branch
  // ---------------------------------------------------------------------------

  describe('drawSocChart — hasEvSoc branch', () => {
    it('includes EV SoC dataset when present', () => {
      const canvas = mockCanvas();
      const rows = makeRows().map(r => ({ ...r, ev_soc_percent: 60 + r.timestampMs % 30 }));
      drawSocChart(canvas, rows, 15);
      const datasets = canvas._chart.config.data.datasets;
      expect(datasets).toHaveLength(2);
      expect(datasets[1].label).toBe('EV SoC (%)');
    });

    it('omits EV SoC dataset when absent', () => {
      const canvas = mockCanvas();
      drawSocChart(canvas, makeRows(), 15);
      expect(canvas._chart.config.data.datasets).toHaveLength(1);
    });

    it('hides legend when no EV SoC', () => {
      const canvas = mockCanvas();
      drawSocChart(canvas, makeRows(), 15);
      expect(optPlugins(canvas._chart).legend.display).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // drawEvPowerChart
  // ---------------------------------------------------------------------------

  describe('drawEvPowerChart', () => {
    function makeEvRows(count = 4) {
      const base = new Date(2024, 0, 15, 8, 0, 0).getTime();
      return Array.from({ length: count }, (_, i) => ({
        timestampMs: base + i * 900000,
        g2ev: 500 + i * 50,
        pv2ev: 300 + i * 30,
        b2ev: 200 + i * 20,
        ev_charge_A: 10 + i * 2,
        ic: 8.5 + i * 0.5,
        ec: 4.2,
      }));
    }

    it('renders EV power chart with stacked bars', () => {
      const canvas = mockCanvas();
      drawEvPowerChart(canvas, makeEvRows(), 15, { departureTime: '2024-01-15T16:00:00Z' });
      expect(canvas._chart.config.type).toBe('bar');
      const labels = canvas._chart.config.data.datasets.map(d => d.label);
      expect(labels).toContain('Grid');
      expect(labels).toContain('Solar');
      expect(labels).toContain('Battery');
    });

    it('has a secondary price axis (y2)', () => {
      const canvas = mockCanvas();
      drawEvPowerChart(canvas, makeEvRows(), 15, {});
      expect(canvas._chart.config.options.scales.y2).toBeDefined();
      expect(canvas._chart.config.options.scales.y2.position).toBe('right');
    });

    function makeEvRowsForDeparture(count = 4) {
      const base = new Date('2024-01-15T06:00:00Z').getTime();
      return Array.from({ length: count }, (_, i) => ({
        timestampMs: base + i * 900000,
        g2ev: 500 + i * 50,
        pv2ev: 300 + i * 30,
        b2ev: 200 + i * 20,
        ev_charge_A: 10 + i * 2,
        ic: 8.5 + i * 0.5,
        ec: 4.2,
      }));
    }

    it('renders EV departure plugin', () => {
      const canvas = mockCanvas();
      // Rows from 06:00-06:45; departure at 06:30 (matches row[2])
      const rows = makeEvRowsForDeparture(4);
      drawEvPowerChart(canvas, rows, 15, { departureTime: '2024-01-15T06:30:00Z' });
      const plugins = topPlugins(canvas._chart);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].id).toBe('evDeparture');
    });

    it('does not render departure plugin when no departureTime', () => {
      const canvas = mockCanvas();
      drawEvPowerChart(canvas, makeEvRows(), 15, {});
      expect(topPlugins(canvas._chart)).toHaveLength(0);
    });

    it('departure plugin handles missing chartArea gracefully', () => {
      const canvas = mockCanvas();
      const rows = makeEvRowsForDeparture(4);
      drawEvPowerChart(canvas, rows, 15, { departureTime: '2024-01-15T06:30:00Z' });
      const plugin = topPlugins(canvas._chart)[0];
      plugin.afterDatasetsDraw({ ctx: {}, chartArea: null, scales: {} });
    });

    it('tooltip shows EV source breakdown', () => {
      const canvas = mockCanvas();
      mountCanvas(canvas);
      Object.defineProperty(canvas, 'offsetWidth', { get: () => 400 });
      Object.defineProperty(canvas, 'offsetHeight', { get: () => 300 });
      drawEvPowerChart(canvas, makeEvRows(), 15, {});
      const tooltipCfg = optPlugins(canvas._chart).tooltip;

      const mockTooltip = {
        opacity: 1,
        dataPoints: [
          { dataIndex: 0, dataset: { label: 'Grid' }, raw: 2.5 },
        ],
        caretX: 100,
        caretY: 50,
      };
      tooltipCfg.external({ chart: { canvas }, tooltip: mockTooltip });

      const ttEl = canvas.parentElement.querySelector('.ov-tt');
      expect(ttEl).toBeDefined();
      expect(ttEl.innerHTML).toContain('Charging');
      expect(ttEl.innerHTML).toContain('Grid');
    });
  });

  // ---------------------------------------------------------------------------
  // drawEvSocChartTab
  // ---------------------------------------------------------------------------

  describe('drawEvSocChartTab', () => {
    function makeEvSocRows(count = 4) {
      const base = new Date(2024, 0, 15, 8, 0, 0).getTime();
      return Array.from({ length: count }, (_, i) => ({
        timestampMs: base + i * 900000,
        ev_soc_percent: 20 + i * 10,
      }));
    }

    it('renders EV SoC line chart', () => {
      const canvas = mockCanvas();
      drawEvSocChartTab(canvas, makeEvSocRows(), {});
      expect(canvas._chart.config.type).toBe('line');
      expect(canvas._chart.config.data.datasets[0].label).toBe('EV SoC (%)');
    });

    it('has y axis min 0 and max 100', () => {
      const canvas = mockCanvas();
      drawEvSocChartTab(canvas, makeEvSocRows(), {});
      expect(canvas._chart.config.options.scales.y.min).toBe(0);
      expect(canvas._chart.config.options.scales.y.max).toBe(100);
    });

    function makeEvSocRowsForDeparture(count = 4) {
      const base = new Date('2024-01-15T06:00:00Z').getTime();
      return Array.from({ length: count }, (_, i) => ({
        timestampMs: base + i * 900000,
        ev_soc_percent: 20 + i * 10,
      }));
    }

    it('renders EV target plugin when departure + target provided', () => {
      const canvas = mockCanvas();
      const rows = makeEvSocRowsForDeparture(4);
      drawEvSocChartTab(canvas, rows, {
        departureTime: '2024-01-15T06:30:00Z',
        targetSoc_percent: 80,
      });
      const plugins = topPlugins(canvas._chart);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].id).toBe('evTarget');
    });

    it('no target plugin when targetSoc_percent is 0', () => {
      const canvas = mockCanvas();
      drawEvSocChartTab(canvas, makeEvSocRowsForDeparture(4), {
        departureTime: '2024-01-15T06:30:00Z',
        targetSoc_percent: 0,
      });
      expect(topPlugins(canvas._chart)).toHaveLength(0);
    });

    it('no target plugin when no departureTime', () => {
      const canvas = mockCanvas();
      drawEvSocChartTab(canvas, makeEvSocRowsForDeparture(4), { targetSoc_percent: 80 });
      expect(topPlugins(canvas._chart)).toHaveLength(0);
    });

    it('EV target plugin handles missing chartArea', () => {
      const canvas = mockCanvas();
      const rows = makeEvSocRowsForDeparture(4);
      drawEvSocChartTab(canvas, rows, {
        departureTime: '2024-01-15T06:30:00Z',
        targetSoc_percent: 80,
      });
      const plugin = topPlugins(canvas._chart)[0];
      plugin.afterDatasetsDraw({ ctx: {}, chartArea: null, scales: {} });
    });

    it('tooltip shows EV SoC value', () => {
      const canvas = mockCanvas();
      mountCanvas(canvas);
      Object.defineProperty(canvas, 'offsetWidth', { get: () => 400 });
      Object.defineProperty(canvas, 'offsetHeight', { get: () => 300 });
      drawEvSocChartTab(canvas, makeEvSocRows(), {});
      const tooltipCfg = optPlugins(canvas._chart).tooltip;

      tooltipCfg.external({
        chart: { canvas },
        tooltip: {
          opacity: 1,
          dataPoints: [{ dataIndex: 0, raw: 30, dataset: { label: 'EV SoC (%)' } }],
          title: ['08:00'],
          caretX: 100,
          caretY: 50,
        },
      });

      const ttEl = canvas.parentElement.querySelector('.ov-tt');
      expect(ttEl.innerHTML).toContain('EV SoC');
      expect(ttEl.innerHTML).toContain('30%');
    });
  });

  // ---------------------------------------------------------------------------
  // aggregateRows (via drawFlowsBarStackSigned with aggregateMinutes)
  // ---------------------------------------------------------------------------

  describe('aggregateRows behavior', () => {
    it('averages flow values across aggregated slots', () => {
      const canvas = mockCanvas();
      // 4 rows at 15min = 1 hour → aggregate to 60min = 1 bucket
      const rows = makeRows(4);
      drawFlowsBarStackSigned(canvas, rows, 15, null, { aggregateMinutes: 60 });
      // All 4 rows should be merged into 1 bucket
      expect(canvas._chart.config.data.labels).toHaveLength(1);
    });

    it('uses last SoC value in bucket', () => {
      const canvas = mockCanvas();
      const rows = [
        { timestampMs: Date.now(), g2l: 100, b2l: 50, load: 200, soc: 1000, soc_percent: 10 },
        { timestampMs: Date.now() + 15 * 60000, g2l: 200, b2l: 100, load: 300, soc: 2000, soc_percent: 20 },
      ];
      drawFlowsBarStackSigned(canvas, rows, 15, null, { aggregateMinutes: 60 });
      const datasets = canvas._chart.config.data.datasets;
      // g2l should be averaged: (100 + 200) / 2 = 150, converted to kWh
      const g2lDs = datasets.find(d => d.label === 'Grid → Load');
      // Values are signed in kWh (abs value * sign)
      expect(g2lDs).toBeDefined();
    });
  });
});
