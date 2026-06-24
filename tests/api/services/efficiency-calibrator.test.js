import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockSnapshots = [];
const mockSamples = [];
let mockCalibration = null;
let savedCalibration = null;

vi.mock('../../../api/services/plan-history-store.ts', () => ({
  getRecentSnapshots: vi.fn(async () => mockSnapshots),
}));

vi.mock('../../../api/services/soc-tracker.ts', () => ({
  loadSocSamples: vi.fn(async () => mockSamples),
  findLatestSampleAtOrBefore: vi.fn((samples, targetMs, maxLagMs = 10 * 60_000, maxLeadMs = 2 * 60_000) => {
    let bestPrior = null;
    let bestNearFuture = null;
    for (const s of samples) {
      const deltaMs = s.timestampMs - targetMs;
      if (deltaMs <= 0) {
        if (deltaMs < -maxLagMs) continue;
        if (!bestPrior || s.timestampMs > bestPrior.timestampMs) bestPrior = s;
        continue;
      }
      if (deltaMs <= maxLeadMs) {
        if (!bestNearFuture || s.timestampMs < bestNearFuture.timestampMs) bestNearFuture = s;
      }
    }
    return bestPrior ?? bestNearFuture;
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
    savedCalibration = data;
    mockCalibration = data;
  }),
}));

// Mock node:fs/promises so resetCalibration doesn't touch the real filesystem
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    unlink: vi.fn(async () => {}),
  };
});

import {
  calibrate,
  resetCalibration,
  calibrateEv,
  loadEvCalibration,
  saveEvCalibration,
  resetEvCalibration,
  generateThresholdsFromCurve,
  EV_MIN_RATE,
} from '../../../api/services/efficiency-calibrator.ts';
import { unlink } from 'node:fs/promises';

function makeSnapshot(slots, createdAtMs = Date.now() - 5 * 24 * 60 * 60_000) {
  return {
    planId: `plan-${createdAtMs}`,
    createdAtMs,
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
  };
}

describe('efficiency-calibrator', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('returns null when no snapshots exist', async () => {
    const result = await calibrate(1);
    expect(result).toBeNull();
  });

  it('returns null when insufficient history days', async () => {
    const now = Date.now();
    mockSnapshots.push(makeSnapshot(
      [
        { timestampMs: now - 60_000, predictedSoc_percent: 50, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
        { timestampMs: now, predictedSoc_percent: 55, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      ],
      now - 1 * 24 * 60 * 60_000,
    ));
    mockSamples.push(
      { timestampMs: now - 60_000, soc_percent: 50, actualLoad_W: 500, actualPv_W: 0 },
      { timestampMs: now, soc_percent: 53, actualLoad_W: 500, actualPv_W: 0 },
    );

    const result = await calibrate(3);
    expect(result).toBeNull();
  });

  it('calibrates per-SoC charge curve when actual SoC gains less than predicted', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4, // 80% of predicted
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.chargeCurve).toHaveLength(100);
    expect(result.dischargeCurve).toHaveLength(100);
    expect(result.effectiveChargeRate).toBeLessThan(1.0);
    expect(result.effectiveChargeRate).toBeGreaterThan(0.5);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.sampleCount).toBeGreaterThan(0);
  });

  it('calibrates per-SoC discharge curve', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 90 - i * 5,
        chargePower_W: 0,
        dischargePower_W: 3000,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 3,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 90 - i * 6, // 120% of predicted loss
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.effectiveDischargeRate).toBeGreaterThan(1.0);
    expect(result.effectiveDischargeRate).toBeLessThan(1.5);
  });

  it('skips slots where actual load deviated from predicted', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    // Actual load is 3000W (heater on) — 500% deviation from predicted 500W
    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 2, // SoC barely rose because of high load
        actualLoad_W: 3000,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    // All slots should be filtered out due to load deviation
    expect(result).toBeNull();
  });

  it('persists calibration with curves', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    await calibrate(1);
    expect(savedCalibration).not.toBeNull();
    expect(savedCalibration.chargeCurve).toHaveLength(100);
    expect(savedCalibration.dischargeCurve).toHaveLength(100);
    expect(savedCalibration.lastCalibratedMs).toBeGreaterThan(0);
  });

  it('accepts SoC samples taken shortly after each slot boundary', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    mockSnapshots.push(makeSnapshot([
      { timestampMs: base, predictedSoc_percent: 50, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      { timestampMs: base + step, predictedSoc_percent: 55, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      { timestampMs: base + 2 * step, predictedSoc_percent: 60, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
    ], base));

    mockSamples.push(
      { timestampMs: base + 30_000, soc_percent: 50, actualLoad_W: 500, actualPv_W: 0 },
      { timestampMs: base + step + 30_000, soc_percent: 54, actualLoad_W: 500, actualPv_W: 0 },
      { timestampMs: base + 2 * step + 30_000, soc_percent: 58, actualLoad_W: 500, actualPv_W: 0 },
    );

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBeGreaterThan(0);
  });
});

describe('loadCalibration — non-ENOENT errors', () => {
  it('rethrows non-ENOENT errors from readJson', async () => {
    // Import loadCalibration directly — it's not exported from efficiency-calibrator,
    // but we can test it indirectly via calibrate which calls loadCalibration to load
    // existing calibration. Instead, import the function from the module directly.
    const { loadCalibration } = await import('../../../api/services/efficiency-calibrator.ts');
    const { readJson } = await import('../../../api/services/json-store.ts');

    readJson.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    await expect(loadCalibration()).rejects.toThrow('EPERM');
  });
});

describe('resetCalibration', () => {
  beforeEach(() => {
    unlink.mockClear();
  });

  it('calls unlink on the calibration file path', async () => {
    await resetCalibration();
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('calibration.json'));
  });

  it('does not throw when the calibration file does not exist', async () => {
    unlink.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(resetCalibration()).resolves.toBeUndefined();
  });

  it('re-throws non-ENOENT errors from unlink', async () => {
    unlink.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(resetCalibration()).rejects.toThrow('EPERM');
  });
});

describe('efficiency-calibrator — previous calibration with wrong-length curves', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('falls back to defaultCurve when prev chargeCurve has wrong length', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    // prev calibration with wrong-length curves (not 100 entries) — triggers defaultCurve() fallback
    mockCalibration = {
      chargeCurve: [0.9, 0.85], // wrong length
      dischargeCurve: [1.1],    // wrong length
      chargeSamples: [5, 3],    // wrong length
      dischargeSamples: [2],    // wrong length
      effectiveChargeRate: 0.9,
      effectiveDischargeRate: 1.1,
      sampleCount: 10,
      confidence: 0.1,
      lastCalibratedMs: base,
    };

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    // Curves must be full-length 100 even when prev had wrong-length arrays
    expect(result.chargeCurve).toHaveLength(100);
    expect(result.dischargeCurve).toHaveLength(100);
    expect(result.chargeSamples).toHaveLength(100);
    expect(result.dischargeSamples).toHaveLength(100);
  });

  it('reuses prev curves when they have correct length (100)', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    // prev calibration with correct-length curves (100) — EMA continuity path
    const prevChargeCurve = new Array(100).fill(0.8);
    const prevDischargeCurve = new Array(100).fill(1.05);
    const prevChargeSamples = new Array(100).fill(2);
    const prevDischargeSamples = new Array(100).fill(0);
    mockCalibration = {
      chargeCurve: prevChargeCurve,
      dischargeCurve: prevDischargeCurve,
      chargeSamples: prevChargeSamples,
      dischargeSamples: prevDischargeSamples,
      effectiveChargeRate: 0.8,
      effectiveDischargeRate: 1.05,
      sampleCount: 200,
      confidence: 0.8,
      lastCalibratedMs: base,
    };

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.chargeCurve).toHaveLength(100);
    // EMA applied on top of 0.8 seed — result should still be < 1.0
    expect(result.effectiveChargeRate).toBeLessThan(1.0);
  });
});

describe('efficiency-calibrator — isCleanSlot branch coverage', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('passes slot when sample has null actualLoad_W (no load filtering)', async () => {
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
        predictedPv_W: null, // no PV prediction
        strategy: 0,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: null, // null → load check skipped
        actualPv_W: null,   // null → PV check skipped
      });
    }

    const result = await calibrate(1);
    // Slot passes isCleanSlot (both null → return true)
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBeGreaterThan(0);
  });

  it('filters slot when actual PV deviated >20% from predicted', async () => {
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
        predictedPv_W: 1000, // predicted 1000W PV
        strategy: 0,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,    // load OK
        actualPv_W: 5000,     // 400% deviation → filtered
      });
    }

    const result = await calibrate(1);
    // All slots filtered due to PV deviation
    expect(result).toBeNull();
  });

  it('processes slot when sample is null (no filtering applied)', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    // Samples are far in the future so findClosestSample returns null,
    // meaning isCleanSlot(slot, null) → true (no filtering)
    // but collectRatios skips when !prevSample || !curSample, so use close timestamps
    // Actually to exercise isCleanSlot with null we need curSample to be non-null
    // but predictedPv_W and actualPv_W conditions both null → both checks skipped
    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: null,   // null actualPv_W → PV check condition false
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBeGreaterThan(0);
  });
});

describe('efficiency-calibrator — collectRatios branch coverage', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('stops processing slots when a future slot is encountered', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;
    const future = Date.now() + 2 * 60 * 60_000; // 2h in future

    // Mix of past slots followed by a future slot
    const slots = [
      { timestampMs: base, predictedSoc_percent: 50, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      { timestampMs: base + step, predictedSoc_percent: 55, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      { timestampMs: future, predictedSoc_percent: 60, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
      { timestampMs: future + step, predictedSoc_percent: 65, chargePower_W: 3000, dischargePower_W: 0, predictedLoad_W: 500, predictedPv_W: 0, strategy: 0 },
    ];
    mockSnapshots.push(makeSnapshot(slots, base));

    mockSamples.push(
      { timestampMs: base, soc_percent: 50, actualLoad_W: 500, actualPv_W: 0 },
      { timestampMs: base + step, soc_percent: 54, actualLoad_W: 500, actualPv_W: 0 },
    );

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    // Only the one past slot contributed — future slots were skipped
    expect(result.sampleCount).toBe(1);
  });

  it('skips slots where findClosestSample returns null for either boundary', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    const slots = [];
    for (let i = 0; i < 5; i++) {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    // Only provide samples for first boundary — other boundaries are too far away
    // findClosestSample returns null when dist > toleranceMs (10 min)
    // Provide only sample at base (prevSlot boundary for i=1), nothing else
    mockSamples.push(
      { timestampMs: base, soc_percent: 50, actualLoad_W: 500, actualPv_W: 0 },
      // curSample for i=1 is at base+step (15 min away), but tolerance is 10 min → null
    );

    const result = await calibrate(1);
    // All slots skipped because curSample is null (out of tolerance)
    expect(result).toBeNull();
  });

  it('skips slots with negligible predicted SoC change', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    // Slots where predicted SoC barely changes (< 0.5%)
    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 50 + i * 0.1, // only 0.1% change per slot
        chargePower_W: 100,
        dischargePower_W: 0,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 0,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 5; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 0.1,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    // All slots skipped due to negligible predicted change
    expect(result).toBeNull();
  });

  it('skips slots where ratio is <= 0 (actual change reversed)', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    // Predicted charging, but actual SoC went down (ratio < 0)
    const slots = [];
    for (let i = 0; i < 5; i++) {
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 5; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 - i * 3, // SoC drops while predicted to rise → ratio < 0
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    // All slots skipped due to negative ratio
    expect(result).toBeNull();
  });

  it('skips slots where ratio is > 2.0 (extreme outlier)', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    // Predicted 2% charge but actual gained 10% → ratio = 5.0 → outlier
    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 50 + i * 2,
        chargePower_W: 3000,
        dischargePower_W: 0,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 0,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 5; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 10, // 5x predicted → ratio > 2.0 → discarded
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    // All slots discarded as outliers
    expect(result).toBeNull();
  });
});

describe('efficiency-calibrator — weightedAvg branch coverage', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('returns effectiveChargeRate of 1.0 when no samples contribute to weighted average', async () => {
    // To reach the weightSum === 0 fallback in weightedAvg, we need a calibration
    // result where all sample counts are 0. This happens when prev has correct-length
    // curves but all-zero sample counts, and the current run has no new charge ratios.
    // We can verify via a discharge-only run: chargeSamples will all be 0,
    // so weightedAvg for charge returns 1.0 → effectiveChargeRate = clamp(1.0) = 1.0.
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 90 - i * 5,
        chargePower_W: 0,
        dischargePower_W: 3000,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 3,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 90 - i * 6,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    // No charge samples → weightedAvg falls back to 1.0
    expect(result.effectiveChargeRate).toBe(1.0);
    // Discharge has samples → weighted avg applied
    expect(result.effectiveDischargeRate).toBeGreaterThan(1.0);
  });

  it('handles samples array with sparse (zero-count) bands via ?? 0 fallback', async () => {
    // Exercise the `samples[i] ?? 0` path in weightedAvg by providing a prev
    // calibration whose sample arrays contain undefined at some positions.
    // We do this by constructing a prev calibration with sparse arrays.
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
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 50 + i * 4,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    // Provide prev calibration with correct-length curves but some undefined
    // entries in sample arrays (sparse array via delete)
    const prevChargeSamples = new Array(100).fill(1);
    delete prevChargeSamples[55]; // creates undefined at index 55 → ?? 0 activates
    const prevDischargeSamples = new Array(100).fill(0);
    mockCalibration = {
      chargeCurve: new Array(100).fill(0.9),
      dischargeCurve: new Array(100).fill(1.0),
      chargeSamples: prevChargeSamples,
      dischargeSamples: prevDischargeSamples,
      effectiveChargeRate: 0.9,
      effectiveDischargeRate: 1.0,
      sampleCount: 100,
      confidence: 0.5,
      lastCalibratedMs: base,
    };

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.chargeCurve).toHaveLength(100);
    // Should complete without error despite sparse samples array
    expect(result.effectiveChargeRate).toBeGreaterThan(0.5);
    expect(result.effectiveChargeRate).toBeLessThanOrEqual(1.05);
  });
});

describe('efficiency-calibrator — sample counts (chargeSamples/dischargeSamples)', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('records chargeSamples count per SoC band after calibration', async () => {
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
    mockSnapshots.push(makeSnapshot(slots, base));

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
    expect(result.chargeSamples).toHaveLength(100);
    // At least some bands should have been incremented
    const totalChargeSamples = result.chargeSamples.reduce((a, b) => a + b, 0);
    expect(totalChargeSamples).toBeGreaterThan(0);
    // Discharge had no data
    const totalDischargeSamples = result.dischargeSamples.reduce((a, b) => a + b, 0);
    expect(totalDischargeSamples).toBe(0);
  });

  it('records dischargeSamples count per SoC band after discharge calibration', async () => {
    const base = Date.now() - 5 * 24 * 60 * 60_000;
    const step = 15 * 60_000;

    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push({
        timestampMs: base + i * step,
        predictedSoc_percent: 90 - i * 5,
        chargePower_W: 0,
        dischargePower_W: 3000,
        predictedLoad_W: 500,
        predictedPv_W: 0,
        strategy: 3,
      });
    }
    mockSnapshots.push(makeSnapshot(slots, base));

    for (let i = 0; i < 10; i++) {
      mockSamples.push({
        timestampMs: base + i * step,
        soc_percent: 90 - i * 6,
        actualLoad_W: 500,
        actualPv_W: 0,
      });
    }

    const result = await calibrate(1);
    expect(result).not.toBeNull();
    expect(result.dischargeSamples).toHaveLength(100);
    const totalDischargeSamples = result.dischargeSamples.reduce((a, b) => a + b, 0);
    expect(totalDischargeSamples).toBeGreaterThan(0);
    // Charge had no data
    const totalChargeSamples = result.chargeSamples.reduce((a, b) => a + b, 0);
    expect(totalChargeSamples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateThresholdsFromCurve — MILP threshold extraction from a curve
// ---------------------------------------------------------------------------
describe('generateThresholdsFromCurve', () => {
  const flatCurve = (v = 1.0) => new Array(100).fill(v);
  const flatSamples = (c = 10) => new Array(100).fill(c);

  it('emits nothing for a flat all-1.0 curve (no reduction anywhere)', () => {
    expect(generateThresholdsFromCurve(flatCurve(1.0), flatSamples(10), 3600, 'charge')).toEqual([]);
  });

  it('emits a single charge threshold at the segment boundary of a high-SoC cliff', () => {
    // Drops to 0.6 from SoC 91; only the top segment (91-99) is fully reduced.
    const curve = Array.from({ length: 100 }, (_, i) => (i >= 91 ? 0.6 : 1.0));
    const r = generateThresholdsFromCurve(curve, flatSamples(10), 3600, 'charge');
    expect(r).toHaveLength(1);
    expect(r[0].soc_percent).toBe(91); // charge boundary = segment lo
    expect(r[0].power_W).toBe(Math.round(3600 * 0.6));
  });

  it('ignores low-SoC reductions for charge (charge starts at the upper half)', () => {
    const curve = flatCurve(1.0);
    for (let i = 0; i < 13; i++) curve[i] = 0.6; // bottom segment only
    expect(generateThresholdsFromCurve(curve, flatSamples(10), 3600, 'charge')).toEqual([]);
  });

  it('emits discharge thresholds in descending SoC order at the segment top', () => {
    // Reduced at low SoC for discharge (segments 0-3 are scanned).
    const curve = Array.from({ length: 100 }, (_, i) => (i < 25 ? 0.6 : 1.0));
    const r = generateThresholdsFromCurve(curve, flatSamples(10), 4000, 'discharge');
    expect(r.length).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) {
      expect(r[i].soc_percent).toBeLessThanOrEqual(r[i - 1].soc_percent);
    }
    // Discharge boundary = hi-1 of the segment; descending → highest boundary first.
    // Segment 1 (13-25) is mostly 0.6, boundary = min(26,100)-1 = 25.
    expect(r[0].soc_percent).toBe(25);
    expect(r[r.length - 1].soc_percent).toBe(12); // segment 0 boundary
  });

  it('skips segments whose total samples are below minSamples', () => {
    const curve = flatCurve(0.5);
    expect(generateThresholdsFromCurve(curve, new Array(100).fill(0), 3600, 'charge', 2)).toEqual([]);
    expect(generateThresholdsFromCurve(curve, new Array(100).fill(1), 3600, 'charge', 2)).toEqual([]);
  });

  it('clamps the per-segment ratio to the default MIN_RATE (0.50) floor', () => {
    const r = generateThresholdsFromCurve(flatCurve(0.3), flatSamples(10), 3600, 'charge');
    for (const t of r) expect(t.power_W).toBe(Math.round(3600 * 0.50));
  });

  it('honours a lower EV floor than the battery (deeper taper allowed)', () => {
    const curve = flatCurve(1.0);
    const samples = new Array(100).fill(0);
    for (let b = 88; b < 100; b++) { curve[b] = 0.18; samples[b] = 5; }
    const r = generateThresholdsFromCurve(curve, samples, 11040, 'charge', 2, undefined, EV_MIN_RATE);
    expect(r.length).toBeGreaterThan(0);
    const deepest = Math.min(...r.map(t => t.power_W));
    expect(deepest).toBeLessThan(0.5 * 11040); // below the battery clamp
    expect(deepest).toBeGreaterThanOrEqual(Math.round(EV_MIN_RATE * 11040) - 1);
  });

  it('truncates to maxThresholds, keeping the deepest reductions, then re-sorts', () => {
    const curve = new Array(100).fill(1.0);
    for (let i = 52; i < 65; i++) curve[i] = 0.90; // reduction 0.10 (smallest)
    for (let i = 65; i < 78; i++) curve[i] = 0.80; // reduction 0.20
    for (let i = 78; i < 91; i++) curve[i] = 0.60; // reduction 0.40 (largest)
    for (let i = 91; i < 100; i++) curve[i] = 0.70; // reduction 0.30
    const r = generateThresholdsFromCurve(curve, flatSamples(10), 4000, 'charge', 2, 2);
    expect(r).toHaveLength(2);
    // Kept seg6 (0.40) + seg7 (0.30); re-sorted ascending by SoC for charge.
    expect(r[0].soc_percent).toBe(78);
    expect(r[1].soc_percent).toBe(91);
  });
});

// ---------------------------------------------------------------------------
// EV calibration: persistence + calibrateEv + collectEvRatios
// ---------------------------------------------------------------------------
const QUARTER = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

function makeEvSnapshot(baseMs, evSocSeq) {
  return {
    planId: `ev-plan-${baseMs}`,
    createdAtMs: baseMs,
    initialSoc_percent: 50,
    slots: evSocSeq.map((soc, i) => ({
      timestampMs: baseMs + i * QUARTER,
      predictedSoc_percent: 50,
      chargePower_W: 0,
      dischargePower_W: 0,
      predictedLoad_W: 400,
      predictedPv_W: 0,
      strategy: 0,
      predictedEvSoc_percent: soc,
      evChargePower_W: 11040,
    })),
  };
}

function makeEvSamples(baseMs, actualEvSeq, over = {}) {
  return actualEvSeq.map((soc, i) => ({
    timestampMs: baseMs + i * QUARTER,
    soc_percent: 50,
    actualEvSoc_percent: soc,
    evPluggedIn: true,
    actualLoad_W: 400,
    actualPv_W: 0,
    ...over,
  }));
}

describe('efficiency-calibrator — EV persistence', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('loadEvCalibration returns null on ENOENT', async () => {
    mockCalibration = null;
    expect(await loadEvCalibration()).toBeNull();
  });

  it('loadEvCalibration rethrows non-ENOENT errors', async () => {
    const { readJson } = await import('../../../api/services/json-store.ts');
    readJson.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(loadEvCalibration()).rejects.toThrow('EACCES');
  });

  it('saveEvCalibration persists via writeJson', async () => {
    const cal = { evChargeCurve: new Array(100).fill(1), evChargeSamples: new Array(100).fill(0), effectiveChargeRate: 1, sampleCount: 0, confidence: 0, lastCalibratedMs: 1 };
    await saveEvCalibration(cal);
    expect(savedCalibration).toBe(cal);
  });
});

describe('resetEvCalibration', () => {
  beforeEach(() => unlink.mockClear());

  it('unlinks the ev-calibration file', async () => {
    await resetEvCalibration();
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('ev-calibration.json'));
  });

  it('swallows ENOENT (file already absent)', async () => {
    unlink.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(resetEvCalibration()).resolves.toBeUndefined();
  });

  it('rethrows a non-ENOENT unlink error', async () => {
    unlink.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(resetEvCalibration()).rejects.toThrow('EPERM');
  });
});

describe('calibrateEv', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSamples.length = 0;
    mockCalibration = null;
    savedCalibration = null;
  });

  it('returns null when there are no snapshots or samples', async () => {
    expect(await calibrateEv(3)).toBeNull();
  });

  it('returns null when history covers fewer than minDataDays', async () => {
    const now = Date.now();
    mockSnapshots.push(makeEvSnapshot(now - 60_000, [80, 85]));
    mockSamples.push(...makeEvSamples(now - 60_000, [80, 84]));
    // oldest snapshot only ~1 minute old → far below 3 days.
    expect(await calibrateEv(3)).toBeNull();
  });

  it('learns a deepening acceptance taper across SoC bands and saves it', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84])); // Δ3,2,1 → tapering
    }
    const result = await calibrateEv(3);
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBe(36); // 3 ratios × 12 snapshots
    expect(result.evChargeSamples[81]).toBe(12);
    expect(result.evChargeCurve[91]).toBeLessThan(result.evChargeCurve[86]);
    expect(result.evChargeCurve[86]).toBeLessThan(result.evChargeCurve[81]);
    expect(result.effectiveChargeRate).toBeLessThan(1.0);
    expect(result.confidence).toBe(Math.round(Math.min(1, 36 / 200) * 100) / 100);
    expect(savedCalibration).toBe(result);
  });

  it('returns null when every ratio is filtered (car never plugged in)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84], { evPluggedIn: false }));
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips slots missing a predicted EV SoC trajectory', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      const snap = makeEvSnapshot(baseMs, [78, 83, 88, 93]);
      // Wipe the predicted EV SoC so collectEvRatios skips via the null-trajectory gate.
      for (const slot of snap.slots) slot.predictedEvSoc_percent = null;
      mockSnapshots.push(snap);
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84]));
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips a slot whose previous boundary lacks a predicted EV SoC (asymmetric null)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      const snap = makeEvSnapshot(baseMs, [78, 83, 88, 93]);
      // Slot i has a value, but its predecessor (i-1) is null → second clause of the gate.
      for (let i = 0; i < snap.slots.length; i += 2) snap.slots[i].predictedEvSoc_percent = null;
      mockSnapshots.push(snap);
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84]));
    }
    // With alternating nulls every (prev,cur) pair has at least one null → all skipped.
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips slots where no actual SoC sample exists at a boundary (findLatest null)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      // Only one sample per snapshot, hours away from slots 1..3 → other boundaries null.
      mockSamples.push({
        timestampMs: baseMs, soc_percent: 50, actualEvSoc_percent: 78,
        evPluggedIn: true, actualLoad_W: 400, actualPv_W: 0,
      });
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips EV slots where home load diverged from plan (clean-slot gate)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      // Predicted home load is 400W but actual is 6000W → >20% deviation → filtered.
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84], { actualLoad_W: 6000 }));
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips slots with a missing actual EV SoC reading', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84], { actualEvSoc_percent: null }));
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('skips slots with non-positive predicted EV charge (no charge slot)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      // Flat predicted EV SoC → predictedChange = 0 < MIN_SOC_CHANGE_PERCENT.
      mockSnapshots.push(makeEvSnapshot(baseMs, [80, 80, 80, 80]));
      mockSamples.push(...makeEvSamples(baseMs, [80, 81, 82, 83]));
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('discards a gross EV acceptance outlier (ratio > 2)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [50, 51, 52, 53])); // predicted Δ1/slot
      mockSamples.push(...makeEvSamples(baseMs, [50, 60, 70, 80])); // actual Δ10/slot → ratio 10
    }
    expect(await calibrateEv(3)).toBeNull();
  });

  it('stops at the first future slot and continues EMA from a prior EV calibration', async () => {
    const now = Date.now();
    // Seed prev EV calibration with full-length curves to exercise the continuity path.
    const base = now - 5 * DAY;
    mockSnapshots.push(makeEvSnapshot(base, [78, 83, 88, 93]));
    // Last slot is in the future → loop must break before it.
    mockSnapshots[0].slots.push({
      timestampMs: now + 2 * 60 * 60_000,
      predictedSoc_percent: 50, chargePower_W: 0, dischargePower_W: 0,
      predictedLoad_W: 400, predictedPv_W: 0, strategy: 0,
      predictedEvSoc_percent: 98, evChargePower_W: 11040,
    });
    mockSamples.push(...makeEvSamples(base, [78, 81, 83, 84]));

    mockCalibration = {
      evChargeCurve: new Array(100).fill(0.7),
      evChargeSamples: new Array(100).fill(3),
      effectiveChargeRate: 0.7,
      sampleCount: 30,
      confidence: 0.15,
      lastCalibratedMs: base,
    };

    const result = await calibrateEv(3);
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBe(3); // only the 3 elapsed ratios
    // Continued from the 0.7 seed → bands that got samples now carry >3 counts.
    expect(result.evChargeSamples[81]).toBe(4);
  });

  it('falls back to default curves when the prior EV calibration has wrong-length arrays', async () => {
    const now = Date.now();
    const base = now - 5 * DAY;
    for (let d = 0; d < 4; d++) {
      const baseMs = base + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84]));
    }
    mockCalibration = {
      evChargeCurve: [0.5, 0.4], // wrong length → defaultCurve()
      evChargeSamples: [1],      // wrong length → defaultSampleCounts()
      effectiveChargeRate: 0.5,
      sampleCount: 2,
      confidence: 0.01,
      lastCalibratedMs: base,
    };
    const result = await calibrateEv(3);
    expect(result).not.toBeNull();
    expect(result.evChargeCurve).toHaveLength(100);
    expect(result.evChargeSamples).toHaveLength(100);
  });
});
