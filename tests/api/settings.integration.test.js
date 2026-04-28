import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, post } from './helpers/express-test-client.js';

vi.mock('../../api/services/auto-calculate.ts');
vi.mock('../../api/services/dess-price-refresh.ts');
vi.mock('../../api/services/shore-optimizer.ts');

import { startAutoCalculate, stopAutoCalculate } from '../../api/services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../../api/services/dess-price-refresh.ts';
import { startShoreOptimizer, stopShoreOptimizer } from '../../api/services/shore-optimizer.ts';

async function importRouter() {
  vi.resetModules();
  return (await import('../../api/routes/settings.ts')).default;
}

describe('Settings route integration', () => {
  let tempDir;
  let settingsRouter;

  beforeEach(async () => {
    vi.resetAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-settings-route-'));
    process.env.DATA_DIR = tempDir;
    settingsRouter = await importRouter();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    delete process.env.SUPERVISOR_TOKEN;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSettings(settings) {
    await fs.writeFile(path.join(tempDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  it('GET /settings redacts haToken from persisted settings', async () => {
    await writeSettings({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'secret-token',
    });

    const res = await get(settingsRouter, '/');

    expect(res.status).toBe(200);
    expect(res.body.hasHaToken).toBe(true);
    expect(res.body.haToken).toBeUndefined();
  });

  it('POST /settings structurally merges nested settings and persists write-only token updates', async () => {
    await writeSettings({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'old-token',
      evConfig: {
        enabled: false,
        chargerPower_W: 11000,
        disableDischargeWhileCharging: true,
        scheduleSensor: 'sensor.old',
        scheduleAttribute: 'charging_schedule',
        connectedSwitch: 'switch.old',
        alwaysApplySchedule: false,
      },
    });

    const res = await post(settingsRouter, '/', {
      evConfig: { enabled: true, scheduleSensor: 'sensor.new' },
      haToken: 'new-token',
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(saved.haToken).toBe('new-token');
    expect(saved.evConfig.enabled).toBe(true);
    expect(saved.evConfig.scheduleSensor).toBe('sensor.new');
    expect(saved.evConfig.chargerPower_W).toBe(11000);
    expect(stopAutoCalculate).toHaveBeenCalled();
    expect(startAutoCalculate).toHaveBeenCalled();
    expect(stopDessPriceRefresh).toHaveBeenCalled();
    expect(startDessPriceRefresh).toHaveBeenCalled();
    expect(stopShoreOptimizer).toHaveBeenCalled();
    expect(startShoreOptimizer).toHaveBeenCalled();
  });

  it('POST /settings rejects invalid Home Assistant URLs', async () => {
    const res = await post(settingsRouter, '/', {
      haUrl: 'http://not-a-websocket-url',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Home Assistant websocket URL/);
  });
});
