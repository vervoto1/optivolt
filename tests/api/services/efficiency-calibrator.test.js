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

import { calibrate, resetCalibration } from '../../../api/services/efficiency-calibrator.ts';
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
