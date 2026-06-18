// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callHaService } from '../../../api/services/ha-client.ts';

const HA = { haUrl: 'ws://h:8123/api/websocket', haToken: 'tok' };

describe('callHaService — generic HA write path', () => {
  beforeEach(() => {
    delete process.env.SUPERVISOR_TOKEN;
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs to /api/services/{domain}/{service} with the target body', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await callHaService({ ...HA, domain: 'switch', service: 'turn_on', target: { entity_id: 'switch.x' } });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://h:8123/api/services/switch/turn_on',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ entity_id: 'switch.x' });
  });

  it('merges target + data (number.set_value)', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await callHaService({ ...HA, domain: 'number', service: 'set_value', target: { entity_id: 'number.amps' }, data: { value: 16 } });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ entity_id: 'number.amps', value: 16 });
  });

  it('sends data only when no target is given (target ?? {})', async () => {
    // A targetless service call (e.g. a script/scene) still POSTs a body built
    // purely from `data`; the `target ?? {}` fallback must contribute nothing.
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await callHaService({ ...HA, domain: 'homeassistant', service: 'restart', data: { foo: 'bar' } });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ foo: 'bar' });
  });

  it('sends an empty body when neither target nor data is given', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await callHaService({ ...HA, domain: 'script', service: 'run_thing' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({});
  });

  it('throws when HA returns non-OK', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(callHaService({ ...HA, domain: 'switch', service: 'turn_on', target: { entity_id: 'switch.x' } }))
      .rejects.toThrow(/500/);
  });

  it('throws when HA is not configured (no token, no supervisor)', async () => {
    await expect(callHaService({ haUrl: HA.haUrl, haToken: '', domain: 'switch', service: 'turn_on' }))
      .rejects.toThrow(/not configured/);
  });
});
