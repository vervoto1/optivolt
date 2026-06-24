import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from '../helpers/express-test-client.js';

// Isolated from tests/api/ev.test.js: here we mock settings-store and the EV
// decision service so we can drive the /status error path (line 135 catch).
vi.mock('../../../api/services/planner-service.ts', () => ({
  getLastPlan: vi.fn(() => null),
  getLastEvPreview: vi.fn(() => null),
}));
vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../../api/services/ev-decision-service.ts', () => ({
  computeEvDecision: vi.fn(),
}));
vi.mock('../../../api/services/ev-actuator-service.ts', () => ({
  getLastActuation: vi.fn(() => ({ status: 'never_run' })),
}));

import evRouter from '../../../api/routes/ev.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { computeEvDecision } from '../../../api/services/ev-decision-service.ts';

describe('GET /ev/status error handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('forwards an error to the error handler (500) when computeEvDecision throws', async () => {
    loadSettings.mockResolvedValue({});
    computeEvDecision.mockRejectedValueOnce(new Error('decision failed'));

    const res = await get(evRouter, '/status');

    // The route forwards the raw Error via next(err); the default handler wraps
    // it as a non-exposed 500 with a generic message.
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
  });

  it('forwards an error when loadSettings itself rejects', async () => {
    loadSettings.mockRejectedValueOnce(new Error('settings unavailable'));

    const res = await get(evRouter, '/status');

    expect(res.status).toBe(500);
  });
});
