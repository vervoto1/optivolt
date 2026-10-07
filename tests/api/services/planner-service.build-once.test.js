import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The solver config is built exactly once per plan (getSolverInputs →
// buildPlannerConfig). With dataSources.soc = 'mqtt' (production) the planner
// used to rebuild it after the live SoC read from raw data, silently dropping
// the prediction adjustments, the adaptive-learning charge taper and the EV
// charge taper on every solve. These tests pin the build-once pipeline, the
// post-solve rebalance bookkeeping and the data.json patch semantics.

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/efficiency-calibrator.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadCalibration: vi.fn(), loadEvCalibration: vi.fn() };
});
vi.mock('../../../lib/dess-mapper.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mapRowsToDessV2: vi.fn(actual.mapRowsToDessV2) };
});
vi.mock('../../../lib/build-lp.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildLP: vi.fn(actual.buildLP) };
});

import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { readVictronSocPercent } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';
import { loadCalibration, loadEvCalibration } from '../../../api/services/efficiency-calibrator.ts';
import { mapRowsToDessV2 } from '../../../lib/dess-mapper.ts';
import { buildLP } from '../../../lib/build-lp.ts';
import { applyCalibration, buildSolverConfigFromSettings } from '../../../api/services/config-builder.ts';
import { createStoredPredictionAdjustment } from '../../../api/services/prediction-adjustment-store.ts';
import { computePlan, getLastEvPreview } from '../../../api/services/planner-service.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();
const MQTT_SOC = 11;

const baseSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 4000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 2,
  adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 7 },
};

const baseData = {
  load: { start: NOW_STRING, step: 60, values: [500, 500, 500, 500, 500] },
  pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
  importPrice: { start: NOW_STRING, step: 60, values: [10, 10, 10, 10, 10] },
  exportPrice: { start: NOW_STRING, step: 60, values: [5, 5, 5, 5, 5] },
  soc: { timestamp: NOW_STRING, value: 50 },
};

function makeCalibration(chargeRate = 0.7) {
  return {
    chargeCurve: new Array(100).fill(chargeRate),
    dischargeCurve: new Array(100).fill(0.9),
    chargeSamples: new Array(100).fill(10),
    dischargeSamples: new Array(100).fill(10),
    effectiveChargeRate: chargeRate,
    effectiveDischargeRate: 0.9,
    sampleCount: 100,
    confidence: 0.8,
    lastCalibratedMs: NOW_MS,
  };
}

function makeEvCalibration() {
  const evChargeCurve = new Array(100).fill(1.0);
  for (let i = 80; i < 100; i++) evChargeCurve[i] = 0.3; // strong taper near full
  return {
    evChargeCurve,
    evChargeSamples: new Array(100).fill(10),
    effectiveChargeRate: 1.0,
    sampleCount: 100,
    confidence: 0.8,
    lastCalibratedMs: NOW_MS,
  };
}

const evSettings = {
  evEnabled: true,
  evSource: 'native',
  evSocSensor: 'sensor.ev_soc',
  evPlugSensor: 'sensor.ev_plug',
  evChargePhases: 1,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 10,
  evTargetSoc_percent: 95,
  evChargeEfficiency_percent: 100,
  evDepartureTime: '2024-01-01T04:00:00Z',
  evStartTime: '',
  evMinSoc_percent: 0,
  evApplyPriceLimit: false,
  evOpportunisticEnabled: false,
  evChargeCurveEnabled: true,
};

function mockEv(plugState, soc = '40') {
  fetchHaEntityState.mockImplementation(async ({ entityId }) =>
    ({ state: entityId === 'sensor.ev_plug' ? plugState : soc }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_STRING));
  vi.clearAllMocks();
  saveSettings.mockResolvedValue();
  wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
  saveData.mockResolvedValue();
  wireUpdateData({ loadData, saveData, updateData });
  savePlanSnapshot.mockResolvedValue();
  readVictronSocPercent.mockResolvedValue(MQTT_SOC);
  loadCalibration.mockResolvedValue(makeCalibration());
  loadEvCalibration.mockResolvedValue(makeEvCalibration());
  fetchHaEntityState.mockReset();
  loadSettings.mockResolvedValue({ ...baseSettings });
  loadData.mockResolvedValue(structuredClone(baseData));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computePlan — soc=mqtt builds the solver config once', () => {
  it('keeps the adaptive-learning charge taper and seeds the live MQTT SoC', async () => {
    const result = await computePlan();

    const expected = applyCalibration(
      buildSolverConfigFromSettings(baseSettings, { ...baseData, soc: { timestamp: NOW_STRING, value: MQTT_SOC } }, NOW_MS),
      makeCalibration(),
    ).cvPhaseThresholds;
    expect(expected?.length).toBeGreaterThan(0);
    expect(result.cfg.cvPhaseThresholds).toEqual(expected);
    expect(result.cfg.initialSoc_percent).toBe(MQTT_SOC);
    expect(result.data.soc.value).toBe(MQTT_SOC);
    // Exactly one LP built for the main plan, from that config.
    expect(buildLP).toHaveBeenCalledTimes(1);
    expect(buildLP.mock.calls[0][0].cvPhaseThresholds).toEqual(expected);
  });

  it('persists only the live SoC as a patch of the current file', async () => {
    await computePlan();

    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith({
      ...baseData,
      soc: { timestamp: expect.any(String), value: MQTT_SOC },
    });
  });

  it('applies prediction adjustments to the solved load', async () => {
    loadData.mockResolvedValue({
      ...structuredClone(baseData),
      predictionAdjustments: [{
        id: 'load-add',
        series: 'load',
        mode: 'add',
        value_W: 700,
        start: NOW_STRING,
        end: '2024-01-01T02:00:00.000Z',
        createdAt: NOW_STRING,
        updatedAt: NOW_STRING,
      }],
    });

    const result = await computePlan();

    expect(result.cfg.load_W).toEqual([1200, 1200, 500, 500, 500]);
    expect(result.rows[0]).toMatchObject({ load: 1200, originalLoad: 500 });
  });

  it('gives a plugged-in EV the learned charge taper', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, ...evSettings });
    mockEv('connected');

    const result = await computePlan();

    expect(result.cfg.ev).toBeDefined();
    expect(result.cfg.ev.evInitialSoc_percent).toBe(40);
    expect(result.cfg.ev.evChargeThresholds?.length).toBeGreaterThan(0);
    expect(result.cfg.initialSoc_percent).toBe(MQTT_SOC);
  });

  it('reads the live SoC only for soc=mqtt', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, dataSources: { ...baseSettings.dataSources, soc: 'api' } });

    const result = await computePlan();

    expect(readVictronSocPercent).not.toHaveBeenCalled();
    expect(result.cfg.initialSoc_percent).toBe(50);
    expect(result.cfg.cvPhaseThresholds?.length).toBeGreaterThan(0);
    expect(saveData).not.toHaveBeenCalled();
  });

  it('writes nothing when the MQTT SoC read fails', async () => {
    readVictronSocPercent.mockRejectedValue(new Error('MQTT timeout'));

    await expect(computePlan()).rejects.toMatchObject({ statusCode: 503 });
    expect(saveData).not.toHaveBeenCalled();
    expect(buildLP).not.toHaveBeenCalled();
  });

  it('rejects with 503 when MQTT returns no SoC', async () => {
    readVictronSocPercent.mockResolvedValue(null);

    await expect(computePlan()).rejects.toThrow('Victron MQTT returned no battery SoC');
    expect(saveData).not.toHaveBeenCalled();
  });
});

describe('computePlan — data.json is patched, never overwritten with a stale snapshot', () => {
  it('a prediction adjustment created during the MQTT SoC read survives the plan (and is planned with)', async () => {
    // Stateful in-memory data.json behind the mocked store.
    let disk = structuredClone(baseData);
    loadData.mockImplementation(async () => structuredClone(disk));
    saveData.mockImplementation(async (d) => { disk = structuredClone(d); });

    readVictronSocPercent.mockImplementation(async () => {
      // A UI edit lands while the planner waits on Victron.
      await createStoredPredictionAdjustment({
        series: 'load',
        mode: 'add',
        value_W: 300,
        start: NOW_STRING,
        end: '2024-01-01T01:00:00.000Z',
      });
      return 55;
    });

    const result = await computePlan();

    expect(disk.predictionAdjustments).toHaveLength(1);
    expect(disk.soc.value).toBe(55);
    expect(result.cfg.load_W[0]).toBe(800);
    expect(result.cfg.initialSoc_percent).toBe(55);
  });

  it('a POST /data-style series write during the SoC read is kept', async () => {
    let disk = structuredClone(baseData);
    loadData.mockImplementation(async () => structuredClone(disk));
    saveData.mockImplementation(async (d) => { disk = structuredClone(d); });
    const newLoad = { start: NOW_STRING, step: 60, values: [900, 900, 900, 900, 900] };

    readVictronSocPercent.mockImplementation(async () => {
      await updateData(current => ({ ...current, load: newLoad }));
      return 60;
    });

    const result = await computePlan();

    expect(disk.load).toEqual(newLoad);
    expect(disk.soc.value).toBe(60);
    expect(result.cfg.load_W).toEqual(newLoad.values);
  });
});

describe('computePlan — rebalance bookkeeping runs post-solve', () => {
  const completedCycle = () => {
    // holdHours=2, 60-min slots → holdSlots=2; started 2h ago → remainingSlots=0
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 2 });
    loadData.mockResolvedValue({ ...structuredClone(baseData), rebalanceState: { startMs: NOW_MS - 2 * 3_600_000 } });
  };

  it('a completed cycle keeps the calibrated config and switches rebalancing off afterwards', async () => {
    completedCycle();

    const result = await computePlan();

    expect(result.cfg.rebalanceRemainingSlots).toBe(0);
    expect(result.cfg.cvPhaseThresholds?.length).toBeGreaterThan(0);
    expect(buildLP).toHaveBeenCalledTimes(1);
    expect(result.summary.rebalanceStatus).toBe('disabled');
    expect(result.rebalanceWindow).toBeUndefined();
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ rebalanceEnabled: false }));
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ rebalanceState: { startMs: null } }));
    expect(result.data.rebalanceState).toEqual({ startMs: null });
  });

  it('a completed cycle builds the same LP as rebalancing switched off', async () => {
    completedCycle();
    await computePlan();
    const completedLp = buildLP.mock.results[0].value;

    buildLP.mockClear();
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: false });
    loadData.mockResolvedValue({ ...structuredClone(baseData), rebalanceState: { startMs: null } });
    await computePlan();

    expect(buildLP.mock.results[0].value).toBe(completedLp);
  });

  it('a failure after the solve leaves settings and rebalance state untouched (completed cycle)', async () => {
    completedCycle();
    mapRowsToDessV2.mockImplementationOnce(() => { throw new Error('mapper boom'); });

    await expect(computePlan()).rejects.toThrow('mapper boom');
    expect(saveSettings).not.toHaveBeenCalled();
    // The live-SoC patch carries the existing marker through unchanged; nothing clears it.
    expect(saveData.mock.calls.every(([d]) => d.rebalanceState?.startMs === NOW_MS - 2 * 3_600_000)).toBe(true);
  });

  it('a failure after the solve does not stamp the hold start', async () => {
    readVictronSocPercent.mockResolvedValue(100);
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...structuredClone(baseData), rebalanceState: { startMs: null } });
    mapRowsToDessV2.mockImplementationOnce(() => { throw new Error('mapper boom'); });

    await expect(computePlan()).rejects.toThrow('mapper boom');
    expect(saveData.mock.calls.some(([d]) => d.rebalanceState?.startMs != null)).toBe(false);
  });

  it('stamps the hold start as a patch once the battery is at target', async () => {
    let disk = { ...structuredClone(baseData), rebalanceState: { startMs: null }, lastFullSocAt: null };
    loadData.mockImplementation(async () => structuredClone(disk));
    saveData.mockImplementation(async (d) => { disk = structuredClone(d); });
    readVictronSocPercent.mockResolvedValue(100);
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });

    const result = await computePlan();

    expect(disk.rebalanceState).toEqual({ startMs: NOW_MS });
    expect(disk.soc.value).toBe(100);
    expect(disk.lastFullSocAt).not.toBeNull(); // full-SoC observation recorded with the live SoC
    expect(result.data.rebalanceState).toEqual({ startMs: NOW_MS });
  });
});

describe('computePlan — EV preview uses the same config assembly', () => {
  it('the disconnected-car preview gets the learned EV taper', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, ...evSettings });
    mockEv('off', '55');

    const result = await computePlan();

    expect(result.cfg.ev).toBeUndefined();
    expect(buildLP).toHaveBeenCalledTimes(2);
    const previewCfg = buildLP.mock.calls[1][0];
    expect(previewCfg.ev?.evInitialSoc_percent).toBe(55);
    expect(previewCfg.ev?.evChargeThresholds?.length).toBeGreaterThan(0);
    expect(previewCfg.cvPhaseThresholds?.length).toBeGreaterThan(0);
    expect(getLastEvPreview()?.hasSchedule).toBe(true);
  });
});
