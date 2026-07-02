// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the rendering/core layer so we can assert the CONFIG that the
// solution-chart builders produce, without a real Chart.js canvas render. ---
vi.mock('../../../app/src/charts/core.js', () => ({
  renderChart: vi.fn(),
  getBaseOptions: vi.fn((axis, overrides) => ({ axis, overrides })),
  buildTimeAxisFromTimestamps: vi.fn((timestampsMs) => ({
    labels: timestampsMs.map((_, i) => `t${i}`),
    ticksCb: () => 'tick',
    tooltipTitleCb: () => 'title',
    gridCb: () => 'grid',
  })),
  dsBar: vi.fn((label, data, color, stack) => ({ label, data, color, stack, type: 'bar' })),
  getChartTheme: vi.fn(() => ({ majorGridColor: 'MAJOR', minorGridColor: 'MINOR' })),
  fmtHHMM: (dt) => {
    const HH = String(dt.getHours()).padStart(2, '0');
    const MM = String(dt.getMinutes()).padStart(2, '0');
    return `${HH}:${MM}`;
  },
}));

// makeFlowsTooltip / the SoC + price + load-pv tooltips wrap createTooltipHandler.
// Make createTooltipHandler return the renderContent fn directly so tests can
// invoke it and cover the tooltip HTML branches.
vi.mock('../../../app/src/chart-tooltip.js', () => ({
  createTooltipHandler: vi.fn(({ renderContent }) => renderContent),
  fmtKwh: vi.fn((v) => `KWH(${Number(v).toFixed(3)})`),
  getChartAnimations: vi.fn((type, n) => ({ animation: { type, n } })),
  ttHeader: vi.fn((time, meta = '') => `H[${time}|${meta}]`),
  ttRow: vi.fn((color, label, value) => `R[${color}|${label}|${value}]`),
  ttSection: vi.fn((label) => `S[${label}]`),
  ttDivider: vi.fn(() => 'DIV'),
  ttPrices: vi.fn((buy, sell) => `P[${buy}|${sell}]`),
}));

vi.mock('../../../app/src/charts/ev-annotations.js', () => ({
  makeEvDeparturePlugin: vi.fn(() => ({ id: 'evDeparture' })),
  makeEvTargetPlugin: vi.fn(() => ({ id: 'evTarget' })),
}));

vi.mock('../../../app/src/charts/overlays.js', () => ({
  BUY_PRICE_STRIP_TICK_PADDING: 16,
  makeBuyPriceStripPlugin: vi.fn(() => ({ id: 'buyPriceStrip' })),
  makeNegativePriceInjectionPlugin: vi.fn(() => ({ id: 'negInjection' })),
  makeRebalancingPlugin: vi.fn(() => ({ id: 'rebalance' })),
}));

import { SOLUTION_COLORS, toRGBA } from '../../../app/src/charts/colors.js';
import { renderChart } from '../../../app/src/charts/core.js';
import {
  makeEvDeparturePlugin,
  makeEvTargetPlugin,
} from '../../../app/src/charts/ev-annotations.js';
import {
  makeBuyPriceStripPlugin,
  makeNegativePriceInjectionPlugin,
  makeRebalancingPlugin,
} from '../../../app/src/charts/overlays.js';
import {
  aggregateLoadPvBuckets,
  drawFlowsBarStackSigned,
  drawLoadPvGrouped,
  drawPricesStepLines,
  drawSocChart,
} from '../../../app/src/charts/solution-charts.js';

function canvas() {
  return document.createElement('canvas');
}

/** Grab the single config passed to the (mocked) renderChart. */
function lastRenderConfig() {
  return renderChart.mock.calls.at(-1)[1];
}

const T0 = Date.parse('2099-01-01T10:00:00.000Z');
const MIN = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('drawFlowsBarStackSigned', () => {
  it('builds signed kWh datasets only for non-zero flow keys with the right colors and stack', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 50, ic: 20, ec: 5, pv2l: 1000, b2l: 400, pv2g: 0 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 51, ic: 21, ec: 6, pv2l: 2000, b2l: 0, g2l: 800 },
    ];

    drawFlowsBarStackSigned(canvas(), rows, 15);

    const cfg = lastRenderConfig();
    expect(cfg.type).toBe('bar');
    expect(cfg.data.labels).toEqual(['t0', 't1']);

    const byLabel = Object.fromEntries(cfg.data.datasets.map(d => [d.label, d]));
    // Only pv2l, b2l, g2l are non-zero -> exactly those datasets, in flowSpecs order.
    expect(cfg.data.datasets.map(d => d.label)).toEqual([
      'Solar → Load', 'Battery → Load', 'Grid → Load',
    ]);

    // 15 min -> h = 0.25, so 1000 W -> 0.25 kWh; sign +1 for sources, -1 for draws.
    expect(byLabel['Solar → Load'].data[0]).toBeCloseTo(0.25);
    expect(byLabel['Solar → Load'].data[1]).toBeCloseTo(0.5);
    expect(byLabel['Battery → Load'].data[0]).toBeCloseTo(-0.1); // 400 W draw -> -0.1 kWh
    expect(byLabel['Grid → Load'].data[1]).toBeCloseTo(-0.2);    // 800 W draw -> -0.2 kWh

    expect(byLabel['Solar → Load'].color).toBe(SOLUTION_COLORS.pv2l);
    expect(byLabel['Solar → Load'].stack).toBe('flows');

    // stacked + yTitle kWh passed through to getBaseOptions
    expect(cfg.options.axis.yTitle).toBe('kWh');
    expect(cfg.options.axis.stacked).toBe(true);
    expect(cfg.options.overrides.scales.x.ticks.padding).toBe(16);
    expect(cfg.options.overrides.layout.padding.bottom).toBe(0);
  });

  it('always uses the absolute value with the spec sign even for negative inputs', () => {
    const rows = [{ timestampMs: T0, soc_percent: 10, ic: 1, ec: 1, b2l: -400 }];
    drawFlowsBarStackSigned(canvas(), rows, 15);
    const cfg = lastRenderConfig();
    // b2l sign is -1; Math.abs(-400) -> 0.1 kWh -> -0.1
    expect(cfg.data.datasets[0].data[0]).toBeCloseTo(-0.1);
  });

  it('adds the rebalance, buy-price-strip, negative-injection, and EV departure plugins', () => {
    const rows = [{ timestampMs: T0, soc_percent: 10, ic: 1, ec: 1, pv2l: 100 }];

    drawFlowsBarStackSigned(
      canvas(), rows, 15,
      { startIdx: 0, endIdx: 1 },
      { departureTime: '2099-01-01T12:00:00.000Z' },
    );

    expect(makeRebalancingPlugin).toHaveBeenCalledWith(0, 1);
    expect(makeBuyPriceStripPlugin).toHaveBeenCalled();
    expect(makeNegativePriceInjectionPlugin).toHaveBeenCalled();
    expect(makeEvDeparturePlugin).toHaveBeenCalled();

    const cfg = lastRenderConfig();
    expect(cfg.plugins.map(p => p.id)).toEqual([
      'rebalance', 'buyPriceStrip', 'negInjection', 'evDeparture',
    ]);
  });

  it('omits optional plugins when their inputs are absent or return null', () => {
    makeBuyPriceStripPlugin.mockReturnValueOnce(null);
    makeNegativePriceInjectionPlugin.mockReturnValueOnce(null);
    const rows = [{ timestampMs: T0, soc_percent: 10, ic: 1, ec: 1, pv2l: 100 }];

    drawFlowsBarStackSigned(canvas(), rows, 15, null, null);

    expect(makeRebalancingPlugin).not.toHaveBeenCalled();
    expect(makeEvDeparturePlugin).not.toHaveBeenCalled();
    const cfg = lastRenderConfig();
    expect(cfg.plugins).toEqual([]);
  });

  it('aggregates rows when aggregateMinutes exceeds the step size', () => {
    // 4 x 15-min slots -> one 60-min bucket. Power flows are averaged.
    const rows = [
      { timestampMs: T0, soc_percent: 10, soc: 1, ev_soc_percent: 0, ic: 10, ec: 1, g2l: 400 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 12, soc: 1.2, ev_soc_percent: 0, ic: 10, ec: 1, g2l: 800 },
      { timestampMs: T0 + 30 * MIN, soc_percent: 14, soc: 1.4, ev_soc_percent: 0, ic: 10, ec: 1, g2l: 0 },
      { timestampMs: T0 + 45 * MIN, soc_percent: 16, soc: 1.6, ev_soc_percent: 0, ic: 10, ec: 1, g2l: 0 },
    ];

    drawFlowsBarStackSigned(canvas(), rows, 15, null, null, 60);

    const cfg = lastRenderConfig();
    expect(cfg.data.labels).toEqual(['t0']); // one bucket
    const g2l = cfg.data.datasets.find(d => d.label === 'Grid → Load');
    // avg g2l = (400+800+0+0)/4 = 300 W; effectiveStep 60 -> h=1 -> 0.3 kWh, draw sign -> -0.3
    expect(g2l.data[0]).toBeCloseTo(-0.3);
  });

  it('sorts aggregated buckets chronologically when rows arrive out of order', () => {
    // Two 60-min buckets fed in reverse-time order; the comparator must reorder them.
    const rows = [
      { timestampMs: T0 + 60 * MIN, soc_percent: 80, soc: 8, ev_soc_percent: 0, ic: 1, ec: 1, pv2l: 4000 },
      { timestampMs: T0, soc_percent: 10, soc: 1, ev_soc_percent: 0, ic: 1, ec: 1, pv2l: 1000 },
    ];
    drawFlowsBarStackSigned(canvas(), rows, 15, null, null, 60);

    const cfg = lastRenderConfig();
    expect(cfg.data.labels).toEqual(['t0', 't1']); // two buckets
    const pv = cfg.data.datasets.find(d => d.label === 'Solar → Load');
    // After sorting: first bucket = T0 (1000 W -> 1 kWh), second = T0+1h (4000 W -> 4 kWh)
    expect(pv.data[0]).toBeCloseTo(1);
    expect(pv.data[1]).toBeCloseTo(4);
  });

  it('does not aggregate when aggregateMinutes equals the step size', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 10, ic: 1, ec: 1, pv2l: 100 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 10, ic: 1, ec: 1, pv2l: 100 },
    ];
    drawFlowsBarStackSigned(canvas(), rows, 15, null, null, 15);
    expect(lastRenderConfig().data.labels).toEqual(['t0', 't1']);
  });

  it('renders a flows tooltip with source/draw sections, divider, and prices', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 50.4, ic: 23.1, ec: 4.7, pv2l: 1000, b2l: 400 },
    ];
    drawFlowsBarStackSigned(canvas(), rows, 15);

    const cfg = lastRenderConfig();
    const external = cfg.options.overrides.plugins.tooltip.external;
    const html = external(0, { title: ['10:00'] });

    expect(html).toContain('H[10:00|SoC <strong>50%</strong>]'); // header + rounded SoC
    expect(html).toContain('S[↑ Sources]');
    expect(html).toContain('S[↓ Draws]');
    expect(html).toContain('DIV'); // divider between sources and draws + before prices
    expect(html).toContain('P[23.1¢|4.7¢]');
    // Solar -> Load source row uses the flow color and labelled kWh value.
    expect(html).toContain(`R[${SOLUTION_COLORS.pv2l}|Solar → Load|KWH(0.250) kWh]`);
    expect(html).toContain(`R[${SOLUTION_COLORS.b2l}|Battery → Load|KWH(0.100) kWh]`);
  });

  it('renders a tooltip with only draws (no sources, no leading divider)', () => {
    const rows = [{ timestampMs: T0, soc_percent: 30, ic: 10, ec: 2, b2l: 400 }];
    drawFlowsBarStackSigned(canvas(), rows, 15);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;
    const html = external(0, { title: ['10:00'] });

    expect(html).not.toContain('S[↑ Sources]');
    expect(html).toContain('S[↓ Draws]');
    // Exactly one divider (the pre-prices one) since there are no sources to separate.
    expect(html.match(/DIV/g)).toHaveLength(1);
  });

  it('falls back to empty title and the spec label when tooltip title / flow label missing', () => {
    const rows = [{ timestampMs: T0, soc_percent: 5, ic: 1, ec: 1, pvCurtail: 400 }];
    drawFlowsBarStackSigned(canvas(), rows, 15);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;
    // pvCurtail has a FLOWS_TOOLTIP_LABELS entry; pass no title -> "" fallback.
    const html = external(0, {});
    expect(html).toContain('H[|'); // empty time
    expect(html).toContain('Solar curtailed');
  });
});

describe('drawSocChart', () => {
  it('renders only the battery SoC line and hides the legend when no EV SoC present', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 40, ev_soc_percent: 0 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 45, ev_soc_percent: 0 },
    ];
    drawSocChart(canvas(), rows);

    const cfg = lastRenderConfig();
    expect(cfg.type).toBe('line');
    expect(cfg.data.datasets).toHaveLength(1);
    expect(cfg.data.datasets[0].label).toBe('Battery SoC (%)');
    expect(cfg.data.datasets[0].data).toEqual([40, 45]);
    expect(cfg.data.datasets[0].borderColor).toBe(SOLUTION_COLORS.soc);

    // legend hidden + bottom padding override when no EV
    expect(cfg.options.overrides.plugins.legend).toEqual({ display: false });
    expect(cfg.options.overrides.layout).toEqual({ padding: { bottom: 0 } });
    expect(cfg.options.overrides.scales.y.max).toBe(100);
    expect(makeEvTargetPlugin).not.toHaveBeenCalled();
    expect(cfg.plugins).toEqual([]);
  });

  it('treats a missing ev_soc_percent as zero when deciding hasEvSoc (no EV line)', () => {
    // ev_soc_percent omitted entirely -> hasEvSoc nullish-coalesces to 0 -> false.
    const rows = [
      { timestampMs: T0, soc_percent: 40 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 45 },
    ];
    drawSocChart(canvas(), rows);
    const cfg = lastRenderConfig();
    expect(cfg.data.datasets).toHaveLength(1);
    expect(cfg.options.overrides.plugins.legend).toEqual({ display: false });
  });

  it('adds the EV SoC line and EV target plugin when EV SoC is present', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 40, ev_soc_percent: 20 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 45, ev_soc_percent: 30 },
    ];
    const evSettings = { departureTime: '2099-01-01T12:00:00.000Z', targetSoc_percent: 80 };
    drawSocChart(canvas(), rows, 15, evSettings);

    const cfg = lastRenderConfig();
    expect(cfg.data.datasets).toHaveLength(2);
    const ev = cfg.data.datasets[1];
    expect(ev.label).toBe('EV SoC (%)');
    expect(ev.data).toEqual([20, 30]);
    expect(ev.borderColor).toBe(SOLUTION_COLORS.ev_charge);

    // legend NOT hidden -> overrides.plugins has no legend key; layout undefined
    expect(cfg.options.overrides.plugins.legend).toBeUndefined();
    expect(cfg.options.overrides.layout).toBeUndefined();

    expect(makeEvTargetPlugin).toHaveBeenCalledWith(rows, evSettings.departureTime, evSettings.targetSoc_percent);
    expect(cfg.plugins.map(p => p.id)).toEqual(['evTarget']);
  });

  it('sources the EV SoC line from evSocRows when supplied', () => {
    const rows = [{ timestampMs: T0, soc_percent: 40, ev_soc_percent: 0 }];
    const evSocRows = [{ timestampMs: T0, ev_soc_percent: 55 }];
    drawSocChart(canvas(), rows, 15, null, evSocRows);

    const cfg = lastRenderConfig();
    expect(cfg.data.datasets).toHaveLength(2);
    expect(cfg.data.datasets[1].data).toEqual([55]);
    // evSettings is null -> no target plugin even though EV SoC present
    expect(makeEvTargetPlugin).not.toHaveBeenCalled();
    expect(cfg.plugins).toEqual([]);
  });

  it('handles missing ev_soc_percent fields as 0 in the EV dataset', () => {
    const rows = [
      { timestampMs: T0, soc_percent: 40, ev_soc_percent: 10 },
      { timestampMs: T0 + 15 * MIN, soc_percent: 45 }, // no ev_soc_percent
    ];
    drawSocChart(canvas(), rows);
    expect(lastRenderConfig().data.datasets[1].data).toEqual([10, 0]);
  });

  it('builds a vertical gradient background, falling back to flat rgba without a chart area', () => {
    const rows = [{ timestampMs: T0, soc_percent: 40, ev_soc_percent: 0 }];
    drawSocChart(canvas(), rows);
    const gradientFn = lastRenderConfig().data.datasets[0].backgroundColor;

    // No chartArea -> flat 0.15 rgba of the SoC color.
    expect(gradientFn({ chart: { ctx: {}, chartArea: null } })).toBe(toRGBA(SOLUTION_COLORS.soc, 0.15));

    // With a chart area -> a real gradient with two color stops.
    const stops = [];
    const fakeGradient = { addColorStop: (offset, color) => stops.push([offset, color]) };
    const ctx = { createLinearGradient: vi.fn(() => fakeGradient) };
    const out = gradientFn({ chart: { ctx, chartArea: { top: 0, bottom: 200 } } });
    expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 200);
    expect(out).toBe(fakeGradient);
    expect(stops).toEqual([
      [0, toRGBA(SOLUTION_COLORS.soc, 0.25)],
      [1, toRGBA(SOLUTION_COLORS.soc, 0)],
    ]);
  });

  it('renders the SoC tooltip rows from dataPoints, defaulting time and points', () => {
    const rows = [{ timestampMs: T0, soc_percent: 40, ev_soc_percent: 0 }];
    drawSocChart(canvas(), rows);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;

    const html = external(0, {
      title: ['10:00'],
      dataPoints: [{ dataset: { borderColor: 'C', label: 'Battery SoC (%)' }, raw: 42.6 }],
    });
    expect(html).toBe('H[10:00|]R[C|Battery SoC (%)|43%]');

    // No title and no dataPoints -> empty header, no rows.
    expect(external(0, {})).toBe('H[|]');
  });
});

describe('drawPricesStepLines', () => {
  it('builds stepped buy/sell datasets with a thick stroke for short horizons', () => {
    const rows = [
      { timestampMs: T0, ic: 20, ec: 5 },
      { timestampMs: T0 + 15 * MIN, ic: 22, ec: 6 },
    ];
    drawPricesStepLines(canvas(), rows);

    const cfg = lastRenderConfig();
    expect(cfg.type).toBe('line');
    const [buy, sell] = cfg.data.datasets;
    expect(buy.label).toBe('Buy price');
    expect(buy.data).toEqual([20, 22]);
    expect(buy.borderColor).toBe('#ef4444');
    expect(buy.stepped).toBe(true);
    expect(buy.borderWidth).toBe(2); // <= 48 labels -> width 2
    expect(sell.label).toBe('Sell price');
    expect(sell.data).toEqual([5, 6]);
    expect(sell.borderColor).toBe('#22c55e');

    expect(cfg.options.axis.yTitle).toBe('c€/kWh');
    expect(cfg.plugins.map(p => p.id)).toEqual(['priceZeroLine']);
  });

  it('uses a thin stroke when there are more than 48 slots', () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({
      timestampMs: T0 + i * 15 * MIN, ic: i, ec: 0,
    }));
    drawPricesStepLines(canvas(), rows);
    expect(lastRenderConfig().data.datasets[0].borderWidth).toBe(1);
  });

  it('renders the price tooltip rows with one-decimal values', () => {
    const rows = [{ timestampMs: T0, ic: 20, ec: 5 }];
    drawPricesStepLines(canvas(), rows);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;

    const html = external(0, {
      title: ['10:00'],
      dataPoints: [{ dataset: { borderColor: '#ef4444', label: 'Buy price' }, raw: 19.97 }],
    });
    expect(html).toBe('H[10:00|]R[#ef4444|Buy price|20.0 c€/kWh]');
    expect(external(0, {})).toBe('H[|]'); // no title, no dataPoints
  });

  describe('priceZeroLine plugin', () => {
    function getPlugin() {
      drawPricesStepLines(canvas(), [{ timestampMs: T0, ic: 1, ec: 1 }]);
      return lastRenderConfig().plugins[0];
    }
    function makeCtx() {
      return {
        save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
        moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
        strokeStyle: '', lineWidth: 0,
      };
    }

    it('draws a zero line across the chart when y=0 is inside the area', () => {
      const plugin = getPlugin();
      const ctx = makeCtx();
      plugin.beforeDatasetsDraw({
        ctx,
        chartArea: { top: 0, bottom: 100, left: 10, right: 200 },
        scales: { y: { min: -5, max: 30, getPixelForValue: () => 50 } },
      });
      expect(ctx.strokeStyle).toBe('MAJOR'); // getChartTheme().majorGridColor
      expect(ctx.moveTo).toHaveBeenCalledWith(10, 50);
      expect(ctx.lineTo).toHaveBeenCalledWith(200, 50);
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('skips when there is no chart area', () => {
      const plugin = getPlugin();
      const ctx = makeCtx();
      plugin.beforeDatasetsDraw({ ctx, chartArea: null, scales: { y: {} } });
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('skips when the y range does not straddle zero', () => {
      const plugin = getPlugin();
      const ctx = makeCtx();
      plugin.beforeDatasetsDraw({
        ctx,
        chartArea: { top: 0, bottom: 100, left: 0, right: 10 },
        scales: { y: { min: 5, max: 30, getPixelForValue: () => 50 } },
      });
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('skips when the zero pixel falls outside the chart area', () => {
      const plugin = getPlugin();
      const ctx = makeCtx();
      plugin.beforeDatasetsDraw({
        ctx,
        chartArea: { top: 0, bottom: 100, left: 0, right: 10 },
        scales: { y: { min: -5, max: 30, getPixelForValue: () => 500 } },
      });
      expect(ctx.stroke).not.toHaveBeenCalled();
    });
  });
});

describe('aggregateLoadPvBuckets', () => {
  it('sums hourly load/pv kWh and tracks original adjusted slots', () => {
    const buckets = aggregateLoadPvBuckets([
      { timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 150, originalLoad: 100, pv: 20 },
      { timestampMs: Date.parse('2099-01-01T10:15:00.000Z'), load: 100, pv: 0, originalPv: 30 },
      { timestampMs: Date.parse('2099-01-01T10:30:00.000Z'), load: 100, pv: 10 },
      { timestampMs: Date.parse('2099-01-01T10:45:00.000Z'), load: 100, pv: 10 },
    ], 15);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ hasOriginalLoad: true, hasOriginalPv: true });
    expect(buckets[0].loadKWh).toBeCloseTo(0.1125);
    expect(buckets[0].originalLoadKWh).toBeCloseTo(0.1);
    expect(buckets[0].pvKWh).toBeCloseTo(0.01);
    expect(buckets[0].originalPvKWh).toBeCloseTo(0.0175);
  });

  it('falls back to load/pv for originals when no adjustment is present and sorts buckets by hour', () => {
    const buckets = aggregateLoadPvBuckets([
      { timestampMs: Date.parse('2099-01-01T11:00:00.000Z'), load: 400, pv: 200 },
      { timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 0 },
    ], 60);

    expect(buckets).toHaveLength(2);
    // sorted: 10:00 then 11:00
    expect(buckets[0].dtHour.getTime()).toBeLessThan(buckets[1].dtHour.getTime());
    expect(buckets[0].loadKWh).toBeCloseTo(0.8); // 800 W * 1h
    expect(buckets[0].hasOriginalLoad).toBe(false);
    expect(buckets[0].hasOriginalPv).toBe(false);
    expect(buckets[0].originalLoadKWh).toBeCloseTo(0.8); // falls back to load
  });
});

describe('drawLoadPvGrouped', () => {
  afterEach(() => {
    delete window.pattern;
  });

  it('builds consumption/solar bar datasets and uses plain colors without window.pattern', () => {
    const rows = [
      { timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 400 },
      { timestampMs: Date.parse('2099-01-01T10:15:00.000Z'), load: 800, pv: 400 },
    ];
    drawLoadPvGrouped(canvas(), rows, 15);

    const cfg = lastRenderConfig();
    expect(cfg.type).toBe('bar');
    const [load, pv] = cfg.data.datasets;
    expect(load.label).toBe('Consumption forecast');
    expect(load.series).toBe('load');
    expect(load.borderColor).toBe(SOLUTION_COLORS.g2l);
    // no window.pattern -> backgroundColor is the raw color
    expect(load.backgroundColor).toBe(SOLUTION_COLORS.g2l);
    expect(pv.label).toBe('Solar forecast');
    expect(pv.series).toBe('pv');
    expect(pv.borderColor).toBe(SOLUTION_COLORS.pv2g);

    // 2 x 800 W * 0.25h = 0.4 kWh load, 2 x 400 W * 0.25h = 0.2 kWh pv
    expect(load.data[0]).toBeCloseTo(0.4);
    expect(pv.data[0]).toBeCloseTo(0.2);
    expect(cfg.options.axis.yTitle).toBe('kWh');
  });

  it('uses the diagonal stripe pattern when window.pattern is available', () => {
    window.pattern = { draw: vi.fn((kind, color) => `PATTERN(${kind},${color})`) };
    const rows = [{ timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 400 }];
    drawLoadPvGrouped(canvas(), rows, 15);

    const load = lastRenderConfig().data.datasets[0];
    expect(load.backgroundColor).toBe(`PATTERN(diagonal,${SOLUTION_COLORS.g2l})`);
    expect(window.pattern.draw).toHaveBeenCalledWith('diagonal', SOLUTION_COLORS.g2l);
  });

  it('falls back to the raw color when window.pattern.draw returns falsy', () => {
    window.pattern = { draw: vi.fn(() => null) };
    const rows = [{ timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 400 }];
    drawLoadPvGrouped(canvas(), rows, 15);
    expect(lastRenderConfig().data.datasets[0].backgroundColor).toBe(SOLUTION_COLORS.g2l);
  });

  it('renders the load/pv tooltip and an "Original" row when the forecast was adjusted', () => {
    const rows = [
      { timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 400, originalLoad: 400 },
    ];
    drawLoadPvGrouped(canvas(), rows, 15);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;

    // load bucket: loadKWh = 800*0.25 = 0.2; originalLoadKWh = 400*0.25 = 0.1 (differs > 0.001)
    const html = external(0, {
      title: ['10:00'],
      dataPoints: [{
        dataset: { borderColor: SOLUTION_COLORS.g2l, label: 'Consumption forecast', series: 'load' },
        raw: 0.2,
        dataIndex: 0,
      }],
    });
    expect(html).toContain('H[10:00|]');
    expect(html).toContain(`R[${SOLUTION_COLORS.g2l}|Consumption forecast|KWH(0.200) kWh]`);
    expect(html).toContain(`R[${toRGBA(SOLUTION_COLORS.g2l, 0.45)}|Original consumption forecast|KWH(0.100) kWh]`);
  });

  it('skips null tooltip points and omits the Original row when unchanged', () => {
    const rows = [
      { timestampMs: Date.parse('2099-01-01T10:00:00.000Z'), load: 800, pv: 400 },
    ];
    drawLoadPvGrouped(canvas(), rows, 15);
    const external = lastRenderConfig().options.overrides.plugins.tooltip.external;

    const html = external(0, {
      title: ['10:00'],
      dataPoints: [
        { dataset: { borderColor: SOLUTION_COLORS.pv2g, label: 'Solar forecast', series: 'pv' }, raw: null, dataIndex: 0 },
        { dataset: { borderColor: SOLUTION_COLORS.pv2g, label: 'Solar forecast', series: 'pv' }, raw: 0.2, dataIndex: 0 },
      ],
    });
    // null raw skipped; no original pv adjustment present -> no "Original" row
    expect(html).toContain('Solar forecast');
    expect(html).not.toContain('Original');

    // No title and no dataPoints -> empty header, no rows.
    expect(external(0, {})).toBe('H[|]');
  });
});
