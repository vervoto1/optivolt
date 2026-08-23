/**
 * run-buttons.js
 *
 * Run Selection and Run Comparison each kick off a long HA history read plus a
 * full strategy backtest on the single-threaded server. Either one in flight
 * locks both buttons so the two cannot be started on top of each other.
 */

const RUN_BUTTON_IDS = ['autosel-run', 'pred-run-validation'];

export function setRunButtonsDisabled(disabled) {
  for (const id of RUN_BUTTON_IDS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = disabled;
    btn.classList.toggle('opacity-50', disabled);
    btn.classList.toggle('cursor-not-allowed', disabled);
  }
}
