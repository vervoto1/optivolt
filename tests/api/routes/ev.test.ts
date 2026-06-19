import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import evRouter from '../../../api/routes/ev.ts';
import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { runActuatorTick } from '../../../api/services/ev-actuator-service.ts';
import { get, post } from '../helpers/express-test-client.js';

// ---------------------------------------------------------------------------
// Mocks — only the deps the /override handlers touch need real behaviour; the
// rest are stubbed so importing the router stays side-effect free.
// ---------------------------------------------------------------------------
vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('../../../api/services/ev-actuator-service.ts', () => ({
  getLastActuation: vi.fn(() => ({})),
  runActuatorTick: vi.fn(async () => ({})),
}));
vi.mock('../../../api/services/planner-service.ts', () => ({
  getLastPlan: vi.fn(() => null),
  getLastEvPreview: vi.fn(() => null),
}));
vi.mock('../../../api/services/ev-decision-service.ts', () => ({
  computeEvDecision: vi.fn(),
}));

// Note: the test client already applies express.json() before the handler, so
// this sub-app must NOT add its own (a second read of the consumed request
// stream throws "stream is not readable").
function makeServer() {
  const app = express();
  app.use('/ev', evRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if ('statusCode' in err) {
      res.status((err as { statusCode: number }).statusCode).json({ message: err.message });
    } else {
      res.status(500).json({ message: 'Internal Server Error' });
    }
  });
  return app;
}

describe('GET /ev/override', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the persisted override mode', async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ evOverrideMode: 'charge' });
    const res = await get(makeServer(), '/ev/override');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'charge' });
  });

  it("defaults to 'auto' when unset", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await get(makeServer(), '/ev/override');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'auto' });
  });
});

describe('POST /ev/override', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('persists a valid mode and fires one actuator tick', async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ evOverrideMode: 'auto' });
    const res = await post(makeServer(), '/ev/override', { mode: 'stop' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'stop' });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ evOverrideMode: 'stop' }));
    expect(runActuatorTick).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid mode with 400 and writes nothing', async () => {
    const res = await post(makeServer(), '/ev/override', { mode: 'bogus' });
    expect(res.status).toBe(400);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(runActuatorTick).not.toHaveBeenCalled();
  });
});
