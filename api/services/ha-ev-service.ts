import type { Settings } from '../types.ts';
import type { TimeSeries } from '../../lib/types.ts';
import { resolveHaHttpConfig } from './ha-config.ts';

interface ChargingSlot {
  start: string;
  end: string;
  value: number;
}

/**
 * Fetch EV charging schedule from Home Assistant's EV Smart Charging integration.
 * Returns a TimeSeries of EV load in watts, or null if unavailable.
 */
export async function fetchEvLoadFromHA(settings: Settings): Promise<TimeSeries | null> {
  const { evConfig, haUrl, haToken } = settings;

  if (!evConfig?.enabled || !evConfig.scheduleSensor) {
    return null;
  }

  const haConfig = resolveHaHttpConfig(haUrl, haToken);
  if (!haConfig) {
    return null;
  }
  const { baseUrl, token } = haConfig;

  try {
    // Check if EV is connected (skip check if alwaysApplySchedule is true)
    if (!evConfig.alwaysApplySchedule && evConfig.connectedSwitch) {
      const connectedState = await fetchEntityState(baseUrl, token, evConfig.connectedSwitch);
      if (connectedState?.state !== 'on') {
        console.log('[ha-ev] EV not connected, skipping schedule');
        return null;
      }
    }

    // Read charging schedule
    const sensorState = await fetchEntityState(baseUrl, token, evConfig.scheduleSensor);
    const attr = evConfig.scheduleAttribute || 'charging_schedule';
    const schedule = sensorState?.attributes?.[attr] as ChargingSlot[] | undefined;

    if (!Array.isArray(schedule) || schedule.length === 0) {
      console.warn('[ha-ev] No charging_schedule attribute found or empty');
      return null;
    }

    // Convert schedule to TimeSeries
    return scheduleToTimeSeries(schedule, evConfig.chargerPower_W);
  } catch (err) {
    console.warn('[ha-ev] Failed to fetch EV schedule from HA:', (err as Error).message);
    return null;
  }
}

async function fetchEntityState(
  baseUrl: string,
  token: string,
  entityId: string,
): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  const url = `${baseUrl}/api/states/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HA API returned ${res.status} for ${entityId}`);
  }
  return res.json() as Promise<{ state: string; attributes: Record<string, unknown> }>;
}

function scheduleToTimeSeries(schedule: ChargingSlot[], chargerPower_W: number): TimeSeries {
  // Schedule slots are ISO 8601 with timezone, 15-min aligned
  // Sort by start time
  const sorted = [...schedule].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const startMs = new Date(sorted[0].start).getTime();
  const values: number[] = sorted.map(slot => (slot.value > 0 ? chargerPower_W : 0));

  return {
    start: new Date(startMs).toISOString(),
    step: 15,
    values,
  };
}
