/**
 * open-meteo-client.ts
 *
 * Thin HTTP wrapper around the Open-Meteo API.
 * Uses the pure URL builders and response parsers from lib/open-meteo.ts.
 */

import {
  buildArchiveUrl,
  buildForecastUrl,
  buildTemperatureUrl,
  parseIrradianceResponse,
  parseForecastResponse,
  parseTemperatureResponse,
} from '../../lib/open-meteo.ts';
import type { IrradianceRecord } from '../../lib/predict-pv.ts';
import type { TemperatureRecord } from '../../lib/load-predictor-temperature.ts';
import { fetchWithTimeout } from '../../lib/fetch-utils.ts';

const OPEN_METEO_TIMEOUT_MS = 15_000;

/**
 * Fetch historical irradiance data from the Open-Meteo Archive API.
 */
export async function fetchArchiveIrradiance(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<IrradianceRecord[]> {
  const url = buildArchiveUrl({ latitude: lat, longitude: lon, startDate, endDate });
  const response = await fetchWithTimeout(url, {}, { timeoutMs, label: 'Open-Meteo Archive API request' });

  if (!response.ok) {
    throw new Error(`Open-Meteo Archive API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseIrradianceResponse(data);
}

/**
 * Fetch forecast irradiance data from the Open-Meteo Forecast API.
 */
export async function fetchForecastIrradiance(
  lat: number,
  lon: number,
  model?: string,
  resolution: 15 | 60 = 60,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<IrradianceRecord[]> {
  const url = buildForecastUrl({ latitude: lat, longitude: lon, model, pastDays: 1, forecastDays: 2, resolution });
  const response = await fetchWithTimeout(url, {}, { timeoutMs, label: 'Open-Meteo Forecast API request' });

  if (!response.ok) {
    throw new Error(`Open-Meteo Forecast API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseForecastResponse(data, resolution);
}

/**
 * Fetch hourly outside temperature (past + forecast) from the Open-Meteo
 * Forecast API. pastDays is capped at 92 and forecastDays at 16 (API limits);
 * hours older than about 68 days come back null and are dropped by the parser
 * (OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA).
 */
export async function fetchTemperatureSeries(
  lat: number,
  lon: number,
  pastDays: number,
  forecastDays: number,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<TemperatureRecord[]> {
  const url = buildTemperatureUrl({ latitude: lat, longitude: lon, pastDays, forecastDays });
  const response = await fetchWithTimeout(url, {}, { timeoutMs, label: 'Open-Meteo temperature request' });

  if (!response.ok) {
    throw new Error(`Open-Meteo temperature request returned status ${response.status}`);
  }

  const data = await response.json();
  return parseTemperatureResponse(data);
}
