import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fixtures driven per-test.
let mockSnapshots = [];
let mockSamples = [];
let savedEvCalibration = null;

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

// No persisted EV calibration (ENOENT) so each run starts from the default curve;
// writeJson captures what would be saved.
vi.mock('../../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/tmp/test-data',
  readJson: vi.fn(async () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  writeJson: vi.fn(async (_path, data) => { savedEvCalibration = data; }),
}));

import { calibrateEv, generateThresholdsFromCurve, EV_MIN_RATE } from '../../../api/services/efficiency-calibrator.ts';

const DAY = 24 * 60 * 60_000;
const QUARTER = 15 * 60_000;

/** Snapshot with EV-charging slots. `evSocSeq` is start-of-slot predicted EV SoC. */
function makeEvSnapshot(baseMs, evSocSeq) {
  return {
    planId: `plan-${baseMs}`,
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

/** SoC samples aligned to a snapshot's slot timestamps. */
function makeEvSamples(baseMs, actualEvSeq, pluggedIn = true) {
  return actualEvSeq.map((soc, i) => ({
    timestampMs: baseMs + i * QUARTER,
    soc_percent: 50,
    actualEvSoc_percent: soc,
    evPluggedIn: pluggedIn,
  }));
}

describe('EV charge-acceptance calibration', () => {
  beforeEach(() => {
    mockSnapshots = [];
    mockSamples = [];
    savedEvCalibration = null;
  });

  it('learns a taper curve: acceptance drops in higher SoC bands', async () => {
    // Predicted (flat-rate) EV SoC rises 78→83→88→93 (Δ5/slot). Actual rises slower
    // and slower (Δ3, Δ2, Δ1) → acceptance 0.6/0.4/0.2 in bands ~81/86/91.
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000; // spread across the window, all elapsed
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84]));
    }

    const result = await calibrateEv(3);
    expect(result).not.toBeNull();
    expect(result.sampleCount).toBe(36); // 3 ratios × 12 snapshots

    // Bands accumulated samples and show a taper that deepens with SoC.
    expect(result.evChargeSamples[81]).toBe(12);
    expect(result.evChargeSamples[86]).toBe(12);
    expect(result.evChargeSamples[91]).toBe(12);
    expect(result.evChargeCurve[81]).toBeLessThan(1.0);
    expect(result.evChargeCurve[91]).toBeLessThan(result.evChargeCurve[86]);
    expect(result.evChargeCurve[86]).toBeLessThan(result.evChargeCurve[81]);
    expect(savedEvCalibration).toBe(result);
  });

  it('excludes slots where the car was not plugged in (confound gate)', async () => {
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      mockSamples.push(...makeEvSamples(baseMs, [78, 81, 83, 84], /* pluggedIn */ false));
    }
    const result = await calibrateEv(3);
    expect(result).toBeNull(); // all ratios filtered out → no result
  });

  it('excludes slots where home load/PV diverged from plan (clean-slot gate)', async () => {
    // Same charging history, but every sample's actual load is far from the plan's
    // predictedLoad_W (400) — a throttling/confound proxy. The EV shortfall must NOT
    // be learned as acceptance, so all ratios are filtered → no result.
    const now = Date.now();
    for (let d = 0; d < 12; d++) {
      const baseMs = now - 5 * DAY + d * 60 * 60_000;
      mockSnapshots.push(makeEvSnapshot(baseMs, [78, 83, 88, 93]));
      const samples = makeEvSamples(baseMs, [78, 81, 83, 84]).map(s => ({ ...s, actualLoad_W: 6000 }));
      mockSamples.push(...samples);
    }
    const result = await calibrateEv(3);
    expect(result).toBeNull();
  });

  it('returns null with no snapshots', async () => {
    const result = await calibrateEv(3);
    expect(result).toBeNull();
  });

  it('generateThresholdsFromCurve honours the low EV floor (below the battery 0.50)', () => {
    // High-SoC bands at ~0.18 acceptance. With the EV floor (0.05) a 2 kW-ish cap is
    // emitted; the battery's 0.50 floor would have clamped it at ~5.5 kW.
    const curve = new Array(100).fill(1.0);
    const samples = new Array(100).fill(0);
    for (let b = 88; b < 100; b++) { curve[b] = 0.18; samples[b] = 5; }

    const thresholds = generateThresholdsFromCurve(curve, samples, 11040, 'charge', 2, undefined, EV_MIN_RATE);
    expect(thresholds.length).toBeGreaterThan(0);
    const deepest = Math.min(...thresholds.map(t => t.power_W));
    expect(deepest).toBeLessThan(0.5 * 11040); // below the battery floor
    expect(deepest).toBeGreaterThanOrEqual(EV_MIN_RATE * 11040 - 1);
  });
});
