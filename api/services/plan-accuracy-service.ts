import { getLatestSnapshot, getRecentSnapshots } from './plan-history-store.ts';
import { loadSocSamples, findLatestSampleAtOrBefore } from './soc-tracker.ts';
import type { PlanAccuracyReport, SlotDeviation, PlanSnapshot, SocSample } from '../types.ts';

/**
 * Evaluate the most recent plan against actual SoC samples.
 * Compares predicted SoC at each elapsed slot with the closest actual SoC sample.
 * Returns null if no plan or no samples are available.
 */
export async function evaluateLatestPlan(): Promise<PlanAccuracyReport | null> {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return null;

  const samples = await loadSocSamples();
  if (samples.length === 0) return null;

  return evaluatePlan(snapshot, samples);
}

/**
 * Evaluate a single plan snapshot against SoC samples.
 */
export function evaluatePlan(
  snapshot: PlanSnapshot,
  samples: SocSample[],
): PlanAccuracyReport | null {
  const now = Date.now();
  const deviations: SlotDeviation[] = [];

  for (const slot of snapshot.slots) {
    // Only evaluate elapsed slots
    if (slot.timestampMs > now) break;

    const sample = findLatestSampleAtOrBefore(samples, slot.timestampMs);
    if (!sample) continue;

    const deviation = sample.soc_percent - slot.predictedSoc_percent;
    deviations.push({
      timestampMs: slot.timestampMs,
      predictedSoc_percent: slot.predictedSoc_percent,
      actualSoc_percent: sample.soc_percent,
      deviation_percent: Math.round(deviation * 100) / 100,
    });
  }

  if (deviations.length === 0) return null;

  const absDeviations = deviations.map(d => Math.abs(d.deviation_percent));
  const meanDeviation = absDeviations.reduce((a, b) => a + b, 0) / absDeviations.length;
  const maxDeviation = Math.max(...absDeviations);

  return {
    planId: snapshot.planId,
    createdAtMs: snapshot.createdAtMs,
    evaluatedAtMs: now,
    slotsCompared: deviations.length,
    meanDeviation_percent: Math.round(meanDeviation * 100) / 100,
    maxDeviation_percent: Math.round(maxDeviation * 100) / 100,
    deviations,
  };
}

/**
 * Evaluate all recent plans and return accuracy reports.
 */
export async function evaluateRecentPlans(days: number): Promise<PlanAccuracyReport[]> {
  const snapshots = await getRecentSnapshots(days);
  const samples = await loadSocSamples();
  if (samples.length === 0) return [];

  const reports: PlanAccuracyReport[] = [];
  for (const snapshot of snapshots) {
    const report = evaluatePlan(snapshot, samples);
    if (report) reports.push(report);
  }
  return reports;
}
