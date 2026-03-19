import type { Settings } from '../types.ts';
import { planAndMaybeWrite } from './planner-service.ts';
import { sampleAndStoreSoc } from './soc-tracker.ts';
import { calibrate } from './efficiency-calibrator.ts';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let calculating = false;
let tickCount = 0;
let adaptiveLearningEnabled = false;
let adaptiveLearningMinDays = 3;

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

  adaptiveLearningEnabled = settings.adaptiveLearning?.enabled ?? false;
  adaptiveLearningMinDays = settings.adaptiveLearning?.minDataDays ?? 3;
  tickCount = 0;

  console.log(`[auto-calculate] started (every ${minutes} min, adaptive=${adaptiveLearningEnabled})`);

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
    // Sample actual SoC before computing the new plan (fire-and-forget on failure)
    sampleAndStoreSoc().catch(err =>
      console.warn('[auto-calculate] SoC sampling failed:', (err as Error).message),
    );

    await planAndMaybeWrite({ updateData, writeToVictron });
    console.log('[auto-calculate] calculation completed');

    tickCount++;
    // Run calibration every ~4 hours (16 ticks at 15-min interval)
    if (adaptiveLearningEnabled && tickCount % 16 === 0) {
      calibrate(adaptiveLearningMinDays).catch(err =>
        console.warn('[auto-calculate] calibration failed:', (err as Error).message),
      );
    }
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
