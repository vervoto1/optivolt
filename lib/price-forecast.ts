/**
 * Day-ahead price forecast feed (EpexPredictor, `github.com/b3nn0/EpexPredictor`).
 *
 * Pure helpers: the request URL and the response parser. The HTTP call, the
 * refresh policy and persistence live in `api/services/price-forecast-service.ts`.
 *
 * Request: `GET <forecastUrl>/prices?region=NL&unit=CT_PER_KWH&startTs=<local
 * midnight today>`. No `hours` (the feed then returns about 7 days), no
 * `surcharge`/`taxPercent` (the series stays the bare market price, ex VAT),
 * and `startTs` at local midnight so the overlap with today's published prices
 * is included.
 *
 * Response: `{ prices: [{ startsAt, total }], knownUntil }`, quarter-hourly.
 * `knownUntil` is the *start* of the last published (EPEX) slot; everything
 * after it is the model's forecast.
 */

import type { TimeSeries, PriceForecastSourceKind } from './types.ts';

/** Bidding zones the feed accepts (`PriceRegionName` in its OpenAPI schema). */
export const PRICE_FORECAST_REGIONS = [
  'DE', 'AT', 'BE', 'FR', 'NL', 'SE1', 'SE2', 'SE3', 'SE4', 'DK1', 'DK2', 'ES', 'PT',
] as const;
export type PriceForecastRegion = typeof PRICE_FORECAST_REGIONS[number];

/** Step of the stored forecast series, in minutes. */
export const PRICE_FORECAST_STEP_M = 15;
const STEP_MS = PRICE_FORECAST_STEP_M * 60_000;
/** Feed resolutions the parser accepts; hourly points are expanded to quarters. */
const ACCEPTED_STEPS_MS = [STEP_MS, 4 * STEP_MS] as const;
/** Hard cap on what is kept (the feed returns about 7 days); the default of `parsePriceForecastResponse`'s `maxSlots`. */
export const PRICE_FORECAST_MAX_SLOTS = 10 * 24 * 4;

export interface ParsePriceForecastOptions {
  /**
   * Slots kept at most (default `PRICE_FORECAST_MAX_SLOTS`); the series is
   * cut there and marked truncated. The accuracy script passes Infinity: its
   * history responses span up to 30 days.
   */
  maxSlots?: number;
}

export interface ParsedPriceForecast {
  /** Market price in c/kWh ex VAT, 15-minute slots, starting at the first point. */
  series: TimeSeries;
  /** End of the published prices (ms): `knownUntil` + one feed step. */
  publishedEndMs: number;
  /** `true` when the parser cut the series at a gap or at the slot cap. */
  truncated: boolean;
}

/**
 * Why a forecast URL is not acceptable, or null when it is: it must parse as
 * an absolute `http:`/`https:` URL and carry no credentials (the URL is shown
 * in the UI and written to the settings file in clear).
 */
export function forecastUrlError(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'is not a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  return null;
}

/** The public EpexPredictor server (its author's; free, fair use, no guarantees). */
export const PUBLIC_FORECAST_URL = 'https://epexpredictor.batzill.com';

/**
 * The `forecastUrl` setting that picks the source itself: the EpexPredictor
 * add-on from this repository when it is installed and started, else the
 * public server (`api/services/forecast-source.ts`).
 */
export const AUTO_FORECAST_URL = 'auto';

/** Values of a stored forecast's `source` (`PriceForecastSourceKind`). */
export const PRICE_FORECAST_SOURCES: readonly PriceForecastSourceKind[] = ['configured', 'local', 'public'];

/** Whether a `forecastUrl` setting is `auto` (trimmed, any case). */
export function isAutoForecastUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === AUTO_FORECAST_URL;
}

/**
 * Why a `forecastUrl` setting is not acceptable, or null when it is: `auto`
 * (any case) or a URL `forecastUrlError` accepts.
 */
export function forecastUrlSettingError(value: unknown): string | null {
  if (isAutoForecastUrl(value)) return null;
  const error = forecastUrlError(value);
  return error === 'is not a valid URL' ? 'must be "auto" or a valid http(s) URL' : error;
}

/** Local (server time zone) midnight at the start of the day containing `nowMs`. */
export function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The feed request. `baseUrl` may carry a path (a self-hosted instance behind
 * a reverse proxy); `/prices` is appended to it. Only the region is sent.
 */
export function buildPriceForecastUrl({ baseUrl, region, nowMs }: {
  baseUrl: string;
  region: PriceForecastRegion;
  nowMs: number;
}): string {
  const url = new URL(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/prices`;
  url.searchParams.set('region', region);
  url.searchParams.set('unit', 'CT_PER_KWH');
  url.searchParams.set('startTs', new Date(localMidnightMs(nowMs)).toISOString());
  return url.toString();
}

function parseInstant(value: unknown, label: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`Price forecast: ${label} is not a valid timestamp (${JSON.stringify(value)})`);
  return ms;
}

/**
 * Validate and convert a feed response.
 *
 * Throws on anything malformed: not an object, no points, a point without a
 * parseable `startsAt` or a finite `total`, timestamps that do not increase,
 * a first point off the 15-minute grid, an unsupported resolution, or an
 * unparseable `knownUntil`. A gap in the points (or the slot cap,
 * `options.maxSlots`) ends the series there; the published end is taken from
 * `knownUntil` regardless.
 */
export function parsePriceForecastResponse(
  body: unknown,
  { maxSlots = PRICE_FORECAST_MAX_SLOTS }: ParsePriceForecastOptions = {},
): ParsedPriceForecast {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Price forecast: response is not an object');
  }
  const { prices, knownUntil } = body as { prices?: unknown; knownUntil?: unknown };
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error('Price forecast: response has no prices');
  }

  const points = prices.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`Price forecast: prices[${i}] is not an object`);
    const { startsAt, total } = p as { startsAt?: unknown; total?: unknown };
    const ms = parseInstant(startsAt, `prices[${i}].startsAt`);
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      throw new Error(`Price forecast: prices[${i}].total is not a finite number`);
    }
    return { ms, total };
  });

  for (let i = 1; i < points.length; i++) {
    if (points[i].ms <= points[i - 1].ms) {
      throw new Error(`Price forecast: prices[${i}].startsAt does not follow prices[${i - 1}]`);
    }
  }
  const startMs = points[0].ms;
  if (startMs % STEP_MS !== 0) {
    throw new Error('Price forecast: the first slot is not on a 15-minute boundary');
  }

  // The resolution is the first spacing (a single point is taken as quarter-hourly).
  const stepMs = points.length > 1 ? points[1].ms - points[0].ms : STEP_MS;
  if (!(ACCEPTED_STEPS_MS as readonly number[]).includes(stepMs)) {
    throw new Error(`Price forecast: unsupported resolution of ${stepMs / 60_000} minutes`);
  }
  const knownUntilMs = parseInstant(knownUntil, 'knownUntil');

  const repeat = stepMs / STEP_MS;
  const values: number[] = [];
  let truncated = false;
  for (let i = 0; i < points.length; i++) {
    if (points[i].ms !== startMs + i * stepMs) {
      truncated = true;
      break;
    }
    for (let k = 0; k < repeat; k++) values.push(points[i].total);
  }
  if (values.length > maxSlots) {
    values.length = maxSlots;
    truncated = true;
  }

  return {
    series: { start: new Date(startMs).toISOString(), step: PRICE_FORECAST_STEP_M, values },
    publishedEndMs: knownUntilMs + stepMs,
    truncated,
  };
}

/**
 * Hourly means of `series` for `hours` hours from `fromMs` (rounded up to a
 * whole UTC hour). Hours without any slot end the list, so the result is
 * contiguous from its start. Used for the forecast accuracy log.
 */
export function hourlyMeans(series: TimeSeries, fromMs: number, hours: number): { startMs: number; values: number[] } {
  const hourMs = 3_600_000;
  const startMs = Math.ceil(fromMs / hourMs) * hourMs;
  const seriesStartMs = Date.parse(series.start);
  const stepMs = (series.step || PRICE_FORECAST_STEP_M) * 60_000;
  const values: number[] = [];
  for (let h = 0; h < hours; h++) {
    const hourStart = startMs + h * hourMs;
    let sum = 0;
    let n = 0;
    for (let t = hourStart; t < hourStart + hourMs; t += stepMs) {
      const index = Math.floor((t - seriesStartMs) / stepMs);
      const value = index >= 0 && index < series.values.length ? series.values[index] : undefined;
      if (typeof value === 'number' && Number.isFinite(value)) {
        sum += value;
        n++;
      }
    }
    if (n === 0) break;
    values.push(Math.round((sum / n) * 10_000) / 10_000);
  }
  return { startMs, values };
}
