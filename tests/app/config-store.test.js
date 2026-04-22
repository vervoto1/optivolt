// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchStoredSettings: vi.fn(),
  saveStoredSettings: vi.fn(),
}));

import { fetchStoredSettings, saveStoredSettings } from '../../app/src/api/api.js';
import { loadInitialConfig, saveConfig } from '../../app/src/config-store.js';

describe('config-store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads settings from the API', async () => {
    fetchStoredSettings.mockResolvedValue({ stepSize_m: 15 });
    await expect(loadInitialConfig()).resolves.toEqual({
      config: { stepSize_m: 15 },
      source: 'api',
    });
  });

  it('returns api-error fallback on fetch failure', async () => {
    fetchStoredSettings.mockRejectedValue(new Error('boom'));
    await expect(loadInitialConfig()).resolves.toEqual({
      config: {},
      source: 'api-error',
    });
  });

  it('uses empty config when fetchStoredSettings returns falsy value', async () => {
    fetchStoredSettings.mockResolvedValue(null);
    await expect(loadInitialConfig()).resolves.toEqual({
      config: {},
      source: 'api',
    });
  });

  it('delegates config saves to the API layer', async () => {
    const config = { stepSize_m: 60 };
    await saveConfig(config);
    expect(saveStoredSettings).toHaveBeenCalledWith(config);
  });
});
