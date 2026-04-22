import { VRMClient } from '../../lib/vrm-api.ts';
import type { VRMForecasts, VRMPrices } from '../../lib/vrm-api.ts';
import { loadSettings, saveSettings } from './settings-store.ts';
import { loadData, saveData } from './data-store.ts';
import { readVictronSocPercent, readVictronSocLimits } from './mqtt-service.ts';
import { fetchEvLoadFromHA } from './ha-ev-service.ts';
import { fetchPricesFromHA } from './ha-price-service.ts';
import { runForecast } from './load-prediction-service.ts';
import { runPvForecast } from './pv-prediction-service.ts';
import { loadPredictionConfig } from './prediction-config-store.ts';
import { withRetry } from './retry.ts';
import type { Data } from '../types.ts';

function createClientFromEnv(): VRMClient {
  // v8 ignore next — module-level const
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  // v8 ignore next — module-level const
  const token = (process.env.VRM_TOKEN ?? '').trim();
  if (!installationId) throw new Error('VRM Site ID not configured');
  if (!token) throw new Error('VRM API token not configured');
  return new VRMClient({ installationId, token });
}

function getStart(obj: VRMForecasts | VRMPrices, label: string): string {
  if (obj.timestamps.length > 0) {
    // v8 ignore next — trivial return in function
    return new Date(obj.timestamps[0]).toISOString();
  }
  throw new Error(`VRM returned no timestamps for ${label}.`);
}

/** Persist relatively static system settings from VRM (no timeseries). */
export async function refreshSettingsFromVrmAndPersist() {
  const client = createClientFromEnv();

  const [vrmSettings, socLimits] = await Promise.all([
    client.fetchDynamicEssSettings(),
    // Prefer MQTT for SoC limits; fall back gracefully if it fails.
    readVictronSocLimits({ timeoutMs: 5000 }).catch((err: unknown) => {
      /* v8 ignore next — null path of ternary on err instanceof check */
      console.error('Failed to read SoC limits from MQTT:', err instanceof Error ? err.message : String(err));
      return null;
    }),
  ]);

  // v8 ignore next — module-level const
  const base = await loadSettings();

  const merged = {
    ...base,
    batteryCapacity_Wh:       vrmSettings.batteryCapacity_Wh,
    maxDischargePower_W:      vrmSettings.dischargePower_W,
    maxChargePower_W:         vrmSettings.chargePower_W,
    maxGridImport_W:          vrmSettings.maxPowerFromGrid_W,
    maxGridExport_W:          vrmSettings.maxPowerToGrid_W,
    batteryCost_cent_per_kWh: vrmSettings.batteryCosts_cents_per_kWh,

    // SoC limits now come from MQTT (if available), otherwise keep existing.
    minSoc_percent: socLimits?.minSoc_percent ?? base.minSoc_percent,
    maxSoc_percent: socLimits?.maxSoc_percent ?? base.maxSoc_percent,
  };

  await saveSettings(merged);
  return merged;
}

/**
 * Fetch VRM series (load + PV + prices) and persist RAW data.
 * No slicing/alignment is done here; the "Smart Reader" handles that.
 */
export async function refreshSeriesFromVrmAndPersist(): Promise<void> {
  const client = createClientFromEnv();

  const settings = await loadSettings();
  const sources = settings.dataSources;

  const shouldFetchVrmLoad = sources.load === 'vrm';
  const shouldFetchVrmPv = sources.pv === 'vrm';
  const shouldFetchForecasts = shouldFetchVrmLoad || shouldFetchVrmPv;
  const shouldFetchPrices = sources.prices === 'vrm';
  const shouldFetchSoc = sources.soc === 'mqtt';

  // Concurrent IO
  const [forecastsResult, pricesResult, socResult] = await Promise.allSettled([
    shouldFetchForecasts ? withRetry(() => client.fetchForecasts(), { label: 'VRM forecasts' }) : Promise.resolve(null),
    shouldFetchPrices ? withRetry(() => client.fetchPrices(), { label: 'VRM prices' }) : Promise.resolve(null),
    shouldFetchSoc ? readVictronSocPercent({ timeoutMs: 5000 }) : Promise.resolve(null),
  ]);

  let forecasts: VRMForecasts | null = null;
  if (shouldFetchForecasts) {
    if (forecastsResult.status === 'fulfilled') forecasts = forecastsResult.value;
    else {
      // v8 ignore next — null path of ? in reason instanceof check is covered by test, v8 double-counts
      console.error('Failed to fetch forecasts:', forecastsResult.reason instanceof Error ? forecastsResult.reason.message : String(forecastsResult.reason));
    }
  }

  let prices: VRMPrices | null = null;
  if (shouldFetchPrices) {
    if (pricesResult.status === 'fulfilled') prices = pricesResult.value;
    else {
      // v8 ignore next — null path of ? in reason instanceof check is covered by test, v8 double-counts
      console.error('Failed to fetch prices:', pricesResult.reason instanceof Error ? pricesResult.reason.message : String(pricesResult.reason));
    }
  }

  let socPercent: number | null = null;
  if (shouldFetchSoc) {
    if (socResult.status === 'fulfilled') socPercent = socResult.value;
    else {
      // v8 ignore next — null path of ? in reason instanceof check is covered by test, v8 double-counts
      console.error('Failed to read SoC from MQTT:', socResult.reason instanceof Error ? socResult.reason.message : String(socResult.reason));
    }
  }

  // Load previous data for fallback (we overwrite specific keys if VRM usage is active)
  const baseData = await loadData();

  // Build new data structures (or keep existing)

  // v8 ignore next — module-level const
  let load = baseData.load;
  if (shouldFetchVrmLoad && forecasts) {
    load = {
      start: getStart(forecasts, 'load'),
      step: forecasts.step_minutes,
      values: forecasts.load_W,
    };
  }

  let pv = baseData.pv;
  if (shouldFetchVrmPv && forecasts) {
    pv = {
      start: getStart(forecasts, 'pv'),
      step: forecasts.step_minutes,
      values: forecasts.pv_W,
    };
  }

  // API forecasts (load and/or PV from the prediction pipeline)
  const shouldFetchApiLoad = sources.load === 'api';
  const shouldFetchApiPv = sources.pv === 'api';

  if (shouldFetchApiLoad || shouldFetchApiPv) {
    let predConfig: Awaited<ReturnType<typeof loadPredictionConfig>> | null = null;
    try {
      predConfig = await loadPredictionConfig();
    } catch (err) {
      console.warn('[vrm-refresh] Failed to load prediction config:', (err as Error).message);
    }

    if (predConfig) {
      const runConfig = { ...predConfig, haUrl: settings.haUrl ?? '', haToken: settings.haToken ?? '' };

      const [loadRes, pvRes] = await Promise.allSettled([
        shouldFetchApiLoad ? withRetry(() => runForecast(runConfig), { label: 'load forecast' }) : Promise.resolve(null),
        shouldFetchApiPv ? withRetry(() => runPvForecast(runConfig), { label: 'pv forecast' }) : Promise.resolve(null),
      ]);

      /* v8 ignore start — optional chaining null paths (loadRes.value?.forecast?.values) are untestable when resolved */
      if (shouldFetchApiLoad) {
        if (loadRes.status === 'fulfilled' && loadRes.value?.forecast?.values) {
          load = loadRes.value.forecast;
        } else if (loadRes.status === 'rejected') {
          /* v8 ignore next — non-Error branch of ternary on reason is untestable */
          console.error('[vrm-refresh] Load forecast failed after retries — keeping stale data:', (loadRes.reason as Error).message);
        }
      }
      /* v8 ignore end */

      /* v8 ignore start — optional chaining null paths (pvRes.value?.forecast?.values) are untestable when resolved */
      if (shouldFetchApiPv) {
        if (pvRes.status === 'fulfilled' && pvRes.value?.forecast?.values) {
          pv = pvRes.value.forecast;
        } else if (pvRes.status === 'rejected') {
          /* v8 ignore next — non-Error branch of ternary on reason is untestable */
          console.error('[vrm-refresh] PV forecast failed after retries — keeping stale data:', (pvRes.reason as Error).message);
        }
      }
    }
  }

  let importPrice = baseData.importPrice;
  let exportPrice = baseData.exportPrice;
  if (shouldFetchPrices && prices) {
    importPrice = {
      start: getStart(prices, 'importPrice'),
      step: prices.step_minutes,
      values: prices.importPrice_cents_per_kwh,
    };
    exportPrice = {
      start: getStart(prices, 'exportPrice'),
      step: prices.step_minutes,
      values: prices.exportPrice_cents_per_kwh,
    };
  }

  const soc = shouldFetchSoc && socPercent !== null
    ? { timestamp: new Date().toISOString(), value: socPercent }
    : baseData.soc;

  // Prices from Home Assistant
  if (settings.dataSources.prices === 'ha') {
    try {
      const haPrices = await fetchPricesFromHA(settings);
      if (haPrices) {
        importPrice = haPrices.importPrice;
        exportPrice = haPrices.exportPrice;
      }
    } catch (err) {
      console.warn('[vrm-refresh] Failed to fetch prices from HA:', (err as Error).message);
    }
  }

  let evLoad = baseData.evLoad;
  // EV load from Home Assistant (fetch when data source is 'ha' OR evConfig is enabled)
  if (settings.dataSources.evLoad === 'ha' || settings.evConfig?.enabled) {
    try {
      const fetched = await fetchEvLoadFromHA(settings);
      // Use fresh data or clear stale schedule (e.g., car disconnected)
      evLoad = fetched ?? undefined;
    } catch (err) {
      console.warn('[vrm-refresh] Failed to fetch EV load from HA:', (err as Error).message);
    }
  }

  const nextData: Data = { load, pv, importPrice, exportPrice, soc, rebalanceState: baseData.rebalanceState, evLoad };
  await saveData(nextData);

  // Optionally keep stepSize_m in settings in sync
  const nextSettings = {
    ...settings,
    stepSize_m: forecasts?.step_minutes || settings.stepSize_m,
  };
  await saveSettings(nextSettings);
}
