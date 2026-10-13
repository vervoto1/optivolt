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

  it('POST /data records lastFullSocAt when API SoC reaches 100%', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });
    await writeData({
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [500, 500] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });

    const res = await post(dataRouter, '/', {
      soc: { value: 100, timestamp: '2024-02-01T12:00:00.000Z' },
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(saved.soc).toEqual({ value: 100, timestamp: '2024-02-01T12:00:00.000Z' });
    expect(saved.lastFullSocAt).toBe('2024-02-01T12:00:00.000Z');
  });

  it('POST /data and a concurrent prediction-adjustment write both survive (locked patches)', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });
    await writeData({
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [500, 500] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });
    const { createStoredPredictionAdjustment } = await import('../../api/services/prediction-adjustment-store.ts');

    const [res] = await Promise.all([
      post(dataRouter, '/', { importPrice: { start: '2024-02-01T00:00:00Z', step: 60, values: [99, 99, 99] } }),
      createStoredPredictionAdjustment({
        series: 'load', mode: 'add', value_W: 100,
        start: '2099-01-01T00:00:00.000Z', end: '2099-01-02T00:00:00.000Z',
      }),
    ]);

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(saved.importPrice.values).toEqual([99, 99, 99]);
    expect(saved.predictionAdjustments).toHaveLength(1);
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

  it('POST /data accepts marketPrice when prices are API-backed and validates it', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });

    const res = await post(dataRouter, '/', {
      marketPrice: { start: '2026-12-31T23:00:00.000Z', step: 15, values: [8.5, 9, -1] },
    });

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(res.status).toBe(200);
    expect(res.body.keysUpdated).toEqual(['marketPrice']);
    expect(saved.marketPrice.values).toEqual([8.5, 9, -1]);

    const bad = await post(dataRouter, '/', { marketPrice: { start: 'invalid-date', values: [] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/marketPrice.*not a valid timestamp/);
  });

  it('POST /data rejects non-numeric market prices and a non-array values field', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });

    const strings = await post(dataRouter, '/', {
      marketPrice: { start: '2026-12-31T23:00:00.000Z', step: 15, values: [8.5, '9'] },
    });
    expect(strings.status).toBe(400);
    expect(strings.body.error).toBe("'marketPrice' values must be numbers or null");

    const notArray = await post(dataRouter, '/', {
      marketPrice: { start: '2026-12-31T23:00:00.000Z', step: 15, values: 'x' },
    });
    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toMatch(/marketPrice.*'values' must be an array/);
  });

  it('POST /data accepts null market prices and removes the series on marketPrice: null', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });
    const readSaved = async () => JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));

    const res = await post(dataRouter, '/', {
      marketPrice: { start: '2026-12-31T23:00:00.000Z', step: 60, values: [8.5, null] },
    });
    expect(res.status).toBe(200);
    expect((await readSaved()).marketPrice.values).toEqual([8.5, null]);

    const cleared = await post(dataRouter, '/', { marketPrice: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.keysUpdated).toEqual(['marketPrice']);
    expect(await readSaved()).not.toHaveProperty('marketPrice');

    // Any other key still has to be an object.
    const badNull = await post(dataRouter, '/', { importPrice: null });
    expect(badNull.status).toBe(400);
    expect(badNull.body.error).toBe("'importPrice' must be a JSON object");
  });

  it('POST /data rejects a non-finite series value, but a legacy one in an untouched series does not block it', async () => {
    await writeSettings({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' },
    });
    // A pre-0.7.72 file with a null in the stored load (JSON has no NaN).
    await writeData({
      load: { start: '2024-01-01T00:00:00Z', step: 15, values: [500, null] },
      pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, 0] },
      importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bad = await post(dataRouter, '/', { pv: { start: '2024-01-01T00:00:00Z', step: 15, values: [0, null] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid pv: values[1] is not a finite number (null)');

    const strings = await post(dataRouter, '/', { importPrice: { start: '2024-01-01T00:00:00Z', step: 15, values: ['10'] } });
    expect(strings.status).toBe(400);

    const soc = await post(dataRouter, '/', { soc: { value: 61, timestamp: '2024-01-01T00:15:00Z' } });
    expect(soc.status).toBe(200);
    const saved = JSON.parse(await fs.readFile(path.join(tempDir, 'data.json'), 'utf8'));
    expect(saved.soc.value).toBe(61);
    expect(saved.load.values).toEqual([500, null]);
    warn.mockRestore();
  });

  it('POST /data rejects marketPrice when prices are not API-backed', async () => {
    await writeSettings({
      dataSources: { prices: 'ha', load: 'api', pv: 'api', soc: 'api' },
    });

    const res = await post(dataRouter, '/', {
      marketPrice: { start: '2026-12-31T23:00:00.000Z', step: 15, values: [8.5] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No valid data keys provided or settings are not set to API');
  });
});
