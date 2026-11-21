// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTimeAxisFromTimestamps,
  dismissChartHighlights,
  getBaseOptions,
  getStoredSharedCrosshair,
  initSharedCrosshairToggle,
  renderChart,
  setSharedCrosshairEnabled,
  sharedCrosshairPlugin,
} from '../../../app/src/charts/core.js';

const MIN15 = 15 * 60 * 1000;
const HOUR = 4 * MIN15;
const T0 = 1781733600000; // a local midnight

// Chart.js stand-in with what the crosshair touches: a category x scale whose
// pixel for slot i is 100 + 10·i, a chart area, a canvas context that records
// strokes, and the hover/tooltip state the dismiss handler clears.
class FakeChart {
  constructor(ctx, config) {
    this.config = config;
    this.canvas = ctx.canvas;
    this.chartArea = { top: 5, bottom: 95, width: 400 };
    this.scales = {
      x: {
        getPixelForValue: (i) => 100 + 10 * i,
        getValueForPixel: (px) => (px - 100) / 10,
      },
    };
    this.lines = [];
    this.draws = 0;
    this.updates = [];
    this.active = [];
    const lines = this.lines;
    let path = [];
    this.ctx = {
      save() {}, restore() {}, setLineDash() {},
      beginPath() { path = []; },
      moveTo(x, y) { path.push([x, y]); },
      lineTo(x, y) { path.push([x, y]); },
      stroke() { lines.push(path); },
    };
    this.tooltip = {
      getActiveElements: () => this.active,
      setActiveElements: (els) => { this.active = els; },
    };
  }
  draw() {
    this.draws += 1;
    this.lines.length = 0;
    sharedCrosshairPlugin.afterDatasetsDraw(this);
  }
  getActiveElements() { return this.active; }
  setActiveElements(els) { this.active = els; }
  update(mode) { this.updates.push(mode); }
  destroy() {}
  static getChart() { return undefined; }
}

function chartFor(timestampsMs) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);
  renderChart(canvas, { type: 'bar', data: { labels: axis.labels, datasets: [] }, options: getBaseOptions(axis) });
  return canvas._chart;
}

const slots = (n, step) => Array.from({ length: n }, (_, i) => T0 + i * step);

function hover(chart, x, type = 'mousemove', inChartArea = true) {
  const args = { event: { type, x }, inChartArea, changed: false };
  sharedCrosshairPlugin.afterEvent(chart, args);
  return args;
}

beforeEach(() => {
  vi.stubGlobal('Chart', FakeChart);
  HTMLCanvasElement.prototype.getContext = function getContext() { return { canvas: this }; };
  document.body.innerHTML = '';
  localStorage.clear();
  setSharedCrosshairEnabled(false);
});

afterEach(() => {
  setSharedCrosshairEnabled(false);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shared crosshair', () => {
  it('hands each chart its slot timestamps through getBaseOptions', () => {
    const times = slots(4, MIN15);
    const chart = chartFor(times);
    expect(chart.config.options.plugins.sharedCrosshair).toEqual({ timestampsMs: times });
    expect(chart.config.plugins).toContain(sharedCrosshairPlugin);
  });

  it('does nothing while it is off', () => {
    const a = chartFor(slots(8, MIN15));
    const b = chartFor(slots(8, MIN15));
    const args = hover(a, 130);
    expect(args.changed).toBe(false);
    expect(b.draws).toBe(0);
  });

  it('marks the hovered moment on the other charts, placed by time across resolutions', () => {
    setSharedCrosshairEnabled(true);
    const quarter = chartFor(slots(8, MIN15)); // 15 min SoC-style chart
    const hourly = chartFor(slots(2, HOUR)); // 1 h flows bars

    // Hover slot 5 of the 15 min chart: T0 + 1 h 15 min.
    const args = hover(quarter, 150);
    expect(args.changed).toBe(true);
    expect(quarter.draws).toBe(0); // Chart.js repaints the hovered chart itself (args.changed)
    expect(hourly.draws).toBe(1);
    // A quarter of the way into the second hourly bar: 110 + 0.25 · 10.
    expect(hourly.lines).toEqual([[[112.5, 5], [112.5, 95]]]);

    // Mid-plan bars interpolate between ticks too: slot 2 of the 15 min chart
    // (T0 + 30 min) on a 3-bar hourly chart is half-way into its first bar.
    const hourly3 = chartFor(slots(3, HOUR));
    hover(quarter, 120);
    expect(hourly3.lines).toEqual([[[105, 5], [105, 95]]]);

    // Same slot again: no further repaint.
    hover(quarter, 121);
    expect(hourly.draws).toBe(2);
  });

  it('clamps to the first/last slot and ignores events outside the chart area', () => {
    setSharedCrosshairEnabled(true);
    const a = chartFor(slots(4, MIN15));
    const b = chartFor(slots(4, MIN15));
    hover(a, 9999);
    expect(b.lines).toEqual([[[130, 5], [130, 95]]]);
    const outside = hover(a, 100, 'mousemove', false);
    expect(outside.changed).toBe(false);
    hover(a, 100, 'click');
    expect(b.lines).toEqual([[[130, 5], [130, 95]]]);
  });

  it('draws nothing on a chart whose range does not contain the moment', () => {
    setSharedCrosshairEnabled(true);
    const plan = chartFor(slots(4, MIN15));
    const later = chartFor(slots(4, MIN15).map(t => t + 10 * HOUR));
    hover(plan, 110);
    expect(later.draws).toBe(1);
    expect(later.lines).toEqual([]);
  });

  it('clears the line when the pointer leaves the chart', () => {
    setSharedCrosshairEnabled(true);
    const a = chartFor(slots(4, MIN15));
    const b = chartFor(slots(4, MIN15));
    hover(a, 110);
    expect(b.lines.length).toBe(1);
    hover(a, 0, 'mouseout');
    expect(b.lines).toEqual([]);
  });

  it('skips charts on hidden tabs when repainting', () => {
    setSharedCrosshairEnabled(true);
    const a = chartFor(slots(4, MIN15));
    const hidden = chartFor(slots(4, MIN15));
    hidden.chartArea.width = 0;
    hover(a, 110);
    expect(hidden.draws).toBe(0);
  });
});

describe('initSharedCrosshairToggle', () => {
  it('starts off, then stores and applies every change', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    initSharedCrosshairToggle(input);
    expect(input.checked).toBe(false);

    const a = chartFor(slots(4, MIN15));
    const b = chartFor(slots(4, MIN15));
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('optivolt:sharedCrosshair')).toBe('on');
    expect(getStoredSharedCrosshair()).toBe(true);
    hover(a, 110);
    expect(b.lines.length).toBe(1);

    input.checked = false;
    input.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('optivolt:sharedCrosshair')).toBe('off');
    expect(hover(a, 120).changed).toBe(false);
  });

  it('restores a stored "on"', () => {
    localStorage.setItem('optivolt:sharedCrosshair', 'on');
    const input = document.createElement('input');
    input.type = 'checkbox';
    initSharedCrosshairToggle(input);
    expect(input.checked).toBe(true);
  });

  it('stays off and does not throw when storage is blocked', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const input = document.createElement('input');
      input.type = 'checkbox';
      initSharedCrosshairToggle(input);
      expect(input.checked).toBe(false);
      input.checked = true;
      expect(() => input.dispatchEvent(new Event('change'))).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('ignores a missing checkbox', () => {
    expect(() => initSharedCrosshairToggle(null)).not.toThrow();
  });
});

describe('dismissing tooltips', () => {
  it('a tap outside the charts closes every open tooltip and the crosshair', () => {
    setSharedCrosshairEnabled(true);
    const a = chartFor(slots(4, MIN15));
    const b = chartFor(slots(4, MIN15));
    a.active = [{ index: 1 }];
    hover(a, 110);
    expect(b.lines.length).toBe(1);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(a.active).toEqual([]);
    expect(a.updates).toEqual(['none']);
    expect(b.updates).toEqual([]); // nothing open there: left alone
    expect(b.lines).toEqual([]);
  });

  it('a tap on one chart closes the others but keeps its own', () => {
    const a = chartFor(slots(4, MIN15));
    const b = chartFor(slots(4, MIN15));
    a.active = [{ index: 1 }];
    b.active = [{ index: 2 }];
    a.canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(a.active).toEqual([{ index: 1 }]);
    expect(b.active).toEqual([]);
  });

  it('scrolling closes open tooltips', () => {
    const a = chartFor(slots(4, MIN15));
    a.active = [{ index: 0 }];
    window.dispatchEvent(new Event('scroll'));
    expect(a.active).toEqual([]);
  });

  it('can be called directly with no charts on the page', () => {
    expect(() => dismissChartHighlights(null)).not.toThrow();
  });
});
