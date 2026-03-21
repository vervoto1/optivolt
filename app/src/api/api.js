import { getJson, postJson } from "./client.js";

// --- Settings ---
export async function fetchStoredSettings() {
  const settings = await getJson("/settings");
  if (settings && typeof settings === "object") {
    return settings;
  }
  return {};
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
