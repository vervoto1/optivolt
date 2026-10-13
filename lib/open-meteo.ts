/**
 * open-meteo.ts
 *
 * Pure URL builders and response parsers for the Open-Meteo API.
 * No I/O — the actual HTTP calls live in api/services/open-meteo-client.ts.
 */

import type { IrradianceRecord } from './predict-pv.ts';
import type { TemperatureRecord } from './load-predictor-temperature.ts';

// ----------------------------- URL Builders --------------------------------

const RADIATION_VARIABLES = 'shortwave_radiation,direct_radiation,diffuse_radiation';

interface ArchiveUrlParams {
  latitude: number;
  longitude: number;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

/**
 * Build URL for the Open-Meteo Archive API.
 * Requests hourly radiation variables in UTC (timezone=GMT).
 */
export function buildArchiveUrl({ latitude, longitude, startDate, endDate }: ArchiveUrlParams): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${latitude}&longitude=${longitude}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + `&hourly=${RADIATION_VARIABLES}&timezone=GMT`
  );
}

interface ForecastUrlParams {
  latitude: number;
  longitude: number;
  model?: string;
  pastDays?: number;
  forecastDays?: number;
  resolution?: 15 | 60;
}

/**
 * Build URL for the Open-Meteo Forecast API.
 * Uses the ICON D2 model by default (good European coverage).
 * Requests radiation variables in UTC (timezone=GMT).
 * When resolution=15, uses minutely_15 data; otherwise uses hourly.
 */
export function buildForecastUrl({
  latitude,
  longitude,
  model = 'icon_d2',
  pastDays = 1,
  forecastDays = 2,
  resolution = 60,
}: ForecastUrlParams): string {
  const radiationParam = resolution === 15
    ? `&minutely_15=${RADIATION_VARIABLES}`
    : `&hourly=${RADIATION_VARIABLES}`;
  return (
    `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${latitude}&longitude=${longitude}`
    + radiationParam
    + `&models=${model}`
    + `&timezone=GMT`
    + `&past_days=${pastDays}`
    + `&forecast_days=${forecastDays}`
  );
}

/** Open-Meteo Forecast API limits for `past_days` and `forecast_days`. */
export const OPEN_METEO_MAX_PAST_DAYS = 92;
export const OPEN_METEO_MAX_FORECAST_DAYS = 16;

/**
 * Past days of hourly `temperature_2m` the Forecast API actually fills. It
 * accepts `past_days` up to 92, but hours older than this come back as null
 * (a probe on 2026-10-06 returned 576 null hours, the first non-null one 68
 * days back). `parseTemperatureResponse` drops the nulls, so a window sized
 * past this silently loses its oldest days. Temperature lookbacks are capped
 * to stay inside it, and the callers warn when lookback days come back
 * without a temperature anyway.
 */
export const OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA = 68;

interface TemperatureUrlParams {
  latitude: number;
  longitude: number;
  pastDays: number;
  forecastDays: number;
}

/**
 * Build URL for hourly outside temperature from the Open-Meteo Forecast API.
 * Uses the default best_match model (up to 16 forecast days; `past_days` is
 * accepted up to 92 but only about the last 68 days carry data, see
 * OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA) — the ICON D2 model used for
 * radiation only covers ~2 days. Day counts are clamped to the API limits (an
 * out-of-range value is a 400).
 */
export function buildTemperatureUrl({ latitude, longitude, pastDays, forecastDays }: TemperatureUrlParams): string {
  const past = Math.max(0, Math.min(Math.ceil(pastDays), OPEN_METEO_MAX_PAST_DAYS));
  const forecast = Math.max(1, Math.min(Math.ceil(forecastDays), OPEN_METEO_MAX_FORECAST_DAYS));
  return (
    `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${latitude}&longitude=${longitude}`
    + `&hourly=temperature_2m`
    + `&timezone=GMT`
    + `&past_days=${past}`
    + `&forecast_days=${forecast}`
  );
}

// ----------------------------- Response Parsers ----------------------------

interface OpenMeteoHourlyResponse {
  hourly: {
    time: string[];
    shortwave_radiation: (number | null)[];
    direct_radiation?: (number | null)[];
    diffuse_radiation?: (number | null)[];
  };
}

function radiationValue(values: (number | null)[] | undefined, index: number): number {
  return Math.max(0, values?.[index] ?? 0);
}

/**
 * Parse an Open-Meteo hourly response into IrradianceRecord[].
 *
 * Handles the backward-averaging alignment:
 *   Open-Meteo labels hour 14:00 = average over 13:00–14:00.
 *   HA labels the same interval as hour 13.
 *   We convert: intervalStartHour = (omHour + 23) % 24.
 *   And shift the timestamp back 1 hour to represent the interval start.
 *
 * Null radiation values are treated as 0 (nighttime or missing data).
 */
export function parseIrradianceResponse(data: OpenMeteoHourlyResponse): IrradianceRecord[] {
  const records: IrradianceRecord[] = [];

  const { time, shortwave_radiation, direct_radiation, diffuse_radiation } = data.hourly;

  for (let i = 0; i < time.length; i++) {
    const omDate = new Date(time[i] + 'Z');  // Append Z since timezone=GMT
    const omHour = omDate.getUTCHours();

    // Backward-averaging alignment: shift to interval start
    const intervalStartHour = (omHour + 23) % 24;
    const intervalStartTime = omDate.getTime() - 3600000; // shift back 1 hour

    records.push({
      time: intervalStartTime,
      hour: intervalStartHour,
      ghi_W_per_m2: radiationValue(shortwave_radiation, i),
      directRadiation_W_per_m2: radiationValue(direct_radiation, i),
      diffuseRadiation_W_per_m2: radiationValue(diffuse_radiation, i),
      intervalMinutes: 60,
    });
  }

  return records;
}

interface OpenMeteoTemperatureResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
  };
}

/**
 * Parse an Open-Meteo hourly temperature response into TemperatureRecords.
 * temperature_2m is instantaneous at the labeled time (unlike radiation,
 * which is backward-averaged), so no alignment shift is needed. Null or
 * non-finite values (missing data) are skipped; a response without an
 * hourly block is an error rather than "no temperatures".
 */
export function parseTemperatureResponse(data: OpenMeteoTemperatureResponse): TemperatureRecord[] {
  const time = data?.hourly?.time;
  const temperature_2m = data?.hourly?.temperature_2m;
  if (!Array.isArray(time) || !Array.isArray(temperature_2m)) {
    throw new Error('Open-Meteo temperature response has no hourly temperature_2m data');
  }
  const records: TemperatureRecord[] = [];
  for (let i = 0; i < time.length; i++) {
    const temp_C = temperature_2m[i];
    if (typeof temp_C !== 'number' || !Number.isFinite(temp_C)) continue;
    records.push({ time: new Date(time[i] + 'Z').getTime(), temp_C });
  }
  return records;
}

// ----------------------------- 15-min Parser ------------------------------

interface OpenMeteoMinutely15Response {
  minutely_15: {
    time: string[];
    shortwave_radiation: (number | null)[];
    direct_radiation?: (number | null)[];
    diffuse_radiation?: (number | null)[];
  };
}

/**
 * Parse an Open-Meteo minutely_15 response into IrradianceRecord[].
 *
 * Unlike the hourly response, Open-Meteo labels 15-min data at interval start,
 * so no backward-averaging shift is needed.
 *
 * Null radiation values are treated as 0 (nighttime or missing data).
 */
export function parseMinutely15Response(data: OpenMeteoMinutely15Response): IrradianceRecord[] {
  const records: IrradianceRecord[] = [];

  const { time, shortwave_radiation, direct_radiation, diffuse_radiation } = data.minutely_15;

  for (let i = 0; i < time.length; i++) {
    const date = new Date(time[i] + 'Z');  // Append Z since timezone=GMT
    const hour = date.getUTCHours();
    records.push({
      time: date.getTime(),
      hour,
      ghi_W_per_m2: radiationValue(shortwave_radiation, i),
      directRadiation_W_per_m2: radiationValue(direct_radiation, i),
      diffuseRadiation_W_per_m2: radiationValue(diffuse_radiation, i),
      intervalMinutes: 15,
    });
  }

  return records;
}

/**
 * Expand hourly IrradianceRecords into 15-minute records for validation.
 *
 * Each hourly record is split into 4 × 15-min records with the same GHI value
 * but timestamps at +0, +15, +30, +45 minutes within the hour.
 * This allows forecastPvSlot() to evaluate Bird clear-sky at each 15-min
 * mid-interval and match against 15-min actuals from HA.
 */
export function expandHourlyTo15Min(records: IrradianceRecord[]): IrradianceRecord[] {
  const expanded: IrradianceRecord[] = [];
  for (const rec of records) {
    for (let q = 0; q < 4; q++) {
      const slotMs = rec.time + q * 15 * 60 * 1000;
      expanded.push({
        time: slotMs,
        hour: new Date(slotMs).getUTCHours(),
        ghi_W_per_m2: rec.ghi_W_per_m2,
        directRadiation_W_per_m2: rec.directRadiation_W_per_m2,
        diffuseRadiation_W_per_m2: rec.diffuseRadiation_W_per_m2,
        intervalMinutes: 15,
      });
    }
  }
  return expanded;
}

// ----------------------------- Splicing ------------------------------------

/** The model used after the ICON D2 range (~45 h) when the planning window is extended. */
export const EXTENDED_FORECAST_MODEL = 'icon_seamless';

/**
 * Interval-start times (ms, aligned exactly as `parseForecastResponse`
 * aligns them) whose shortwave radiation is null or missing. The parsers read
 * those as 0 W/m², which is right at night but wrong past the end of a
 * model's range, so the splice and the truncation rule need them.
 */
export function forecastNullTimes(data: unknown, resolution: 15 | 60): number[] {
  const block = resolution === 15
    ? (data as OpenMeteoMinutely15Response).minutely_15
    : (data as OpenMeteoHourlyResponse).hourly;
  const shiftMs = resolution === 15 ? 0 : 3600000;
  const times: number[] = [];
  for (let i = 0; i < block.time.length; i++) {
    const value = block.shortwave_radiation[i];
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    times.push(new Date(block.time[i] + 'Z').getTime() - shiftMs);
  }
  return times;
}

export interface SplicedIrradiance {
  records: IrradianceRecord[];
  /** Interval starts in `records` with no radiation value (null in the source). */
  nullTimes: number[];
}

/**
 * Keep `primary` (ICON D2) up to its last record with a radiation value and
 * continue with `secondary` (ICON seamless) after it. The primary part is
 * kept record for record, so the slots it covers come out identical.
 */
export function spliceIrradiance(primary: SplicedIrradiance, secondary: SplicedIrradiance): SplicedIrradiance {
  const primaryNulls = new Set(primary.nullTimes);
  let lastValidMs = -Infinity;
  for (const rec of primary.records) {
    if (!primaryNulls.has(rec.time) && rec.time > lastValidMs) lastValidMs = rec.time;
  }
  return {
    records: [
      ...primary.records.filter(rec => rec.time <= lastValidMs),
      ...secondary.records.filter(rec => rec.time > lastValidMs),
    ],
    nullTimes: [
      ...primary.nullTimes.filter(t => t <= lastValidMs),
      ...secondary.nullTimes.filter(t => t > lastValidMs),
    ],
  };
}

/**
 * Dispatch to the appropriate parser based on resolution.
 */
export function parseForecastResponse(data: unknown, resolution: 15 | 60): IrradianceRecord[] {
  if (resolution === 15) {
    return parseMinutely15Response(data as OpenMeteoMinutely15Response);
  }
  return parseIrradianceResponse(data as OpenMeteoHourlyResponse);
}
