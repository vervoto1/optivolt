import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: vi.fn() }));
vi.mock('../../../api/services/prediction-config-store.ts', () => ({
  loadPredictionConfig: vi.fn(),
  savePredictionConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../api/services/load-prediction-service.ts', () => ({ scoreStrategies: vi.fn() }));
vi.mock('../../../api/services/prediction-auto-select-store.ts', () => ({
  appendAutoSelectRun: vi.fn().mockResolvedValue(undefined),
  getLatestAutoSelectRun: vi.fn().mockResolvedValue(null),
}));

const {
  runAutoSelect,
  startPredictionAutoSelect,
  stopPredictionAutoSelect,
  isAutoSelectRunning,
  isAutoSelectScheduled,
  computeValidationWindow,
  DEFAULT_AUTO_SELECT_CONFIG,
} = await import('../../../api/services/prediction-auto-select.ts');
const { loadSettings } = await import('../../../api/services/settings-store.ts');
const { loadPredictionConfig, savePredictionConfig } = await import('../../../api/services/prediction-config-store.ts');
const { scoreStrategies } = await import('../../../api/services/load-prediction-service.ts');
const { appendAutoSelectRun, getLatestAutoSelectRun } = await import('../../../api/services/prediction-auto-select-store.ts');
const { HttpError } = await import('../../../api/http-errors.ts');

const INCUMBENT = { sensor: 'Load without EV', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median' };

function makePredConfig(overrides = {}) {
  return {
    sensors: [{ id: 'sensor.load', name: 'Load without EV', unit: 'kWh' }],
    derived: [],
    activeType: 'historical',
    historicalPredictor: { ...INCUMBENT },
    fixedPredictor: { load_W: 200 },
    pvConfig: { latitude: 51, longitude: 4, historyDays: 14, pvSensor: 'Solar' },
    validationWindow: { start: '2026-08-15T00:00:00.000Z', end: '2026-08-22T00:00:00.000Z' },
    ...overrides,
  };
}

function makeSettings(autoSelect = {}, overrides = {}) {
  return {
    haUrl: 'ws://homeassistant.local:8123/api/websocket',
    haToken: 'token',
    predictionAutoSelect: { ...DEFAULT_AUTO_SELECT_CONFIG, ...autoSelect },
    ...overrides,
  };
}

const score = (lookbackWeeks, dayFilter, aggregation, mae, n = 672) => ({
  sensor: 'Load without EV', lookbackWeeks, dayFilter, aggregation, mae, rmse: mae * 1.4, mape: 30, n, nSkipped: 0, validationPredictions: [],
});

const NOW = '2026-08-22T10:00:00.000Z';

describe('computeValidationWindow', () => {
  it('returns the previous N full UTC days ending at today UTC midnight', () => {
    expect(computeValidationWindow(28, new Date(NOW).getTime())).toEqual({
      start: '2026-07-25T00:00:00.000Z',
      end: '2026-08-22T00:00:00.000Z',
    });
    expect(computeValidationWindow(14, new Date(NOW).getTime()).start).toBe('2026-08-08T00:00:00.000Z');
  });
});

describe('runAutoSelect', () => {
  let log;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.clearAllMocks();
    stopPredictionAutoSelect();
    loadSettings.mockResolvedValue(makeSettings());
    loadPredictionConfig.mockResolvedValue(makePredConfig());
    getLatestAutoSelectRun.mockResolvedValue(null);
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 483), score(26, 'all', 'median', 457)]);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stopPredictionAutoSelect();
    vi.useRealTimers();
    log.mockRestore();
  });

  it('records a skip when the active predictor is not historical, without fetching', async () => {
    loadPredictionConfig.mockResolvedValue(makePredConfig({ activeType: 'fixed' }));
    const record = await runAutoSelect();
    expect(record.action).toBe('skipped');
    expect(record.skipReason).toContain('not historical');
    expect(record.sensor).toBe('Load without EV');
    expect(record.trigger).toBe('manual');
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).toHaveBeenCalledWith(record);
  });

  it('records a skip when no historical predictor or no sensors are configured', async () => {
    loadPredictionConfig.mockResolvedValue(makePredConfig({ historicalPredictor: undefined }));
    let record = await runAutoSelect();
    expect(record.skipReason).toBe('no historical predictor configured');
    expect(record.sensor).toBeNull();

    loadPredictionConfig.mockResolvedValue(makePredConfig({ sensors: [] }));
    record = await runAutoSelect();
    expect(record.skipReason).toBe('no sensors configured');
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('records a skip without HA credentials outside add-on mode, but runs with SUPERVISOR_TOKEN', async () => {
    loadSettings.mockResolvedValue(makeSettings({}, { haUrl: '', haToken: '' }));
    let record = await runAutoSelect();
    expect(record.skipReason).toBe('Home Assistant connection not configured');

    loadSettings.mockResolvedValue(makeSettings({}, { haUrl: undefined, haToken: undefined }));
    record = await runAutoSelect();
    expect(record.skipReason).toBe('Home Assistant connection not configured');

    process.env.SUPERVISOR_TOKEN = 'sup';
    record = await runAutoSelect();
    expect(record.action).not.toBe('skipped');
    expect(scoreStrategies.mock.calls[0][0]).toMatchObject({ haUrl: '', haToken: '' });
  });

  it('keeps the incumbent when it is best and records the ranking', async () => {
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300), score(26, 'all', 'median', 320)]);
    const record = await runAutoSelect();

    expect(record.action).toBe('kept');
    expect(record.reason).toBe('incumbent-best');
    expect(record.incumbent).toMatchObject({ lookbackWeeks: 8, mae: 300 });
    expect(record.best).toMatchObject({ lookbackWeeks: 8 });
    expect(record.improvement_percent).toBe(0);
    expect(record.ranking.map(r => r.lookbackWeeks)).toEqual([8, 26]);
    expect(record).toMatchObject({ windowDays: 28, metric: 'mae', mode: 'suggest', minImprovement_percent: 10, at: NOW });
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).toHaveBeenCalledWith(record);
  });

  it('scores the full grid for the active sensor over the configured window with HA credentials', async () => {
    loadSettings.mockResolvedValue(makeSettings({ windowDays: 14, metric: 'rmse', minImprovement_percent: 5 }));
    await runAutoSelect();

    const [runConfig, strategies, window] = scoreStrategies.mock.calls[0];
    expect(runConfig).toMatchObject({ haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'token', activeType: 'historical' });
    expect(strategies).toHaveLength(80);
    expect(strategies.every(s => s.sensor === 'Load without EV')).toBe(true);
    expect(strategies.some(s => s.lookbackWeeks === 8 && s.dayFilter === 'all' && s.aggregation === 'median')).toBe(true);
    expect(window).toEqual({ start: '2026-08-08T00:00:00.000Z', end: '2026-08-22T00:00:00.000Z' });
  });

  it('adds an off-grid incumbent to the scored strategies exactly once', async () => {
    loadPredictionConfig.mockResolvedValue(makePredConfig({ historicalPredictor: { ...INCUMBENT, lookbackWeeks: 5 } }));
    scoreStrategies.mockResolvedValue([score(5, 'all', 'median', 300), score(8, 'all', 'median', 320)]);
    const record = await runAutoSelect();

    const strategies = scoreStrategies.mock.calls[0][1];
    expect(strategies).toHaveLength(81);
    expect(strategies.filter(s => s.lookbackWeeks === 5)).toEqual([{ sensor: 'Load without EV', lookbackWeeks: 5, dayFilter: 'all', aggregation: 'median' }]);
    expect(record.reason).toBe('incumbent-best');
  });

  it('caps the persisted ranking at 10 entries', async () => {
    scoreStrategies.mockResolvedValue(Array.from({ length: 15 }, (_, i) => score(i + 1, 'all', 'median', 400 + i)));
    loadPredictionConfig.mockResolvedValue(makePredConfig({ historicalPredictor: { ...INCUMBENT, lookbackWeeks: 1 } }));
    const record = await runAutoSelect();
    expect(record.ranking).toHaveLength(10);
  });

  it('suggests without writing when a candidate clears the margin in suggest mode', async () => {
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const record = await runAutoSelect();

    expect(record.action).toBe('suggested');
    expect(record.reason).toBe('switch');
    expect(record.best).toMatchObject({ lookbackWeeks: 26 });
    expect(record.improvement_percent).toBeCloseTo(20, 6);
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('suggested (manual) — switch: best 26w/all/median MAE 400, current 8w/all/median MAE 500 (−20.0 %)'));
  });

  it('keeps below-threshold candidates and logs the delta', async () => {
    const record = await runAutoSelect();
    expect(record.action).toBe('kept');
    expect(record.reason).toBe('below-threshold');
    expect(record.improvement_percent).toBeCloseTo(5.383, 2);
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('applies in auto mode, rewriting only the three strategy fields', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'weekday-weekend', 'mean', 400)]);
    const record = await runAutoSelect({ trigger: 'scheduled' });

    expect(record.action).toBe('applied');
    expect(record.trigger).toBe('scheduled');
    expect(savePredictionConfig).toHaveBeenCalledOnce();
    const saved = savePredictionConfig.mock.calls[0][0];
    expect(saved.historicalPredictor).toEqual({ sensor: 'Load without EV', lookbackWeeks: 26, dayFilter: 'weekday-weekend', aggregation: 'mean' });
    expect(saved.activeType).toBe('historical');
    expect(saved.pvConfig).toEqual(makePredConfig().pvConfig);
    expect(saved.fixedPredictor).toEqual({ load_W: 200 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched 8w/all/median → 26w/weekday-weekend/mean'));
  });

  it('does not write in auto mode when apply is false (dry run)', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const record = await runAutoSelect({ apply: false });
    expect(record.action).toBe('suggested');
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('switches away from an incumbent that could not be scored', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', NaN), score(4, 'all', 'median', 400)]);
    const record = await runAutoSelect();
    expect(record.reason).toBe('incumbent-unscored');
    expect(record.action).toBe('applied');
    expect(record.incumbent).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('current 8w/all/median MAE —'));
  });

  it('keeps the incumbent and logs "none" when nothing is eligible', async () => {
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300, 10), score(26, 'all', 'median', 200, 5)]);
    const record = await runAutoSelect();
    expect(record.reason).toBe('no-eligible');
    expect(record.action).toBe('kept');
    expect(record.best).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('best none'));
  });

  it('falls back to the default config when settings lack the block', async () => {
    loadSettings.mockResolvedValue(makeSettings({}, { predictionAutoSelect: undefined }));
    const record = await runAutoSelect();
    expect(record).toMatchObject({ windowDays: 28, metric: 'mae', mode: 'suggest' });
    expect(scoreStrategies.mock.calls[0][2]).toEqual({ start: '2026-07-25T00:00:00.000Z', end: '2026-08-22T00:00:00.000Z' });
  });

  it('rejects a concurrent run with 409 and resets the flag afterwards', async () => {
    let release;
    scoreStrategies.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const first = runAutoSelect();
    await vi.advanceTimersByTimeAsync(0);
    expect(isAutoSelectRunning()).toBe(true);

    await expect(runAutoSelect()).rejects.toMatchObject({ statusCode: 409 });
    expect(() => { throw new HttpError(409); }).toThrow();

    release([score(8, 'all', 'median', 300)]);
    await first;
    expect(isAutoSelectRunning()).toBe(false);
  });

  it('propagates scoring errors and releases the running flag', async () => {
    scoreStrategies.mockRejectedValue(new Error('HA WebSocket timed out'));
    await expect(runAutoSelect()).rejects.toThrow('HA WebSocket timed out');
    expect(isAutoSelectRunning()).toBe(false);
    expect(appendAutoSelectRun).not.toHaveBeenCalled();

    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300)]);
    await expect(runAutoSelect()).resolves.toMatchObject({ action: 'kept' });
  });
});

describe('startPredictionAutoSelect timer', () => {
  let log;
  let error;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopPredictionAutoSelect();
    loadSettings.mockResolvedValue(makeSettings({ enabled: true, mode: 'suggest', time: '03:30' }));
    loadPredictionConfig.mockResolvedValue(makePredConfig());
    getLatestAutoSelectRun.mockResolvedValue(null);
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300)]);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stopPredictionAutoSelect();
    vi.useRealTimers();
    log.mockRestore();
    error.mockRestore();
  });

  const enabled = (extra = {}) => makeSettings({ enabled: true, time: '03:30', ...extra });

  it('does not arm when disabled or missing', () => {
    startPredictionAutoSelect(makeSettings({ enabled: false }));
    expect(isAutoSelectScheduled()).toBe(false);
    startPredictionAutoSelect({});
    expect(isAutoSelectScheduled()).toBe(false);
  });

  it('fires once inside the daily window and again the next day', async () => {
    // Local time (TZ=Europe/Amsterdam in vitest config); recent run so no catch-up
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-22T06:00:00').toISOString() });
    startPredictionAutoSelect(enabled());
    expect(isAutoSelectScheduled()).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000); // 03:30:30
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    const record = appendAutoSelectRun.mock.calls[0][0];
    expect(record.trigger).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(4 * 60_000); // still inside the window
    expect(scoreStrategies).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); // next day 03:34:30
    expect(scoreStrategies).toHaveBeenCalledTimes(2);
  });

  it('skips the scheduled run when a run already happened today (restart inside the window)', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:31:00'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-23T03:30:20').toISOString() });
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already ran today'));
  });

  it('runs a catch-up 2 minutes after boot when there is no run in the last 24 h', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun.mock.calls[0][0].trigger).toBe('catch-up');
  });

  it('runs a catch-up when the last run is older than 24 h but not when it is recent', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-23T11:00:00').toISOString() });
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();

    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-22T06:00:00').toISOString() });
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('stop cancels both the interval and the pending catch-up', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    startPredictionAutoSelect(enabled());
    stopPredictionAutoSelect();
    expect(isAutoSelectScheduled()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('restarting replaces the previous timer (no double fire)', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-22T06:00:00').toISOString() });
    startPredictionAutoSelect(enabled());
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('never fires on an unparseable time, and falls back to defaults for missing time/mode', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-23T01:00:00').toISOString() });
    startPredictionAutoSelect(enabled({ time: 'xx:yy' }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();

    startPredictionAutoSelect({ predictionAutoSelect: { enabled: true } });
    expect(log).toHaveBeenCalledWith('[auto-select] started (daily at 03:30, mode suggest)');
  });

  it('logs scheduled-run failures instead of throwing', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    getLatestAutoSelectRun.mockResolvedValue({ at: new Date('2026-08-22T06:00:00').toISOString() });
    scoreStrategies.mockRejectedValue(new Error('HA down'));
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith('[auto-select] scheduled run failed:', 'HA down');
  });

  it('treats a failing history read as "no run yet"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    getLatestAutoSelectRun.mockRejectedValue(new Error('corrupt'));
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(warn).toHaveBeenCalledWith('[auto-select] Failed to read run history:', 'corrupt');
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
