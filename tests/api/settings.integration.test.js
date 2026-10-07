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

  describe('rebalance cycle reset on toggle', () => {
    const PENDING_SINCE_MS = Date.parse('2024-01-01T00:00:00Z');
    const dataPath = () => path.join(tempDir, 'data.json');

    async function writeDataWithRebalanceState(rebalanceState) {
      const defaults = JSON.parse(await fs.readFile(new URL('../../api/defaults/default-data.json', import.meta.url), 'utf8'));
      await fs.writeFile(dataPath(), `${JSON.stringify({ ...defaults, rebalanceState }, null, 2)}\n`, 'utf8');
    }
    const readRebalanceState = async () => JSON.parse(await fs.readFile(dataPath(), 'utf8')).rebalanceState;

    it('POST /settings clears a stale pendingSinceMs when rebalancing is switched on again', async () => {
      // Disabled, then re-enabled before any plan ran with rebalancing off.
      await writeSettings({ rebalanceEnabled: false });
      await writeDataWithRebalanceState({ startMs: null, pendingSinceMs: PENDING_SINCE_MS });

      const res = await post(settingsRouter, '/', { rebalanceEnabled: true });

      expect(res.status).toBe(200);
      expect(await readRebalanceState()).toEqual({ startMs: null });
    });

    it('POST /settings resets a started hold when rebalancing is switched off mid-hold', async () => {
      await writeSettings({ rebalanceEnabled: true });
      await writeDataWithRebalanceState({ startMs: PENDING_SINCE_MS, pendingSinceMs: PENDING_SINCE_MS });

      await post(settingsRouter, '/', { rebalanceEnabled: false });

      expect(await readRebalanceState()).toEqual({ startMs: null });
    });

    it('POST /settings resets a started hold when rebalancing is switched on again', async () => {
      // Disabled mid-hold before this fix (or before any plan ran): the stale
      // start would otherwise read as a completed cycle on the next plan.
      await writeSettings({ rebalanceEnabled: false });
      await writeDataWithRebalanceState({ startMs: PENDING_SINCE_MS });

      await post(settingsRouter, '/', { rebalanceEnabled: true });

      expect(await readRebalanceState()).toEqual({ startMs: null });
    });

    it('POST /settings keeps the rest of the data file when it resets the cycle', async () => {
      await writeSettings({ rebalanceEnabled: true });
      await writeDataWithRebalanceState({ startMs: PENDING_SINCE_MS });
      const raw = JSON.parse(await fs.readFile(dataPath(), 'utf8'));
      await fs.writeFile(dataPath(), JSON.stringify({ ...raw, lastFullSocAt: '2024-01-01T00:00:00.000Z' }), 'utf8');

      await post(settingsRouter, '/', { rebalanceEnabled: false });

      const saved = JSON.parse(await fs.readFile(dataPath(), 'utf8'));
      expect(saved.rebalanceState).toEqual({ startMs: null });
      expect(saved.lastFullSocAt).toBe('2024-01-01T00:00:00.000Z');
      expect(saved.load).toEqual(raw.load);
    });

    it('POST /settings writes nothing on a toggle when there is no cycle progress to reset', async () => {
      await writeSettings({ rebalanceEnabled: true });
      await writeDataWithRebalanceState({ startMs: null });
      const before = await fs.readFile(dataPath(), 'utf8');

      await post(settingsRouter, '/', { rebalanceEnabled: false });

      expect(await fs.readFile(dataPath(), 'utf8')).toBe(before);
    });

    it('POST /settings leaves the marker alone when rebalanceEnabled does not change', async () => {
      await writeSettings({ rebalanceEnabled: true });
      await writeDataWithRebalanceState({ startMs: null, pendingSinceMs: PENDING_SINCE_MS });
      const before = await fs.readFile(dataPath(), 'utf8');

      await post(settingsRouter, '/', { rebalanceEnabled: true, maxSoc_percent: 95 });

      expect(await fs.readFile(dataPath(), 'utf8')).toBe(before);
    });

    it('POST /settings still saves when the data file cannot be patched', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeSettings({ rebalanceEnabled: false });
      await fs.writeFile(dataPath(), '{ not json', 'utf8');

      const res = await post(settingsRouter, '/', { rebalanceEnabled: true });

      expect(res.status).toBe(200);
      expect(JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8')).rebalanceEnabled).toBe(true);
      expect(warn).toHaveBeenCalledWith('[settings] could not reset the rebalance cycle progress:', expect.any(String));
      warn.mockRestore();
    });
  });
});
