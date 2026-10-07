import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { post } from '../helpers/express-test-client.js';

// Real calculate route -> planner-service -> config-builder; only persistence and
// hardware I/O are mocked, so the guard is exercised end to end.
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');

import calculateRouter from '../../../api/routes/calculate.ts';
import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';

const NOW_STRING = '2024-01-01T12:00:00Z';

const settings = {
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
  dataSources: { load: 'api', pv: 'api', prices: 'api', soc: 'api' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 0,
};

const series = (start, values) => ({ start, step: 60, values });

function makeData(overrides = {}) {
  return {
    load: series(NOW_STRING, [500, 500, 500, 500]),
    pv: series(NOW_STRING, [0, 0, 0, 0]),
    importPrice: series(NOW_STRING, [30, 30, 30, 30]),
    exportPrice: series(NOW_STRING, [5, 5, 5, 5]),
    soc: { timestamp: NOW_STRING, value: 50 },
    ...overrides,
  };
}

describe('POST /calculate — series start coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    loadSettings.mockResolvedValue(structuredClone(settings));
    saveSettings.mockResolvedValue();
    wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
    wireUpdateData({ loadData, saveData, updateData });
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['load', 'importPrice', 'exportPrice'])(
    'returns 422 and writes nothing when %s starts after the plan window',
    async (key) => {
      // Starts at 13:00, an hour after the 12:00 plan start: extractWindow would
      // have zero-padded 12:00 (0 W load or 0 c/kWh) and that slot is written first.
      loadData.mockResolvedValue(makeData({ [key]: series('2024-01-01T13:00:00Z', [30, 30, 30]) }));

      const res = await post(calculateRouter, '/', { writeToVictron: true });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe(`Series '${key}' starts after the plan window begins`);
      expect(res.body.details).toEqual({
        now: '2024-01-01T12:00:00.000Z',
        seriesStart: '2024-01-01T13:00:00.000Z',
      });
      expect(setDynamicEssSchedule).not.toHaveBeenCalled();
    },
  );

  it('solves and writes when every series covers the plan start (PV may start later)', async () => {
    loadData.mockResolvedValue(makeData({ pv: series('2024-01-01T13:00:00Z', [100, 100, 100]) }));

    const res = await post(calculateRouter, '/', { writeToVictron: true });

    expect(res.status).toBe(200);
    expect(res.body.solverStatus).toBe('Optimal');
    expect(res.body.tsStart).toBe('2024-01-01T12:00:00.000Z');
    await vi.waitFor(() => expect(setDynamicEssSchedule).toHaveBeenCalled());
  });
});
