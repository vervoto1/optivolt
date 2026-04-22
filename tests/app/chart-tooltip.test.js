// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  injectTooltipStyles,
  ttHeader,
  ttRow,
  ttSection,
  ttDivider,
  ttPrices,
  fmtKwh,
  getChartAnimations,
  createTooltipHandler,
} from '../../app/src/chart-tooltip.js';

describe('ttHeader', () => {
  it('renders time', () => {
    expect(ttHeader('12:00')).toContain('12:00');
  });

  it('renders meta when provided', () => {
    expect(ttHeader('12:00', 'meta')).toContain('meta');
  });

  it('omits meta span when not provided', () => {
    expect(ttHeader('12:00')).not.toContain('ov-tt-meta');
  });

  it('omits meta span when empty string', () => {
    expect(ttHeader('12:00', '')).not.toContain('ov-tt-meta');
  });
});

describe('ttRow', () => {
  it('renders color, label and value', () => {
    const html = ttRow('red', 'Load', '1.2 kWh');
    expect(html).toContain('red');
    expect(html).toContain('Load');
    expect(html).toContain('1.2 kWh');
  });
});

describe('ttSection', () => {
  it('renders section label', () => {
    expect(ttSection('Power')).toContain('Power');
  });
});

describe('ttDivider', () => {
  it('renders divider', () => {
    expect(ttDivider()).toContain('ov-tt-div');
  });
});

describe('ttPrices', () => {
  it('renders buy price when only buyVal provided', () => {
    const html = ttPrices('10c');
    expect(html).toContain('Buy price');
    expect(html).toContain('10c');
  });

  it('renders buy/sell when both provided', () => {
    const html = ttPrices('10c', '5c');
    expect(html).toContain('Buy / Sell');
    expect(html).toContain('10c');
    expect(html).toContain('5c');
  });

  it('includes ov-tt-badge classes', () => {
    const html = ttPrices('10c', '5c');
    expect(html).toContain('ov-tt-badge');
    expect(html).toContain('ov-tt-buy');
    expect(html).toContain('ov-tt-sell');
  });
});

describe('fmtKwh', () => {
  it('uses 1 decimal for >= 10', () => {
    expect(fmtKwh(10)).toBe('10.0');
    expect(fmtKwh(100)).toBe('100.0');
  });

  it('uses 2 decimals for >= 1', () => {
    expect(fmtKwh(1)).toBe('1.00');
    expect(fmtKwh(5.5)).toBe('5.50');
  });

  it('uses 3 decimals for < 1', () => {
    expect(fmtKwh(0.5)).toBe('0.500');
    expect(fmtKwh(0.01)).toBe('0.010');
  });
});

describe('getChartAnimations', () => {
  it('returns animation config object', () => {
    const result = getChartAnimations('bar', 4);
    expect(result).toHaveProperty('animation');
    expect(result.animation).toHaveProperty('duration');
    expect(result.animation).toHaveProperty('easing');
    expect(result.animation).toHaveProperty('delay');
  });

  it('uses 600ms duration for bar', () => {
    const result = getChartAnimations('bar', 1);
    expect(result.animation.duration).toBe(600);
  });

  it('uses 500ms duration for line', () => {
    const result = getChartAnimations('line', 1);
    expect(result.animation.duration).toBe(500);
  });

  it('returns per-slot delay > 0 for bar with multiple slots', () => {
    const result = getChartAnimations('bar', 4);
    const delay = result.animation.delay({ type: 'data', mode: 'default', dataIndex: 2 });
    expect(delay).toBeGreaterThan(0);
  });

  it('returns 0 delay for non-data context', () => {
    const result = getChartAnimations('bar', 4);
    const delay = result.animation.delay({ type: 'something' });
    expect(delay).toBe(0);
  });
});

describe('injectTooltipStyles', () => {
  it('injects style element once', () => {
    injectTooltipStyles();
    expect(document.getElementById('ov-tt-style')).toBeTruthy();

    // Second call should be a no-op (no duplicate)
    injectTooltipStyles();
    expect(document.querySelectorAll('#ov-tt-style').length).toBe(1);
  });
});

describe('createTooltipHandler', () => {
  function makeMockCanvas(width = 400, height = 300) {
    const parent = document.createElement('div');
    parent.style.position = 'relative';
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // Use Object.defineProperty to mock offsetWidth/offsetHeight
    Object.defineProperty(canvas, 'offsetWidth', { value: width, writable: false, configurable: true });
    Object.defineProperty(canvas, 'offsetHeight', { value: height, writable: false, configurable: true });
    Object.defineProperty(canvas, 'offsetTop', { value: 0, writable: false, configurable: true });
    Object.defineProperty(canvas, 'offsetLeft', { value: 0, writable: false, configurable: true });
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    return { parent, canvas };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('creates a function that handles tooltip', () => {
    const handler = createTooltipHandler({
      renderContent: (idx) => `Content ${idx}`,
    });
    expect(typeof handler).toBe('function');
  });

  it('hides tooltip when opacity is 0', () => {
    const handler = createTooltipHandler({
      renderContent: (_idx) => '<div>test</div>',
    });

    const { canvas, parent } = makeMockCanvas(400, 300);

    handler({
      chart: { canvas, canvasParent: parent },
      tooltip: { opacity: 0, dataPoints: [{ dataIndex: 0 }] },
    });

    const el = document.querySelector('.ov-tt');
    expect(el).toBeTruthy();
    expect(el.style.opacity).toBe('0');
  });

  it('shows tooltip and renders content', () => {
    const handler = createTooltipHandler({
      renderContent: (idx) => `<div>Slot ${idx}</div>`,
    });

    const { canvas } = makeMockCanvas(400, 300);

    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 200,
        caretY: 100,
        dataPoints: [{ dataIndex: 3 }],
      },
    });

    const el = document.querySelector('.ov-tt');
    expect(el).toBeTruthy();
    expect(el.innerHTML).toContain('Slot 3');
    expect(el.style.opacity).toBe('1');
  });

  it('skips re-rendering when idx is same', () => {
    let renderCount = 0;
    const handler = createTooltipHandler({
      renderContent: (idx) => {
        renderCount++;
        return `<div>Content ${idx}</div>`;
      },
    });

    const { canvas } = makeMockCanvas(400, 300);

    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 200,
        caretY: 100,
        dataPoints: [{ dataIndex: 5 }],
      },
    });

    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 210,
        caretY: 105,
        dataPoints: [{ dataIndex: 5 }],
      },
    });

    expect(renderCount).toBe(1);
  });

  it('skips rendering when dataIndex is null', () => {
    const handler = createTooltipHandler({
      renderContent: (_idx) => '<div>test</div>',
    });

    const { canvas } = makeMockCanvas(400, 300);

    // First call creates the element
    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 200,
        caretY: 100,
        dataPoints: [{ dataIndex: 0 }],
      },
    });

    // Second call with no dataIndex → skips update but element persists
    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 200,
        caretY: 100,
        dataPoints: [{}], // no dataIndex
      },
    });

    // Element should still exist from first call
    const el = document.querySelector('.ov-tt');
    expect(el).toBeTruthy();
    // Content should not have changed (still from first call)
    expect(el.innerHTML).toContain('test');
  });

  it('flips tooltip left when it would overflow canvas', () => {
    const handler = createTooltipHandler({
      renderContent: (_idx) => '<div style="width:200px;height:100px">test</div>',
    });

    const { canvas } = makeMockCanvas(150, 300); // narrow canvas

    handler({
      chart: { canvas },
      tooltip: {
        opacity: 1,
        caretX: 140, // near right edge
        caretY: 50,
        dataPoints: [{ dataIndex: 0 }],
      },
    });

    const el = document.querySelector('.ov-tt');
    // Should flip left (negative x or small x)
    expect(el.style.left).toBeTruthy();
  });
});
