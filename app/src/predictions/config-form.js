import { fetchPredictionConfig, savePredictionConfig } from '../api/api.js';
import { debounce } from '../utils.js';
import { initValidation, rerenderTable } from '../predictions-validation.js';
import { getLastAutoSelectRun, initAutoSelect } from './auto-select.js';
import { formatStrategy } from './strategy.js';

/** Form fields whose values make up `historicalPredictor`. */
const STRATEGY_FIELD_IDS = ['pred-active-sensor', 'pred-active-lookback', 'pred-active-filter', 'pred-active-agg'];

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

export async function hydratePredictionForm() {
  try {
    const config = await fetchPredictionConfig();
    applyPredictionConfigToForm(config);
  } catch (err) {
    console.error('Failed to load prediction config:', err);
  }
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
  renderPvConfig(config.pvConfig ?? null);
  updatePredictorFieldVisibility();
  // The form now mirrors the server, so nothing local is pending.
  strategyDirty = false;
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

  document.getElementById('pred-active-type')
    ?.addEventListener('change', updatePredictorFieldVisibility);

  const validationDeps = {
    readFormValues: readPredictionFormValues,
    renderHistoricalConfig,
    setComparisonStatus,
    getHighlights: () => {
      // The run record's `best` is a bare strategy score; the sensor it was
      // scored for is the record's top-level `sensor`.
      const run = getLastAutoSelectRun();
      return {
        active: readPredictionFormValues().historicalPredictor ?? null,
        best: run?.best ? { ...run.best, sensor: run.sensor } : null,
      };
    },
  };
  initValidation(validationDeps);

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

export async function savePredictionFormToServer() {
  const partial = readPredictionFormValues();
  // Omitting the key leaves the server's stored value alone: POST
  // /predictions/config merges `{ ...prev, ...body }`.
  if (!strategyDirty) delete partial.historicalPredictor;
  await savePredictionConfig(partial);
  strategyDirty = false;
}

async function savePredictionFormSilently() {
  try {
    await savePredictionFormToServer();
  } catch (err) {
    console.error('Failed to save prediction config:', err);
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

  const fixedLoadW = getVal('pred-fixed-load-w');
  const fixedLoadWParsed = fixedLoadW !== '' ? parseFloat(fixedLoadW) : NaN;
  const fixedPredictor = Number.isFinite(fixedLoadWParsed) && fixedLoadWParsed >= 0 ? { load_W: fixedLoadWParsed } : null;

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: parseFloat(getVal('pred-pv-lat')) || 0,
    longitude: parseFloat(getVal('pred-pv-lon')) || 0,
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
    pvConfig,
  };
}

function updatePredictorFieldVisibility() {
  const type = getVal('pred-active-type') || 'historical';
  const isFixed = type === 'fixed';
  document.getElementById('pred-fixed-fields')?.classList.toggle('hidden', !isFixed);
  document.getElementById('pred-historical-fields')?.classList.toggle('hidden', isFixed);
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
