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
  };
});

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  readVictronSocPercent: vi.fn(async () => 65),
}));

import { loadSocSamples, findClosestSample, sampleAndStoreSoc } from '../../../api/services/soc-tracker.ts';
import { _reset } from '../../../api/services/json-store.ts';

describe('soc-tracker', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns empty array when no samples exist', async () => {
    const samples = await loadSocSamples();
    expect(samples).toEqual([]);
  });

  it('sampleAndStoreSoc reads MQTT and persists', async () => {
    const sample = await sampleAndStoreSoc();
    expect(sample).not.toBeNull();
    expect(sample.soc_percent).toBe(65);
    expect(sample.timestampMs).toBeGreaterThan(0);

    const stored = await loadSocSamples();
    expect(stored).toHaveLength(1);
    expect(stored[0].soc_percent).toBe(65);
  });

  it('accumulates multiple samples', async () => {
    await sampleAndStoreSoc();
    await sampleAndStoreSoc();
    await sampleAndStoreSoc();

    const stored = await loadSocSamples();
    expect(stored).toHaveLength(3);
  });
});

describe('findClosestSample', () => {
  const samples = [
    { timestampMs: 1000, soc_percent: 50 },
    { timestampMs: 2000, soc_percent: 55 },
    { timestampMs: 3000, soc_percent: 60 },
  ];

  it('finds exact match', () => {
    const result = findClosestSample(samples, 2000);
    expect(result).toEqual({ timestampMs: 2000, soc_percent: 55 });
  });

  it('finds closest within tolerance', () => {
    // 2300 is closest to 2000 (distance 300 vs 700 for 3000)
    const result = findClosestSample(samples, 2300, 1000);
    expect(result).toEqual({ timestampMs: 2000, soc_percent: 55 });
  });

  it('returns null when no sample within tolerance', () => {
    const result = findClosestSample(samples, 10000, 1000);
    expect(result).toBeNull();
  });

  it('returns null for empty samples', () => {
    const result = findClosestSample([], 1000);
    expect(result).toBeNull();
  });
});
