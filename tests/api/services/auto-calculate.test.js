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
const { loadSettings } = await import('../../../api/services/settings-store.ts');
const { calibrate } = await import('../../../api/services/efficiency-calibrator.ts');
const { HttpError } = await import('../../../api/http-errors.ts');

const BASE_TIME = '2024-01-01T12:03:00.000Z';

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
    vi.setSystemTime(new Date(BASE_TIME));
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

  it('starts timer and waits until the next boundary for the first calculation', async () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: false });
    startAutoCalculate(settings);

    expect(isAutoCalculateRunning()).toBe(true);
    expect(planAndMaybeWrite).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(planAndMaybeWrite).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
  });

  it('calls planAndMaybeWrite with correct updateData and writeToVictron', async () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 10, updateData: true, writeToVictron: true });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(7 * 60_000);

    expect(planAndMaybeWrite).toHaveBeenCalledWith({ updateData: true, writeToVictron: true });
  });

  it('stops previous timer when startAutoCalculate is called again', async () => {
    const settings1 = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    const settings2 = makeSettings({ enabled: true, intervalMinutes: 10, updateData: true, writeToVictron: true });

    startAutoCalculate(settings1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    startAutoCalculate(settings2);
    await vi.advanceTimersByTimeAsync(0);

    // First start fires once at 12:05; second schedule is still waiting for 12:10.
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
    expect(isAutoCalculateRunning()).toBe(true);

    // Advancing to 12:08 should not fire the cleared 5-minute timer again.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);

    // The replacement timer should fire once at 12:10.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);
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

    // Let the first aligned tick start (but not finish — it's hanging)
    await vi.advanceTimersByTimeAsync(60_000);

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

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(errorSpy).toHaveBeenCalledWith('[auto-calculate] calculation failed:', 'solver exploded');
    // Timer should still be running
    expect(isAutoCalculateRunning()).toBe(true);

    // Next tick should work normally
    planAndMaybeWrite.mockResolvedValueOnce({});
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it('defaults intervalMinutes to 15 when intervalMinutes is undefined', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const settings = makeSettings({ enabled: true, intervalMinutes: undefined, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    // At 12:03, next 15-minute boundary is 12 minutes away.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 12 * 60_000);

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000);

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('defaults minDataDays to 3 when minDataDays is undefined in adaptive learning settings', async () => {
    // Line 70: al.minDataDays ?? 3
    loadSettings.mockResolvedValue({ adaptiveLearning: { enabled: true } }); // minDataDays not set

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // calibrate should have been called with the default of 3
    expect(calibrate).toHaveBeenCalledWith(3);
  });

  it('clamps intervalMinutes to minimum of 1', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const settings = makeSettings({ enabled: true, intervalMinutes: 0, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    expect(isAutoCalculateRunning()).toBe(true);

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('runs calibration when adaptive learning is enabled in settings', async () => {
    loadSettings.mockResolvedValue({ adaptiveLearning: { enabled: true, minDataDays: 1 } });

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(calibrate).toHaveBeenCalledWith(1);
  });

  it('does not run calibration when adaptive learning is disabled', async () => {
    loadSettings.mockResolvedValue({ adaptiveLearning: { enabled: false } });

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(calibrate).not.toHaveBeenCalled();
  });

  it('SoC sampling failure is caught and tick still completes', async () => {
    const { sampleAndStoreSoc } = await import('../../../api/services/soc-tracker.ts');
    sampleAndStoreSoc.mockRejectedValueOnce(new Error('MQTT timeout'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // Tick should still complete (planAndMaybeWrite was called)
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
    expect(isAutoCalculateRunning()).toBe(true);

    warnSpy.mockRestore();
  });

  it('adaptive learning check failure is caught and tick still completes', async () => {
    loadSettings.mockRejectedValueOnce(new Error('settings read failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // planAndMaybeWrite still called despite loadSettings failure during adaptive check
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
    expect(isAutoCalculateRunning()).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[auto-calculate] adaptive learning check failed:',
      'settings read failed',
    );

    warnSpy.mockRestore();
  });

  it('catches calibration errors without crashing', async () => {
    loadSettings.mockResolvedValue({ adaptiveLearning: { enabled: true, minDataDays: 2 } });
    calibrate.mockRejectedValueOnce(new Error('calibration exploded'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(isAutoCalculateRunning()).toBe(true);

    // Next tick should also work
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('retries with updateData:true when planAndMaybeWrite throws Insufficient future data and updateData is false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    planAndMaybeWrite
      .mockRejectedValueOnce(new HttpError(422, 'Insufficient future data'))
      .mockResolvedValueOnce({});

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: true });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(warnSpy).toHaveBeenCalledWith('[auto-calculate] data exhausted, retrying with VRM refresh');
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2);
    expect(planAndMaybeWrite).toHaveBeenNthCalledWith(1, { updateData: false, writeToVictron: true });
    expect(planAndMaybeWrite).toHaveBeenNthCalledWith(2, { updateData: true, writeToVictron: true });
    expect(isAutoCalculateRunning()).toBe(true);

    warnSpy.mockRestore();
  });

  it('does not retry when updateData is already true and Insufficient future data is thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    planAndMaybeWrite.mockRejectedValueOnce(new HttpError(422, 'Insufficient future data'));

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: true, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // Only one call — no retry since updateData was already true
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[auto-calculate] calculation failed:', 'Insufficient future data');

    errorSpy.mockRestore();
  });

  it('does not retry on non-Insufficient future data errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    planAndMaybeWrite.mockRejectedValueOnce(new Error('solver crashed'));

    const settings = makeSettings({ enabled: true, intervalMinutes: 5, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[auto-calculate] calculation failed:', 'solver crashed');

    errorSpy.mockRestore();
  });

  it('aligns recurring runs to wall-clock boundaries instead of startup time', async () => {
    const settings = makeSettings({ enabled: true, intervalMinutes: 15, updateData: false, writeToVictron: false });
    startAutoCalculate(settings);

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1); // 12:15

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(2); // 12:30

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(3); // 12:45
  });

});
