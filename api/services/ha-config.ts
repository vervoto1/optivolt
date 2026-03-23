import { HttpError } from '../http-errors.ts';

const HA_WS_URL = /^wss?:\/\/[^/]+(?::\d+)?\/api\/websocket\/?$/i;

export function normalizeHaWsUrl(haUrl: string): string {
  return String(haUrl ?? '').trim();
}

export function haWsToHttp(haUrl: string): string {
  const wsUrl = normalizeHaWsUrl(haUrl);
  if (!HA_WS_URL.test(wsUrl)) {
    throw new HttpError(400, 'haUrl must be a Home Assistant websocket URL like ws://host:8123/api/websocket');
  }

  return wsUrl
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/api\/websocket\/?$/i, '');
}

export function resolveHaHttpConfig(haUrl: string, haToken: string): { baseUrl: string; token: string } | null {
  if (process.env.SUPERVISOR_TOKEN) {
    return {
      baseUrl: 'http://supervisor/core',
      token: process.env.SUPERVISOR_TOKEN,
    };
  }

  const token = String(haToken ?? '');
  if (!token) {
    return null;
  }

  return {
    baseUrl: haWsToHttp(haUrl),
    token,
  };
}

export function resolveHaWsConfig(haUrl: string, haToken: string): { url: string; token: string } | null {
  if (process.env.SUPERVISOR_TOKEN) {
    return {
      url: 'ws://supervisor/core/websocket',
      token: process.env.SUPERVISOR_TOKEN,
    };
  }

  const token = String(haToken ?? '');
  const url = normalizeHaWsUrl(haUrl);
  if (!token || !url) {
    return null;
  }
  if (!HA_WS_URL.test(url)) {
    throw new HttpError(400, 'haUrl must be a Home Assistant websocket URL like ws://host:8123/api/websocket');
  }

  return { url, token };
}

