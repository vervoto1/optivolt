import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, post } from './helpers/express-test-client.js';

async function importRouter() {
  vi.resetModules();
  return (await import('../../api/routes/data.ts')).default;
}

describe('Data route integration', () => {
  let tempDir;
  let dataRouter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-data-route-'));
    process.env.DATA_DIR = tempDir;
    dataRouter = await importRouter();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSettings(settings) {
    await fs.writeFile(path.join(tempDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  async function writeData(data) {
    await fs.writeFile(path.join(tempDir, 'data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  it('GET /data returns persisted data', async () => {
    await writeData({
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [1, 2] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 11] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });

    const res = await get(dataRouter, '/');

    expect(res.status).toBe(200);
    expect(res.body.load.values).toEqual([1, 2]);
  });

  it('POST /data updates only API-backed keys and preserves existing data', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api', evLoad: 'api' },
    });
    await writeData({
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [500, 500] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });

    const res = await post(dataRouter, '/', {
      importPrice: { start: '2024-02-01T00:00:00Z', step: 60, values: [99, 99, 99] },
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(res.body.keysUpdated).toEqual(['importPrice']);
    expect(saved.importPrice.values).toEqual([99, 99, 99]);
    expect(saved.exportPrice.values).toEqual([5, 5]);
  });

  it('POST /data rejects keys whose source is not api', async () => {
    await writeSettings({
      dataSources: { prices: 'vrm', load: 'api', pv: 'api', soc: 'api' },
    });

    const res = await post(dataRouter, '/', {
      importPrice: { start: '2024-02-01T00:00:00Z', step: 60, values: [99] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No valid data keys provided or settings are not set to API');
  });

  it('POST /data validates payload shape before writing', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });

    const res = await post(dataRouter, '/', {
      importPrice: { start: 'invalid-date', values: [] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid timestamp/);
  });

  it('POST /data accepts evLoad when evLoad is API-backed', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api', evLoad: 'api' },
    });

    const res = await post(dataRouter, '/', {
      evLoad: { start: '2026-03-17T00:00:00.000Z', step: 15, values: [0, 0, 11000] },
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(res.body.keysUpdated).toEqual(['evLoad']);
    expect(saved.evLoad.values).toEqual([0, 0, 11000]);
  });
});
