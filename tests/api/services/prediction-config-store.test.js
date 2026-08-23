import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', async (importOriginal) => {
  const { withJsonLock } = await importOriginal();
  let store = {};
  return {
    // The real per-path lock: the update tests below exercise its serialisation.
    withJsonLock,
    resolveDataDir: () => '/tmp/test-data',
    readJson: vi.fn(async (filePath) => {
      if (store[filePath] === undefined) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.parse(JSON.stringify(store[filePath]));
    }),
    writeJson: vi.fn(async (filePath, data) => {
      store[filePath] = JSON.parse(JSON.stringify(data));
    }),
    _reset: () => { store = {}; },
    _set: (filePath, data) => { store[filePath] = JSON.parse(JSON.stringify(data)); },
  };
});

import {
  computeValidationWindow,
  loadPredictionConfig,
  savePredictionConfig,
  updatePredictionConfig,
} from '../../../api/services/prediction-config-store.ts';
import { readJson, writeJson, _reset, _set } from '../../../api/services/json-store.ts';

function getDefaultPath() {
  return new URL('../../../api/defaults/default-prediction-config.json', import.meta.url).pathname;
}

const PREDICTION_CONFIG_PATH = '/tmp/test-data/prediction-config.json';

describe('loadPredictionConfig', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns defaults merged with empty user config when no file exists', async () => {
    _set(getDefaultPath(), { someDefaultKey: 'default-value' });

    const config = await loadPredictionConfig();
    expect(config.someDefaultKey).toBe('default-value');
  });

  it('populates validationWindow with last 7 days when not set in defaults', async () => {
    _set(getDefaultPath(), {});

    const config = await loadPredictionConfig();
    expect(config.validationWindow).toBeDefined();
    expect(config.validationWindow.start).toBeDefined();
    expect(config.validationWindow.end).toBeDefined();

    // end should be start of today (UTC)
    const end = new Date(config.validationWindow.end);
    expect(end.toISOString()).toBe('2024-06-15T00:00:00.000Z');

    // start should be 7 days before end
    const start = new Date(config.validationWindow.start);
    const diffDays = (end - start) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it('merges user config over defaults', async () => {
    _set(getDefaultPath(), { someDefaultKey: 'default-value', anotherKey: 'original' });
    _set(PREDICTION_CONFIG_PATH, { anotherKey: 'overridden' });

    const config = await loadPredictionConfig();
    expect(config.someDefaultKey).toBe('default-value');
    expect(config.anotherKey).toBe('overridden');
  });

  it('always recomputes validationWindow, ignoring any persisted value', async () => {
    _set(getDefaultPath(), {});
    _set(PREDICTION_CONFIG_PATH, {
      validationWindow: { start: '2024-01-01T00:00:00.000Z', end: '2024-01-08T00:00:00.000Z' },
    });

    const config = await loadPredictionConfig();
    // New behavior: always recomputes — ignores persisted validationWindow
    expect(config.validationWindow.end).toBe('2024-06-15T00:00:00.000Z');
    const diffDays = (new Date(config.validationWindow.end) - new Date(config.validationWindow.start)) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it('migrates old activeConfig format to historicalPredictor + activeType', async () => {
    _set(getDefaultPath(), {});
    _set(PREDICTION_CONFIG_PATH, {
      activeConfig: {
        sensor: 'Total Load',
        lookbackWeeks: 4,
        dayFilter: 'weekday-weekend',
        aggregation: 'mean',
      },
    });

    const config = await loadPredictionConfig();
    expect(config.activeType).toBe('historical');
    expect(config.historicalPredictor).toEqual({
      sensor: 'Total Load',
      lookbackWeeks: 4,
      dayFilter: 'weekday-weekend',
      aggregation: 'mean',
    });
    expect(config).not.toHaveProperty('activeConfig');
  });
});

describe('loadPredictionConfig — stored strategy bounds', () => {
  beforeEach(() => {
    _reset();
  });

  it('clamps an out-of-range lookbackWeeks from a pre-validation file on load', async () => {
    // POST /predictions/config has only validated the strategy since 0.7.56;
    // a file written by an older UI can hold any value, and predict() walks
    // lookbackWeeks × 7 days synchronously on every auto-calculate tick.
    _set(getDefaultPath(), {});
    _set(PREDICTION_CONFIG_PATH, { historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 104, dayFilter: 'same', aggregation: 'mean' } });
    const config = await loadPredictionConfig();
    expect(config.historicalPredictor).toEqual({ sensor: 'Total Load', lookbackWeeks: 52, dayFilter: 'same', aggregation: 'mean' });
  });

  it('clamps the strategy migrated from the legacy activeConfig block too', async () => {
    _set(getDefaultPath(), {});
    _set(PREDICTION_CONFIG_PATH, { activeConfig: { sensor: 'Total Load', lookbackWeeks: 0, dayFilter: 'nope', aggregation: 'mean' } });
    const config = await loadPredictionConfig();
    expect(config.historicalPredictor).toEqual({ sensor: 'Total Load', lookbackWeeks: 1, dayFilter: 'same', aggregation: 'mean' });
  });

  it('leaves a config without a historical predictor alone', async () => {
    _set(getDefaultPath(), { activeType: 'fixed', fixedPredictor: { load_W: 300 } });
    const config = await loadPredictionConfig();
    expect(config.historicalPredictor).toBeUndefined();
  });
});

describe('loadPredictionConfig — non-ENOENT error', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-throws non-ENOENT errors when reading user config', async () => {
    _set(getDefaultPath(), { someKey: 'val' });

    const { readJson } = await import('../../../api/services/json-store.ts');
    // First call reads default (succeeds), second call reads user config (fails with non-ENOENT)
    readJson
      .mockResolvedValueOnce({ someKey: 'val' })  // defaults
      .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

    await expect(loadPredictionConfig()).rejects.toThrow('Permission denied');
  });
});

describe('savePredictionConfig', () => {
  beforeEach(() => {
    _reset();
  });

  it('persists config via writeJson', async () => {
    const config = {
      someKey: 'value',
      validationWindow: { start: '2024-01-01T00:00:00.000Z', end: '2024-01-08T00:00:00.000Z' },
    };

    await savePredictionConfig(config);
    expect(writeJson).toHaveBeenCalledWith(
      expect.stringContaining('prediction-config.json'),
      config,
    );
  });
});

describe('computeValidationWindow', () => {
  it('returns the previous N full UTC days ending at today UTC midnight', () => {
    const now = new Date('2026-08-22T10:00:00.000Z').getTime();
    expect(computeValidationWindow(28, now)).toEqual({
      start: '2026-07-25T00:00:00.000Z',
      end: '2026-08-22T00:00:00.000Z',
    });
    expect(computeValidationWindow(14, now).start).toBe('2026-08-08T00:00:00.000Z');
  });

  it('is what loadPredictionConfig uses for its 7-day window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00.000Z'));
    _reset();
    _set(getDefaultPath(), {});
    const config = await loadPredictionConfig();
    expect(config.validationWindow).toEqual(computeValidationWindow(7));
    expect(config.validationWindow.start).toBe('2024-06-08T00:00:00.000Z');
    vi.useRealTimers();
  });
});

describe('updatePredictionConfig', () => {
  beforeEach(() => {
    _reset();
    _set(getDefaultPath(), { sensors: [], derived: [], activeType: 'historical' });
    vi.clearAllMocks();
  });

  it('loads, mutates and saves, returning what was persisted', async () => {
    const next = await updatePredictionConfig(cfg => ({ ...cfg, activeType: 'fixed' }));
    expect(next.activeType).toBe('fixed');
    expect(writeJson).toHaveBeenCalledWith(PREDICTION_CONFIG_PATH, expect.objectContaining({ activeType: 'fixed' }));
    expect((await loadPredictionConfig()).activeType).toBe('fixed');
  });

  it('leaves the file untouched when the mutator returns null', async () => {
    const seen = [];
    expect(await updatePredictionConfig(cfg => { seen.push(cfg.activeType); return null; })).toBeNull();
    expect(seen).toEqual(['historical']);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('serialises concurrent updates so neither loses the other', async () => {
    // Without the lock both updaters load the same snapshot and the second
    // save reverts the first (the auto-selector's strategy switch vs. a UI
    // sensor edit — the run spans a long HA fetch, so the window is wide).
    _set(PREDICTION_CONFIG_PATH, { activeType: 'historical', historicalPredictor: { sensor: 'A', lookbackWeeks: 4, dayFilter: 'all', aggregation: 'mean' } });
    const seenBySecond = [];

    const first = updatePredictionConfig(cfg => ({ ...cfg, historicalPredictor: { ...cfg.historicalPredictor, lookbackWeeks: 26 } }));
    const second = updatePredictionConfig(cfg => {
      seenBySecond.push(cfg.historicalPredictor.lookbackWeeks);
      return { ...cfg, pvConfig: { ...cfg.pvConfig, latitude: 52 } };
    });
    await Promise.all([first, second]);

    // The second updater only loaded after the first had saved.
    expect(seenBySecond).toEqual([26]);
    expect(readJson.mock.calls.filter(c => c[0] === PREDICTION_CONFIG_PATH)).toHaveLength(2);
    const final = await loadPredictionConfig();
    expect(final.historicalPredictor.lookbackWeeks).toBe(26);
    expect(final.pvConfig.latitude).toBe(52);
    expect(writeJson).toHaveBeenCalledTimes(2);
  });

  it('keeps serialising after a failed update', async () => {
    await expect(updatePredictionConfig(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    const next = await updatePredictionConfig(cfg => ({ ...cfg, activeType: 'fixed' }));
    expect(next.activeType).toBe('fixed');
  });
});
