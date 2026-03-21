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

import { evaluateLatestPlan, evaluatePlan, evaluateRecentPlans } from '../../../api/services/plan-accuracy-service.ts';

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

  it('evaluatePlan returns null when all slots are in the future', () => {
    const now = Date.now();
    const step = 15 * 60_000;

    const snapshot = {
      planId: 'future',
      createdAtMs: now,
      initialSoc_percent: 50,
      slots: [
        { timestampMs: now + 1 * step, predictedSoc_percent: 55 },
        { timestampMs: now + 2 * step, predictedSoc_percent: 60 },
      ],
      config: {},
    };

    const samples = [{ timestampMs: now, soc_percent: 50 }];
    const report = evaluatePlan(snapshot, samples);
    expect(report).toBeNull();
  });

  it('evaluateLatestPlan returns a real report when snapshot and samples match', async () => {
    const now = Date.now();
    const step = 15 * 60_000;

    mockLatestSnapshot = {
      planId: 'test-real',
      createdAtMs: now - 3 * step,
      initialSoc_percent: 50,
      slots: [
        { timestampMs: now - 2 * step, predictedSoc_percent: 55 },
        { timestampMs: now - 1 * step, predictedSoc_percent: 60 },
        { timestampMs: now + 1 * step, predictedSoc_percent: 65 }, // future, skipped
      ],
      config: {},
    };

    mockSocSamples = [
      { timestampMs: now - 2 * step, soc_percent: 53 },
      { timestampMs: now - 1 * step, soc_percent: 57 },
    ];

    const report = await evaluateLatestPlan();

    expect(report).not.toBeNull();
    expect(report.slotsCompared).toBe(2);
    expect(report.meanDeviation_percent).toBeGreaterThanOrEqual(0);
    expect(report.maxDeviation_percent).toBeGreaterThanOrEqual(0);
  });

  it('evaluateRecentPlans returns reports for multiple snapshots', async () => {
    const now = Date.now();
    const step = 15 * 60_000;

    mockRecentSnapshots = [
      {
        planId: 'snap-1',
        createdAtMs: now - 3 * step,
        initialSoc_percent: 50,
        slots: [
          { timestampMs: now - 2 * step, predictedSoc_percent: 55 },
          { timestampMs: now - 1 * step, predictedSoc_percent: 60 },
        ],
        config: {},
      },
      {
        planId: 'snap-2',
        createdAtMs: now - 2 * step,
        initialSoc_percent: 55,
        slots: [
          { timestampMs: now - 1 * step, predictedSoc_percent: 60 },
        ],
        config: {},
      },
    ];

    mockSocSamples = [
      { timestampMs: now - 2 * step, soc_percent: 53 },
      { timestampMs: now - 1 * step, soc_percent: 58 },
    ];

    const reports = await evaluateRecentPlans(7);
    expect(reports.length).toBeGreaterThanOrEqual(1);
  });

  it('evaluateRecentPlans skips snapshots where evaluatePlan returns null (all future slots)', async () => {
    // Line 74: if (report) branch not taken when evaluatePlan returns null
    const now = Date.now();
    const step = 15 * 60_000;

    mockRecentSnapshots = [
      {
        planId: 'all-future',
        createdAtMs: now,
        initialSoc_percent: 50,
        slots: [
          // All slots are in the future — evaluatePlan returns null
          { timestampMs: now + 1 * step, predictedSoc_percent: 55 },
          { timestampMs: now + 2 * step, predictedSoc_percent: 60 },
        ],
        config: {},
      },
    ];

    mockSocSamples = [
      { timestampMs: now - 1 * step, soc_percent: 50 },
    ];

    const reports = await evaluateRecentPlans(7);
    // evaluatePlan returned null for the snapshot (all future) → nothing pushed
    expect(reports).toEqual([]);
  });

  it('evaluateRecentPlans returns empty array when no samples', async () => {
    mockRecentSnapshots = [{
      planId: 'snap-1',
      createdAtMs: Date.now() - 60_000,
      initialSoc_percent: 50,
      slots: [{ timestampMs: Date.now() - 30_000, predictedSoc_percent: 55 }],
      config: {},
    }];
    mockSocSamples = [];

    const reports = await evaluateRecentPlans(7);
    expect(reports).toEqual([]);
  });
});
