import { fetchPredictionConfig, savePredictionConfig } from '../api/api.js';
import { debounce } from '../utils.js';
import { initValidation, rerenderTable } from '../predictions-validation.js';
import { getLastAutoSelectRun, initAutoSelect } from './auto-select.js';
import { formatStrategy } from './strategy.js';
import { wireSensorCheck } from './sensor-check.js';

/** Form fields whose values make up `historicalPredictor`. */
const STRATEGY_FIELD_IDS = ['pred-active-sensor', 'pred-active-lookback', 'pred-active-filter', 'pred-active-agg'];

/** Form fields of the opt-in temperature predictor (its sensor is the shared Sensor select). */
const TEMPERATURE_FIELD_IDS = ['pred-temp-lookback', 'pred-temp-bins', 'pred-temp-filter'];

/** Form defaults for a temperature predictor the server has not stored yet. */
const TEMPERATURE_DEFAULTS = { lookbackWeeks: 4, dayFilter: 'all', bins: 3 };

/**
 * True when the form should send `temperaturePredictor`: the server already
 * stores one, the user edited a temperature field, or the type is selected.
 * Otherwise saves leave the key out, so a config that never used the
 * temperature predictor stays byte-for-byte what it was.
 */
let temperatureInUse = false;

/**
 * True once the user has changed a strategy field since the last hydrate/save.
 *
 * The form hydrates once per page load, but the auto-selector rewrites
 * `historicalPredictor` server-side on its own schedule. A dashboard tab left
 * open across a run therefore holds a stale strategy, and because every
 * predictions field triggers a debounced whole-config save, editing an
 * unrelated field would push that stale strategy back and silently revert the
 * switch. Only send the strategy when the user actually chose it.
 */
let strategyDirty = false;

function markStrategyDirty() {
  strategyDirty = true;
}

/**
 * True once the form holds the server's stored config. Until then its fields
 * are the HTML defaults (PV location 0,0, clear-sky model, historical
 * predictor), and saving them would overwrite the stored config, which the
 * planner reads for every PV and load forecast.
 */
let formHydrated = false;

/** Error message for a save attempted before the stored config was loaded. */
export const NOT_HYDRATED_MESSAGE = 'Prediction settings were not loaded from the server; reload the page before saving';

/** Load the stored config into the form. Resolves true on success, false on failure. */
export async function hydratePredictionForm() {
  try {
    const config = await fetchPredictionConfig();
    applyPredictionConfigToForm(config);
    return true;
  } catch (err) {
    console.error('Failed to load prediction config:', err);
    return false;
  }
}

export function isPredictionFormHydrated() {
  return formHydrated;
}

export function applyPredictionConfigToForm(config) {
  setVal('pred-sensors', config.sensors ? JSON.stringify(config.sensors, null, 2) : '');
  setVal('pred-derived', config.derived ? JSON.stringify(config.derived, null, 2) : '');

  const allSensors = [...(config.sensors || []), ...(config.derived || [])];

  for (const selectId of ['pred-active-sensor', 'pred-pv-sensor']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    select.innerHTML = '<option value="" disabled selected>Select a sensor…</option>';
    for (const s of allSensors) {
      const opt = document.createElement('option');
      opt.textContent = s.name || s.id;
      opt.value = opt.textContent;
      select.appendChild(opt);
    }
  }

  setVal('pred-active-type', config.activeType ?? 'historical');
  setVal('pred-fixed-load-w', config.fixedPredictor?.load_W ?? '');
  renderHistoricalConfig(config.historicalPredictor ?? null);
  temperatureInUse = !!config.temperaturePredictor;
  renderTemperatureConfig(config.temperaturePredictor ?? TEMPERATURE_DEFAULTS);
  renderPvConfig(config.pvConfig ?? null);
  updatePredictorFieldVisibility();
  // The form now mirrors the server, so nothing local is pending.
  strategyDirty = false;
  formHydrated = true;
}

export function wirePredictionForm({ onForecastAll, onPvForecast, onForecastResolutionChange }) {
  const debouncedSave = debounce(savePredictionFormSilently, 600);

  for (const el of document.querySelectorAll('[data-predictions-only="true"]')) {
    el.addEventListener('input', debouncedSave);
    el.addEventListener('change', debouncedSave);
  }

  for (const id of STRATEGY_FIELD_IDS) {
    const el = document.getElementById(id);
    el?.addEventListener('input', markStrategyDirty);
    el?.addEventListener('change', markStrategyDirty);
  }

  for (const id of TEMPERATURE_FIELD_IDS) {
    const el = document.getElementById(id);
    el?.addEventListener('input', markTemperatureInUse);
    el?.addEventListener('change', markTemperatureInUse);
  }

  document.getElementById('pred-active-type')
    ?.addEventListener('change', updatePredictorFieldVisibility);

  const validationDeps = {
    readFormValues: readPredictionFormValues,
    assertCanSave: assertPredictionFormHydrated,
    renderHistoricalConfig,
    applyTemperatureRow,
    setComparisonStatus,
    getHighlights: () => {
      // The run record's `best` is a bare strategy score; the sensor it was
      // scored for is the record's top-level `sensor`.
      const run = getLastAutoSelectRun();
      const values = readPredictionFormValues();
      // Untyped strategies are historical (see sameStrategy in predictions-validation.js).
      const active = values.activeType === 'temperature'
        ? (values.temperaturePredictor ? { type: 'temperature', ...values.temperaturePredictor } : null)
        : values.historicalPredictor ?? null;
      return {
        active,
        best: run?.best ? { ...run.best, sensor: run.sensor } : null,
      };
    },
  };
  initValidation(validationDeps);
  wireSensorCheck();

  void initAutoSelect({
    getCurrentStrategy: () => readPredictionFormValues().historicalPredictor ?? null,
    applyStrategy: applyStrategyToForm,
    // After Apply suggestion the form holds the new strategy, so the table's
    // ACTIVE badge has to move — same re-render the Use button does.
    onApplied: () => rerenderTable(validationDeps),
    onRunComplete: (run) => {
      // In auto mode the run may have just rewritten historicalPredictor
      // server-side; pull it into the form so the display matches and the next
      // save does not carry the pre-switch strategy.
      if (run?.action === 'applied' && run.best) {
        const { lookbackWeeks, dayFilter, aggregation } = run.best;
        // Keep the form's sensor: the selector never moves between sensors.
        renderHistoricalConfig({ sensor: getVal('pred-active-sensor'), lookbackWeeks, dayFilter, aggregation });
        strategyDirty = false;
      }
      rerenderTable(validationDeps);
    },
  });

  document.getElementById('pred-load-forecast')
    ?.addEventListener('click', onForecastAll);
  document.getElementById('pred-pv-forecast')
    ?.addEventListener('click', onPvForecast);
  document.getElementById('forecast-chart-15m')
    ?.addEventListener('change', onForecastResolutionChange);

  const settingsToggle = document.getElementById('pred-settings-toggle');
  const settingsBody = document.getElementById('pred-settings-body');
  const settingsIcon = document.getElementById('pred-settings-toggle-icon');

  if (settingsToggle && settingsBody) {
    settingsToggle.addEventListener('click', () => {
      const isHidden = settingsBody.classList.contains('hidden');
      settingsBody.classList.toggle('hidden', !isHidden);
      if (settingsIcon) {
        settingsIcon.style.transform = isHidden ? 'rotate(180deg)' : '';
      }
    });
  }
}

/**
 * Apply a strategy from the auto-selector's suggestion: push the three
 * strategy fields into the form, force the historical predictor type, and
 * persist. Unlike the comparison table's "Use" button this keeps the form's
 * current sensor (the selector only ever scores the active one) and refreshes
 * the fixed/historical field visibility, since the predictor type may change.
 * Only the three strategy fields are read from the argument on purpose.
 */
export async function applyStrategyToForm({ lookbackWeeks, dayFilter, aggregation }) {
  assertPredictionFormHydrated();
  const strategy = { lookbackWeeks, dayFilter, aggregation };
  const current = readPredictionFormValues().historicalPredictor ?? {};
  renderHistoricalConfig({ ...current, ...strategy });
  setVal('pred-active-type', 'historical');
  updatePredictorFieldVisibility();
  // An explicit user choice, so this save must carry the strategy.
  markStrategyDirty();
  await savePredictionFormToServer();
  setComparisonStatus(`Active config updated: ${formatStrategy(strategy)}`);
}

/**
 * The comparison table's Use button on a temperature row: an explicit,
 * user-initiated switch of the live load forecast to the temperature
 * predictor (nothing else ever selects it). The shared Sensor select moves to
 * the row's sensor, so the historical fallback predicts the same series.
 */
export function applyTemperatureRow({ sensor, lookbackWeeks, dayFilter, bins }) {
  setVal('pred-active-sensor', sensor ?? '');
  renderTemperatureConfig({ lookbackWeeks, dayFilter, bins });
  setVal('pred-active-type', 'temperature');
  markTemperatureInUse();
  updatePredictorFieldVisibility();
}

function markTemperatureInUse() {
  temperatureInUse = true;
}

/** Throws unless the form holds the stored config (see `formHydrated`). */
function assertPredictionFormHydrated() {
  if (!formHydrated) throw new Error(NOT_HYDRATED_MESSAGE);
}

export async function savePredictionFormToServer() {
  assertPredictionFormHydrated();
  const partial = readPredictionFormValues();
  // Omitting the key leaves the server's stored value alone: POST
  // /predictions/config merges `{ ...prev, ...body }`.
  if (!strategyDirty) delete partial.historicalPredictor;
  await savePredictionConfig(partial);
  strategyDirty = false;
}

/**
 * The debounced per-edit save. A rejected save is shown on the comparison
 * status line: the server now validates the patch, and a 400 that only went
 * to the console left the form looking saved while every later edit was
 * rejected the same way.
 */
async function savePredictionFormSilently() {
  try {
    await savePredictionFormToServer();
  } catch (err) {
    console.error('Failed to save prediction config:', err);
    setComparisonStatus(`Save failed: ${err.message}`, true);
  }
}

export function readPredictionFormValues() {
  const sensors = parseSilently(getVal('pred-sensors'));
  const derived = parseSilently(getVal('pred-derived'));

  const activeType = getVal('pred-active-type') || 'historical';

  const activeSensor = getVal('pred-active-sensor');
  const activeLookback = getVal('pred-active-lookback');

  const historicalPredictor = activeSensor ? {
    sensor: activeSensor,
    lookbackWeeks: activeLookback ? parseInt(activeLookback, 10) : 4,
    dayFilter: getVal('pred-active-filter') || 'same',
    aggregation: getVal('pred-active-agg') || 'mean',
  } : null;

  const temperaturePredictor = activeSensor && (temperatureInUse || activeType === 'temperature') ? {
    sensor: activeSensor,
    lookbackWeeks: intOr(getVal('pred-temp-lookback'), TEMPERATURE_DEFAULTS.lookbackWeeks),
    dayFilter: getVal('pred-temp-filter') || TEMPERATURE_DEFAULTS.dayFilter,
    bins: intOr(getVal('pred-temp-bins'), TEMPERATURE_DEFAULTS.bins),
  } : null;

  const fixedLoadW = getVal('pred-fixed-load-w');
  const fixedLoadWParsed = fixedLoadW !== '' ? parseFloat(fixedLoadW) : NaN;
  const fixedPredictor = Number.isFinite(fixedLoadWParsed) && fixedLoadWParsed >= 0 ? { load_W: fixedLoadWParsed } : null;

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    // A blank field is null, never 0: (0, 0) is a real place, and the server
    // rejects null so a cleared field can never overwrite the stored location.
    latitude: coordOrNull(getVal('pred-pv-lat')),
    longitude: coordOrNull(getVal('pred-pv-lon')),
    historyDays: parseInt(getVal('pred-pv-history'), 10) || 14,
    pvMode: getVal('pred-pv-mode') || 'hourly',
    pvModel: getVal('pred-pv-model') || 'clearSkyRatio',
  };

  return {
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
    activeType,
    ...(historicalPredictor ? { historicalPredictor } : {}),
    ...(fixedPredictor ? { fixedPredictor } : {}),
    ...(temperaturePredictor ? { temperaturePredictor } : {}),
    pvConfig,
  };
}

function intOr(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function coordOrNull(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function updatePredictorFieldVisibility() {
  const type = getVal('pred-active-type') || 'historical';
  const isFixed = type === 'fixed';
  document.getElementById('pred-fixed-fields')?.classList.toggle('hidden', !isFixed);
  // The temperature type keeps the historical fields visible: they are its fallback.
  document.getElementById('pred-historical-fields')?.classList.toggle('hidden', isFixed);
  document.getElementById('pred-temperature-fields')?.classList.toggle('hidden', type !== 'temperature');
}

function renderTemperatureConfig(temperaturePredictor) {
  if (!temperaturePredictor) return;
  setVal('pred-temp-lookback', temperaturePredictor.lookbackWeeks ?? TEMPERATURE_DEFAULTS.lookbackWeeks);
  setVal('pred-temp-filter', temperaturePredictor.dayFilter ?? TEMPERATURE_DEFAULTS.dayFilter);
  setVal('pred-temp-bins', temperaturePredictor.bins ?? TEMPERATURE_DEFAULTS.bins);
}

function renderHistoricalConfig(historicalPredictor) {
  if (!historicalPredictor) return;
  setVal('pred-active-sensor', historicalPredictor.sensor ?? '');
  setVal('pred-active-lookback', historicalPredictor.lookbackWeeks ?? '');
  setVal('pred-active-filter', historicalPredictor.dayFilter ?? '');
  setVal('pred-active-agg', historicalPredictor.aggregation ?? '');
}

function renderPvConfig(pvConfig) {
  if (!pvConfig) return;
  setVal('pred-pv-sensor', pvConfig.pvSensor ?? '');
  setVal('pred-pv-lat', pvConfig.latitude ?? '');
  setVal('pred-pv-lon', pvConfig.longitude ?? '');
  setVal('pred-pv-history', pvConfig.historyDays ?? 14);
  const pvMode = pvConfig.pvMode ?? (pvConfig.forecastResolution === 15 ? 'hybrid' : 'hourly'); // fall back for legacy forecastResolution field
  setVal('pred-pv-mode', pvMode);
  setVal('pred-pv-model', pvConfig.pvModel ?? 'clearSkyRatio');
}

function setComparisonStatus(msg, isError = false) {
  const el = document.getElementById('pred-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm text-red-600 dark:text-red-400'
    : 'text-sm text-ink-soft dark:text-slate-400';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}

function parseSilently(str) {
  try { return JSON.parse(str); }
  catch { return null; }
}
