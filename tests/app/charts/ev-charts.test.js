// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core.js so renderChart/getBaseOptions/dsBar/etc. are spies and we can
// assert on the chart config the module produces. getBaseOptions must return an
// object with a `scales` field because ev-charts mutates `options.scales.y2`.
vi.mock('../../../app/src/charts/core.js', () => ({
  renderChart: vi.fn(),
  getBaseOptions: vi.fn((axis, overrides) => ({ __axis: axis, __overrides: overrides, scales: {} })),
  buildTimeAxisFromTimestamps: vi.fn((timestamps) => ({
    labels: timestamps.map((t) => `L${t}`),
    ticksCb: () => 'tick',
    tooltipTitleCb: () => 'title',
    gridCb: () => 'grid',
  })),
  getChartTheme: vi.fn(() => ({ gridColor: 'grid-color' })),
  dsBar: vi.fn((label, data, color, stack) => ({ label, data, color, stack, type: 'bar' })),
}));

// Tooltip + animation helpers are spies; createTooltipHandler returns the
// renderContent callback so we can drive it directly.
vi.mock('../../../app/src/chart-tooltip.js', () => ({
  createTooltipHandler: vi.fn(({ renderContent }) => ({ __renderContent: renderContent })),
  getChartAnimations: vi.fn((type, n) => ({ __anim: { type, n } })),
  ttHeader: vi.fn((time) => `[head:${time}]`),
  ttRow: vi.fn((color, label, value) => `[row:${color}|${label}|${value}]`),
  ttSection: vi.fn((label) => `[sec:${label}]`),
  ttDivider: vi.fn(() => '[div]'),
  ttPrices: vi.fn((v) => `[prices:${v}]`),
}));

// ev-annotations plugins are spies returning controllable values.
vi.mock('../../../app/src/charts/ev-annotations.js', () => ({
  makeEvDeparturePlugin: vi.fn(() => null),
  makeEvTargetPlugin: vi.fn(() => null),
}));

import { drawEvPowerChart, drawEvSocChartTab } from '../../../app/src/charts/ev-charts.js';
import { renderChart, getBaseOptions, buildTimeAxisFromTimestamps, dsBar } from '../../../app/src/charts/core.js';
import {
  createTooltipHandler, getChartAnimations,
  ttHeader, ttRow, ttSection, ttDivider, ttPrices,
} from '../../../app/src/chart-tooltip.js';
import { makeEvDeparturePlugin, makeEvTargetPlugin } from '../../../app/src/charts/ev-annotations.js';
import { SOLUTION_COLORS } from '../../../app/src/charts/colors.js';

beforeEach(() => {
  vi.clearAllMocks();
  makeEvDeparturePlugin.mockReturnValue(null);
  makeEvTargetPlugin.mockReturnValue(null);
});

// Two rows: the first has active charging from all three sources, the second is idle.
const powerRows = [
  { timestampMs: 1000, g2ev: 1000, pv2ev: 2000, b2ev: 1000, ev_charge_A: 16, ic: 12.4 },
  { timestampMs: 2000, g2ev: 0, pv2ev: 0, b2ev: 0, ev_charge_A: 0, ic: 5 },
];

describe('drawEvPowerChart', () => {
  it('builds the time axis from row timestamps', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows);
    expect(buildTimeAxisFromTimestamps).toHaveBeenCalledWith([1000, 2000]);
  });

  it('treats a missing source field as zero amps even when total power is positive', () => {
    const canvas = document.createElement('canvas');
    // total_W = 3000 (grid + solar), but b2ev is absent -> Battery share = 0.
    drawEvPowerChart(canvas, [{ timestampMs: 1000, g2ev: 1000, pv2ev: 2000, ev_charge_A: 9 }]);
    const battCall = dsBar.mock.calls.find((c) => c[0] === 'Battery');
    const gridCall = dsBar.mock.calls.find((c) => c[0] === 'Grid');
    expect(battCall[1]).toEqual([0]);    // (r.b2ev || 0) -> 0
    expect(gridCall[1]).toEqual([3]);    // 9 * 1000/3000
  });

  it('splits charge current across sources proportionally and adds a price line', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows);

    // dsBar called once per source with amps split by power share.
    const gridCall = dsBar.mock.calls.find((c) => c[0] === 'Grid');
    const solarCall = dsBar.mock.calls.find((c) => c[0] === 'Solar');
    const battCall = dsBar.mock.calls.find((c) => c[0] === 'Battery');

    // Row 0: total_W = 4000, ev_A = 16. Grid share = 16 * 1000/4000 = 4.
    expect(gridCall[1]).toEqual([4, 0]);   // row1 idle -> 0
    expect(solarCall[1]).toEqual([8, 0]);  // 16 * 2000/4000
    expect(battCall[1]).toEqual([4, 0]);   // 16 * 1000/4000
    expect(gridCall[2]).toBe(SOLUTION_COLORS.g2ev);
    expect(gridCall[3]).toBe('ev');

    const [, config] = renderChart.mock.calls[0];
    expect(config.type).toBe('bar');
    expect(config.data.labels).toEqual(['L1000', 'L2000']);

    // Last dataset is the price line on the secondary axis.
    const priceDs = config.data.datasets[config.data.datasets.length - 1];
    expect(priceDs.label).toBe('Price');
    expect(priceDs.type).toBe('line');
    expect(priceDs.yAxisID).toBe('y2');
    expect(priceDs.data).toEqual([12.4, 5]);
  });

  it('defaults the price to 0 when ic is missing', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, [{ timestampMs: 1000, ev_charge_A: 0 }]);
    const [, config] = renderChart.mock.calls[0];
    const priceDs = config.data.datasets[config.data.datasets.length - 1];
    expect(priceDs.data).toEqual([0]);
  });

  it('configures the right-hand price axis (y2) with a cents formatter', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows);
    const [, config] = renderChart.mock.calls[0];
    const y2 = config.options.scales.y2;
    expect(y2.type).toBe('linear');
    expect(y2.position).toBe('right');
    expect(y2.beginAtZero).toBe(false);
    expect(y2.ticks.callback(12.6)).toBe('13¢');
    expect(y2.grid.drawOnChartArea).toBe(false);
    expect(y2.grid.color).toBe('grid-color');
  });

  it('passes stacked axis config and bar animations to getBaseOptions', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows);
    const [axisArg, overrides] = getBaseOptions.mock.calls[0];
    expect(axisArg.yTitle).toBe('A');
    expect(axisArg.stacked).toBe(true);
    expect(getChartAnimations).toHaveBeenCalledWith('bar', 2);
    expect(overrides.__anim).toEqual({ type: 'bar', n: 2 });
    expect(overrides.plugins.tooltip.external).toBeTruthy();
  });

  it('renders the departure plugin when one is available', () => {
    const fakePlugin = { id: 'evDeparture' };
    makeEvDeparturePlugin.mockReturnValue(fakePlugin);
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows, 15, { departureTime: '2026-06-18T17:00:00Z' });
    expect(makeEvDeparturePlugin).toHaveBeenCalledWith(powerRows, '2026-06-18T17:00:00Z');
    const [, config] = renderChart.mock.calls[0];
    expect(config.plugins).toEqual([fakePlugin]);
  });

  it('passes an empty plugins array when no departure plugin is produced', () => {
    const canvas = document.createElement('canvas');
    drawEvPowerChart(canvas, powerRows);
    const [, config] = renderChart.mock.calls[0];
    expect(config.plugins).toEqual([]);
  });

  describe('tooltip renderContent', () => {
    function getRenderContent() {
      const canvas = document.createElement('canvas');
      drawEvPowerChart(canvas, powerRows);
      // createTooltipHandler is called with { renderContent }.
      return createTooltipHandler.mock.calls[0][0].renderContent;
    }

    it('lists active charging sources with their amps and a price footer', () => {
      const renderContent = getRenderContent();
      const html = renderContent(0, { title: ['08:00'] });

      expect(ttHeader).toHaveBeenCalledWith('08:00');
      expect(ttSection).toHaveBeenCalledWith('Charging — 16.0 A total');
      // All three sources are active on row 0.
      expect(ttRow).toHaveBeenCalledWith(SOLUTION_COLORS.g2ev, 'Grid', '4.0 A');
      expect(ttRow).toHaveBeenCalledWith(SOLUTION_COLORS.pv2ev, 'Solar', '8.0 A');
      expect(ttRow).toHaveBeenCalledWith(SOLUTION_COLORS.b2ev, 'Battery', '4.0 A');
      expect(ttDivider).toHaveBeenCalled();
      expect(ttPrices).toHaveBeenCalledWith('12.4¢');
      expect(html).toContain('[head:08:00]');
      expect(html).toContain('[prices:12.4¢]');
    });

    it('omits the charging section when no source is active', () => {
      const renderContent = getRenderContent();
      ttSection.mockClear();
      ttRow.mockClear();
      const html = renderContent(1, { title: ['09:00'] }); // idle row

      expect(ttSection).not.toHaveBeenCalled();
      expect(ttRow).not.toHaveBeenCalled();
      expect(ttPrices).toHaveBeenCalledWith('5.0¢');
      expect(html).toContain('[head:09:00]');
    });

    it('falls back to an empty time and zero price when fields are missing', () => {
      const renderContent = getRenderContent();
      // tooltip without title -> time "", and a row with missing ic/ev_charge_A.
      // Use the idle row index but pass a tooltip with no title.
      const html = renderContent(1, {});
      expect(ttHeader).toHaveBeenCalledWith('');
      expect(html).toContain('[head:]');
    });

    it('falls back to 0¢ in the price footer when ic is nullish', () => {
      // ic omitted -> (row.ic ?? 0) fallback fires for the price footer.
      const canvas = document.createElement('canvas');
      drawEvPowerChart(canvas, [{ timestampMs: 1000, g2ev: 1000, ev_charge_A: 8 }]);
      const renderContent = createTooltipHandler.mock.calls[0][0].renderContent;
      renderContent(0, { title: ['10:00'] });
      expect(ttPrices).toHaveBeenCalledWith('0.0¢');
    });
  });
});

describe('drawEvSocChartTab', () => {
  const socRows = [
    { timestampMs: 1000, ev_soc_percent: 30 },
    { timestampMs: 2000, ev_soc_percent: 65 },
  ];

  it('renders an SoC line chart clamped to 0–100', () => {
    const canvas = document.createElement('canvas');
    drawEvSocChartTab(canvas, socRows);

    expect(buildTimeAxisFromTimestamps).toHaveBeenCalledWith([1000, 2000]);
    const [passedCanvas, config] = renderChart.mock.calls[0];
    expect(passedCanvas).toBe(canvas);
    expect(config.type).toBe('line');
    expect(config.data.labels).toEqual(['L1000', 'L2000']);

    const ds = config.data.datasets[0];
    expect(ds.label).toBe('EV SoC (%)');
    expect(ds.data).toEqual([30, 65]);
    expect(ds.borderColor).toBe(SOLUTION_COLORS.ev_charge);

    const overrides = getBaseOptions.mock.calls[0][1];
    expect(overrides.scales.y).toEqual({ min: 0, max: 100 });
    expect(getChartAnimations).toHaveBeenCalledWith('line', 2);
  });

  it('defaults missing SoC values to 0', () => {
    const canvas = document.createElement('canvas');
    drawEvSocChartTab(canvas, [{ timestampMs: 1000 }]);
    const [, config] = renderChart.mock.calls[0];
    expect(config.data.datasets[0].data).toEqual([0]);
  });

  it('attaches the target plugin when one is produced', () => {
    const targetPlugin = { id: 'evTarget' };
    makeEvTargetPlugin.mockReturnValue(targetPlugin);
    const canvas = document.createElement('canvas');
    drawEvSocChartTab(canvas, socRows, { departureTime: 'D', targetSoc_percent: 80 });
    expect(makeEvTargetPlugin).toHaveBeenCalledWith(socRows, 'D', 80);
    const [, config] = renderChart.mock.calls[0];
    expect(config.plugins).toEqual([targetPlugin]);
  });

  it('passes an empty plugins array when no target plugin is produced', () => {
    const canvas = document.createElement('canvas');
    drawEvSocChartTab(canvas, socRows);
    const [, config] = renderChart.mock.calls[0];
    expect(config.plugins).toEqual([]);
  });

  describe('tooltip renderContent', () => {
    function getRenderContent() {
      const canvas = document.createElement('canvas');
      drawEvSocChartTab(canvas, socRows);
      return createTooltipHandler.mock.calls[0][0].renderContent;
    }

    it('renders the rounded SoC value', () => {
      const renderContent = getRenderContent();
      const html = renderContent(0, { title: ['08:00'], dataPoints: [{ raw: 64.6 }] });
      expect(ttHeader).toHaveBeenCalledWith('08:00');
      expect(ttRow).toHaveBeenCalledWith(SOLUTION_COLORS.ev_charge, 'EV SoC', '65%');
      expect(html).toContain('[head:08:00]');
    });

    it('renders only the header when there is no data point', () => {
      const renderContent = getRenderContent();
      ttRow.mockClear();
      const html = renderContent(0, {}); // no title, no dataPoints
      expect(ttHeader).toHaveBeenCalledWith('');
      expect(ttRow).not.toHaveBeenCalled();
      expect(html).toContain('[head:]');
    });
  });
});
