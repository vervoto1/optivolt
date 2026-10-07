import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson, withJsonLock } from './json-store.ts';
import type { Data, TimeSeries } from '../types.ts';
import { validatePredictionAdjustment } from './prediction-adjustments.ts';

const DATA_DIR = resolveDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-data.json', import.meta.url));

function validateTimeSeries(ts: TimeSeries, label: string): void {
  if (!ts || typeof ts !== 'object') {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  if (Number.isNaN(new Date(ts.start).getTime())) {
    throw new Error(`Invalid ${label}: 'start' is not a valid timestamp (${ts.start})`);
  }
  if (!Array.isArray(ts.values)) {
    throw new Error(`Invalid ${label}: 'values' must be an array`);
  }
  if (ts.step !== undefined && !(Number.isFinite(ts.step) && ts.step > 0)) {
    throw new Error(`Invalid ${label}: 'step' must be a positive number`);
  }
}

export function validateData(d: Data): Data {
  validateTimeSeries(d.load, 'load');
  validateTimeSeries(d.pv, 'pv');
  validateTimeSeries(d.importPrice, 'importPrice');
  validateTimeSeries(d.exportPrice, 'exportPrice');
  if (!Number.isFinite(d.soc.value)) {
    throw new Error('Invalid soc: value must be a finite number; refresh VRM data first');
  }
  if (Number.isNaN(new Date(d.soc.timestamp).getTime())) {
    throw new Error(`Invalid soc: 'timestamp' is not a valid timestamp (${d.soc.timestamp})`);
  }
  if (d.evLoad) {
    validateTimeSeries(d.evLoad, 'evLoad');
  }
  if (d.lastFullSocAt !== undefined && d.lastFullSocAt !== null) {
    if (typeof d.lastFullSocAt !== 'string' || Number.isNaN(new Date(d.lastFullSocAt).getTime())) {
      throw new Error(`Invalid lastFullSocAt: must be null or a valid timestamp (${d.lastFullSocAt})`);
    }
  }
  if (d.predictionAdjustments !== undefined) {
    if (!Array.isArray(d.predictionAdjustments)) {
      throw new Error("Invalid predictionAdjustments: must be an array");
    }
    for (const adjustment of d.predictionAdjustments) {
      validatePredictionAdjustment(adjustment);
    }
  }
  return d;
}

/**
 * Load stored data or fall back to defaults.
 */
export async function loadData(): Promise<Data> {
  try {
    return validateData(await readJson<Data>(DATA_PATH));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const defaults = await readJson<Data>(DEFAULT_PATH);

    // Shift defaults to "start of current hour" so we have full 24h of future data
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startTimeStr = now.toISOString();

    defaults.load.start = startTimeStr;
    defaults.pv.start = startTimeStr;
    defaults.importPrice.start = startTimeStr;
    defaults.exportPrice.start = startTimeStr;
    defaults.soc.timestamp = startTimeStr;
    if (defaults.evLoad) {
      defaults.evLoad.start = startTimeStr;
    }

    return validateData(defaults);
  }
}

/**
 * Persist data to DATA_DIR/data.json (pretty-printed).
 *
 * Prefer `updateData`: a plain save writes back whatever snapshot the caller
 * loaded, so anything another writer persisted in between is lost. The save
 * still queues behind the store's lock so it never interleaves with an
 * in-flight `updateData`.
 */
export async function saveData(data: Data): Promise<void> {
  validateData(data);
  await withJsonLock(DATA_PATH, () => writeJson(DATA_PATH, data));
}

/**
 * Read-modify-write data.json under the store's lock.
 *
 * Several writers share this file: the planner (live SoC, rebalance state,
 * pruned adjustments), the VRM/forecast refresh, prediction-adjustment CRUD,
 * forecast persists and `POST /data`. Some of them load the file, await
 * multi-second HA/MQTT/forecast round-trips, then used to save the whole
 * object back — silently reverting any write that landed in between (e.g. a
 * prediction adjustment created mid-plan). `mutate` receives the freshly
 * loaded data and returns what to persist, or `null` to leave the file
 * untouched. It must be synchronous and must not call back into this store
 * (that would wait on the lock it is running under). Returns the data as it
 * stands afterwards: the persisted value, or the loaded one when `mutate`
 * returned `null`. A throwing `mutate` or a failed validation rejects without
 * writing.
 */
export async function updateData(mutate: (current: Data) => Data | null): Promise<Data> {
  return withJsonLock(DATA_PATH, async () => {
    const current = await loadData();
    const next = mutate(current);
    if (!next) return current;
    validateData(next);
    await writeJson(DATA_PATH, next);
    return next;
  });
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultData(): Promise<Data> {
  return readJson<Data>(DEFAULT_PATH);
}
