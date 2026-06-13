import type { Settings } from '../types.ts';
import { loadSettings } from './settings-store.ts';
import { fetchHaEntityState, callHaService } from './ha-client.ts';
import { computeEvDecision, type EvDecision, type EvDecisionMode } from './ev-decision-service.ts';
import { getLastPlan, planAndMaybeWrite, type ComputePlanResult } from './planner-service.ts';
import { resolveEvMode } from './ev-mode.ts';

/**
 * EV charger actuator — a lightweight control loop that drives the physical
 * charger via HA service calls so OptiVolt can own EV charging end-to-end (and
 * the EV Smart Charging integration can be retired).
 *
 * Safety properties (see the EV native-charging plan):
 *  - idempotent: only writes when the desired state differs from the last command
 *  - fail-safe: NO charger write on any uncertainty (HA error, no/stale plan,
 *    uncertain plug). The charger holds its last physical state.
 *  - clean startup: tick 1 seeds lastCommand from the observed state and writes
 *    nothing (no blip); tick 2+ apply normal idempotent writes.
 *  - single owner: contention is detected (observed diverges from commanded) and
 *    surfaced; idempotency stops OptiVolt from spamming.
 */

export type ActuationStatus =
  | 'ok'
  | 'seeded'
  | 'disabled'
  | 'paused'
  | 'no_plan_source'
  | 'stale_plan'
  | 'plug_uncertain'
  | 'contention'
  | 'error'
  | 'never_run';

export interface ActuationRecord {
  status: ActuationStatus;
  mode: EvDecisionMode | null;
  desired: { on: boolean; amps: number | null } | null;
  commanded: { on: boolean; amps: number | null } | null;
  observed: { on: boolean } | null;
  wrote: boolean;
  reason: string;
  error: string | null;
  contentionCount: number;
  timestampMs: number;
}

const CONTENTION_THRESHOLD = 3;
const ERROR_STOP_THRESHOLD = 3;
const REPLAN_MIN_INTERVAL_MS = 5 * 60_000;

// In-memory single-owner state. lastCommand === null means "not yet boot-seeded".
let lastCommand: { on: boolean; amps: number | null } | null = null;
let contentionCount = 0;
let errorCount = 0;
let lastReplanAtMs = 0;
let lastDecisionMode: EvDecisionMode | null = null;
let lastActuation: ActuationRecord = {
  status: 'never_run', mode: null, desired: null, commanded: null, observed: null,
  wrote: false, reason: 'actuator has not run', error: null, contentionCount: 0, timestampMs: 0,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function getLastActuation(): ActuationRecord {
  return lastActuation;
}

/** Reset all in-memory actuator state (for tests and clean restarts). */
export function resetEvActuatorState(): void {
  lastCommand = null;
  contentionCount = 0;
  errorCount = 0;
  lastReplanAtMs = 0;
  lastDecisionMode = null;
  lastActuation = {
    status: 'never_run', mode: null, desired: null, commanded: null, observed: null,
    wrote: false, reason: 'actuator has not run', error: null, contentionCount: 0, timestampMs: 0,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function record(rec: Partial<ActuationRecord> & { status: ActuationStatus; reason: string; timestampMs: number }): ActuationRecord {
  lastActuation = {
    mode: null, desired: null, commanded: lastCommand, observed: null, wrote: false,
    error: null, contentionCount, ...rec,
  };
  return lastActuation;
}

function interpretSwitch(state: string | undefined): boolean {
  const s = (state ?? '').trim().toLowerCase();
  return s === 'on' || s === 'true' || s === 'charging' || s === 'home';
}

function clampAmps(settings: Settings, amps: number): number {
  const lo = settings.evMinChargeCurrent_A;
  const hi = settings.evMaxChargeCurrent_A;
  return Math.max(lo, Math.min(hi, Math.round(amps)));
}

function currentRowOf(plan: ComputePlanResult, nowMs: number) {
  const rows = plan.rows;
  if (rows.length === 0) return null;
  let row = rows[0];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].timestampMs <= nowMs) { row = rows[i]; break; }
  }
  return row;
}

// Override modes that re-planning can actually reconcile: low_soc and min_soc
// drop the live EV SoC, which config-builder feeds into the next solve, so the
// re-plan genuinely re-syncs the Victron schedule with the new charge need.
// low_price and keep_on are NOT here: the LP has no knowledge of those live
// triggers, so re-planning would yield an identical schedule — a wasted solve.
const RECONCILE_MODES: EvDecisionMode[] = ['low_soc', 'min_soc'];

/**
 * 0c — override↔DESS reconciliation. A low-SoC/min-SoC override that charges
 * off-plan makes the Victron DESS schedule (built from the PLANNED ev_charge)
 * inconsistent. Trigger a fast re-plan + re-write so the battery/grid plan stays
 * consistent. Edge-triggered (once per episode), debounced, and only when DESS
 * writes are actually enabled.
 */
function maybeReconcile(settings: Settings, decision: EvDecision, plan: ComputePlanResult, nowMs: number): void {
  const prevMode = lastDecisionMode;
  lastDecisionMode = decision.mode;
  // Reconcile only on the TRANSITION into a reconcilable override, not every tick
  // of a sustained one (which would re-fire the re-plan forever).
  const isReconcile = RECONCILE_MODES.includes(decision.mode);
  const wasReconcile = prevMode != null && RECONCILE_MODES.includes(prevMode);
  if (!isReconcile || wasReconcile) return;
  if (!settings.autoCalculate?.writeToVictron) return;
  const row = currentRowOf(plan, nowMs);
  if ((row?.ev_charge ?? 0) > 1) return; // plan already charges this slot → consistent
  if (nowMs - lastReplanAtMs < REPLAN_MIN_INTERVAL_MS) return; // debounce backstop
  lastReplanAtMs = nowMs;
  console.log(`[ev-actuator] override ${decision.mode} onset deviates from plan → re-plan + re-write Victron`);
  // No forceWrite: let writePlanToVictron's fingerprint dedup decide whether the
  // DESS schedule actually changed, so we never spam Victron with unchanged writes.
  planAndMaybeWrite({ writeToVictron: true })
    .catch(err => console.warn('[ev-actuator] reconcile re-plan failed:', msg(err)));
}

async function failSafe(settings: Settings, reason: string, err: unknown, nowMs: number): Promise<ActuationRecord> {
  errorCount++;
  // Default 'hold' = no write (charger holds its last physical state). 'stop' is
  // an opt-in stricter mode: a single turn_off on sustained error — but ONLY for
  // a charger we have actually seeded/commanded ON. If lastCommand is null (never
  // seeded, e.g. HA down since boot), the charger's real state was never observed,
  // so issuing turn_off would be a write-on-uncertainty + boot blip — exactly the
  // safety property we promise never to violate. Hold instead.
  if (settings.evFailSafeMode === 'stop'
      && errorCount >= ERROR_STOP_THRESHOLD
      && settings.evChargerSwitchEntity
      && lastCommand != null
      && lastCommand.on === true) {
    try {
      await callHaService({
        haUrl: settings.haUrl, haToken: settings.haToken,
        domain: 'switch', service: 'turn_off',
        target: { entity_id: settings.evChargerSwitchEntity },
      });
      lastCommand = { on: false, amps: null };
      return record({ status: 'error', reason: `${reason} → fail-safe stop`, error: msg(err), wrote: true, timestampMs: nowMs });
    } catch { /* swallow — never throw out of the tick */ }
  }
  return record({ status: 'error', reason, error: msg(err), wrote: false, timestampMs: nowMs });
}

/** Run one actuator control tick. Never throws. */
export async function runActuatorTick(nowMs: number = Date.now()): Promise<ActuationRecord> {
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch (err) {
    return record({ status: 'error', reason: 'settings load failed', error: msg(err), timestampMs: nowMs });
  }

  // Actuation is a native-mode feature (haSchedule means an external owner).
  if (resolveEvMode(settings) !== 'native' || !settings.evActuationEnabled) {
    return record({ status: 'disabled', reason: 'actuation disabled', timestampMs: nowMs });
  }
  if (settings.evActuationPaused) {
    return record({ status: 'paused', reason: 'actuation paused by user', timestampMs: nowMs });
  }
  if (!settings.evChargerSwitchEntity) {
    return record({ status: 'disabled', reason: 'no charger switch entity configured', timestampMs: nowMs });
  }

  const plan = getLastPlan();
  if (!plan) {
    return record({ status: 'no_plan_source', reason: 'no plan computed yet — enable auto-calculate or run /calculate', timestampMs: nowMs });
  }
  const maxAgeMs = (settings.evMaxPlanAgeSeconds ?? 1800) * 1000;
  if (plan.computedAtMs != null && (nowMs - plan.computedAtMs) > maxAgeMs) {
    return record({ status: 'stale_plan', reason: `plan older than ${settings.evMaxPlanAgeSeconds}s → no write`, timestampMs: nowMs });
  }

  let decision: EvDecision;
  try {
    decision = await computeEvDecision(settings, plan, nowMs);
  } catch (err) {
    return failSafe(settings, 'decision compute failed', err, nowMs);
  }

  // Uncertain plug status (unavailable/unknown) → no write (fail-safe). A fresh,
  // definite not-connected is handled by computeEvDecision (idle).
  if (decision.plugConnected === null) {
    return record({ status: 'plug_uncertain', mode: decision.mode, reason: 'plug status unavailable → no write', timestampMs: nowMs });
  }

  // Read the charger's observed state.
  let observedOn: boolean;
  try {
    const s = await fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evChargerSwitchEntity });
    observedOn = interpretSwitch(s.state);
  } catch (err) {
    return failSafe(settings, 'charger state read failed', err, nowMs);
  }
  errorCount = 0; // a healthy read clears the sustained-error counter

  const desired = {
    on: decision.is_charging,
    amps: decision.is_charging ? clampAmps(settings, decision.ev_charge_A) : null,
  };

  // Clean startup: seed lastCommand from the observed state, write nothing.
  if (lastCommand === null) {
    lastCommand = { on: observedOn, amps: null };
    return record({
      status: 'seeded', mode: decision.mode, observed: { on: observedOn },
      desired, commanded: lastCommand, wrote: false,
      reason: 'boot seed — no write on first tick', timestampMs: nowMs,
    });
  }

  // Single-owner contention: observed diverges from what we last commanded.
  if (observedOn !== lastCommand.on) {
    contentionCount++;
    if (contentionCount >= CONTENTION_THRESHOLD) {
      console.warn(`[ev-actuator] contention: charger observed ${observedOn ? 'on' : 'off'} but last command was ${lastCommand.on ? 'on' : 'off'} for ${contentionCount} ticks (another controller?)`);
    }
  } else {
    contentionCount = 0;
  }

  // Idempotent write: only when the desired state differs from the last command.
  // Commit lastCommand PER LEG: if the on/off write succeeds but the amps write
  // then throws, we must still record the on/off we actually issued — otherwise
  // lastCommand stays inverted from physical reality, re-firing turn_on and
  // false-flagging contention forever.
  let wrote = false;
  try {
    if (desired.on !== lastCommand.on) {
      await callHaService({
        haUrl: settings.haUrl, haToken: settings.haToken,
        domain: 'switch', service: desired.on ? 'turn_on' : 'turn_off',
        target: { entity_id: settings.evChargerSwitchEntity },
      });
      // Turning off clears the commanded current; turning on keeps prior amps
      // until set_value commits below.
      lastCommand = { on: desired.on, amps: desired.on ? lastCommand.amps : null };
      wrote = true;
    }
    if (settings.evChargerCurrentEntity && desired.on && desired.amps != null && desired.amps !== lastCommand.amps) {
      await callHaService({
        haUrl: settings.haUrl, haToken: settings.haToken,
        domain: 'number', service: 'set_value',
        target: { entity_id: settings.evChargerCurrentEntity },
        data: { value: desired.amps },
      });
      lastCommand = { on: lastCommand.on, amps: desired.amps };
      wrote = true;
    }
  } catch (err) {
    return failSafe(settings, 'charger write failed', err, nowMs);
  }

  maybeReconcile(settings, decision, plan, nowMs);

  return record({
    status: contentionCount >= CONTENTION_THRESHOLD ? 'contention' : 'ok',
    mode: decision.mode, observed: { on: observedOn }, commanded: lastCommand,
    desired, wrote, reason: decision.reason, timestampMs: nowMs,
  });
}

async function tickGuarded(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runActuatorTick();
  } catch (err) {
    // runActuatorTick never throws, but guard the timer callback regardless.
    console.error('[ev-actuator] tick error:', msg(err));
  } finally {
    ticking = false;
  }
}

/** Start the actuator control loop. Stops any previous loop first. */
export function startEvActuator(settings: Settings): void {
  const wasRunning = intervalHandle !== null;
  stopEvActuator();
  if (!settings.evActuationEnabled) return;
  // Reset ownership state only on a genuine (re)enable — NOT on every settings
  // save. Resetting wipes lastCommand → the next tick re-seeds and skips a write,
  // and a reset racing a mid-flight tick (the ticking guard does not cover reset)
  // can mis-seed. If the loop was already running (an unrelated save), keep state
  // and continue idempotently.
  if (!wasRunning) resetEvActuatorState();
  const sec = Math.max(5, settings.evControlIntervalSeconds ?? 60);
  console.log(`[ev-actuator] started (every ${sec}s)`);
  intervalHandle = setInterval(() => { void tickGuarded(); }, sec * 1000);
}

export function stopEvActuator(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ev-actuator] stopped');
  }
}

export function isEvActuatorRunning(): boolean {
  return intervalHandle !== null;
}
