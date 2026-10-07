import { VRMClient } from '../../lib/vrm-api.ts';
import type { VRMForecasts, VRMPrices } from '../../lib/vrm-api.ts';
import { loadSettings, updateSettings } from './settings-store.ts';
import { updateData } from './data-store.ts';
import { readVictronSocPercent, readVictronSocLimits } from './mqtt-service.ts';
import { fetchPricesFromHA } from './ha-price-service.ts';
import { runForecast } from './load-prediction-service.ts';
import { runPvForecast } from './pv-prediction-service.ts';
import { loadPredictionConfig } from './prediction-config-store.ts';
import { withRetry } from './retry.ts';
import { recordFullSocObservation } from './rebalance-nudge.ts';
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

  // Overlaid onto the settings as they are at write time (under the store's
  // lock), so a UI save that landed during the VRM/MQTT round-trips is kept.
  const merged = (await updateSettings(base => ({
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
  })))!;
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
  const socOptions: { timeoutMs: number; batteryInstance?: number } = { timeoutMs: 5000 };
  if (settings.shoreOptimizer?.batteryInstance !== undefined) {
    socOptions.batteryInstance = settings.shoreOptimizer.batteryInstance;
  }

  // Concurrent IO
  const [forecastsResult, pricesResult, socResult] = await Promise.allSettled([
    shouldFetchForecasts ? withRetry(() => client.fetchForecasts(), { label: 'VRM forecasts' }) : Promise.resolve(null),
    shouldFetchPrices ? withRetry(() => client.fetchPrices(), { label: 'VRM prices' }) : Promise.resolve(null),
    shouldFetchSoc ? readVictronSocPercent(socOptions) : Promise.resolve(null),
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

  // Only the series actually refreshed below are patched onto data.json; every
  // other field (and any series whose fetch failed) keeps its value as it is on
  // disk at write time. Building the whole object from a snapshot loaded before
  // the multi-second forecast/HA fetches used to revert any data.json write
  // that landed in between (a prediction adjustment, POST /data).
  const patch: Partial<Pick<Data, 'load' | 'pv' | 'importPrice' | 'exportPrice' | 'soc'>> = {};

  if (shouldFetchVrmLoad && forecasts) {
    patch.load = {
      start: getStart(forecasts, 'load'),
      step: forecasts.step_minutes,
      values: forecasts.load_W,
    };
  }

  if (shouldFetchVrmPv && forecasts) {
    patch.pv = {
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
          patch.load = loadRes.value.forecast;
        } else if (loadRes.status === 'rejected') {
          /* v8 ignore next — non-Error branch of ternary on reason is untestable */
          console.error('[vrm-refresh] Load forecast failed after retries — keeping stale data:', (loadRes.reason as Error).message);
        }
      }
      /* v8 ignore end */

      /* v8 ignore start — optional chaining null paths (pvRes.value?.forecast?.values) are untestable when resolved */
      if (shouldFetchApiPv) {
        if (pvRes.status === 'fulfilled' && pvRes.value?.forecast?.values) {
          patch.pv = pvRes.value.forecast;
        } else if (pvRes.status === 'rejected') {
          /* v8 ignore next — non-Error branch of ternary on reason is untestable */
          console.error('[vrm-refresh] PV forecast failed after retries — keeping stale data:', (pvRes.reason as Error).message);
        }
      }
    }
  }

  if (shouldFetchPrices && prices) {
    patch.importPrice = {
      start: getStart(prices, 'importPrice'),
      step: prices.step_minutes,
      values: prices.importPrice_cents_per_kwh,
    };
    patch.exportPrice = {
      start: getStart(prices, 'exportPrice'),
      step: prices.step_minutes,
      values: prices.exportPrice_cents_per_kwh,
    };
  }

  if (shouldFetchSoc && socPercent !== null) {
    patch.soc = { timestamp: new Date().toISOString(), value: socPercent };
  }

  // Prices from Home Assistant
  if (settings.dataSources.prices === 'ha') {
    try {
      const haPrices = await fetchPricesFromHA(settings);
      if (haPrices) {
        patch.importPrice = haPrices.importPrice;
        patch.exportPrice = haPrices.exportPrice;
      }
    } catch (err) {
      console.warn('[vrm-refresh] Failed to fetch prices from HA:', (err as Error).message);
    }
  }

  // EV load (uncontrollable house load injected via POST /data), the rebalance
  // state, lastFullSocAt and the prediction adjustments are never touched here.
  await updateData(current => {
    const next: Data = { ...current, ...patch };
    return patch.soc ? recordFullSocObservation(next) : next;
  });

  // Keep stepSize_m in settings in sync. Patched onto the current file under
  // the store's lock rather than saving the `settings` snapshot loaded before
  // the VRM fetches: that snapshot is seconds old by now, and writing it back
  // whole reverted any POST /settings, EV override or rebalance auto-disable
  // that landed in between.
  const stepSize_m = forecasts?.step_minutes || settings.stepSize_m;
  await updateSettings(current => current.stepSize_m === stepSize_m ? null : { ...current, stepSize_m });
}
