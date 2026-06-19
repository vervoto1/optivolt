// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
}));

import { computeEvDecision } from '../../../api/services/ev-decision-service.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';

const NOW = 1_700_000_000_000;
const STEP_MS = 15 * 60_000;

function makePlan({ evCharge = 0, ic = 20, planMode = 'planned', targetMet = false } = {}) {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    timestampMs: NOW + i * STEP_MS,
    ic,
    ev_charge: i === 0 ? evCharge : 0,
    ev_charge_A: i === 0 ? 16 : 0,
    ev_plan_mode: planMode,
    ev_soc_percent: 50,
    ...(i === 7 ? { ev_target_met: targetMet } : {}),
  }));
  return { rows, timing: { startMs: NOW, stepMin: 15 } };
}

function makeSettings(overrides = {}) {
  return {
    evEnabled: true,
    evMinChargeCurrent_A: 6,
    evMaxChargeCurrent_A: 16,
    evChargePhases: 3,
    evTargetSoc_percent: 80,
    evDepartureTime: new Date(NOW + 8 * STEP_MS).toISOString(),
    evSocSensor: 'sensor.soc',
    evPlugSensor: 'sensor.plug',
    haUrl: 'ws://h:8123/api/websocket',
    haToken: 'tok',
    ...overrides,
  };
}

function mockHa({ soc = '50', plug = 'on' } = {}) {
  fetchHaEntityState.mockImplementation(async ({ entityId }) => {
    if (entityId === 'sensor.soc') return { state: String(soc) };
    if (entityId === 'sensor.plug') return { state: String(plug) };
    throw new Error(`unknown entity ${entityId}`);
  });
}

describe('computeEvDecision — priority + gating', () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.SUPERVISOR_TOKEN; });

  it('low_soc has priority over low_price', async () => {
    mockHa({ soc: '20', plug: 'on' });
    const settings = makeSettings({
      evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30,
      evLowPriceChargingEnabled: true, evLowPriceChargingLevel_cents_per_kWh: 100,
    });
    const d = await computeEvDecision(settings, makePlan({ ic: 5 }), NOW);
    expect(d.mode).toBe('low_soc');
    expect(d.is_charging).toBe(true);
    expect(d.ev_charge_A).toBe(16);
  });

  it('low_price fires when SoC is above the low-SoC level', async () => {
    mockHa({ soc: '70', plug: 'on' });
    const settings = makeSettings({
      evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30,
      evLowPriceChargingEnabled: true, evLowPriceChargingLevel_cents_per_kWh: 6,
    });
    const d = await computeEvDecision(settings, makePlan({ ic: 5 }), NOW);
    expect(d.mode).toBe('low_price');
  });

  it('min_soc floor fires below the minimum when no low-price/low-soc match', async () => {
    mockHa({ soc: '35', plug: 'on' });
    const settings = makeSettings({ evMinSoc_percent: 40 });
    const d = await computeEvDecision(settings, makePlan(), NOW);
    expect(d.mode).toBe('min_soc');
  });

  it('falls back to the planned decision when no override matches', async () => {
    mockHa({ soc: '70', plug: 'on' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 5000 }), NOW);
    expect(d.mode).toBe('planned');
    expect(d.ev_charge_W).toBe(5000);
  });

  it('reports idle when the car is definitely not connected', async () => {
    mockHa({ soc: '20', plug: 'off' });
    const settings = makeSettings({ evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30 });
    const d = await computeEvDecision(settings, makePlan(), NOW);
    expect(d.mode).toBe('idle');
    expect(d.is_charging).toBe(false);
  });

  it('tolerates HA failures: low-SoC cannot fire without a live SoC reading', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('HA down'));
    const settings = makeSettings({ evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30 });
    const d = await computeEvDecision(settings, makePlan({ evCharge: 5000 }), NOW);
    expect(d.mode).toBe('planned'); // not low_soc — no live SoC to trigger it
    expect(d.plugConnected).toBe(null);
  });

  it('does not apply overrides when EV charging is disabled (not native)', async () => {
    mockHa({ soc: '20', plug: 'on' });
    const settings = makeSettings({
      evEnabled: false,
      evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30,
    });
    const d = await computeEvDecision(settings, makePlan({ evCharge: 0 }), NOW);
    expect(d.mode).toBe('idle'); // override suppressed; plan idle this slot
  });

  it('keep_on holds the charger on between cheap slots, at min current', async () => {
    mockHa({ soc: '70', plug: 'on' }); // below 80% target
    const settings = makeSettings({ evKeepOn: true });
    // Charging started at slot 0; now at slot 2 where the plan is idle.
    const d = await computeEvDecision(settings, makePlan({ evCharge: 5000 }), NOW + 2 * STEP_MS);
    expect(d.mode).toBe('keep_on');
    expect(d.ev_charge_A).toBe(6); // evMinChargeCurrent_A
  });

  it('keep_on does NOT fire once the target is met', async () => {
    mockHa({ soc: '85', plug: 'on' });
    const settings = makeSettings({ evKeepOn: true });
    const d = await computeEvDecision(settings, makePlan({ evCharge: 5000, targetMet: true }), NOW + 2 * STEP_MS);
    expect(d.mode).toBe('idle');
  });

  it('maps a planned opportunistic slot to mode opportunistic', async () => {
    mockHa({ soc: '85', plug: 'on' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 5000, planMode: 'opportunistic' }), NOW);
    expect(d.mode).toBe('opportunistic');
  });

  it('treats an unavailable plug as uncertain (not idle)', async () => {
    mockHa({ soc: '50', plug: 'unavailable' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 5000 }), NOW);
    expect(d.plugConnected).toBe(null);
    expect(d.mode).toBe('planned'); // not forced idle by an uncertain plug
  });

  it('stops a planned charge mid-slot once live SoC reaches the target', async () => {
    // Plan slot still says charge, but the car already hit 80% — switch off rather
    // than run out the 15-min slot (which a forced-rate charger would overshoot).
    mockHa({ soc: '80', plug: 'on' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 11040, planMode: 'planned' }), NOW);
    expect(d.mode).toBe('idle');
    expect(d.is_charging).toBe(false);
    expect(d.reason).toMatch(/target/i);
  });

  it('keeps charging above target on a genuinely opportunistic slot', async () => {
    // Above the target, but the LP scheduled this slot as opportunistic (cheap
    // energy) — the target-reached guard must not block it.
    mockHa({ soc: '82', plug: 'on' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 11040, planMode: 'opportunistic' }), NOW);
    expect(d.mode).toBe('opportunistic');
    expect(d.is_charging).toBe(true);
  });

  it('charges a planned slot normally while live SoC is below target', async () => {
    mockHa({ soc: '70', plug: 'on' });
    const d = await computeEvDecision(makeSettings(), makePlan({ evCharge: 11040, planMode: 'planned' }), NOW);
    expect(d.mode).toBe('planned');
    expect(d.is_charging).toBe(true);
  });
});

describe('computeEvDecision — manual override', () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.SUPERVISOR_TOKEN; });

  it('force-charge overrides an idle plan, even above target', async () => {
    mockHa({ soc: '90', plug: 'on' }); // above the 80% target, plan idle
    const d = await computeEvDecision(makeSettings({ evOverrideMode: 'charge' }), makePlan({ evCharge: 0 }), NOW);
    expect(d.mode).toBe('manual_charge');
    expect(d.is_charging).toBe(true);
    expect(d.ev_charge_A).toBe(16);
  });

  it('force-stop overrides low_soc (the strongest reactive override)', async () => {
    mockHa({ soc: '10', plug: 'on' });
    const settings = makeSettings({
      evOverrideMode: 'stop',
      evLowSocChargingEnabled: true, evLowSocChargingLevel_percent: 30,
    });
    const d = await computeEvDecision(settings, makePlan({ evCharge: 11040 }), NOW);
    expect(d.mode).toBe('manual_stop');
    expect(d.is_charging).toBe(false);
    expect(d.ev_charge_W).toBe(0);
  });

  it('force-charge on a disconnected car stays idle (cannot charge)', async () => {
    mockHa({ soc: '50', plug: 'off' });
    const d = await computeEvDecision(makeSettings({ evOverrideMode: 'charge' }), makePlan({ evCharge: 0 }), NOW);
    expect(d.mode).toBe('idle');
    expect(d.is_charging).toBe(false);
  });

  it("'auto' follows the plan (no override applied)", async () => {
    mockHa({ soc: '70', plug: 'on' });
    const d = await computeEvDecision(makeSettings({ evOverrideMode: 'auto' }), makePlan({ evCharge: 11040, planMode: 'planned' }), NOW);
    expect(d.mode).toBe('planned');
    expect(d.is_charging).toBe(true);
  });
});
