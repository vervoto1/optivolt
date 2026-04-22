import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import haRouter from '../../../api/routes/ha.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
}));

// Build a test app wrapping the router with an error handler
function makeServer() {
  const app = express();
  app.use(express.json());
  app.use('/ha', haRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if ('statusCode' in err) {
      res.status((err as { statusCode: number }).statusCode).json({ message: err.message });
    } else {
      res.status(500).json({ message: 'Internal Server Error' });
    }
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /ha/entity/:entityId', () => {
  const request = supertest(makeServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 422 when HA URL is not configured', async () => {
    const settings = {}; // No haUrl
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settings);

    const res = await request.get('/ha/entity/sensor.temperature');
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('HA URL is not configured');
  });

  it('returns entity state on success', async () => {
    const settings = { haUrl: 'http://ha.local:8123' };
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
    (fetchHaEntityState as ReturnType<typeof vi.fn>).mockResolvedValue({
      entity_id: 'sensor.temperature',
      state: '22.5',
      attributes: {},
      last_changed: '2024-01-01T00:00:00Z',
      last_updated: '2024-01-01T00:00:00Z',
    });

    const res = await request.get('/ha/entity/sensor.temperature');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('22.5');
  });

  it('returns 422 with mapped error when fetchHaEntityState fails', async () => {
    const settings = { haUrl: 'http://ha.local:8123' };
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
    (fetchHaEntityState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));

    const res = await request.get('/ha/entity/sensor.temperature');
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('Connection refused');
  });

  it('encodes special characters in entityId', async () => {
    const settings = { haUrl: 'http://ha.local:8123' };
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
    (fetchHaEntityState as ReturnType<typeof vi.fn>).mockResolvedValue({
      entity_id: 'sensor.my sensor',
      state: '42',
      attributes: {},
      last_changed: '2024-01-01T00:00:00Z',
      last_updated: '2024-01-01T00:00:00Z',
    });

    const res = await request.get('/ha/entity/sensor%2Fmy%20sensor');
    expect(res.status).toBe(200);
  });
});
