import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function importSettingsStore() {
  vi.resetModules();
  return import('../../../api/services/settings-store.ts');
}

describe('settings-store integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-settings-'));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists normalized settings to the configured DATA_DIR', async () => {
    const { loadSettings, saveSettings } = await importSettingsStore();
    const settings = await loadSettings();
    settings.minSoc_percent = 90;
    settings.maxSoc_percent = 10;
    settings.evConfig = {
      ...settings.evConfig,
      enabled: true,
      chargerPower_W: 11000.4,
      disableDischargeWhileCharging: true,
      scheduleSensor: 'sensor.ev',
      scheduleAttribute: 'charging_schedule',
      connectedSwitch: 'switch.ev',
      alwaysApplySchedule: false,
    };

    await saveSettings(settings);

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(raw.minSoc_percent).toBe(10);
    expect(raw.maxSoc_percent).toBe(90);
    expect(raw.evConfig.chargerPower_W).toBe(11000);
  });

  it('loads stored settings with nested dataSources merge intact', async () => {
    const settingsPath = path.join(tempDir, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({
      dataSources: { prices: 'ha' },
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'secret',
    }));

    const { loadSettings } = await importSettingsStore();
    const settings = await loadSettings();

    expect(settings.dataSources.prices).toBe('ha');
    expect(settings.dataSources.load).toBe('vrm');
    expect(settings.haToken).toBe('secret');
  });
});
