import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock json-store before importing the module under test
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

import { loadPlanHistory, savePlanSnapshot, getLatestSnapshot, getRecentSnapshots } from '../../../api/services/plan-history-store.ts';
import { _reset } from '../../../api/services/json-store.ts';

function makeSnapshot(overrides = {}) {
  return {
    planId: 'test-plan',
    createdAtMs: Date.now(),
    initialSoc_percent: 50,
    slots: [
      { timestampMs: Date.now(), predictedSoc_percent: 55, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
    ],
    config: {
      chargeEfficiency_percent: 95,
      dischargeEfficiency_percent: 95,
      maxChargePower_W: 3600,
      maxDischargePower_W: 4000,
      batteryCapacity_Wh: 20480,
      idleDrain_W: 40,
      stepSize_m: 15,
    },
    ...overrides,
  };
}

describe('plan-history-store', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns empty array when no history exists', async () => {
    const history = await loadPlanHistory();
    expect(history).toEqual([]);
  });

  it('saves and loads a plan snapshot', async () => {
    const snapshot = makeSnapshot({ planId: 'snap-1' });
    await savePlanSnapshot(snapshot);

    const history = await loadPlanHistory();
    expect(history).toHaveLength(1);
    expect(history[0].planId).toBe('snap-1');
  });

  it('appends snapshots without overwriting', async () => {
    await savePlanSnapshot(makeSnapshot({ planId: 'snap-1' }));
    await savePlanSnapshot(makeSnapshot({ planId: 'snap-2' }));

    const history = await loadPlanHistory();
    expect(history).toHaveLength(2);
    expect(history[0].planId).toBe('snap-1');
    expect(history[1].planId).toBe('snap-2');
  });

  it('getLatestSnapshot returns most recent', async () => {
    await savePlanSnapshot(makeSnapshot({ planId: 'snap-1', createdAtMs: 1000 }));
    await savePlanSnapshot(makeSnapshot({ planId: 'snap-2', createdAtMs: 2000 }));

    const latest = await getLatestSnapshot();
    expect(latest.planId).toBe('snap-2');
  });

  it('getLatestSnapshot returns null when empty', async () => {
    const latest = await getLatestSnapshot();
    expect(latest).toBeNull();
  });

  it('getRecentSnapshots filters by days', async () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60_000;
    const fiveDaysAgo = now - 5 * 24 * 60 * 60_000;

    await savePlanSnapshot(makeSnapshot({ planId: 'old', createdAtMs: fiveDaysAgo }));
    await savePlanSnapshot(makeSnapshot({ planId: 'recent', createdAtMs: twoDaysAgo }));
    await savePlanSnapshot(makeSnapshot({ planId: 'now', createdAtMs: now }));

    const recent = await getRecentSnapshots(3);
    expect(recent).toHaveLength(2);
    expect(recent[0].planId).toBe('recent');
    expect(recent[1].planId).toBe('now');
  });

  it('prunes old snapshots when exceeding max capacity', async () => {
    // Directly write a pre-filled array to avoid 2001 sequential saves
    const { writeJson } = await import('../../../api/services/json-store.ts');
    const big = [];
    for (let i = 0; i < 2001; i++) {
      big.push(makeSnapshot({ planId: `snap-${i}`, createdAtMs: i }));
    }
    await writeJson('/tmp/test-data/plan-history.json', big);

    // Adding one more triggers pruning
    await savePlanSnapshot(makeSnapshot({ planId: 'snap-new', createdAtMs: 9999 }));

    const history = await loadPlanHistory();
    expect(history).toHaveLength(2000);
    // Oldest entries should have been pruned, newest kept
    expect(history[history.length - 1].planId).toBe('snap-new');
  });
});
