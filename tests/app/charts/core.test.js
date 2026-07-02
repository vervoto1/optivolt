// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fmtHHMM,
  buildTimeAxisFromTimestamps,
  getBaseOptions,
  getChartTheme,
  refreshAllChartThemes,
  renderChart,
  dsBar,
} from '../../../app/src/charts/core.js';
import { dim } from '../../../app/src/charts/colors.js';

// A minimal Chart.js stand-in. renderChart does:
//   new Chart(canvas.getContext("2d"), config)
// and getRenderedCharts iterates document canvases reading canvas._chart
// or Chart.getChart(canvas). We track lifecycle so tests can assert it.
class FakeChart {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.options = config?.options;
    this.canvas = ctx?.canvas ?? null;
    this.updateCalls = [];
    this.destroyed = false;
  }
  update(mode) {
    this.updateCalls.push(mode);
  }
  destroy() {
    this.destroyed = true;
  }
  static getChart() {
    return undefined;
  }
}

// Local midnight 2026-06-18 in Europe/Amsterdam (CEST, UTC+2).
const MIDNIGHT_MS = 1781733600000;
const HOUR = 3600 * 1000;

beforeEach(() => {
  vi.stubGlobal('Chart', FakeChart);
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return { canvas: this };
  };
  document.documentElement.classList.remove('dark');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  document.body.innerHTML = '';
});

describe('fmtHHMM', () => {
  it('formats hours and minutes zero-padded in local time', () => {
    expect(fmtHHMM(new Date(MIDNIGHT_MS))).toBe('00:00');
    expect(fmtHHMM(new Date(MIDNIGHT_MS + 9 * HOUR + 5 * 60 * 1000))).toBe('09:05');
  });
});

describe('getChartTheme', () => {
  it('returns the light theme by default', () => {
    expect(getChartTheme()).toEqual({
      axisTickColor: 'rgba(71, 85, 105, 0.95)',
      gridColor: 'rgba(148, 163, 184, 0.22)',
      zeroLineColor: 'rgba(148, 163, 184, 0.6)',
      majorGridColor: 'rgba(0, 0, 0, 0.25)',
      minorGridColor: 'rgba(0, 0, 0, 0.08)',
    });
  });

  it('returns the dark theme when the html element has the dark class', () => {
    document.documentElement.classList.add('dark');
    expect(getChartTheme()).toEqual({
      axisTickColor: 'rgba(226, 232, 240, 0.9)',
      gridColor: 'rgba(148, 163, 184, 0.28)',
      zeroLineColor: 'rgba(148, 163, 184, 0.6)',
      majorGridColor: 'rgba(226, 232, 240, 0.32)',
      minorGridColor: 'rgba(226, 232, 240, 0.10)',
    });
  });
});

describe('buildTimeAxisFromTimestamps', () => {
  it('handles a single timestamp (no span) with labelEveryH = 2', () => {
    const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS]);
    expect(axis.labels).toEqual(['00:00']);
    // Single timestamp -> hoursSpan 0 -> dense mode -> midnight is labeled.
    expect(axis.ticksCb(0, 0)).toBe('18/06');
  });

  it('uses a 2-hour label cadence for spans <= 12h (dense mode)', () => {
    // 0h..6h in 1h steps -> 6h span -> dense mode, every hour labeled.
    const ts = [];
    for (let h = 0; h <= 6; h++) ts.push(MIDNIGHT_MS + h * HOUR);
    const axis = buildTimeAxisFromTimestamps(ts);
    expect(axis.ticksCb(null, 0)).toBe('18/06'); // midnight -> date
    expect(axis.ticksCb(null, 1)).toBe('01:00'); // 01:00 labeled in dense mode
    expect(axis.ticksCb(null, 3)).toBe('03:00');
  });

  it('uses a 4-hour cadence for spans > 12h but <= 2 days (sparse mode)', () => {
    // 0h..18h in 1h steps -> 18h span -> sparse, labelEveryH = 4.
    const ts = [];
    for (let h = 0; h <= 18; h++) ts.push(MIDNIGHT_MS + h * HOUR);
    const axis = buildTimeAxisFromTimestamps(ts);
    expect(axis.ticksCb(null, 0)).toBe('18/06'); // midnight always labeled
    expect(axis.ticksCb(null, 4)).toBe('04:00'); // 4 % 4 === 0 -> labeled
    expect(axis.ticksCb(null, 1)).toBe(''); // 1 % 4 !== 0 -> not labeled
    expect(axis.ticksCb(null, 8)).toBe('08:00');
  });

  it('uses a 24-hour cadence for spans > 2 days', () => {
    // 0h..72h in 6h steps -> 3 days -> labelEveryH = 24.
    const ts = [];
    for (let h = 0; h <= 72; h += 6) ts.push(MIDNIGHT_MS + h * HOUR);
    const axis = buildTimeAxisFromTimestamps(ts);
    // index 0 -> day0 midnight -> 18/06
    expect(axis.ticksCb(null, 0)).toBe('18/06');
    // index 4 -> +24h -> next midnight -> 19/06
    expect(axis.ticksCb(null, 4)).toBe('19/06');
    // index 2 -> +12h (noon) -> 12 % 24 !== 0 -> not labeled
    expect(axis.ticksCb(null, 2)).toBe('');
  });

  it('returns empty tick text when the index is out of range', () => {
    const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS]);
    expect(axis.ticksCb(null, 99)).toBe('');
  });

  it('returns empty tick text for non-full-minute ticks in sparse mode', () => {
    // 18h span -> sparse. Include a non-zero-minute tick.
    const ts = [];
    for (let h = 0; h <= 18; h++) ts.push(MIDNIGHT_MS + h * HOUR);
    ts.push(MIDNIGHT_MS + 30 * 60 * 1000); // 00:30, not a full minute hour
    const axis = buildTimeAxisFromTimestamps(ts);
    const halfPastIdx = ts.length - 1;
    expect(axis.ticksCb(null, halfPastIdx)).toBe('');
  });

  describe('tooltipTitleCb', () => {
    it('formats the timestamp of the first hovered item', () => {
      const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS, MIDNIGHT_MS + HOUR]);
      expect(axis.tooltipTitleCb([{ dataIndex: 1 }])).toBe('01:00');
    });

    it('returns empty string when there are no items', () => {
      const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS]);
      expect(axis.tooltipTitleCb([])).toBe('');
      expect(axis.tooltipTitleCb(undefined)).toBe('');
    });

    it('returns empty string when the resolved time is missing', () => {
      const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS]);
      expect(axis.tooltipTitleCb([{ dataIndex: 5 }])).toBe('');
    });
  });

  describe('gridCb', () => {
    it('returns the major grid color at midnight', () => {
      const ts = [];
      for (let h = 0; h <= 6; h++) ts.push(MIDNIGHT_MS + h * HOUR);
      const axis = buildTimeAxisFromTimestamps(ts);
      expect(axis.gridCb({ index: 0 })).toBe(getChartTheme().majorGridColor);
    });

    it('returns the minor grid color at a labeled non-midnight hour', () => {
      const ts = [];
      for (let h = 0; h <= 6; h++) ts.push(MIDNIGHT_MS + h * HOUR);
      const axis = buildTimeAxisFromTimestamps(ts); // dense mode -> all hours labeled
      expect(axis.gridCb({ index: 2 })).toBe(getChartTheme().minorGridColor);
    });

    it('returns transparent for unlabeled hours in sparse mode', () => {
      const ts = [];
      for (let h = 0; h <= 18; h++) ts.push(MIDNIGHT_MS + h * HOUR);
      const axis = buildTimeAxisFromTimestamps(ts); // labelEveryH = 4
      expect(axis.gridCb({ index: 1 })).toBe('transparent'); // 01:00 not labeled
    });

    it('returns transparent when index is null or missing', () => {
      const axis = buildTimeAxisFromTimestamps([MIDNIGHT_MS]);
      expect(axis.gridCb({})).toBe('transparent');
      expect(axis.gridCb({ index: null })).toBe('transparent');
      expect(axis.gridCb({ index: 50 })).toBe('transparent');
    });

    it('reads the index from tick.index and tick.value fallbacks', () => {
      const ts = [];
      for (let h = 0; h <= 6; h++) ts.push(MIDNIGHT_MS + h * HOUR);
      const axis = buildTimeAxisFromTimestamps(ts);
      expect(axis.gridCb({ tick: { index: 0 } })).toBe(getChartTheme().majorGridColor);
      expect(axis.gridCb({ tick: { value: 0 } })).toBe(getChartTheme().majorGridColor);
    });
  });
});

describe('getBaseOptions', () => {
  const baseAxis = {
    ticksCb: () => 't',
    tooltipTitleCb: () => 'tt',
    gridCb: () => 'g',
    yTitle: 'Power (W)',
  };

  it('produces the standard structure with light-theme colors', () => {
    const opts = getBaseOptions(baseAxis);
    expect(opts.maintainAspectRatio).toBe(false);
    expect(opts.responsive).toBe(true);
    expect(opts.interaction).toEqual({ mode: 'index', intersect: false });
    // default layout padding bottom
    expect(opts.layout.padding.bottom).toBe(-6);
    // no animation key when not overridden
    expect('animation' in opts).toBe(false);

    expect(opts.plugins.legend.position).toBe('bottom');
    expect(opts.plugins.legend.labels.color).toBe('rgba(71, 85, 105, 0.95)');
    expect(opts.plugins.legend.labels.pointStyle).toBe('rect');
    expect(opts.plugins.tooltip.mode).toBe('index');
    expect(opts.plugins.tooltip.callbacks.title).toBe(baseAxis.tooltipTitleCb);

    expect(opts.scales.x.stacked).toBe(false);
    expect(opts.scales.x.ticks.callback).toBe(baseAxis.ticksCb);
    expect(opts.scales.x.ticks.autoSkip).toBe(false);
    expect(opts.scales.x.grid.color).toBe(baseAxis.gridCb);

    expect(opts.scales.y.stacked).toBe(false);
    expect(opts.scales.y.beginAtZero).toBe(true);
    expect(opts.scales.y.grid.zeroLineColor).toBe('rgba(148, 163, 184, 0.6)');
    expect(opts.scales.y.title).toEqual({
      display: true,
      text: 'Power (W)',
      color: 'rgba(71, 85, 105, 0.95)',
    });
  });

  it('marks the y title as hidden when no yTitle is supplied', () => {
    const opts = getBaseOptions({ ...baseAxis, yTitle: undefined });
    expect(opts.scales.y.title.display).toBe(false);
    expect(opts.scales.y.title.text).toBeUndefined();
  });

  it('applies stacked to both axes', () => {
    const opts = getBaseOptions({ ...baseAxis, stacked: true });
    expect(opts.scales.x.stacked).toBe(true);
    expect(opts.scales.y.stacked).toBe(true);
  });

  it('honours an explicit layout padding bottom override', () => {
    const opts = getBaseOptions(baseAxis, { layout: { padding: { bottom: 20 } } });
    expect(opts.layout.padding.bottom).toBe(20);
  });

  it('includes the animation key when overrides contain animation (even false)', () => {
    const opts = getBaseOptions(baseAxis, { animation: false });
    expect('animation' in opts).toBe(true);
    expect(opts.animation).toBe(false);
  });

  it('merges legend overrides and legend label overrides', () => {
    const opts = getBaseOptions(baseAxis, {
      plugins: {
        legend: { display: false, labels: { boxWidth: 99 } },
      },
    });
    expect(opts.plugins.legend.display).toBe(false);
    // overridden label key
    expect(opts.plugins.legend.labels.boxWidth).toBe(99);
    // base label keys preserved
    expect(opts.plugins.legend.labels.pointStyle).toBe('rect');
    expect(opts.plugins.legend.labels.padding).toBe(12);
  });

  it('merges tooltip overrides and extra plugins', () => {
    const opts = getBaseOptions(baseAxis, {
      plugins: {
        tooltip: { enabled: false },
        datalabels: { display: true },
      },
    });
    expect(opts.plugins.tooltip.enabled).toBe(false);
    expect(opts.plugins.tooltip.mode).toBe('index'); // base preserved
    expect(opts.plugins.datalabels).toEqual({ display: true });
  });

  it('merges x scale ticks, grid and remaining overrides', () => {
    const opts = getBaseOptions(baseAxis, {
      scales: {
        x: {
          offset: true,
          ticks: { maxRotation: 90 },
          grid: { display: false },
        },
      },
    });
    expect(opts.scales.x.offset).toBe(true); // xRest spread
    expect(opts.scales.x.ticks.maxRotation).toBe(90); // ticks override
    expect(opts.scales.x.ticks.autoSkip).toBe(false); // base preserved
    expect(opts.scales.x.grid.display).toBe(false); // grid override
    expect(opts.scales.x.grid.color).toBe(baseAxis.gridCb); // base preserved
  });

  it('merges a y scale override', () => {
    const opts = getBaseOptions(baseAxis, {
      scales: { y: { max: 100 } },
    });
    expect(opts.scales.y.max).toBe(100);
    // y override fully replaces the constructed y? Spread of override after,
    // so override keys win but base y keys remain present.
    expect(opts.scales.y.beginAtZero).toBe(true);
  });

  it('handles overrides with empty plugins/scales objects', () => {
    const opts = getBaseOptions(baseAxis, { plugins: {}, scales: {} });
    expect(opts.plugins.legend.position).toBe('bottom');
    expect(opts.scales.x.stacked).toBe(false);
    expect(opts.scales.y.beginAtZero).toBe(true);
  });
});

describe('renderChart', () => {
  it('creates a chart, registers it, and hides the empty overlay', () => {
    const wrap = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.className = 'chart-empty';
    const canvas = document.createElement('canvas');
    wrap.append(overlay, canvas);
    document.body.append(wrap);

    const config = { type: 'bar', options: { plugins: {}, scales: {} } };
    renderChart(canvas, config);

    expect(canvas._chart).toBeInstanceOf(FakeChart);
    expect(canvas._chart.config).toBe(config);
    expect(overlay.style.display).toBe('none');
  });

  it('destroys the previous chart before creating a new one', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);

    renderChart(canvas, { id: 'first', options: {} });
    const first = canvas._chart;
    expect(first.destroyed).toBe(false);

    renderChart(canvas, { id: 'second', options: {} });
    expect(first.destroyed).toBe(true);
    expect(canvas._chart).not.toBe(first);
    expect(canvas._chart.config.id).toBe('second');
  });

  it('works when there is no empty overlay or parent', () => {
    const canvas = document.createElement('canvas');
    // not appended -> parentElement is null
    expect(() => renderChart(canvas, { options: {} })).not.toThrow();
    expect(canvas._chart).toBeInstanceOf(FakeChart);
  });
});

describe('refreshAllChartThemes', () => {
  function makeConnectedChart(options) {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    renderChart(canvas, { options });
    return canvas._chart;
  }

  it('recolors legend, scale ticks, titles and grids then calls update("none")', () => {
    const chart = makeConnectedChart({
      plugins: { legend: { labels: { boxWidth: 7, font: { size: 9 } } } },
      scales: {
        x: {
          ticks: { color: 'old' },
          title: { text: 'X' },
          grid: { color: 'old-grid', zeroLineColor: 'old-zero' },
        },
        y: {
          ticks: {},
          grid: { color: 'old' },
        },
      },
    });

    document.documentElement.classList.add('dark');
    refreshAllChartThemes();

    const theme = getChartTheme(); // dark theme now
    expect(chart.options.plugins.legend.labels.color).toBe(theme.axisTickColor);
    expect(chart.options.plugins.legend.labels.boxWidth).toBe(7); // preserved
    expect(chart.options.plugins.legend.labels.font.size).toBe(9); // preserved

    expect(chart.options.scales.x.ticks.color).toBe(theme.axisTickColor);
    expect(chart.options.scales.x.title.color).toBe(theme.axisTickColor);
    expect(chart.options.scales.x.title.text).toBe('X'); // preserved
    expect(chart.options.scales.x.grid.color).toBe(theme.gridColor);
    expect(chart.options.scales.x.grid.zeroLineColor).toBe(theme.zeroLineColor);

    expect(chart.updateCalls).toEqual(['none']);
  });

  it('skips recoloring a grid whose color is a function', () => {
    const gridFn = () => 'transparent';
    const chart = makeConnectedChart({
      scales: { x: { grid: { color: gridFn } } },
    });

    refreshAllChartThemes();
    // function color is left untouched
    expect(chart.options.scales.x.grid.color).toBe(gridFn);
    // no zeroLineColor key -> not added
    expect(Object.hasOwn(chart.options.scales.x.grid, 'zeroLineColor')).toBe(false);
  });

  it('does not recolor ticks on the y2 scale', () => {
    const chart = makeConnectedChart({
      scales: {
        y2: { ticks: { color: 'price-color' }, grid: {} },
      },
    });

    refreshAllChartThemes();
    expect(chart.options.scales.y2.ticks.color).toBe('price-color');
  });

  it('ignores charts with no legend and no scales/title', () => {
    const chart = makeConnectedChart({ plugins: {}, scales: {} });
    expect(() => refreshAllChartThemes()).not.toThrow();
    expect(chart.updateCalls).toEqual(['none']);
  });

  it('skips legend recoloring when there is no plugins object at all', () => {
    // options.plugins is undefined -> updateLegendTheme returns early.
    const chart = makeConnectedChart({ scales: {} });
    expect(() => refreshAllChartThemes()).not.toThrow();
    expect(chart.options.plugins).toBeUndefined();
    expect(chart.updateCalls).toEqual(['none']);
  });

  it('recolors a legend that has no labels object yet', () => {
    const chart = makeConnectedChart({
      plugins: { legend: {} }, // no labels -> legend.labels?.font is undefined
      scales: {},
    });
    document.documentElement.classList.add('dark');
    refreshAllChartThemes();
    const theme = getChartTheme();
    expect(chart.options.plugins.legend.labels.color).toBe(theme.axisTickColor);
    expect(chart.options.plugins.legend.labels.font.family).toBeDefined();
  });

  it('skips scale entries that are null', () => {
    const chart = makeConnectedChart({
      plugins: {},
      scales: { x: null, y: { ticks: {}, grid: {} } },
    });
    expect(() => refreshAllChartThemes()).not.toThrow();
    expect(chart.options.scales.x).toBeNull();
    expect(chart.options.scales.y.ticks.color).toBe(getChartTheme().axisTickColor);
  });

  it('ignores bare canvases that resolve to no chart', () => {
    // A connected canvas with no _chart and Chart.getChart returning undefined.
    const bare = document.createElement('canvas');
    document.body.append(bare);
    // Also have a real chart so we can confirm refresh still runs.
    const chart = makeConnectedChart({ plugins: {}, scales: {} });
    expect(() => refreshAllChartThemes()).not.toThrow();
    expect(chart.updateCalls).toEqual(['none']);
    expect(bare._chart).toBeUndefined();
  });

  it('falls back to an empty options object when chart.options is missing', () => {
    const chart = makeConnectedChart(undefined);
    chart.options = undefined;
    expect(() => refreshAllChartThemes()).not.toThrow();
    expect(chart.updateCalls).toEqual(['none']);
  });

  it('drops charts whose canvas is disconnected from the registry', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    renderChart(canvas, { options: { plugins: {}, scales: {} } });
    const chart = canvas._chart;

    // Disconnect the canvas: it should be pruned from the registry and not updated.
    canvas.remove();
    refreshAllChartThemes();
    expect(chart.updateCalls).toEqual([]);
  });

  it('picks up canvases carrying a _chart created outside renderChart', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const externalChart = new FakeChart({ canvas }, {
      options: { scales: { x: { ticks: {} } } },
    });
    canvas._chart = externalChart;

    refreshAllChartThemes();
    expect(externalChart.updateCalls).toEqual(['none']);
    expect(externalChart.options.scales.x.ticks.color).toBe(getChartTheme().axisTickColor);
  });

  it('picks up charts discoverable via Chart.getChart on a bare canvas', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const discovered = new FakeChart({ canvas }, { options: { scales: {} } });
    const spy = vi.spyOn(FakeChart, 'getChart').mockReturnValue(discovered);

    refreshAllChartThemes();
    expect(discovered.updateCalls).toEqual(['none']);
    spy.mockRestore();
  });

  it('runs when triggered via the optivolt:themechange window event', () => {
    const chart = makeConnectedChart({ plugins: {}, scales: {} });
    window.dispatchEvent(new Event('optivolt:themechange'));
    expect(chart.updateCalls).toEqual(['none']);
  });
});

describe('dsBar', () => {
  it('builds a bar dataset descriptor with dimmed hover color', () => {
    const color = 'rgb(71, 144, 208)';
    const ds = dsBar('Battery', [1, 2, 3], color, 'stack-a');
    expect(ds).toEqual({
      label: 'Battery',
      data: [1, 2, 3],
      stack: 'stack-a',
      type: 'bar',
      backgroundColor: color,
      hoverBackgroundColor: dim(color),
      borderColor: color,
      borderWidth: 0.5,
    });
  });
});
