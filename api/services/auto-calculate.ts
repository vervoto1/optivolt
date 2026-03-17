import type { Settings } from '../types.ts';
import { planAndMaybeWrite } from './planner-service.ts';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let calculating = false;

const MIN_INTERVAL_MINUTES = 1;

/**
 * Start the auto-calculate timer. If already running, stops the previous
 * timer first to avoid duplicates.
 */
export function startAutoCalculate(settings: Settings): void {
  stopAutoCalculate();

  const config = settings.autoCalculate;
  if (!config?.enabled) return;

  const minutes = Math.max(MIN_INTERVAL_MINUTES, config.intervalMinutes ?? 15);
  const intervalMs = minutes * 60_000;

  console.log(`[auto-calculate] started (every ${minutes} min)`);

  // Fire first calculation immediately (non-blocking)
  runTick(config.updateData, config.writeToVictron);

  intervalHandle = setInterval(() => {
    runTick(config.updateData, config.writeToVictron);
  }, intervalMs);
}

/**
 * Stop the auto-calculate timer if running.
 */
export function stopAutoCalculate(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[auto-calculate] stopped');
  }
}

async function runTick(updateData: boolean, writeToVictron: boolean): Promise<void> {
  if (calculating) {
    console.log('[auto-calculate] skipped — calculation already in progress');
    return;
  }

  calculating = true;
  try {
    await planAndMaybeWrite({ updateData, writeToVictron });
    console.log('[auto-calculate] calculation completed');
  } catch (err) {
    console.error('[auto-calculate] calculation failed:', (err as Error).message);
  } finally {
    calculating = false;
  }
}

/**
 * Check if the timer is currently running (for testing).
 */
export function isAutoCalculateRunning(): boolean {
  return intervalHandle !== null;
}
