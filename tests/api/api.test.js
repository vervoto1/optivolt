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

import { loadSettings } from '../../api/services/settings-store.ts';
import { loadData } from '../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../api/services/mqtt-service.ts';
import { getLatestSnapshot, getRecentSnapshots, loadPlanHistory, savePlanSnapshot } from '../../api/services/plan-history-store.ts';
import { loadSocSamples, getRecentSamples } from '../../api/services/soc-tracker.ts';
import { loadCalibration } from '../../api/services/efficiency-calibrator.ts';

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
    setDynamicEssSchedule.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
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
    expect(loadSettings).toHaveBeenCalled();
    expect(loadData).toHaveBeenCalled();
  });

  it('POST /calculate with updateData calls VRM refresh', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ updateData: true });

    expect(res.status).toBe(200);
    expect(refreshSeriesFromVrmAndPersist).toHaveBeenCalled();
  });

  it('POST /calculate with writeToVictron calls MQTT service', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ writeToVictron: true });

    expect(res.status).toBe(200);
    expect(setDynamicEssSchedule).toHaveBeenCalled();
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
  });

  it('GET /plan-accuracy returns message when no data', async () => {
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
});
