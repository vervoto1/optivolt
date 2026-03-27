import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get, post } from './helpers/express-test-client.js';

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
  historyStart: '2025-11-01T00:00:00Z',
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  validationWindow: { start: '2026-01-18T00:00:00Z', end: '2026-01-25T00:00:00Z' },
  activeConfig: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
  pvConfig: { latitude: 51.0, longitude: 3.7, azimuth: 180, tilt: 35 },
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
});
