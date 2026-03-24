import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeHaWsUrl,
  haWsToHttp,
  resolveHaHttpConfig,
  resolveHaWsConfig,
} from '../../../api/services/ha-config.ts';

describe('ha-config', () => {
  beforeEach(() => {
    delete process.env.SUPERVISOR_TOKEN;
  });

  afterEach(() => {
    delete process.env.SUPERVISOR_TOKEN;
  });

  describe('normalizeHaWsUrl', () => {
    it('trims whitespace', () => {
      expect(normalizeHaWsUrl('  ws://ha:8123/api/websocket  ')).toBe('ws://ha:8123/api/websocket');
    });

    it('handles null/undefined', () => {
      expect(normalizeHaWsUrl(null)).toBe('');
      expect(normalizeHaWsUrl(undefined)).toBe('');
    });
  });

  describe('haWsToHttp', () => {
    it('converts ws to http', () => {
      expect(haWsToHttp('ws://ha:8123/api/websocket')).toBe('http://ha:8123');
    });

    it('converts wss to https', () => {
      expect(haWsToHttp('wss://ha:8123/api/websocket')).toBe('https://ha:8123');
    });

    it('throws for invalid URL', () => {
      expect(() => haWsToHttp('http://ha:8123')).toThrow('haUrl must be a Home Assistant websocket URL');
      expect(() => haWsToHttp('')).toThrow();
      expect(() => haWsToHttp('ws://ha:8123/wrong')).toThrow();
    });
  });

  describe('resolveHaHttpConfig', () => {
    it('uses SUPERVISOR_TOKEN when available', () => {
      process.env.SUPERVISOR_TOKEN = 'supervisor-tok';
      const result = resolveHaHttpConfig('ws://ha:8123/api/websocket', 'user-tok');
      expect(result).toEqual({
        baseUrl: 'http://supervisor/core',
        token: 'supervisor-tok',
      });
    });

    it('returns null when no token', () => {
      expect(resolveHaHttpConfig('ws://ha:8123/api/websocket', '')).toBeNull();
      expect(resolveHaHttpConfig('ws://ha:8123/api/websocket', null)).toBeNull();
    });

    it('converts WS URL and uses provided token', () => {
      const result = resolveHaHttpConfig('ws://ha:8123/api/websocket', 'tok');
      expect(result).toEqual({
        baseUrl: 'http://ha:8123',
        token: 'tok',
      });
    });
  });

  describe('resolveHaWsConfig', () => {
    it('uses SUPERVISOR_TOKEN when available', () => {
      process.env.SUPERVISOR_TOKEN = 'supervisor-tok';
      const result = resolveHaWsConfig('ws://ha:8123/api/websocket', 'user-tok');
      expect(result).toEqual({
        url: 'ws://supervisor/core/websocket',
        token: 'supervisor-tok',
      });
    });

    it('returns null when no token', () => {
      expect(resolveHaWsConfig('ws://ha:8123/api/websocket', '')).toBeNull();
    });

    it('returns null when no URL', () => {
      expect(resolveHaWsConfig('', 'tok')).toBeNull();
    });

    it('throws for invalid URL with valid token', () => {
      expect(() => resolveHaWsConfig('http://ha:8123', 'tok')).toThrow('haUrl must be a Home Assistant websocket URL');
    });

    it('returns config for valid inputs', () => {
      const result = resolveHaWsConfig('ws://ha:8123/api/websocket', 'tok');
      expect(result).toEqual({
        url: 'ws://ha:8123/api/websocket',
        token: 'tok',
      });
    });
  });
});
