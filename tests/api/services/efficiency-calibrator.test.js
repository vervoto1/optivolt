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
    savedCalibration = data;
    mockCalibration = data;
  }),
}));

import { calibrate } from '../../../api/services/efficiency-calibrator.ts';

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
});
