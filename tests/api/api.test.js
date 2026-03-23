import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, post } from './helpers/express-test-client.js';

vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/plan-history-store.ts');
vi.mock('../../api/services/soc-tracker.ts');
vi.mock('../../api/services/efficiency-calibrator.ts');
vi.mock('../../api/services/plan-accuracy-service.ts');
vi.mock('../../api/services/auto-calculate.ts');
vi.mock('../../api/services/dess-price-refresh.ts');
vi.mock('../../api/services/planner-service.ts');

import { loadSettings, saveSettings } from '../../api/services/settings-store.ts';
import { refreshSettingsFromVrmAndPersist } from '../../api/services/vrm-refresh.ts';
import { loadPlanHistory, clearPlanHistory } from '../../api/services/plan-history-store.ts';
import { getRecentSamples, clearSocSamples } from '../../api/services/soc-tracker.ts';
import { loadCalibration, calibrate, resetCalibration } from '../../api/services/efficiency-calibrator.ts';
import { evaluateRecentPlans } from '../../api/services/plan-accuracy-service.ts';
import { startAutoCalculate, stopAutoCalculate } from '../../api/services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../../api/services/dess-price-refresh.ts';
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
});
