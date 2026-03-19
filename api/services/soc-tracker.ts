import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { readVictronSocPercent } from './mqtt-service.ts';
import { loadData } from './data-store.ts';
import type { SocSample, TimeSeries } from '../types.ts';

const DATA_DIR = resolveDataDir();
const SAMPLES_PATH = path.join(DATA_DIR, 'soc-samples.json');

/** Keep up to 30 days of 15-min samples (~2880 per day). */
const MAX_SAMPLES = 30 * 24 * 4; // 2880

/**
 * Load stored SoC samples (oldest first).
 */
export async function loadSocSamples(): Promise<SocSample[]> {
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

  // Sample actual load/PV from VRM data at current timestamp
  const nowMs = Date.now();
  let actualLoad_W: number | undefined;
  let actualPv_W: number | undefined;
  try {
    const data = await loadData();
    actualLoad_W = lookupTimeSeriesValue(data.load, nowMs) ?? undefined;
    actualPv_W = lookupTimeSeriesValue(data.pv, nowMs) ?? undefined;
  } catch {
    // Non-critical: proceed without actual load/PV
  }

  const sample: SocSample = {
    timestampMs: nowMs,
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
  const stepMs = (ts.step ?? 15) * 60_000;
  const idx = Math.round((timestampMs - startMs) / stepMs);
  if (idx < 0 || idx >= ts.values.length) return null;
  return ts.values[idx];
}
