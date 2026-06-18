// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the rendering/core layer (via the charts.js barrel) so we can capture
// the chart CONFIG produced by the accuracy charts without a real canvas render.
vi.mock('../../app/src/charts.js', () => ({
  renderChart: vi.fn(),
  getBaseOptions: vi.fn((axis, overrides) => ({ axis, overrides })),
  buildTimeAxisFromTimestamps: vi.fn((timestampsMs) => ({
    labels: timestampsMs.map((_, i) => `t${i}`),
    ticksCb: () => 'tick',
    tooltipTitleCb: () => 'title',
    gridCb: () => 'grid',
  })),
}));

// Make createTooltipHandler return renderContent directly so the tooltip HTML
// branches can be exercised by invoking external(idx, tooltip).
vi.mock('../../app/src/chart-tooltip.js', () => ({
  createTooltipHandler: vi.fn(({ renderContent }) => renderContent),
  getChartAnimations: vi.fn((type, n) => ({ animation: { type, n } })),
  ttHeader: vi.fn((time, meta = '') => `H[${time}|${meta}]`),
  ttRow: vi.fn((color, label, value) => `R[${color}|${label}|${value}]`),
  ttDivider: vi.fn(() => 'DIV'),
}));

vi.mock('../../app/src/api/api.js', () => ({
  fetchCalibration: vi.fn(),
  fetchPlanAccuracy: vi.fn(),
  fetchStoredSettings: vi.fn(),
  saveStoredSettings: vi.fn(),
  triggerCalibration: vi.fn(),
}));

import { renderChart } from '../../app/src/charts.js';
import {
  fetchCalibration,
  fetchPlanAccuracy,
  fetchStoredSettings,
  saveStoredSettings,
  triggerCalibration,
} from '../../app/src/api/api.js';
import { initAdaptiveLearning } from '../../app/src/predictions/adaptive-learning.js';

function setupDom({ full = true } = {}) {
  document.body.innerHTML = full ? `
    <input id="adaptive-enabled" type="checkbox">
    <select id="adaptive-mode"><option value="suggest">suggest</option><option value="auto">auto</option></select>
    <input id="adaptive-min-days" value="3">
    <button id="adaptive-calibrate">Calibrate</button>
    <div id="adaptive-status-text"></div>
    <div id="adaptive-charge-rate"></div>
    <div id="adaptive-discharge-rate"></div>
    <div id="adaptive-confidence"></div>
    <div id="adaptive-samples"></div>
    <div id="ev-charge-curve-status"></div>
    <div id="soc-accuracy-empty"></div>
    <div id="soc-accuracy-content" hidden></div>
    <canvas id="soc-accuracy-chart"></canvas>
    <canvas id="soc-accuracy-diff-chart"></canvas>
    <div id="cal-charge-rate"></div>
    <div id="cal-discharge-rate"></div>
    <div id="cal-confidence"></div>
    <div id="cal-slots"></div>
  ` : '';
}

/** The chart config passed to a given renderChart call (0 = overlay, 1 = diff). */
function renderConfig(callIndex) {
  return renderChart.mock.calls[callIndex][1];
}

/** Convenience: the tooltip external (== renderContent) of a render call. */
function tooltipExternal(callIndex) {
  return renderConfig(callIndex).options.overrides.plugins.tooltip.external;
}

describe('adaptive-learning.js', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    setupDom();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hydrates controls from stored settings and renders calibration metrics', async () => {
    fetchStoredSettings.mockResolvedValue({
      adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 7 },
    });
    fetchPlanAccuracy.mockResolvedValue({
      report: {
        slotsCompared: 12,
        deviations: [
          { timestampMs: 2000, actualSoc_percent: 50, predictedSoc_percent: 55 },
          { timestampMs: 1000, actualSoc_percent: 48, predictedSoc_percent: 45 },
        ],
      },
    });
    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 0.923,
        effectiveDischargeRate: 0.881,
        confidence: 0.85,
        sampleCount: 100,
      },
      evCalibration: {
        confidence: 0.7,
        effectiveChargeRate: 0.82,
        sampleCount: 40,
      },
    });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-enabled').checked).toBe(true);
    expect(document.getElementById('adaptive-mode').value).toBe('auto');
    expect(document.getElementById('adaptive-min-days').value).toBe('7');

    expect(document.getElementById('adaptive-status-text').textContent).toBe('Calibrated');
    expect(document.getElementById('adaptive-charge-rate').textContent).toBe('92.3%');
    expect(document.getElementById('adaptive-discharge-rate').textContent).toBe('88.1%');
    expect(document.getElementById('adaptive-confidence').textContent).toBe('85%');
    expect(document.getElementById('adaptive-samples').textContent).toBe('100');

    // content shown, empty hidden
    expect(document.getElementById('soc-accuracy-empty').hidden).toBe(true);
    expect(document.getElementById('soc-accuracy-content').hidden).toBe(false);

    // calibration panel metrics
    expect(document.getElementById('cal-charge-rate').textContent).toBe('92.3%');
    expect(document.getElementById('cal-discharge-rate').textContent).toBe('88.1%');
    expect(document.getElementById('cal-confidence').textContent).toBe('85%');
    // cal-slots is overwritten by sampleCount after slotsCompared
    expect(document.getElementById('cal-slots').textContent).toBe('100');

    // EV taper status with >=50% confidence => "applied"
    expect(document.getElementById('ev-charge-curve-status').textContent)
      .toBe('Learned taper: 70% confidence, ~82% avg acceptance, 40 samples — applied when enabled.');

    // Two charts rendered (overlay + diff). Sorting orders timestamps ascending.
    expect(renderChart).toHaveBeenCalledTimes(2);
    expect(renderConfig(0).data.datasets[0].data).toEqual([48, 50]);
    expect(renderConfig(0).data.datasets[1].data).toEqual([45, 55]);
    // diff = predicted - actual
    expect(renderConfig(1).data.datasets[0].data).toEqual([-3, 5]);
  });

  it('overlay tooltip renders header and a row per data point, defaulting time', () => {
    // Drive renderPercentAccuracyCharts indirectly through the full flow.
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: { slotsCompared: 1, deviations: [{ timestampMs: 1, actualSoc_percent: 10, predictedSoc_percent: 12 }] },
    });
    fetchCalibration.mockResolvedValue({ calibration: null });

    return (async () => {
      await initAdaptiveLearning();
      await vi.runAllTimersAsync();

      const overlay = tooltipExternal(0);
      const html = overlay(0, {
        title: ['09:00'],
        dataPoints: [
          { dataset: { borderColor: 'C1', label: 'Actual SoC (%)' }, raw: 42.6 },
          { dataset: { borderColor: 'C2', label: 'Predicted SoC (%)' }, raw: 47.1 },
        ],
      });
      expect(html).toBe('H[09:00|]R[C1|Actual SoC (%)|42.6%]R[C2|Predicted SoC (%)|47.1%]');

      // No title, no dataPoints -> empty header, no rows.
      expect(overlay(0, {})).toBe('H[|]');
    })();
  });

  it('diff tooltip renders positive and negative deltas, and bare header when no point', () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: { slotsCompared: 1, deviations: [{ timestampMs: 1, actualSoc_percent: 10, predictedSoc_percent: 12 }] },
    });
    fetchCalibration.mockResolvedValue({ calibration: null });

    return (async () => {
      await initAdaptiveLearning();
      await vi.runAllTimersAsync();

      const diff = tooltipExternal(1);

      // Positive delta -> green color, leading '+'
      expect(diff(0, { title: ['10:00'], dataPoints: [{ raw: 3.4 }] }))
        .toBe('H[10:00|]DIVR[rgb(139,201,100)|Pred - Actual|+3.4%]');

      // Negative delta -> red color, no '+', absolute value
      expect(diff(0, { title: ['11:00'], dataPoints: [{ raw: -2.6 }] }))
        .toBe('H[11:00|]DIVR[rgb(233,122,131)|Pred - Actual|2.6%]');

      // No dataPoints -> bare header (and defaulted empty time)
      expect(diff(0, {})).toBe('H[|]');
    })();
  });

  it('shows collecting state and only EV-empty status when no calibration and no report', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-status-text').textContent).toBe('Collecting data...');
    expect(document.getElementById('ev-charge-curve-status').textContent)
      .toBe('Learned taper: collecting EV charge history…');
    // No report and no calibration -> early return before toggling empty/content.
    expect(document.getElementById('soc-accuracy-content').hidden).toBe(true);
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('renders calibration without a deviations report (no charts, slots from sampleCount)', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: { slotsCompared: 5, deviations: [] } });
    fetchCalibration.mockResolvedValue({
      calibration: {
        effectiveChargeRate: 1, effectiveDischargeRate: 1, confidence: 0.5, sampleCount: 30,
      },
    });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    // deviations empty -> charts skipped, but cal panel filled.
    expect(renderChart).not.toHaveBeenCalled();
    expect(document.getElementById('cal-slots').textContent).toBe('30');
    // EV taper: confidence 0 default => needs >=50% message.
    expect(document.getElementById('ev-charge-curve-status').textContent)
      .toBe('Learned taper: collecting EV charge history…');
  });

  it('EV taper status below 50% confidence shows the "needs" message with defaults', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({
      calibration: null,
      evCalibration: { sampleCount: 3 }, // confidence/rate undefined -> defaults applied
    });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(document.getElementById('ev-charge-curve-status').textContent)
      .toBe('Learned taper: 0% confidence, ~100% avg acceptance, 3 samples — needs ≥50% confidence to apply.');
  });

  it('calibrate button calibrates, re-renders, and reports Calibrated', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockResolvedValue({ calibration: { foo: 'bar' } });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-min-days').value = '5';
    const btn = document.getElementById('adaptive-calibrate');
    btn.click();
    await vi.runAllTimersAsync();

    expect(triggerCalibration).toHaveBeenCalledWith(5);
    expect(document.getElementById('adaptive-status-text').textContent).toBe('Calibrated');
    // Button restored after finally block.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Calibrate');
    expect(btn.classList.contains('opacity-50')).toBe(false);
  });

  it('calibrate button falls back to minDays=1 and reports message when no calibration', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockResolvedValue({ calibration: null, message: 'Insufficient data' });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-min-days').value = '';
    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    expect(triggerCalibration).toHaveBeenCalledWith(1);
    expect(document.getElementById('adaptive-status-text').textContent).toBe('Insufficient data');
  });

  it('calibrate button reports "No result" when no calibration and no message', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockResolvedValue({ calibration: null });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-status-text').textContent).toBe('No result');
  });

  it('calibrate button surfaces errors', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    triggerCalibration.mockRejectedValue(new Error('boom'));

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-calibrate').click();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-status-text').textContent).toBe('Error: boom');
  });

  it('debounced save persists enabled/mode/minDataDays on input', async () => {
    fetchStoredSettings.mockResolvedValue({
      adaptiveLearning: { enabled: false, mode: 'suggest', minDataDays: 3 },
    });
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    saveStoredSettings.mockResolvedValue({});

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    const enabled = document.getElementById('adaptive-enabled');
    enabled.checked = true;
    document.getElementById('adaptive-mode').value = 'auto';
    document.getElementById('adaptive-min-days').value = '9';
    enabled.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(700);

    expect(saveStoredSettings).toHaveBeenCalledWith({
      adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 9 },
    });
  });

  it('debounced save uses defaults when control values are missing/invalid', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    saveStoredSettings.mockResolvedValue({});

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    // Make min-days non-numeric so parseInt -> NaN -> default 3.
    document.getElementById('adaptive-min-days').value = 'abc';
    document.getElementById('adaptive-mode').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(700);

    expect(saveStoredSettings).toHaveBeenCalledWith({
      adaptiveLearning: { enabled: false, mode: 'suggest', minDataDays: 3 },
    });
  });

  it('debounced save logs a warning when persistence fails', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    saveStoredSettings.mockRejectedValue(new Error('disk full'));

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-enabled').dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(700);

    expect(console.warn).toHaveBeenCalledWith(
      'Failed to save adaptive learning settings:',
      'disk full',
    );
  });

  it('logs a warning when stored settings cannot be loaded but still renders accuracy', async () => {
    fetchStoredSettings.mockRejectedValue(new Error('settings down'));
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(console.warn).toHaveBeenCalledWith(
      'Failed to load adaptive learning settings:',
      'settings down',
    );
    // renderSocAccuracy still runs (status set to collecting).
    expect(document.getElementById('adaptive-status-text').textContent).toBe('Collecting data...');
  });

  it('logs a warning when accuracy fetch fails', async () => {
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockRejectedValue(new Error('accuracy down'));
    fetchCalibration.mockResolvedValue({ calibration: null });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(console.warn).toHaveBeenCalledWith('Failed to load SoC accuracy:', 'accuracy down');
  });

  it('falls back to defaults when stored adaptiveLearning omits mode/minDataDays', async () => {
    fetchStoredSettings.mockResolvedValue({ adaptiveLearning: { enabled: true } });
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    expect(document.getElementById('adaptive-enabled').checked).toBe(true);
    expect(document.getElementById('adaptive-mode').value).toBe('suggest');
    expect(document.getElementById('adaptive-min-days').value).toBe('3');
  });

  it('save reads defaults for enabled/mode when those controls are absent', async () => {
    // Only min-days present: its event fires saveAdaptiveLearning, which then
    // reads the (missing) enabled/mode controls via the nullish fallbacks.
    document.body.innerHTML = `
      <input id="adaptive-min-days" value="3">
    `;
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({ report: null });
    fetchCalibration.mockResolvedValue({ calibration: null });
    saveStoredSettings.mockResolvedValue({});

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    document.getElementById('adaptive-min-days').dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(700);

    expect(saveStoredSettings).toHaveBeenCalledWith({
      adaptiveLearning: { enabled: false, mode: 'suggest', minDataDays: 3 },
    });
  });

  it('renders the overlay chart even when the diff canvas is missing', async () => {
    document.body.innerHTML = `
      <div id="adaptive-status-text"></div>
      <div id="ev-charge-curve-status"></div>
      <div id="soc-accuracy-empty"></div>
      <div id="soc-accuracy-content" hidden></div>
      <canvas id="soc-accuracy-chart"></canvas>
    `;
    fetchStoredSettings.mockResolvedValue({});
    fetchPlanAccuracy.mockResolvedValue({
      report: { slotsCompared: 1, deviations: [{ timestampMs: 1, actualSoc_percent: 10, predictedSoc_percent: 12 }] },
    });
    fetchCalibration.mockResolvedValue({
      calibration: { effectiveChargeRate: 1, effectiveDischargeRate: 1, confidence: 1, sampleCount: 1 },
    });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    // Only the overlay chart renders; the diff render is skipped.
    expect(renderChart).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing DOM entirely', async () => {
    setupDom({ full: false });
    fetchStoredSettings.mockResolvedValue({
      adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 4 },
    });
    fetchPlanAccuracy.mockResolvedValue({
      report: { slotsCompared: 1, deviations: [{ timestampMs: 1, actualSoc_percent: 10, predictedSoc_percent: 12 }] },
    });
    fetchCalibration.mockResolvedValue({
      calibration: { effectiveChargeRate: 1, effectiveDischargeRate: 1, confidence: 1, sampleCount: 1 },
      evCalibration: { confidence: 1, effectiveChargeRate: 1, sampleCount: 1 },
    });

    await initAdaptiveLearning();
    await vi.runAllTimersAsync();

    // No canvases -> no chart rendered, no throw.
    expect(renderChart).not.toHaveBeenCalled();
  });
});
