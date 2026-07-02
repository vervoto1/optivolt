// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchPredictionConfig: vi.fn(),
  savePredictionConfig: vi.fn(),
}));

vi.mock('../../app/src/predictions-validation.js', () => ({
  initValidation: vi.fn(),
}));

import { fetchPredictionConfig, savePredictionConfig } from '../../app/src/api/api.js';
import { initValidation } from '../../app/src/predictions-validation.js';
import {
  applyPredictionConfigToForm,
  hydratePredictionForm,
  readPredictionFormValues,
  savePredictionFormToServer,
  wirePredictionForm,
} from '../../app/src/predictions/config-form.js';

function setupDom() {
  document.body.innerHTML = `
    <textarea id="pred-sensors" data-predictions-only="true"></textarea>
    <textarea id="pred-derived" data-predictions-only="true"></textarea>
    <select id="pred-active-type" data-predictions-only="true">
      <option value="historical">Historical</option>
      <option value="fixed">Fixed</option>
    </select>
    <select id="pred-active-sensor" data-predictions-only="true"></select>
    <input id="pred-fixed-load-w" data-predictions-only="true" />
    <div id="pred-fixed-fields"></div>
    <div id="pred-historical-fields"></div>
    <input id="pred-active-lookback" data-predictions-only="true" />
    <select id="pred-active-filter" data-predictions-only="true">
      <option value="same">same</option>
      <option value="weekday-weekend">weekday-weekend</option>
    </select>
    <select id="pred-active-agg" data-predictions-only="true">
      <option value="mean">mean</option>
      <option value="median">median</option>
    </select>
    <select id="pred-pv-sensor" data-predictions-only="true"></select>
    <input id="pred-pv-lat" data-predictions-only="true" />
    <input id="pred-pv-lon" data-predictions-only="true" />
    <input id="pred-pv-history" data-predictions-only="true" />
    <select id="pred-pv-mode" data-predictions-only="true">
      <option value="hourly">hourly</option>
      <option value="hybrid">hybrid</option>
    </select>
    <select id="pred-pv-model" data-predictions-only="true">
      <option value="clearSkyRatio">clearSkyRatio</option>
      <option value="robustLinear">robustLinear</option>
    </select>
    <button id="pred-load-forecast" type="button"></button>
    <button id="pred-pv-forecast" type="button"></button>
    <input id="forecast-chart-15m" type="checkbox" />
    <button id="pred-settings-toggle" type="button"></button>
    <div id="pred-settings-body" class="hidden"></div>
    <span id="pred-settings-toggle-icon"></span>
    <div id="pred-status"></div>
    <input id="unowned-input" />
  `;
}

describe('prediction config form', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    setupDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hydrates predictor and PV form fields from server config', async () => {
    fetchPredictionConfig.mockResolvedValue({
      sensors: [{ id: 'sensor.grid', name: 'Grid Import' }],
      derived: [{ name: 'Total Load' }],
      activeType: 'fixed',
      fixedPredictor: { load_W: 420 },
      historicalPredictor: { sensor: 'Grid Import', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
      pvConfig: { pvSensor: 'Total Load', latitude: 51.1, longitude: 3.7, historyDays: 9, forecastResolution: 15, pvModel: 'robustLinear' },
    });

    await hydratePredictionForm();

    expect(document.getElementById('pred-fixed-load-w').value).toBe('420');
    expect(document.getElementById('pred-active-sensor').options).toHaveLength(3);
    expect([...document.getElementById('pred-active-sensor').options].map(opt => opt.value)).toContain('Grid Import');
    expect(document.getElementById('pred-pv-sensor').value).toBe('Total Load');
    expect(document.getElementById('pred-pv-mode').value).toBe('hybrid');
    expect(document.getElementById('pred-pv-model').value).toBe('robustLinear');
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(true);
  });

  it('reads and saves only valid prediction form values', async () => {
    document.getElementById('pred-sensors').value = '[{"id":"sensor.grid","name":"Grid"}]';
    document.getElementById('pred-derived').value = 'not json';
    document.getElementById('pred-active-type').value = 'historical';
    document.getElementById('pred-active-sensor').innerHTML = '<option value="Grid">Grid</option>';
    document.getElementById('pred-active-sensor').value = 'Grid';
    document.getElementById('pred-active-lookback').value = '5';
    document.getElementById('pred-active-filter').value = 'weekday-weekend';
    document.getElementById('pred-active-agg').value = 'median';
    document.getElementById('pred-pv-lat').value = '51.1';
    document.getElementById('pred-pv-lon').value = '3.7';
    document.getElementById('pred-pv-history').value = '10';
    document.getElementById('pred-pv-mode').value = 'hybrid';
    document.getElementById('pred-pv-model').value = 'robustLinear';
    savePredictionConfig.mockResolvedValue({});

    const values = readPredictionFormValues();
    await savePredictionFormToServer();

    expect(values).toMatchObject({
      sensors: [{ id: 'sensor.grid', name: 'Grid' }],
      activeType: 'historical',
      historicalPredictor: {
        sensor: 'Grid',
        lookbackWeeks: 5,
        dayFilter: 'weekday-weekend',
        aggregation: 'median',
      },
      pvConfig: {
        latitude: 51.1,
        longitude: 3.7,
        historyDays: 10,
        pvMode: 'hybrid',
        pvModel: 'robustLinear',
      },
    });
    expect(values).not.toHaveProperty('derived');
    expect(savePredictionConfig).toHaveBeenCalledWith(values);
  });

  it('wires prediction-owned controls, buttons, and settings toggle', async () => {
    const onForecastAll = vi.fn();
    const onPvForecast = vi.fn();
    const onForecastResolutionChange = vi.fn();
    savePredictionConfig.mockResolvedValue({});

    wirePredictionForm({ onForecastAll, onPvForecast, onForecastResolutionChange });

    document.getElementById('pred-active-type').value = 'fixed';
    document.getElementById('pred-active-type').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('unowned-input').dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(savePredictionConfig).toHaveBeenCalledTimes(1);
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(true);
    expect(initValidation).toHaveBeenCalled();

    document.getElementById('pred-load-forecast').click();
    document.getElementById('pred-pv-forecast').click();
    document.getElementById('forecast-chart-15m').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('pred-settings-toggle').click();

    expect(onForecastAll).toHaveBeenCalledTimes(1);
    expect(onPvForecast).toHaveBeenCalledTimes(1);
    expect(onForecastResolutionChange).toHaveBeenCalledTimes(1);
    expect(document.getElementById('pred-settings-body').classList.contains('hidden')).toBe(false);
  });

  it('logs an error when loading the config fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchPredictionConfig.mockRejectedValue(new Error('nope'));

    await hydratePredictionForm();

    expect(spy).toHaveBeenCalledWith('Failed to load prediction config:', expect.any(Error));
    spy.mockRestore();
  });

  it('applies empty/default values when config is sparse and sensors lack names', () => {
    applyPredictionConfigToForm({
      sensors: [{ id: 'sensor.only-id' }], // no name -> uses id
      // no derived, no activeType, no fixedPredictor, no historicalPredictor, no pvConfig
    });

    // Empty JSON fields when sensors/derived are absent.
    expect(document.getElementById('pred-sensors').value).toBe('[\n  {\n    "id": "sensor.only-id"\n  }\n]');
    expect(document.getElementById('pred-derived').value).toBe('');

    // Sensor option falls back to id when name missing.
    const opt = [...document.getElementById('pred-active-sensor').options].map(o => o.value);
    expect(opt).toContain('sensor.only-id');

    // activeType default historical; fixed load empty.
    expect(document.getElementById('pred-active-type').value).toBe('historical');
    expect(document.getElementById('pred-fixed-load-w').value).toBe('');

    // historical/pv render functions early-return on null config -> fields unchanged.
    expect(document.getElementById('pred-active-sensor').value).toBe('');
    expect(document.getElementById('pred-pv-sensor').value).toBe('');

    // historical fields visible, fixed hidden (type is historical).
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(false);
  });

  it('skips a missing sensor <select> without throwing', () => {
    document.getElementById('pred-pv-sensor').remove();

    expect(() => applyPredictionConfigToForm({
      sensors: [{ name: 'Grid' }],
    })).not.toThrow();

    // The remaining select still got populated.
    const opts = [...document.getElementById('pred-active-sensor').options].map(o => o.value);
    expect(opts).toContain('Grid');
  });

  it('renders historical/pv config with field-level defaults for missing keys', () => {
    applyPredictionConfigToForm({
      activeType: 'historical',
      historicalPredictor: {}, // all fields missing -> '' fallbacks
      pvConfig: {}, // all fields missing -> defaults (historyDays 14, model clearSkyRatio, mode hourly)
    });

    expect(document.getElementById('pred-active-sensor').value).toBe('');
    expect(document.getElementById('pred-active-lookback').value).toBe('');
    // dayFilter/aggregation missing -> '' fallback (no matching option keeps it empty).
    expect(document.getElementById('pred-active-filter').value).toBe('');
    expect(document.getElementById('pred-active-agg').value).toBe('');

    expect(document.getElementById('pred-pv-history').value).toBe('14');
    expect(document.getElementById('pred-pv-mode').value).toBe('hourly');
    expect(document.getElementById('pred-pv-model').value).toBe('clearSkyRatio');
  });

  it('reads default values and emits no predictor blocks when the form is empty', () => {
    // pred-active-type empty -> default 'historical'; no active sensor -> null predictor.
    document.getElementById('pred-active-type').value = '';
    document.getElementById('pred-fixed-load-w').value = '-5'; // negative -> fixedPredictor null
    document.getElementById('pred-pv-lat').value = '';
    document.getElementById('pred-pv-lon').value = '';
    document.getElementById('pred-pv-history').value = '';
    document.getElementById('pred-pv-mode').value = '';

    const values = readPredictionFormValues();

    expect(values.activeType).toBe('historical');
    expect(values).not.toHaveProperty('historicalPredictor');
    expect(values).not.toHaveProperty('fixedPredictor');
    expect(values.pvConfig).toEqual({
      pvSensor: 'Solar Generation',
      latitude: 0,
      longitude: 0,
      historyDays: 14,
      pvMode: 'hourly',
      pvModel: 'clearSkyRatio',
    });
  });

  it('reads a historical predictor with lookback/filter/agg defaults', () => {
    document.getElementById('pred-active-sensor').innerHTML = '<option value="Grid">Grid</option>';
    document.getElementById('pred-active-sensor').value = 'Grid';
    document.getElementById('pred-active-lookback').value = ''; // -> default 4
    document.getElementById('pred-active-filter').value = ''; // -> default 'same'
    document.getElementById('pred-active-agg').value = ''; // -> default 'mean'

    const values = readPredictionFormValues();

    expect(values.historicalPredictor).toEqual({
      sensor: 'Grid',
      lookbackWeeks: 4,
      dayFilter: 'same',
      aggregation: 'mean',
    });
  });

  it('reads a fixed predictor when load_W is a non-negative number', () => {
    document.getElementById('pred-active-type').value = 'fixed';
    document.getElementById('pred-fixed-load-w').value = '0';

    const values = readPredictionFormValues();

    expect(values.fixedPredictor).toEqual({ load_W: 0 });
  });

  it('wires the form when settings toggle and icon are absent', () => {
    document.getElementById('pred-settings-toggle').remove();
    document.getElementById('pred-settings-body').remove();
    document.getElementById('pred-settings-toggle-icon').remove();

    expect(() => wirePredictionForm({
      onForecastAll: vi.fn(),
      onPvForecast: vi.fn(),
      onForecastResolutionChange: vi.fn(),
    })).not.toThrow();
  });

  it('toggles the settings icon rotation when the icon is present', () => {
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn(), onForecastResolutionChange: vi.fn() });

    const icon = document.getElementById('pred-settings-toggle-icon');
    const toggle = document.getElementById('pred-settings-toggle');

    toggle.click(); // body was hidden -> now shown, icon rotated
    expect(icon.style.transform).toBe('rotate(180deg)');

    toggle.click(); // body shown -> now hidden, icon reset
    expect(icon.style.transform).toBe('');
  });

  it('silent save logs an error when saving fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    savePredictionConfig.mockRejectedValue(new Error('save boom'));

    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn(), onForecastResolutionChange: vi.fn() });

    document.getElementById('pred-active-lookback').dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);

    expect(spy).toHaveBeenCalledWith('Failed to save prediction config:', expect.any(Error));
    spy.mockRestore();
  });

  it('reads pvModel default and keeps sensors/derived blocks when JSON is valid', () => {
    document.getElementById('pred-sensors').value = '[{"id":"s.1"}]';
    document.getElementById('pred-derived').value = '[{"id":"d.1"}]';
    document.getElementById('pred-pv-model').value = ''; // -> default clearSkyRatio

    const values = readPredictionFormValues();

    expect(values.sensors).toEqual([{ id: 's.1' }]);
    expect(values.derived).toEqual([{ id: 'd.1' }]);
    expect(values.pvConfig.pvModel).toBe('clearSkyRatio');
  });

  it('updatePredictorFieldVisibility defaults to historical when type is empty', () => {
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn(), onForecastResolutionChange: vi.fn() });

    document.getElementById('pred-active-type').value = '';
    document.getElementById('pred-active-type').dispatchEvent(new Event('change', { bubbles: true }));

    // type defaults to historical -> fixed hidden, historical shown.
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(false);
  });

  it('toggle works without the icon element (icon branch skipped)', () => {
    document.getElementById('pred-settings-toggle-icon').remove();
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn(), onForecastResolutionChange: vi.fn() });

    const body = document.getElementById('pred-settings-body');
    document.getElementById('pred-settings-toggle').click();
    expect(body.classList.contains('hidden')).toBe(false);
  });

  it('setVal/getVal tolerate missing elements during render', () => {
    // Remove targets so renderPvConfig/renderHistoricalConfig setVal calls no-op
    // and readPredictionFormValues getVal calls hit the '' fallback.
    document.getElementById('pred-pv-sensor').remove();
    document.getElementById('pred-pv-history').remove();
    document.getElementById('pred-active-sensor').remove();

    expect(() => applyPredictionConfigToForm({
      activeType: 'historical',
      historicalPredictor: { sensor: 'X', lookbackWeeks: 2, dayFilter: 'same', aggregation: 'mean' },
      pvConfig: { pvSensor: 'Y', latitude: 1, longitude: 2, historyDays: 8, pvMode: 'hourly', pvModel: 'clearSkyRatio' },
    })).not.toThrow();

    const values = readPredictionFormValues();
    // active sensor element missing -> no historical predictor.
    expect(values).not.toHaveProperty('historicalPredictor');
    // pv-history element missing -> default historyDays 14.
    expect(values.pvConfig.historyDays).toBe(14);
  });

  it('setComparisonStatus sets text/class and tolerates a missing element', () => {
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn(), onForecastResolutionChange: vi.fn() });
    const { setComparisonStatus } = initValidation.mock.calls.at(-1)[0];

    const el = document.getElementById('pred-status');
    setComparisonStatus('All good'); // default isError=false
    expect(el.textContent).toBe('All good');
    expect(el.className).toContain('text-ink-soft');

    setComparisonStatus('Broke', true);
    expect(el.textContent).toBe('Broke');
    expect(el.className).toContain('text-red-600');

    // Missing element -> no throw.
    el.remove();
    expect(() => setComparisonStatus('ignored')).not.toThrow();
  });
});
