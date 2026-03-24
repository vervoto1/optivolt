// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getJson, postJson } from '../../../app/src/api/client.js';

describe('API Client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getJson calls fetch with GET', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
    });

    const res = await getJson('/test');
    expect(fetchMock).toHaveBeenCalledWith('./test', expect.objectContaining({ method: 'GET' }));
    expect(res).toEqual({ success: true });
  });

  it('postJson calls fetch with POST and payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
    });

    const payload = { foo: 'bar' };
    const res = await postJson('/test', payload);

    expect(fetchMock).toHaveBeenCalledWith('./test', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    }));
    expect(res).toEqual({ success: true });
  });

  it('throws error on non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'Bad Request' }),
    });

    await expect(getJson('/fail')).rejects.toThrow('Bad Request');
  });

  it('throws error on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('Network Error'));
    await expect(getJson('/fail')).rejects.toThrow('Network Error');
  });

  it('throws with message field from error JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'Forbidden access' }),
    });
    await expect(getJson('/fail')).rejects.toThrow('Forbidden access');
  });

  it('throws raw text when error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    await expect(getJson('/fail')).rejects.toThrow('Internal Server Error');
  });

  it('throws with raw text when JSON has no error or message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ foo: 'bar' }),
    });
    await expect(getJson('/fail')).rejects.toThrow('{"foo":"bar"}');
  });

  it('throws default message when error body is empty', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '',
    });
    await expect(getJson('/fail')).rejects.toThrow('API request to /fail failed with 400');
  });

  it('returns null for OK response with empty body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => '',
    });
    const result = await getJson('/empty');
    expect(result).toBeNull();
  });

  it('returns raw text for OK response with non-JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => 'plain text response',
    });
    const result = await getJson('/text');
    expect(result).toBe('plain text response');
  });

  it('handles text() throwing on error response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error('read error'); },
    });
    await expect(getJson('/fail')).rejects.toThrow('API request to /fail failed with 500');
  });
});
