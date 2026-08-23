import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson, withJsonLock } from './json-store.ts';
import type { Settings } from '../types.ts';
import { normalizeSettings } from './settings-schema.ts';

const DATA_DIR = resolveDataDir();
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-settings.json', import.meta.url));

/**
 * Load stored settings or fall back to defaults.
 * This is the canonical way to read settings everywhere.
 */
export async function loadSettings(): Promise<Settings> {
  const defaults = await readJson<Settings>(DEFAULT_PATH);
  try {
    const settings = await readJson<Partial<Settings>>(SETTINGS_PATH);
    // Detect pre-v0.7.20 settings before the defaults merge: if the user's
    // raw settings.json lacks inverterEfficiency_percent, force the migration
    // to fire by stripping the field from defaults below. Without this,
    // {...defaults, ...settings} hands normalizeSettings a value of 95 from
    // the defaults file and the auto-split is silently skipped.
    const userHadInverterEff = settings != null && Object.prototype.hasOwnProperty.call(settings, 'inverterEfficiency_percent');
    const mergedDataSources = { ...defaults.dataSources, ...settings.dataSources };
    const mergedShoreOptimizer = (defaults.shoreOptimizer || settings.shoreOptimizer)
      ? {
          ...(defaults.shoreOptimizer ?? {}),
          ...(settings.shoreOptimizer ?? {}),
        } as Settings['shoreOptimizer']
      : undefined;
    const mergedPvCurtailment = (defaults.pvCurtailment || settings.pvCurtailment)
      ? {
          /* v8 ignore next — default settings always include pvCurtailment; ?? fallback is defensive */
          ...(defaults.pvCurtailment ?? {}),
          ...(settings.pvCurtailment ?? {}),
        } as Settings['pvCurtailment']
      : undefined;
    // essConfig is server-owned and has no settings UI yet, so
    // default-settings.json is authoritative — ignore any persisted essConfig.
    // A persisted copy gets written whenever the user saves unrelated settings
    // (saveSettings persists the whole object), and would otherwise pin stale
    // entities/cadence and silently override updates to the seeded config — e.g.
    // removed calibration tiles or a changed refresh interval would never apply.
    // (When a Phase 7 essConfig editor lands, this can become a real merge.)
    const mergedEssConfig = defaults.essConfig;
    const merged = {
      ...defaults,
      ...settings,
      dataSources: mergedDataSources,
      ...(mergedShoreOptimizer ? { shoreOptimizer: mergedShoreOptimizer } : {}),
      ...(mergedPvCurtailment ? { pvCurtailment: mergedPvCurtailment } : {}),
      ...(mergedEssConfig ? { essConfig: mergedEssConfig } : {}),
    };
    // Strip the field from the merged object so the auto-split migration
    // in normalizeSettings sees a missing inverterEfficiency_percent and
    // back-derives a sensible split from the user's legacy chargeEff/dischargeEff.
    if (!userHadInverterEff) {
      delete (merged as Partial<Settings>).inverterEfficiency_percent;
    }
    return normalizeSettings(merged);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return normalizeSettings(defaults);
  }
}

/**
 * Persist settings to DATA_DIR/settings.json (pretty-printed).
 *
 * Prefer `updateSettings`: a plain save writes back whatever snapshot the
 * caller loaded, so anything another writer persisted in between is lost.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await withJsonLock(SETTINGS_PATH, () => writeJson(SETTINGS_PATH, normalizeSettings(settings)));
}

/**
 * Read-modify-write the settings under the store's lock.
 *
 * Four writers share this file — `POST /settings`, the EV override route, the
 * planner's rebalance auto-disable and the VRM refresh — and the refresh in
 * particular loads the settings, awaits multi-second VRM/MQTT/Open-Meteo
 * fetches, then saves the whole object back: a save landing in that window
 * used to be silently reverted on disk while the timers restarted by
 * `POST /settings` kept running on the newer config. `mutate` receives the
 * freshly loaded (normalised) settings and returns what to persist, or
 * `null` to leave the file untouched; the persisted value is returned. A
 * throwing `mutate` (a 400 from `normalizeSettings`) rejects without writing.
 */
export async function updateSettings(
  mutate: (current: Settings) => Settings | null,
): Promise<Settings | null> {
  return withJsonLock(SETTINGS_PATH, async () => {
    const next = mutate(await loadSettings());
    if (next) await writeJson(SETTINGS_PATH, normalizeSettings(next));
    return next;
  });
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings(): Promise<Settings> {
  return readJson<Settings>(DEFAULT_PATH);
}
