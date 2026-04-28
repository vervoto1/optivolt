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
    const mergedDataSources = { ...defaults.dataSources, ...settings.dataSources };
    const mergedShoreOptimizer = (defaults.shoreOptimizer || settings.shoreOptimizer)
      ? {
          ...(defaults.shoreOptimizer ?? {}),
          ...(settings.shoreOptimizer ?? {}),
        } as Settings['shoreOptimizer']
      : undefined;
    return normalizeSettings({
      ...defaults,
      ...settings,
      dataSources: mergedDataSources,
      ...(mergedShoreOptimizer ? { shoreOptimizer: mergedShoreOptimizer } : {}),
    });
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
