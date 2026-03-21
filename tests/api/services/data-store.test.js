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

import { loadData, saveData, loadDefaultData, validateData } from '../../../api/services/data-store.ts';
import { readJson, writeJson, _reset, _set } from '../../../api/services/json-store.ts';

const NOW_STRING = '2024-01-01T00:00:00.000Z';

function makeValidData(overrides = {}) {
  return {
    load: { start: NOW_STRING, step: 15, values: [500, 500, 500, 500] },
    pv: { start: NOW_STRING, step: 15, values: [0, 0, 0, 0] },
    importPrice: { start: NOW_STRING, step: 15, values: [10, 10, 10, 10] },
    exportPrice: { start: NOW_STRING, step: 15, values: [5, 5, 5, 5] },
    soc: { timestamp: NOW_STRING, value: 50 },
    ...overrides,
  };
}

describe('validateData', () => {
  it('returns the data object when valid', () => {
    const data = makeValidData();
    expect(validateData(data)).toBe(data);
  });

  it('throws when load is missing', () => {
    const data = makeValidData({ load: null });
    expect(() => validateData(data)).toThrow(/load/);
  });

  it('throws when load.start is not a valid timestamp', () => {
    const data = makeValidData({ load: { start: 'not-a-date', step: 15, values: [] } });
    expect(() => validateData(data)).toThrow(/load/);
  });

  it('throws when load.values is not an array', () => {
    const data = makeValidData({ load: { start: NOW_STRING, step: 15, values: 'bad' } });
    expect(() => validateData(data)).toThrow(/load/);
  });

  it('throws when soc.value is not finite', () => {
    const data = makeValidData({ soc: { timestamp: NOW_STRING, value: NaN } });
    expect(() => validateData(data)).toThrow(/soc/);
  });

  it('throws when soc.timestamp is invalid', () => {
    const data = makeValidData({ soc: { timestamp: 'bad-ts', value: 50 } });
    expect(() => validateData(data)).toThrow(/soc/);
  });

  it('validates evLoad when present', () => {
    const data = makeValidData({
      evLoad: { start: NOW_STRING, step: 15, values: [0, 0] },
    });
    expect(validateData(data)).toBe(data);
  });

  it('throws when evLoad.values is not an array', () => {
    const data = makeValidData({
      evLoad: { start: NOW_STRING, step: 15, values: 'bad' },
    });
    expect(() => validateData(data)).toThrow(/evLoad/);
  });
});

describe('loadData', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns defaults when no data file exists', async () => {
    // readJson will throw ENOENT for DATA_PATH, then succeed for DEFAULT_PATH
    // by pre-seeding the default path
    const defaultPath = new URL('../../../api/defaults/default-data.json', import.meta.url).pathname;
    _set(defaultPath, makeValidData());

    const data = await loadData();
    expect(data).toBeDefined();
    expect(data.load).toBeDefined();
    expect(data.soc).toBeDefined();
  });

  it('sets evLoad.start to current time when defaults include evLoad', async () => {
    const defaultPath = new URL('../../../api/defaults/default-data.json', import.meta.url).pathname;
    // Provide defaults that include an evLoad field
    _set(defaultPath, makeValidData({
      evLoad: { start: '1970-01-01T00:00:00.000Z', step: 15, values: [0, 0, 0, 0] },
    }));

    const data = await loadData();
    expect(data.evLoad).toBeDefined();
    // The start time should be updated to NOW_STRING (fake timer is set to NOW_STRING)
    expect(data.evLoad.start).toBe(NOW_STRING);
  });

  it('validates loaded data and returns it', async () => {
    const DATA_PATH = '/tmp/test-data/data.json';
    _set(DATA_PATH, makeValidData());

    const data = await loadData();
    expect(data.soc.value).toBe(50);
  });

  it('throws when stored data is invalid (non-ENOENT error)', async () => {
    readJson.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(loadData()).rejects.toThrow('EPERM');
  });
});

describe('saveData', () => {
  beforeEach(() => {
    _reset();
    writeJson.mockClear();
  });

  it('persists valid data via writeJson', async () => {
    const data = makeValidData();
    await saveData(data);
    expect(writeJson).toHaveBeenCalledWith(expect.stringContaining('data.json'), data);
  });

  it('throws when data is invalid', async () => {
    const bad = makeValidData({ soc: { timestamp: NOW_STRING, value: NaN } });
    await expect(saveData(bad)).rejects.toThrow(/soc/);
    expect(writeJson).not.toHaveBeenCalled();
  });
});

describe('loadDefaultData', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns defaults from the default-data.json file', async () => {
    const defaultPath = new URL('../../../api/defaults/default-data.json', import.meta.url).pathname;
    _set(defaultPath, makeValidData({ soc: { timestamp: NOW_STRING, value: 30 } }));

    const data = await loadDefaultData();
    expect(data.soc.value).toBe(30);
  });
});
