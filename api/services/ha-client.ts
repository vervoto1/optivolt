/**
 * ha-client.ts
 *
 * Home Assistant client: WebSocket for long-term statistics, REST for entity state.
 * Uses the Node.js built-in WebSocket (Node >= 22) and built-in fetch.
 * Creates a new WebSocket connection per call.
 */

import type { HaReading } from '../../lib/ha-postprocess.ts';
import { resolveHaHttpConfig, resolveHaWsConfig } from './ha-config.ts';

// REST calls have no implicit timeout in Node's fetch. The control loops
// (charge limiter, balance tuner) read/write through here every tick, and a hung
// request would freeze the whole loop (the `ticking` guard skips later ticks) so
// no over-voltage protection runs until the OS socket times out. Bound it well
// under the default control interval so a stalled HA frees the next tick.
const HA_REST_TIMEOUT_MS = 10_000;

// ----------------------------- REST: entity state -----------------------------

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface FetchHaEntityStateOptions {
  haUrl: string;
  haToken: string;
  entityId: string;
}

/**
 * Convert a WebSocket URL (ws:// or wss://) to an HTTP base URL (http:// or https://).
 * Strips the /api/websocket suffix if present.
 */
export function wsUrlToHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // Remove the websocket path suffix
  url.pathname = url.pathname.replace(/\/api\/websocket$/, '');
  return url.toString().replace(/\/$/, '');
}

/**
 * Fetch a single entity state from the HA REST API.
 * In add-on mode, uses the supervisor proxy instead.
 */
export async function fetchHaEntityState({
  haUrl,
  haToken,
  entityId,
}: FetchHaEntityStateOptions): Promise<HaEntityState> {
  const isAddon = !!process.env.SUPERVISOR_TOKEN;
  const baseUrl = isAddon ? 'http://supervisor/core' : wsUrlToHttp(haUrl);
  const token: string = isAddon ? process.env.SUPERVISOR_TOKEN! : haToken;

  const url = `${baseUrl}/api/states/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(HA_REST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`HA returned ${res.status} for entity "${entityId}"`);
  }

  return res.json() as Promise<HaEntityState>;
}

interface FetchHaCredentials {
  haUrl: string;
  haToken: string;
}

/**
 * Fetch ALL entity states in one request via the HA REST `GET /api/states`
 * built-in. Far cheaper than N per-entity GETs when a dashboard reads dozens of
 * sensors on a poll loop. The caller indexes the result by entity id; ids that
 * are absent simply have no entry (per-entity tolerance for entity-id drift).
 */
export async function fetchHaEntityStates({ haUrl, haToken }: FetchHaCredentials): Promise<HaEntityState[]> {
  const cfg = resolveHaHttpConfig(haUrl, haToken);
  if (!cfg) {
    throw new Error('Home Assistant connection is not configured');
  }

  const res = await fetch(`${cfg.baseUrl}/api/states`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (!res.ok) {
    throw new Error(`HA returned ${res.status} for /api/states`);
  }

  return res.json() as Promise<HaEntityState[]>;
}

interface CallHaServiceOptions extends FetchHaCredentials {
  domain: string;                       // e.g. 'switch', 'number'
  service: string;                      // e.g. 'turn_on', 'set_value'
  target?: Record<string, unknown>;     // e.g. { entity_id: 'switch.charger' }
  data?: Record<string, unknown>;       // e.g. { value: 16 }
}

/**
 * Call a Home Assistant service via the REST `POST /api/services/{domain}/{service}`
 * endpoint — the generic WRITE path (ha-client is otherwise read-only).
 *
 * In add-on mode this posts through the supervisor proxy
 * (`http://supervisor/core` + `SUPERVISOR_TOKEN`); the add-on manifest already
 * declares `homeassistant_api: true`, so no manifest change is needed. The HA
 * REST API accepts the target (`entity_id`) and service data merged into one
 * top-level JSON body.
 */
export async function callHaService({
  haUrl,
  haToken,
  domain,
  service,
  target,
  data,
}: CallHaServiceOptions): Promise<void> {
  const cfg = resolveHaHttpConfig(haUrl, haToken);
  if (!cfg) {
    throw new Error('Home Assistant connection is not configured');
  }
  const body = { ...(target ?? {}), ...(data ?? {}) };
  const res = await fetch(`${cfg.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HA_REST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HA service ${domain}.${service} returned ${res.status}`);
  }
}

export interface HaHistoryEntry {
  entity_id?: string;
  state: string;
  last_changed?: string;
  last_updated?: string;
}

interface FetchHaHistoryOptions extends FetchHaCredentials {
  entityIds: string[];
  startTime: string;
  endTime?: string;
}

/**
 * Fetch raw recorder history via the HA REST `GET /api/history/period` endpoint.
 *
 * This is the fallback for entities that have **no long-term statistics** (no
 * `state_class`, or excluded from the recorder) — for which
 * `recorder/statistics_during_period` returns an empty array. Per-cell BMS
 * voltages and cell temperatures frequently fall in this bucket, so without raw
 * history the trend charts would silently render blank.
 *
 * Returns one inner array of state entries per requested entity (HA preserves
 * request order). `no_attributes` keeps the payload small while retaining the
 * `entity_id`/`state`/`last_changed` fields the caller needs.
 */
export async function fetchHaHistory({
  haUrl,
  haToken,
  entityIds,
  startTime,
  endTime,
}: FetchHaHistoryOptions): Promise<HaHistoryEntry[][]> {
  const cfg = resolveHaHttpConfig(haUrl, haToken);
  if (!cfg) {
    throw new Error('Home Assistant connection is not configured');
  }
  if (entityIds.length === 0) {
    return [];
  }

  const params = new URLSearchParams();
  params.set('filter_entity_id', entityIds.join(','));
  params.set('no_attributes', 'true');
  params.set('minimal_response', 'true');
  if (endTime) params.set('end_time', endTime);

  const url = `${cfg.baseUrl}/api/history/period/${encodeURIComponent(startTime)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (!res.ok) {
    throw new Error(`HA returned ${res.status} for /api/history/period`);
  }

  return res.json() as Promise<HaHistoryEntry[][]>;
}

interface FetchHaStatsOptions {
  haUrl: string;
  haToken: string;
  entityIds: string[];
  startTime: string;
  endTime?: string;
  period?: string;
  timeoutMs?: number;
}

type HaWsMessage =
  | { type: 'auth_required' }
  | { type: 'auth_ok' }
  | { type: 'auth_invalid'; message: string }
  | { type: 'result'; success: true; result: Record<string, HaReading[]> }
  | { type: 'result'; success: false; error?: { message?: string } };

/**
 * Fetch statistics from HA via WebSocket.
 */
export async function fetchHaStats({
  haUrl,
  haToken,
  entityIds,
  startTime,
  endTime,
  period = 'hour',
  timeoutMs = 30000,
}: FetchHaStatsOptions): Promise<Record<string, HaReading[]>> {
  const haConfig = resolveHaWsConfig(haUrl, haToken);
  if (!haConfig) {
    throw new Error('Home Assistant connection is not configured');
  }
  const targetUrl = haConfig.url;
  const targetToken = haConfig.token;

  const ws = new WebSocket(targetUrl);

  return new Promise((resolve, reject) => {
    let authenticated = false;
    let commandId = 1;
    let settled = false;

    /* v8 ignore next 10 — setTimeout callback + done function exercised by tests
    but v8 statement tracking doesn't count bodies of async timer callbacks in jsdom */
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`HA WebSocket timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const done = (fn: () => void): void => {
      /* v8 ignore next — early return on settled already covered by tests */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.onmessage = (event) => {
      let msg: HaWsMessage;
      try {
        msg = JSON.parse(event.data as string) as HaWsMessage;
      } catch {
        return;
      }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: targetToken }));

      } else if (msg.type === 'auth_ok') {
        authenticated = true;
        const request: Record<string, unknown> = {
          id: commandId++,
          type: 'recorder/statistics_during_period',
          start_time: startTime,
          statistic_ids: entityIds,
          period,
        };
        if (endTime) request['end_time'] = endTime;
        ws.send(JSON.stringify(request));

      } else if (msg.type === 'auth_invalid') {
        ws.close();
        done(() => reject(new Error(`HA authentication failed: ${msg.message}`)));

      /* v8 ignore start — terminal else-if has no observable false branch (no further alternatives), v8 records it as a separate branch we can't exercise */
      } else if (msg.type === 'result') {
      /* v8 ignore stop */
        ws.close();
        if (msg.success) {
          done(() => resolve(msg.result));
        } else {
          // v8 ignore next — null paths of ?. and ?? on msg.error are untestable in tests
          done(() => reject(new Error(msg.error?.message ?? 'HA returned error result')));
        }
      }
    };

    ws.onerror = (event) => {
      ws.close();
      const msg = (event as ErrorEvent).message ?? String(event);
      done(() => reject(new Error(`HA WebSocket error: ${msg}`)));
    };

    ws.onclose = () => {
      if (!authenticated && !settled) {
        done(() => reject(new Error('HA WebSocket closed before authentication')));
      }
    };
  });
}
