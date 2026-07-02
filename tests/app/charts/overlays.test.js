// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUY_PRICE_STRIP_HEIGHT,
  BUY_PRICE_STRIP_GAP,
  BUY_PRICE_STRIP_TICK_PADDING,
  makeRebalancingPlugin,
  makeNegativePriceInjectionPlugin,
  makeBuyPriceStripPlugin,
  makeForecastOriginalMarkersPlugin,
  makeAdjustmentOverlayPlugin,
} from '../../../app/src/charts/overlays.js';
import { getBuyPriceColor, SOLUTION_COLORS, toRGBA } from '../../../app/src/charts/colors.js';
import { fmtHHMM } from '../../../app/src/charts/core.js';

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

// A 2D canvas context that records method calls and remembers settable props.
function makeRecordingCtx() {
  const calls = [];
  const methods = [
    'save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill',
    'fillRect', 'rect', 'clip', 'closePath', 'setLineDash', 'fillText',
    'arc', 'strokeRect', 'translate', 'rotate', 'quadraticCurveTo', 'bezierCurveTo',
  ];
  const ctx = {
    calls,
    // settable props that the source writes to
    fillStyle: undefined,
    strokeStyle: undefined,
    lineWidth: undefined,
    font: undefined,
    globalAlpha: undefined,
    textAlign: undefined,
    textBaseline: undefined,
    lineJoin: undefined,
  };
  for (const name of methods) {
    ctx[name] = (...args) => {
      calls.push([name, ...args]);
      // Record the value of any property the source sets before this draw call,
      // so geometry-producing calls can be paired with the active style.
    };
  }
  // Helper: find recorded call by method name
  ctx.find = (name) => calls.find(c => c[0] === name);
  ctx.findAll = (name) => calls.filter(c => c[0] === name);
  return ctx;
}

// A linear x scale: pixel = left + value (one px per index unit), width given.
function makeXScale({ left = 100, width = 400 } = {}) {
  return {
    left,
    width,
    getPixelForValue: (v) => left + v,
    getValueForPixel: (p) => p - left,
  };
}

function makeChartArea({ left = 100, right = 500, top = 10, bottom = 210 } = {}) {
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function makeChart({
  chartArea = makeChartArea(),
  xScale = makeXScale(),
  yScale = null,
  labels = null,
  datasets = [],
  ctx = makeRecordingCtx(),
  canvas = null,
} = {}) {
  return {
    ctx,
    chartArea,
    scales: { x: xScale, y: yScale },
    data: { labels, datasets },
    canvas,
    getDatasetMeta: () => ({ data: [] }),
  };
}

function setDark(on) {
  if (on) document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

afterEach(() => {
  setDark(false);
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('strip layout constants', () => {
  it('exposes the strip geometry constants', () => {
    expect(BUY_PRICE_STRIP_HEIGHT).toBe(7);
    expect(BUY_PRICE_STRIP_GAP).toBe(4);
    // tick padding = height + gap + 5
    expect(BUY_PRICE_STRIP_TICK_PADDING).toBe(7 + 4 + 5);
  });
});

// ---------------------------------------------------------------------------
// makeRebalancingPlugin
// ---------------------------------------------------------------------------

describe('makeRebalancingPlugin', () => {
  it('has the expected plugin id', () => {
    expect(makeRebalancingPlugin(0, 1).id).toBe('rebalancingShading');
  });

  it('bails out when there is no chartArea', () => {
    const plugin = makeRebalancingPlugin(0, 2);
    const ctx = makeRecordingCtx();
    plugin.beforeDraw({ ctx, chartArea: null, scales: { x: makeXScale() }, data: { labels: [] } });
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out when there are no labels', () => {
    const plugin = makeRebalancingPlugin(0, 2);
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, labels: [] }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out when the computed region has zero/negative width', () => {
    const plugin = makeRebalancingPlugin(5, 4); // endIdx < startIdx → x1 <= x0
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, labels: new Array(8).fill('') }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('shades the rebalancing window and draws the centered label', () => {
    // N = 8 over width 400 → barW = 50. startIdx=1, endIdx=2.
    const plugin = makeRebalancingPlugin(1, 2);
    const chartArea = makeChartArea({ left: 100, right: 500, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, chartArea, xScale, labels: new Array(8).fill('x') }));

    // x0 = max(100, 100 + 1*50) = 150; x1 = min(500, 100 + 3*50) = 250
    const fillRect = ctx.find('fillRect');
    expect(fillRect).toEqual(['fillRect', 150, 10, 100, 200]);

    const fillText = ctx.find('fillText');
    // centered at (150+250)/2 = 200, y = bottom - 8 = 202
    expect(fillText).toEqual(['fillText', 'Rebalancing', 200, 202]);
    expect(ctx.findAll('save')).toHaveLength(1);
    expect(ctx.findAll('restore')).toHaveLength(1);
  });

  it('clamps the region to the chart area edges', () => {
    // startIdx negative-ish via large range; clamp left to chartArea.left and right to chartArea.right
    const plugin = makeRebalancingPlugin(0, 100); // endIdx huge
    const chartArea = makeChartArea({ left: 100, right: 500, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, chartArea, xScale, labels: new Array(8).fill('x') }));
    const fillRect = ctx.find('fillRect');
    // x0 clamped to 100, x1 clamped to 500 → width 400
    expect(fillRect).toEqual(['fillRect', 100, 10, 400, 200]);
  });
});

// ---------------------------------------------------------------------------
// makeBuyPriceStripPlugin
// ---------------------------------------------------------------------------

describe('makeBuyPriceStripPlugin', () => {
  it('returns null for empty/missing rows', () => {
    expect(makeBuyPriceStripPlugin(null)).toBeNull();
    expect(makeBuyPriceStripPlugin([])).toBeNull();
  });

  it('has the expected plugin id', () => {
    expect(makeBuyPriceStripPlugin([{ ic: 10 }]).id).toBe('buyPriceStrip');
  });

  it('bails out without a chartArea', () => {
    const plugin = makeBuyPriceStripPlugin([{ ic: 10 }]);
    const ctx = makeRecordingCtx();
    plugin.afterDraw({ ctx, chartArea: null, scales: { x: makeXScale() }, data: { labels: ['x'] } });
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out without an x scale or labels', () => {
    const plugin = makeBuyPriceStripPlugin([{ ic: 10 }]);
    const ctx1 = makeRecordingCtx();
    plugin.afterDraw({ ctx: ctx1, chartArea: makeChartArea(), scales: { x: null }, data: { labels: ['x'] } });
    expect(ctx1.calls).toHaveLength(0);

    const ctx2 = makeRecordingCtx();
    plugin.afterDraw(makeChart({ ctx: ctx2, labels: [] }));
    expect(ctx2.calls).toHaveLength(0);
  });

  it('fills one colored cell per slot and strokes the strip outline (light theme)', () => {
    const rows = [{ ic: -5 }, { ic: 0 }, { ic: 20 }, { ic: 35 }];
    const plugin = makeBuyPriceStripPlugin(rows);
    const chartArea = makeChartArea({ left: 100, right: 500, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.afterDraw(makeChart({ ctx, chartArea, xScale, labels: new Array(4).fill('x') }));

    // barW = 400/4 = 100. y = bottom + gap = 210 + 4 = 214. h = 7.
    const fillRects = ctx.findAll('fillRect');
    expect(fillRects).toHaveLength(4);
    expect(fillRects[0]).toEqual(['fillRect', 100, 214, 100, 7]);
    expect(fillRects[1]).toEqual(['fillRect', 200, 214, 100, 7]);
    expect(fillRects[2]).toEqual(['fillRect', 300, 214, 100, 7]);
    expect(fillRects[3]).toEqual(['fillRect', 400, 214, 100, 7]);

    // The strip outline covers the full chart-area width.
    const strokeRect = ctx.find('strokeRect');
    expect(strokeRect).toEqual(['strokeRect', 100, 214, 400, 7]);

    // Last set strokeStyle is the light-theme outline color.
    expect(ctx.strokeStyle).toBe('rgba(255, 255, 255, 0.85)');
    expect(ctx.lineWidth).toBe(1);
    // Last fillStyle equals the last cell's buy-price color.
    expect(ctx.fillStyle).toBe(getBuyPriceColor(35));
  });

  it('uses the dark-theme outline color when in dark mode', () => {
    setDark(true);
    const plugin = makeBuyPriceStripPlugin([{ ic: 10 }]);
    const ctx = makeRecordingCtx();
    plugin.afterDraw(makeChart({ ctx, labels: ['x'] }));
    expect(ctx.strokeStyle).toBe('rgba(15, 23, 42, 0.70)');
  });

  it('limits cells to the smaller of colors.length and label count', () => {
    // 3 rows but only 2 labels → only 2 cells drawn.
    const plugin = makeBuyPriceStripPlugin([{ ic: 1 }, { ic: 2 }, { ic: 3 }]);
    const ctx = makeRecordingCtx();
    plugin.afterDraw(makeChart({ ctx, labels: ['a', 'b'] }));
    expect(ctx.findAll('fillRect')).toHaveLength(2);
  });

  it('skips slots whose clamped width collapses to zero', () => {
    // chartArea narrower than the scale so later slots clamp to zero width.
    const rows = [{ ic: 1 }, { ic: 2 }];
    const plugin = makeBuyPriceStripPlugin(rows);
    // chartArea right = left so every cell collapses (x1 <= x0).
    const chartArea = makeChartArea({ left: 100, right: 100, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.afterDraw(makeChart({ ctx, chartArea, xScale, labels: ['a', 'b'] }));
    expect(ctx.findAll('fillRect')).toHaveLength(0);
    // outline still drawn
    expect(ctx.find('strokeRect')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// makeNegativePriceInjectionPlugin
// ---------------------------------------------------------------------------

describe('makeNegativePriceInjectionPlugin', () => {
  const H = 0.25; // 15-minute slots in hours

  // Build rows where some slots export at negative sell price.
  function negRow(tsMs, { ec = -5, pv2g = 0, b2g = 0 } = {}) {
    return { timestampMs: tsMs, ec, pv2g, b2g };
  }
  function posRow(tsMs) {
    return { timestampMs: tsMs, ec: 10, pv2g: 1000, b2g: 0 };
  }

  const t0 = Date.parse('2026-06-18T10:00:00+02:00');
  const step = 15 * 60 * 1000;

  it('returns null when there are no negative-injection ranges', () => {
    const rows = [posRow(t0), posRow(t0 + step)];
    expect(makeNegativePriceInjectionPlugin(rows, H)).toBeNull();
  });

  it('treats a slot with negative price but no export as a non-range', () => {
    // ec negative but pv2g/b2g zero → exportedPower below epsilon → not injection.
    const rows = [negRow(t0, { ec: -5, pv2g: 0, b2g: 0 })];
    expect(makeNegativePriceInjectionPlugin(rows, H)).toBeNull();
  });

  it('builds a plugin with the expected id when ranges exist', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 2000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    expect(plugin.id).toBe('negativePriceInjectionShading');
  });

  it('beforeDraw bails out without a chartArea', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 2000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const ctx = makeRecordingCtx();
    plugin.beforeDraw({ ctx, chartArea: null, scales: { x: makeXScale() }, data: { labels: ['x'] } });
    expect(ctx.calls).toHaveLength(0);
  });

  it('beforeDraw bails out without labels', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 2000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, labels: [] }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('shades a wide range and draws an info icon (light theme)', () => {
    // 4 slots, the middle two are negative-price exports.
    const rows = [
      posRow(t0),
      negRow(t0 + step, { ec: -5, pv2g: 4000 }),
      negRow(t0 + 2 * step, { ec: -8, pv2g: 4000 }),
      posRow(t0 + 3 * step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const chartArea = makeChartArea({ left: 100, right: 500, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, chartArea, xScale, labels: new Array(4).fill('x') }));

    // barW = 100. Range covers idx 1..2 → x0 = 100+100 = 200, x1 = 100 + 3*100 = 400.
    const fillRect = ctx.find('fillRect');
    expect(fillRect).toEqual(['fillRect', 200, 10, 200, 200]);
    // Light-theme range fill color.
    // (fillStyle is later overwritten by the icon; assert the fillRect happened.)

    // The icon draws an arc and the letter 'i'.
    expect(ctx.find('arc')).toBeTruthy();
    const fillText = ctx.find('fillText');
    expect(fillText[0]).toBe('fillText');
    expect(fillText[1]).toBe('i');
  });

  it('uses the dark-theme range fill color in dark mode', () => {
    setDark(true);
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    // Single wide range: barW = 400 (one label). We capture the fillStyle at the fillRect.
    // Because the icon overwrites fillStyle, record it by wrapping fillRect.
    const ctx = makeRecordingCtx();
    let fillStyleAtRect = null;
    const origFillRect = ctx.fillRect;
    ctx.fillRect = (...a) => { fillStyleAtRect = ctx.fillStyle; origFillRect(...a); };
    plugin.beforeDraw(makeChart({ ctx, labels: ['x'] }));
    expect(fillStyleAtRect).toBe('rgba(245, 158, 11, 0.10)');
  });

  it('uses the light-theme range fill color in light mode', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const ctx = makeRecordingCtx();
    let fillStyleAtRect = null;
    const origFillRect = ctx.fillRect;
    ctx.fillRect = (...a) => { fillStyleAtRect = ctx.fillStyle; origFillRect(...a); };
    plugin.beforeDraw(makeChart({ ctx, labels: ['x'] }));
    expect(fillStyleAtRect).toBe('rgba(245, 158, 11, 0.08)');
  });

  it('skips a range whose clamped width collapses to zero', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const chartArea = makeChartArea({ left: 100, right: 100, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 100, width: 400 });
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, chartArea, xScale, labels: ['x'] }));
    // No fillRect nor icon arc; only save/restore.
    expect(ctx.findAll('fillRect')).toHaveLength(0);
    expect(ctx.find('arc')).toBeUndefined();
  });

  it('centers the icon for a narrow range', () => {
    // Two slots, second is a narrow negative-export range. Make barW small so
    // rangeWidth < ICON_SIZE*1.5 (=19.5) → icon centered at (x0+x1)/2.
    const rows = [posRow(t0), negRow(t0 + step, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    // barW must be < 19.5: width 30 over 2 labels → barW = 15.
    const chartArea = makeChartArea({ left: 0, right: 30, top: 10, bottom: 210 });
    const xScale = makeXScale({ left: 0, width: 30 });
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, chartArea, xScale, labels: ['a', 'b'] }));
    // Range idx 1..1 → x0 = 15, x1 = 30. width = 15 < 19.5 → icon centered at 22.5.
    const arc = ctx.find('arc');
    expect(arc[1]).toBeCloseTo(22.5);
  });

  it('afterEvent hides the tooltip and clears cursor on mouseout', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart } = buildLiveChart();
    plugin.beforeDraw(chart);
    plugin.afterEvent(chart, { event: { type: 'mouseout' } });
    expect(chart.canvas.style.cursor).toBe('');
    // No tooltip element exists / it's hidden.
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    expect(tt == null || tt.style.opacity === '0').toBe(true);
  });

  it('afterEvent hides on a null event', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart } = buildLiveChart();
    plugin.beforeDraw(chart);
    plugin.afterEvent(chart, { event: null });
    expect(chart.canvas.style.cursor).toBe('');
  });

  it('afterEvent clears cursor and hides when not over an icon', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart } = buildLiveChart();
    plugin.beforeDraw(chart);
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: -999, y: -999 } });
    expect(chart.canvas.style.cursor).toBe('');
  });

  it('afterEvent shows a tooltip and a "help" cursor when over an icon', () => {
    // Build a range and read back the icon center to target the event there.
    const rows = [
      posRow(t0),
      negRow(t0 + step, { ec: -5, pv2g: 4000 }),
      negRow(t0 + 2 * step, { ec: -8, pv2g: 4000 }),
      posRow(t0 + 3 * step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart, ctx } = buildLiveChart();
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    const iconX = arc[1];
    const iconY = arc[2];

    plugin.afterEvent(chart, { event: { type: 'mousemove', x: iconX, y: iconY } });
    expect(chart.canvas.style.cursor).toBe('help');

    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    expect(tt).toBeTruthy();
    expect(tt.style.opacity).toBe('1');
    // Title text present.
    expect(tt.querySelector('.ov-icon-tt-title').textContent)
      .toBe('Export at negative sell price');
    // Detail table is rendered because slot count <= 12.
    expect(tt.querySelector('.ov-icon-tt-table')).toBeTruthy();
    // Two slots → two body rows.
    expect(tt.querySelectorAll('.ov-icon-tt-table tbody tr')).toHaveLength(2);
  });

  it('reuses the same tooltip element on subsequent hovers', () => {
    const rows = [
      posRow(t0),
      negRow(t0 + step, { ec: -5, pv2g: 4000 }),
      posRow(t0 + 2 * step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart, ctx } = buildLiveChart();
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    const ev = { type: 'mousemove', x: arc[1], y: arc[2] };
    plugin.afterEvent(chart, { event: ev });
    plugin.afterEvent(chart, { event: ev });
    expect(chart.canvas.parentNode.querySelectorAll('.ov-icon-tt')).toHaveLength(1);
  });

  it('omits the detail table when a range spans more than the detail limit', () => {
    // 13 consecutive negative-export slots → slots.length (13) > 12 → no table.
    const rows = [];
    for (let i = 0; i < 13; i++) {
      rows.push(negRow(t0 + i * step, { ec: -5, pv2g: 4000 }));
    }
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const labels = new Array(13).fill('x');
    const { chart, ctx } = buildLiveChart({ labels, scaleWidth: 1300, areaRight: 1300 });
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    expect(tt.querySelector('.ov-icon-tt-table')).toBeNull();
    // Summary still present.
    expect(tt.querySelector('.ov-icon-tt-summary')).toBeTruthy();
  });

  it('flips the tooltip to the left and clamps vertically near edges', () => {
    const rows = [
      posRow(t0),
      negRow(t0 + step, { ec: -5, pv2g: 4000 }),
      posRow(t0 + 2 * step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart, ctx } = buildLiveChart();
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    // Event near the right edge and bottom to exercise the flip + clamp branches.
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    // Position styles are set (left/top in px).
    expect(tt.style.left).toMatch(/px$/);
    expect(tt.style.top).toMatch(/px$/);
  });

  it('does nothing harmful when the canvas has no parent (ensureIconTooltip null)', () => {
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const ctx = makeRecordingCtx();
    const canvas = document.createElement('canvas');
    // canvas not attached → parentNode is null.
    const chart = makeChart({ ctx, labels: ['x'], canvas });
    chart.canvas.style = {};
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    expect(() => {
      plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });
    }).not.toThrow();
  });

  it('counts battery-to-grid export and tolerates missing/null fields', () => {
    // pv2g undefined, b2g drives export → exercises the b2g term and the
    // Number(...)||0 fallbacks for pv2g and ec.
    const rows = [
      { timestampMs: t0, ec: -5, b2g: 4000 },               // pv2g missing
      { ec: -5, pv2g: 4000 },                               // timestampMs missing → ||0 fallback
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    expect(plugin).not.toBeNull();
    // Both slots are negative-price exports, so one contiguous range exists.
    const ctx = makeRecordingCtx();
    plugin.beforeDraw(makeChart({ ctx, labels: ['a', 'b'] }));
    expect(ctx.find('fillRect')).toBeTruthy();
  });

  it('treats a row whose ec is missing/zero as a non-injection slot', () => {
    // ec missing → Number(row?.ec)||0 = 0, not < 0 → not an injection.
    const rows = [{ timestampMs: t0, pv2g: 4000 }];
    expect(makeNegativePriceInjectionPlugin(rows, H)).toBeNull();
  });

  it('hides an already-shown tooltip on a later mouseout (el present branch)', () => {
    const rows = [
      posRow(t0),
      negRow(t0 + step, { ec: -5, pv2g: 4000 }),
      posRow(t0 + 2 * step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    const { chart, ctx } = buildLiveChart();
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    // First show the tooltip so the element exists.
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    expect(tt.style.opacity).toBe('1');
    // Now mouse out → hideNegativeInjectionTooltip finds el and hides it.
    plugin.afterEvent(chart, { event: { type: 'mouseout' } });
    expect(tt.style.opacity).toBe('0');
  });

  it('positions the tooltip to the right when there is room (no flip, no clamp)', () => {
    // Icon at low x and mid y → x not flipped, y within bounds.
    const rows = [
      negRow(t0, { ec: -5, pv2g: 4000 }),
      posRow(t0 + step),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    // Place the range at the far left and at a mid-height row.
    const { chart, ctx } = buildLiveChartTop({ top: 80, bottom: 280, areaRight: 200 });
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    const iconX = arc[1]; // small x (left side)
    const iconY = arc[2]; // = top + 13 = 93
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: iconX, y: iconY } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    // x = iconX + 12 (right of cursor). ttW falls back to 260, cW=600.
    expect(parseFloat(tt.style.left)).toBeCloseTo(iconX + 12);
    // y = iconY - 60 = 33 (>= 0, and 33+120=153 <= 300) → not clamped.
    expect(parseFloat(tt.style.top)).toBeCloseTo(iconY - 60);
  });

  it('flips the tooltip left and clamps the top to zero near the top-right corner', () => {
    // Icon near the right edge and the top → flip x left, clamp y to 0.
    const rows = [posRow(t0), posRow(t0 + step), negRow(t0 + 2 * step, { ec: -5, pv2g: 4000 })];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    // top=0 → iconY = 13; scale pushes the last-slot range to the right edge.
    const { chart, ctx } = buildLiveChartTop({
      labels: ['a', 'b', 'c'], top: 0, bottom: 200, areaRight: 600, scaleWidth: 600, left: 0,
    });
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    const iconX = arc[1]; // ~413, deep in the right half
    const iconY = arc[2]; // 13
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: iconX, y: iconY } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    // Flip: x = iconX - 260 - 12.
    expect(parseFloat(tt.style.left)).toBeCloseTo(iconX - 260 - 12);
    // Clamp: y = iconY - 60 = -47 < 0 → 0.
    expect(tt.style.top).toBe('0px');
  });

  it('clamps the tooltip top to the bottom edge near the bottom of the canvas', () => {
    // Icon near the bottom → y + ttH > cH → clamp to max(0, cH - ttH).
    const rows = [negRow(t0, { ec: -5, pv2g: 4000 }), posRow(t0 + step)];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);
    // top=240 → iconY = 253. canvas offsetHeight=300, ttH=120.
    const { chart, ctx } = buildLiveChartTop({ top: 240, bottom: 290, areaRight: 200 });
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });
    const tt = chart.canvas.parentNode.querySelector('.ov-icon-tt');
    // y = 253 - 60 = 193; 193 + 120 = 313 > 300 → clamp to max(0, 300-120)=180.
    expect(tt.style.top).toBe('180px');
  });

  // Build a chart with a real attached canvas + parent so DOM tooltip code runs.
  function buildLiveChart({ labels = ['a', 'b', 'c', 'd'], scaleWidth = 400, areaRight = 500 } = {}) {
    return buildLiveChartTop({ labels, scaleWidth, areaRight, top: 10, bottom: 210, left: 100 });
  }

  function buildLiveChartTop({
    labels = ['a', 'b'], scaleWidth = 400, areaRight = 500, top = 10, bottom = 210, left = 100,
  } = {}) {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    // jsdom offset dims default to 0; stub them so positioning math runs.
    Object.defineProperty(canvas, 'offsetWidth', { value: 600, configurable: true });
    Object.defineProperty(canvas, 'offsetHeight', { value: 300, configurable: true });
    const ctx = makeRecordingCtx();
    const chartArea = makeChartArea({ left, right: areaRight, top, bottom });
    const xScale = makeXScale({ left, width: scaleWidth });
    const chart = {
      ctx,
      chartArea,
      scales: { x: xScale, y: null },
      data: { labels, datasets: [] },
      canvas,
      getDatasetMeta: () => ({ data: [] }),
    };
    return { chart, ctx, canvas, parent };
  }
});

// ---------------------------------------------------------------------------
// makeForecastOriginalMarkersPlugin
// ---------------------------------------------------------------------------

describe('makeForecastOriginalMarkersPlugin', () => {
  it('has the expected plugin id', () => {
    expect(makeForecastOriginalMarkersPlugin([], {}).id).toBe('forecastOriginalMarkers');
  });

  it('bails out without a chartArea', () => {
    const plugin = makeForecastOriginalMarkersPlugin([1], {});
    const ctx = makeRecordingCtx();
    plugin.afterDatasetsDraw({ ctx, chartArea: null, scales: { y: {} } });
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out when there are no timestamps', () => {
    const plugin = makeForecastOriginalMarkersPlugin([], {});
    const ctx = makeRecordingCtx();
    plugin.afterDatasetsDraw(makeChart({ ctx, yScale: { getPixelForValue: () => 0 } }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out when there is no y scale', () => {
    const plugin = makeForecastOriginalMarkersPlugin([1], {});
    const ctx = makeRecordingCtx();
    plugin.afterDatasetsDraw(makeChart({ ctx, yScale: null }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('skips datasets without a raw series map', () => {
    const ts = [1000, 2000];
    const plugin = makeForecastOriginalMarkersPlugin(ts, { pv: new Map() });
    const ctx = makeRecordingCtx();
    const chart = makeChart({
      ctx,
      yScale: { getPixelForValue: (v) => 200 - v },
      datasets: [{ series: 'load', data: [1, 2] }], // 'load' has no rawMap
    });
    plugin.afterDatasetsDraw(chart);
    // clip rect drawn, but no marker geometry (no moveTo).
    expect(ctx.find('clip')).toBeTruthy();
    expect(ctx.find('moveTo')).toBeUndefined();
  });

  it('draws a diamond marker where raw differs from adjusted (light theme)', () => {
    const ts = [1000, 2000];
    const rawMap = new Map([[1000, 5], [2000, 8]]);
    const plugin = makeForecastOriginalMarkersPlugin(ts, { pv: rawMap });
    const ctx = makeRecordingCtx();
    // Bars: index 0 differs (raw 5 vs adjusted 5 → same, skipped),
    //       index 1 differs (raw 8 vs adjusted 2 → drawn).
    const meta = {
      data: [
        { getProps: () => ({ x: 120, width: 20 }) },
        { getProps: () => ({ x: 140, width: 20 }) },
      ],
    };
    const chart = {
      ctx,
      chartArea: makeChartArea(),
      scales: { y: { getPixelForValue: (v) => 200 - v } },
      data: { datasets: [{ series: 'pv', data: [5, 2] }] },
      getDatasetMeta: () => meta,
    };
    plugin.afterDatasetsDraw(chart);

    // Only one diamond drawn (index 1). markerSize = max(3.5, min(5, 20*0.22=4.4)) = 4.4
    // rawY = 200 - 8 = 192. moveTo(x, rawY - size).
    const moveTos = ctx.findAll('moveTo');
    expect(moveTos).toHaveLength(1);
    expect(moveTos[0]).toEqual(['moveTo', 140, 192 - 4.4]);
    const lineTos = ctx.findAll('lineTo');
    expect(lineTos).toHaveLength(3);
    expect(lineTos[0]).toEqual(['lineTo', 140 + 4.4, 192]);
    expect(lineTos[1]).toEqual(['lineTo', 140, 192 + 4.4]);
    expect(lineTos[2]).toEqual(['lineTo', 140 - 4.4, 192]);
    // light-theme marker colors
    expect(ctx.fillStyle).toBe('rgba(71, 85, 105, 0.92)');
    expect(ctx.strokeStyle).toBe('rgba(255, 255, 255, 0.95)');
    expect(ctx.lineWidth).toBe(2);
  });

  it('uses dark-theme marker colors in dark mode', () => {
    setDark(true);
    const ts = [1000];
    const rawMap = new Map([[1000, 9]]);
    const plugin = makeForecastOriginalMarkersPlugin(ts, { pv: rawMap });
    const ctx = makeRecordingCtx();
    const meta = { data: [{ getProps: () => ({ x: 120, width: 20 }) }] };
    const chart = {
      ctx,
      chartArea: makeChartArea(),
      scales: { y: { getPixelForValue: (v) => 200 - v } },
      data: { datasets: [{ series: 'pv', data: [1] }] },
      getDatasetMeta: () => meta,
    };
    plugin.afterDatasetsDraw(chart);
    expect(ctx.fillStyle).toBe('rgba(226, 232, 240, 0.96)');
    expect(ctx.strokeStyle).toBe('rgba(15, 23, 42, 0.95)');
  });

  it('skips points where raw==null, adjusted==null, bar missing, or values match', () => {
    const ts = [1000, 2000, 3000, 4000];
    // raw map: 1000 -> null (missing), 2000 -> 5 but adjusted null, 3000 -> 5 same as adjusted, 4000 -> no bar
    const rawMap = new Map([[2000, 5], [3000, 5], [4000, 7]]);
    const plugin = makeForecastOriginalMarkersPlugin(ts, { pv: rawMap });
    const ctx = makeRecordingCtx();
    const meta = {
      data: [
        { getProps: () => ({ x: 1, width: 10 }) }, // ts 1000: raw null → skip
        { getProps: () => ({ x: 2, width: 10 }) }, // ts 2000: adjusted null → skip
        { getProps: () => ({ x: 3, width: 10 }) }, // ts 3000: raw==adjusted → skip
        null,                                       // ts 4000: bar missing → skip
      ],
    };
    const chart = {
      ctx,
      chartArea: makeChartArea(),
      scales: { y: { getPixelForValue: (v) => 200 - v } },
      data: { datasets: [{ series: 'pv', data: [1, null, 5, 9] }] },
      getDatasetMeta: () => meta,
    };
    plugin.afterDatasetsDraw(chart);
    expect(ctx.find('moveTo')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeAdjustmentOverlayPlugin
// ---------------------------------------------------------------------------

describe('makeAdjustmentOverlayPlugin', () => {
  function build(overrides = {}) {
    const calls = { laneCalls: [] };
    const opts = {
      timestamps: [1000, 2000, 3000],
      stepMinutes: 15,
      getAdjustments: () => [],
      getSelection: () => null,
      findAdjustmentIndexes: () => null,
      drawSeriesLane: (chart, i, series, cb) => {
        calls.laneCalls.push({ i, series });
        // call back with deterministic left/width so we can assert fills.
        cb(100 + i * 10, 8);
      },
      ...overrides,
    };
    return { plugin: makeAdjustmentOverlayPlugin(opts), calls, opts };
  }

  it('has the expected plugin id', () => {
    expect(build().plugin.id).toBe('predictionAdjustmentOverlay');
  });

  it('bails out without a chartArea', () => {
    const { plugin } = build();
    const ctx = makeRecordingCtx();
    plugin.beforeDatasetsDraw({ ctx, chartArea: null });
    expect(ctx.calls).toHaveLength(0);
  });

  it('bails out when there are no timestamps', () => {
    const { plugin } = build({ timestamps: [] });
    const ctx = makeRecordingCtx();
    plugin.beforeDatasetsDraw(makeChart({ ctx }));
    expect(ctx.calls).toHaveLength(0);
  });

  it('shades PV adjustments using the pv2g color at 0.10 alpha', () => {
    const adj = { series: 'pv' };
    const { plugin, calls } = build({
      getAdjustments: () => [adj],
      findAdjustmentIndexes: () => ({ first: 0, last: 1 }),
    });
    const ctx = makeRecordingCtx();
    const chartArea = makeChartArea({ top: 10, bottom: 210 });
    let fillStyleAtRect = null;
    const origFillRect = ctx.fillRect;
    ctx.fillRect = (...a) => { fillStyleAtRect = ctx.fillStyle; origFillRect(...a); };
    plugin.beforeDatasetsDraw(makeChart({ ctx, chartArea }));

    // Two slots (0 and 1) → two lane draws → two fillRects.
    expect(calls.laneCalls).toEqual([{ i: 0, series: 'pv' }, { i: 1, series: 'pv' }]);
    expect(ctx.findAll('fillRect')).toHaveLength(2);
    // pv → pv2g color at 0.10 alpha.
    expect(fillStyleAtRect).toBe(toRGBA(SOLUTION_COLORS.pv2g, 0.10));
    // fill spans the chart-area height: top, height = bottom-top.
    expect(ctx.find('fillRect')).toEqual(['fillRect', 100, 10, 8, 200]);
  });

  it('shades non-PV (load) adjustments using the g2l color', () => {
    const adj = { series: 'load' };
    const { plugin } = build({
      getAdjustments: () => [adj],
      findAdjustmentIndexes: () => ({ first: 2, last: 2 }),
    });
    const ctx = makeRecordingCtx();
    let fillStyleAtRect = null;
    const origFillRect = ctx.fillRect;
    ctx.fillRect = (...a) => { fillStyleAtRect = ctx.fillStyle; origFillRect(...a); };
    plugin.beforeDatasetsDraw(makeChart({ ctx }));
    expect(fillStyleAtRect).toBe(toRGBA(SOLUTION_COLORS.g2l, 0.10));
  });

  it('skips an adjustment whose index range cannot be resolved', () => {
    const { plugin, calls } = build({
      getAdjustments: () => [{ series: 'pv' }],
      findAdjustmentIndexes: () => null,
    });
    const ctx = makeRecordingCtx();
    plugin.beforeDatasetsDraw(makeChart({ ctx }));
    expect(calls.laneCalls).toHaveLength(0);
    expect(ctx.findAll('fillRect')).toHaveLength(0);
  });

  it('draws the active selection with fill + stroke outline', () => {
    const selection = { series: 'pv', startIndex: 0, endIndex: 1 };
    const { plugin, calls } = build({
      getSelection: () => selection,
    });
    const ctx = makeRecordingCtx();
    const chartArea = makeChartArea({ top: 10, bottom: 210 });
    plugin.beforeDatasetsDraw(makeChart({ ctx, chartArea }));

    // Two slots in the selection → two lane draws.
    expect(calls.laneCalls).toEqual([{ i: 0, series: 'pv' }, { i: 1, series: 'pv' }]);
    // Each lane draws a fillRect and a strokeRect.
    expect(ctx.findAll('fillRect')).toHaveLength(2);
    expect(ctx.findAll('strokeRect')).toHaveLength(2);
    // Selection colors.
    expect(ctx.fillStyle).toBe('rgba(14, 165, 233, 0.10)');
    expect(ctx.strokeStyle).toBe('rgba(14, 165, 233, 0.75)');
    expect(ctx.lineWidth).toBe(1.5);
    // strokeRect insets by 1px top and 2px height.
    expect(ctx.find('strokeRect')).toEqual(['strokeRect', 100, 11, 8, 198]);
  });

  it('renders both adjustments and an active selection together', () => {
    const { plugin } = build({
      getAdjustments: () => [{ series: 'pv' }],
      findAdjustmentIndexes: () => ({ first: 0, last: 0 }),
      getSelection: () => ({ series: 'load', startIndex: 1, endIndex: 1 }),
    });
    const ctx = makeRecordingCtx();
    plugin.beforeDatasetsDraw(makeChart({ ctx }));
    // 1 adjustment fill + 1 selection fill = 2 fillRects, 1 strokeRect.
    expect(ctx.findAll('fillRect')).toHaveLength(2);
    expect(ctx.findAll('strokeRect')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Negative-injection range computation (indirectly via plugin construction)
// ---------------------------------------------------------------------------

describe('negative-injection range labels (via tooltip content)', () => {
  const H = 0.25;
  const step = 15 * 60 * 1000;
  const t0 = Date.parse('2026-06-18T10:00:00+02:00');

  function negRow(tsMs, ec, pv2g) {
    return { timestampMs: tsMs, ec, pv2g, b2g: 0 };
  }

  it('formats the window/export/cost summary correctly', () => {
    // Two slots: ec -10 (=> -0.10 €/... here cents) exporting 4000 W.
    // export_kWh per slot = 4000 * 0.25 / 1000 = 1 kWh.
    // cost cents per slot = max(0, -(-10) * 1) = 10 cents.
    const rows = [
      negRow(t0, -10, 4000),
      negRow(t0 + step, -10, 4000),
    ];
    const plugin = makeNegativePriceInjectionPlugin(rows, H);

    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    Object.defineProperty(canvas, 'offsetWidth', { value: 600, configurable: true });
    Object.defineProperty(canvas, 'offsetHeight', { value: 300, configurable: true });
    const ctx = makeRecordingCtx();
    const chart = {
      ctx,
      chartArea: makeChartArea({ left: 100, right: 500, top: 10, bottom: 210 }),
      scales: { x: makeXScale({ left: 100, width: 400 }), y: null },
      data: { labels: ['a', 'b'], datasets: [] },
      canvas,
      getDatasetMeta: () => ({ data: [] }),
    };
    plugin.beforeDraw(chart);
    const arc = ctx.find('arc');
    plugin.afterEvent(chart, { event: { type: 'mousemove', x: arc[1], y: arc[2] } });

    const tt = canvas.parentNode.querySelector('.ov-icon-tt');
    const summaryStrongs = [...tt.querySelectorAll('.ov-icon-tt-summary strong')]
      .map(s => s.textContent);
    // Window label uses fmtHHMM of start and end (= start + h*3600s = 15 min after last slot start).
    const winStart = fmtHHMM(new Date(t0));
    const winEnd = fmtHHMM(new Date(t0 + step + H * 3600_000));
    expect(summaryStrongs[0]).toBe(`${winStart}-${winEnd}`);
    // Total export = 2 kWh → "2.00 kWh"
    expect(summaryStrongs[1]).toBe('2.00 kWh');
    // Total cost = 20.0¢
    expect(summaryStrongs[2]).toBe('20.0¢');

    // Per-slot rows: time, "Sell¢", export, cost.
    const firstRowCells = [...tt.querySelectorAll('.ov-icon-tt-table tbody tr')[0].querySelectorAll('td')]
      .map(td => td.textContent);
    expect(firstRowCells[0]).toBe(fmtHHMM(new Date(t0)));
    expect(firstRowCells[1]).toBe('-10.0¢');
    expect(firstRowCells[2]).toBe('1.00');
    expect(firstRowCells[3]).toBe('10.0¢');
  });
});
