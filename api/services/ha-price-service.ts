import type { Settings } from '../types.ts';
import type { TimeSeries } from '../../lib/types.ts';
import { resolveHaHttpConfig } from './ha-config.ts';

interface PriceSlot {
  [key: string]: unknown;
}

/**
 * Fetch electricity prices from a Home Assistant sensor.
 * Reads today + tomorrow price arrays from sensor attributes,
 * converts to 15-min slot TimeSeries in cents/kWh.
 */
export async function fetchPricesFromHA(settings: Settings): Promise<{ importPrice: TimeSeries; exportPrice: TimeSeries } | null> {
  const { haPriceConfig, haUrl, haToken } = settings;

  if (!haPriceConfig?.sensor) {
    return null;
  }

  const haConfig = resolveHaHttpConfig(haUrl, haToken);
  if (!haConfig) {
    return null;
  }
  const { baseUrl, token } = haConfig;

  try {
    const state = await fetchEntityState(baseUrl, token, haPriceConfig.sensor);
    if (!state?.attributes) {
      console.warn('[ha-price] No attributes found on sensor', haPriceConfig.sensor);
      return null;
    }

    const todayAttr = haPriceConfig.todayAttribute || 'today_hourly_prices';
    const tomorrowAttr = haPriceConfig.tomorrowAttribute || 'tomorrow_hourly_prices';
    const timeKey = haPriceConfig.timeKey || 'time';
    const valueKey = haPriceConfig.valueKey || 'value';
    const multiplier = haPriceConfig.valueMultiplier ?? 100;
    const interval = haPriceConfig.priceInterval ?? 60;

    const todayPrices = state.attributes[todayAttr] as PriceSlot[] | undefined;
    const tomorrowPrices = state.attributes[tomorrowAttr] as PriceSlot[] | undefined;

    if (!Array.isArray(todayPrices) || todayPrices.length === 0) {
      console.warn('[ha-price] No today prices found in attribute', todayAttr);
      return null;
    }

    // Combine today + tomorrow (tomorrow may be empty before ~14:00)
    const allPrices = [...todayPrices];
    if (Array.isArray(tomorrowPrices) && tomorrowPrices.length > 0) {
      allPrices.push(...tomorrowPrices);
    }

    // Sort by time
    allPrices.sort((a, b) => {
      const ta = new Date(String(a[timeKey])).getTime();
      const tb = new Date(String(b[timeKey])).getTime();
      return ta - tb;
    });

    // Convert to cents and expand to 15-min slots
    const values: number[] = [];
    for (const slot of allPrices) {
      const rawValue = Number(slot[valueKey]) * multiplier;
      const price = Number.isFinite(rawValue) ? rawValue : 0;
      if (interval === 60) {
        // Hourly: repeat 4 times for 15-min slots
        values.push(price, price, price, price);
      } else {
        // Already 15-min granularity
        values.push(price);
      }
    }

    const startTime = new Date(String(allPrices[0][timeKey])).toISOString();

    const importPrice: TimeSeries = { start: startTime, step: 15, values };
    const exportPrice: TimeSeries = haPriceConfig.importEqualsExport !== false
      ? { start: startTime, step: 15, values: [...values] }
      : { start: startTime, step: 15, values: new Array(values.length).fill(0) };

    return { importPrice, exportPrice };
  } catch (err) {
    console.warn('[ha-price] Failed to fetch prices from HA:', (err as Error).message);
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
