import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: vi.fn() }));
vi.mock('../../../api/services/prediction-config-store.ts', async (importOriginal) => {
  const real = await importOriginal();
  const loadPredictionConfig = vi.fn();
  const savePredictionConfig = vi.fn().mockResolvedValue(undefined);
  // Same contract as the real lock: load → mutate → save unless null.
  const updatePredictionConfig = vi.fn(async (mutate) => {
    const next = mutate(await loadPredictionConfig());
    if (next) await savePredictionConfig(next);
    return next;
  });
  return { computeValidationWindow: real.computeValidationWindow, loadPredictionConfig, savePredictionConfig, updatePredictionConfig };
});
vi.mock('../../../api/services/load-prediction-service.ts', () => ({ scoreStrategies: vi.fn() }));
vi.mock('../../../api/services/prediction-auto-select-store.ts', () => ({
  appendAutoSelectRun: vi.fn().mockResolvedValue(undefined),
  loadAutoSelectHistory: vi.fn().mockResolvedValue([]),
}));

const {
  runAutoSelect,
  startPredictionAutoSelect,
  stopPredictionAutoSelect,
  isAutoSelectRunning,
  isAutoSelectScheduled,
  minSamplesFor,
  DEFAULT_AUTO_SELECT_CONFIG,
  MIN_SAMPLES_SHARE,
} = await import('../../../api/services/prediction-auto-select.ts');
const { loadSettings } = await import('../../../api/services/settings-store.ts');
const { loadPredictionConfig, savePredictionConfig, updatePredictionConfig } = await import('../../../api/services/prediction-config-store.ts');
const { scoreStrategies } = await import('../../../api/services/load-prediction-service.ts');
const { appendAutoSelectRun, loadAutoSelectHistory } = await import('../../../api/services/prediction-auto-select-store.ts');
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
/** What the run record stores for a scored strategy: the declared StrategyScore fields only. */
const stored = (lookbackWeeks, dayFilter, aggregation, mae, n = 672) => ({
  lookbackWeeks, dayFilter, aggregation, mae, rmse: mae * 1.4, mape: 30, n, nSkipped: 0,
});

const NOW = '2026-08-22T10:00:00.000Z';

describe('defaults and eligibility floor', () => {
  it('DEFAULT_AUTO_SELECT_CONFIG is the same block as api/defaults/default-settings.json', () => {
    // The defaults are written in both places (the JSON seeds a fresh install,
    // the constant is the runtime fallback); this keeps them from drifting.
    const json = JSON.parse(readFileSync(new URL('../../../api/defaults/default-settings.json', import.meta.url), 'utf8'));
    expect(json.predictionAutoSelect).toEqual(DEFAULT_AUTO_SELECT_CONFIG);
  });

  it('minSamplesFor derives the floor from the window in hours, not days', () => {
    expect(MIN_SAMPLES_SHARE).toBe(0.8);
    expect(minSamplesFor(28)).toBe(538);
    expect(minSamplesFor(14)).toBe(269);
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
    loadAutoSelectHistory.mockResolvedValue([]);
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
    try {
      record = await runAutoSelect();
      expect(record.action).not.toBe('skipped');
      expect(scoreStrategies.mock.calls[0][0]).toMatchObject({ haUrl: '', haToken: '' });
    } finally {
      delete process.env.SUPERVISOR_TOKEN;
    }
  });

  it('keeps the incumbent when it is best and records the ranking as bare strategy scores', async () => {
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300), score(26, 'all', 'median', 320)]);
    const record = await runAutoSelect();

    expect(record.action).toBe('kept');
    expect(record.reason).toBe('incumbent-best');
    // Projected to the declared StrategyScore shape: no `sensor`, no
    // `validationPredictions` leaking from the scorer's entries.
    expect(record.incumbent).toEqual(stored(8, 'all', 'median', 300));
    expect(record.best).toEqual(stored(8, 'all', 'median', 300));
    expect(record.ranking).toEqual([stored(8, 'all', 'median', 300), stored(26, 'all', 'median', 320)]);
    expect(record.improvement_percent).toBe(0);
    expect(record).toMatchObject({ windowDays: 28, metric: 'mae', mode: 'suggest', minImprovement_percent: 10, at: NOW });
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).toHaveBeenCalledWith(record);
  });

  it('scores the full grid for the active sensor over the configured window with HA credentials', async () => {
    loadSettings.mockResolvedValue(makeSettings({ windowDays: 14, metric: 'rmse', minImprovement_percent: 5 }));
    await runAutoSelect();

    const [runConfig, strategies, window, options] = scoreStrategies.mock.calls[0];
    expect(runConfig).toMatchObject({ haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'token', activeType: 'historical' });
    expect(strategies).toHaveLength(80);
    expect(strategies.every(s => s.sensor === 'Load without EV')).toBe(true);
    expect(strategies.some(s => s.lookbackWeeks === 8 && s.dayFilter === 'all' && s.aggregation === 'median')).toBe(true);
    expect(window).toEqual({ start: '2026-08-08T00:00:00.000Z', end: '2026-08-22T00:00:00.000Z' });
    // The eligibility floor also gates the scorer's common-hour intersection,
    // so one gap-sensitive strategy cannot pull every other one under it.
    expect(options).toEqual({ minCoverage: minSamplesFor(14) });
  });

  it('applies the 80 % eligibility floor derived from the window', async () => {
    // 28 days → 538 points. A regression to `share × days` (22) would let
    // both of these through; a regression to `share × hours × 7` would block both.
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 483, 538), score(26, 'all', 'median', 300, 537)]);
    const record = await runAutoSelect();
    expect(record.reason).toBe('incumbent-best');
    expect(record.ranking.map(r => r.lookbackWeeks)).toEqual([8]);
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
    expect(record.ranking.every(r => !('sensor' in r) && !('validationPredictions' in r))).toBe(true);
  });

  it('suggests without writing when a candidate clears the margin in suggest mode', async () => {
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const record = await runAutoSelect();

    expect(record.action).toBe('suggested');
    expect(record.reason).toBe('switch');
    expect(record.best).toMatchObject({ lookbackWeeks: 26 });
    expect(record.improvement_percent).toBeCloseTo(20, 6);
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('suggested (manual) — switch: best 26w/all/median MAE 400, current 8w/all/median MAE 500 (20.0 % better)'));
  });

  it('keeps below-threshold candidates and logs the delta', async () => {
    const record = await runAutoSelect();
    expect(record.action).toBe('kept');
    expect(record.reason).toBe('below-threshold');
    expect(record.improvement_percent).toBeCloseTo(5.383, 2);
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('applies in auto mode, rewriting only the three strategy fields', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto', enabled: true }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'weekday-weekend', 'mean', 400)]);
    const record = await runAutoSelect({ trigger: 'scheduled' });

    expect(record.action).toBe('applied');
    expect(record.trigger).toBe('scheduled');
    expect(updatePredictionConfig).toHaveBeenCalledOnce();
    expect(savePredictionConfig).toHaveBeenCalledOnce();
    const saved = savePredictionConfig.mock.calls[0][0];
    expect(saved.historicalPredictor).toEqual({ sensor: 'Load without EV', lookbackWeeks: 26, dayFilter: 'weekday-weekend', aggregation: 'mean' });
    expect(saved.activeType).toBe('historical');
    expect(saved.pvConfig).toEqual(makePredConfig().pvConfig);
    expect(saved.fixedPredictor).toEqual({ load_W: 200 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched 8w/all/median → 26w/weekday-weekend/mean'));
  });

  it('overlays the strategy onto the config as it is at write time, not the run-start snapshot', async () => {
    // A UI edit that lands during the (long) scoring phase used to be reverted:
    // the run wrote back its own snapshot with only the strategy changed.
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const edited = makePredConfig({
      pvConfig: { latitude: 52.1, longitude: 4.4, historyDays: 21, pvSensor: 'Roof' },
      sensors: [{ id: 'sensor.load', name: 'Load without EV', unit: 'kWh' }, { id: 'sensor.ev', name: 'EV', unit: 'kWh' }],
    });
    loadPredictionConfig.mockResolvedValueOnce(makePredConfig()).mockResolvedValueOnce(edited);

    const record = await runAutoSelect();
    expect(record.action).toBe('applied');
    const saved = savePredictionConfig.mock.calls[0][0];
    expect(saved.pvConfig).toEqual(edited.pvConfig);
    expect(saved.sensors).toHaveLength(2);
    expect(saved.historicalPredictor).toEqual({ ...INCUMBENT, lookbackWeeks: 26 });
  });

  it('does not apply when the active predictor changed during the run', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const moved = makePredConfig({ historicalPredictor: { ...INCUMBENT, lookbackWeeks: 12 } });
    loadPredictionConfig.mockResolvedValueOnce(makePredConfig()).mockResolvedValueOnce(moved);

    const record = await runAutoSelect();
    expect(record.action).toBe('suggested');
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[auto-select] not applied — the active predictor changed during the run');

    // Same for a sensor change or a switch to the fixed predictor.
    loadPredictionConfig.mockResolvedValueOnce(makePredConfig()).mockResolvedValueOnce(makePredConfig({ activeType: 'fixed' }));
    expect((await runAutoSelect()).action).toBe('suggested');
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('does not apply a timer-triggered run once the selector was disabled or set to suggest mid-run', async () => {
    // POST /settings restarts the timer but cannot cancel a run already scoring.
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    loadSettings
      .mockResolvedValueOnce(makeSettings({ mode: 'auto', enabled: true }))
      .mockResolvedValueOnce(makeSettings({ mode: 'auto', enabled: false }));
    let record = await runAutoSelect({ trigger: 'scheduled' });
    expect(record.action).toBe('suggested');
    expect(updatePredictionConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[auto-select] not applied — selector disabled or switched to suggest mode during the run');

    loadSettings
      .mockResolvedValueOnce(makeSettings({ mode: 'auto', enabled: true }))
      .mockResolvedValueOnce(makeSettings({ mode: 'suggest', enabled: true }));
    record = await runAutoSelect({ trigger: 'catch-up' });
    expect(record.action).toBe('suggested');
    expect(updatePredictionConfig).not.toHaveBeenCalled();

    // A manual run applies on the settings it started with — the caller asked for it.
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto', enabled: false }));
    record = await runAutoSelect();
    expect(record.action).toBe('applied');
    expect(loadSettings).toHaveBeenCalledTimes(5);
  });

  it('does not write in auto mode when apply is false (dry run)', async () => {
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 500), score(26, 'all', 'median', 400)]);
    const record = await runAutoSelect({ apply: false });
    expect(record.action).toBe('suggested');
    expect(savePredictionConfig).not.toHaveBeenCalled();
  });

  it('only suggests — never applies — when the incumbent could not be scored', async () => {
    // No incumbent score means no margin; auto mode must not rewrite the live
    // predictor on what is usually a transient data gap.
    loadSettings.mockResolvedValue(makeSettings({ mode: 'auto' }));
    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', NaN), score(4, 'all', 'median', 400)]);
    const record = await runAutoSelect();
    expect(record.reason).toBe('incumbent-unscored');
    expect(record.action).toBe('suggested');
    expect(record.incumbent).toBeNull();
    expect(record.best).toMatchObject({ lookbackWeeks: 4 });
    expect(record.improvement_percent).toBeNull();
    expect(savePredictionConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('suggested (manual) — incumbent-unscored: best 4w/all/median MAE 400, current 8w/all/median MAE —'));
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
    // The rejected caller is not a run: nothing is recorded for it.
    expect(appendAutoSelectRun).not.toHaveBeenCalled();

    release([score(8, 'all', 'median', 300)]);
    await first;
    expect(isAutoSelectRunning()).toBe(false);
  });

  it('records a failed run, then propagates scoring errors and releases the running flag', async () => {
    scoreStrategies.mockRejectedValue(new Error('HA WebSocket timed out'));
    await expect(runAutoSelect()).rejects.toThrow('HA WebSocket timed out');
    expect(isAutoSelectRunning()).toBe(false);
    expect(appendAutoSelectRun).toHaveBeenCalledOnce();
    expect(appendAutoSelectRun.mock.calls[0][0]).toMatchObject({
      at: NOW,
      trigger: 'manual',
      sensor: 'Load without EV',
      windowDays: 28,
      metric: 'mae',
      mode: 'suggest',
      action: 'failed',
      error: 'HA WebSocket timed out',
      incumbent: null,
      best: null,
      ranking: [],
    });

    scoreStrategies.mockResolvedValue([score(8, 'all', 'median', 300)]);
    await expect(runAutoSelect()).resolves.toMatchObject({ action: 'kept' });
  });

  it('records a failed run on defaults when the settings themselves could not be read', async () => {
    loadSettings.mockRejectedValue(new Error('settings.json unreadable'));
    await expect(runAutoSelect({ trigger: 'catch-up' })).rejects.toThrow('settings.json unreadable');
    expect(appendAutoSelectRun.mock.calls[0][0]).toMatchObject({
      trigger: 'catch-up', sensor: null, windowDays: 28, action: 'failed', error: 'settings.json unreadable',
    });
  });

  it('still rethrows the run error when recording the failure itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scoreStrategies.mockRejectedValue(new Error('HA down'));
    appendAutoSelectRun.mockRejectedValueOnce(new Error('disk full'));
    await expect(runAutoSelect()).rejects.toThrow('HA down');
    expect(warn).toHaveBeenCalledWith('[auto-select] Failed to record the failed run:', 'disk full');
    expect(isAutoSelectRunning()).toBe(false);
    warn.mockRestore();
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
    loadAutoSelectHistory.mockResolvedValue([]);
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
  const pastRun = (at, extra = {}) => ({ at: new Date(at).toISOString(), trigger: 'scheduled', action: 'kept', ...extra });

  it('does not arm when disabled or missing', () => {
    startPredictionAutoSelect(makeSettings({ enabled: false }));
    expect(isAutoSelectScheduled()).toBe(false);
    startPredictionAutoSelect({});
    expect(isAutoSelectScheduled()).toBe(false);
  });

  it('fires once inside the daily window and again the next day', async () => {
    // Local time (TZ=Europe/Amsterdam in vitest config); recent run so no catch-up
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
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
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T03:30:20')]);
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already ran today'));

    // A skipped automatic attempt counts too: its cause is a config state that
    // a retry a minute later will not change.
    vi.clearAllMocks();
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T03:30:20', { action: 'skipped' })]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('does not let a manual run earlier in the day cancel the scheduled run', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T01:00:00', { trigger: 'manual' })]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun.mock.calls[0][0].trigger).toBe('scheduled');
  });

  it('retries a failed scheduled run on the next tick and stops once a run completes', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    scoreStrategies.mockRejectedValueOnce(new Error('HA down'));
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000); // 03:30:30 — fails
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[auto-select] scheduled run failed:', 'HA down');
    expect(appendAutoSelectRun.mock.calls[0][0]).toMatchObject({ action: 'failed', trigger: 'scheduled' });

    await vi.advanceTimersByTimeAsync(60_000); // 03:31:30 — retried, succeeds
    expect(scoreStrategies).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 60_000); // rest of the window: no more
    expect(scoreStrategies).toHaveBeenCalledTimes(2);
  });

  it('retries after a restart inside the window when the persisted run for it failed', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:31:00'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T03:30:20', { action: 'failed', error: 'HA down' })]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('defers behind a manual run in flight and retries on the next tick', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    let release;
    scoreStrategies.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const manual = runAutoSelect(); // manual run holding the flag
    await vi.advanceTimersByTimeAsync(0);
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000); // 03:30:30 — deferred without a 409
    expect(log).toHaveBeenCalledWith('[auto-select] scheduled run deferred — another run is in flight');
    expect(error).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).not.toHaveBeenCalled();

    release([score(8, 'all', 'median', 300)]);
    await manual;
    await vi.advanceTimersByTimeAsync(60_000); // 03:31:30 — the manual run does not count, so it runs
    expect(scoreStrategies).toHaveBeenCalledTimes(2);
    expect(appendAutoSelectRun.mock.calls.at(-1)[0].trigger).toBe('scheduled');
  });

  it('does not race its own run: ticks during a slow scheduled run neither 409 nor log a deferral', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    let release;
    scoreStrategies.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    startPredictionAutoSelect(enabled());

    await vi.advanceTimersByTimeAsync(60_000); // 03:30:30 — scheduled run starts, HA fetch hangs
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000); // 03:32:30 — two more ticks while it runs
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('deferred'));
    expect(appendAutoSelectRun).not.toHaveBeenCalled();

    release([score(8, 'all', 'median', 300)]);
    await vi.advanceTimersByTimeAsync(2 * 60_000); // rest of the window
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun.mock.calls[0][0]).toMatchObject({ trigger: 'scheduled', action: 'kept' });
  });

  it('judges "already ran today" on the whole history, not the latest record', async () => {
    // Scheduled run at 03:30:10, a manual run at 03:31 (now the latest record),
    // then a settings save restarts the timer inside the window: the window
    // is still served.
    vi.setSystemTime(new Date('2026-08-23T03:32:00'));
    loadAutoSelectHistory.mockResolvedValue([
      pastRun('2026-08-22T03:30:10'),
      pastRun('2026-08-23T03:30:10'),
      pastRun('2026-08-23T03:31:00', { trigger: 'manual' }),
    ]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already ran today'));
  });

  it('treats a catch-up that fired shortly before the window as having served it', async () => {
    // Boot at 03:27 → catch-up at 03:29; its record is stamped before the
    // 03:30 window opens, and a scheduled run on top of it would score the
    // same data twice.
    vi.setSystemTime(new Date('2026-08-23T03:30:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T03:29:10', { trigger: 'catch-up' })]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();

    // A catch-up the previous evening is too old to count as today's run.
    vi.clearAllMocks();
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T20:00:00', { trigger: 'catch-up' })]);
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('abandons a tick that was suspended on the history read when the timer is stopped or replaced', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    let releaseHistory;
    loadAutoSelectHistory.mockReturnValueOnce(new Promise(resolve => { releaseHistory = resolve; }));
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000); // tick is now awaiting the history
    expect(loadAutoSelectHistory).toHaveBeenCalledTimes(1);

    stopPredictionAutoSelect();
    releaseHistory([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('fires on the spring-forward day for a time inside the skipped hour', async () => {
    // 2027-03-28 02:00 → 03:00 CEST in Europe/Amsterdam; 02:30 never appears
    // on the wall clock, and the old minutes-of-day check produced no run at all.
    vi.setSystemTime(new Date('2027-03-28T00:59:30Z')); // 01:59:30 CET, 30 s before the jump
    loadAutoSelectHistory.mockResolvedValue([pastRun('2027-03-27T02:31:00')]);
    startPredictionAutoSelect(enabled({ time: '02:30' }));
    await vi.advanceTimersByTimeAsync(60 * 60_000); // one real hour: wall clock 03:59 → no, window opened at 03:30
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun.mock.calls[0][0].trigger).toBe('scheduled');
  });

  it('fires in a window that wraps midnight and again the next evening', async () => {
    vi.setSystemTime(new Date('2026-08-24T00:00:30')); // local; window 23:58–00:03 opened yesterday
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T23:58:30')]);
    startPredictionAutoSelect(enabled({ time: '23:58' }));
    await vi.advanceTimersByTimeAsync(60_000); // 00:01:30
    expect(scoreStrategies).toHaveBeenCalledTimes(1);

    // The evening window of the new day is a different one.
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-24T00:01:30')]);
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000 + 57 * 60_000); // 23:58:30
    expect(scoreStrategies).toHaveBeenCalledTimes(2);
  });

  it('runs a catch-up 2 minutes after boot when there is no run in the last 24 h', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    startPredictionAutoSelect(enabled(), { runCatchUp: true });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    expect(appendAutoSelectRun.mock.calls[0][0].trigger).toBe('catch-up');
  });

  it('runs a catch-up when the last run is older than 24 h but not when it is recent', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T11:00:00')]);
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();

    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('still runs the catch-up when the only recent run was manual or failed', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    for (const recent of [
      pastRun('2026-08-23T11:00:00', { trigger: 'manual' }),
      pastRun('2026-08-23T11:00:00', { action: 'failed', error: 'HA down' }),
    ]) {
      vi.clearAllMocks();
      loadAutoSelectHistory.mockResolvedValue([recent]);
      startPredictionAutoSelect(enabled(), { runCatchUp: true });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(scoreStrategies).toHaveBeenCalledTimes(1);
      expect(appendAutoSelectRun.mock.calls[0][0].trigger).toBe('catch-up');
    }
  });

  it('is satisfied by a recent skipped automatic attempt (a restart does not change the skip reason)', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    loadAutoSelectHistory.mockResolvedValue([
      pastRun('2026-08-23T11:00:00', { trigger: 'catch-up', action: 'skipped', skipReason: 'active predictor is "fixed", not historical' }),
    ]);
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).not.toHaveBeenCalled();
  });

  it('judges the catch-up on the whole history, so a manual run after the scheduled one does not trigger it', async () => {
    // Scheduled run completed at 03:30, the user clicked Run Selection at
    // 10:00 (now the latest record), the add-on restarted at 10:05.
    vi.setSystemTime(new Date('2026-08-23T10:05:00'));
    loadAutoSelectHistory.mockResolvedValue([
      pastRun('2026-08-23T03:30:10'),
      pastRun('2026-08-23T10:00:00', { trigger: 'manual' }),
    ]);
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('defers the catch-up (logged, not failed) when a manual run is in flight at that moment', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    let release;
    scoreStrategies.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const manual = runAutoSelect(); // holds the running flag through the catch-up
    await vi.advanceTimersByTimeAsync(0);
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(log).toHaveBeenCalledWith('[auto-select] catch-up run deferred — another run is in flight');
    expect(error).not.toHaveBeenCalled();
    expect(appendAutoSelectRun).not.toHaveBeenCalled();

    release([score(8, 'all', 'median', 300)]);
    await manual;
    expect(scoreStrategies).toHaveBeenCalledTimes(1); // the catch-up is not retried; the manual run covers it
  });

  it('abandons the catch-up when the timer is stopped while it reads the history', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    let releaseHistory;
    loadAutoSelectHistory.mockReturnValueOnce(new Promise(resolve => { releaseHistory = resolve; }));
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    stopPredictionAutoSelect();
    releaseHistory([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('does not arm the catch-up when restarted from a settings save', async () => {
    // POST /settings stops and restarts every timer service on each save. Without
    // the boot gate, ticking "enabled" in auto mode would rewrite the live
    // prediction config two minutes later, and every keystroke in the card would
    // re-arm that fuse.
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
    expect(isAutoSelectScheduled()).toBe(true);
  });

  it('stop cancels both the interval and the pending catch-up', async () => {
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    stopPredictionAutoSelect();
    expect(isAutoSelectScheduled()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();
  });

  it('restarting replaces the previous timer (no double fire)', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    startPredictionAutoSelect(enabled());
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
  });

  it('never fires on an unparseable time, and falls back to defaults for missing time/mode', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-23T01:00:00')]);
    startPredictionAutoSelect(enabled({ time: 'xx:yy' }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scoreStrategies).not.toHaveBeenCalled();

    startPredictionAutoSelect({ predictionAutoSelect: { enabled: true } });
    expect(log).toHaveBeenCalledWith('[auto-select] started (daily at 03:30, mode suggest)');
  });

  it('logs scheduled-run failures instead of throwing', async () => {
    vi.setSystemTime(new Date('2026-08-23T03:29:30'));
    loadAutoSelectHistory.mockResolvedValue([pastRun('2026-08-22T06:00:00')]);
    scoreStrategies.mockRejectedValue(new Error('HA down'));
    startPredictionAutoSelect(enabled());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith('[auto-select] scheduled run failed:', 'HA down');
  });

  it('treats a failing history read as "no run yet"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.setSystemTime(new Date('2026-08-23T12:00:00'));
    loadAutoSelectHistory.mockRejectedValue(new Error('corrupt'));
    startPredictionAutoSelect(enabled(), { runCatchUp: true });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(warn).toHaveBeenCalledWith('[auto-select] Failed to read run history:', 'corrupt');
    expect(scoreStrategies).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
