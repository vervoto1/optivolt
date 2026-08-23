/**
 * auto-select.js
 *
 * Strategy Selection card on the Predictions tab: settings for the daily
 * auto-selector, a "run now" button, and the status of the last run. Applying
 * a suggestion goes through the same form path as the comparison table's
 * "Use" button (the `applyStrategy` dep), so the applied strategy becomes the
 * incumbent for the next run.
 */

import { fetchAutoSelect, fetchStoredSettings, runAutoSelect, saveStoredSettings } from '../api/api.js';
import { debounce } from '../utils.js';
import { formatStrategy, isSameStrategy } from './strategy.js';
import { setRunButtonsDisabled } from './run-buttons.js';

export { formatStrategy, isSameStrategy };

/** Mirrors DEFAULT_AUTO_SELECT_CONFIG on the server (api/services/prediction-auto-select.ts). */
const DEFAULTS = { enabled: false, mode: 'suggest', time: '03:30', metric: 'mae', minImprovement_percent: 10, windowDays: 28 };
const FIELD_IDS = ['autosel-enabled', 'autosel-mode', 'autosel-time', 'autosel-metric', 'autosel-min-improvement', 'autosel-window-days'];

const OUTCOME_CLASSES = {
  neutral: 'text-sm font-medium text-ink-soft dark:text-slate-400',
  good: 'text-sm font-medium text-emerald-600 dark:text-emerald-400',
  suggest: 'text-sm font-medium text-sky-600 dark:text-sky-400',
  warn: 'text-sm font-medium text-amber-600 dark:text-amber-400',
  error: 'text-sm font-medium text-red-600 dark:text-red-400',
};

let lastRun = null;
let deps = {};

/** The most recent run record seen by the UI (used by the comparison table badges). */
export function getLastAutoSelectRun() {
  return lastRun;
}

export function formatRelativeTime(iso, nowMs = Date.now()) {
  const diffMin = Math.round((nowMs - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const hours = Math.round(diffMin / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export async function initAutoSelect({ applyStrategy, getCurrentStrategy, onRunComplete, onApplied } = {}) {
  deps = { applyStrategy, getCurrentStrategy, onRunComplete, onApplied };

  let cfg = DEFAULTS;
  try {
    const settings = await fetchStoredSettings();
    cfg = { ...DEFAULTS, ...(settings?.predictionAutoSelect ?? {}) };
  } catch (err) {
    console.warn('Failed to load auto-select settings:', err.message);
  }
  // The markup carries no values of its own, so the defaults must land even when the fetch failed.
  setChecked('autosel-enabled', cfg.enabled);
  setVal('autosel-mode', cfg.mode);
  setVal('autosel-time', cfg.time);
  setVal('autosel-metric', cfg.metric);
  setVal('autosel-min-improvement', cfg.minImprovement_percent);
  setVal('autosel-window-days', cfg.windowDays);

  const save = debounce(saveAutoSelectSettings, 600);
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    el?.addEventListener('input', save);
    el?.addEventListener('change', save);
  }

  document.getElementById('autosel-run')?.addEventListener('click', onRunNow);
  document.getElementById('autosel-apply')?.addEventListener('click', onApply);

  await refreshAutoSelectStatus();
}

export function readAutoSelectForm() {
  return {
    enabled: document.getElementById('autosel-enabled')?.checked ?? false,
    mode: getVal('autosel-mode') || 'suggest',
    time: getVal('autosel-time') || DEFAULTS.time,
    metric: getVal('autosel-metric') || 'mae',
    minImprovement_percent: numberOr(getVal('autosel-min-improvement'), DEFAULTS.minImprovement_percent),
    windowDays: numberOr(getVal('autosel-window-days'), DEFAULTS.windowDays),
  };
}

async function saveAutoSelectSettings() {
  try {
    await saveStoredSettings({ predictionAutoSelect: readAutoSelectForm() });
  } catch (err) {
    console.warn('Failed to save auto-select settings:', err.message);
  }
}

export async function refreshAutoSelectStatus() {
  try {
    const state = await fetchAutoSelect();
    lastRun = state?.lastRun ?? null;
  } catch (err) {
    console.warn('Failed to load auto-select status:', err.message);
    lastRun = null;
    // Distinct from "never ran": the panel's whole job is reporting run state,
    // so a status read that failed must not look like a feature that never fired.
    renderUnavailable(err.message);
    return;
  }
  renderRun(lastRun);
}

async function onRunNow() {
  const btn = document.getElementById('autosel-run');
  setRunButtonsDisabled(true);
  btn.textContent = 'Running…';
  try {
    lastRun = await runAutoSelect(true);
    renderRun(lastRun);
    deps.onRunComplete?.(lastRun);
  } catch (err) {
    setOutcome(`Error: ${err.message}`, 'error');
  } finally {
    btn.textContent = 'Run Selection';
    setRunButtonsDisabled(false);
  }
}

async function onApply() {
  if (!lastRun?.best || !deps.applyStrategy) return;
  const btn = document.getElementById('autosel-apply');
  // The save is a network round trip; without a busy state a double-click posts it twice.
  setBusy(btn, true, 'Applying…');
  try {
    await deps.applyStrategy(lastRun.best);
    renderRun(lastRun);
    // Lets the comparison table re-read its highlights so the ACTIVE badge moves.
    deps.onApplied?.();
  } catch (err) {
    setOutcome(`Apply failed: ${err.message}`, 'error');
  } finally {
    setBusy(btn, false, 'Apply suggestion');
  }
}

function clearRunCells() {
  setEl('autosel-current', '--');
  setEl('autosel-current-metric', '');
  setEl('autosel-best', '--');
  setEl('autosel-best-metric', '');
  setEl('autosel-delta', '--');
  const applyRow = document.getElementById('autosel-apply-row');
  if (applyRow) applyRow.hidden = true;
}

function renderUnavailable(message) {
  setEl('autosel-last-run', 'Unknown');
  setOutcome(`Status unavailable: ${message}`, 'error');
  clearRunCells();
}

function renderRun(run) {
  const applyRow = document.getElementById('autosel-apply-row');
  if (!run) {
    setEl('autosel-last-run', 'Never');
    setOutcome('No run yet', 'neutral');
    clearRunCells();
    return;
  }

  const metric = run.metric ?? 'mae';
  const metricLabel = metric.toUpperCase();
  const scoreOf = s => (s && Number.isFinite(s[metric]) ? `${metricLabel} ${Math.round(s[metric])} Wh` : '');

  setEl('autosel-last-run', `${formatRelativeTime(run.at)} · ${run.trigger}`);
  setEl('autosel-current', formatStrategy(run.incumbent));
  setEl('autosel-current-metric', scoreOf(run.incumbent));
  setEl('autosel-best', formatStrategy(run.best));
  setEl('autosel-best-metric', scoreOf(run.best));

  // improvement_percent is the server's error reduction (positive = best has a
  // lower MAE/RMSE than the current strategy), which is exactly what the tile's
  // "Gain" label means — so no sign flip, and no collapsing to "0 %".
  const pct = run.improvement_percent;
  const gain = pct == null ? null : `${pct.toFixed(1)} %`;
  setEl('autosel-delta', gain ?? '--');

  const current = deps.getCurrentStrategy?.() ?? null;
  const alreadyApplied = run.action === 'suggested' && isSameStrategy(current, run.best);
  let showApply = false;

  switch (run.action) {
    case 'skipped':
      setOutcome(`Skipped: ${run.skipReason ?? 'unknown reason'}`, 'warn');
      break;
    case 'failed':
      setOutcome(`Failed: ${run.error ?? 'unknown error'}`, 'error');
      break;
    case 'applied':
      // gain is null on records written by the pre-0.7.56 `incumbent-unscored`
      // path (which no longer applies, but may still sit in the run history).
      setOutcome(gain == null ? 'Switched — current strategy could not be scored' : `Switched to best (${gain} lower ${metricLabel})`, 'good');
      break;
    case 'suggested':
      if (alreadyApplied) {
        setOutcome('Suggestion applied', 'good');
      } else {
        // gain is null on the `incumbent-unscored` path — the current strategy
        // could not be scored, so there is no measured margin to report.
        setOutcome(gain == null ? 'Suggested: current strategy could not be scored' : `Suggested: switch to best (${gain} lower ${metricLabel})`, 'suggest');
        showApply = true;
      }
      break;
    default:
      setOutcome(describeKept(run), 'good');
  }

  if (applyRow) applyRow.hidden = !showApply;
}

function describeKept(run) {
  switch (run.reason) {
    case 'below-threshold':
      return `Kept — best is only ${(run.improvement_percent ?? 0).toFixed(1)} % better (min ${run.minImprovement_percent ?? DEFAULTS.minImprovement_percent} %)`;
    case 'no-eligible':
      return 'Kept — not enough data to score';
    default:
      return 'Kept — current strategy is best';
  }
}

function setOutcome(text, tone) {
  const el = document.getElementById('autosel-outcome');
  if (!el) return;
  el.textContent = text;
  el.className = OUTCOME_CLASSES[tone];
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = label;
  btn.classList.toggle('opacity-50', busy);
  btn.classList.toggle('cursor-not-allowed', busy);
}

function numberOr(raw, fallback) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
}

function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}
