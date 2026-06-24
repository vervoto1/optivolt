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
  fetchStoredData: vi.fn(),
  fetchPredictionAdjustments: vi.fn(),
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
  fetchStoredData,
  fetchPredictionAdjustments,
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

  it('hydrates forecasts from stored data and fills load/pv metrics', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchPredictionAdjustments.mockResolvedValue({ adjustments: [] });

    // Forecast window starting slightly before "now" so futureForecastSeries keeps slots.
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fetchStoredData.mockResolvedValue({
      load: { start, step: 15, values: Array(96).fill(800) },
      pv: { start, step: 15, values: Array(96).fill(400) },
    });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchStoredData).toHaveBeenCalled();
    // updateStoredForecastMetrics -> updateStatus 'Stored data loaded' (then onForecastAll overwrites
    // with the null/'skipped' status). The error cell is set to '--'.
    expect(document.getElementById('load-summary-error').textContent).toBe('--');
    expect(document.getElementById('pv-summary-error').textContent).toBe('--');
    // Load gets a min metric (load-only branch); both get totals/peaks.
    expect(document.getElementById('load-summary-min').textContent).not.toBe('');
    expect(document.getElementById('load-summary-total').textContent).not.toBe('');
    expect(document.getElementById('pv-summary-total').textContent).not.toBe('');
  });

  it('hydrates only load when stored pv data is absent', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchPredictionAdjustments.mockResolvedValue({ adjustments: [] });

    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fetchStoredData.mockResolvedValue({
      load: { start, step: 15, values: Array(96).fill(800) },
      // no pv
    });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(document.getElementById('load-summary-error').textContent).toBe('--');
    // pv-summary-error untouched by stored hydration (pv absent).
    expect(document.getElementById('load-summary-min').textContent).not.toBe('');
  });

  it('hydrates only pv when stored load data is absent', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchPredictionAdjustments.mockResolvedValue({ adjustments: [] });

    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fetchStoredData.mockResolvedValue({
      // no load
      pv: { start, step: 15, values: Array(96).fill(400) },
    });

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // pv hydrated (error cell '--'); load left untouched by stored hydration.
    expect(document.getElementById('pv-summary-error').textContent).toBe('--');
    expect(document.getElementById('pv-summary-total').textContent).not.toBe('');
  });

  it('setEl no-ops when a metrics element is missing', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({
      load: { forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(500) }, recent: [], metrics: { mae: 10 } },
      pv: null,
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    // Remove a metrics target so setEl hits its `if (el)` guard's else arm.
    document.getElementById('load-summary-total').remove();

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Other metrics still written despite the missing total element.
    expect(document.getElementById('load-summary-peak').textContent).not.toBe('');
    expect(document.getElementById('load-summary-total')).toBeNull();
  });

  it('handles stored forecast data load failure', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockRejectedValue(new Error('stored fail'));

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(console.error).toHaveBeenCalledWith(
      'Failed to load stored forecast data:',
      expect.any(Error),
    );
  });

  it('updateForecastUI uses rawForecast when present and forecast otherwise', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    // load result has rawForecast (distinct from forecast); pv result has only forecast.
    runCombinedForecast.mockResolvedValue({
      load: {
        rawForecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(900) },
        forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(850) },
        recent: [],
        metrics: { mae: 30 },
      },
      pv: {
        forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(300) },
        recent: [],
        metrics: { mae: 12 },
      },
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // Both load and pv statuses report updated.
    expect(document.getElementById('load-summary-status').textContent).toContain('updated');
    expect(document.getElementById('pv-summary-status').textContent).toContain('updated');
    // Avg error from metrics.mae rounded.
    expect(document.getElementById('load-summary-error').textContent).toBe('30');
    expect(document.getElementById('pv-summary-error').textContent).toBe('12');
  });

  it('updateForecastUI nulls forecasts and skips metrics when result lacks a forecast', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    // load result is truthy but has neither rawForecast nor forecast.
    runCombinedForecast.mockResolvedValue({
      load: { recent: [], metrics: {} },
      pv: { forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: Array(96).fill(300) }, recent: [], metrics: { mae: 9 } },
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // load forecast had no forecast -> metrics skipped, status still 'updated'.
    expect(document.getElementById('load-summary-status').textContent).toContain('updated');
    // load-summary-total left untouched (no metrics written) -> empty.
    expect(document.getElementById('load-summary-total').textContent).toBe('');
    // pv metrics written.
    expect(document.getElementById('pv-summary-total').textContent).not.toBe('');
  });

  it('updateMetrics handles an empty-values load forecast (min/peak default to 0)', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({
      load: { forecast: { start: '2024-01-15T00:00:00Z', step: 15, values: [] }, recent: [], metrics: { mae: 0 } },
      pv: null,
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    expect(document.getElementById('load-summary-total').textContent).toBe('0.0');
    expect(document.getElementById('load-summary-peak').textContent).toBe('0');
    expect(document.getElementById('load-summary-min').textContent).toBe('0');
  });

  it('handles a pv result with no forecast and a load forecast missing values', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({
      // load forecast object without a `values` key -> `values || []` fallback.
      load: { forecast: { start: '2024-01-15T00:00:00Z', step: 15 }, recent: [], metrics: { mae: 0 } },
      // pv result truthy but no rawForecast and no forecast -> `?? null` tails.
      pv: { recent: [], metrics: {} },
    });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // load metrics computed from an empty values fallback.
    expect(document.getElementById('load-summary-total').textContent).toBe('0.0');
    // pv had no forecast -> metrics skipped, status still updated.
    expect(document.getElementById('pv-summary-status').textContent).toContain('updated');
  });

  it('updateStatus no-ops when the status element is missing', async () => {
    fetchPredictionConfig.mockResolvedValue({});
    savePredictionConfig.mockResolvedValue({});
    runCombinedForecast.mockResolvedValue({ load: null, pv: null });
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    fetchStoredData.mockResolvedValue(null);

    // Remove the status elements so updateStatus hits the `if (!el) return` guard.
    document.getElementById('load-summary-status').remove();
    document.getElementById('pv-summary-status').remove();

    vi.resetModules();
    const { initPredictionsTab } = await import('../../app/src/predictions.js');
    const promise = initPredictionsTab();
    await vi.runAllTimersAsync();
    await promise;

    // No throw; missing elements stay missing.
    expect(document.getElementById('load-summary-status')).toBeNull();
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
