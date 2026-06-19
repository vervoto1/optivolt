import { getJson, postJson } from "./client.js";

// --- Settings ---
export async function fetchStoredSettings() {
  const settings = await getJson("/settings");
  /* v8 ignore start — settings returned as primitive/string is already a v8-ignore next */
  if (settings && typeof settings === "object") {
    return settings;
  }
  return {};
  /* v8 ignore end */
}

export function saveStoredSettings(config) {
  return postJson("/settings", config);
}

// --- Solver ---
export function requestRemoteSolve(body = {}) {
  return postJson("/calculate", body);
}

// --- Data ---
export function fetchStoredData() {
  return getJson("/data");
}

// --- VRM ---
export function refreshVrmSettings() {
  return postJson("/vrm/refresh-settings", {});
}

// --- Home Assistant ---
export function fetchHaEntityState(entityId) {
  return getJson(`/ha/entity/${encodeURIComponent(entityId)}`);
}

// --- EV ---
export const fetchEvSchedule = () => getJson('/ev/schedule');
export const fetchEvCurrent = () => getJson('/ev/current');
export const fetchEvStatus = () => getJson('/ev/status');
export const fetchEvActuation = () => getJson('/ev/actuation');
export const fetchEvOverride = () => getJson('/ev/override');
export const setEvOverride = (mode) => postJson('/ev/override', { mode });

// --- ESS dashboard ---
export const getEssState = () => getJson('/ess/state');
export function getEssHistory({ hours, period } = {}) {
  const params = new URLSearchParams();
  if (hours != null) params.set('hours', String(hours));
  if (period) params.set('period', period);
  const qs = params.toString();
  return getJson(`/ess/history${qs ? `?${qs}` : ''}`);
}

// --- Shore Current Optimizer ---
export const fetchShoreOptimizerStatus = () => getJson('/shore-optimizer/status');

// --- Battery controllers (charge-current limiter + balance tuner) ---
export const fetchBatteryStatus = () => getJson('/battery');

// --- Predictions ---
export const fetchPredictionConfig = () => getJson('/predictions/config');
export const savePredictionConfig = (c) => postJson('/predictions/config', c);
export const runValidation = () => postJson('/predictions/validate', {});
export const runLoadForecast = () => postJson('/predictions/load/forecast', {});
export const runPvForecast = () => postJson('/predictions/pv/forecast', {});
export const runCombinedForecast = () => postJson('/predictions/forecast', {});
export const fetchForecast = runCombinedForecast;
export const fetchPredictionAdjustments = () => getJson('/predictions/adjustments');
export const createPredictionAdjustment = (adjustment) => postJson('/predictions/adjustments', adjustment);
export const updatePredictionAdjustment = (id, adjustment) => postJson(`/predictions/adjustments/${encodeURIComponent(id)}`, adjustment, { method: 'PATCH' });
export const deletePredictionAdjustment = (id) => postJson(`/predictions/adjustments/${encodeURIComponent(id)}`, {}, { method: 'DELETE' });

// --- Plan Accuracy (Adaptive Learning) ---
export const fetchPlanAccuracy = () => getJson('/plan-accuracy');
export const fetchPlanAccuracyHistory = (days = 7) => getJson(`/plan-accuracy/history?days=${days}`);
export const fetchCalibration = () => getJson('/plan-accuracy/calibration');
export const resetCalibrationData = () => postJson('/plan-accuracy/calibration/reset', {});
export const triggerCalibration = (minDataDays = 1) => postJson(`/plan-accuracy/calibrate?minDataDays=${minDataDays}`, {});
