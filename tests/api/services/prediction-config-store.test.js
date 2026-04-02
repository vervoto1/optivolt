import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', () => {
  let store = {};
  return {
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

import { loadPredictionConfig, savePredictionConfig } from '../../../api/services/prediction-config-store.ts';
import { writeJson, _reset, _set } from '../../../api/services/json-store.ts';

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
