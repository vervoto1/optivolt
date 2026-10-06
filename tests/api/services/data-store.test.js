import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', async (importOriginal) => {
  const actual = await importOriginal();
  let store = {};
  return {
    resolveDataDir: () => '/tmp/test-data',
    // The real per-path lock: the updateData tests below depend on it.
    withJsonLock: actual.withJsonLock,
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

import { loadData, saveData, updateData, loadDefaultData, validateData } from '../../../api/services/data-store.ts';
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

  it('throws when step is zero', () => {
    const data = makeValidData({ load: { start: NOW_STRING, step: 0, values: [100] } });
    expect(() => validateData(data)).toThrow(/load.*step.*positive/i);
  });

  it('throws when step is negative', () => {
    const data = makeValidData({ load: { start: NOW_STRING, step: -1, values: [100] } });
    expect(() => validateData(data)).toThrow(/load.*step.*positive/i);
  });

  it('throws when step is NaN', () => {
    const data = makeValidData({ load: { start: NOW_STRING, step: NaN, values: [100] } });
    expect(() => validateData(data)).toThrow(/load.*step.*positive/i);
  });

  it('accepts data without step property', () => {
    const data = makeValidData({ load: { start: NOW_STRING, values: [100] } });
    expect(validateData(data)).toBe(data);
  });

  it('accepts a null lastFullSocAt', () => {
    const data = makeValidData({ lastFullSocAt: null });
    expect(validateData(data)).toBe(data);
  });

  it('accepts a valid lastFullSocAt timestamp string', () => {
    const data = makeValidData({ lastFullSocAt: '2024-01-02T03:04:05.000Z' });
    expect(validateData(data)).toBe(data);
  });

  it('throws when lastFullSocAt is not a string', () => {
    const data = makeValidData({ lastFullSocAt: 1234567890 });
    expect(() => validateData(data)).toThrow(/lastFullSocAt.*null or a valid timestamp/);
  });

  it('throws when lastFullSocAt is an invalid timestamp string', () => {
    const data = makeValidData({ lastFullSocAt: 'not-a-date' });
    expect(() => validateData(data)).toThrow(/lastFullSocAt.*not-a-date/);
  });

  it('throws when predictionAdjustments is not an array', () => {
    const data = makeValidData({ predictionAdjustments: { id: 'x' } });
    expect(() => validateData(data)).toThrow(/predictionAdjustments: must be an array/);
  });

  it('validates each entry of a predictionAdjustments array', () => {
    const valid = {
      id: 'adj-1',
      series: 'load',
      mode: 'add',
      value_W: 500,
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-01-01T06:00:00.000Z',
      createdAt: NOW_STRING,
      updatedAt: NOW_STRING,
    };
    const data = makeValidData({ predictionAdjustments: [valid] });
    expect(validateData(data)).toBe(data);
  });

  it('throws when a predictionAdjustments entry is invalid', () => {
    const data = makeValidData({
      predictionAdjustments: [{ id: 'adj-1', series: 'bogus', mode: 'add', value_W: 1, start: '2024-01-01T00:00:00.000Z', end: '2024-01-01T06:00:00.000Z' }],
    });
    expect(() => validateData(data)).toThrow(/series must be/);
  });

  it('accepts an empty predictionAdjustments array', () => {
    const data = makeValidData({ predictionAdjustments: [] });
    expect(validateData(data)).toBe(data);
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

describe('updateData', () => {
  const DATA_PATH = '/tmp/test-data/data.json';

  beforeEach(() => {
    _reset();
    writeJson.mockClear();
  });

  it('patches the freshly loaded file and returns the persisted value', async () => {
    _set(DATA_PATH, makeValidData({ lastFullSocAt: '2023-12-31T00:00:00.000Z' }));
    const result = await updateData(current => ({ ...current, soc: { timestamp: NOW_STRING, value: 77 } }));

    expect(result.soc.value).toBe(77);
    expect(result.lastFullSocAt).toBe('2023-12-31T00:00:00.000Z'); // untouched field kept
    expect(writeJson).toHaveBeenCalledTimes(1);
    expect((await loadData()).soc.value).toBe(77);
  });

  it('writes nothing when mutate returns null, and returns the current data', async () => {
    _set(DATA_PATH, makeValidData());
    const result = await updateData(() => null);

    expect(result.soc.value).toBe(50);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('rejects without writing when mutate throws or the result is invalid', async () => {
    _set(DATA_PATH, makeValidData());
    await expect(updateData(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(updateData(current => ({ ...current, soc: { timestamp: NOW_STRING, value: NaN } }))).rejects.toThrow(/soc/);
    expect(writeJson).not.toHaveBeenCalled();
    expect((await loadData()).soc.value).toBe(50);
  });

  it('serialises concurrent writers so neither patch is lost', async () => {
    _set(DATA_PATH, makeValidData());
    // Hold the first writer inside its locked section until the second has queued.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    readJson.mockImplementationOnce(async () => {
      await gate;
      return JSON.parse(JSON.stringify(makeValidData()));
    });

    const first = updateData(current => ({ ...current, soc: { timestamp: NOW_STRING, value: 61 } }));
    const second = updateData(current => ({ ...current, lastFullSocAt: NOW_STRING }));
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    const stored = await loadData();
    expect(stored.soc.value).toBe(61);
    expect(stored.lastFullSocAt).toBe(NOW_STRING);
  });

  it('a plain saveData queues behind an in-flight updateData', async () => {
    _set(DATA_PATH, makeValidData());
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    readJson.mockImplementationOnce(async () => {
      await gate;
      return JSON.parse(JSON.stringify(makeValidData()));
    });

    const order = [];
    const patch = updateData(current => { order.push('update'); return { ...current, soc: { timestamp: NOW_STRING, value: 61 } }; })
      .then(() => order.push('update-done'));
    const save = saveData(makeValidData({ soc: { timestamp: NOW_STRING, value: 42 } })).then(() => order.push('save-done'));
    await Promise.resolve();
    release();
    await Promise.all([patch, save]);

    expect(order).toEqual(['update', 'update-done', 'save-done']);
    expect((await loadData()).soc.value).toBe(42);
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
