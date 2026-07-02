// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock every direct dependency of the runner; the runner orchestration runs for real.
vi.mock('../../../api/services/prediction-config-store.ts', () => ({
  loadPredictionConfig: vi.fn(),
}));
vi.mock('../../../api/services/load-prediction-service.ts', () => ({
  runValidation: vi.fn(),
  runForecast: vi.fn(),
}));
vi.mock('../../../api/services/pv-prediction-service.ts', () => ({
  runPvForecast: vi.fn(),
}));
vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(),
  saveData: vi.fn(async () => {}),
}));
vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../../api/services/prediction-adjustments.ts', () => ({
  applyPredictionAdjustmentsToSeries: vi.fn((series) => series),
  pruneExpiredPredictionAdjustments: vi.fn((data) => ({
    data,
    adjustments: data.predictionAdjustments ?? [],
    changed: false,
  })),
}));
vi.mock('../../../api/services/prediction-adjustment-store.ts', () => ({
  loadActiveAdjustmentsAndPrune: vi.fn(async () => ({ adjustments: [] })),
}));

import {
  buildPredictionRunConfig,
  executePredictionValidation,
  runCombinedPredictionForecast,
  executeLoadForecast,
  executePvForecast,
  persistForecastData,
  withAdjustedForecast,
} from '../../../api/services/prediction-forecast-runner.ts';

import { loadPredictionConfig } from '../../../api/services/prediction-config-store.ts';
import { runValidation, runForecast as runLoadForecast } from '../../../api/services/load-prediction-service.ts';
import { runPvForecast } from '../../../api/services/pv-prediction-service.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import {
  applyPredictionAdjustmentsToSeries,
  pruneExpiredPredictionAdjustments,
} from '../../../api/services/prediction-adjustments.ts';
import { loadActiveAdjustmentsAndPrune } from '../../../api/services/prediction-adjustment-store.ts';

const HA = { haUrl: 'ws://ha.local:8123/api/websocket', haToken: 'tok' };
const SENSOR = { entity: 'sensor.house_power', name: 'House' };

function makeConfig(overrides = {}) {
  return {
    sensors: [SENSOR],
    derived: [],
    activeType: 'fixed',
    fixedPredictor: { load_W: 500 },
    ...HA,
    ...overrides,
  };
}

function makeSeries(start = '2026-06-19T00:00:00.000Z') {
  return { start, step: 15, values: [1, 2, 3, 4] };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPERVISOR_TOKEN;
  // sensible defaults the happy paths rely on
  loadSettings.mockResolvedValue({
    ...HA,
    dataSources: { load: 'api', pv: 'api' },
  });
  loadData.mockResolvedValue({
    load: makeSeries(),
    pv: makeSeries(),
    importPrice: makeSeries(),
    exportPrice: makeSeries(),
    soc: { timestamp: '2026-06-19T00:00:00.000Z', value: 50 },
  });
  pruneExpiredPredictionAdjustments.mockImplementation((data) => ({
    data,
    adjustments: data.predictionAdjustments ?? [],
    changed: false,
  }));
  applyPredictionAdjustmentsToSeries.mockImplementation((series) => series);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildPredictionRunConfig', () => {
  it('merges persisted config with HA credentials from settings', async () => {
    loadPredictionConfig.mockResolvedValue({ sensors: [SENSOR], derived: [], activeType: 'fixed' });
    loadSettings.mockResolvedValue({ haUrl: 'ws://x', haToken: 'secret', dataSources: { load: 'api', pv: 'api' } });

    const result = await buildPredictionRunConfig();

    expect(result).toMatchObject({
      sensors: [SENSOR],
      activeType: 'fixed',
      haUrl: 'ws://x',
      haToken: 'secret',
    });
  });
});

describe('executePredictionValidation', () => {
  it('runs validation and returns its result', async () => {
    runValidation.mockResolvedValue({ ok: true });
    const result = await executePredictionValidation(makeConfig());
    expect(result).toEqual({ ok: true });
    expect(runValidation).toHaveBeenCalledTimes(1);
  });

  it('asserts at least one sensor is configured (400)', async () => {
    await expect(executePredictionValidation(makeConfig({ sensors: [] })))
      .rejects.toMatchObject({ statusCode: 400, message: /At least one sensor/ });
    expect(runValidation).not.toHaveBeenCalled();
  });

  it('asserts an HA connection (400) when no creds and no SUPERVISOR_TOKEN', async () => {
    await expect(executePredictionValidation(makeConfig({ haUrl: '', haToken: '' })))
      .rejects.toMatchObject({ statusCode: 400, message: /haUrl and haToken are required/ });
  });

  it('passes the HA assertion in add-on mode via SUPERVISOR_TOKEN', async () => {
    process.env.SUPERVISOR_TOKEN = 'supervisor';
    runValidation.mockResolvedValue({ ok: true });
    const result = await executePredictionValidation(makeConfig({ haUrl: '', haToken: '' }));
    expect(result).toEqual({ ok: true });
  });

  it('maps an HA connection error (Error) to 502', async () => {
    runValidation.mockRejectedValue(new Error('WebSocket closed unexpectedly'));
    await expect(executePredictionValidation(makeConfig()))
      .rejects.toMatchObject({ statusCode: 502, message: /HA connection error/ });
  });

  it('maps a non-Error rejection that mentions auth to 502', async () => {
    runValidation.mockRejectedValue('auth token rejected');
    await expect(executePredictionValidation(makeConfig()))
      .rejects.toMatchObject({ statusCode: 502, message: /HA connection error: auth token rejected/ });
  });

  it('rethrows unrelated validation errors unchanged', async () => {
    const boom = new Error('solver overflow');
    runValidation.mockRejectedValue(boom);
    await expect(executePredictionValidation(makeConfig())).rejects.toBe(boom);
  });
});

describe('executeLoadForecast', () => {
  it('runs a fixed forecast and returns the result', async () => {
    const forecast = makeSeries();
    runLoadForecast.mockResolvedValue({ forecast });
    const result = await executeLoadForecast(makeConfig(), 'unit');
    expect(result).toEqual({ forecast });
  });

  it('asserts activeType is present (400)', async () => {
    await expect(executeLoadForecast(makeConfig({ activeType: undefined }), 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /activeType is required/ });
  });

  it('asserts historical predictor fields for the historical activeType', async () => {
    const cfg = makeConfig({ activeType: 'historical', historicalPredictor: undefined });
    await expect(executeLoadForecast(cfg, 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /historicalPredictor is required/ });
  });

  it('runs a historical forecast when the predictor and sensors are present', async () => {
    runLoadForecast.mockResolvedValue({ forecast: makeSeries() });
    const cfg = makeConfig({
      activeType: 'historical',
      historicalPredictor: { sensor: 'sensor.house_power', lookbackWeeks: 4, dayFilter: 'all', aggregation: 'mean' },
      fixedPredictor: undefined,
    });
    const result = await executeLoadForecast(cfg, 'unit');
    expect(result.forecast).toBeDefined();
  });

  it('asserts fixedPredictor is present for the fixed activeType', async () => {
    await expect(executeLoadForecast(makeConfig({ fixedPredictor: undefined }), 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /fixedPredictor is required/ });
  });

  it('asserts fixedPredictor.load_W is non-negative and finite', async () => {
    await expect(executeLoadForecast(makeConfig({ fixedPredictor: { load_W: -1 } }), 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /load_W must be a non-negative/ });
  });

  it('maps an HA connection error from the load forecast to 502', async () => {
    runLoadForecast.mockRejectedValue(new Error('connection refused by host'));
    await expect(executeLoadForecast(makeConfig(), 'unit'))
      .rejects.toMatchObject({ statusCode: 502, message: /HA connection error/ });
  });

  it('passes through an unrelated load forecast error', async () => {
    runLoadForecast.mockRejectedValue(new Error('weird parse failure'));
    await expect(executeLoadForecast(makeConfig(), 'unit')).rejects.toThrow('weird parse failure');
  });

  it('wraps a non-Error load forecast rejection in an Error', async () => {
    runLoadForecast.mockRejectedValue('string failure');
    await expect(executeLoadForecast(makeConfig(), 'unit')).rejects.toThrow('string failure');
  });
});

describe('executePvForecast', () => {
  it('returns null when no pvConfig is configured', async () => {
    const result = await executePvForecast(makeConfig({ pvConfig: undefined }), 'unit');
    expect(result).toBeNull();
    expect(runPvForecast).not.toHaveBeenCalled();
  });

  it('returns null when latitude is missing or NaN', async () => {
    const r1 = await executePvForecast(makeConfig({ pvConfig: { latitude: null, longitude: 4 } }), 'unit');
    expect(r1).toBeNull();
    const r2 = await executePvForecast(makeConfig({ pvConfig: { latitude: NaN, longitude: 4 } }), 'unit');
    expect(r2).toBeNull();
  });

  it('returns null when longitude is missing or NaN', async () => {
    const r1 = await executePvForecast(makeConfig({ pvConfig: { latitude: 51, longitude: null } }), 'unit');
    expect(r1).toBeNull();
    const r2 = await executePvForecast(makeConfig({ pvConfig: { latitude: 51, longitude: NaN } }), 'unit');
    expect(r2).toBeNull();
  });

  it('runs the PV forecast for valid coordinates', async () => {
    runPvForecast.mockResolvedValue({ forecast: makeSeries() });
    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    const result = await executePvForecast(cfg, 'unit');
    expect(result.forecast).toBeDefined();
    expect(runPvForecast).toHaveBeenCalledTimes(1);
  });

  it('asserts an HA connection for a PV forecast', async () => {
    const cfg = makeConfig({ haUrl: '', haToken: '', pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await expect(executePvForecast(cfg, 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /haUrl and haToken are required/ });
  });

  it('asserts at least one sensor for a PV forecast', async () => {
    const cfg = makeConfig({ sensors: [], pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await expect(executePvForecast(cfg, 'unit'))
      .rejects.toMatchObject({ statusCode: 400, message: /At least one sensor/ });
  });

  it('maps an Open-Meteo error to 502 (PV-specific branch)', async () => {
    runPvForecast.mockRejectedValue(new Error('Open-Meteo returned 500'));
    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await expect(executePvForecast(cfg, 'unit'))
      .rejects.toMatchObject({ statusCode: 502, message: /Open-Meteo error/ });
  });

  it('maps an HA connection error from the PV forecast to 502', async () => {
    runPvForecast.mockRejectedValue(new Error('WebSocket timed out'));
    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await expect(executePvForecast(cfg, 'unit'))
      .rejects.toMatchObject({ statusCode: 502, message: /HA connection error/ });
  });
});

describe('persistForecastData', () => {
  it('returns early when neither load nor pv values are present', async () => {
    await persistForecastData({});
    expect(loadSettings).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it('returns without saving when the data sources are not "api"', async () => {
    loadSettings.mockResolvedValue({ ...HA, dataSources: { load: 'vrm', pv: 'vrm' } });
    await persistForecastData({ load: makeSeries(), pv: makeSeries() });
    expect(saveData).not.toHaveBeenCalled();
  });

  it('persists only the load series when load is api but pv is not', async () => {
    loadSettings.mockResolvedValue({ ...HA, dataSources: { load: 'api', pv: 'vrm' } });
    const newLoad = makeSeries('2026-06-20T00:00:00.000Z');
    await persistForecastData({ load: newLoad, pv: makeSeries() });
    expect(saveData).toHaveBeenCalledTimes(1);
    const saved = saveData.mock.calls[0][0];
    expect(saved.load).toEqual(newLoad);
    // pv untouched (source is vrm)
    expect(saved.pv).toEqual(makeSeries());
  });

  it('persists only the pv series when only pv values are supplied', async () => {
    const newPv = makeSeries('2026-06-22T00:00:00.000Z');
    // load absent -> left operand of the early-return guard is true; pv present -> not early-return.
    await persistForecastData({ pv: newPv });
    expect(saveData).toHaveBeenCalledTimes(1);
    const saved = saveData.mock.calls[0][0];
    expect(saved.pv).toEqual(newPv);
  });

  it('persists both series when both sources are api', async () => {
    const newLoad = makeSeries('2026-06-20T00:00:00.000Z');
    const newPv = makeSeries('2026-06-21T00:00:00.000Z');
    await persistForecastData({ load: newLoad, pv: newPv });
    const saved = saveData.mock.calls[0][0];
    expect(saved.load).toEqual(newLoad);
    expect(saved.pv).toEqual(newPv);
  });
});

describe('runCombinedPredictionForecast', () => {
  it('runs load + pv, persists, prunes, and applies adjustments', async () => {
    const loadForecast = makeSeries();
    const pvForecast = makeSeries('2026-06-20T00:00:00.000Z');
    runLoadForecast.mockResolvedValue({ forecast: loadForecast });
    runPvForecast.mockResolvedValue({ forecast: pvForecast });

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    const result = await runCombinedPredictionForecast(cfg, 'combined');

    expect(result.load.forecast).toBeDefined();
    expect(result.load.rawForecast).toEqual(loadForecast);
    expect(result.pv.forecast).toBeDefined();
    expect(saveData).toHaveBeenCalled();
    expect(applyPredictionAdjustmentsToSeries).toHaveBeenCalled();
  });

  it('tolerates a failed load forecast (logs and continues with null)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runLoadForecast.mockRejectedValue(new Error('load blew up'));
    runPvForecast.mockResolvedValue({ forecast: makeSeries() });

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    const result = await runCombinedPredictionForecast(cfg, 'combined');

    expect(result.load).toBeNull();
    expect(result.pv.forecast).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[predict] load forecast failed in combined:'),
      'load blew up',
    );
    warnSpy.mockRestore();
  });

  it('warns but still returns results when forecast persistence fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runLoadForecast.mockResolvedValue({ forecast: makeSeries() });
    runPvForecast.mockResolvedValue(null);
    saveData.mockRejectedValueOnce(new Error('disk full'));

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    const result = await runCombinedPredictionForecast(cfg, 'combined');

    expect(warnSpy).toHaveBeenCalledWith('[predict] forecast persistence failed:', 'disk full');
    expect(result.load.forecast).toBeDefined();
    expect(result.pv).toBeNull();
    warnSpy.mockRestore();
  });

  it('logs the raw (non-Error) reason when persistence rejects with a non-Error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runLoadForecast.mockResolvedValue({ forecast: makeSeries() });
    runPvForecast.mockResolvedValue(null);
    saveData.mockRejectedValueOnce('weird');

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await runCombinedPredictionForecast(cfg, 'combined');

    expect(warnSpy).toHaveBeenCalledWith('[predict] forecast persistence failed:', 'weird');
    warnSpy.mockRestore();
  });
});

describe('persistForecastAndPrune (via runCombinedPredictionForecast)', () => {
  it('saves the pruned data when adjustments changed even if no forecast values set', async () => {
    // Neither source is api -> setLoad/setPv false, but pruning reports a change.
    loadSettings.mockResolvedValue({ ...HA, dataSources: { load: 'vrm', pv: 'vrm' } });
    pruneExpiredPredictionAdjustments.mockImplementation((data) => ({
      data: { ...data, predictionAdjustments: [] },
      adjustments: [],
      changed: true,
    }));
    runLoadForecast.mockResolvedValue({ forecast: makeSeries() });
    runPvForecast.mockResolvedValue(null);

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await runCombinedPredictionForecast(cfg, 'combined');

    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it('does not save when nothing changed and no forecast values are set', async () => {
    loadSettings.mockResolvedValue({ ...HA, dataSources: { load: 'vrm', pv: 'vrm' } });
    pruneExpiredPredictionAdjustments.mockImplementation((data) => ({
      data,
      adjustments: [],
      changed: false,
    }));
    runLoadForecast.mockResolvedValue({ forecast: makeSeries() });
    runPvForecast.mockResolvedValue(null);

    const cfg = makeConfig({ pvConfig: { latitude: 51.2, longitude: 4.4 } });
    await runCombinedPredictionForecast(cfg, 'combined');

    expect(saveData).not.toHaveBeenCalled();
  });
});

describe('withAdjustedForecast', () => {
  it('applies active adjustments to a result with a forecast', async () => {
    const forecast = makeSeries();
    const adjusted = makeSeries('2026-07-01T00:00:00.000Z');
    loadActiveAdjustmentsAndPrune.mockResolvedValue({ adjustments: [{ id: 'a' }] });
    applyPredictionAdjustmentsToSeries.mockReturnValue(adjusted);

    const result = await withAdjustedForecast({ forecast }, 'load');

    expect(result.rawForecast).toEqual(forecast);
    expect(result.forecast).toEqual(adjusted);
    expect(applyPredictionAdjustmentsToSeries).toHaveBeenCalledWith(forecast, [{ id: 'a' }], 'load');
  });

  it('returns the result unchanged when there is no forecast', async () => {
    loadActiveAdjustmentsAndPrune.mockResolvedValue({ adjustments: [] });
    const result = await withAdjustedForecast({ other: 1 }, 'pv');
    expect(result).toEqual({ other: 1 });
    expect(result.rawForecast).toBeUndefined();
  });

  it('returns null unchanged when the result is null', async () => {
    loadActiveAdjustmentsAndPrune.mockResolvedValue({ adjustments: [] });
    const result = await withAdjustedForecast(null, 'load');
    expect(result).toBeNull();
  });
});
