import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, post } from '../helpers/express-test-client.js';

// Real calculate route -> planner-service -> HiGHS; only persistence and
// hardware I/O are mocked. Tests can merge extra HiGHS options into what
// lib/solve-options.ts returns (objective_target 1e12 = early stop with an
// incumbent).
const solverCtl = vi.hoisted(() => ({ extraOptions: {} }));

vi.mock('../../../lib/solve-options.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    solveOptionsFor: (cfg) => ({ ...actual.solveOptionsFor(cfg), ...solverCtl.extraOptions }),
  };
});

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/pv-curtailment.ts');

import calculateRouter from '../../../api/routes/calculate.ts';
import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const SLOTS = 48;

// A pending 1 h rebalance window: with its binaries, objective_target 1e12
// stops on the first incumbent instead of proving optimality.
const settings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 20000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'api', pv: 'api', prices: 'api', soc: 'api' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: true,
  rebalanceHoldHours: 1,
};

// Native EV mode with the car unplugged: an Optimal solve also caches an EV
// preview (the schedule as it would be if plugged in now).
const evPreviewSettings = {
  ...settings,
  evEnabled: true,
  evSource: 'native',
  evSocSensor: 'sensor.ev_soc',
  evPlugSensor: 'binary_sensor.ev_plug',
  evChargePhases: 1,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 10,
  evTargetSoc_percent: 80,
  evChargeEfficiency_percent: 100,
  evDepartureTime: '2024-01-01T04:00:00Z',
  evStartTime: '',
  evMinSoc_percent: 0,
  evApplyPriceLimit: false,
  evOpportunisticEnabled: false,
};

// No grid import and no battery discharge: the hard load balance cannot be met.
const infeasibleSettings = { ...settings, maxGridImport_W: 0, maxDischargePower_W: 0 };

const series = (values) => ({ start: NOW_STRING, step: 15, values });
const data = {
  load: series(Array(SLOTS).fill(800)),
  pv: series(Array.from({ length: SLOTS }, (_, t) => (t > 16 && t < 36 ? 5000 : 0))),
  importPrice: series(Array.from({ length: SLOTS }, (_, t) => 20 + 15 * Math.sin(t / 7))),
  exportPrice: series(Array.from({ length: SLOTS }, (_, t) => 8 + 15 * Math.sin(t / 7))),
  soc: { timestamp: NOW_STRING, value: 50 },
  rebalanceState: { startMs: null },
};

describe('POST /calculate — solver status', () => {
  beforeEach(() => {
    // Only fake Date: faking setImmediate would deadlock Express's error
    // middleware, which the 502/503 paths go through.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    solverCtl.extraOptions = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    loadSettings.mockResolvedValue(structuredClone(settings));
    saveSettings.mockResolvedValue();
    wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
    loadData.mockResolvedValue(structuredClone(data));
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedOptimalPlan() {
    const res = await post(calculateRouter, '/', {});
    expect(res.status).toBe(200);
    expect(res.body.solverStatus).toBe('Optimal');
    return res.body;
  }

  it('returns 502 naming the status for an infeasible solve; /calculate/last keeps serving the previous plan', async () => {
    const previous = await seedOptimalPlan();
    loadSettings.mockResolvedValue(structuredClone(infeasibleSettings));

    const res = await post(calculateRouter, '/', { writeToVictron: true });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Solver produced no usable solution: status is "Infeasible"');
    expect(res.body.details).toEqual({ solverStatus: 'Infeasible' });
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();

    const last = await get(calculateRouter, '/last');
    expect(last.status).toBe(200);
    expect(last.body.solverStatus).toBe('Optimal');
    expect(last.body.computedAtMs).toBe(previous.computedAtMs);
    expect(last.body.objectiveValue).toBe(previous.objectiveValue);
  });

  it('shows an early-stop incumbent for display, but /calculate/last keeps the previous plan and nothing is written', async () => {
    const previous = await seedOptimalPlan();
    vi.setSystemTime(new Date(Date.parse(NOW_STRING) + 60_000));
    solverCtl.extraOptions = { objective_target: 1e12 };

    const shown = await post(calculateRouter, '/', {});
    expect(shown.status).toBe(200);
    expect(shown.body.solverStatus).toBe('Target for objective reached');
    expect(shown.body.rows).toHaveLength(SLOTS);

    const refused = await post(calculateRouter, '/', { writeToVictron: true });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatch(/Refusing to write schedule to Victron/);
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();

    const last = await get(calculateRouter, '/last');
    expect(last.status).toBe(200);
    expect(last.body.solverStatus).toBe('Optimal');
    expect(last.body.computedAtMs).toBe(previous.computedAtMs);
  });

  it('does not pair an early-stop incumbent with the previous plan\'s EV preview', async () => {
    // Car disconnected; the SoC sensor still reads.
    fetchHaEntityState.mockImplementation(async ({ entityId }) =>
      entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
    loadSettings.mockResolvedValue(structuredClone(evPreviewSettings));
    const previous = await seedOptimalPlan();
    expect(previous.evPreview?.hasSchedule).toBe(true);

    vi.setSystemTime(new Date(Date.parse(NOW_STRING) + 60_000));
    solverCtl.extraOptions = { objective_target: 1e12 };

    const shown = await post(calculateRouter, '/', {});
    expect(shown.status).toBe(200);
    expect(shown.body.solverStatus).toBe('Target for objective reached');
    expect(shown.body.rows).toHaveLength(SLOTS);
    expect(shown.body.evPreview).toBeNull();

    // The cached Optimal plan still carries its own preview.
    const last = await get(calculateRouter, '/last');
    expect(last.status).toBe(200);
    expect(last.body.computedAtMs).toBe(previous.computedAtMs);
    expect(last.body.evPreview).toEqual(previous.evPreview);
  });
});
