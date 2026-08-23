import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', () => {
  let store = {};
  return {
    resolveDataDir: () => '/tmp/test-data',
    readJson: vi.fn(async (path) => {
      if (store[path] === undefined) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.parse(JSON.stringify(store[path]));
    }),
    writeJson: vi.fn(async (path, data) => {
      store[path] = JSON.parse(JSON.stringify(data));
    }),
    _reset: () => { store = {}; },
    _getStore: () => store,
  };
});

import {
  loadAutoSelectHistory,
  appendAutoSelectRun,
  getLatestAutoSelectRun,
  MAX_AUTO_SELECT_RUNS,
} from '../../../api/services/prediction-auto-select-store.ts';
import { _reset, _getStore, readJson } from '../../../api/services/json-store.ts';

function makeRun(overrides = {}) {
  return {
    at: '2026-08-23T01:30:00.000Z',
    trigger: 'scheduled',
    sensor: 'Load without EV',
    windowDays: 28,
    metric: 'mae',
    mode: 'suggest',
    incumbent: null,
    best: null,
    improvement_percent: null,
    reason: 'incumbent-best',
    action: 'kept',
    ranking: [],
    ...overrides,
  };
}

describe('prediction-auto-select-store', () => {
  beforeEach(() => {
    _reset();
    vi.clearAllMocks();
  });

  it('returns an empty history and null latest when nothing is stored', async () => {
    expect(await loadAutoSelectHistory()).toEqual([]);
    expect(await getLatestAutoSelectRun()).toBeNull();
  });

  it('appends runs oldest-first and returns the latest', async () => {
    await appendAutoSelectRun(makeRun({ at: '2026-08-22T01:30:00.000Z' }));
    await appendAutoSelectRun(makeRun({ at: '2026-08-23T01:30:00.000Z', action: 'suggested' }));

    const history = await loadAutoSelectHistory();
    expect(history).toHaveLength(2);
    expect(history[0].at).toBe('2026-08-22T01:30:00.000Z');

    const latest = await getLatestAutoSelectRun();
    expect(latest.action).toBe('suggested');
  });

  it('prunes the oldest entries past the ring-buffer limit', async () => {
    for (let i = 0; i < MAX_AUTO_SELECT_RUNS + 5; i++) {
      await appendAutoSelectRun(makeRun({ at: `run-${i}` }));
    }
    const history = await loadAutoSelectHistory();
    expect(history).toHaveLength(MAX_AUTO_SELECT_RUNS);
    expect(history[0].at).toBe('run-5');
    expect(history[history.length - 1].at).toBe(`run-${MAX_AUTO_SELECT_RUNS + 4}`);
  });

  it('treats a non-array file as empty', async () => {
    // Seed through the store's own writer so the key is whatever path the
    // module really uses, then corrupt that entry. (Deriving the key from an
    // already-reset store handed back undefined and a hardcoded fallback path,
    // which turned this into an ENOENT test that passed for the wrong reason.)
    await appendAutoSelectRun(makeRun());
    const [path] = Object.keys(_getStore());
    expect(path).toMatch(/prediction-auto-select\.json$/);
    _getStore()[path] = { not: 'an array' };
    readJson.mockClear();

    expect(await loadAutoSelectHistory()).toEqual([]);
    expect(readJson).toHaveBeenCalledWith(path);
  });

  it('starts fresh on a corrupted file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readJson.mockRejectedValueOnce(new Error('Unexpected token'));
    expect(await loadAutoSelectHistory()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Corrupted history file'), 'Unexpected token');
    warn.mockRestore();
  });
});
