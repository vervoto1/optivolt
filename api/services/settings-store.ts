import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
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
    const merged = {
      ...defaults,
      ...settings,
      dataSources: mergedDataSources,
      ...(mergedShoreOptimizer ? { shoreOptimizer: mergedShoreOptimizer } : {}),
      ...(mergedPvCurtailment ? { pvCurtailment: mergedPvCurtailment } : {}),
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
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(SETTINGS_PATH, normalizeSettings(settings));
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings(): Promise<Settings> {
  return readJson<Settings>(DEFAULT_PATH);
}
