// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOLUTION_COLORS, toRGBA } from '../../../app/src/charts/colors.js';

// --- Mock the chart rendering layer so render() runs without a real Chart.js. ---
const renderChartCalls = [];

vi.mock('../../../app/src/api/api.js', () => ({
  createPredictionAdjustment: vi.fn(),
  deletePredictionAdjustment: vi.fn(),
  fetchPredictionAdjustments: vi.fn(),
  updatePredictionAdjustment: vi.fn(),
}));

vi.mock('../../../app/src/charts.js', async () => {
  const colors = await import('../../../app/src/charts/colors.js');
  return {
    renderChart: vi.fn((canvas, config) => {
      renderChartCalls.push({ canvas, config });
      // Mimic real renderChart wiring a chart instance onto the canvas.
      canvas._chart = canvas._fakeChart || { update: vi.fn() };
    }),
    getBaseOptions: vi.fn((axis, overrides) => ({ axis, overrides })),
    buildTimeAxisFromTimestamps: vi.fn((timestamps) => ({
      labels: timestamps.map((t) => `L${t}`),
      tooltipTitleCb: vi.fn(() => 'TITLE'),
    })),
    toRGBA: colors.toRGBA,
    SOLUTION_COLORS: colors.SOLUTION_COLORS,
  };
});

vi.mock('../../../app/src/chart-tooltip.js', () => ({
  createTooltipHandler: vi.fn((arg) => ({ __handler: arg })),
  fmtKwh: vi.fn((v) => `K${v}`),
  getChartAnimations: vi.fn(() => ({ animation: false })),
  ttHeader: vi.fn((time) => `HEAD(${time})`),
  ttRow: vi.fn((color, label, value) => `ROW(${color}|${label}|${value})`),
}));

// Capture the args passed to the overlay plugins so we can drive the callbacks directly.
const overlayCalls = [];

vi.mock('../../../app/src/charts/overlays.js', () => ({
  makeAdjustmentOverlayPlugin: vi.fn((arg) => {
    overlayCalls.push(arg);
    return { id: 'adjustmentOverlay', __arg: arg };
  }),
  makeForecastOriginalMarkersPlugin: vi.fn((timestamps, maps) => ({
    id: 'originalMarkers',
    timestamps,
    maps,
  })),
}));

import { createForecastChartController } from '../../../app/src/predictions/forecast-chart.js';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function setupDom() {
  document.body.innerHTML = `
    <canvas id="forecast-chart"></canvas>
    <input id="forecast-chart-15m" type="checkbox" />
    <div id="prediction-adjustments-count"></div>
    <div id="prediction-adjustments-list"></div>
    <div id="forecast-adjustment-popover" class="hidden">
      <div id="forecast-adjustment-title"></div>
      <div id="forecast-adjustment-range"></div>
      <input id="forecast-adjustment-watts" />
      <input id="forecast-adjustment-start" />
      <input id="forecast-adjustment-end" />
      <div id="forecast-adjustment-error" class="hidden"></div>
      <button id="forecast-adjustment-save" type="button"></button>
      <button id="forecast-adjustment-delete" type="button"></button>
      <button id="forecast-adjustment-cancel" type="button"></button>
      <button class="forecast-adjustment-series" data-adjust-series="load" type="button"></button>
      <button class="forecast-adjustment-series" data-adjust-series="pv" type="button"></button>
      <button class="forecast-adjustment-mode" data-adjust-mode="add" type="button"></button>
      <button class="forecast-adjustment-mode" data-adjust-mode="set" type="button"></button>
    </div>
  `;
  Element.prototype.scrollIntoView = vi.fn();
}

// A controllable fake Chart instance that pickForecastBucket / categoryBounds use.
function installFakeChart(area = { left: 0, top: 0, right: 400, bottom: 200 }) {
  const canvas = document.getElementById('forecast-chart');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 });
  const fake = {
    update: vi.fn(),
    chartArea: area,
    data: { labels: [], datasets: [] },
    scales: {
      x: {
        getValueForPixel: (x) => x / 100,
        getPixelForValue: (i) => i * 100,
      },
    },
    getElementsAtEventForMode: vi.fn(() => []),
  };
  canvas._fakeChart = fake;
  return { canvas, fake };
}

function fcLoad(values, { start = '2099-01-01T00:00:00.000Z', step = 60 } = {}) {
  return { start, step, values };
}

beforeEach(() => {
  renderChartCalls.length = 0;
  overlayCalls.length = 0;
  vi.clearAllMocks();
  setupDom();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('forecast-chart render: dataset + axis construction', () => {
  it('returns without rendering when the canvas is missing', () => {
    document.getElementById('forecast-chart').remove();
    const controller = createForecastChartController({ getForecasts: () => ({}) });
    controller.render();
    expect(renderChartCalls).toHaveLength(0);
  });

  it('builds Load and Solar bar datasets with the real solution colors', () => {
    const controller = createForecastChartController({
      getForecasts: () => ({
        load: fcLoad([1000, 2000]),
        pv: fcLoad([0, 3000]),
        rawLoad: fcLoad([1000, 1500]),
        rawPv: fcLoad([0, 3000]),
      }),
    });
    controller.render();

    expect(renderChartCalls).toHaveLength(1);
    const { config } = renderChartCalls[0];
    expect(config.type).toBe('bar');
    const [loadDs, pvDs] = config.data.datasets;

    expect(loadDs.label).toBe('Load');
    expect(loadDs.series).toBe('load');
    expect(loadDs.borderColor).toBe(SOLUTION_COLORS.g2l);
    expect(loadDs.hoverBackgroundColor).toBe(toRGBA(SOLUTION_COLORS.g2l, 0.6));
    expect(loadDs.barPercentage).toBe(0.9);

    expect(pvDs.label).toBe('Solar');
    expect(pvDs.series).toBe('pv');
    expect(pvDs.borderColor).toBe(SOLUTION_COLORS.pv2g);

    // Hourly aggregation: 1000 W and 2000 W over an hour -> 1 and 2 kWh.
    expect(loadDs.data).toEqual([1, 2]);
    expect(pvDs.data).toEqual([0, 3]);

    // Original-markers plugin receives the raw maps keyed by timestamp.
    const markersPlugin = config.plugins[1];
    expect(markersPlugin.id).toBe('originalMarkers');
    expect(markersPlugin.maps.load instanceof Map).toBe(true);
    expect(markersPlugin.maps.pv instanceof Map).toBe(true);
  });

  it('coerces a non-array adjustments value to an empty list', () => {
    const controller = createForecastChartController({ getForecasts: () => ({}) });
    controller.setAdjustments('not-an-array', { renderForecast: false });
    expect(controller.getAdjustments()).toEqual([]);
  });

  it('falls back to empty aggregates when forecasts are absent', () => {
    const controller = createForecastChartController({ getForecasts: () => ({}) });
    controller.render();
    const { config } = renderChartCalls[0];
    expect(config.data.datasets[0].data).toEqual([]);
    expect(config.data.datasets[1].data).toEqual([]);
    expect(config.data.labels).toEqual([]);
  });

  it('switches to a 15-minute step when the 15m toggle is checked', () => {
    document.getElementById('forecast-chart-15m').checked = true;
    const controller = createForecastChartController({
      getForecasts: () => ({ load: fcLoad([1000, 1000, 1000, 1000], { step: 15 }) }),
    });
    controller.render();
    const { config } = renderChartCalls[0];
    // 15-minute resolution keeps four separate buckets (each 1000 W * 0.25h = 0.25 kWh).
    expect(config.data.datasets[0].data).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(config.data.labels).toHaveLength(4);
    // The overlay plugin is told the active resolution.
    expect(overlayCalls[0].stepMinutes).toBe(15);
  });

  it('renders the tooltip showing adjusted and original values, skipping null points', () => {
    const controller = createForecastChartController({
      getForecasts: () => ({
        load: fcLoad([2000]),
        rawLoad: fcLoad([1000]),
        pv: fcLoad([1000]),
        rawPv: fcLoad([1000]),
      }),
    });
    controller.render();
    const { config } = renderChartCalls[0];
    const renderContent = config.options.overrides.plugins.tooltip.external.__handler.renderContent;

    const html = renderContent(0, {
      title: ['09:00'],
      dataPoints: [
        { raw: null, dataIndex: 0, dataset: { borderColor: 'rgb(1,2,3)', label: 'Load', series: 'load' } },
        { raw: 2, dataIndex: 0, dataset: { borderColor: SOLUTION_COLORS.g2l, label: 'Load', series: 'load' } },
      ],
    });
    expect(html).toContain('HEAD(09:00)');
    // The adjusted value row is present.
    expect(html).toContain(`ROW(${SOLUTION_COLORS.g2l}|Load|K2 kWh)`);
    // Raw load (1 kWh) differs from adjusted (2 kWh) -> the "Original load" row is shown.
    expect(html).toContain('Original load');
  });

  it('omits the original-value row when raw matches the adjusted value', () => {
    const controller = createForecastChartController({
      getForecasts: () => ({
        pv: fcLoad([2000]),
        rawPv: fcLoad([2000]),
      }),
    });
    controller.render();
    const renderContent = renderChartCalls[0].config.options.overrides.plugins.tooltip
      .external.__handler.renderContent;
    const html = renderContent(0, {
      dataPoints: [
        { raw: 2, dataIndex: 0, dataset: { borderColor: SOLUTION_COLORS.pv2g, label: 'Solar', series: 'pv' } },
      ],
    });
    expect(html).not.toContain('Original');
  });
});

describe('forecast-chart render: overlay plugin helper callbacks', () => {
  function renderWithAdjustments(adjustments, opts = {}) {
    const controller = createForecastChartController({
      getForecasts: () => ({ load: fcLoad([1000, 1000, 1000], opts) }),
    });
    controller.setAdjustments(adjustments, { renderForecast: false });
    controller.render();
    return overlayCalls[overlayCalls.length - 1];
  }

  function renderWithAdjustments4(adjustments) {
    const controller = createForecastChartController({
      getForecasts: () => ({ load: fcLoad([1000, 1000, 1000, 1000]) }),
    });
    controller.setAdjustments(adjustments, { renderForecast: false });
    controller.render();
    return overlayCalls[overlayCalls.length - 1];
  }

  it('exposes the live selection to the overlay via getSelection', () => {
    const arg = renderWithAdjustments([]);
    // No selection active right after render.
    expect(arg.getSelection()).toBeNull();
    // getAdjustments reflects the controller state.
    expect(arg.getAdjustments()).toEqual([]);
  });

  it('findAdjustmentIndexes returns the overlapping bucket span and null when nothing overlaps', () => {
    const adj = { series: 'load', mode: 'add', value_W: 100, start: '2099-01-01T01:00:00.000Z', end: '2099-01-01T02:30:00.000Z' };
    const arg = renderWithAdjustments([adj]);
    const ts = arg.timestamps;
    expect(ts).toHaveLength(3);

    // Adjustment spans 01:00–02:30 -> covers buckets index 1 and 2.
    expect(arg.findAdjustmentIndexes(adj, ts, 60)).toEqual({ first: 1, last: 2 });

    const noOverlap = { series: 'load', mode: 'add', value_W: 100, start: '2099-01-05T00:00:00.000Z', end: '2099-01-05T01:00:00.000Z' };
    expect(arg.findAdjustmentIndexes(noOverlap, ts, 60)).toBeNull();
  });

  it('findAdjustmentIndexes stops scanning once a bucket starts at/after the adjustment end', () => {
    // Four hourly buckets; adjustment covers only buckets 1 and 2, ending exactly at 03:00.
    const adj = { series: 'load', mode: 'add', value_W: 100, start: '2099-01-01T01:00:00.000Z', end: '2099-01-01T03:00:00.000Z' };
    const arg = renderWithAdjustments4([adj]);
    const ts = arg.timestamps;
    expect(ts).toHaveLength(4);
    // Bucket 3 (03:00) starts at the adjustment end -> the loop breaks there.
    expect(arg.findAdjustmentIndexes(adj, ts, 60)).toEqual({ first: 1, last: 2 });
  });

  it('drawSeriesLane invokes the draw callback with lane bounds for the load lane', () => {
    const arg = renderWithAdjustments([]);
    const chart = {
      scales: { x: { getPixelForValue: (i) => i * 100 } },
      data: { labels: ['a', 'b', 'c'] },
      chartArea: { left: 0, right: 300 },
    };
    const draw = vi.fn();
    arg.drawSeriesLane(chart, 1, 'load', draw);
    expect(draw).toHaveBeenCalledTimes(1);
    const [left, width] = draw.mock.calls[0];
    expect(width).toBeGreaterThan(0);
    expect(Number.isFinite(left)).toBe(true);
  });

  it('drawSeriesLane positions the pv lane on the right half of the bucket', () => {
    const arg = renderWithAdjustments([]);
    const chart = {
      scales: { x: { getPixelForValue: (i) => i * 100 } },
      data: { labels: ['a', 'b', 'c'] },
      chartArea: { left: 0, right: 300 },
    };
    const loadCall = vi.fn();
    const pvCall = vi.fn();
    arg.drawSeriesLane(chart, 1, 'load', loadCall);
    arg.drawSeriesLane(chart, 1, 'pv', pvCall);
    const loadLeft = loadCall.mock.calls[0][0];
    const pvLeft = pvCall.mock.calls[0][0];
    // The pv lane starts to the right of the load lane.
    expect(pvLeft).toBeGreaterThan(loadLeft);
  });

  it('drawSeriesLane skips zero-width lanes', () => {
    const arg = renderWithAdjustments([]);
    // Collapsed bucket bounds (all pixels equal) -> width <= 0 -> draw never called.
    const chart = {
      scales: { x: { getPixelForValue: () => 50 } },
      data: { labels: ['a', 'b', 'c'] },
      chartArea: { left: 50, right: 50 },
    };
    const draw = vi.fn();
    arg.drawSeriesLane(chart, 1, 'load', draw);
    expect(draw).not.toHaveBeenCalled();
  });

  it('categoryBounds uses the previous pixel for the last bucket and the chart area for a single bucket', () => {
    // Single-bucket forecast exercises the chartArea fallback in categoryBounds.
    const arg = renderWithAdjustments([], { step: 60 });
    // Re-render a single-slot forecast so labels.length === 1.
    const single = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000]) }) });
    single.render();
    const singleArg = overlayCalls[overlayCalls.length - 1];
    const chart = {
      scales: { x: { getPixelForValue: () => 100 } },
      data: { labels: ['only'] },
      chartArea: { left: 0, right: 200 },
    };
    const draw = vi.fn();
    singleArg.drawSeriesLane(chart, 0, 'load', draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(arg.timestamps).toHaveLength(3);
  });
});

describe('forecast-chart editing: pointer interactions', () => {
  function setupEditing(adjustments = []) {
    const { canvas, fake } = installFakeChart();
    const controller = createForecastChartController({
      getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }),
    });
    controller.setAdjustments(adjustments, { renderForecast: false });
    controller.wireAdjustmentPopover();
    controller.render();
    return { canvas, fake, controller };
  }

  function pointer(type, props = {}) {
    return new MouseEvent(type, { button: 0, clientX: 150, clientY: 100, ...props });
  }

  it('sets a copy cursor on pointer enter over a bucket and clears it on leave', () => {
    const { canvas } = setupEditing();
    canvas.dispatchEvent(pointer('pointerenter'));
    expect(canvas.style.cursor).toBe('copy');
    canvas.dispatchEvent(pointer('pointerleave'));
    expect(canvas.style.cursor).toBe('');
  });

  it('opens the popover for a new selection on a plain click (no drag)', () => {
    const { canvas } = setupEditing();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();

    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1 }));
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 150, clientY: 100 }));

    const popover = document.getElementById('forecast-adjustment-popover');
    expect(popover.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('forecast-adjustment-title').textContent).toBe('Manual adjustment');
  });

  it('opens an existing adjustment when a plain click lands on it', () => {
    const adj = { id: 'x', series: 'load', mode: 'add', value_W: 100, start: '2099-01-01T01:00:00.000Z', end: '2099-01-01T02:00:00.000Z' };
    const { canvas, fake } = setupEditing([adj]);
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    // Make the hit land on the load dataset at index 1 (bucket 01:00).
    fake.getElementsAtEventForMode = vi.fn(() => [{ datasetIndex: 0, index: 1 }]);
    fake.data.datasets = [{ series: 'load' }, { series: 'pv' }];

    // clientX 110 -> x 110 -> index round(1.1) = 1 -> bucket 01:00, which the adjustment covers.
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 110 }));
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 2, clientX: 110 }));

    expect(document.getElementById('forecast-adjustment-title').textContent).toBe('Edit adjustment');
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('100');
  });

  it('opens a pv-lane new selection as a set/0 draft', () => {
    const { canvas, fake } = setupEditing();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    // Hit lands on the pv dataset (index 1) -> picked series is pv.
    fake.getElementsAtEventForMode = vi.fn(() => [{ datasetIndex: 1, index: 1 }]);
    fake.data.datasets = [{ series: 'load' }, { series: 'pv' }];

    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 7, clientX: 110 }));
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 7, clientX: 110 }));

    expect(document.getElementById('forecast-adjustment-title').textContent).toBe('Manual adjustment');
    // pv lane defaults to set mode with 0 W.
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('0');
  });

  it('tracks a drag selection across buckets and opens a new-selection popover', () => {
    const { canvas, fake } = setupEditing();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();

    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 3, clientX: 50, clientY: 100 }));
    canvas.dispatchEvent(pointer('pointermove', { pointerId: 3, clientX: 250, clientY: 100 }));
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 3, clientX: 250, clientY: 100 }));

    // A drag moved across buckets -> chart asked to redraw the selection.
    expect(fake.update).toHaveBeenCalledWith('none');
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
  });

  it('ignores non-primary buttons and pointer events outside the chart area', () => {
    const { canvas, fake } = setupEditing();
    // Right-click is ignored.
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }));
    // Move with no active drag just updates the cursor.
    canvas.dispatchEvent(pointer('pointermove', { clientX: 150 }));
    // pointerup with no drag is a no-op.
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 9 }));
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(true);

    // A click outside the chart area picks nothing -> no popover.
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 10, clientX: 9999, clientY: 9999 }));
    expect(fake.update).not.toHaveBeenCalledWith('none');
  });

  it('cancels an in-flight drag on pointercancel', () => {
    const { canvas, fake } = setupEditing();
    canvas.setPointerCapture = vi.fn();
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 4, clientX: 150 }));
    canvas.dispatchEvent(pointer('pointercancel'));
    expect(canvas.style.cursor).toBe('');
    expect(fake.update).toHaveBeenCalledWith('none');
  });

  it('keeps the cursor while a drag is active on pointer leave', () => {
    const { canvas } = setupEditing();
    canvas.setPointerCapture = vi.fn();
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 5, clientX: 150 }));
    canvas.style.cursor = 'copy';
    canvas.dispatchEvent(pointer('pointerleave'));
    // Active drag -> the leave handler does not reset the cursor.
    expect(canvas.style.cursor).toBe('copy');
  });

  it('re-wiring the chart cleans up the previous editing listeners', () => {
    const { canvas, controller } = setupEditing();
    const cleanup = canvas._forecastEditCleanup;
    expect(typeof cleanup).toBe('function');
    // A second render should swap in a fresh cleanup fn.
    controller.render();
    expect(canvas._forecastEditCleanup).not.toBe(cleanup);
  });
});

describe('forecast-chart popover: new-selection drafts and error paths', () => {
  function open(controller) {
    controller.wireAdjustmentPopover();
    // Render so editing is wired, then simulate a plain click to open a new selection.
    const { canvas } = installFakeChart();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    controller.render();
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    return canvas;
  }

  it('defaults a new pv selection to a set/0 draft and load to add/blank', () => {
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller);

    // Default new selection is a load lane -> mode add, blank watts.
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('');

    // Switch to the pv series segment -> mode set, watts 0.
    document.querySelector('.forecast-adjustment-series[data-adjust-series="pv"]').click();
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('0');

    // Switching the mode segment updates the draft mode without throwing.
    document.querySelector('.forecast-adjustment-mode[data-adjust-mode="add"]').click();
    // Editing start/end recomputes the displayed range.
    const startEl = document.getElementById('forecast-adjustment-start');
    startEl.value = '2099-02-02T05:00';
    startEl.dispatchEvent(new Event('change'));
    expect(document.getElementById('forecast-adjustment-range').textContent).toContain('–');
  });

  it('surfaces a validation error when watts is not a number', async () => {
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller);
    document.getElementById('forecast-adjustment-watts').value = 'abc';
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();
    const err = document.getElementById('forecast-adjustment-error');
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('Watts must be a number.');
  });

  it('creates the adjustment and closes the popover on a successful save', async () => {
    const api = await import('../../../app/src/api/api.js');
    const created = { id: 'new-1', series: 'load', mode: 'add', value_W: 250, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' };
    api.createPredictionAdjustment.mockResolvedValue({ adjustment: created, adjustments: [created] });
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller);
    document.getElementById('forecast-adjustment-watts').value = '250';
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();

    expect(api.createPredictionAdjustment).toHaveBeenCalledWith(expect.objectContaining({ value_W: 250 }));
    expect(controller.getAdjustments()).toEqual([created]);
    // Popover closes after a successful save.
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(true);
  });

  it('shows an error when the save API call rejects', async () => {
    const api = await import('../../../app/src/api/api.js');
    api.createPredictionAdjustment.mockRejectedValue(new Error('server-down'));
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller);
    document.getElementById('forecast-adjustment-watts').value = '250';
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();
    const err = document.getElementById('forecast-adjustment-error');
    expect(err.textContent).toBe('server-down');
    // Popover stays open after a failed save.
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
  });

  it('shows an error when the delete API call rejects', async () => {
    const api = await import('../../../app/src/api/api.js');
    api.deletePredictionAdjustment.mockRejectedValue(new Error('delete-failed'));
    const existing = { id: 'adj-9', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' };
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    controller.setAdjustments([existing], { renderForecast: false });
    controller.wireAdjustmentPopover();
    document.querySelector('#prediction-adjustments-list button').click();

    document.getElementById('forecast-adjustment-delete').click();
    await flushPromises();
    expect(document.getElementById('forecast-adjustment-error').textContent).toBe('delete-failed');
  });

  it('does nothing when delete is invoked without a saved adjustment id', async () => {
    const api = await import('../../../app/src/api/api.js');
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller); // new (unsaved) selection -> draft has no id
    document.getElementById('forecast-adjustment-delete').click();
    await flushPromises();
    expect(api.deletePredictionAdjustment).not.toHaveBeenCalled();
  });

  it('closes the popover on Escape', () => {
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    open(controller);
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(true);
  });
});

describe('forecast-chart popover: validation and segment wiring branches', () => {
  function openNew(controller) {
    controller.wireAdjustmentPopover();
    const { canvas } = installFakeChart();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    controller.render();
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    return canvas;
  }

  function makeController() {
    return createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
  }

  async function clickSaveAndReadError() {
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();
    return document.getElementById('forecast-adjustment-error').textContent;
  }

  it('rejects an invalid start/end', async () => {
    const controller = makeController();
    openNew(controller);
    document.getElementById('forecast-adjustment-start').value = 'not-a-date';
    document.getElementById('forecast-adjustment-watts').value = '100';
    expect(await clickSaveAndReadError()).toBe('Start and end must be valid.');
  });

  it('rejects an end that is not after the start', async () => {
    const controller = makeController();
    openNew(controller);
    document.getElementById('forecast-adjustment-start').value = '2099-03-03T10:00';
    document.getElementById('forecast-adjustment-end').value = '2099-03-03T09:00';
    document.getElementById('forecast-adjustment-watts').value = '100';
    expect(await clickSaveAndReadError()).toBe('End must be after start.');
  });

  it('rejects a negative value for a set adjustment', async () => {
    const controller = makeController();
    openNew(controller);
    // Switch to pv -> set mode, then enter a negative value.
    document.querySelector('.forecast-adjustment-series[data-adjust-series="pv"]').click();
    document.getElementById('forecast-adjustment-watts').value = '-5';
    expect(await clickSaveAndReadError()).toBe('Set values cannot be negative.');
  });

  it('switching the series back to load restores add mode and a blank value', () => {
    const controller = makeController();
    openNew(controller);
    document.querySelector('.forecast-adjustment-series[data-adjust-series="pv"]').click();
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('0');
    // Switch back to load -> add mode, blank watts (covers the load ternary branch).
    document.querySelector('.forecast-adjustment-series[data-adjust-series="load"]').click();
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('');
  });

  it('keeps the prior bounds when an edited start/end is invalid', () => {
    const controller = makeController();
    openNew(controller);
    const before = document.getElementById('forecast-adjustment-range').textContent;
    const startEl = document.getElementById('forecast-adjustment-start');
    startEl.value = 'garbage';
    startEl.dispatchEvent(new Event('change'));
    // Invalid date -> fromDatetimeLocalValue returns '' -> draft falls back to prior bounds.
    expect(document.getElementById('forecast-adjustment-range').textContent).toBe(before);
  });

  it('ignores segment and date-change clicks when no draft is open', () => {
    const controller = makeController();
    controller.wireAdjustmentPopover();
    // No popover opened -> adjustmentDraft is null; these handlers should bail without throwing.
    expect(() => {
      document.querySelector('.forecast-adjustment-series[data-adjust-series="load"]').click();
      document.querySelector('.forecast-adjustment-mode[data-adjust-mode="set"]').click();
      document.getElementById('forecast-adjustment-start').dispatchEvent(new Event('change'));
    }).not.toThrow();
  });

  it('changing the mode segment on an open draft updates the mode without resetting watts', () => {
    const controller = makeController();
    openNew(controller);
    document.getElementById('forecast-adjustment-watts').value = '300';
    document.querySelector('.forecast-adjustment-mode[data-adjust-mode="set"]').click();
    // Mode flips but watts is preserved.
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('300');
  });

  it('falls back to load/set when a segment button has no dataset attribute', () => {
    const controller = makeController();
    // Strip the dataset attributes so the `|| 'load'` / `|| 'set'` fallbacks fire.
    document.querySelectorAll('.forecast-adjustment-series').forEach((b) => b.removeAttribute('data-adjust-series'));
    document.querySelectorAll('.forecast-adjustment-mode').forEach((b) => b.removeAttribute('data-adjust-mode'));
    openNew(controller);
    expect(() => {
      document.querySelector('.forecast-adjustment-series').click();
      document.querySelector('.forecast-adjustment-mode').click();
    }).not.toThrow();
  });

  it('throws to a non-Error and falls back to String(err) for the popover error message', async () => {
    const api = await import('../../../app/src/api/api.js');
    api.createPredictionAdjustment.mockRejectedValue('plain-string-error');
    const controller = makeController();
    openNew(controller);
    document.getElementById('forecast-adjustment-watts').value = '100';
    expect(await clickSaveAndReadError()).toBe('plain-string-error');
  });

  it('wires the popover even when its control elements are absent', () => {
    // Remove the optional controls so the `?.addEventListener` short-circuits fire.
    for (const id of ['forecast-adjustment-cancel', 'forecast-adjustment-save', 'forecast-adjustment-delete', 'forecast-adjustment-start', 'forecast-adjustment-end']) {
      document.getElementById(id).remove();
    }
    const controller = makeController();
    expect(() => controller.wireAdjustmentPopover()).not.toThrow();
  });

  it('setPopoverError is a no-op when its element is missing', () => {
    // Remove the error element, then trigger a save validation failure path.
    const controller = makeController();
    openNew(controller);
    document.getElementById('forecast-adjustment-error').remove();
    document.getElementById('forecast-adjustment-watts').value = 'abc';
    expect(() => document.getElementById('forecast-adjustment-save').click()).not.toThrow();
  });
});

describe('forecast-chart: cursor and pointer guard branches', () => {
  function setup() {
    const { canvas, fake } = installFakeChart();
    const controller = createForecastChartController({
      getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }),
    });
    controller.render();
    return { canvas, fake, controller };
  }

  function pointer(type, props = {}) {
    return new MouseEvent(type, { button: 0, clientX: 150, clientY: 100, ...props });
  }

  it('clears the cursor on pointer move outside the chart area when not dragging', () => {
    const { canvas } = setup();
    canvas.style.cursor = 'copy';
    // No active drag + outside the chart area -> updateCursor sets ''.
    canvas.dispatchEvent(pointer('pointermove', { clientX: 99999, clientY: 99999 }));
    expect(canvas.style.cursor).toBe('');
  });

  it('returns no bucket when the canvas has no chart instance yet', () => {
    const { canvas } = setup();
    canvas._chart = null;
    canvas._fakeChart = null;
    // pickForecastBucket short-circuits on the missing chart -> cursor cleared, no popover.
    canvas.dispatchEvent(pointer('pointerenter'));
    expect(canvas.style.cursor).toBe('');
  });

  it('defaults the picked series to load when the hit dataset has no series', () => {
    const { canvas, fake } = setup();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    // Hit a dataset that lacks a `series` field -> `|| 'load'` fallback.
    fake.getElementsAtEventForMode = vi.fn(() => [{ datasetIndex: 0 }]);
    fake.data.datasets = [{}, {}];
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 110 }));
    canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 110 }));
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
  });

  it('returns early from pointermove when the drag leaves the chart area', () => {
    const { canvas, fake } = setup();
    canvas.setPointerCapture = vi.fn();
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 110 }));
    const updatesBefore = fake.update.mock.calls.length;
    // Move outside the area -> pickForecastBucket returns null -> handler returns early.
    canvas.dispatchEvent(pointer('pointermove', { clientX: 99999, clientY: 99999 }));
    expect(fake.update.mock.calls.length).toBe(updatesBefore);
  });
});

describe('forecast-chart: remaining defensive and fallback branches', () => {
  function makeController(forecasts = { load: fcLoad([1000, 1000, 1000]) }) {
    return createForecastChartController({ getForecasts: () => forecasts });
  }

  function openNew(controller) {
    controller.wireAdjustmentPopover();
    const { canvas } = installFakeChart();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    controller.render();
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    return canvas;
  }

  it('renders the tooltip header alone when there are no data points', () => {
    const controller = makeController();
    controller.render();
    const renderContent = renderChartCalls[0].config.options.overrides.plugins.tooltip
      .external.__handler.renderContent;
    // No dataPoints -> the `?? []` fallback yields an empty loop.
    expect(renderContent(0, {})).toBe('HEAD()');
  });

  it('keeps the prior end when an edited end value is invalid', () => {
    const controller = makeController();
    openNew(controller);
    const before = document.getElementById('forecast-adjustment-range').textContent;
    const endEl = document.getElementById('forecast-adjustment-end');
    endEl.value = 'bad-end';
    endEl.dispatchEvent(new Event('change'));
    expect(document.getElementById('forecast-adjustment-range').textContent).toBe(before);
  });

  it('ignores non-Escape keydowns', () => {
    const controller = makeController();
    openNew(controller);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // A non-Escape key leaves the popover open.
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
  });

  it('does nothing when openAdjustmentPopover has no popover element', () => {
    const controller = makeController();
    controller.wireAdjustmentPopover();
    const { canvas } = installFakeChart();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    controller.render();
    document.getElementById('forecast-adjustment-popover').remove();
    expect(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
      canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    }).not.toThrow();
  });

  it('returns null payload and saves nothing when clicking save with no open draft', async () => {
    const api = await import('../../../app/src/api/api.js');
    const controller = makeController();
    controller.wireAdjustmentPopover();
    // No popover opened -> adjustmentDraft null -> readAdjustmentPayload returns null, save bails.
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();
    expect(api.createPredictionAdjustment).not.toHaveBeenCalled();
    expect(api.updatePredictionAdjustment).not.toHaveBeenCalled();
  });

  it('falls back to String(err) for a non-Error delete rejection', async () => {
    const api = await import('../../../app/src/api/api.js');
    api.deletePredictionAdjustment.mockRejectedValue('delete-string-error');
    const existing = { id: 'adj-d', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' };
    const controller = makeController();
    controller.setAdjustments([existing], { renderForecast: false });
    controller.wireAdjustmentPopover();
    document.querySelector('#prediction-adjustments-list button').click();
    document.getElementById('forecast-adjustment-delete').click();
    await flushPromises();
    expect(document.getElementById('forecast-adjustment-error').textContent).toBe('delete-string-error');
  });

  it('renderAdjustmentList bails when its container is missing', () => {
    const controller = makeController();
    document.getElementById('prediction-adjustments-list').remove();
    expect(() => controller.setAdjustments([
      { id: 'a', series: 'load', mode: 'add', value_W: 10, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' },
    ], { renderForecast: false })).not.toThrow();
  });

  it('renderAdjustmentList tolerates a missing count element', () => {
    const controller = makeController();
    document.getElementById('prediction-adjustments-count').remove();
    expect(() => controller.setAdjustments([
      { id: 'a', series: 'load', mode: 'add', value_W: 10, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' },
    ], { renderForecast: false })).not.toThrow();
    // The list still renders the adjustment.
    expect(document.querySelector('#prediction-adjustments-list button')).not.toBeNull();
  });

  it('setEl, setVal and getVal tolerate missing elements when opening an existing adjustment', () => {
    const existing = { id: 'adj-m', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' };
    const controller = makeController();
    controller.setAdjustments([existing], { renderForecast: false });
    controller.wireAdjustmentPopover();
    // Drop the title / watts / start inputs so setEl/setVal/getVal hit their `if (el)` / `?.` guards.
    document.getElementById('forecast-adjustment-title').remove();
    document.getElementById('forecast-adjustment-watts').remove();
    document.getElementById('forecast-adjustment-start').remove();
    expect(() => document.querySelector('#prediction-adjustments-list button').click()).not.toThrow();
  });
});

describe('forecast-chart: short-move drag and getVal fallback branches', () => {
  it('flags a drag as moved when the bucket index changes within the 4px threshold', () => {
    // Buckets only 2px wide so a 2px move lands on a different index while distance <= 4.
    const canvas = document.getElementById('forecast-chart');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 });
    const fake = {
      update: vi.fn(),
      chartArea: { left: 0, top: 0, right: 400, bottom: 200 },
      data: { labels: ['a', 'b', 'c'], datasets: [{ series: 'load' }, { series: 'pv' }] },
      scales: { x: { getValueForPixel: (x) => x / 2, getPixelForValue: (i) => i * 2 } },
      getElementsAtEventForMode: vi.fn(() => []),
    };
    canvas._fakeChart = fake;

    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    controller.wireAdjustmentPopover();
    controller.render();
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();

    const ptr = (type, x) => new MouseEvent(type, { button: 0, clientX: x, clientY: 100, pointerId: 1 });
    canvas.dispatchEvent(ptr('pointerdown', 0));   // index round(0) = 0
    canvas.dispatchEvent(ptr('pointermove', 2));   // distance 2 (<=4) but index round(1) = 1 -> moved via index change
    canvas.dispatchEvent(ptr('pointerup', 2));

    // A moved drag opens a manual (new selection) popover, not an existing-adjustment edit.
    expect(document.getElementById('forecast-adjustment-title').textContent).toBe('Manual adjustment');
  });

  it('treats a removed start input as empty when validating a save', async () => {
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad([1000, 1000, 1000]) }) });
    controller.wireAdjustmentPopover();
    const canvas = document.getElementById('forecast-chart');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 });
    canvas._fakeChart = {
      update: vi.fn(),
      chartArea: { left: 0, top: 0, right: 400, bottom: 200 },
      data: { labels: [], datasets: [] },
      scales: { x: { getValueForPixel: (x) => x / 100, getPixelForValue: (i) => i * 100 } },
      getElementsAtEventForMode: vi.fn(() => []),
    };
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    controller.render();
    // Open a new draft.
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 150, clientY: 100, pointerId: 1 }));

    // Remove the start input -> getVal('...start') hits its `?? ''` fallback during save validation.
    document.getElementById('forecast-adjustment-start').remove();
    document.getElementById('forecast-adjustment-watts').value = '100';
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();
    expect(document.getElementById('forecast-adjustment-error').textContent).toBe('Start and end must be valid.');
  });
});

describe('forecast-chart: categoryBounds and findAdjustmentIndexes interior branches', () => {
  function overlayArgFor(values, adjustments = []) {
    const controller = createForecastChartController({ getForecasts: () => ({ load: fcLoad(values) }) });
    controller.setAdjustments(adjustments, { renderForecast: false });
    controller.render();
    return overlayCalls[overlayCalls.length - 1];
  }

  it('categoryBounds falls back to [] labels when chart.data has none', () => {
    const arg = overlayArgFor([1000, 1000, 1000]);
    const draw = vi.fn();
    // data.labels missing -> `chart.data.labels || []` fallback.
    arg.drawSeriesLane({
      scales: { x: { getPixelForValue: (i) => i * 100 } },
      data: {},
      chartArea: { left: 0, right: 300 },
    }, 1, 'load', draw);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('findAdjustmentIndexes returns a single-bucket span for a sub-step adjustment', () => {
    const adj = { series: 'load', mode: 'set', value_W: 100, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T00:45:00.000Z' };
    const arg = overlayArgFor([1000, 1000, 1000]);
    const ts = arg.timestamps; // hourly buckets
    // The 45-minute adjustment only overlaps the first hourly bucket.
    expect(arg.findAdjustmentIndexes(adj, ts, 60)).toEqual({ first: 0, last: 0 });
  });
});

describe('forecast-chart: loadAdjustments error handling', () => {
  it('logs and swallows API failures while loading adjustments', async () => {
    const api = await import('../../../app/src/api/api.js');
    api.fetchPredictionAdjustments.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = createForecastChartController({ getForecasts: () => ({}) });

    await controller.loadAdjustments();

    expect(spy).toHaveBeenCalledWith('Failed to load prediction adjustments:', expect.any(Error));
    spy.mockRestore();
  });
});
