// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: vi.fn() }));
vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
  callHaService: vi.fn(),
}));
vi.mock('../../../api/services/ev-decision-service.ts', () => ({ computeEvDecision: vi.fn() }));
vi.mock('../../../api/services/planner-service.ts', () => ({
  getLastPlan: vi.fn(),
  planAndMaybeWrite: vi.fn().mockResolvedValue(undefined),
}));

import { runActuatorTick, resetEvActuatorState, getLastActuation } from '../../../api/services/ev-actuator-service.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { fetchHaEntityState, callHaService } from '../../../api/services/ha-client.ts';
import { computeEvDecision } from '../../../api/services/ev-decision-service.ts';
import { getLastPlan, planAndMaybeWrite } from '../../../api/services/planner-service.ts';

const NOW = 1_700_000_000_000;

function settings(over = {}) {
  return {
    evEnabled: true, evSource: 'native', evActuationEnabled: true, evActuationPaused: false,
    evChargerSwitchEntity: 'switch.charger', evChargerCurrentEntity: '',
    evMinChargeCurrent_A: 6, evMaxChargeCurrent_A: 16, evChargePhases: 3,
    evMaxPlanAgeSeconds: 1800, evFailSafeMode: 'hold',
    haUrl: 'ws://h:8123/api/websocket', haToken: 'tok',
    autoCalculate: { writeToVictron: false },
    ...over,
  };
}
function plan(over = {}) {
  return { rows: [{ timestampMs: NOW, ev_charge: 0 }], timing: { startMs: NOW, stepMin: 15 }, computedAtMs: NOW, ...over };
}
function decision(over = {}) {
  return { mode: 'planned', is_charging: false, ev_charge_W: 0, ev_charge_A: 0, plugConnected: true, reason: 'x', ...over };
}
function observe(state) { fetchHaEntityState.mockResolvedValue({ state }); }

beforeEach(() => {
  vi.clearAllMocks();
  resetEvActuatorState();
  loadSettings.mockResolvedValue(settings());
  getLastPlan.mockReturnValue(plan());
  computeEvDecision.mockResolvedValue(decision());
  observe('off');
});

describe('ev-actuator — gating + fail-safe (no charger write on uncertainty)', () => {
  it('disabled → no write', async () => {
    loadSettings.mockResolvedValue(settings({ evActuationEnabled: false }));
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('disabled');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('paused → no write', async () => {
    loadSettings.mockResolvedValue(settings({ evActuationPaused: true }));
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('paused');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('no plan source → no write, status no_plan_source', async () => {
    getLastPlan.mockReturnValue(undefined);
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('no_plan_source');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('stale plan → no write', async () => {
    getLastPlan.mockReturnValue(plan({ computedAtMs: NOW - 3600_000 }));
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('stale_plan');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('uncertain plug status → no write', async () => {
    computeEvDecision.mockResolvedValue(decision({ plugConnected: null, is_charging: true, ev_charge_A: 16 }));
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('plug_uncertain');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('charger-read failure holds (no write) in default fail-safe mode', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('HA down'));
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('error');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it("evFailSafeMode 'stop' does NOT turn off a never-seeded charger (boot HA down)", async () => {
    // HA down since boot → the charger's real state was never observed. 'stop'
    // must hold (no write-on-uncertainty / boot blip), not turn off.
    loadSettings.mockResolvedValue(settings({ evFailSafeMode: 'stop' }));
    fetchHaEntityState.mockRejectedValue(new Error('HA down'));
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    await runActuatorTick(NOW);
    await runActuatorTick(NOW);
    await runActuatorTick(NOW);
    await runActuatorTick(NOW);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it("evFailSafeMode 'stop' issues a single turn_off after sustained error on a seeded-on charger", async () => {
    loadSettings.mockResolvedValue(settings({ evFailSafeMode: 'stop' }));
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    observe('on');
    await runActuatorTick(NOW); // seed lastCommand = { on: true }
    // Now HA reads start failing.
    fetchHaEntityState.mockRejectedValue(new Error('HA down'));
    await runActuatorTick(NOW); // err 1
    await runActuatorTick(NOW); // err 2
    await runActuatorTick(NOW); // err 3 → fail-safe stop
    const offCalls = callHaService.mock.calls.filter(c => c[0].service === 'turn_off');
    expect(offCalls.length).toBe(1);
  });
});

describe('ev-actuator — clean startup + idempotency + contention', () => {
  it('tick 1 seeds from observed and writes nothing (no blip)', async () => {
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    observe('off');
    const r = await runActuatorTick(NOW);
    expect(r.status).toBe('seeded');
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('tick 2 applies a plan change (turn_on)', async () => {
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    observe('off');
    await runActuatorTick(NOW);      // seed off
    const r = await runActuatorTick(NOW + 1000); // desired on ≠ commanded off → write
    expect(r.wrote).toBe(true);
    expect(callHaService).toHaveBeenCalledWith(expect.objectContaining({ service: 'turn_on' }));
  });

  it('does not re-write when the desired state is unchanged (idempotent)', async () => {
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    observe('on');
    await runActuatorTick(NOW);          // seed on
    const r = await runActuatorTick(NOW + 1000); // desired on == commanded on → no write
    expect(r.wrote).toBe(false);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it('flags contention when observed diverges from commanded for N ticks', async () => {
    computeEvDecision.mockResolvedValue(decision({ is_charging: false }));
    observe('off');
    await runActuatorTick(NOW); // seed off
    observe('on'); // something else switched it on
    await runActuatorTick(NOW + 1000);
    await runActuatorTick(NOW + 2000);
    const r = await runActuatorTick(NOW + 3000);
    expect(r.status).toBe('contention');
    expect(getLastActuation().contentionCount).toBeGreaterThanOrEqual(3);
  });
});

describe('ev-actuator — charge-current write + partial-write recovery', () => {
  it('writes clamped charge current via number.set_value, idempotently', async () => {
    loadSettings.mockResolvedValue(settings({ evChargerCurrentEntity: 'number.amps' }));
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 99 }));
    observe('off');
    await runActuatorTick(NOW);          // seed off
    await runActuatorTick(NOW + 1000);   // turn_on + set_value(16, clamped from 99)
    const setCalls = callHaService.mock.calls.filter(c => c[0].service === 'set_value');
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0].data.value).toBe(16); // clamped to evMaxChargeCurrent_A
    // Unchanged amps next tick → no second set_value.
    callHaService.mockClear();
    observe('on');
    await runActuatorTick(NOW + 2000);
    expect(callHaService.mock.calls.filter(c => c[0].service === 'set_value').length).toBe(0);
  });

  it('reconciles (re-plan + re-write) once on low_soc onset, not on low_price', async () => {
    loadSettings.mockResolvedValue(settings({ autoCalculate: { writeToVictron: true } }));
    getLastPlan.mockReturnValue(plan({ rows: [{ timestampMs: NOW, ev_charge: 0 }] }));
    observe('off');
    // low_price override must NOT reconcile (the LP can't act on it).
    computeEvDecision.mockResolvedValue(decision({ mode: 'low_price', is_charging: true, ev_charge_A: 16 }));
    await runActuatorTick(NOW);        // seed
    await runActuatorTick(NOW + 1000); // low_price → no reconcile
    expect(planAndMaybeWrite).not.toHaveBeenCalled();
    // low_soc override reconciles once on the transition, then is debounced.
    computeEvDecision.mockResolvedValue(decision({ mode: 'low_soc', is_charging: true, ev_charge_A: 16 }));
    observe('on');
    await runActuatorTick(NOW + 2000); // low_soc onset → reconcile
    await runActuatorTick(NOW + 3000); // sustained low_soc → no second reconcile
    expect(planAndMaybeWrite).toHaveBeenCalledTimes(1);
  });

  it('commits the on/off leg even if the set_value leg throws (no re-fire / no false contention)', async () => {
    loadSettings.mockResolvedValue(settings({ evChargerCurrentEntity: 'number.amps' }));
    computeEvDecision.mockResolvedValue(decision({ is_charging: true, ev_charge_A: 16 }));
    // set_value (number domain) fails; switch (turn_on) succeeds.
    callHaService.mockImplementation(async ({ domain }) => {
      if (domain === 'number') throw new Error('set_value failed');
    });
    observe('off');
    await runActuatorTick(NOW);          // seed off
    const r1 = await runActuatorTick(NOW + 1000); // turn_on ok, set_value throws
    expect(r1.status).toBe('error');
    const turnOnCount1 = callHaService.mock.calls.filter(c => c[0].service === 'turn_on').length;
    expect(turnOnCount1).toBe(1);
    // Recovery tick: charger really on, set_value now succeeds. turn_on must NOT
    // re-fire (on leg was committed) and contention must NOT trip.
    callHaService.mockResolvedValue(undefined);
    observe('on');
    const r2 = await runActuatorTick(NOW + 2000);
    expect(callHaService.mock.calls.filter(c => c[0].service === 'turn_on').length).toBe(1);
    expect(r2.status).not.toBe('contention');
  });
});
