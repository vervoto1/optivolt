import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

// Mock dependencies
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/mqtt-service.ts');
vi.mock('../../api/services/plan-history-store.ts');
vi.mock('../../api/services/soc-tracker.ts');
vi.mock('../../api/services/efficiency-calibrator.ts');
vi.mock('../../api/services/plan-accuracy-service.ts');
vi.mock('../../api/services/auto-calculate.ts');
vi.mock('../../api/services/dess-price-refresh.ts');
vi.mock('../../api/services/planner-service.ts');

import { loadSettings, saveSettings } from '../../api/services/settings-store.ts';
import { loadData } from '../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist, refreshSettingsFromVrmAndPersist } from '../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../api/services/mqtt-service.ts';
import { getLatestSnapshot, getRecentSnapshots, loadPlanHistory, savePlanSnapshot, clearPlanHistory } from '../../api/services/plan-history-store.ts';
import { loadSocSamples, getRecentSamples, clearSocSamples } from '../../api/services/soc-tracker.ts';
import { loadCalibration, calibrate, resetCalibration } from '../../api/services/efficiency-calibrator.ts';
import { evaluateLatestPlan, evaluateRecentPlans } from '../../api/services/plan-accuracy-service.ts';
import { startAutoCalculate, stopAutoCalculate } from '../../api/services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../../api/services/dess-price-refresh.ts';
import { planAndMaybeWrite } from '../../api/services/planner-service.ts';

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
  terminalSocValuation: "zero",
  terminalSocCustomPrice_cents_per_kWh: 0
};

const mockData = {
  // 5 hours of data
  load: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [500, 500, 500, 500, 500]
  },
  pv: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [0, 0, 0, 0, 0]
  },
  importPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [10, 10, 10, 10, 10]
  },
  exportPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [5, 5, 5, 5, 5]
  },
  soc: {
    timestamp: "2024-01-01T00:00:00.000Z",
    value: 20
  },
  // Legacy field for safety during transition, though not used by new logic
  initialSoc_percent: 20
};

describe('Integration: API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    vi.resetAllMocks();
    loadSettings.mockResolvedValue({ ...mockSettings });
    loadData.mockResolvedValue({ ...mockData });
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    refreshSettingsFromVrmAndPersist.mockResolvedValue({ batteryCapacity_Wh: 10000 });
    setDynamicEssSchedule.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    saveSettings.mockResolvedValue();
    planAndMaybeWrite.mockResolvedValue({
      cfg: { initialSoc_percent: 20 },
      timing: { startMs: new Date('2024-01-01T00:00:00.000Z').getTime() },
      result: { Status: 'Optimal', ObjectiveValue: 0 },
      rows: [1, 2, 3, 4, 5],
      summary: {},
      rebalanceWindow: null,
    });
    startAutoCalculate.mockReturnValue();
    stopAutoCalculate.mockReturnValue();
    startDessPriceRefresh.mockReturnValue();
    stopDessPriceRefresh.mockReturnValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Optivolt API is running.' });
  });

  it('GET /settings returns merged settings', async () => {
    // We mocked loadSettings to return mockSettings
    // But endpoint merges with defaults. Since mockSettings covers most, it should appear.
    const res = await request(app).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stepSize_m: 60 });
  });

  it('POST /calculate runs the solver', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.solverStatus).toBe('Optimal');
    expect(res.body.rows).toHaveLength(5);
    expect(planAndMaybeWrite).toHaveBeenCalled();
  });

  it('POST /calculate with updateData calls VRM refresh', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ updateData: true });

    expect(res.status).toBe(200);
    expect(planAndMaybeWrite).toHaveBeenCalledWith(expect.objectContaining({ updateData: true }));
  });

  it('POST /calculate with writeToVictron calls MQTT service', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ writeToVictron: true });

    expect(res.status).toBe(200);
    expect(planAndMaybeWrite).toHaveBeenCalledWith(expect.objectContaining({ writeToVictron: true }));
  });

  it('POST /calculate returns 500 when solver fails', async () => {
    vi.useRealTimers();
    planAndMaybeWrite.mockRejectedValueOnce(new Error('HiGHS solver crashed'));

    const res = await request(app).post('/calculate').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to calculate plan/);
  });

  it('GET /settings returns 500 when loadSettings fails', async () => {
    loadSettings.mockRejectedValueOnce(new Error('File read error'));

    const res = await request(app).get('/settings');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to read settings/);
  });

  it('POST /settings returns 500 when saveSettings fails', async () => {
    vi.useRealTimers();
    saveSettings.mockRejectedValueOnce(new Error('File write error'));

    const res = await request(app).post('/settings').send({ stepSize_m: 30 });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to save settings/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nonexistent-route-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns correct status for unknown HTTP error codes', async () => {
    vi.useRealTimers();
    const { HttpError } = await import('../../api/http-errors.ts');
    planAndMaybeWrite.mockRejectedValueOnce(new HttpError(418, undefined));

    const res = await request(app).post('/calculate').send({});
    expect(res.status).toBe(418);
    expect(res.body.error).toBe('HTTP Error');
  });

  it('includes error details when expose is true and details are set', async () => {
    vi.useRealTimers();
    const { HttpError } = await import('../../api/http-errors.ts');
    planAndMaybeWrite.mockRejectedValueOnce(
      new HttpError(422, 'Validation failed', { expose: true, details: { field: 'batteryCapacity' } }),
    );

    const res = await request(app).post('/calculate').send({});
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'batteryCapacity' });
  });
});

describe('Integration: Plan Accuracy API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getLatestSnapshot.mockResolvedValue(null);
    getRecentSnapshots.mockResolvedValue([]);
    loadPlanHistory.mockResolvedValue([]);
    loadSocSamples.mockResolvedValue([]);
    getRecentSamples.mockResolvedValue([]);
    loadCalibration.mockResolvedValue(null);
    savePlanSnapshot.mockResolvedValue();
    evaluateLatestPlan.mockResolvedValue(null);
    evaluateRecentPlans.mockResolvedValue([]);
    clearPlanHistory.mockResolvedValue();
    clearSocSamples.mockResolvedValue();
    resetCalibration.mockResolvedValue();
  });

  it('GET /plan-accuracy returns message when no data', async () => {
    const res = await request(app).get('/plan-accuracy');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeNull();
  });

  it('GET /plan-accuracy returns null when reports exist but all deviations are empty', async () => {
    evaluateRecentPlans.mockResolvedValue([
      {
        planId: 'plan-1',
        createdAtMs: Date.now() - 60_000,
        evaluatedAtMs: Date.now(),
        slotsCompared: 0,
        meanDeviation_percent: 0,
        maxDeviation_percent: 0,
        deviations: [],
      },
    ]);

    const res = await request(app).get('/plan-accuracy');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeNull();
  });

  it('GET /plan-accuracy/calibration returns message when no calibration', async () => {
    const res = await request(app).get('/plan-accuracy/calibration');
    expect(res.status).toBe(200);
    expect(res.body.calibration).toBeNull();
  });

  it('GET /plan-accuracy/calibration returns calibration when available', async () => {
    loadCalibration.mockResolvedValue({
      effectiveChargeRate: 0.82,
      effectiveDischargeRate: 0.95,
      sampleCount: 150,
      confidence: 0.75,
      lastCalibratedMs: Date.now(),
    });

    const res = await request(app).get('/plan-accuracy/calibration');
    expect(res.status).toBe(200);
    expect(res.body.calibration.effectiveChargeRate).toBe(0.82);
    expect(res.body.calibration.confidence).toBe(0.75);
  });

  it('GET /plan-accuracy/history returns empty array when no data', async () => {
    const res = await request(app).get('/plan-accuracy/history?days=7');
    expect(res.status).toBe(200);
    expect(res.body.reports).toEqual([]);
    expect(res.body.days).toBe(7);
  });

  it('GET /plan-accuracy/soc-samples returns samples', async () => {
    getRecentSamples.mockResolvedValue([
      { timestampMs: 1000, soc_percent: 65 },
    ]);

    const res = await request(app).get('/plan-accuracy/soc-samples?days=1');
    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.samples[0].soc_percent).toBe(65);
  });

  it('POST /plan-accuracy/calibrate returns result when calibration succeeds', async () => {
    calibrate.mockResolvedValue({
      effectiveChargeRate: 0.82,
      effectiveDischargeRate: 0.95,
      sampleCount: 50,
      confidence: 0.75,
      lastCalibratedMs: Date.now(),
      chargeCurve: new Array(100).fill(0.82),
      dischargeCurve: new Array(100).fill(0.95),
    });

    const res = await request(app).post('/plan-accuracy/calibrate');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Calibration complete');
    expect(res.body.calibration.effectiveChargeRate).toBe(0.82);
  });

  it('POST /plan-accuracy/calibrate returns null message when insufficient data', async () => {
    calibrate.mockResolvedValue(null);

    const res = await request(app).post('/plan-accuracy/calibrate');
    expect(res.status).toBe(200);
    expect(res.body.calibration).toBeNull();
    expect(res.body.message).toMatch(/insufficient data/i);
  });

  it('GET /plan-accuracy returns merged deviations from all recent plans', async () => {
    const now = Date.now();
    evaluateRecentPlans.mockResolvedValue([
      {
        planId: 'plan-1',
        createdAtMs: now - 60_000,
        evaluatedAtMs: now,
        slotsCompared: 2,
        meanDeviation_percent: 2,
        maxDeviation_percent: 3,
        deviations: [
          { timestampMs: 1000, predictedSoc_percent: 50, actualSoc_percent: 48, deviation_percent: -2 },
          { timestampMs: 2000, predictedSoc_percent: 55, actualSoc_percent: 52, deviation_percent: -3 },
        ],
      },
      {
        planId: 'plan-2',
        createdAtMs: now - 30_000,
        evaluatedAtMs: now,
        slotsCompared: 1,
        meanDeviation_percent: 1,
        maxDeviation_percent: 1,
        deviations: [
          { timestampMs: 3000, predictedSoc_percent: 60, actualSoc_percent: 59, deviation_percent: -1 },
        ],
      },
    ]);

    const res = await request(app).get('/plan-accuracy');
    expect(res.status).toBe(200);
    expect(res.body.report.slotsCompared).toBe(3);
    expect(res.body.report.deviations).toHaveLength(3);
  });

  it('GET /plan-accuracy/snapshots filters by days', async () => {
    const now = Date.now();
    loadPlanHistory.mockResolvedValue([
      { planId: 'old', createdAtMs: now - 5 * 24 * 60 * 60_000, slots: [] },
      { planId: 'recent', createdAtMs: now - 1000, slots: [] },
    ]);

    const res = await request(app).get('/plan-accuracy/snapshots?days=1');
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].planId).toBe('recent');
  });

  it('POST /plan-accuracy/reset-all clears all adaptive learning data', async () => {
    const res = await request(app).post('/plan-accuracy/reset-all');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/cleared/i);
    expect(resetCalibration).toHaveBeenCalled();
    expect(clearPlanHistory).toHaveBeenCalled();
    expect(clearSocSamples).toHaveBeenCalled();
  });

  it('POST /plan-accuracy/calibration/reset clears calibration data', async () => {
    const { resetCalibration } = await import('../../api/services/efficiency-calibrator.ts');
    resetCalibration.mockResolvedValue();

    const res = await request(app).post('/plan-accuracy/calibration/reset');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset/i);
  });

  it('GET /plan-accuracy/snapshots returns snapshots array', async () => {
    const now = Date.now();
    loadPlanHistory.mockResolvedValue([
      { planId: 'plan-1', createdAtMs: now - 1000, slots: [] },
    ]);

    const res = await request(app).get('/plan-accuracy/snapshots?days=1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.snapshots)).toBe(true);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].planId).toBe('plan-1');
  });
});

describe('Integration: Calculate API — branch coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    vi.resetAllMocks();
    loadSettings.mockResolvedValue({});
    loadData.mockResolvedValue({});
    planAndMaybeWrite.mockResolvedValue({
      cfg: { initialSoc_percent: 20 },
      timing: { startMs: new Date('2024-01-01T00:00:00.000Z').getTime() },
      result: { Status: 'Optimal', ObjectiveValue: 0 },
      rows: [],
      summary: {},
      rebalanceWindow: null,
    });
    startAutoCalculate.mockReturnValue();
    stopAutoCalculate.mockReturnValue();
    startDessPriceRefresh.mockReturnValue();
    stopDessPriceRefresh.mockReturnValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POST /calculate with null body still works (line 10: req.body ?? {})', async () => {
    // Express with json() middleware provides req.body={} on empty body,
    // but we verify the null-coalesce path by ensuring it doesn't crash
    const res = await request(app)
      .post('/calculate')
      .set('Content-Type', 'application/json')
      .send();
    expect(res.status).toBe(200);
  });

  it('POST /calculate logs non-Error thrown object (line 50: error instanceof Error ? ... : undefined)', async () => {
    vi.useRealTimers();
    planAndMaybeWrite.mockRejectedValueOnce('plain string error');
    const res = await request(app).post('/calculate').send({});
    // non-Error is wrapped by toHttpError → 500
    expect(res.status).toBe(500);
  });
});

describe('Integration: Settings API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    vi.resetAllMocks();
    loadSettings.mockResolvedValue({ ...mockSettings });
    saveSettings.mockResolvedValue();
    startAutoCalculate.mockReturnValue();
    stopAutoCalculate.mockReturnValue();
    startDessPriceRefresh.mockReturnValue();
    stopDessPriceRefresh.mockReturnValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POST /settings rejects array payload with 400 (line 21: assertCondition array check)', async () => {
    vi.useRealTimers();
    const res = await request(app)
      .post('/settings')
      .send([{ stepSize_m: 30 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/settings payload must be an object/);
  });

  it('POST /settings saves and returns merged settings', async () => {
    const patch = { batteryCost_cent_per_kWh: 5 };

    const res = await request(app).post('/settings').send(patch);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Settings saved successfully.');
    expect(res.body.settings.batteryCost_cent_per_kWh).toBe(5);
    expect(saveSettings).toHaveBeenCalled();
  });

  it('POST /settings restarts auto-calculate with merged settings', async () => {
    const patch = { idleDrain_W: 10 };

    await request(app).post('/settings').send(patch);
    expect(stopAutoCalculate).toHaveBeenCalled();
    expect(startAutoCalculate).toHaveBeenCalled();
  });
});

describe('Integration: VRM API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refreshSettingsFromVrmAndPersist.mockResolvedValue({ batteryCapacity_Wh: 10000 });
  });

  it('POST /vrm/refresh-settings returns 400 when VRM env vars are missing', async () => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;

    const res = await request(app).post('/vrm/refresh-settings');
    expect(res.status).toBe(400);
  });

  it('POST /vrm/refresh-settings calls VRM refresh when env vars are set', async () => {
    process.env.VRM_INSTALLATION_ID = 'site-123';
    process.env.VRM_TOKEN = 'tok-abc';

    const res = await request(app).post('/vrm/refresh-settings');
    expect(res.status).toBe(200);
    expect(refreshSettingsFromVrmAndPersist).toHaveBeenCalled();
    expect(res.body.message).toMatch(/updated from VRM/i);

    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });
});
