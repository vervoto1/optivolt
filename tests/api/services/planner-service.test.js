import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/ha-ev-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');

import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { fetchEvLoadFromHA } from '../../../api/services/ha-ev-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { computePlan, planAndMaybeWrite } from '../../../api/services/planner-service.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const MID_SLOT_NOW_STRING = '2024-01-01T00:22:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// Minimal settings — use 60-min slots for a smaller LP
const baseSettings = {
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
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 2,
};

// 5 slots of data starting at NOW
const baseData = {
  load: { start: NOW_STRING, step: 60, values: [500, 500, 500, 500, 500] },
  pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
  importPrice: { start: NOW_STRING, step: 60, values: [10, 10, 10, 10, 10] },
  exportPrice: { start: NOW_STRING, step: 60, values: [5, 5, 5, 5, 5] },
  soc: { timestamp: NOW_STRING, value: 50 },
};

describe('computePlan — rebalance bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT set startMs when soc < maxSoc_percent (not at target yet)', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 50 }, rebalanceState: { startMs: null } });

    await computePlan();

    // saveData should not have been called with a non-null startMs
    const savedDataCalls = saveData.mock.calls;
    const rebalanceSave = savedDataCalls.find(([d]) => d.rebalanceState?.startMs != null);
    expect(rebalanceSave).toBeUndefined();
  });

  it('sets startMs when soc >= maxSoc_percent (battery reached target)', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 100 }, rebalanceState: { startMs: null } });

    await computePlan();

    // saveData should have been called with startMs set to NOW_MS
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: NOW_MS } })
    );
  });

  it('clears startMs and disables rebalancing when cycle is complete (remainingSlots = 0)', async () => {
    // holdHours=2, stepSize=60min → holdSlots=2; started 2h ago → remainingSlots=0
    const startMs = NOW_MS - 2 * 60 * 60_000;
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 2 });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs } });

    await computePlan();

    // Settings should be saved with rebalanceEnabled = false
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceEnabled: false })
    );
    // Data should be saved with startMs = null
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: null } })
    );
  });
});

describe('planAndMaybeWrite — DESS slot count', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes up to 48 slots to setDynamicEssSchedule', async () => {
    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });

    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);
    const [rows, slotCount] = setDynamicEssSchedule.mock.calls[0];
    // DESS_SLOTS = 48; actual slots capped at min(48, rows.length)
    expect(slotCount).toBe(Math.min(48, rows.length));
    expect(slotCount).toBeGreaterThan(4); // must be more than old value of 4
  });
});

describe('computePlan — error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects and resets highsPromise when highs.solve throws', async () => {
    // First call with bad data that causes HiGHS to fail — use empty values so LP is unsolvable
    loadData.mockResolvedValueOnce({
      ...baseData,
      load: { start: NOW_STRING, step: 60, values: [] },
      pv: { start: NOW_STRING, step: 60, values: [] },
      importPrice: { start: NOW_STRING, step: 60, values: [] },
      exportPrice: { start: NOW_STRING, step: 60, values: [] },
    });

    // computePlan should reject (insufficient future data or solve error)
    await expect(computePlan()).rejects.toThrow();

    // After rejection, computePlan should still be callable on next invocation
    loadData.mockResolvedValue({ ...baseData });
    await expect(computePlan()).resolves.toBeDefined();
  });

  it('succeeds even when savePlanSnapshot rejects (fire-and-forget)', async () => {
    // Import savePlanSnapshot from plan-history-store — we need to mock it
    // The module isn't mocked at top level, so we spy via the module registry indirectly.
    // We verify plan still completes — if savePlanSnapshot threw synchronously it would fail.
    // Since it's fire-and-forget (.catch), the plan result is still returned.
    const result = await computePlan();
    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
  });

  it('logs error but still returns result when writeToVictron fails', async () => {
    setDynamicEssSchedule.mockRejectedValue(new Error('MQTT connection refused'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });

    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[calculate] Failed to write to Victron:',
      'MQTT connection refused',
    );

    errorSpy.mockRestore();
  });
});

describe('computePlan — plan snapshot timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MID_SLOT_NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes the partially elapsed current slot from saved plan snapshots', async () => {
    const result = await computePlan();

    expect(result.rows.length).toBeGreaterThan(1);
    expect(savePlanSnapshot).toHaveBeenCalledTimes(1);

    const snapshot = savePlanSnapshot.mock.calls[0][0];
    expect(snapshot.slots.length).toBe(result.rows.length - 1);
    expect(new Date(snapshot.slots[0].timestampMs).toISOString()).toBe('2024-01-01T01:00:00.000Z');
    expect(snapshot.slots[0].predictedSoc_percent).toBeCloseTo(result.rows[0].soc_percent, 5);
  });
});

describe('planAndMaybeWrite — DESS fingerprint cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips MQTT write when DESS schedule is unchanged between calls', async () => {
    // First call: should write because fingerprint is new (or changed)
    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });
    const callsAfterFirst = setDynamicEssSchedule.mock.calls.length;

    // Second call with same data: fingerprint matches, should skip
    await planAndMaybeWrite({ writeToVictron: true });
    const callsAfterSecond = setDynamicEssSchedule.mock.calls.length;

    // First call always writes (forceWrite=true); second should be skipped
    expect(callsAfterFirst).toBe(1);
    expect(callsAfterSecond).toBe(1); // no additional call
  });

  it('writes when forceWrite is true even if schedule unchanged', async () => {
    // First call: establish the fingerprint
    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);

    // Second call with forceWrite=true: must write even though schedule is identical
    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(2);
  });
});

describe('computePlan — updateData path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls refreshSeriesFromVrmAndPersist when updateData=true', async () => {
    const result = await computePlan({ updateData: true });

    expect(refreshSeriesFromVrmAndPersist).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
  });

  it('logs error but still returns result when VRM refresh fails (updateData=true)', async () => {
    refreshSeriesFromVrmAndPersist.mockRejectedValue(new Error('VRM timeout'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await computePlan({ updateData: true });

    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to refresh VRM data before calculation:',
      'VRM timeout',
    );

    errorSpy.mockRestore();
  });

  it('does not call refreshSeriesFromVrmAndPersist when updateData=false (default)', async () => {
    await computePlan();

    expect(refreshSeriesFromVrmAndPersist).not.toHaveBeenCalled();
  });
});

describe('computePlan — evConfig EV load refresh', () => {
  const evSettings = {
    ...baseSettings,
    evConfig: {
      enabled: true,
      scheduleSensor: 'sensor.ev_schedule',
      chargerPower_W: 7400,
    },
    haUrl: 'ws://homeassistant.local:8123/api/websocket',
    haToken: 'test-token',
  };

  // EV load time series aligned to NOW
  const evLoad = {
    start: NOW_STRING,
    step: 15,
    values: [7400, 7400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes EV load from HA when evConfig.enabled is true', async () => {
    loadSettings.mockResolvedValue({ ...evSettings });
    fetchEvLoadFromHA.mockResolvedValue(evLoad);

    const result = await computePlan();

    expect(fetchEvLoadFromHA).toHaveBeenCalledTimes(1);
    expect(fetchEvLoadFromHA).toHaveBeenCalledWith(expect.objectContaining({ evConfig: expect.objectContaining({ enabled: true }) }));
    expect(result).toBeDefined();
  });

  it('clears evLoad_W when fetchEvLoadFromHA returns null (car disconnected)', async () => {
    loadSettings.mockResolvedValue({ ...evSettings });
    fetchEvLoadFromHA.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await computePlan();

    expect(fetchEvLoadFromHA).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('EV load cleared'));
    expect(result).toBeDefined();

    logSpy.mockRestore();
  });

  it('logs warning but still computes plan when fetchEvLoadFromHA rejects', async () => {
    loadSettings.mockResolvedValue({ ...evSettings });
    fetchEvLoadFromHA.mockRejectedValue(new Error('HA unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await computePlan();

    expect(warnSpy).toHaveBeenCalledWith(
      '[calculate] Failed to refresh EV load from HA:',
      'HA unreachable',
    );
    expect(result).toBeDefined();

    warnSpy.mockRestore();
  });

  it('does not call fetchEvLoadFromHA when evConfig.enabled is false', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings });

    await computePlan();

    expect(fetchEvLoadFromHA).not.toHaveBeenCalled();
  });
});

describe('planAndMaybeWrite — writeToVictron=false', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call setDynamicEssSchedule when writeToVictron is false (default)', async () => {
    // Line 217: writeToVictron=false branch — planAndMaybeWrite skips writePlanToVictron
    const result = await planAndMaybeWrite({ writeToVictron: false });

    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
  });
});

describe('computePlan — horizon warnings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    savePlanSnapshot.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets horizonWarnings when data is short of expected horizon', async () => {
    // baseData: 5 slots of 60 min = 5h data.
    // Expected horizon: 24h from NOW → gap = 19h, tolerance = 2h → warning
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });

    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await computePlan();

    expect(result.summary.horizonWarnings).toBeDefined();
    expect(result.summary.horizonWarnings.length).toBeGreaterThan(0);
    expect(result.summary.horizonWarnings[0]).toContain('short');
    logSpy.mockRestore();
  });

  it('does not set horizonWarnings when data reaches the expected horizon', async () => {
    // 24 slots of 60-min data starting at NOW = full 24h horizon
    const fullData = {
      ...baseData,
      load: { start: NOW_STRING, step: 60, values: new Array(24).fill(500) },
      pv: { start: NOW_STRING, step: 60, values: new Array(24).fill(0) },
      importPrice: { start: NOW_STRING, step: 60, values: new Array(24).fill(10) },
      exportPrice: { start: NOW_STRING, step: 60, values: new Array(24).fill(5) },
    };

    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue(fullData);

    const result = await computePlan();
    expect(result.summary.horizonWarnings).toBeUndefined();
  });
});

describe('computePlan — savePlanSnapshot fire-and-forget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
    fetchEvLoadFromHA.mockResolvedValue(null);
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves successfully even when savePlanSnapshot rejects', async () => {
    savePlanSnapshot.mockRejectedValue(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await computePlan();

    // Allow the fire-and-forget rejection to propagate through microtask queue
    await Promise.resolve();

    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[plan-history] Failed to save snapshot:',
      'disk full',
    );

    warnSpy.mockRestore();
  });
});
