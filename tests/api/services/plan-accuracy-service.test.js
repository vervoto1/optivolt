import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockLatestSnapshot = null;
let mockRecentSnapshots = [];
let mockSocSamples = [];

vi.mock('../../../api/services/plan-history-store.ts', () => ({
  getLatestSnapshot: vi.fn(async () => mockLatestSnapshot),
  getRecentSnapshots: vi.fn(async () => mockRecentSnapshots),
}));

vi.mock('../../../api/services/soc-tracker.ts', () => ({
  loadSocSamples: vi.fn(async () => mockSocSamples),
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

import { evaluateLatestPlan, evaluatePlan } from '../../../api/services/plan-accuracy-service.ts';

describe('plan-accuracy-service', () => {
  beforeEach(() => {
    mockLatestSnapshot = null;
    mockRecentSnapshots = [];
    mockSocSamples = [];
  });

  it('returns null when no snapshot exists', async () => {
    const result = await evaluateLatestPlan();
    expect(result).toBeNull();
  });

  it('returns null when no SoC samples exist', async () => {
    mockLatestSnapshot = {
      planId: 'test',
      createdAtMs: Date.now() - 60_000,
      initialSoc_percent: 50,
      slots: [{ timestampMs: Date.now() - 30_000, predictedSoc_percent: 55 }],
      config: {},
    };
    const result = await evaluateLatestPlan();
    expect(result).toBeNull();
  });

  it('computes deviations for elapsed slots', () => {
    const now = Date.now();
    const step = 15 * 60_000;

    const snapshot = {
      planId: 'test-plan',
      createdAtMs: now - 4 * step,
      initialSoc_percent: 50,
      slots: [
        { timestampMs: now - 3 * step, predictedSoc_percent: 55 },
        { timestampMs: now - 2 * step, predictedSoc_percent: 60 },
        { timestampMs: now - 1 * step, predictedSoc_percent: 65 },
        { timestampMs: now + 1 * step, predictedSoc_percent: 70 }, // future - skipped
      ],
      config: {},
    };

    const samples = [
      { timestampMs: now - 3 * step, soc_percent: 53 },
      { timestampMs: now - 2 * step, soc_percent: 57 },
      { timestampMs: now - 1 * step, soc_percent: 62 },
    ];

    const report = evaluatePlan(snapshot, samples);
    expect(report).not.toBeNull();
    expect(report.slotsCompared).toBe(3);
    expect(report.deviations).toHaveLength(3);

    // First slot: actual 53, predicted 55, deviation = -2
    expect(report.deviations[0].deviation_percent).toBe(-2);
    // Second slot: actual 57, predicted 60, deviation = -3
    expect(report.deviations[1].deviation_percent).toBe(-3);
    // Third slot: actual 62, predicted 65, deviation = -3
    expect(report.deviations[2].deviation_percent).toBe(-3);

    // Mean absolute deviation = (2 + 3 + 3) / 3 = 2.67
    expect(report.meanDeviation_percent).toBeCloseTo(2.67, 1);
    expect(report.maxDeviation_percent).toBe(3);
  });

  it('skips slots without matching SoC samples', () => {
    const now = Date.now();
    const step = 15 * 60_000;

    const snapshot = {
      planId: 'test',
      createdAtMs: now - 3 * step,
      initialSoc_percent: 50,
      slots: [
        { timestampMs: now - 2 * step, predictedSoc_percent: 55 },
        { timestampMs: now - 1 * step, predictedSoc_percent: 60 },
      ],
      config: {},
    };

    // Only one sample, far from the first slot
    const samples = [
      { timestampMs: now - 1 * step + 1000, soc_percent: 58 },
    ];

    const report = evaluatePlan(snapshot, samples);
    expect(report).not.toBeNull();
    expect(report.slotsCompared).toBe(1);
    expect(report.deviations[0].actualSoc_percent).toBe(58);
  });
});
