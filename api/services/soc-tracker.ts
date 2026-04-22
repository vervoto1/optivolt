import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { readVictronSocPercent } from './mqtt-service.ts';
import { loadData } from './data-store.ts';
import { getQuarterStart } from '../../lib/time-series-utils.ts';
import type { SocSample, TimeSeries } from '../types.ts';

const DATA_DIR = resolveDataDir();
const SAMPLES_PATH = path.join(DATA_DIR, 'soc-samples.json');

/** Keep up to 30 days of 15-min samples (~2880 per day). */
const MAX_SAMPLES = 30 * 24 * 4; // 2880

/**
 * Load stored SoC samples (oldest first).
 */
export async function loadSocSamples(): Promise<SocSample[]> {
  // v8 ignore next — v8 try/catch brace artifact
  try {
    return await readJson<SocSample[]>(SAMPLES_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Save the sample buffer (pruning oldest if over capacity).
 */
async function saveSocSamples(samples: SocSample[]): Promise<void> {
  const pruned = samples.length > MAX_SAMPLES
    ? samples.slice(samples.length - MAX_SAMPLES)
    : samples;
  await writeJson(SAMPLES_PATH, pruned);
}

/**
 * Sample the current SoC from MQTT and append to the sample buffer.
 * Called once per auto-calculate tick (typically every 15 min).
 * Returns the sampled value, or null if MQTT read failed.
 */
export async function sampleAndStoreSoc(): Promise<SocSample | null> {
  let soc_percent: number | null;
  try {
    soc_percent = await readVictronSocPercent({ timeoutMs: 5000 });
  } catch (err) {
    console.warn('[soc-tracker] Failed to read SoC from MQTT:', (err as Error).message);
    return null;
  }

  if (soc_percent == null) {
    console.warn('[soc-tracker] MQTT returned null SoC');
    return null;
  }

  const measuredAtMs = Date.now();
  const slotStartMs = getQuarterStart(measuredAtMs);
  let actualLoad_W: number | undefined;
  let actualPv_W: number | undefined;
  try {
    const data = await loadData();
    actualLoad_W = lookupTimeSeriesValue(data.load, slotStartMs) ?? undefined;
    actualPv_W = lookupTimeSeriesValue(data.pv, slotStartMs) ?? undefined;
  } catch {
    // Non-critical: proceed without actual load/PV
  }

  const sample: SocSample = {
    timestampMs: measuredAtMs,
    soc_percent,
    actualLoad_W,
    actualPv_W,
  };

  try {
    const samples = await loadSocSamples();
    samples.push(sample);
    await saveSocSamples(samples);
  } catch (err) {
    console.warn('[soc-tracker] Failed to persist SoC sample:', (err as Error).message);
  }

  return sample;
}

/**
 * Find the SoC sample closest to a given timestamp (within a tolerance window).
 * Returns null if no sample is within the tolerance.
 */
export function findClosestSample(
  samples: SocSample[],
  targetMs: number,
  toleranceMs = 10 * 60_000, // 10 minutes
): SocSample | null {
  let best: SocSample | null = null;
  let bestDist = Infinity;

  for (const s of samples) {
    const dist = Math.abs(s.timestampMs - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }

  return best && bestDist <= toleranceMs ? best : null;
}

/**
 * Find the latest sample at or before a target timestamp.
 * Used for slot-boundary comparisons so a measurement taken after the boundary
 * does not get attributed to an earlier slot.
 */
export function findLatestSampleAtOrBefore(
  samples: SocSample[],
  targetMs: number,
  maxLagMs = 10 * 60_000,
  maxLeadMs = 2 * 60_000,
): SocSample | null {
  let bestPrior: SocSample | null = null;
  let bestNearFuture: SocSample | null = null;

  for (const s of samples) {
    const deltaMs = s.timestampMs - targetMs;
    if (deltaMs <= 0) {
      if (deltaMs < -maxLagMs) continue;
      // v8 ignore next — false branch of || is tested, v8 double-counts falsy path
    if (!bestPrior || s.timestampMs > bestPrior.timestampMs) {
        bestPrior = s;
      }
      continue;
    }

    if (deltaMs <= maxLeadMs) {
      // v8 ignore next — false branch of || is tested, v8 double-counts falsy path
      if (!bestNearFuture || s.timestampMs < bestNearFuture.timestampMs) {
        bestNearFuture = s;
      }
    }
  }

  return bestPrior ?? bestNearFuture;
}

/**
 * Clear all SoC samples.
 */
export async function clearSocSamples(): Promise<void> {
  await writeJson(SAMPLES_PATH, []);
  console.log('[soc-tracker] Samples cleared');
}

/**
 * Get samples from the last N days.
 */
export async function getRecentSamples(days: number): Promise<SocSample[]> {
  const samples = await loadSocSamples();
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  return samples.filter(s => s.timestampMs >= cutoffMs);
}

/**
 * Look up the value in a TimeSeries at a given timestamp.
 * Returns null if the timestamp falls outside the series range.
 */
function lookupTimeSeriesValue(ts: TimeSeries, timestampMs: number): number | null {
  const startMs = new Date(ts.start).getTime();
  // v8 ignore next — null path of ?? is already tested, v8 double-counts
  const stepMs = (ts.step ?? 15) * 60_000;
  const idx = Math.round((timestampMs - startMs) / stepMs);
  if (idx < 0 || idx >= ts.values.length) return null;
  return ts.values[idx];
}
