import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get, post, inject } from './helpers/express-test-client.js';

vi.mock('../../api/services/prediction-config-store.ts');
vi.mock('../../api/services/load-prediction-service.ts');
vi.mock('../../api/services/pv-prediction-service.ts');
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');

import { loadPredictionConfig, savePredictionConfig } from '../../api/services/prediction-config-store.ts';
import { runValidation, runForecast } from '../../api/services/load-prediction-service.ts';
import { runPvForecast } from '../../api/services/pv-prediction-service.ts';
import { loadSettings } from '../../api/services/settings-store.ts';
import { loadData, saveData } from '../../api/services/data-store.ts';

async function importRouter() {
  vi.resetModules();
  return (await import('../../api/routes/predictions.ts')).default;
}

const mockConfig = {
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  validationWindow: { start: '2026-01-18T00:00:00Z', end: '2026-01-25T00:00:00Z' },
  activeConfig: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
  pvConfig: { latitude: 51.0, longitude: 3.7, azimuth: 180, tilt: 35 },
  activeType: 'historical',
  historicalPredictor: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
};

const mockSettings = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  dataSources: { load: 'vrm', pv: 'vrm' },
};

describe('Prediction route contracts', () => {
  let predictionsRouter;

  beforeEach(async () => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(structuredClone(mockConfig));
    savePredictionConfig.mockResolvedValue();
    loadSettings.mockResolvedValue(structuredClone(mockSettings));
    loadData.mockResolvedValue({});
    saveData.mockResolvedValue();
    runValidation.mockResolvedValue({
      sensorNames: ['Grid Import'],
      results: [{ sensor: 'Grid Import', mae: 120.5, rmse: 180.2, mape: 15.3, n: 168, nSkipped: 0 }],
    });
    runForecast.mockResolvedValue({
      forecast: { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(200) },
      recent: [],
    });
    runPvForecast.mockResolvedValue({
      forecast: { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(100) },
    });

    predictionsRouter = await importRouter();
  });

  it('GET /predictions/config returns the config', async () => {
    const res = await get(predictionsRouter, '/config');
    expect(res.status).toBe(200);
    expect(res.body.sensors).toHaveLength(1);
  });

  it('POST /predictions/config merges and saves config', async () => {
    const res = await post(predictionsRouter, '/config', {
      activeConfig: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      haToken: 'ignored',
    });

    expect(res.status).toBe(200);
    expect(res.body.config.activeConfig.sensor).toBe('Total Load');
    expect(savePredictionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeConfig: expect.objectContaining({ sensor: 'Total Load' }),
      }),
    );
  });

  it('merges and saves config (historicalPredictor)', async () => {
    loadPredictionConfig.mockResolvedValue({ ...structuredClone(mockConfig), activeType: 'historical' });
    savePredictionConfig.mockResolvedValue();
    const res = await post(predictionsRouter, '/config', {
      historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
    });

    expect(res.status).toBe(200);
    expect(savePredictionConfig).toHaveBeenCalled();
  });

  it('POST /predictions/validate returns validation results', async () => {
    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(200);
    expect(res.body.sensorNames).toContain('Grid Import');
    expect(runValidation).toHaveBeenCalled();
  });

  it('POST /predictions/validate requires HA credentials outside add-on mode', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, haUrl: '', haToken: '' });
    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(400);
  });

  it('POST /predictions/load/forecast maps HA connection errors to 502', async () => {
    runForecast.mockRejectedValueOnce(new Error('HA WebSocket timed out after 30000ms'));
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(502);
  });

  it('POST /predictions/load/forecast persists forecast data when API-backed', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { ...mockSettings.dataSources, load: 'api' } });

    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalled();
  });

  it('POST /predictions/pv/forecast maps Open-Meteo errors to 502', async () => {
    runPvForecast.mockRejectedValueOnce(new Error('Open-Meteo API returned 500'));
    const res = await post(predictionsRouter, '/pv/forecast', {});
    expect(res.status).toBe(502);
  });

  it('POST /predictions/forecast gracefully degrades individual failures', async () => {
    runForecast.mockRejectedValueOnce(new Error('HA WebSocket timed out after 30000ms'));

    const res = await post(predictionsRouter, '/forecast', {});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeNull();
    expect(res.body.pv).toBeTruthy();
  });

  it('returns load=null when activeType missing (graceful fallback)', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
    const res = await post(predictionsRouter, '/forecast', {});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeNull();
    expect(res.body.pv).toBeTruthy();
  });

  it('GET /predictions/forecast/now forces includeRecent=false', async () => {
    const res = await get(predictionsRouter, '/forecast/now');
    expect(res.status).toBe(200);
    expect(runForecast).toHaveBeenCalledWith(expect.objectContaining({ includeRecent: false }));
  });

  it('POST /predictions/pv/forecast returns PV forecast data', async () => {
    const res = await post(predictionsRouter, '/pv/forecast', {});
    expect(res.status).toBe(200);
    expect(res.body.forecast.values).toHaveLength(96);
    expect(runPvForecast).toHaveBeenCalled();
  });

  it('POST /predictions/forecast with ?recent=false passes includeRecent=false to load forecast', async () => {
    const res = await post(predictionsRouter, '/forecast?recent=false', {});
    expect(res.status).toBe(200);
    expect(runForecast).toHaveBeenCalledWith(expect.objectContaining({ includeRecent: false }));
  });

  it('returns 400 when activeType missing for load forecast', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(400);
  });

  it('POST /predictions/forecast returns null PV when pvConfig has invalid coordinates', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      pvConfig: { latitude: NaN, longitude: NaN, azimuth: 180, tilt: 35 },
    });

    const res = await post(predictionsRouter, '/forecast', {});
    expect(res.status).toBe(200);
    expect(res.body.pv).toBeNull();
    expect(res.body.load).toBeTruthy();
    expect(runPvForecast).not.toHaveBeenCalled();
  });

  it('POST /predictions/load/forecast passes through generic non-connection errors as 500', async () => {
    runForecast.mockRejectedValueOnce(new Error('data processing failed'));
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(500);
  });

  it('POST /predictions/load/forecast maps connection refused to 502', async () => {
    runForecast.mockRejectedValueOnce(new Error('connection refused'));
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(502);
  });

  // --- Coverage: predictions.ts catch blocks and branches ---

  it('GET /predictions/config returns 500 when loadPredictionConfig rejects', async () => {
    loadPredictionConfig.mockRejectedValueOnce(new Error('disk read failed'));
    const res = await get(predictionsRouter, '/config');
    expect(res.status).toBe(500);
  });

  it('POST /predictions/config returns 500 when savePredictionConfig rejects', async () => {
    savePredictionConfig.mockRejectedValueOnce(new Error('disk write failed'));
    const res = await post(predictionsRouter, '/config', { sensors: [] });
    expect(res.status).toBe(500);
  });

  it('POST /predictions/validate re-throws non-connection errors from runValidation', async () => {
    runValidation.mockRejectedValueOnce(new Error('unexpected parse error'));
    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(500);
  });

  it('POST /predictions/validate handles non-Error throwable from runValidation', async () => {
    runValidation.mockRejectedValueOnce('string error');
    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(500);
  });

  it('POST /predictions/load/forecast with ?recent=false passes includeRecent=false', async () => {
    const res = await post(predictionsRouter, '/load/forecast?recent=false', {});
    expect(res.status).toBe(200);
    expect(runForecast).toHaveBeenCalledWith(expect.objectContaining({ includeRecent: false }));
  });

  it('POST /predictions/validate maps auth errors from runValidation to 502', async () => {
    runValidation.mockRejectedValueOnce(new Error('HA authentication failed'));
    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(502);
  });

  // --- Coverage: 'fixed' activeType branch (lines 152-158 in predictions.ts) ---

  it('returns 400 when activeType is fixed but fixedPredictor is missing', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      activeType: 'fixed',
      fixedPredictor: undefined,
    });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fixedPredictor is required for fixed activeType');
  });

  it('returns 400 when fixedPredictor.load_W is negative', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      activeType: 'fixed',
      fixedPredictor: { load_W: -500 },
    });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fixedPredictor.load_W must be a non-negative finite number');
  });

  it('returns 400 when fixedPredictor.load_W is NaN', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      activeType: 'fixed',
      fixedPredictor: { load_W: NaN },
    });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fixedPredictor.load_W must be a non-negative finite number');
  });

  it('returns 400 when fixedPredictor.load_W is Infinity', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      activeType: 'fixed',
      fixedPredictor: { load_W: Infinity },
    });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fixedPredictor.load_W must be a non-negative finite number');
  });

  it('accepts fixedPredictor with valid load_W', async () => {
    loadPredictionConfig.mockResolvedValue({
      ...structuredClone(mockConfig),
      activeType: 'fixed',
      fixedPredictor: { load_W: 500 },
    });
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(200);
  });

  // --- Coverage: maybeSaveForecastData early return (line 219) ---

  it('does not save data when PV forecast result has no values (maybeSaveForecastData early return)', async () => {
    // runPvForecast returns a result with forecast that has no values property
    // This triggers the early return in maybeSaveForecastData (line 219)
    runPvForecast.mockResolvedValueOnce({ forecast: { start: '2026-02-20T00:00:00Z', step: 15 } });
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { ...mockSettings.dataSources, pv: 'api' } });

    const res = await post(predictionsRouter, '/pv/forecast', {});
    expect(res.status).toBe(200);
    // saveData should not have been called because forecast has no values
    expect(saveData).not.toHaveBeenCalled();
  });

  // --- Coverage: mapPredictionError non-Error throwable (lines 229, 236) ---

  it('POST /predictions/load/forecast maps non-Error throwable to 500', async () => {
    // runForecast rejects with a string — mapPredictionError (line 229) uses String(err),
    // then returns new Error(msg) (line 236 fallback). Route handler catches and wraps.
    runForecast.mockRejectedValueOnce('string error throwable');
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(500);
  });

  it('POST /predictions/load/forecast maps non-Error string with auth keyword to 502', async () => {
    runForecast.mockRejectedValueOnce('HA authentication failed');
    const res = await post(predictionsRouter, '/load/forecast', {});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('HA connection error');
  });

  // ------------------------- Manual adjustments -------------------------
  // These drive prediction-adjustment-store.ts through the data-store mock.

  const FUTURE_START = '2099-01-01T00:00:00.000Z';
  const FUTURE_END = '2099-01-01T01:00:00.000Z';

  function patch(router, url, body) {
    return inject(router, { method: 'PATCH', url, body });
  }
  function del(router, url) {
    return inject(router, { method: 'DELETE', url });
  }

  function storedAdjustment(overrides = {}) {
    return {
      id: 'adj-1',
      series: 'load',
      mode: 'add',
      value_W: 100,
      start: FUTURE_START,
      end: FUTURE_END,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('GET /predictions/adjustments returns the active adjustments', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [storedAdjustment({ id: 'a' })] });
    const res = await get(predictionsRouter, '/adjustments');
    expect(res.status).toBe(200);
    expect(res.body.adjustments.map(a => a.id)).toEqual(['a']);
  });

  it('GET /predictions/adjustments returns 500 when the store throws', async () => {
    loadData.mockRejectedValueOnce(new Error('disk read failed'));
    const res = await get(predictionsRouter, '/adjustments');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to read prediction adjustments');
  });

  it('POST /predictions/adjustments creates and persists an adjustment (201)', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [] });
    const res = await post(predictionsRouter, '/adjustments', {
      series: 'pv', mode: 'set', value_W: 0, start: FUTURE_START, end: FUTURE_END, label: 'cloudy',
    });
    expect(res.status).toBe(201);
    expect(res.body.adjustment.series).toBe('pv');
    expect(res.body.adjustment.value_W).toBe(0);
    expect(res.body.adjustments).toHaveLength(1);
    expect(saveData).toHaveBeenCalled();
  });

  it('POST /predictions/adjustments rejects a non-object body (400)', async () => {
    const res = await post(predictionsRouter, '/adjustments', []);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('prediction adjustment payload must be an object');
  });

  it('POST /predictions/adjustments surfaces validation HttpErrors as 400', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [] });
    const res = await post(predictionsRouter, '/adjustments', {
      series: 'grid', mode: 'set', value_W: 0, start: FUTURE_START, end: FUTURE_END,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('series must be "load" or "pv"');
  });

  it('POST /predictions/adjustments maps a non-HttpError store failure to 500', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [] });
    saveData.mockRejectedValueOnce(new Error('disk write failed'));
    const res = await post(predictionsRouter, '/adjustments', {
      series: 'pv', mode: 'set', value_W: 0, start: FUTURE_START, end: FUTURE_END,
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create prediction adjustment');
  });

  it('PATCH /predictions/adjustments/:id updates an existing adjustment', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [storedAdjustment({ id: 'a', value_W: 100 })] });
    const res = await patch(predictionsRouter, '/adjustments/a', { value_W: 555 });
    expect(res.status).toBe(200);
    expect(res.body.adjustment.value_W).toBe(555);
    expect(saveData).toHaveBeenCalled();
  });

  it('PATCH /predictions/adjustments/:id rejects a non-object body (400)', async () => {
    const res = await patch(predictionsRouter, '/adjustments/a', []);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('prediction adjustment payload must be an object');
  });

  it('PATCH /predictions/adjustments/:id returns 404 when not found', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [storedAdjustment({ id: 'a' })] });
    const res = await patch(predictionsRouter, '/adjustments/missing', { value_W: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Prediction adjustment not found');
  });

  it('PATCH /predictions/adjustments/:id maps a non-HttpError store failure to 500', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [storedAdjustment({ id: 'a' })] });
    saveData.mockRejectedValueOnce(new Error('disk write failed'));
    const res = await patch(predictionsRouter, '/adjustments/a', { value_W: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update prediction adjustment');
  });

  it('DELETE /predictions/adjustments/:id removes an adjustment', async () => {
    loadData.mockResolvedValue({
      predictionAdjustments: [storedAdjustment({ id: 'a' }), storedAdjustment({ id: 'b' })],
    });
    const res = await del(predictionsRouter, '/adjustments/a');
    expect(res.status).toBe(200);
    expect(res.body.adjustments.map(x => x.id)).toEqual(['b']);
    expect(saveData).toHaveBeenCalled();
  });

  it('DELETE /predictions/adjustments/:id returns 404 when not found', async () => {
    loadData.mockResolvedValue({ predictionAdjustments: [storedAdjustment({ id: 'a' })] });
    const res = await del(predictionsRouter, '/adjustments/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Prediction adjustment not found');
  });

  it('DELETE /predictions/adjustments/:id maps a non-HttpError store failure to 500', async () => {
    loadData.mockRejectedValueOnce(new Error('disk read failed'));
    const res = await del(predictionsRouter, '/adjustments/a');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete prediction adjustment');
  });
});
