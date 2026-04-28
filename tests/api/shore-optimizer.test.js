import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from './helpers/express-test-client.js';

vi.mock('../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../api/services/shore-optimizer.ts', () => ({
  getShoreOptimizerStatus: vi.fn(),
}));

import { loadSettings } from '../../api/services/settings-store.ts';
import { getShoreOptimizerStatus } from '../../api/services/shore-optimizer.ts';
import shoreOptimizerRouter from '../../api/routes/shore-optimizer.ts';

describe('shore optimizer route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('GET /status returns runtime status', async () => {
    const settings = { shoreOptimizer: { enabled: false } };
    const status = {
      enabled: false,
      dryRun: true,
      lastTickAt: null,
      lastWriteAt: null,
      currentShoreA: null,
      mpptState: null,
      mpptStateDisplay: null,
      mpptStateRaw: null,
      batteryPowerW: null,
      slotMode: 'unknown',
      stale: { currentShoreA: true, mpptState: true, batteryPowerW: true },
      recentWrites: [],
    };
    loadSettings.mockResolvedValue(settings);
    getShoreOptimizerStatus.mockReturnValue(status);

    const res = await get(shoreOptimizerRouter, '/status');

    expect(res.status).toBe(200);
    expect(getShoreOptimizerStatus).toHaveBeenCalledWith(settings.shoreOptimizer);
    expect(res.body).toEqual(status);
  });
});
