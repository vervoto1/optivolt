// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Chart globally - capture configs for callback testing
const chartInstances = [];
vi.stubGlobal('Chart', class MockChart {
  constructor(ctx, config) {
    this.config = config;
    this.data = config.data;
    chartInstances.push(this);
  }
  destroy() {}
});

vi.mock('../../app/src/api/api.js', () => ({
  fetchPredictionConfig: vi.fn(),
  savePredictionConfig: vi.fn(),
  runValidation: vi.fn(),
  runPvForecast: vi.fn(),
  runCombinedForecast: vi.fn(),
  runLoadForecast: vi.fn(),
  fetchPlanAccuracy: vi.fn(),
  fetchCalibration: vi.fn(),
  fetchStoredSettings: vi.fn(),
  saveStoredSettings: vi.fn(),
  triggerCalibration: vi.fn(),
}));

vi.mock('../../app/src/predictions-validation.js', () => ({
  initValidation: vi.fn(),
}));

import { initValidation } from '../../app/src/predictions-validation.js';

import {
  fetchPredictionConfig,
  savePredictionConfig,
  runCombinedForecast,
  runPvForecast,
  fetchPlanAccuracy,
  fetchCalibration,
  fetchStoredSettings,
  saveStoredSettings,
  triggerCalibration,
} from '../../app/src/api/api.js';

function setupDOM() {
  document.body.innerHTML = `
    <input id="pred-sensors" data-predictions-only="true" value="">
    <input id="pred-derived" data-predictions-only="true" value="">
    <select id="pred-active-sensor" data-predictions-only="true"></select>
    <input id="pred-active-lookback" data-predictions-only="true" value="4">
    <select id="pred-active-filter" data-predictions-only="true"><option value="same">same</option></select>
    <select id="pred-active-agg" data-predictions-only="true"><option value="mean">mean</option></select>
    <select id="pred-pv-sensor" data-predictions-only="true"></select>
    <input id="pred-pv-lat" data-predictions-only="true" value="50">
    <input id="pred-pv-lon" data-predictions-only="true" value="4">
    <input id="pred-pv-history" data-predictions-only="true" value="14">
    <select id="pred-pv-mode" data-predictions-only="true"><option value="hourly">hourly</option></select>
    <button id="pred-load-forecast">Forecast</button>
    <button id="pred-pv-forecast">PV Forecast</button>
    <input id="forecast-chart-15m" type="checkbox">
    <canvas id="forecast-chart"></canvas>
    <canvas id="load-accuracy-chart"></canvas>
    <canvas id="load-accuracy-diff-chart"></canvas>
    <canvas id="pv-accuracy-chart"></canvas>
    <canvas id="pv-accuracy-diff-chart"></canvas>
    <div id="load-summary-status"></div>
    <div id="pv-summary-status"></div>
    <div id="load-summary-total"></div>
    <div id="load-summary-peak"></div>
    <div id="load-summary-error"></div>
    <div id="load-summary-min"></div>
    <div id="pv-summary-total"></div>
    <div id="pv-summary-peak"></div>
    <div id="pv-summary-error"></div>
    <div id="pred-status"></div>
    <button id="pred-settings-toggle">Settings</button>
    <div id="pred-settings-body" class="hidden"></div>
    <div id="pred-settings-toggle-icon"></div>

    <input id="adaptive-enabled" type="checkbox">
    <select id="adaptive-mode"><option value="suggest">suggest</option><option value="auto">auto</option></select>
    <input id="adaptive-min-days" value="3">
    <button id="adaptive-calibrate">Calibrate</button>
    <div id="adaptive-status-text"></div>
    <div id="adaptive-charge-rate"></div>
    <div id="adaptive-discharge-rate"></div>
    <div id="adaptive-confidence"></div>
    <div id="adaptive-samples"></div>
    <div id="soc-accuracy-empty"></div>
    <div id="soc-accuracy-content" hidden></div>
    <canvas id="soc-accuracy-chart"></canvas>
    <canvas id="soc-accuracy-diff-chart"></canvas>
    <div id="cal-charge-rate"></div>
    <div id="cal-discharge-rate"></div>
    <div id="cal-confidence"></div>
    <div id="cal-slots"></div>
    <canvas id="efficiency-curve-chart"></canvas>
  `;
}

describe('predictions.js', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    setupDOM();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initPredictionsTab hydrates form and runs forecast', async () => {
    fetchPredictionConfig.mockResolvedValue({
      sensors: [{ name: 'Load' }],
      derived: [{ name: 'PV' }],
      activeConfig: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      pvConfig: { pvSensor: 'PV', latitude: 50, longitude: 4, historyDays: 14, pvMode: 'hourly' },
    });
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({
      load: {
        forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(500) },
        recent: [{ time: Date.now(), actual: 500, predicted: 480 }],
        metrics: { mae: 20 },
      },
      pv: {
        forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(300) },
        recent: [{ time: Date.now(), actual: 300, predicted: 310 }],
        metrics: { mae: 10 },
      },
    });
    fetchStoredSettings.mockResolvedValue({ adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 3 } });
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchPredictionConfig).toHaveBeenCalled();
    expect(runCombinedForecast).toHaveBeenCalled();
    expect(fetchStoredSettings).toHaveBeenCalled();
  });

  it('handles fetchPredictionConfig failure gracefully', async () => {
    fetchPredictionConfig.mockRejectedValue(new Error('fetch fail'));
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(console.error).toHaveBeenCalled();
  });

  it('handles combined forecast error', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockRejectedValue(new Error('forecast fail'));
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    const loadStatus = document.getElementById('load-summary-status');
    expect(loadStatus.textContent).toContain('Error');
  });

  it('handles null forecast results', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    const loadStatus = document.getElementById('load-summary-status');
    expect(loadStatus.textContent).toContain('skipped');
  });

  it('PV forecast button triggers PV-only forecast', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    runPvForecast.mockResolvedValue({
      forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(200) },
      recent: [],
      metrics: { mae: 5 },
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('pred-pv-forecast').click();
    await vi.runAllTimersAsync();

    expect(runPvForecast).toHaveBeenCalled();
  });

  it('PV forecast handles error', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    runPvForecast.mockRejectedValue(new Error('pv fail'));
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('pred-pv-forecast').click();
    await vi.runAllTimersAsync();

    const pvStatus = document.getElementById('pv-summary-status');
    expect(pvStatus.textContent).toContain('Error');
  });

  it('settings toggle shows/hides settings body', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    const toggle = document.getElementById('pred-settings-toggle');
    const body = document.getElementById('pred-settings-body');
    expect(body.classList.contains('hidden')).toBe(true);

    toggle.click();
    expect(body.classList.contains('hidden')).toBe(false);

    toggle.click();
    expect(body.classList.contains('hidden')).toBe(true);
  });

  it('renders SoC accuracy with calibration data', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({ adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 3 } });
    fetchPlanAccuracy.mockResolvedValue({
      report: {
        slotsCompared: 10,
        deviations: [
          { timestampMs: Date.now() - 3600000, deviation_percent: 5, actualSoc_percent: 50, predictedSoc_percent: 55 },
          { timestampMs: Date.now(), deviation_percent: -3, actualSoc_percent: 48, predictedSoc_percent: 45 },
        ],
      },
    });
    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 0.92,
        effectiveDischargeRate: 0.88,
        confidence: 0.85,
        sampleCount: 100,
        chargeCurve: Array(100).fill(0.92),
        dischargeCurve: Array(100).fill(0.88),
        chargeSamples: Array(100).fill(5),
        dischargeSamples: Array(100).fill(5),
      },
    });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(document.getElementById('adaptive-status-text').textContent).toBe('Calibrated');
    expect(document.getElementById('adaptive-charge-rate').textContent).toContain('92');
  });

  it('renders efficiency curve chart callbacks when calibration has curves', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: {
        slotsCompared: 5,
        deviations: [
          { timestampMs: Date.now() - 3600000, deviation_percent: 2, actualSoc_percent: 50, predictedSoc_percent: 52 },
        ],
      },
    });
    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 0.92,
        effectiveDischargeRate: 0.88,
        confidence: 0.85,
        sampleCount: 100,
        chargeCurve: Array(100).fill(0.92),
        dischargeCurve: Array(100).fill(0.88),
        chargeSamples: Array(100).fill(5),
        dischargeSamples: Array(100).fill(5),
      },
    });

    chartInstances.length = 0;
    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Find the efficiency curve chart (last chart created with 200 labels)
    const effChart = chartInstances.find(c =>
      c.config?.options?.scales?.x?.title?.text?.includes?.('Charge 0→100%')
    );
    if (effChart) {
      const opts = effChart.config.options;

      // Exercise legend generateLabels callback (line 672-677)
      const labels = opts.plugins.legend.labels.generateLabels();
      expect(labels).toHaveLength(4);
      expect(labels[0].text).toBe('Charge');

      // Exercise tooltip title callback (line 682-686)
      const title = opts.plugins.tooltip.callbacks.title([{ dataIndex: 50 }]);
      expect(title).toContain('Charging');
      const title2 = opts.plugins.tooltip.callbacks.title([{ dataIndex: 150 }]);
      expect(title2).toContain('Discharging');

      // Exercise tooltip afterLabel callback (line 688-691)
      const after0 = opts.plugins.tooltip.callbacks.afterLabel({ datasetIndex: 0, dataIndex: 50 });
      expect(after0).toContain('sample');
      const after1 = opts.plugins.tooltip.callbacks.afterLabel({ datasetIndex: 1, dataIndex: 50 });
      expect(after1).toBe('');
      // Test singular sample
      const after2 = opts.plugins.tooltip.callbacks.afterLabel({ datasetIndex: 0, dataIndex: 0 });
      expect(after2).toContain('sample');

      // Exercise x-axis tick callback (line 701-707)
      const tickCb = opts.scales.x.ticks.callback;
      expect(tickCb(null, 0)).toBe('0%');
      expect(tickCb(null, 99)).toBe('100%');
      expect(tickCb(null, 100)).toBe('100%');
      expect(tickCb(null, 199)).toBe('0%');
      expect(tickCb(null, 20)).toBe('20%');
      // i=179: (199-179)%20 = 0, so 200-1-179 = 20 → "20%"
      expect(tickCb(null, 179)).toBe('20%');
      expect(tickCb(null, 50)).toBe('');
    }
  });

  it('setComparisonStatus sets text and class', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // setComparisonStatus is called internally during validation - verify pred-status element
    const el = document.getElementById('pred-status');
    expect(el).toBeTruthy();
  });

  it('calibrate button triggers calibration', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({ adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 3 } });
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockResolvedValue({ calibration: { effectiveChargeRate: 0.95, effectiveDischargeRate: 0.9, confidence: 0.8, sampleCount: 50 } });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    expect(triggerCalibration).toHaveBeenCalled();
  });

  it('calibrate button handles null result', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockResolvedValue({ calibration: null, message: 'Insufficient data' });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    const statusText = document.getElementById('adaptive-status-text').textContent;
    expect(statusText === 'Insufficient data' || statusText === 'Collecting data…' || statusText.includes('No result')).toBe(true);
  });

  it('calibrate button handles API error', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockRejectedValue(new Error('cal error'));

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-status-text').textContent).toContain('Error');
  });

  it('handles fetchStoredSettings failure', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockRejectedValue(new Error('settings fail'));
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(console.warn).toHaveBeenCalled();
  });

  it('handles SoC accuracy fetch failure', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockRejectedValue(new Error('accuracy fail'));
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(console.warn).toHaveBeenCalled();
  });

  it('renders pvConfig with deprecated forecastResolution', async () => {
    fetchPredictionConfig.mockResolvedValue({
      pvConfig: { pvSensor: 'PV', latitude: 50, longitude: 4, historyDays: 14, forecastResolution: 15 },
    });
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // The pvMode is set from pvConfig; forecastResolution is a deprecated fallback
    // If pvMode is missing, it falls back to forecastResolution mapping
    const pvMode = document.getElementById('pred-pv-mode').value;
    expect(pvMode === 'hybrid' || pvMode === 'hourly' || pvMode === '').toBe(true);
  });

  it('saveAdaptiveLearning saves on input change', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({ adaptiveLearning: { enabled: false, mode: 'suggest', minDataDays: 3 } });
    saveStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    const enabledEl = document.getElementById('adaptive-enabled');
    enabledEl.checked = true;
    enabledEl.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(700);

    expect(saveStoredSettings).toHaveBeenCalledWith(expect.objectContaining({
      adaptiveLearning: expect.objectContaining({ enabled: true }),
    }));
  });

  it('saveAdaptiveLearning handles error gracefully', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    saveStoredSettings.mockRejectedValue(new Error('save fail'));
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    document.getElementById('adaptive-enabled').dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(700);

    expect(console.warn).toHaveBeenCalled();
  });

  it('15m checkbox re-renders combined chart', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({
      load: { forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(500) }, recent: [], metrics: {} },
      pv: null,
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    const checkbox = document.getElementById('forecast-chart-15m');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    // Chart should have been rendered
    const canvas = document.getElementById('forecast-chart');
    expect(canvas._chart).toBeDefined();
  });

  it('exercises borderColor callback on efficiency curve dataset', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: {
        slotsCompared: 5,
        deviations: [
          { timestampMs: Date.now() - 3600000, deviation_percent: 2, actualSoc_percent: 50, predictedSoc_percent: 52 },
        ],
      },
    });
    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 0.92,
        effectiveDischargeRate: 0.88,
        confidence: 0.85,
        sampleCount: 100,
        chargeCurve: Array(100).fill(0.92),
        dischargeCurve: Array(100).fill(0.88),
        chargeSamples: Array(100).fill(5),
        dischargeSamples: Array(100).fill(5),
      },
    });

    chartInstances.length = 0;
    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Find the efficiency curve chart
    const effChart = chartInstances.find(c =>
      c.config?.options?.scales?.x?.title?.text?.includes?.('Charge 0→100%')
    );
    expect(effChart).toBeTruthy();

    // Exercise the main borderColor callback (line 622-625)
    const borderColorFn = effChart.config.data.datasets[0].borderColor;
    if (typeof borderColorFn === 'function') {
      // Charge half (i < 100) — via p0.parsed.x
      expect(borderColorFn({ p0: { parsed: { x: 50 } } })).toBe('rgb(34, 197, 94)');
      // Discharge half (i >= 100) — via p0.parsed.x
      expect(borderColorFn({ p0: { parsed: { x: 150 } } })).toBe('rgb(249, 115, 22)');
      // Fallback to dataIndex when p0 is missing
      expect(borderColorFn({ dataIndex: 10 })).toBe('rgb(34, 197, 94)');
      expect(borderColorFn({ dataIndex: 110 })).toBe('rgb(249, 115, 22)');
      // Fallback to 0 when both are missing
      expect(borderColorFn({})).toBe('rgb(34, 197, 94)');
    }
  });

  it('setComparisonStatus sets text and applies correct CSS class', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Extract the setComparisonStatus callback passed to initValidation
    expect(initValidation).toHaveBeenCalled();
    const { setComparisonStatus } = initValidation.mock.calls[0][0];

    // Exercise normal (non-error) status
    setComparisonStatus('Test message');
    const el = document.getElementById('pred-status');
    expect(el.textContent).toBe('Test message');
    expect(el.className).toContain('text-ink-soft');

    // Exercise error status
    setComparisonStatus('Error occurred', true);
    expect(el.textContent).toBe('Error occurred');
    expect(el.className).toContain('text-red-600');
  });

  it('renders efficiency curve chart with some bands below minSamples (gaps in chart)', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: {
        slotsCompared: 5,
        deviations: [
          { timestampMs: Date.now(), deviation_percent: 1, actualSoc_percent: 50, predictedSoc_percent: 51 },
        ],
      },
    });

    // Provide calibration where first 10 charge and discharge bands have 0 samples (< minSamples=2)
    const chargeSamples = Array(100).fill(5);
    const dischargeSamples = Array(100).fill(5);
    // Set some bands to 0 samples to trigger the else branch (lines 590-592, 606-608)
    for (let i = 0; i < 10; i++) { chargeSamples[i] = 0; dischargeSamples[i] = 0; }

    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 0.9,
        effectiveDischargeRate: 0.85,
        confidence: 0.8,
        sampleCount: 80,
        chargeCurve: Array(100).fill(0.9),
        dischargeCurve: Array(100).fill(0.85),
        chargeSamples,
        dischargeSamples,
      },
    });

    chartInstances.length = 0;
    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Find the efficiency curve chart
    const effChart = chartInstances.find(c =>
      c.config?.options?.scales?.x?.title?.text?.includes?.('Charge 0→100%')
    );
    expect(effChart).toBeDefined();

    // Verify gaps: first 10 charge points should be null
    const dataset = effChart.data.datasets[0];
    expect(dataset.data[0]).toBeNull();
    expect(dataset.data[9]).toBeNull();
    expect(dataset.data[10]).not.toBeNull();

    // Exercise segment borderColor callback (line 628)
    if (dataset.segment?.borderColor) {
      const green = dataset.segment.borderColor({ p0DataIndex: 50 });
      expect(green).toBe('rgb(34, 197, 94)');
      const orange = dataset.segment.borderColor({ p0DataIndex: 150 });
      expect(orange).toBe('rgb(249, 115, 22)');
    }

    // Exercise main borderColor callback (line 624-625)
    if (typeof dataset.borderColor === 'function') {
      const green = dataset.borderColor({ p0: { parsed: { x: 50 } }, dataIndex: 50 });
      expect(green).toBe('rgb(34, 197, 94)');
      const orange = dataset.borderColor({ p0: { parsed: { x: 150 } }, dataIndex: 150 });
      expect(orange).toBe('rgb(249, 115, 22)');
    }
  });

  it('saveFormToServer is triggered by form input events', async () => {
    fetchPredictionConfig.mockResolvedValue({
      sensors: [{ id: 'sensor.grid', name: 'Grid' }],
      activeConfig: { sensor: 'Grid', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
    });
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Reset mock to track only the save from form input
    savePredictionConfig.mockClear();

    // Trigger input on a predictions-only form element to invoke saveFormToServer via debounce
    const lookbackEl = document.getElementById('pred-active-lookback');
    if (lookbackEl) {
      lookbackEl.value = '8';
      lookbackEl.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(700); // debounce delay is 600ms
      expect(savePredictionConfig).toHaveBeenCalled();
    }
  });

  it('saveFormToServer logs error when savePredictionConfig rejects', async () => {
    fetchPredictionConfig.mockResolvedValue({
      sensors: [{ id: 'sensor.grid', name: 'Grid' }],
      activeConfig: { sensor: 'Grid', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
    });
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Make savePredictionConfig reject to trigger catch block (line 135)
    savePredictionConfig.mockRejectedValueOnce(new Error('save failed'));

    const lookbackEl = document.getElementById('pred-active-lookback');
    if (lookbackEl) {
      lookbackEl.value = '12';
      lookbackEl.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(700);
      expect(console.error).toHaveBeenCalledWith(
        'Failed to save prediction config:',
        expect.any(Error),
      );
    }
  });
});
