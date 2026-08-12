import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { SocCalibrationEvent } from '../types.ts';

const EVENTS_PATH = path.join(resolveDataDir(), 'soc-calibration-events.json');

/**
 * Retain events for the same window the SoC sampler keeps (30 days). An event
 * older than every live sample can no longer straddle a sample pair, so it is
 * pruned on the next write.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Load recorded SoC calibration events (oldest first). */
export async function loadSocCalibrationEvents(): Promise<SocCalibrationEvent[]> {
  // v8 ignore next — v8 try/catch brace artifact
  try {
    return await readJson<SocCalibrationEvent[]>(EVENTS_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Record a SoC calibration event, pruning any older than the retention window.
 */
export async function recordSocCalibrationEvent(event: SocCalibrationEvent): Promise<void> {
  const events = await loadSocCalibrationEvents();
  const cutoffMs = event.timestampMs - MAX_AGE_MS;
  const kept = events.filter(e => e.timestampMs >= cutoffMs);
  kept.push(event);
  await writeJson(EVENTS_PATH, kept);
}

/**
 * True if any calibration event happened in `(afterMs, atOrBeforeMs]` — i.e.
 * strictly after the earlier sample and at or before the later one, so the
 * later sample reflects the recalibrated value and the earlier one does not.
 */
export function calibrationEventInRange(
  events: SocCalibrationEvent[],
  afterMs: number,
  atOrBeforeMs: number,
): boolean {
  return events.some(e => e.timestampMs > afterMs && e.timestampMs <= atOrBeforeMs);
}
