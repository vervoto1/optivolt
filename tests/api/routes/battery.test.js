import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from '../helpers/express-test-client.js';

vi.mock('../../../api/services/battery-charge-controller.ts', () => ({
  getBatteryChargeStatus: vi.fn(),
}));
vi.mock('../../../api/services/balance-tuner.ts', () => ({
  getBalanceTunerStatus: vi.fn(),
}));

import batteryRouter from '../../../api/routes/battery.ts';
import { getBatteryChargeStatus } from '../../../api/services/battery-charge-controller.ts';
import { getBalanceTunerStatus } from '../../../api/services/balance-tuner.ts';

describe('GET /battery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns combined charge and balance controller status', async () => {
    const charge = {
      status: 'never_run', enabled: false, intervalSeconds: null, lastWriteAt: null,
      maxCellVoltage: null, observedLevel: null, commandedLevel: null, targetLevel: null,
      wrote: false, dryRun: true, contentionCount: 0, error: null, timestampMs: 0,
      reason: 'controller has not run',
    };
    const balance = {
      enabled: true, dryRun: false, intervalSeconds: 300,
      lastTickAt: '2026-06-18T00:00:00.000Z', lastWriteAt: null, batteries: [],
    };
    getBatteryChargeStatus.mockReturnValue(charge);
    getBalanceTunerStatus.mockReturnValue(balance);

    const res = await get(batteryRouter, '/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ charge, balance });
    expect(getBatteryChargeStatus).toHaveBeenCalledTimes(1);
    expect(getBalanceTunerStatus).toHaveBeenCalledTimes(1);
  });

  it('maps a thrown error to 500', async () => {
    getBatteryChargeStatus.mockImplementation(() => {
      throw new Error('controller exploded');
    });

    const res = await get(batteryRouter, '/');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to read battery controller status');
  });
});
