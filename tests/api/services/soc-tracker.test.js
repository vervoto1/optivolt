import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(async () => ({
    load: { start: new Date().toISOString(), step: 15, values: [300, 400, 500] },
    pv: { start: new Date().toISOString(), step: 15, values: [0, 0, 0] },
    importPrice: { start: new Date().toISOString(), step: 15, values: [10, 10, 10] },
    exportPrice: { start: new Date().toISOString(), step: 15, values: [5, 5, 5] },
    soc: { timestamp: new Date().toISOString(), value: 50 },
  })),
}));

import {
  loadSocSamples,
  findClosestSample,
  findLatestSampleAtOrBefore,
  sampleAndStoreSoc,
  getRecentSamples,
  clearSocSamples,
} from '../../../api/services/soc-tracker.ts';
import { _reset, readJson } from '../../../api/services/json-store.ts';
import { loadData } from '../../../api/services/data-store.ts';
import { readVictronSocPercent } from '../../../api/services/mqtt-service.ts';

describe('soc-tracker', () => {
  beforeEach(() => {
    _reset();
    vi.restoreAllMocks();
    readVictronSocPercent.mockResolvedValue(65);
  });

  it('returns empty array when no samples exist', async () => {
    const samples = await loadSocSamples();
    expect(samples).toEqual([]);
  });

  it('loadSocSamples returns empty array for corrupted JSON', async () => {
    readJson.mockRejectedValueOnce(Object.assign(new SyntaxError('Unexpected token'), { code: undefined }));
    await expect(loadSocSamples()).rejects.toThrow(SyntaxError);
  });

  it('sampleAndStoreSoc returns null when MQTT read throws', async () => {
    readVictronSocPercent.mockRejectedValueOnce(new Error('MQTT connection refused'));
    const result = await sampleAndStoreSoc();
    expect(result).toBeNull();
  });

  it('sampleAndStoreSoc returns null when MQTT returns null', async () => {
    readVictronSocPercent.mockResolvedValueOnce(null);
    const result = await sampleAndStoreSoc();
    expect(result).toBeNull();
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

  it('stores the actual measurement timestamp instead of flooring to slot start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:03:00.000Z'));

    const sample = await sampleAndStoreSoc();

    expect(sample).not.toBeNull();
    expect(new Date(sample.timestampMs).toISOString()).toBe('2024-01-01T12:03:00.000Z');

    vi.useRealTimers();
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

describe('findLatestSampleAtOrBefore', () => {
  const samples = [
    { timestampMs: 1000, soc_percent: 50 },
    { timestampMs: 2000, soc_percent: 55 },
    { timestampMs: 3000, soc_percent: 60 },
  ];

  it('returns the latest sample at or before the target', () => {
    const result = findLatestSampleAtOrBefore(samples, 2500, 1000);
    expect(result).toEqual({ timestampMs: 2000, soc_percent: 55 });
  });

  it('returns null when only future samples exist', () => {
    const result = findLatestSampleAtOrBefore(samples, 500, 1000);
    expect(result).toBeNull();
  });

  it('returns null when the latest prior sample is outside max lag', () => {
    const result = findLatestSampleAtOrBefore(samples, 4500, 1000);
    expect(result).toBeNull();
  });
});

describe('sampleAndStoreSoc — persist failure', () => {
  beforeEach(() => {
    _reset();
    vi.restoreAllMocks();
    readVictronSocPercent.mockResolvedValue(65);
  });

  it('logs warning and still returns sample when writeJson rejects', async () => {
    const { writeJson } = await import('../../../api/services/json-store.ts');
    writeJson.mockRejectedValueOnce(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sample = await sampleAndStoreSoc();

    // Sample is returned despite persist failure
    expect(sample).not.toBeNull();
    expect(sample.soc_percent).toBe(65);
    expect(warnSpy).toHaveBeenCalledWith(
      '[soc-tracker] Failed to persist SoC sample:',
      'disk full',
    );

    warnSpy.mockRestore();
  });
});

describe('sampleAndStoreSoc — error paths', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns null when MQTT read throws', async () => {
    readVictronSocPercent.mockRejectedValueOnce(new Error('MQTT connection refused'));
    const sample = await sampleAndStoreSoc();
    expect(sample).toBeNull();
  });

  it('returns null when MQTT returns null SoC', async () => {
    readVictronSocPercent.mockResolvedValueOnce(null);
    const sample = await sampleAndStoreSoc();
    expect(sample).toBeNull();
  });
});

describe('soc-tracker — pruning when over MAX_SAMPLES', () => {
  beforeEach(() => {
    _reset();
    vi.restoreAllMocks();
    readVictronSocPercent.mockResolvedValue(65);
  });

  it('prunes oldest samples when buffer exceeds MAX_SAMPLES (2880)', async () => {
    // Line 30: samples.length > MAX_SAMPLES branch in saveSocSamples
    const MAX_SAMPLES = 30 * 24 * 4; // 2880
    const SAMPLES_PATH = '/tmp/test-data/soc-samples.json';
    const { writeJson } = await import('../../../api/services/json-store.ts');

    // Pre-fill with MAX_SAMPLES entries
    const existing = Array.from({ length: MAX_SAMPLES }, (_, i) => ({
      timestampMs: 1000 + i,
      soc_percent: 50,
    }));
    await writeJson(SAMPLES_PATH, existing);

    // Adding one more sample should trigger pruning
    const sample = await sampleAndStoreSoc();
    expect(sample).not.toBeNull();

    const stored = await loadSocSamples();
    expect(stored).toHaveLength(MAX_SAMPLES);
    // The oldest entry (timestampMs=1000) should have been pruned
    expect(stored[0].timestampMs).toBeGreaterThan(1000);
  });
});

describe('sampleAndStoreSoc — actualLoad_W and actualPv_W', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    // Set current time to align with the start of the series (index 0)
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    readVictronSocPercent.mockResolvedValue(70);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores actualLoad_W from data series at current timestamp', async () => {
    loadData.mockResolvedValue({
      load: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [999, 500] },
      pv: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [200, 0] },
      importPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [5, 5] },
      soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
    });

    const sample = await sampleAndStoreSoc();
    expect(sample).not.toBeNull();
    expect(sample.actualLoad_W).toBe(999);
    expect(sample.actualPv_W).toBe(200);
  });

  it('stores undefined actualLoad_W when timestamp falls outside series range', async () => {
    loadData.mockResolvedValue({
      // Series starts 2 hours in the future — current time is outside range
      load: { start: '2024-01-01T02:00:00.000Z', step: 15, values: [300] },
      pv: { start: '2024-01-01T02:00:00.000Z', step: 15, values: [0] },
      importPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [10] },
      exportPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [5] },
      soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
    });

    const sample = await sampleAndStoreSoc();
    expect(sample).not.toBeNull();
    expect(sample.actualLoad_W).toBeUndefined();
  });

  it('sampleAndStoreSoc stores actualLoad_W and actualPv_W from data', async () => {
    loadData.mockResolvedValue({
      load: { start: '2024-01-01T00:00:00.000Z', step: 15, values: Array(96).fill(500) },
      pv: { start: '2024-01-01T00:00:00.000Z', step: 15, values: Array(96).fill(200) },
      importPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: Array(96).fill(10) },
      exportPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: Array(96).fill(5) },
      soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
    });

    const sample = await sampleAndStoreSoc();
    expect(sample).not.toBeNull();
    expect(sample.actualLoad_W).toBe(500);
    expect(sample.actualPv_W).toBe(200);
  });
});

describe('getRecentSamples', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-10T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('filters samples by the given number of days', async () => {
    // Seed samples: one old (8 days ago) and two recent (within 7 days)
    const now = new Date('2024-01-10T00:00:00.000Z').getTime();
    const SAMPLES_PATH = '/tmp/test-data/soc-samples.json';
    const { writeJson } = await import('../../../api/services/json-store.ts');
    await writeJson(SAMPLES_PATH, [
      { timestampMs: now - 8 * 24 * 60 * 60_000, soc_percent: 40 },
      { timestampMs: now - 3 * 24 * 60 * 60_000, soc_percent: 55 },
      { timestampMs: now - 1 * 24 * 60 * 60_000, soc_percent: 70 },
    ]);

    const recent = await getRecentSamples(7);
    expect(recent).toHaveLength(2);
    expect(recent[0].soc_percent).toBe(55);
    expect(recent[1].soc_percent).toBe(70);
  });

  it('returns empty array when all samples are older than the cutoff', async () => {
    const now = new Date('2024-01-10T00:00:00.000Z').getTime();
    const SAMPLES_PATH = '/tmp/test-data/soc-samples.json';
    const { writeJson } = await import('../../../api/services/json-store.ts');
    await writeJson(SAMPLES_PATH, [
      { timestampMs: now - 30 * 24 * 60 * 60_000, soc_percent: 40 },
    ]);

    const recent = await getRecentSamples(7);
    expect(recent).toHaveLength(0);
  });

  it('clearSocSamples writes empty array and clears all samples', async () => {
    const SAMPLES_PATH = '/tmp/test-data/soc-samples.json';
    const { writeJson } = await import('../../../api/services/json-store.ts');
    await writeJson(SAMPLES_PATH, [
      { timestampMs: Date.now(), soc_percent: 50 },
    ]);

    await clearSocSamples();

    const samples = await loadSocSamples();
    expect(samples).toEqual([]);
  });
});
