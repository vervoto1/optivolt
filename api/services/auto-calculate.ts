import type { Settings } from '../types.ts';
import { HttpError } from '../http-errors.ts';
import { planAndMaybeWrite } from './planner-service.ts';
import { sampleAndStoreSoc } from './soc-tracker.ts';
import { calibrate, calibrateEv } from './efficiency-calibrator.ts';
import { loadSettings } from './settings-store.ts';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let calculating = false;
let calculatingSinceMs: number | null = null;
let activeIntervalMs: number | null = null;

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
  activeIntervalMs = intervalMs;
  const initialDelayMs = getDelayToNextBoundary(Date.now(), intervalMs);

  console.log(`[auto-calculate] started (every ${minutes} min, first run in ${Math.round(initialDelayMs / 1000)}s)`);

  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    runTick(config.updateData, config.writeToVictron);
    intervalHandle = setInterval(() => {
      runTick(config.updateData, config.writeToVictron);
    }, intervalMs);
  }, initialDelayMs);
}

/**
 * Stop the auto-calculate timer if running.
 */
export function stopAutoCalculate(): void {
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  activeIntervalMs = null;
  console.log('[auto-calculate] stopped');
}

async function runTick(updateData: boolean, writeToVictron: boolean): Promise<void> {
  if (calculating) {
    console.log('[auto-calculate] skipped — calculation already in progress');
    return;
  }

  calculating = true;
  calculatingSinceMs = Date.now();
  try {
    // Sample actual SoC before computing the new plan
    try {
      await sampleAndStoreSoc();
    } catch (err) {
      console.warn('[auto-calculate] SoC sampling failed:', (err as Error).message);
    }

    try {
      await planAndMaybeWrite({ updateData, writeToVictron });
    } catch (err) {
      if (err instanceof HttpError && err.message === 'Insufficient future data' && !updateData) {
        console.warn('[auto-calculate] data exhausted, retrying with VRM refresh');
        await planAndMaybeWrite({ updateData: true, writeToVictron });
      } else {
        throw err;
      }
    }
    console.log('[auto-calculate] calculation completed');

    // Re-read adaptive learning settings each tick so UI changes take effect
    // immediately without requiring auto-calculate restart
    try {
      const currentSettings = await loadSettings();
      const al = currentSettings.adaptiveLearning;
      if (al?.enabled) {
        calibrate(al.minDataDays ?? 3).catch(err =>
          console.warn('[auto-calculate] calibration failed:', (err as Error).message),
        );
        // EV charge-acceptance learning runs whenever adaptive learning is on, so
        // the curve is ready before the user opts into applying it (evChargeCurveEnabled).
        calibrateEv(al.minDataDays ?? 3).catch(err =>
          console.warn('[auto-calculate] EV calibration failed:', (err as Error).message),
        );
      }
    } catch (err) {
      // Non-critical: settings read failure should not block auto-calculate
      console.warn('[auto-calculate] adaptive learning check failed:', (err as Error).message);
    }
  } catch (err) {
    console.error('[auto-calculate] calculation failed:', (err as Error).message);
  } finally {
    calculating = false;
    calculatingSinceMs = null;
  }
}

export interface AutoCalculateHealth {
  /** True when one tick has been running for more than twice the interval (a wedged await). */
  stuck: boolean;
  calculatingForMs: number | null;
  intervalMs: number | null;
}

/**
 * Liveness of the auto-calculate loop for /health. A tick only counts as stuck when it has
 * been in progress for more than two intervals: every later tick is skipped while it runs,
 * so the plan silently stops being refreshed. Slow or failing ticks are not stuck.
 */
export function getAutoCalculateHealth(nowMs: number = Date.now()): AutoCalculateHealth {
  const calculatingForMs = calculating && calculatingSinceMs !== null ? nowMs - calculatingSinceMs : null;
  const stuck = calculatingForMs !== null && activeIntervalMs !== null && calculatingForMs > 2 * activeIntervalMs;
  return { stuck, calculatingForMs, intervalMs: activeIntervalMs };
}

/**
 * Check if the timer is currently running (for testing).
 */
export function isAutoCalculateRunning(): boolean {
  return timeoutHandle !== null || intervalHandle !== null;
}

function getDelayToNextBoundary(nowMs: number, intervalMs: number): number {
  const remainder = nowMs % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}
