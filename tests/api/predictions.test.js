import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get, post, inject } from './helpers/express-test-client.js';

vi.mock('../../api/services/prediction-config-store.ts');
vi.mock('../../api/services/load-prediction-service.ts');
vi.mock('../../api/services/pv-prediction-service.ts');
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/prediction-auto-select.ts');
vi.mock('../../api/services/prediction-auto-select-store.ts');

import { loadPredictionConfig, savePredictionConfig, updatePredictionConfig } from '../../api/services/prediction-config-store.ts';
import { runValidation, runForecast, scoreStrategyPredictions } from '../../api/services/load-prediction-service.ts';
import { runPvForecast } from '../../api/services/pv-prediction-service.ts';
import { loadSettings } from '../../api/services/settings-store.ts';
import { loadData, saveData } from '../../api/services/data-store.ts';
import { runAutoSelect } from '../../api/services/prediction-auto-select.ts';
import { getLatestAutoSelectRun, loadAutoSelectHistory } from '../../api/services/prediction-auto-select-store.ts';

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
    // Same contract as the real store lock: load → mutate → save unless null.
    updatePredictionConfig.mockImplementation(async (mutate) => {
      const next = mutate(await loadPredictionConfig());
      if (next) await savePredictionConfig(next);
      return next;
    });
    getLatestAutoSelectRun.mockResolvedValue(null);
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

  describe('auto-select', () => {
    const autoSelectConfig = { enabled: true, mode: 'suggest', time: '03:30', metric: 'mae', minImprovement_percent: 10, windowDays: 28 };
    const run = (at, action = 'kept') => ({ at, trigger: 'scheduled', sensor: 'Grid Import', windowDays: 28, metric: 'mae', mode: 'suggest', incumbent: null, best: null, improvement_percent: null, reason: 'incumbent-best', action, ranking: [] });

    it('GET /predictions/auto-select returns config and lastRun, without the ring buffer', async () => {
      loadSettings.mockResolvedValue({ ...mockSettings, predictionAutoSelect: autoSelectConfig });
      getLatestAutoSelectRun.mockResolvedValue(run('2026-08-23T01:30:00.000Z', 'suggested'));

      const res = await get(predictionsRouter, '/auto-select');
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual(autoSelectConfig);
      expect(res.body.lastRun.action).toBe('suggested');
      expect(res.body).not.toHaveProperty('history');
      expect(loadAutoSelectHistory).not.toHaveBeenCalled();
    });

    it('GET /predictions/auto-select?history=1 includes the run history', async () => {
      getLatestAutoSelectRun.mockResolvedValue(run('2026-08-23T01:30:00.000Z', 'suggested'));
      loadAutoSelectHistory.mockResolvedValue([run('2026-08-22T01:30:00.000Z'), run('2026-08-23T01:30:00.000Z', 'suggested')]);

      let res = await get(predictionsRouter, '/auto-select?history=1');
      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(2);
      expect(res.body.lastRun.action).toBe('suggested');

      res = await get(predictionsRouter, '/auto-select?history=true');
      expect(res.body.history).toHaveLength(2);
    });

    it('GET /predictions/auto-select reports null config and lastRun when nothing exists', async () => {
      const res = await get(predictionsRouter, '/auto-select');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ config: null, lastRun: null });
    });

    it('GET /predictions/auto-select maps store failures to 500', async () => {
      getLatestAutoSelectRun.mockRejectedValue(new Error('disk'));
      const res = await get(predictionsRouter, '/auto-select');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to read auto-select state');
    });

    it('POST /predictions/auto-select/run runs with apply=true by default', async () => {
      runAutoSelect.mockResolvedValue(run('2026-08-23T09:00:00.000Z', 'applied'));
      const res = await post(predictionsRouter, '/auto-select/run', {});
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('applied');
      expect(runAutoSelect).toHaveBeenCalledWith({ apply: true, trigger: 'manual' });
    });

    it('POST /predictions/auto-select/run honours apply=false (dry run)', async () => {
      runAutoSelect.mockResolvedValue(run('2026-08-23T09:00:00.000Z', 'suggested'));
      const res = await post(predictionsRouter, '/auto-select/run', { apply: false });
      expect(res.status).toBe(200);
      expect(runAutoSelect).toHaveBeenCalledWith({ apply: false, trigger: 'manual' });
    });

    it('POST /predictions/auto-select/run rejects a non-boolean apply instead of coercing it', async () => {
      // "false"/0 mean a dry run to the caller; silently reading them as
      // apply=true would rewrite prediction-config.json in auto mode.
      for (const apply of ['false', 0, 'true', null]) {
        const res = await post(predictionsRouter, '/auto-select/run', { apply });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('auto-select "apply" must be a boolean');
      }
      expect(runAutoSelect).not.toHaveBeenCalled();
    });

    it('POST /predictions/auto-select/run passes HttpErrors through (409 while running)', async () => {
      // importRouter() resets the module registry, so use the HttpError class the router sees
      const { HttpError: RouterHttpError } = await import('../../api/http-errors.ts');
      runAutoSelect.mockRejectedValue(new RouterHttpError(409, 'Auto-select run already in progress'));
      const res = await post(predictionsRouter, '/auto-select/run', {});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Auto-select run already in progress');
    });

    it('POST /predictions/auto-select/run maps other failures to 500', async () => {
      runAutoSelect.mockRejectedValue(new Error('HA WebSocket timed out'));
      const res = await post(predictionsRouter, '/auto-select/run', {});
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Auto-select run failed');
    });
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

  it('merges and saves config (historicalPredictor) under the store lock', async () => {
    loadPredictionConfig.mockResolvedValue({ ...structuredClone(mockConfig), activeType: 'historical' });
    savePredictionConfig.mockResolvedValue();
    const res = await post(predictionsRouter, '/config', {
      historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      haUrl: 'ws://should-be-stripped', validationWindow: { start: 'x', end: 'y' },
    });

    expect(res.status).toBe(200);
    expect(updatePredictionConfig).toHaveBeenCalledOnce();
    expect(savePredictionConfig).toHaveBeenCalledOnce();
    const saved = savePredictionConfig.mock.calls[0][0];
    expect(saved.historicalPredictor).toEqual({ sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(saved).not.toHaveProperty('haUrl');
    // validationWindow is server-owned: the stored one survives, the posted one is dropped.
    expect(saved.validationWindow).toEqual(mockConfig.validationWindow);
  });

  it('POST /predictions/config rejects an out-of-range lookbackWeeks with 400 before writing', async () => {
    // lookbackWeeks reaches a synchronous day loop; 1e7 would hang the process.
    for (const lookbackWeeks of [20000, 1e7, 0, 2.5, 'four']) {
      const res = await post(predictionsRouter, '/config', {
        historicalPredictor: { sensor: 'Total Load', lookbackWeeks, dayFilter: 'same', aggregation: 'mean' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('historicalPredictor.lookbackWeeks must be an integer between 1 and 52');
    }
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('POST /predictions/config rejects bad enums and a non-object payload', async () => {
    let res = await post(predictionsRouter, '/config', { activeType: 'neural' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('activeType must be one of');
    res = await post(predictionsRouter, '/config', [1, 2]);
    expect(res.status).toBe(400);
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('POST /predictions/validate/strategy returns the per-hour predictions of one strategy', async () => {
    const strategy = { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' };
    scoreStrategyPredictions.mockResolvedValue({ strategy, validationPredictions: [{ time: 1, actual: 500, predicted: 480 }] });

    const res = await post(predictionsRouter, '/validate/strategy', strategy);
    expect(res.status).toBe(200);
    expect(res.body.validationPredictions).toHaveLength(1);
    expect(scoreStrategyPredictions).toHaveBeenCalledWith(
      expect.objectContaining({ haUrl: mockSettings.haUrl, validationWindow: mockConfig.validationWindow }),
      strategy,
    );
  });

  it('POST /predictions/validate/strategy validates the strategy and requires HA credentials', async () => {
    let res = await post(predictionsRouter, '/validate/strategy', { sensor: 'Grid Import', lookbackWeeks: 999, dayFilter: 'same', aggregation: 'mean' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('lookbackWeeks');
    res = await post(predictionsRouter, '/validate/strategy', {});
    expect(res.status).toBe(400);
    expect(scoreStrategyPredictions).not.toHaveBeenCalled();

    loadSettings.mockResolvedValue({ ...mockSettings, haUrl: '', haToken: '' });
    res = await post(predictionsRouter, '/validate/strategy', { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(res.status).toBe(400);

    loadSettings.mockResolvedValue(structuredClone(mockSettings));
    scoreStrategyPredictions.mockRejectedValue(new Error('HA WebSocket timed out after 120000ms'));
    res = await post(predictionsRouter, '/validate/strategy', { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(res.status).toBe(502);

    scoreStrategyPredictions.mockRejectedValue(new Error('unexpected parse error'));
    res = await post(predictionsRouter, '/validate/strategy', { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' });
    expect(res.status).toBe(500);
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
