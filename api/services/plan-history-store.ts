import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { PlanSnapshot } from '../types.ts';

const DATA_DIR = resolveDataDir();
const HISTORY_PATH = path.join(DATA_DIR, 'plan-history.json');

/** Maximum number of plan snapshots to retain (ring buffer). */
const MAX_SNAPSHOTS = 2000;

/**
 * Load all stored plan snapshots (oldest first).
 */
export async function loadPlanHistory(): Promise<PlanSnapshot[]> {
  try {
    const data = await readJson<PlanSnapshot[]>(HISTORY_PATH);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Corrupted file — start fresh rather than crashing
    console.warn('[plan-history] Corrupted history file, starting fresh:', (err as Error).message);
    return [];
  }
}

/**
 * Append a snapshot to the history ring buffer.
 * Prunes oldest entries when the buffer exceeds MAX_SNAPSHOTS.
 */
export async function savePlanSnapshot(snapshot: PlanSnapshot): Promise<void> {
  const history = await loadPlanHistory();
  history.push(snapshot);
  // Prune oldest entries if over capacity
  const pruned = history.length > MAX_SNAPSHOTS
    ? history.slice(history.length - MAX_SNAPSHOTS)
    : history;
  await writeJson(HISTORY_PATH, pruned);
}

/**
 * Get the most recent plan snapshot, or null if none exists.
 */
export async function getLatestSnapshot(): Promise<PlanSnapshot | null> {
  const history = await loadPlanHistory();
  return history.length > 0 ? history[history.length - 1] : null;
}

/**
 * Get snapshots from the last N days.
 */
export async function getRecentSnapshots(days: number): Promise<PlanSnapshot[]> {
  const history = await loadPlanHistory();
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  return history.filter(s => s.createdAtMs >= cutoffMs);
}
