import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies BEFORE importing auto-calculate
vi.mock('../../../api/services/planner-service.ts', () => ({
  planAndMaybeWrite: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn().mockResolvedValue({ adaptiveLearning: { enabled: false } }),
}));
vi.mock('../../../api/services/soc-tracker.ts', () => ({
  sampleAndStoreSoc: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../api/services/efficiency-calibrator.ts', () => ({
  calibrate: vi.fn().mockResolvedValue(null),
}));

const { startAutoCalculate, stopAutoCalculate, isAutoCalculateRunning } = await import(
  '../../../api/services/auto-calculate.ts'
);
const { planAndMaybeWrite } = await import('../../../api/services/planner-service.ts');

/** Build a minimal Settings object with the given autoCalculate config. */
function makeSettings(autoCalculate) {
  return /** @type {any} */ ({
    stepSize_m: 15,
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
    terminalSocValuation: 'average-import',
    terminalSocCustomPrice_cents_per_kWh: 0,
    dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
    rebalanceEnabled: false,
    rebalanceHoldHours: 0,
    haUrl: '',
    haToken: '',
    autoCalculate,
  });
}

describe('auto-calculate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopAutoCalculate();
  });

  afterEach(() => {
    stopAutoCalculate();
    vi.useRealTimers();
  });

  it('does not start when autoCalculate is not enabled', () => {
    const settings = makeSettings({ enabled: false, intervalMinutes: 5, updateData: true, writeToVictron: false });
    startAutoCalculate(settings);

    expect(isAutoCalculateRunning()).toBe(false);
    expect(planAndMaybeWrite).not.toHaveBeenCalled();
  });

  it('does not start when autoCalculate is missing', () => {
    const settings = makeSettings(undefined);
    startAutoCalculate(settings);

    expect(isAutoCalculateRunning()).toBe(false);
    expect(planAndMaybeWrite).not.toHaveBeenCalled();
  });

  it('starts timer and runs first calculation immediately', async () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: false });
    startAutoCalculate(settings);

    expect(isAutoCalculateRunning()).toBe(true);

    // The immediate tick is async — flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
  });

  it('calls planAndMaybeWrite with correct updateData and writeToVictron', async () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 10, updateData: true, writeToVictron: true });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(0);

    expect(planAndMaybeWrite).toHaveBeenCalledWith({ updateData: true, writeToVictron: true });
  });

  it('stops previous timer when startAutoCalculate is called again', async () => {
    const settings1 = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    const settings2 = makeSettings({ enabled: true, intervalMinutes: 10, updateData: true, writeToVictron: true });

    startAutoCalculate(settings1);
    await vi.advanceTimersByTimeAsync(0);

    startAutoCalculate(settings2);
    await vi.advanceTimersByTimeAsync(0);

    // First start: 1 immediate call, second start: 1 immediate call = 2 total
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);
    expect(isAutoCalculateRunning()).toBe(true);

    // Advance past first interval (5 min) — should NOT fire again because old timer was cleared
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Only the second timer's interval (10 min) should fire
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(3);
  });

  it('stopAutoCalculate clears the timer', () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    expect(isAutoCalculateRunning()).toBe(true);

    stopAutoCalculate();

    expect(isAutoCalculateRunning()).toBe(false);
  });

  it('skips tick when calculation is in progress', async () => {
    const logSpy = vi.spyOn(console, 'log');

    // Make planAndMaybeWrite hang (never resolve) to simulate in-progress calculation
    let resolveHanging;
    planAndMaybeWrite.mockImplementationOnce(
      () => new Promise((resolve) => { resolveHanging = resolve; }),
    );

    const settings = makeSettings({ enabled: true, intervalMinutes: 1, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    // Let the immediate tick start (but not finish — it's hanging)
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the interval to trigger another tick
    await vi.advanceTimersByTimeAsync(60_000);

    expect(logSpy).toHaveBeenCalledWith('[auto-calculate] skipped — calculation already in progress');

    // Resolve the hanging promise to clean up
    resolveHanging({});
    await vi.advanceTimersByTimeAsync(0);

    logSpy.mockRestore();
  });

  it('catches errors from planAndMaybeWrite without crashing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    planAndMaybeWrite.mockRejectedValueOnce(new Error('solver exploded'));

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(0);

    expect(errorSpy).toHaveBeenCalledWith('[auto-calculate] calculation failed:', 'solver exploded');
    // Timer should still be running
    expect(isAutoCalculateRunning()).toBe(true);

    // Next tick should work normally
    planAndMaybeWrite.mockResolvedValueOnce({});
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it('clamps intervalMinutes to minimum of 1', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const settings = makeSettings({ enabled: true, intervalMinutes: 0, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    // Should use 1 minute (60000ms), not 0ms
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    expect(isAutoCalculateRunning()).toBe(true);

    setIntervalSpy.mockRestore();
  });

});
