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
      autoCalculate: {
        enabled: false,
        intervalMinutes: 20,
        updateData: true,
        writeToVictron: true,
      },
    });

    const res = await post(settingsRouter, '/', {
      autoCalculate: { enabled: true },
      haToken: 'new-token',
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(saved.haToken).toBe('new-token');
    expect(saved.autoCalculate.enabled).toBe(true);
    expect(saved.autoCalculate.intervalMinutes).toBe(20);
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

  it('POST /settings rejects a zero efficiency with a 400 naming the field and persists nothing', async () => {
    const stored = { dischargeEfficiency_percent: 95, chargeEfficiency_percent: 95, inverterEfficiency_percent: 95 };
    await writeSettings(stored);
    const before = await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8');

    const res = await post(settingsRouter, '/', { dischargeEfficiency_percent: 0, maxSoc_percent: 90 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dischargeEfficiency_percent must be a number between 1 and 100/);
    expect(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8')).toBe(before);
    expect(startAutoCalculate).not.toHaveBeenCalled();
  });

  it('POST /settings rejects string booleans and unknown enum values instead of coercing them', async () => {
    const offRes = await post(settingsRouter, '/', { rebalanceEnabled: 'off' });
    expect(offRes.status).toBe(400);
    expect(offRes.body.error).toMatch(/rebalanceEnabled must be a boolean/);

    const enumRes = await post(settingsRouter, '/', { terminalSocValuation: 'Avg' });
    expect(enumRes.status).toBe(400);
    expect(enumRes.body.error).toMatch(/terminalSocValuation must be one of/);

    await expect(fs.access(path.join(tempDir, 'settings.json'))).rejects.toThrow();
  });

  it('POST /settings still saves other fields when a bad efficiency is already stored', async () => {
    // Only the incoming patch is validated: the stored value is not clamped
    // (it keeps failing the solve loudly) and does not block unrelated saves.
    await writeSettings({ dischargeEfficiency_percent: 0, inverterEfficiency_percent: 95 });

    const res = await post(settingsRouter, '/', { maxSoc_percent: 90, rebalanceEnabled: true });

    expect(res.status).toBe(200);
    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(saved.maxSoc_percent).toBe(90);
    expect(saved.rebalanceEnabled).toBe(true);
    expect(saved.dischargeEfficiency_percent).toBe(0);
  });
});
