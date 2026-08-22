import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { AutoSelectRun } from '../types.ts';

const DATA_DIR = resolveDataDir();
const HISTORY_PATH = path.join(DATA_DIR, 'prediction-auto-select.json');

/** Maximum number of run records to retain (ring buffer). */
export const MAX_AUTO_SELECT_RUNS = 60;

/**
 * Load all stored auto-select run records (oldest first).
 */
export async function loadAutoSelectHistory(): Promise<AutoSelectRun[]> {
  try {
    const data = await readJson<AutoSelectRun[]>(HISTORY_PATH);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Corrupted file — start fresh rather than crashing the scheduler
    console.warn('[auto-select] Corrupted history file, starting fresh:', (err as Error).message);
    return [];
  }
}

/**
 * Append a run record, pruning the oldest entries past MAX_AUTO_SELECT_RUNS.
 */
export async function appendAutoSelectRun(run: AutoSelectRun): Promise<void> {
  const history = await loadAutoSelectHistory();
  history.push(run);
  const pruned = history.length > MAX_AUTO_SELECT_RUNS
    ? history.slice(history.length - MAX_AUTO_SELECT_RUNS)
    : history;
  await writeJson(HISTORY_PATH, pruned);
}

/**
 * Most recent run record, or null when none exists.
 */
export async function getLatestAutoSelectRun(): Promise<AutoSelectRun | null> {
  const history = await loadAutoSelectHistory();
  return history.length > 0 ? history[history.length - 1] : null;
}
