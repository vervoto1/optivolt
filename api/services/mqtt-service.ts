import { VictronMqttClient } from '../../lib/victron-mqtt.ts';
import { isPriceRefreshWindowActive } from './dess-price-refresh.ts';
import type { PlanRowWithDess } from '../types.ts';

let victronClient: VictronMqttClient | null = null;

function toVictronStrategy(strategy: number): number {
  // GX stable releases document 0=follow target SoC and 1=self-consume.
  // Keep our richer internal planner strategies, but publish a compatible
  // subset so TargetSoc is honored consistently on the device.
  return strategy === 1 ? 1 : 0;
}

function getVictronClient(): VictronMqttClient {
  if (!victronClient) {
    const host = process.env.MQTT_HOST ?? 'venus.local';
    const tls = process.env.MQTT_TLS === 'true' || process.env.MQTT_TLS === '1';
    const rawPort = process.env.MQTT_PORT ? Number(process.env.MQTT_PORT) : undefined;
    // If port is the non-TLS default (1883) but TLS is enabled, treat it as
    // "not explicitly set" so the MQTT client picks the correct TLS default (8883).
    const port = (tls && rawPort === 1883) ? undefined : rawPort;
    const username = process.env.MQTT_USERNAME ?? '';
    const password = process.env.MQTT_PASSWORD ?? '';
    const rejectUnauthorized = !(process.env.MQTT_TLS_INSECURE === 'true' || process.env.MQTT_TLS_INSECURE === '1');

    victronClient = new VictronMqttClient({ host, port, username, password, tls, rejectUnauthorized });
  }

  return victronClient;
}

export async function getVictronSerial(): Promise<string> {
  const client = getVictronClient();
  return client.getSerial();
}

export async function readVictronSetting(relativePath: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<unknown> {
  const client = getVictronClient();
  return client.readSetting(relativePath, { timeoutMs });
}

export async function writeVictronSetting(relativePath: string, value: unknown): Promise<void> {
  const client = getVictronClient();
  await client.writeSetting(relativePath, value);
}

/**
 * Read the current battery SoC (%) from MQTT.
 * Returns a number in [0, 100] or null if unavailable.
 */
export async function readVictronSocPercent({ timeoutMs }: { timeoutMs?: number } = {}): Promise<number | null> {
  const client = getVictronClient();
  const res = await client.readSocPercent({ timeoutMs });
  return res.soc_percent;
}

/**
 * Read ESS SoC limits (min/max %) from MQTT.
 * Returns { minSoc_percent: number | null, maxSoc_percent: number | null }.
 */
export async function readVictronSocLimits({ timeoutMs }: { timeoutMs?: number } = {}): Promise<{ minSoc_percent: number | null; maxSoc_percent: number | null }> {
  const client = getVictronClient();
  const res = await client.readSocLimitsPercent({ timeoutMs });
  return { minSoc_percent: res.minSoc_percent, maxSoc_percent: res.maxSoc_percent };
}

// DESS Mode 4 = Custom/Node-RED mode: VRM cloud stops sending schedules
// and the local GX daemon watches our schedule slots instead.
const DESS_MODE_CUSTOM = 4;
const DEFAULT_SLOT_SECONDS = 15 * 60;

/**
 * Ensure Dynamic ESS is in Mode 4 (Custom).
 * Reads the current mode and sets it if not already 4.
 * Mode 4 does not persist across GX reboots, so we check every write.
 */
async function ensureDessMode4(client: VictronMqttClient, serial: string): Promise<void> {
  try {
    const payload = await client.readSetting('settings/0/Settings/DynamicEss/Mode', {
      serial,
      timeoutMs: 3000,
    }) as { value?: unknown } | null;

    const currentMode = Number(payload?.value);
    if (currentMode === DESS_MODE_CUSTOM) return;

    console.log(`[mqtt] DESS Mode is ${currentMode}, switching to Mode 4 (Custom)...`);
    await client.writeSetting('settings/0/Settings/DynamicEss/Mode', DESS_MODE_CUSTOM, { serial });
    console.log('[mqtt] DESS Mode set to 4 (Custom)');
  } catch (err) {
    console.warn('[mqtt] Failed to read DESS Mode, setting to 4:', (err as Error).message);
    // If read timed out (e.g. first connect), write Mode 4 anyway
    await client.writeSetting('settings/0/Settings/DynamicEss/Mode', DESS_MODE_CUSTOM, { serial });
    console.log('[mqtt] DESS Mode set to 4 (Custom) after read failure');
  }
}

/**
 * High-level Dynamic ESS schedule builder.
 *
 * Ensures DESS is in Mode 4 (Custom), then writes schedule slots.
 * Fills all available slots from rows — Venus OS ignores expired slots
 * based on Start timestamps, so filling all 48 ensures no gaps.
 *
 * rows: optimizer rows with DESS slot data
 * slotCount: how many slots to push (starting from rows[0])
 */
export async function setDynamicEssSchedule(rows: PlanRowWithDess[], slotCount: number): Promise<{ serial: string; slotsWritten: number }> {
  console.log(`[mqtt] Writing DESS schedule (${Math.min(slotCount, rows.length)} slots)...`);
  const client = getVictronClient();

  let serial: string;
  try {
    serial = await client.getSerial();
    console.log(`[mqtt] Connected, serial: ${serial}`);
  } catch (err) {
    console.error('[mqtt] Failed to get Venus serial:', (err as Error).message);
    throw err;
  }

  // Skip schedule writes during the price refresh window (DESS is in Mode 1
  // so VRM can update prices; custom slots are ignored in Mode 1 anyway).
  if (isPriceRefreshWindowActive()) {
    console.log('[mqtt] Price refresh window active, skipping schedule write');
    return { serial, slotsWritten: 0 };
  }

  // Ensure DESS is in Custom mode so our local schedules are used
  await ensureDessMode4(client, serial);

  const nSlots = Math.min(slotCount, rows.length);
  const tasks = [];
  const stepSeconds = rows.length > 1
    ? (rows[1].timestampMs - rows[0].timestampMs) / 1000
    : DEFAULT_SLOT_SECONDS;

  for (let i = 0; i < nSlots; i += 1) {
    const row = rows[i];

    const slot = {
      startEpoch: Math.round(row.timestampMs / 1000),
      durationSeconds: stepSeconds,
      strategy: toVictronStrategy(row.dess.strategy),
      flags: row.dess.flags,
      socTarget: Math.round(row.dess.socTarget_percent),
      restrictions: row.dess.restrictions,
      allowGridFeedIn: row.dess.feedin,
    };
    tasks.push(client.writeScheduleSlot(i, slot, { serial }));
  }

  await Promise.all(tasks);
  console.log(`[mqtt] DESS schedule written (${nSlots} slots, serial: ${serial})`);

  return { serial, slotsWritten: nSlots };
}

export async function shutdownVictronClient(): Promise<void> {
  if (!victronClient) return;
  await victronClient.close();
  victronClient = null;
}
