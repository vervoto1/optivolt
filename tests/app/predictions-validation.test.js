// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  runValidation: vi.fn(),
  savePredictionConfig: vi.fn(),
}));

import { runValidation, savePredictionConfig } from '../../app/src/api/api.js';
import { initValidation } from '../../app/src/predictions-validation.js';

function setupDOM() {
  document.body.innerHTML = `
    <button id="pred-run-validation">Run Validation</button>
    <div id="pred-results" hidden>
      <div id="pred-sensor-tabs"></div>
      <table><tbody id="pred-metrics-body"></tbody></table>
    </div>
    <div id="pred-no-results"></div>
    <div id="pred-chart-section" hidden>
      <canvas id="pred-accuracy-chart"></canvas>
      <canvas id="pred-accuracy-diff-chart"></canvas>
      <div id="pred-chart-title"></div>
    </div>
  `;
}

describe('predictions-validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDOM();
    // Mock Chart globally
    vi.stubGlobal('Chart', class {
      constructor() { this.data = {}; }
      destroy() {}
    });
  });

  it('initValidation wires the run button', () => {
    const readFormValues = vi.fn(() => ({}));
    const renderLoadConfig = vi.fn();
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig, setComparisonStatus });

    const btn = document.getElementById('pred-run-validation');
    expect(btn).toBeTruthy();
  });

  it('run validation saves config then runs validation', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['sensor1'],
      results: [
        { sensor: 'sensor1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({ sensors: [] }));
    const renderLoadConfig = vi.fn();
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig, setComparisonStatus });

    const btn = document.getElementById('pred-run-validation');
    btn.click();

    // Wait for async operations
    await vi.waitFor(() => {
      expect(setComparisonStatus).toHaveBeenCalledWith(expect.stringContaining('Validation complete'));
    });

    expect(savePredictionConfig).toHaveBeenCalled();
    expect(runValidation).toHaveBeenCalled();
  });

  it('handles save config failure', async () => {
    savePredictionConfig.mockRejectedValue(new Error('save failed'));
    const readFormValues = vi.fn(() => ({}));
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus });

    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(setComparisonStatus).toHaveBeenCalledWith(expect.stringContaining('Save failed'), true);
    });
  });

  it('handles validation API failure', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockRejectedValue(new Error('api error'));
    const readFormValues = vi.fn(() => ({}));
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus });

    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(setComparisonStatus).toHaveBeenCalledWith(expect.stringContaining('Error: api error'), true);
    });
  });

  it('renders sensor tabs and metrics table', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['sensor1', 'sensor2'],
      results: [
        { sensor: 'sensor1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
        { sensor: 'sensor2', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'median', mae: NaN, rmse: NaN, mape: NaN, n: 0, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });

    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      const tabs = document.getElementById('pred-sensor-tabs');
      expect(tabs.querySelectorAll('button').length).toBe(2);
    });
  });

  it('sensor tab click switches active sensor', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1', 's2'],
      results: [
        { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
        { sensor: 's2', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'median', mae: 30, rmse: 40, mape: 8, n: 48, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });

    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      const tabs = document.getElementById('pred-sensor-tabs');
      const buttons = tabs.querySelectorAll('button');
      expect(buttons.length).toBe(2);
      // Click second tab
      buttons[1].click();
      expect(buttons[1].classList.contains('bg-sky-600')).toBe(true);
    });
  });

  it('Use button calls savePredictionConfig and renderLoadConfig', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [
        { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    const renderLoadConfig = vi.fn();
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig, setComparisonStatus });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelector('.btn-use')).toBeTruthy();
    });

    document.querySelector('.btn-use').click();

    await vi.waitFor(() => {
      expect(renderLoadConfig).toHaveBeenCalled();
    });
  });

  it('Use button handles save error', async () => {
    savePredictionConfig.mockResolvedValueOnce({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [
        { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    const renderLoadConfig = vi.fn();
    const setComparisonStatus = vi.fn();

    initValidation({ readFormValues, renderLoadConfig, setComparisonStatus });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelector('.btn-use')).toBeTruthy();
    });

    savePredictionConfig.mockRejectedValueOnce(new Error('save err'));
    document.querySelector('.btn-use').click();

    await vi.waitFor(() => {
      expect(setComparisonStatus).toHaveBeenCalledWith(expect.stringContaining('Failed to save'), true);
    });
  });

  it('Chart button shows accuracy charts', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [
        {
          sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean',
          mae: 50, rmse: 60, mape: 10, n: 96,
          validationPredictions: [
            { date: '2024-01-15', hour: 8, actual: 1000, predicted: 1050 },
            { date: '2024-01-15', hour: 9, actual: 1200, predicted: 1100 },
          ],
        },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelector('.btn-chart')).toBeTruthy();
    });

    document.querySelector('.btn-chart').click();
    expect(document.getElementById('pred-chart-section').hidden).toBe(false);
  });

  it('works when pred-run-validation button missing', () => {
    document.body.innerHTML = '';
    initValidation({ readFormValues: vi.fn(), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });
    // No error
  });

  it('works when result elements missing', async () => {
    document.body.innerHTML = '<button id="pred-run-validation">Run</button>';
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [{ sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] }],
    });

    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(runValidation).toHaveBeenCalled();
    });
  });
});
