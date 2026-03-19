import type { Settings } from '../types.ts';
import { writeVictronSetting } from './mqtt-service.ts';
import { planAndMaybeWrite } from './planner-service.ts';

const DESS_MODE_AUTO = 1;
const DESS_MODE_CUSTOM = 4;
const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let windowActive = false;
let configTime = '';        // "HH:MM"
let configDuration = 15;    // minutes
let configEnabled = false;

/**
 * Returns true when the price refresh window is active (DESS is in Mode 1).
 * Used by mqtt-service to skip schedule writes during the window.
 */
export function isPriceRefreshWindowActive(): boolean {
  return windowActive;
}

/**
 * Check if the current local time falls within [time, time+duration).
 */
function isInWindow(now: Date, time: string, durationMinutes: number): boolean {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;

  const startMinutes = h * 60 + m;
  const endMinutes = startMinutes + durationMinutes;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

async function tick(): Promise<void> {
  if (!configEnabled) return;

  const now = new Date();
  const inWindow = isInWindow(now, configTime, configDuration);

  if (inWindow && !windowActive) {
    // Entering window: switch to Mode 1 (Auto/VRM) for price refresh
    windowActive = true;
    try {
      await writeVictronSetting('settings/0/Settings/DynamicEss/Mode', DESS_MODE_AUTO);
      console.log(`[dess-price-refresh] Entered window — DESS set to Mode ${DESS_MODE_AUTO} (Auto) for ${configDuration} min`);
    } catch (err) {
      console.error('[dess-price-refresh] Failed to set Mode 1:', (err as Error).message);
    }
  } else if (!inWindow && windowActive) {
    // Exiting window: restore Mode 4 and trigger immediate recalc with fresh prices
    windowActive = false;
    try {
      await writeVictronSetting('settings/0/Settings/DynamicEss/Mode', DESS_MODE_CUSTOM);
      console.log(`[dess-price-refresh] Window ended — DESS restored to Mode ${DESS_MODE_CUSTOM} (Custom)`);
    } catch (err) {
      console.error('[dess-price-refresh] Failed to restore Mode 4:', (err as Error).message);
    }

    // Trigger forced recalc so fresh VRM prices are used immediately
    try {
      await planAndMaybeWrite({ updateData: true, writeToVictron: true, forceWrite: true });
      console.log('[dess-price-refresh] Forced recalculation complete');
    } catch (err) {
      console.error('[dess-price-refresh] Forced recalc failed:', (err as Error).message);
    }
  }
}

/**
 * Start the price refresh timer. Idempotent — stops any existing timer first.
 */
export function startDessPriceRefresh(settings: Settings): void {
  stopDessPriceRefresh();

  const cfg = settings.dessPriceRefresh;
  if (!cfg?.enabled) return;

  configEnabled = cfg.enabled;
  configTime = cfg.time ?? '23:00';
  configDuration = cfg.durationMinutes ?? 15;

  console.log(`[dess-price-refresh] started (daily at ${configTime} for ${configDuration} min)`);

  // Check immediately, then every 60 seconds
  tick();
  intervalHandle = setInterval(tick, CHECK_INTERVAL_MS);
}

/**
 * Stop the price refresh timer. Clears window state.
 */
export function stopDessPriceRefresh(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[dess-price-refresh] stopped');
  }
  windowActive = false;
  configEnabled = false;
}
