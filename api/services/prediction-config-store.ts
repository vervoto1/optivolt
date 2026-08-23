import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson, withJsonLock } from './json-store.ts';
import { clampHistoricalPredictor } from './prediction-config-schema.ts';
import type { PredictionConfig, PredictionValidationWindow, PvPredictionConfig } from '../types.ts';

// v8 ignore next — module-level setup
const DATA_DIR = resolveDataDir();
const PREDICTION_CONFIG_PATH = path.join(DATA_DIR, 'prediction-config.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-prediction-config.json', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The previous `windowDays` full UTC days, ending at today's UTC midnight.
 *
 * Shared by the 7-day comparison window (`loadPredictionConfig`) and the
 * auto-selector's backtest window. UTC days are used deliberately: the history
 * is keyed on UTC hours, and a fixed UTC boundary keeps the window identical
 * whatever local time the run fires at. The cost is that a run early in the
 * local day (the selector's 03:30 default) scores up to a day-and-a-bit of
 * stale data east of roughly UTC+11 — consistent day to day, just not the
 * freshest possible hours.
 */
export function computeValidationWindow(windowDays: number, nowMs: number = Date.now()): PredictionValidationWindow {
  const now = new Date(nowMs);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(end - windowDays * DAY_MS).toISOString(),
    end: new Date(end).toISOString(),
  };
}

export async function loadPredictionConfig(): Promise<PredictionConfig> {
  const defaults = await readJson<PredictionConfig>(DEFAULT_PATH);
  let userConfig: Record<string, unknown> = {};
  try {
    const parsed = await readJson<unknown>(PREDICTION_CONFIG_PATH);
    // v8 ignore next — false branch of && is already tested, v8 double-counts null path
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      userConfig = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Migrate old activeConfig format to historicalPredictor + activeType
  if ('activeConfig' in userConfig && !('historicalPredictor' in userConfig)) {
    const old = userConfig.activeConfig;
    // v8 ignore next — false branch of && is already tested, v8 double-counts null path
    if (typeof old === 'object' && old !== null && !Array.isArray(old)) {
      const o = old as Record<string, unknown>;
      const { activeConfig: _ac, ...rest } = userConfig;
      userConfig = {
        ...rest,
        activeType: 'historical',
        historicalPredictor: {
          sensor: o['sensor'],
          lookbackWeeks: o['lookbackWeeks'],
          dayFilter: o['dayFilter'],
          aggregation: o['aggregation'],
        },
      };
    }
  }

  // Strip activeConfig from userConfig (guard for stored configs that have both activeConfig and historicalPredictor)
  const { activeConfig: _ac, ...cleanUserConfig } = userConfig;
  const cleanConfig = cleanUserConfig as Partial<PredictionConfig>;
  const pvConfig: PredictionConfig['pvConfig'] = (defaults.pvConfig || cleanConfig.pvConfig)
    ? { ...defaults.pvConfig, ...cleanConfig.pvConfig } as PvPredictionConfig
    : undefined;
  const merged = {
    ...defaults,
    ...cleanConfig,
    ...(pvConfig ? { pvConfig } : {}),
  };
  const { validationWindow: _vw, ...rest } = merged;

  return {
    ...rest,
    // A stored strategy is bounded on every load, not only when the route
    // validates a new one: an out-of-range lookbackWeeks from a pre-0.7.56
    // file would otherwise still reach predict() on every auto-calculate tick.
    historicalPredictor: clampHistoricalPredictor(rest.historicalPredictor),
    // Always recompute validationWindow — never trust a persisted value
    validationWindow: computeValidationWindow(7),
  };
}

/** Persist the config as given. Prefer `updatePredictionConfig` — a plain save can still lose a race. */
export async function savePredictionConfig(config: PredictionConfig): Promise<void> {
  await withJsonLock(PREDICTION_CONFIG_PATH, () => writeJson(PREDICTION_CONFIG_PATH, config));
}

/**
 * Read-modify-write the prediction config under the store's lock.
 *
 * Two writers share this file — `POST /predictions/config` and the
 * auto-selector — and the selector's run spans a long HA fetch. Without the
 * lock either side can load the config, lose the race, and write back a
 * snapshot that reverts the other's change (the UI's sensor or PV edit, or the
 * selector's strategy switch) with nothing logged. `mutate` receives the
 * freshly loaded config and returns the config to persist, or `null` to leave
 * the file untouched. Returns what was persisted (or `null`).
 */
export async function updatePredictionConfig(
  mutate: (current: PredictionConfig) => PredictionConfig | null,
): Promise<PredictionConfig | null> {
  return withJsonLock(PREDICTION_CONFIG_PATH, async () => {
    const next = mutate(await loadPredictionConfig());
    if (next) await writeJson(PREDICTION_CONFIG_PATH, next);
    return next;
  });
}
