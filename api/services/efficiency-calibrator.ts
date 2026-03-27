import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { getRecentSnapshots } from './plan-history-store.ts';
import { loadSocSamples, findLatestSampleAtOrBefore } from './soc-tracker.ts';
import type { CalibrationResult, AccuracyCurve, PlanSnapshot, PlanSnapshotSlot, SocSample } from '../types.ts';

const DATA_DIR = resolveDataDir();
const CALIBRATION_PATH = path.join(DATA_DIR, 'calibration.json');

/** Minimum days of data before calibration produces results. */
const DEFAULT_MIN_DATA_DAYS = 3;

/** EMA smoothing factor — lower = more smoothing, slower adaptation. */
const EMA_ALPHA = 0.15;

/** Clamp effective rate multiplier to this range. */
const MIN_RATE = 0.50;
const MAX_RATE = 1.05;

/** Minimum SoC change (%) per slot to consider it meaningful for calibration. */
const MIN_SOC_CHANGE_PERCENT = 0.5;

/** Max relative deviation between predicted and actual load/PV before skipping the slot. */
const MAX_LOAD_PV_DEVIATION = 0.20; // 20%

/** Number of SoC bands in the efficiency curve (one per percent, 0–99). */
const SOC_BANDS = 100;

/** A single calibration data point with timestamp for sorting. */
interface RatioSample {
  timestampMs: number;
  socBand: number; // 0–99
  ratio: number;
  direction: 'charge' | 'discharge';
}

/**
 * Create a default accuracy curve (100 entries, all 1.0 = no correction).
 */
function defaultCurve(): AccuracyCurve {
  return new Array(SOC_BANDS).fill(1.0);
}

/**
 * Create a default sample count array (100 entries, all 0).
 */
function defaultSampleCounts(): number[] {
  return new Array(SOC_BANDS).fill(0);
}

/**
 * Load persisted calibration, or null if none exists.
 */
export async function loadCalibration(): Promise<CalibrationResult | null> {
  try {
    return await readJson<CalibrationResult>(CALIBRATION_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist calibration result.
 */
export async function saveCalibration(cal: CalibrationResult): Promise<void> {
  await writeJson(CALIBRATION_PATH, cal);
}

/**
 * Reset calibration by deleting the calibration file.
 */
export async function resetCalibration(): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    await fs.unlink(CALIBRATION_PATH);
    console.log('[calibrator] Calibration data reset');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Run calibration: compare predicted vs actual SoC changes across recent plans
 * to derive per-SoC-band efficiency curves for charge and discharge.
 *
 * The approach: for each elapsed slot, compute the ratio of actual SoC change
 * to predicted SoC change, tagged by the SoC band the slot was in. Sort all
 * ratios chronologically, then apply EMA per band to build the curves.
 *
 * Slots where actual load or PV deviated >20% from prediction are skipped
 * to avoid confounding efficiency calibration with forecast errors. Actual
 * load/PV comes from the SoC samples (recorded at each tick), not from
 * the stale data.json.
 *
 * Returns null if insufficient data.
 */
export async function calibrate(
  minDataDays = DEFAULT_MIN_DATA_DAYS,
): Promise<CalibrationResult | null> {
  const snapshots = await getRecentSnapshots(Math.max(minDataDays, 3));
  const samples = await loadSocSamples();

  if (snapshots.length === 0 || samples.length === 0) {
    console.log(`[calibrator] skipped: ${snapshots.length} snapshots, ${samples.length} samples`);
    return null;
  }

  // Check we have at least minDataDays of history
  const oldestSnapshotMs = snapshots[0].createdAtMs;
  const daysCovered = (Date.now() - oldestSnapshotMs) / (24 * 60 * 60_000);
  if (daysCovered < minDataDays) {
    console.log(`[calibrator] skipped: ${daysCovered.toFixed(1)} days covered < ${minDataDays} min`);
    return null;
  }

  // Collect all ratio samples across all snapshots
  const allRatios: RatioSample[] = [];
  for (const snapshot of snapshots) {
    collectRatios(snapshot, samples, allRatios);
  }

  if (allRatios.length === 0) {
    console.log(`[calibrator] skipped: 0 valid ratios from ${snapshots.length} snapshots (all slots filtered out)`);
    return null;
  }

  // Sort chronologically (#4 fix: ensures EMA processes in time order)
  allRatios.sort((a, b) => a.timestampMs - b.timestampMs);

  // Load previous calibration for EMA continuity
  const prev = await loadCalibration();
  const chargeCurve = prev?.chargeCurve?.length === SOC_BANDS
    ? [...prev.chargeCurve]
    : defaultCurve();
  const dischargeCurve = prev?.dischargeCurve?.length === SOC_BANDS
    ? [...prev.dischargeCurve]
    : defaultCurve();
  const chargeSamples = prev?.chargeSamples?.length === SOC_BANDS
    ? [...prev.chargeSamples]
    : defaultSampleCounts();
  const dischargeSamples = prev?.dischargeSamples?.length === SOC_BANDS
    ? [...prev.dischargeSamples]
    : defaultSampleCounts();

  // Apply EMA per SoC band, in chronological order
  let chargeCount = 0;
  let dischargeCount = 0;

  for (const rs of allRatios) {
    const curve = rs.direction === 'charge' ? chargeCurve : dischargeCurve;
    const counts = rs.direction === 'charge' ? chargeSamples : dischargeSamples;
    curve[rs.socBand] = clamp(
      EMA_ALPHA * rs.ratio + (1 - EMA_ALPHA) * curve[rs.socBand],
      MIN_RATE,
      MAX_RATE,
    );
    counts[rs.socBand]++;
    if (rs.direction === 'charge') chargeCount++;
    else dischargeCount++;
  }

  const totalSamples = chargeCount + dischargeCount;
  const confidence = Math.min(1.0, totalSamples / 500);

  // Compute aggregate rates (weighted average, only from bands with data)
  const effectiveChargeRate = clamp(weightedAvg(chargeCurve, chargeSamples), MIN_RATE, MAX_RATE);
  const effectiveDischargeRate = clamp(weightedAvg(dischargeCurve, dischargeSamples), MIN_RATE, MAX_RATE);

  const result: CalibrationResult = {
    chargeCurve,
    dischargeCurve,
    chargeSamples,
    dischargeSamples,
    effectiveChargeRate,
    effectiveDischargeRate,
    sampleCount: totalSamples,
    confidence: Math.round(confidence * 100) / 100,
    lastCalibratedMs: Date.now(),
  };

  await saveCalibration(result);
  console.log(
    `[calibrator] charge=${effectiveChargeRate.toFixed(3)} ` +
    `discharge=${effectiveDischargeRate.toFixed(3)} ` +
    `samples=${totalSamples} confidence=${result.confidence} ` +
    `(${chargeCount} charge, ${dischargeCount} discharge)`,
  );

  return result;
}

/**
 * Check if predicted and actual load/PV are within the acceptable deviation.
 * Uses actual values from the SoC sample (recorded at tick time) rather than
 * the stale data.json which gets overwritten on each VRM refresh.
 */
function isCleanSlot(
  slot: PlanSnapshotSlot,
  sample: SocSample | null,
): boolean {
  if (!sample) return true; // No sample → no filtering

  // Check load deviation
  if (sample.actualLoad_W != null && slot.predictedLoad_W != null) {
    const maxVal = Math.max(Math.abs(slot.predictedLoad_W), Math.abs(sample.actualLoad_W), 100);
    const loadDev = Math.abs(sample.actualLoad_W - slot.predictedLoad_W) / maxVal;
    if (loadDev > MAX_LOAD_PV_DEVIATION) return false;
  }

  // Check PV deviation
  if (sample.actualPv_W != null && slot.predictedPv_W != null) {
    const maxVal = Math.max(Math.abs(slot.predictedPv_W), Math.abs(sample.actualPv_W), 100);
    const pvDev = Math.abs(sample.actualPv_W - slot.predictedPv_W) / maxVal;
    if (pvDev > MAX_LOAD_PV_DEVIATION) return false;
  }

  return true;
}

/**
 * Collect ratio samples from a single plan snapshot.
 * Each ratio is tagged with its SoC band and timestamp for proper ordering.
 */
function collectRatios(
  snapshot: PlanSnapshot,
  samples: SocSample[],
  out: RatioSample[],
): void {
  const now = Date.now();

  for (let i = 1; i < snapshot.slots.length; i++) {
    const slot = snapshot.slots[i];
    const prevSlot = snapshot.slots[i - 1];

    // Only evaluate elapsed slots
    if (slot.timestampMs > now) break;

    // Find actual SoC samples at both slot boundaries
    const prevSample = findLatestSampleAtOrBefore(samples, prevSlot.timestampMs);
    const curSample = findLatestSampleAtOrBefore(samples, slot.timestampMs);
    if (!prevSample || !curSample) continue;

    // Skip slots where load or PV deviated from prediction (confound filter)
    if (!isCleanSlot(slot, curSample)) continue;

    const predictedChange = slot.predictedSoc_percent - prevSlot.predictedSoc_percent;
    const actualChange = curSample.soc_percent - prevSample.soc_percent;

    // Skip slots with negligible predicted change (avoid division by near-zero)
    if (Math.abs(predictedChange) < MIN_SOC_CHANGE_PERCENT) continue;

    const ratio = actualChange / predictedChange;

    // Discard outliers (ratio should be positive and within reasonable bounds)
    if (ratio <= 0 || ratio > 2.0) continue;

    // SoC band = the average SoC during this slot, clamped to 0–99
    const avgSoc = (prevSlot.predictedSoc_percent + slot.predictedSoc_percent) / 2;
    const socBand = clamp(Math.round(avgSoc), 0, SOC_BANDS - 1);

    out.push({
      timestampMs: slot.timestampMs,
      socBand,
      ratio,
      direction: predictedChange > 0 ? 'charge' : 'discharge',
    });
  }
}

/**
 * Weighted average of a curve, giving more weight to mid-range SoC bands
 * (20–80%) where most charging/discharging happens.
 */
/**
 * Weighted average of a curve, only including bands that have actual data.
 * Falls back to 1.0 if no bands have samples.
 */
function weightedAvg(curve: AccuracyCurve, samples: number[]): number {
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < curve.length; i++) {
    const count = samples[i] ?? 0;
    if (count === 0) continue; // Skip bands with no data
    sum += curve[i] * count;
    weightSum += count;
  }
  return weightSum > 0 ? sum / weightSum : 1.0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Maximum number of MILP thresholds per direction. */
const MAX_THRESHOLDS = 8;

/** Number of equal-width SoC segments to partition the curve into. */
const NUM_SEGMENTS = 8;

/** Minimum curve ratio to consider "meaningful reduction" (5% drop). */
const REDUCTION_THRESHOLD = 0.95;

/**
 * Convert a 100-band calibration curve into discrete power thresholds for the MILP.
 *
 * For charge: thresholds are SoC values ABOVE which power is reduced (ascending SoC order).
 * For discharge: thresholds are SoC values BELOW which power is reduced (descending SoC order).
 *
 * Algorithm: divide SoC range into 8 equal segments, compute weighted-average
 * curve value per segment, and emit a threshold at the segment boundary when
 * the average shows a meaningful reduction (>= 5%).
 *
 * @param curve - 100-entry array (index = SoC%), values are ratios like 0.85 = 85% of nominal
 * @param sampleCounts - 100-entry array of sample counts per band
 * @param basePower_W - nominal max power (maxChargePower_W or maxDischargePower_W)
 * @param direction - 'charge' or 'discharge'
 * @param minSamples - minimum samples per band to trust (default 2)
 * @returns array of thresholds, max 8 entries
 */
export function generateThresholdsFromCurve(
  curve: AccuracyCurve,
  sampleCounts: number[],
  basePower_W: number,
  direction: 'charge' | 'discharge',
  minSamples = 2,
  maxThresholds = MAX_THRESHOLDS,
): { soc_percent: number; power_W: number }[] {
  const segmentWidth = Math.ceil(SOC_BANDS / NUM_SEGMENTS);
  const candidates: { soc_percent: number; power_W: number; reduction: number }[] = [];
  const startSegment = direction === 'charge' ? Math.floor(NUM_SEGMENTS / 2) : 0;
  const endSegment = direction === 'charge' ? NUM_SEGMENTS : Math.ceil(NUM_SEGMENTS / 2);

  for (let seg = startSegment; seg < endSegment; seg++) {
    const lo = seg * segmentWidth;
    const hi = Math.min(lo + segmentWidth, SOC_BANDS);

    let weightedSum = 0;
    let weightTotal = 0;

    for (let i = lo; i < hi; i++) {
      const count = sampleCounts[i] ?? 0;
      if (count < minSamples) continue;
      weightedSum += curve[i] * count;
      weightTotal += count;
    }

    if (weightTotal < minSamples) continue; // not enough data in this segment

    const avgRatio = weightedSum / weightTotal;
    if (avgRatio >= REDUCTION_THRESHOLD) continue; // no meaningful reduction

    // Threshold sits at the segment boundary
    const socBoundary = direction === 'charge' ? lo : hi - 1;
    const power_W = Math.round(basePower_W * clamp(avgRatio, MIN_RATE, MAX_RATE));

    candidates.push({ soc_percent: socBoundary, power_W, reduction: 1 - avgRatio });
  }

  // Cap at MAX_THRESHOLDS, keeping the largest reductions
  if (candidates.length > maxThresholds) {
    candidates.sort((a, b) => b.reduction - a.reduction);
    candidates.length = maxThresholds;
  }

  // Sort by soc_percent: ascending for charge, descending for discharge
  if (direction === 'charge') {
    candidates.sort((a, b) => a.soc_percent - b.soc_percent);
  } else {
    candidates.sort((a, b) => b.soc_percent - a.soc_percent);
  }

  return candidates.map(({ soc_percent, power_W }) => ({ soc_percent, power_W }));
}
