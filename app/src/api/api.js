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

// --- Shore Current Optimizer ---
export const fetchShoreOptimizerStatus = () => getJson('/shore-optimizer/status');

// --- Predictions ---
export const fetchPredictionConfig = () => getJson('/predictions/config');
export const savePredictionConfig = (c) => postJson('/predictions/config', c);
export const runValidation = () => postJson('/predictions/validate', {});
export const runLoadForecast = () => postJson('/predictions/load/forecast', {});
export const runPvForecast = () => postJson('/predictions/pv/forecast', {});
export const runCombinedForecast = () => postJson('/predictions/forecast', {});
export const fetchForecast = runCombinedForecast;

// --- Plan Accuracy (Adaptive Learning) ---
export const fetchPlanAccuracy = () => getJson('/plan-accuracy');
export const fetchPlanAccuracyHistory = (days = 7) => getJson(`/plan-accuracy/history?days=${days}`);
export const fetchCalibration = () => getJson('/plan-accuracy/calibration');
export const resetCalibrationData = () => postJson('/plan-accuracy/calibration/reset', {});
export const triggerCalibration = (minDataDays = 1) => postJson(`/plan-accuracy/calibrate?minDataDays=${minDataDays}`, {});
