/**
 * Battery settings sub-tab live status.
 *
 * Polls GET /battery while the Settings tab is visible and renders a one-line
 * status for the charge-current limiter and a per-BMS summary for the balance
 * tuner into the `#bcc-status` / `#bbc-status` placeholders. Lazy + leak-free:
 * mirrors ess-tab.js — start on activate, stop on deactivate.
 */

import { fetchBatteryStatus } from "./api/api.js";

const POLL_MS = 5000;

let intervalHandle = null;

function fmtV(v) {
  return Number.isFinite(v) ? `${Number(v).toFixed(3)}V` : "—";
}

function renderCharge(el, charge) {
  if (!el) return;
  if (!charge || charge.enabled === false) {
    el.textContent = "Status: disabled";
    return;
  }
  const mode = charge.dryRun ? "dry-run" : "live";
  const level = charge.commandedLevel != null ? `${charge.commandedLevel}A` : "—";
  const maxV = fmtV(charge.maxCellVoltage);
  const reason = charge.reason || charge.status || "—";
  el.textContent = `Status: ${charge.status} (${mode}) · level ${level} · maxV ${maxV} · ${reason}`;
}

function renderBalance(el, balance) {
  if (!el) return;
  if (!balance || balance.enabled === false) {
    el.textContent = "Status: disabled";
    return;
  }
  const mode = balance.dryRun ? "dry-run" : "live";
  const rows = Array.isArray(balance.batteries) ? balance.batteries : [];
  if (rows.length === 0) {
    el.textContent = `Status: enabled (${mode}) · no BMS data yet`;
    return;
  }
  const lines = rows.map(b => {
    const start = fmtV(b.startVoltage);
    const trig = fmtV(b.triggerVoltage);
    const warn = b.warning ? " ⚠" : "";
    return `${b.name}: ${b.status} · start ${start} · trig ${trig} · ${b.reason || "—"}${warn}`;
  });
  el.textContent = `(${mode}) ${lines.join("  |  ")}`;
}

async function poll() {
  const bccEl = document.getElementById("bcc-status");
  const bbcEl = document.getElementById("bbc-status");
  if (!bccEl && !bbcEl) return;
  try {
    const status = await fetchBatteryStatus();
    renderCharge(bccEl, status?.charge);
    renderBalance(bbcEl, status?.balance);
  } catch {
    // Transient (HA/API hiccup) — leave the last rendered status in place.
  }
}

/** Start polling battery controller status. Idempotent. */
export function initBatterySettings() {
  deactivateBatterySettings();
  void poll();
  intervalHandle = setInterval(() => { void poll(); }, POLL_MS);
}

/** Stop polling (called when the Settings tab is left). */
export function deactivateBatterySettings() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
