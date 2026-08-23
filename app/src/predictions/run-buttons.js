/**
 * run-buttons.js
 *
 * Run Selection, Run Comparison and the comparison table's Chart buttons
 * each kick off an HA history read (and, for the first two, a full strategy
 * backtest) on the single-threaded server. Any one in flight locks all of
 * them so they cannot be started on top of each other.
 */

const RUN_BUTTON_IDS = ['autosel-run', 'pred-run-validation'];
/** The per-row Chart buttons are re-created with every table render, so they are matched by class. */
const RUN_BUTTON_SELECTOR = '#pred-metrics-body .btn-chart';

let locked = false;

/** True while a run is in flight — a table re-rendered meanwhile applies it to its fresh Chart buttons. */
export function areRunButtonsDisabled() {
  return locked;
}

export function setRunButtonsDisabled(disabled) {
  locked = disabled;
  const buttons = RUN_BUTTON_IDS.map(id => document.getElementById(id)).filter(Boolean);
  buttons.push(...document.querySelectorAll(RUN_BUTTON_SELECTOR));
  for (const btn of buttons) {
    btn.disabled = disabled;
    btn.classList.toggle('opacity-50', disabled);
    btn.classList.toggle('cursor-not-allowed', disabled);
  }
}
