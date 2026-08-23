// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchStrategyPredictions: vi.fn(),
  runValidation: vi.fn(),
  savePredictionConfig: vi.fn(),
}));

import { fetchStrategyPredictions, runValidation, savePredictionConfig } from '../../app/src/api/api.js';
import { initValidation, rerenderTable } from '../../app/src/predictions-validation.js';

function setupDOM() {
  document.body.innerHTML = `
    <button id="pred-run-validation">Run Validation</button>
    <button id="autosel-run">Run Selection</button>
    <div id="pred-results" hidden>
      <div id="pred-sensor-tabs"></div>
      <table><tbody id="pred-metrics-body"></tbody></table>
      <button id="pred-show-all" hidden>Show all</button>
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

  it('rerenderTable is a no-op before any validation results exist', () => {
    rerenderTable({});
    expect(document.getElementById('pred-metrics-body').children.length).toBe(0);
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

  const PREDICTIONS = [
    { date: '2024-01-15', hour: 8, actual: 1000, predicted: 1050 },
    { date: '2024-01-15', hour: 9, actual: 1200, predicted: 1100 },
  ];

  async function renderOneRow(setComparisonStatus = vi.fn()) {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      // Metrics only — the validate payload no longer carries per-hour predictions.
      results: [{ sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] }],
    });
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus });
    document.getElementById('pred-run-validation').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.btn-chart')).toBeTruthy();
    });
    return setComparisonStatus;
  }

  it('Chart button fetches that strategy\'s predictions on demand and shows the charts', async () => {
    const setComparisonStatus = await renderOneRow();
    fetchStrategyPredictions.mockResolvedValue({ validationPredictions: PREDICTIONS });

    document.querySelector('.btn-chart').click();
    await vi.waitFor(() => {
      expect(document.getElementById('pred-chart-section').hidden).toBe(false);
    });
    expect(fetchStrategyPredictions).toHaveBeenCalledWith({ sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(setComparisonStatus).toHaveBeenCalledWith('Loading chart…');
    expect(setComparisonStatus).toHaveBeenLastCalledWith('');
    expect(document.getElementById('pred-chart-title').textContent).toBe('Accuracy: s1 / 4w / same / mean');
  });

  it('Chart button reports a failed predictions fetch instead of opening an empty chart', async () => {
    const setComparisonStatus = await renderOneRow();
    fetchStrategyPredictions.mockRejectedValue(new Error('HA WebSocket timed out'));

    document.querySelector('.btn-chart').click();
    await vi.waitFor(() => {
      expect(setComparisonStatus).toHaveBeenCalledWith('Chart failed: HA WebSocket timed out', true);
    });
    expect(document.getElementById('pred-chart-section').hidden).toBe(true);
  });

  it('Chart button clicked twice destroys previous charts before recreating', async () => {
    await renderOneRow();
    fetchStrategyPredictions.mockResolvedValue({ validationPredictions: PREDICTIONS });

    // First click creates charts
    document.querySelector('.btn-chart').click();
    await vi.waitFor(() => {
      expect(document.getElementById('pred-chart-section').hidden).toBe(false);
    });

    // Second click should destroy existing charts then recreate
    document.querySelector('.btn-chart').click();
    await vi.waitFor(() => {
      expect(fetchStrategyPredictions).toHaveBeenCalledTimes(2);
    });

    // Charts should still be visible (recreated after destroy)
    expect(document.getElementById('pred-chart-section').hidden).toBe(false);
  });

  it('locks both run buttons while a comparison is in flight', async () => {
    savePredictionConfig.mockResolvedValue({});
    let release;
    runValidation.mockReturnValue(new Promise(resolve => { release = resolve; }));
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });

    const runBtn = document.getElementById('pred-run-validation');
    const selectionBtn = document.getElementById('autosel-run');
    runBtn.click();
    await vi.waitFor(() => {
      expect(runBtn.disabled).toBe(true);
    });
    expect(runBtn.textContent).toBe('Running...');
    expect(selectionBtn.disabled).toBe(true);
    expect(selectionBtn.classList.contains('opacity-50')).toBe(true);

    release({ sensorNames: [], results: [] });
    await vi.waitFor(() => {
      expect(runBtn.disabled).toBe(false);
    });
    expect(runBtn.textContent).toBe('Run Validation');
    expect(selectionBtn.disabled).toBe(false);
  });

  it('exposes the show-all toggle state to assistive tech', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: Array.from({ length: 25 }, (_, i) => ({
        sensor: 's1', lookbackWeeks: i + 1, dayFilter: 'all', aggregation: 'mean', mae: 100 + i, rmse: 120, mape: 10, n: 96, validationPredictions: [],
      })),
    });
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });
    document.getElementById('pred-run-validation').click();

    const toggle = document.getElementById('pred-show-all');
    await vi.waitFor(() => {
      expect(toggle.hidden).toBe(false);
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('#pred-metrics-body tr:not([hidden])')).toHaveLength(20);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('#pred-metrics-body tr:not([hidden])')).toHaveLength(25);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('sorts metrics table with NaN mae entries pushed to the end', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [
        { sensor: 's1', lookbackWeeks: 2, dayFilter: 'all', aggregation: 'mean', mae: NaN, rmse: NaN, mape: NaN, n: 0, validationPredictions: [] },
        { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 100, rmse: 120, mape: 15, n: 96, validationPredictions: [] },
        { sensor: 's1', lookbackWeeks: 8, dayFilter: 'same', aggregation: 'median', mae: 50, rmse: 60, mape: 10, n: 192, validationPredictions: [] },
      ],
    });

    const readFormValues = vi.fn(() => ({}));
    initValidation({ readFormValues, renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn() });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      const rows = document.querySelectorAll('#pred-metrics-body tr');
      expect(rows.length).toBe(3);
      // Sorted by mae ascending: 50, 100, NaN
      // mae is in 4th column (index 3) — first row should be lowest mae
      const firstMae = rows[0].querySelectorAll('td')[3]?.textContent;
      expect(firstMae).toContain('50');
      // Last row should be NaN (rendered as —)
      const lastMae = rows[2].querySelectorAll('td')[3]?.textContent;
      expect(lastMae).toBe('—');
    });
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

  it('badges the active and best strategies and collapses rows past the top 20', async () => {
    savePredictionConfig.mockResolvedValue({});
    const results = Array.from({ length: 25 }, (_, i) => ({
      sensor: 's1', lookbackWeeks: i + 1, dayFilter: 'all', aggregation: 'median', mae: 100 + i, rmse: 120, mape: 10, n: 96, validationPredictions: [],
    }));
    runValidation.mockResolvedValue({ sensorNames: ['s1'], results });

    const highlights = {
      active: { sensor: 's1', lookbackWeeks: 23, dayFilter: 'all', aggregation: 'median' }, // beyond the top 20
      best: { sensor: 's1', lookbackWeeks: 1, dayFilter: 'all', aggregation: 'median' },
    };
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn(), getHighlights: () => highlights });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#pred-metrics-body tr').length).toBe(25);
    });

    const rows = [...document.querySelectorAll('#pred-metrics-body tr')];
    expect(rows[0].textContent).toContain('best');
    expect(rows[0].hidden).toBe(false);
    expect(rows[22].textContent).toContain('active');
    expect(rows[22].hidden).toBe(false);
    expect(rows[19].hidden).toBe(false);
    expect(rows[20].hidden).toBe(true);
    expect(rows[24].hidden).toBe(true);

    const showAll = document.getElementById('pred-show-all');
    expect(showAll.hidden).toBe(false);
    expect(showAll.textContent).toBe('Show all 25 strategies');

    showAll.click();
    expect([...document.querySelectorAll('#pred-metrics-body tr')].every(tr => !tr.hidden)).toBe(true);
    expect(showAll.textContent).toBe('Show top 20');

    showAll.click();
    expect(document.querySelectorAll('#pred-metrics-body tr')[24].hidden).toBe(true);
  });

  it('hides the show-all toggle when the table fits and moves the active badge after Use', async () => {
    savePredictionConfig.mockResolvedValue({});
    runValidation.mockResolvedValue({
      sensorNames: ['s1'],
      results: [
        { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', mae: 50, rmse: 60, mape: 10, n: 96, validationPredictions: [] },
        { sensor: 's1', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median', mae: 70, rmse: 80, mape: 12, n: 96, validationPredictions: [] },
      ],
    });

    let active = { sensor: 's1', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' };
    const renderLoadConfig = vi.fn(cfg => { active = cfg; });
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig, setComparisonStatus: vi.fn(), getHighlights: () => ({ active, best: null }) });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#pred-metrics-body tr').length).toBe(2);
    });
    expect(document.getElementById('pred-show-all').hidden).toBe(true);
    let rows = document.querySelectorAll('#pred-metrics-body tr');
    expect(rows[0].textContent).toContain('active');
    expect(rows[1].textContent).not.toContain('active');

    rows[1].querySelector('.btn-use').click();
    await vi.waitFor(() => {
      rows = document.querySelectorAll('#pred-metrics-body tr');
      expect(rows[1].textContent).toContain('active');
    });
    expect(rows[0].textContent).not.toContain('active');
  });

  it('does not badge an identical strategy on a different sensor tab', async () => {
    savePredictionConfig.mockResolvedValue({});
    // The same 8w/all/median strategy exists for both sensors.
    const mk = (sensor, mae) => ({
      sensor, lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median',
      mae, rmse: 120, mape: 10, n: 672, validationPredictions: [],
    });
    runValidation.mockResolvedValue({
      sensorNames: ['Total Load', 'Load without EV'],
      results: [mk('Total Load', 500), mk('Load without EV', 300)],
    });

    // Both the active predictor and the last run's best belong to "Load without EV".
    const highlights = {
      active: { sensor: 'Load without EV', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median' },
      best: { sensor: 'Load without EV', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median' },
    };
    initValidation({ readFormValues: vi.fn(() => ({})), renderLoadConfig: vi.fn(), setComparisonStatus: vi.fn(), getHighlights: () => highlights });
    document.getElementById('pred-run-validation').click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#pred-metrics-body tr').length).toBe(1);
    });

    // The first tab rendered is "Total Load" — a different sensor, so neither badge applies.
    const row = document.querySelector('#pred-metrics-body tr');
    expect(row.textContent).not.toContain('active');
    expect(row.textContent).not.toContain('best');
  });
});
