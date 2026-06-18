import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from '../helpers/express-test-client.js';

// Mount only the EV router with mocked dependencies so we can drive the
// low-price override branch (line 36) and the evActiveInPlan nullish branches
// (line 27) and the lowPriceOn AND-branch (line 20) of /ev/schedule.
vi.mock('../../../api/services/planner-service.ts', () => ({
  getLastPlan: vi.fn(),
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
import { getLastPlan } from '../../../api/services/planner-service.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';

const START_MS = 1700000000000;

function row(overrides = {}) {
  return {
    timestampMs: START_MS,
    ev_charge: 1000,
    ev_charge_A: 4,
    ev_charge_mode: 'fixed',
    ev_plan_mode: 'planned',
    g2ev: 1000,
    pv2ev: 0,
    b2ev: 0,
    ev_soc_percent: 50,
    ic: 30,
    ...overrides,
  };
}

describe('GET /ev/schedule branch coverage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('annotates slots as low_price when low-price charging is enabled and price is at/below the level', async () => {
    getLastPlan.mockReturnValue({
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [
        row({ ic: 5 }),                                  // below level -> low_price
        row({ ic: 50, ev_charge: 0, ev_plan_mode: undefined }), // above level, no charge -> idle
      ],
      summary: { evChargeTotal_kWh: 1, evChargeFromGrid_kWh: 1, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
    });
    loadSettings.mockResolvedValue({
      evLowPriceChargingEnabled: true,
      evLowPriceChargingLevel_cents_per_kWh: 10,
    });

    const res = await get(evRouter, '/schedule');

    expect(res.status).toBe(200);
    expect(res.body.slots[0].override_mode).toBe('low_price'); // ic 5 <= 10 -> low_price
    expect(res.body.slots[1].override_mode).toBe('idle');      // ic 50 > 10, no charge -> idle
  });

  it('uses planned/idle override modes when low-price charging is disabled', async () => {
    getLastPlan.mockReturnValue({
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [
        row({ ev_charge: 1000, ev_plan_mode: 'planned' }), // charging -> planned
        row({ ev_charge: 0 }),                              // not charging -> idle
        row({ ev_charge: 500, ev_plan_mode: undefined }),  // charging, no plan mode -> 'planned' default
      ],
      summary: { evChargeTotal_kWh: 1, evChargeFromGrid_kWh: 1, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
    });
    loadSettings.mockResolvedValue({ evLowPriceChargingEnabled: false });

    const res = await get(evRouter, '/schedule');

    expect(res.status).toBe(200);
    expect(res.body.slots[0].override_mode).toBe('planned');
    expect(res.body.slots[1].override_mode).toBe('idle');
    expect(res.body.slots[2].override_mode).toBe('planned');
  });

  it('treats low-price as off when the configured level is not finite', async () => {
    getLastPlan.mockReturnValue({
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [row({ ic: 1, ev_charge: 1000 })],
      summary: { evChargeTotal_kWh: 1, evChargeFromGrid_kWh: 1, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
    });
    loadSettings.mockResolvedValue({
      evLowPriceChargingEnabled: true,
      evLowPriceChargingLevel_cents_per_kWh: undefined, // not finite -> lowPriceOn false
    });

    const res = await get(evRouter, '/schedule');

    expect(res.status).toBe(200);
    // Despite a very low price, low-price is off because the level is not finite.
    expect(res.body.slots[0].override_mode).toBe('planned');
  });

  it('falls back to the EV preview when plan rows have null ev fields (nullish coalescing)', async () => {
    // Both ev_charge and ev_soc_percent are null -> evActiveInPlan is false ->
    // the route would consult the preview, which we leave null, so it uses the plan.
    getLastPlan.mockReturnValue({
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [
        { timestampMs: START_MS, ev_charge: null, ev_soc_percent: null, ev_charge_A: 0, ev_charge_mode: 'off', ev_plan_mode: undefined, g2ev: 0, pv2ev: 0, b2ev: 0, ic: 20 },
      ],
      summary: { evChargeTotal_kWh: 0, evChargeFromGrid_kWh: 0, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
    });
    loadSettings.mockResolvedValue({ evLowPriceChargingEnabled: false });

    const res = await get(evRouter, '/schedule');

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(false);
    // ev_charge null -> override_mode 'idle' (row.ev_charge > 0 is false)
    expect(res.body.slots[0].override_mode).toBe('idle');
  });
});
