// "Refresh from VRM" against the real settings store: the settings it hands
// back (the route replies with them, and the UI refills its form from them)
// must be what was written to settings.json, normalised, not the raw merge.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetchDessSettings, mockReadSocLimits } = vi.hoisted(() => ({
  mockFetchDessSettings: vi.fn(),
  mockReadSocLimits: vi.fn(),
}));

vi.mock('../../../lib/vrm-api.ts', () => ({
  VRMClient: class {
    constructor() {
      this.fetchDynamicEssSettings = mockFetchDessSettings;
    }
  },
}));

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  readVictronSocLimits: mockReadSocLimits,
  readVictronSocPercent: vi.fn(),
}));

describe('refreshSettingsFromVrmAndPersist with the real settings store', () => {
  let tempDir;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-vrm-settings-'));
    process.env.DATA_DIR = tempDir;
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';
    mockFetchDessSettings.mockResolvedValue({
      batteryCapacity_Wh: 12000.6,
      dischargePower_W: 6000.4,
      chargePower_W: 5000,
      maxPowerFromGrid_W: 8000,
      maxPowerToGrid_W: 7000,
      batteryCosts_cents_per_kWh: 4,
    });
    // An inverted pair as read from the GX.
    mockReadSocLimits.mockResolvedValue({ minSoc_percent: 95, maxSoc_percent: 90 });
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the normalised settings it wrote: rounded values, a repaired SoC pair', async () => {
    const { refreshSettingsFromVrmAndPersist } = await import('../../../api/services/vrm-refresh.ts');

    const returned = await refreshSettingsFromVrmAndPersist();

    const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(onDisk.minSoc_percent).toBe(90);
    expect(onDisk.maxSoc_percent).toBe(95);
    expect(onDisk.batteryCapacity_Wh).toBe(12001);
    expect(returned.minSoc_percent).toBe(90);
    expect(returned.maxSoc_percent).toBe(95);
    expect(returned.batteryCapacity_Wh).toBe(12001);
    expect(returned.maxDischargePower_W).toBe(6000);
    expect(returned).toEqual(onDisk);
  });
});
