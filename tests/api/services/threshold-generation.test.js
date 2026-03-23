import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies so the module can be imported without real I/O
const mockSnapshots = [];
const mockSamples = [];
let mockCalibration = null;
// writeJson mock captures saved data via mockCalibration directly

vi.mock('../../../api/services/plan-history-store.ts', () => ({
  getRecentSnapshots: vi.fn(async () => mockSnapshots),
}));

vi.mock('../../../api/services/soc-tracker.ts', () => ({
  loadSocSamples: vi.fn(async () => mockSamples),
  findClosestSample: vi.fn((samples, targetMs, toleranceMs = 10 * 60_000) => {
    let best = null;
    let bestDist = Infinity;
    for (const s of samples) {
      const dist = Math.abs(s.timestampMs - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    return best && bestDist <= toleranceMs ? best : null;
  }),
}));

vi.mock('../../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/tmp/test-data',
  readJson: vi.fn(async () => {
    if (mockCalibration === null) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return mockCalibration;
  }),
  writeJson: vi.fn(async (_path, data) => {
    mockCalibration = data;
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    unlink: vi.fn(async () => {}),
  };
});

import { generateThresholdsFromCurve, calibrate } from '../../../api/services/efficiency-calibrator.ts';

/** Helper: create a flat curve of length 100 filled with a single value. */
function flatCurve(value = 1.0) {
  return new Array(100).fill(value);
}

/** Helper: create a sample-count array of length 100 filled with a single value. */
function flatSamples(count = 10) {
  return new Array(100).fill(count);
}

describe('generateThresholdsFromCurve', () => {
  it('returns no thresholds for a flat curve (all 1.0)', () => {
    const result = generateThresholdsFromCurve(
      flatCurve(1.0),
      flatSamples(10),
      3600,
      'charge',
    );
    expect(result).toEqual([]);
  });

  it('generates charge thresholds for a gradual decline', () => {
    // Curve drops linearly from 1.0 at SoC 0 to 0.7 at SoC 99
    const curve = Array.from({ length: 100 }, (_, i) => 1.0 - (i / 99) * 0.3);
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      3600,
      'charge',
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(8);
    // Charge thresholds should be ascending by soc_percent
    for (let i = 1; i < result.length; i++) {
      expect(result[i].soc_percent).toBeGreaterThanOrEqual(result[i - 1].soc_percent);
    }
    // Each threshold power should be less than basePower
    for (const t of result) {
      expect(t.power_W).toBeLessThan(3600);
      expect(t.power_W).toBeGreaterThan(0);
    }
  });

  it('generates thresholds for a steep cliff at 91%', () => {
    // Flat at 1.0 until SoC 91, then drops to 0.6
    // Segment boundaries (width=13): 0-12, 13-25, 26-38, 39-51, 52-64, 65-77, 78-90, 91-99
    // Only segment 7 (91-99) is entirely below 0.95
    const curve = Array.from({ length: 100 }, (_, i) => (i >= 91 ? 0.6 : 1.0));
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      3600,
      'charge',
    );
    expect(result.length).toBe(1);
    // Threshold at segment 7 boundary (soc 91)
    expect(result[0].soc_percent).toBe(91);
    expect(result[0].power_W).toBe(Math.round(3600 * 0.6));
  });

  it('returns no thresholds when sample counts are below minSamples', () => {
    // Curve has low values but no data to back them
    const curve = flatCurve(0.5);
    const samples = new Array(100).fill(0); // zero samples
    const result = generateThresholdsFromCurve(curve, samples, 3600, 'charge', 2);
    expect(result).toEqual([]);
  });

  it('returns no thresholds when sample counts are 1 and minSamples is 2', () => {
    const curve = flatCurve(0.5);
    const samples = new Array(100).fill(1);
    const result = generateThresholdsFromCurve(curve, samples, 3600, 'charge', 2);
    expect(result).toEqual([]);
  });

  it('generates thresholds across the range when all bands are below 0.95, capped at 8', () => {
    const curve = flatCurve(0.7);
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      4000,
      'charge',
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(8);
    for (const t of result) {
      expect(t.power_W).toBe(Math.round(4000 * 0.7));
    }
  });

  it('sorts discharge thresholds in descending soc_percent order', () => {
    // Curve drops at low SoC for discharge
    const curve = Array.from({ length: 100 }, (_, i) => (i < 25 ? 0.6 : 1.0));
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      4000,
      'discharge',
    );
    expect(result.length).toBeGreaterThan(0);
    // Descending order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].soc_percent).toBeLessThanOrEqual(result[i - 1].soc_percent);
    }
  });

  it('only produces thresholds for bands with sufficient samples (mixed)', () => {
    // Segment boundaries (width=13): 0-12, 13-25, 26-38, 39-51, 52-64, 65-77, 78-90, 91-99
    // Place data only in segment 4 (bands 52-64)
    const curve = flatCurve(0.7);
    const samples = new Array(100).fill(0);
    for (let i = 52; i < 65; i++) samples[i] = 10;
    const result = generateThresholdsFromCurve(
      curve,
      samples,
      3600,
      'charge',
    );
    expect(result.length).toBe(1);
    // Charge threshold boundary is at segment start (52)
    expect(result[0].soc_percent).toBe(52);
    expect(result[0].power_W).toBe(Math.round(3600 * 0.7));
  });

  it('computes power_W as basePower_W * curveValue for each threshold', () => {
    // Different ratios per segment
    const curve = new Array(100).fill(1.0);
    // Segment 0 (0-12): ratio 0.8
    for (let i = 0; i < 13; i++) curve[i] = 0.8;
    // Segment 6 (78-90): ratio 0.6
    for (let i = 78; i < 91; i++) curve[i] = 0.6;

    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      5000,
      'charge',
    );
    expect(result.length).toBe(2);
    // First threshold (lower SoC segment)
    expect(result[0].power_W).toBe(Math.round(5000 * 0.8));
    // Second threshold (higher SoC segment)
    expect(result[1].power_W).toBe(Math.round(5000 * 0.6));
  });

  it('limits output to max 8 thresholds when more candidates exist', () => {
    // Force all 8 segments to have reductions — they should all appear (exactly 8)
    // Then verify it doesn't exceed 8 even with varied data
    const curve = flatCurve(0.7);
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      3600,
      'charge',
    );
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('clamps power_W to minimum rate * basePower', () => {
    // Curve at the minimum clamp (0.50)
    const curve = flatCurve(0.3); // below MIN_RATE of 0.50
    const result = generateThresholdsFromCurve(
      curve,
      flatSamples(10),
      3600,
      'charge',
    );
    for (const t of result) {
      // Should be clamped to 0.50 * 3600 = 1800
      expect(t.power_W).toBe(Math.round(3600 * 0.50));
    }
  });

  it('uses custom minSamples parameter', () => {
    const curve = flatCurve(0.7);
    const samples = new Array(100).fill(3);
    // With minSamples=5, all bands fail
    const result = generateThresholdsFromCurve(curve, samples, 3600, 'charge', 5);
    expect(result).toEqual([]);
  });
});

describe('calibrate() confidence denominator change', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
  });

  it('computes confidence as totalSamples / 500', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 50 + i * 5,
        chargePower_W: 3000,
        dischargePower_W: 0,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 0,
      });
    }
    mockSnapshots.push({
      planId: 'plan-confidence',
      createdAtMs: base,
      initialSoc_percent: 50,
      slots,
      config: {
        chargeEfficiency_percent: 95,
        dischargeEfficiency_percent: 95,
        maxChargePower_W: 3600,
        maxDischargePower_W: 4000,
        batteryCapacity_Wh: 20480,
        idleDrain_W: 40,
        stepSize_m: 15,
      },
    });

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    // 9 valid slots (i=1..9), so sampleCount=9
    // confidence = min(1.0, 9/500) = 0.018 → rounded to 0.02
    expect(result.sampleCount).toBe(9);
    expect(result.confidence).toBe(Math.round(Math.min(1.0, 9 / 500) * 100) / 100);
    // With old /100 denominator this would have been 0.09, so verify it's much smaller
    expect(result.confidence).toBeLessThan(0.05);
  });
});
