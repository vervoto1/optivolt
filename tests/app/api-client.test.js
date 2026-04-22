// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getJson, postJson } from '../../app/src/api/client.js';
import { fetchStoredSettings, saveStoredSettings, fetchHaEntityState } from '../../app/src/api/api.js';

function mockFetch(text, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(typeof text === 'string' ? text : JSON.stringify(text)),
    json: () => Promise.resolve(typeof text === 'string' ? text : text),
  });
}

function mockFetchError(status = 500, message = 'Internal Server Error') {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify({ error: message })),
  });
}

describe('getJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls fetch with the path and options', async () => {
    mockFetch({ ok: true });
    await getJson('/test');
    expect(global.fetch).toHaveBeenCalledWith('./test', expect.any(Object));
  });
});

describe('postJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs JSON with content-type header', async () => {
    mockFetch({ saved: true });
    await postJson('/save', { key: 'value' });
    expect(global.fetch).toHaveBeenCalledWith('./save', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: 'value' }),
    }));
  });
});

describe('fetchStoredSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('returns empty object when fetch fails', async () => {
    mockFetchError(500, 'API request failed');
    let caught;
    try {
      await fetchStoredSettings();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe('API request failed');
  });

  it('returns empty object when response is non-object (string)', async () => {
    mockFetch('invalid json');
    const result = await fetchStoredSettings();
    expect(result).toEqual({});
  });

  it('returns the settings object when response is valid JSON object', async () => {
    mockFetch({ stepSize_m: 15, batteryCapacity_Wh: 10000 });
    const result = await fetchStoredSettings();
    expect(result.stepSize_m).toBe(15);
    expect(result.batteryCapacity_Wh).toBe(10000);
  });

  it('calls fetch with correct path', async () => {
    mockFetch({ stepSize_m: 15 });
    await fetchStoredSettings();
    expect(global.fetch).toHaveBeenCalledWith('./settings', expect.any(Object));
  });
});

describe('saveStoredSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs config to ./settings', async () => {
    mockFetch({ message: 'saved' });
    const config = { stepSize_m: 15 };
    await saveStoredSettings(config);
    expect(global.fetch).toHaveBeenCalledWith('./settings', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(config),
    }));
  });
});

describe('fetchHaEntityState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GETs the correct entity path with URL encoding', async () => {
    mockFetch({ entity_id: 'sensor.test', state: '42' });
    await fetchHaEntityState('sensor/with spaces');
    expect(global.fetch).toHaveBeenCalledWith('./ha/entity/sensor%2Fwith%20spaces', expect.any(Object));
  });

  it('GETs the correct entity path for simple entity', async () => {
    mockFetch({ entity_id: 'sensor.test', state: '42' });
    await fetchHaEntityState('sensor.test');
    expect(global.fetch).toHaveBeenCalledWith('./ha/entity/sensor.test', expect.any(Object));
  });
});
