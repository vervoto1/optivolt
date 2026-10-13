/**
 * Where the price forecast is fetched from (`extendedHorizon.forecastUrl`).
 *
 * A URL is used as configured. `auto` uses the EpexPredictor add-on from this
 * repository when it is installed and started, else the public server:
 *
 * 1. Outside Home Assistant (no `SUPERVISOR_TOKEN`) there is no add-on to find.
 * 2. `GET http://supervisor/addons/self/info` gives this add-on's slug, e.g.
 *    `601a68d0_optivolt` (repository install) or `local_optivolt` (local copy).
 * 3. The sibling add-on is the same slug with `optivolt` replaced by
 *    `epexpredictor`; `GET http://supervisor/addons/<slug>/info` gives its
 *    state and hostname. When it is `started` the forecast comes from
 *    `http://<hostname>` (the add-on listens on port 80 of the internal network).
 *
 * Both calls are read-only and allowed for the Supervisor's `default` role,
 * which `hassio_api: true` in optivolt/config.yaml grants. Any other outcome
 * falls back to the public server with the reason. The resolution is cached
 * for 10 minutes (either way), so an add-on started later is picked up and the
 * Supervisor is asked at most once per refresh interval. Never throws.
 */

import { fetchWithTimeout } from '../../lib/fetch-utils.ts';
import { PUBLIC_FORECAST_URL, isAutoForecastUrl } from '../../lib/price-forecast.ts';
import type { PriceForecastSourceKind } from '../../lib/types.ts';

export const FORECAST_SOURCE_CACHE_MS = 10 * 60_000;
export const SUPERVISOR_TIMEOUT_MS = 5_000;
const SUPERVISOR_URL = 'http://supervisor';
const OWN_SLUG_SUFFIX = 'optivolt';
const FORECAST_SLUG_SUFFIX = 'epexpredictor';

export interface ForecastSource {
  /** Base URL to fetch the forecast from. */
  url: string;
  /** `configured`: a URL setting; `local`: auto → the add-on; `public`: auto → the public server. */
  source: PriceForecastSourceKind;
  /** Why `auto` fell back to the public server (only with `public`). */
  reason?: string;
}

export type SupervisorFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ResolveForecastSourceOptions {
  nowMs: number;
  /** Defaults to `process.env` (reads `SUPERVISOR_TOKEN`). */
  env?: Record<string, string | undefined>;
  /** Defaults to `fetch` with a 5 s deadline. */
  fetchImpl?: SupervisorFetch;
}

interface CacheEntry {
  forecastUrl: string;
  atMs: number;
  result: ForecastSource;
}

let cache: CacheEntry | null = null;

const defaultFetch: SupervisorFetch = (url, init) =>
  fetchWithTimeout(url, init, { timeoutMs: SUPERVISOR_TIMEOUT_MS, label: 'Supervisor request' });

const publicSource = (reason: string): ForecastSource => ({ url: PUBLIC_FORECAST_URL, source: 'public', reason });

/** `data` of a Supervisor `{ result: 'ok', data }` answer, or null. */
async function supervisorData(response: Response): Promise<Record<string, unknown> | null> {
  const body = await response.json() as { result?: unknown; data?: unknown } | null;
  if (body?.result !== 'ok' || !body.data || typeof body.data !== 'object') return null;
  return body.data as Record<string, unknown>;
}

async function lookUpLocalAddon(token: string, fetchImpl: SupervisorFetch): Promise<ForecastSource> {
  const get = (path: string) => fetchImpl(`${SUPERVISOR_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  const self = await get('/addons/self/info');
  if (!self.ok) return publicSource(`Supervisor lookup failed: /addons/self/info returned status ${self.status}`);
  const ownSlug = (await supervisorData(self))?.slug;
  if (typeof ownSlug !== 'string' || !ownSlug.endsWith(OWN_SLUG_SUFFIX)) {
    return publicSource(`Supervisor lookup failed: unexpected own add-on slug ${JSON.stringify(ownSlug)}`);
  }
  const slug = `${ownSlug.slice(0, -OWN_SLUG_SUFFIX.length)}${FORECAST_SLUG_SUFFIX}`;

  const addon = await get(`/addons/${encodeURIComponent(slug)}/info`);
  // The Supervisor answers 404 for an unknown slug and 400 for a known add-on
  // that is not installed.
  if (addon.status === 400 || addon.status === 404) return publicSource('not installed');
  if (!addon.ok) return publicSource(`Supervisor lookup failed: /addons/${slug}/info returned status ${addon.status}`);
  const info = await supervisorData(addon);
  if (!info) return publicSource(`Supervisor lookup failed: no add-on info for ${slug}`);
  if (info.state !== 'started') return publicSource(`not started (state ${String(info.state)})`);
  if (typeof info.hostname !== 'string' || info.hostname === '') {
    return publicSource(`Supervisor lookup failed: ${slug} reports no hostname`);
  }
  return { url: `http://${info.hostname}`, source: 'local' };
}

/**
 * The forecast source for a `forecastUrl` setting at `nowMs` (see the module
 * comment). Never throws: every failure is a public fallback with a reason.
 */
export async function resolveForecastSource(
  forecastUrl: string,
  { nowMs, env = process.env, fetchImpl = defaultFetch }: ResolveForecastSourceOptions,
): Promise<ForecastSource> {
  if (!isAutoForecastUrl(forecastUrl)) return { url: forecastUrl.trim(), source: 'configured' };
  const token = env.SUPERVISOR_TOKEN;
  if (!token) return publicSource('no Supervisor');

  if (cache && cache.forecastUrl === forecastUrl && nowMs >= cache.atMs && nowMs - cache.atMs < FORECAST_SOURCE_CACHE_MS) {
    return cache.result;
  }
  let result: ForecastSource;
  try {
    result = await lookUpLocalAddon(token, fetchImpl);
  } catch (err) {
    result = publicSource(`Supervisor lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  cache = { forecastUrl, atMs: nowMs, result };
  return result;
}

/** Test hook: forget the cached resolution. */
export function resetForecastSourceCache(): void {
  cache = null;
}
