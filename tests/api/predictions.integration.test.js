import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, post } from './helpers/express-test-client.js';

vi.mock('../../api/services/load-prediction-service.ts');
vi.mock('../../api/services/pv-prediction-service.ts');

import { runValidation, runForecast } from '../../api/services/load-prediction-service.ts';
import { runPvForecast } from '../../api/services/pv-prediction-service.ts';

async function importRouter() {
  vi.resetModules();
  return (await import('../../api/routes/predictions.ts')).default;
}

describe('Predictions route integration', () => {
  let tempDir;
  let predictionsRouter;

  beforeEach(async () => {
    vi.resetAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-predictions-route-'));
    process.env.DATA_DIR = tempDir;
    runValidation.mockResolvedValue({
      sensorNames: ['Grid Import'],
      results: [{ sensor: 'Grid Import', mae: 12, rmse: 18, mape: 5, n: 96, nSkipped: 0 }],
    });
    runForecast.mockResolvedValue({
      forecast: { start: '2026-02-20T00:00:00.000Z', step: 15, values: [200, 220] },
      recent: [],
    });
    runPvForecast.mockResolvedValue(null);
    predictionsRouter = await importRouter();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeJson(name, value) {
    await fs.writeFile(path.join(tempDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  it('POST /predictions/config persists config through the real store', async () => {
    const res = await post(predictionsRouter, '/config', {
      activeConfig: { sensor: 'Grid Import', lookbackWeeks: 6, dayFilter: 'same', aggregation: 'mean' },
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'prediction-config.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(saved.activeConfig.lookbackWeeks).toBe(6);
  });

  it('GET /predictions/config reads persisted config through the real store', async () => {
    await writeJson('prediction-config.json', {
      sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
      activeConfig: { sensor: 'Grid Import', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'mean' },
    });

    const res = await get(predictionsRouter, '/config');
    expect(res.status).toBe(200);
    expect(res.body.activeConfig.lookbackWeeks).toBe(3);
  });

  it('POST /predictions/validate reads HA credentials from real settings storage', async () => {
    await writeJson('settings.json', {
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'secret-token',
    });

    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(200);
    expect(runValidation).toHaveBeenCalledWith(expect.objectContaining({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'secret-token',
    }));
  });

  it('POST /predictions/load/forecast saves forecast into data.json when load source is api', async () => {
    await writeJson('settings.json', {
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'secret-token',
      dataSources: { load: 'api' },
    });
    await writeJson('data.json', {
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [1, 2] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 11] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });

    const res = await post(predictionsRouter, '/load/forecast', {});
    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));

    expect(res.status).toBe(200);
    expect(saved.load.values).toEqual([200, 220]);
  });

  it('POST /predictions/validate fails with 400 when standalone HA credentials are missing', async () => {
    await writeJson('settings.json', { haUrl: '', haToken: '' });

    const res = await post(predictionsRouter, '/validate', {});
    expect(res.status).toBe(400);
  });
});
