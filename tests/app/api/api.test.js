// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../app/src/api/client.js', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

import { getJson, postJson } from '../../../app/src/api/client.js';
import {
  fetchStoredSettings,
  saveStoredSettings,
  requestRemoteSolve,
  refreshVrmSettings,
  fetchHaEntityState,
  fetchPredictionConfig,
  savePredictionConfig,
  runValidation,
  runLoadForecast,
  runPvForecast,
  runCombinedForecast,
  fetchForecast,
  fetchPlanAccuracy,
  fetchPlanAccuracyHistory,
  fetchCalibration,
  resetCalibrationData,
  triggerCalibration,
  fetchShoreOptimizerStatus,
} from '../../../app/src/api/api.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('api.js wrappers', () => {
  it('fetchStoredSettings calls getJson /settings', async () => {
    getJson.mockResolvedValue({ stepSize_m: 15 });
    const res = await fetchStoredSettings();
    expect(getJson).toHaveBeenCalledWith('/settings');
    expect(res).toEqual({ stepSize_m: 15 });
  });

  it('fetchStoredSettings returns {} for non-object response', async () => {
    getJson.mockResolvedValue(null);
    const res = await fetchStoredSettings();
    expect(res).toEqual({});
  });

  it('fetchStoredSettings returns {} for string response', async () => {
    getJson.mockResolvedValue('not an object');
    const res = await fetchStoredSettings();
    expect(res).toEqual({});
  });

  it('saveStoredSettings calls postJson /settings', async () => {
    postJson.mockResolvedValue({});
    await saveStoredSettings({ foo: 1 });
    expect(postJson).toHaveBeenCalledWith('/settings', { foo: 1 });
  });

  it('fetchHaEntityState calls getJson with encoded entity ID', () => {
    getJson.mockReturnValue(Promise.resolve({ state: 'on' }));
    fetchHaEntityState('sensor.my_entity').catch(() => {});
    expect(getJson).toHaveBeenCalledWith('/ha/entity/sensor.my_entity');
  });

  it('fetchHaEntityState encodes special characters in entity ID', () => {
    getJson.mockReturnValue(Promise.resolve({ state: 'on' }));
    fetchHaEntityState('sensor/my:entity').catch(() => {});
    expect(getJson).toHaveBeenCalledWith('/ha/entity/sensor%2Fmy%3Aentity');
  });

  it('requestRemoteSolve calls postJson /calculate', async () => {
    postJson.mockResolvedValue({ status: 'ok' });
    await requestRemoteSolve({ updateData: true });
    expect(postJson).toHaveBeenCalledWith('/calculate', { updateData: true });
  });

  it('requestRemoteSolve defaults to empty body', async () => {
    postJson.mockResolvedValue({});
    await requestRemoteSolve();
    expect(postJson).toHaveBeenCalledWith('/calculate', {});
  });

  it('refreshVrmSettings calls postJson /vrm/refresh-settings', async () => {
    postJson.mockResolvedValue({});
    await refreshVrmSettings();
    expect(postJson).toHaveBeenCalledWith('/vrm/refresh-settings', {});
  });

  it('fetchShoreOptimizerStatus calls getJson', async () => {
    getJson.mockResolvedValue({});
    await fetchShoreOptimizerStatus();
    expect(getJson).toHaveBeenCalledWith('/shore-optimizer/status');
  });

  it('fetchPredictionConfig calls getJson', async () => {
    getJson.mockResolvedValue({ sensors: [] });
    await fetchPredictionConfig();
    expect(getJson).toHaveBeenCalledWith('/predictions/config');
  });

  it('savePredictionConfig calls postJson', async () => {
    postJson.mockResolvedValue({});
    await savePredictionConfig({ sensors: [] });
    expect(postJson).toHaveBeenCalledWith('/predictions/config', { sensors: [] });
  });

  it('runValidation calls postJson', async () => {
    postJson.mockResolvedValue({ results: [] });
    await runValidation();
    expect(postJson).toHaveBeenCalledWith('/predictions/validate', {});
  });

  it('runLoadForecast calls postJson', async () => {
    postJson.mockResolvedValue({});
    await runLoadForecast();
    expect(postJson).toHaveBeenCalledWith('/predictions/load/forecast', {});
  });

  it('runPvForecast calls postJson', async () => {
    postJson.mockResolvedValue({});
    await runPvForecast();
    expect(postJson).toHaveBeenCalledWith('/predictions/pv/forecast', {});
  });

  it('runCombinedForecast calls postJson', async () => {
    postJson.mockResolvedValue({});
    await runCombinedForecast();
    expect(postJson).toHaveBeenCalledWith('/predictions/forecast', {});
  });

  it('fetchForecast is alias for runCombinedForecast', () => {
    expect(fetchForecast).toBe(runCombinedForecast);
  });

  it('fetchPlanAccuracy calls getJson', async () => {
    getJson.mockResolvedValue({});
    await fetchPlanAccuracy();
    expect(getJson).toHaveBeenCalledWith('/plan-accuracy');
  });

  it('fetchPlanAccuracyHistory calls getJson with days', async () => {
    getJson.mockResolvedValue({});
    await fetchPlanAccuracyHistory(3);
    expect(getJson).toHaveBeenCalledWith('/plan-accuracy/history?days=3');
  });

  it('fetchPlanAccuracyHistory defaults to 7 days', async () => {
    getJson.mockResolvedValue({});
    await fetchPlanAccuracyHistory();
    expect(getJson).toHaveBeenCalledWith('/plan-accuracy/history?days=7');
  });

  it('fetchCalibration calls getJson', async () => {
    getJson.mockResolvedValue({});
    await fetchCalibration();
    expect(getJson).toHaveBeenCalledWith('/plan-accuracy/calibration');
  });

  it('resetCalibrationData calls postJson', async () => {
    postJson.mockResolvedValue({});
    await resetCalibrationData();
    expect(postJson).toHaveBeenCalledWith('/plan-accuracy/calibration/reset', {});
  });

  it('triggerCalibration calls postJson with minDataDays', async () => {
    postJson.mockResolvedValue({});
    await triggerCalibration(5);
    expect(postJson).toHaveBeenCalledWith('/plan-accuracy/calibrate?minDataDays=5', {});
  });

  it('triggerCalibration defaults to minDataDays=1', async () => {
    postJson.mockResolvedValue({});
    await triggerCalibration();
    expect(postJson).toHaveBeenCalledWith('/plan-accuracy/calibrate?minDataDays=1', {});
  });
});
