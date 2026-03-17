import type { Settings } from '../types.ts';
import { planAndMaybeWrite } from './planner-service.ts';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let calculating = false;
let activeDessEntity: string | null = null;

const MIN_INTERVAL_MINUTES = 1;

/**
 * Start the auto-calculate timer. If already running, stops the previous
 * timer first to avoid duplicates.
 */
export function startAutoCalculate(settings: Settings): void {
  stopAutoCalculate(settings);

  const config = settings.autoCalculate;
  if (!config?.enabled) return;

  const minutes = Math.max(MIN_INTERVAL_MINUTES, config.intervalMinutes ?? 15);
  const intervalMs = minutes * 60_000;

  // Set DESS to Node-RED mode when writing to Victron
  if (config.writeToVictron && config.dessModeEntity) {
    activeDessEntity = config.dessModeEntity;
    setDessMode(settings, config.dessModeEntity, 'Node-RED');
  }

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
export function stopAutoCalculate(settings?: Settings): void {
  // Revert DESS mode to Auto / VRM
  if (activeDessEntity && settings) {
    setDessMode(settings, activeDessEntity, 'Auto / VRM');
    activeDessEntity = null;
  }

  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[auto-calculate] stopped');
  }
}

async function setDessMode(settings: Settings, entityId: string, mode: string): Promise<void> {
  const isAddon = !!process.env.SUPERVISOR_TOKEN;
  const baseUrl = isAddon ? 'http://supervisor/core' : settings.haUrl.replace(/^wss?:/, m => m === 'wss:' ? 'https:' : 'http:').replace(/\/api\/websocket\/?$/, '');
  const token = isAddon ? process.env.SUPERVISOR_TOKEN! : settings.haToken;

  if (!token) return;

  try {
    const res = await fetch(`${baseUrl}/api/services/select/select_option`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entity_id: entityId, option: mode }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log(`[auto-calculate] DESS mode set to "${mode}"`);
    } else {
      console.warn(`[auto-calculate] Failed to set DESS mode: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[auto-calculate] Failed to set DESS mode:`, (err as Error).message);
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
