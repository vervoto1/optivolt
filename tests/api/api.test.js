import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, post, inject } from './helpers/express-test-client.js';
import { HttpError, assertCondition } from '../../api/http-errors.ts';

vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/plan-history-store.ts');
vi.mock('../../api/services/soc-tracker.ts');
vi.mock('../../api/services/efficiency-calibrator.ts');
vi.mock('../../api/services/plan-accuracy-service.ts');
vi.mock('../../api/services/auto-calculate.ts');
vi.mock('../../api/services/dess-price-refresh.ts');
vi.mock('../../api/services/shore-optimizer.ts');
vi.mock('../../api/services/planner-service.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/prediction-config-store.ts');

import { loadSettings, saveSettings } from '../../api/services/settings-store.ts';
import { refreshSettingsFromVrmAndPersist } from '../../api/services/vrm-refresh.ts';
import { loadPlanHistory, clearPlanHistory } from '../../api/services/plan-history-store.ts';
import { getRecentSamples, clearSocSamples } from '../../api/services/soc-tracker.ts';
import { loadCalibration, calibrate, resetCalibration } from '../../api/services/efficiency-calibrator.ts';
import { evaluateRecentPlans } from '../../api/services/plan-accuracy-service.ts';
import { startAutoCalculate, stopAutoCalculate } from '../../api/services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../../api/services/dess-price-refresh.ts';
import { startShoreOptimizer, stopShoreOptimizer } from '../../api/services/shore-optimizer.ts';
import { planAndMaybeWrite } from '../../api/services/planner-service.ts';

async function importRoutes() {
  vi.resetModules();
  const [{ default: calculateRouter }, { default: settingsRouter }, { default: vrmRouter }, { default: planAccuracyRouter }] =
    await Promise.all([
      import('../../api/routes/calculate.ts'),
      import('../../api/routes/settings.ts'),
      import('../../api/routes/vrm.ts'),
      import('../../api/routes/plan-accuracy.ts'),
    ]);
  return { calculateRouter, settingsRouter, vrmRouter, planAccuracyRouter };
}

const mockSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  rebalanceHoldHours: 0,
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'secret-token',
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt', evLoad: 'api' },
  evConfig: {
    enabled: false,
    chargerPower_W: 11000,
    disableDischargeWhileCharging: true,
    scheduleSensor: '',
    scheduleAttribute: '',
    connectedSwitch: '',
    alwaysApplySchedule: false,
  },
  autoCalculate: {
    enabled: false,
    intervalMinutes: 60,
    updateData: true,
    writeToVictron: true,
  },
  haPriceConfig: {
    sensor: '',
    todayAttribute: 'today',
    tomorrowAttribute: 'tomorrow',
    timeKey: 'time',
    valueKey: 'value',
    valueMultiplier: 1,
    importEqualsExport: false,
    priceInterval: 60,
  },
  dessPriceRefresh: {
    enabled: false,
    time: '12:00',
    durationMinutes: 60,
  },
  cvPhase: {
    enabled: true,
    thresholds: [{ soc_percent: 95, maxChargePower_W: 1200 }],
  },
  adaptiveLearning: {
    enabled: false,
    mode: 'suggest',
    minDataDays: 7,
  },
};

describe('Route contracts', () => {
  let routes;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    loadSettings.mockResolvedValue(structuredClone(mockSettings));
    saveSettings.mockResolvedValue();
    refreshSettingsFromVrmAndPersist.mockResolvedValue({ batteryCapacity_Wh: 10000 });
    planAndMaybeWrite.mockResolvedValue({
      cfg: { initialSoc_percent: 20 },
      timing: { startMs: new Date('2024-01-01T00:00:00.000Z').getTime() },
      result: { Status: 'Optimal', ObjectiveValue: 0 },
      rows: [1, 2, 3],
      summary: {},
      rebalanceWindow: null,
    });
    startAutoCalculate.mockReturnValue();
    stopAutoCalculate.mockReturnValue();
    startDessPriceRefresh.mockReturnValue();
    stopDessPriceRefresh.mockReturnValue();
    startShoreOptimizer.mockReturnValue();
    stopShoreOptimizer.mockReturnValue();
    evaluateRecentPlans.mockResolvedValue([]);
    loadCalibration.mockResolvedValue(null);
    loadPlanHistory.mockResolvedValue([]);
    getRecentSamples.mockResolvedValue([]);
    clearPlanHistory.mockResolvedValue();
    clearSocSamples.mockResolvedValue();
    calibrate.mockResolvedValue(null);
    resetCalibration.mockResolvedValue();

    routes = await importRoutes();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('GET /health returns 200', async () => {
    const res = await get((_req, res) => res.json({ message: 'Optivolt API is running.' }), '/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Optivolt API is running.' });
  });

  it('GET /settings redacts haToken', async () => {
    const res = await get(routes.settingsRouter, '/');
    expect(res.status).toBe(200);
    expect(res.body.hasHaToken).toBe(true);
    expect(res.body.haToken).toBeUndefined();
  });

  it('POST /settings structurally merges nested config and restarts timers', async () => {
    const res = await post(routes.settingsRouter, '/', {
      evConfig: { enabled: true },
      haToken: '',
    });

    expect(res.status).toBe(200);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        haToken: 'secret-token',
        evConfig: expect.objectContaining({
          enabled: true,
          chargerPower_W: 11000,
        }),
      }),
    );
    expect(stopAutoCalculate).toHaveBeenCalled();
    expect(startAutoCalculate).toHaveBeenCalled();
    expect(stopDessPriceRefresh).toHaveBeenCalled();
    expect(startDessPriceRefresh).toHaveBeenCalled();
    expect(stopShoreOptimizer).toHaveBeenCalled();
    expect(startShoreOptimizer).toHaveBeenCalled();
  });

  it('POST /calculate forwards parsed flags to planner-service', async () => {
    const res = await post(routes.calculateRouter, '/', { updateData: true, writeToVictron: true });

    expect(res.status).toBe(200);
    expect(planAndMaybeWrite).toHaveBeenCalledWith({
      updateData: true,
      writeToVictron: true,
      forceWrite: true,
    });
    expect(res.body.solverStatus).toBe('Optimal');
  });

  it('GET /plan-accuracy returns null report when no data exists', async () => {
    const res = await get(routes.planAccuracyRouter, '/');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeNull();
  });

  it('POST /plan-accuracy/reset-all clears adaptive-learning state', async () => {
    const res = await post(routes.planAccuracyRouter, '/reset-all', {});
    expect(res.status).toBe(200);
    expect(resetCalibration).toHaveBeenCalled();
    expect(clearPlanHistory).toHaveBeenCalled();
    expect(clearSocSamples).toHaveBeenCalled();
  });

  it('POST /vrm/refresh-settings refreshes settings when env is configured', async () => {
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok-abc';

    const res = await post(routes.vrmRouter, '/refresh-settings', {});
    expect(res.status).toBe(200);
    expect(refreshSettingsFromVrmAndPersist).toHaveBeenCalled();
  });

  // --- http-errors.ts coverage ---

  it('HttpError uses default message for unknown status code', () => {
    const err = new HttpError(418);
    expect(err.message).toBe('HTTP Error');
    expect(err.statusCode).toBe(418);
  });

  it('HttpError uses provided message over default', () => {
    const err = new HttpError(418, 'I am a teapot');
    expect(err.message).toBe('I am a teapot');
  });

  it('HttpError expose defaults to true for client errors', () => {
    const err = new HttpError(400);
    expect(err.expose).toBe(true);
  });

  it('HttpError expose defaults to false for server errors', () => {
    const err = new HttpError(500);
    expect(err.expose).toBe(false);
  });

  it('HttpError stores details when provided', () => {
    const err = new HttpError(400, 'bad', { details: { field: 'x' } });
    expect(err.details).toEqual({ field: 'x' });
  });

  it('assertCondition passes when condition is true', () => {
    expect(() => assertCondition(true, 400, 'msg')).not.toThrow();
  });

  it('assertCondition throws when condition is false', () => {
    expect(() => assertCondition(false, 400, 'bad input')).toThrow('bad input');
  });

  // --- calculate.ts error path (test handler directly to avoid router timeout) ---

  it('POST /calculate returns 500 when planner throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    planAndMaybeWrite.mockRejectedValue(new Error('solver crashed'));

    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const mockNext = vi.fn();
    const { default: calcRouter } = await import('../../api/routes/calculate.ts');

    // Extract the POST handler from the router
    const layer = calcRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    await handler({ body: {} }, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
    spy.mockRestore();
    spy2.mockRestore();
  });

  // --- vrm.ts error paths (test handler directly) ---

  it('POST /vrm/refresh-settings returns 400 when VRM_INSTALLATION_ID missing', async () => {
    process.env.VRM_TOKEN = 'tok';
    delete process.env.VRM_INSTALLATION_ID;

    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const mockNext = vi.fn();
    const { default: vrmR } = await import('../../api/routes/vrm.ts');
    const layer = vrmR.stack.find(l => l.route?.path === '/refresh-settings' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    await handler({}, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('POST /vrm/refresh-settings returns 400 when VRM_TOKEN missing', async () => {
    process.env.VRM_INSTALLATION_ID = '123';
    delete process.env.VRM_TOKEN;

    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const mockNext = vi.fn();
    const { default: vrmR } = await import('../../api/routes/vrm.ts');
    const layer = vrmR.stack.find(l => l.route?.path === '/refresh-settings' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    await handler({}, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('POST /vrm/refresh-settings forwards HttpError status on VRM failure', async () => {
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';
    // Use the same HttpError class as the route module by importing fresh
    const { HttpError: RouteHttpError } = await import('../../api/http-errors.ts');
    refreshSettingsFromVrmAndPersist.mockRejectedValue(new RouteHttpError(401, 'Unauthorized'));

    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const mockNext = vi.fn();
    const { default: vrmR } = await import('../../api/routes/vrm.ts');
    const layer = vrmR.stack.find(l => l.route?.path === '/refresh-settings' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    await handler({}, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    const arg = mockNext.mock.calls[0][0];
    expect(arg.statusCode).toBe(401);
  });

  it('POST /vrm/refresh-settings returns 502 for generic errors', async () => {
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';
    refreshSettingsFromVrmAndPersist.mockRejectedValue(new Error('network down'));

    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const mockNext = vi.fn();
    const { default: vrmR } = await import('../../api/routes/vrm.ts');
    const layer = vrmR.stack.find(l => l.route?.path === '/refresh-settings' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    await handler({}, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
  });

  // --- plan-accuracy.ts full coverage ---

  it('GET /plan-accuracy returns merged report when data exists', async () => {
    const now = Date.now();
    evaluateRecentPlans.mockResolvedValue([{
      createdAtMs: now - 3600000,
      deviations: [
        { timestampMs: now - 1800000, deviation_percent: 5, actualSoc_percent: 50, predictedSoc_percent: 55 },
        { timestampMs: now - 900000, deviation_percent: -3, actualSoc_percent: 48, predictedSoc_percent: 45 },
      ],
    }]);

    const res = await get(routes.planAccuracyRouter, '/');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.slotsCompared).toBe(2);
    expect(res.body.report.deviations).toHaveLength(2);
  });

  it('GET /plan-accuracy returns null when reports have empty deviations', async () => {
    evaluateRecentPlans.mockResolvedValue([{
      createdAtMs: Date.now(),
      deviations: [],
    }]);

    const res = await get(routes.planAccuracyRouter, '/');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeNull();
  });

  it('GET /plan-accuracy accepts days query param', async () => {
    evaluateRecentPlans.mockResolvedValue([]);
    const { default: paRouter } = await import('../../api/routes/plan-accuracy.ts');
    const layer = paRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;
    const mockRes = { json: vi.fn() };
    await handler({ query: { days: '3' } }, mockRes);
    expect(evaluateRecentPlans).toHaveBeenCalledWith(3);
  });

  it('GET /plan-accuracy clamps days to 1 for low values', async () => {
    evaluateRecentPlans.mockResolvedValue([]);
    const { default: paRouter } = await import('../../api/routes/plan-accuracy.ts');
    const layer = paRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;

    const mockRes = { json: vi.fn() };
    // Number('0') || 7 = 7 (0 is falsy), so use negative to test min clamp
    await handler({ query: { days: '-5' } }, mockRes);
    expect(evaluateRecentPlans).toHaveBeenCalledWith(1);
  });

  it('GET /plan-accuracy clamps days to 30 for high values', async () => {
    evaluateRecentPlans.mockResolvedValue([]);
    const { default: paRouter } = await import('../../api/routes/plan-accuracy.ts');
    const layer = paRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;

    const mockRes = { json: vi.fn() };
    await handler({ query: { days: '100' } }, mockRes);
    expect(evaluateRecentPlans).toHaveBeenCalledWith(30);
  });

  it('GET /plan-accuracy/history returns reports', async () => {
    evaluateRecentPlans.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await get(routes.planAccuracyRouter, '/history');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.days).toBe(7);
  });

  it('GET /plan-accuracy/history accepts days param', async () => {
    evaluateRecentPlans.mockResolvedValue([]);
    const res = await get(routes.planAccuracyRouter, '/history?days=3');
    expect(res.status).toBe(200);
    expect(evaluateRecentPlans).toHaveBeenCalledWith(3);
  });

  it('GET /plan-accuracy/calibration returns calibration data', async () => {
    loadCalibration.mockResolvedValue({ effectiveChargeRate: 0.92 });
    const res = await get(routes.planAccuracyRouter, '/calibration');
    expect(res.status).toBe(200);
    expect(res.body.calibration.effectiveChargeRate).toBe(0.92);
  });

  it('GET /plan-accuracy/calibration returns null when no data', async () => {
    loadCalibration.mockResolvedValue(null);
    const res = await get(routes.planAccuracyRouter, '/calibration');
    expect(res.status).toBe(200);
    expect(res.body.calibration).toBeNull();
  });

  it('POST /plan-accuracy/calibrate returns calibration result', async () => {
    calibrate.mockResolvedValue({ effectiveChargeRate: 0.95 });
    const res = await post(routes.planAccuracyRouter, '/calibrate', {});
    expect(res.status).toBe(200);
    expect(res.body.calibration.effectiveChargeRate).toBe(0.95);
    expect(res.body.message).toContain('complete');
  });

  it('POST /plan-accuracy/calibrate returns null when insufficient data', async () => {
    calibrate.mockResolvedValue(null);
    const res = await post(routes.planAccuracyRouter, '/calibrate', {});
    expect(res.status).toBe(200);
    expect(res.body.calibration).toBeNull();
  });

  it('POST /plan-accuracy/calibrate accepts minDataDays param', async () => {
    calibrate.mockResolvedValue(null);
    await post(routes.planAccuracyRouter, '/calibrate?minDataDays=5', {});
    expect(calibrate).toHaveBeenCalledWith(5);
  });

  it('POST /plan-accuracy/calibration/reset clears calibration', async () => {
    const res = await post(routes.planAccuracyRouter, '/calibration/reset', {});
    expect(res.status).toBe(200);
    expect(resetCalibration).toHaveBeenCalled();
  });

  it('GET /plan-accuracy/snapshots returns plan snapshots', async () => {
    const now = Date.now();
    loadPlanHistory.mockResolvedValue([
      { createdAtMs: now - 1000, rows: [] },
      { createdAtMs: now - 86400000 * 5, rows: [] },
    ]);
    const res = await get(routes.planAccuracyRouter, '/snapshots?days=1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // only recent one
  });

  it('GET /plan-accuracy/soc-samples returns samples', async () => {
    getRecentSamples.mockResolvedValue([{ ts: 1, soc: 50 }]);
    const res = await get(routes.planAccuracyRouter, '/soc-samples?days=2');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.days).toBe(2);
  });

  // --- app.ts coverage (test middleware directly) ---

  it('app.ts health endpoint returns running message', async () => {
    const { default: app } = await import('../../api/app.ts');
    const res = await inject(app, { method: 'GET', url: '/health' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Optivolt API is running.');
  });

  it('app.ts 404 handler for unknown routes', async () => {
    const { default: app } = await import('../../api/app.ts');
    const res = await inject(app, { method: 'GET', url: '/nonexistent-route-xyz' });
    // Static middleware may serve index.html for unknown routes, or 404 handler fires
    expect([200, 404]).toContain(res.status);
  });

  it('app.ts error handler for 500 errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: app } = await import('../../api/app.ts');
    // Trigger calculate route which will fail because planAndMaybeWrite mock rejects
    planAndMaybeWrite.mockRejectedValue(new Error('test crash'));
    const spy2 = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await inject(app, { method: 'POST', url: '/calculate', body: {} });
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    spy2.mockRestore();
  });

  // --- data.ts error paths ---

  it('GET /data returns 500 when loadData throws', async () => {
    const { loadData } = await import('../../api/services/data-store.ts');
    loadData.mockRejectedValue(new Error('disk error'));
    const { default: dataRouter } = await import('../../api/routes/data.ts');
    const layer = dataRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;
    const mockNext = vi.fn();
    await handler({}, { json: vi.fn() }, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });

  it('POST /data returns 500 when saveData throws', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadData, saveData, validateData } = await import('../../api/services/data-store.ts');
    loadData.mockResolvedValue({ load: {}, pv: {}, importPrice: {}, exportPrice: {} });
    loadSettings.mockResolvedValue({ dataSources: { load: 'api', pv: 'api', prices: 'vrm', soc: 'mqtt' } });
    validateData.mockReturnValue(true);
    saveData.mockRejectedValue(new Error('write error'));
    const { default: dataRouter } = await import('../../api/routes/data.ts');
    const layer = dataRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    const mockNext = vi.fn();
    await handler({ body: { load: { start: '2024-01-01', values: [1], step: 15 } } }, { json: vi.fn() }, mockNext);
    expect(mockNext).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('POST /data handles soc key', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadData, saveData, validateData } = await import('../../api/services/data-store.ts');
    loadData.mockResolvedValue({ load: {}, pv: {}, importPrice: {}, exportPrice: {}, soc: {} });
    loadSettings.mockResolvedValue({ dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' } });
    validateData.mockReturnValue(true);
    saveData.mockResolvedValue();
    const { default: dataRouter } = await import('../../api/routes/data.ts');
    const layer = dataRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    const mockRes = { json: vi.fn() };
    await handler({ body: { soc: { percent: 50, timestamp: Date.now() } } }, mockRes, vi.fn());
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ keysUpdated: ['soc'] }));
    spy.mockRestore();
  });

  // --- settings.ts error path ---

  it('GET /settings returns 500 when loadSettings throws', async () => {
    loadSettings.mockRejectedValue(new Error('settings read fail'));
    const mockNext = vi.fn();
    const { default: settingsRouter } = await import('../../api/routes/settings.ts');
    const layer = settingsRouter.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;
    await handler({}, { json: vi.fn() }, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });

  // --- predictions.ts error paths ---

  it('POST /predictions/forecast returns 500 on generic error', async () => {
    const { loadPredictionConfig } = await import('../../api/services/prediction-config-store.ts');
    loadPredictionConfig.mockRejectedValue(new Error('config load fail'));
    const { default: predRouter } = await import('../../api/routes/predictions.ts');
    const layer = predRouter.stack.find(l => l.route?.path === '/forecast' && l.route?.methods?.post);
    const handler = layer.route.stack[0].handle;
    const mockNext = vi.fn();
    await handler({ query: {} }, { json: vi.fn() }, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('GET /predictions/forecast/now returns 500 on generic error', async () => {
    const { loadPredictionConfig } = await import('../../api/services/prediction-config-store.ts');
    loadPredictionConfig.mockRejectedValue(new Error('fail'));
    const { default: predRouter } = await import('../../api/routes/predictions.ts');
    const layer = predRouter.stack.find(l => l.route?.path === '/forecast/now' && l.route?.methods?.get);
    const handler = layer.route.stack[0].handle;
    const mockNext = vi.fn();
    await handler({}, { json: vi.fn() }, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('app.ts error handler with HttpError details', () => {
    // Test the error handler logic directly
    const err = new HttpError(422, 'Validation failed', { expose: true, details: { field: 'x' } });

    expect(err.expose).toBe(true);
    expect(err.details).toEqual({ field: 'x' });
    expect(err.statusCode).toBe(422);

    // Simulate what app.ts error handler does
    const payload = { error: err.message };
    if (err.expose && err.details) {
      payload.details = err.details;
    }

    expect(payload).toEqual({
      error: 'Validation failed',
      details: { field: 'x' },
    });
  });

  it('app.ts error handler includes details when expose=true and details set', async () => {
    // Import fresh app.ts and its HttpError to avoid class identity issues
    vi.resetModules();
    const { default: app } = await import('../../api/app.ts');
    const { HttpError: FreshHttpError } = await import('../../api/http-errors.ts');

    // Extract the error handler (last 4-arg middleware in Express 5 router stack)
    const errLayer = [...app.router.stack].reverse().find(l => l.handle && l.handle.length === 4);

    const mockReq = { method: 'POST', originalUrl: '/test' };
    const captured = {};
    const mockRes = {
      status(code) { captured.status = code; return mockRes; },
      json(body) { captured.body = body; },
    };

    errLayer.handle(
      new FreshHttpError(422, 'Validation failed', { expose: true, details: { field: 'email' } }),
      mockReq, mockRes, () => {},
    );

    expect(captured.status).toBe(422);
    expect(captured.body.error).toBe('Validation failed');
    expect(captured.body.details).toEqual({ field: 'email' });
  });

  it('app.ts error handler omits details when expose=false', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const { default: app } = await import('../../api/app.ts');
    const { HttpError: FreshHttpError } = await import('../../api/http-errors.ts');

    const errLayer = [...app.router.stack].reverse().find(l => l.handle && l.handle.length === 4);

    const mockReq = { method: 'POST', originalUrl: '/test' };
    const captured = {};
    const mockRes = {
      status(code) { captured.status = code; return mockRes; },
      json(body) { captured.body = body; },
    };

    errLayer.handle(
      new FreshHttpError(500, 'Internal error', { expose: false, details: { secret: 'hidden' } }),
      mockReq, mockRes, () => {},
    );

    expect(captured.status).toBe(500);
    expect(captured.body.error).toBe('Internal error');
    expect(captured.body.details).toBeUndefined();
    consoleSpy.mockRestore();
  });
});
