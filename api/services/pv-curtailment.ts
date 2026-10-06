import type { Settings, PvCurtailmentConfig, PlanRowWithDess } from '../types.ts';
import type { SolverConfig } from '../../lib/types.ts';
import { decidePvCurtailment, type PvCurtailmentDecision } from '../../lib/pv-curtailment.ts';
import { getVictronSerial, readVictronSetting, writeVictronSetting } from './mqtt-service.ts';
import { resolveHaHttpConfig } from './ha-config.ts';
import {
  clearPvCurtailmentState,
  loadPvCurtailmentState,
  savePvCurtailmentState,
  type PvDisableTarget,
} from './pv-curtailment-state-store.ts';

interface ActivePlan {
  cfg: Pick<SolverConfig, 'stepSize_m' | 'maxGridImport_W'>;
  rows: PlanRowWithDess[];
}

export interface PvCurtailmentWriteRecord {
  ts: string;
  disabled: boolean;
  reason: string;
  dryRun: boolean;
  currentPv_W: number;
  currentGridHeadroom_W: number;
  remainingPv_Wh: number;
  remainingGridHeadroom_Wh: number;
}

export interface PvCurtailmentStatus {
  enabled: boolean;
  dryRun: boolean;
  ownsDisable: boolean;
  /** A live disable is recorded on disk and its restore has not been confirmed yet. */
  restorePending: boolean;
  /** At boot Pv/Disable read 1 although OptiVolt holds no record of disabling it. */
  externalDisable: boolean;
  lastTickAt: string | null;
  lastWriteAt: string | null;
  lastDecision: PvCurtailmentDecision | null;
  recentWrites: PvCurtailmentWriteRecord[];
}

const RECENT_WRITE_LIMIT = 50;
const GATE_BLOCK_LOG_INTERVAL_MS = 60_000;
/** Read-back of Pv/Disable that confirms a restore before the ownership record is dropped. */
const RESTORE_READBACK_TIMEOUT_MS = 3000;
/** Retry cadence for an unconfirmed restore while the curtailment loop itself is not running. */
export const RESTORE_RETRY_MS = 30_000;
/**
 * Bound on the PV restore when stopping. A publish while Venus is unreachable never
 * resolves, and process shutdown only has ~3 s before s6 escalates to SIGKILL; an
 * unconfirmed restore stays on disk and is retried at the next start.
 */
export const STOP_RESTORE_TIMEOUT_MS = 2000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let restoreRetryHandle: ReturnType<typeof setInterval> | null = null;
let serviceRunning = false;
let activeConfig: PvCurtailmentConfig | null = null;
let activeHaUrl = '';
let activeHaToken = '';
let activePlan: ActivePlan | null = null;
let tickInFlight = false;
let ownsDisable = false;
// Where the live disable we own (or whose restore is unconfirmed) was written. Taken from
// the persisted record at boot, so a restore never depends on the current settings.
let ownedTarget: PvDisableTarget | null = null;
let restorePending = false;
let restoreInFlight: Promise<boolean> | null = null;
// The owned target whose Pv/Disable=0 has been read back (only the switch may still be pending).
let victronRestoredFor: PvDisableTarget | null = null;
let externalDisable = false;
let lastTickAtMs: number | null = null;
let lastWriteAtMs: number | null = null;
let lastDecision: PvCurtailmentDecision | null = null;
let lastGateBlockSignature: string | null = null;
let lastGateBlockLogAtMs: number | null = null;
let serviceGeneration = 0;
const recentWrites: PvCurtailmentWriteRecord[] = [];

export function startPvCurtailment(settings: Settings): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  const cfg = settings.pvCurtailment;
  serviceGeneration += 1;
  serviceRunning = true;
  activeConfig = cfg ?? null;
  activeHaUrl = settings.haUrl ?? '';
  activeHaToken = settings.haToken ?? '';
  activePlan = null;
  lastDecision = null;
  lastGateBlockSignature = null;
  lastGateBlockLogAtMs = null;
  syncRestoreRetry();

  if (!cfg?.enabled) return;

  const tickMs = Math.max(1000, cfg.tickMs ?? 30_000);
  intervalHandle = setInterval(() => {
    tick().catch(err => console.error('[pv-curtailment] tick failed:', (err as Error).message));
  }, tickMs);

  /* v8 ignore next — initial tick runs with empty plan and cannot reject; catch is defensive */
  tick().catch(err => console.error('[pv-curtailment] initial tick failed:', (err as Error).message));
  console.log(`[pv-curtailment] started (tick=${tickMs}ms, dryRun=${cfg.dryRun})`);
}

/**
 * Boot-time reconciliation, run once after `startPvCurtailment`. A persisted ownership
 * record means an earlier process disabled PV and never confirmed the restore (killed,
 * crashed, power loss, or stopped while Venus was unreachable): restore it now with the
 * persisted serial/instance/switch — even when the feature is now off or in dry-run —
 * unless the live loop decides PV should stay curtailed. Without a record, a Pv/Disable
 * that reads 1 is not ours: warn and leave it alone (single owner). Never throws.
 */
export async function reconcilePvCurtailmentAtBoot(): Promise<void> {
  const state = await loadPvCurtailmentState();
  if (state) {
    console.warn(
      `[pv-curtailment] found a persisted Pv/Disable from ${new Date(state.sinceMs).toISOString()} `
      + `(acsystem ${state.acsystemInstance}); restoring PV unless curtailment is still wanted`,
    );
    ownedTarget = {
      serial: state.serial,
      acsystemInstance: state.acsystemInstance,
      enphaseSwitchEntity: state.enphaseSwitchEntity,
    };
    restorePending = true;
    if (activeConfig?.enabled) {
      // The live loop decides: still curtailing → re-assert the disable, else restore.
      // A failure is retried by its next tick.
      await tick().catch(err => console.error('[pv-curtailment] boot reconcile tick failed:', (err as Error).message));
    } else {
      await restoreOwnedPv(restoreRecord('restore-persisted'));
    }
    syncRestoreRetry();
    return;
  }

  const cfg = activeConfig;
  if (!cfg?.enabled || restorePending || ownsDisable) return;
  try {
    const serial = cfg.portalId || await getVictronSerial();
    const payload = await readVictronSetting(pvDisablePath(cfg.acsystemInstance), {
      serial,
      timeoutMs: RESTORE_READBACK_TIMEOUT_MS,
    }) as { value?: unknown } | null;
    if (Number(payload?.value) === 1 && !ownsDisable && !restorePending) {
      externalDisable = true;
      console.warn(
        `[pv-curtailment] acsystem/${cfg.acsystemInstance}/Pv/Disable is 1 but OptiVolt holds no record of `
        + 'disabling it; leaving it alone. Re-enable PV on the GX if this is unintended.',
      );
    }
  } catch (err) {
    console.warn('[pv-curtailment] could not read Pv/Disable at boot:', (err as Error).message);
  }
}

export async function stopPvCurtailment({ restoreTimeoutMs = STOP_RESTORE_TIMEOUT_MS }: { restoreTimeoutMs?: number } = {}): Promise<void> {
  serviceGeneration += 1;
  serviceRunning = false;

  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[pv-curtailment] stopped');
  }
  clearRestoreRetry();

  // Detach the config too, so a plan computed after this point (an in-flight
  // auto-calculate run) cannot tick again and re-disable PV after the restore.
  const cfg = activeConfig;
  activeConfig = null;
  activePlan = null;

  if (ownsDisable && cfg?.dryRun && !restorePending) {
    ownsDisable = false;
    const record = restoreRecord('stopped', true);
    pushWriteRecord(record);
    console.info('[pv-curtailment] dry-run Pv/Disable write', record);
    if (cfg.enphaseSwitchEntity) {
      console.info('[pv-curtailment] dry-run Enphase switch toggle', { entity: cfg.enphaseSwitchEntity, turnOn: true });
    }
  } else if (ownsDisable || restorePending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), restoreTimeoutMs);
    });
    try {
      const outcome = await Promise.race([restoreOwnedPv(restoreRecord('stopped')), timedOut]);
      if (outcome === 'timeout') {
        console.warn(`[pv-curtailment] PV restore did not finish within ${restoreTimeoutMs}ms on stop; it stays recorded and is retried at the next start`);
      } else if (!outcome) {
        console.warn('[pv-curtailment] PV restore on stop was not confirmed; it stays recorded and is retried at the next start');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  tickInFlight = false;
}

/** Reset in-memory ownership state (tests only; production state lives across stop/start). */
export function resetPvCurtailmentState(): void {
  clearRestoreRetry();
  ownsDisable = false;
  ownedTarget = null;
  restorePending = false;
  restoreInFlight = null;
  victronRestoredFor = null;
  externalDisable = false;
  tickInFlight = false;
}

export function updatePvCurtailmentPlan(plan: ActivePlan): void {
  activePlan = plan;
  if (activeConfig?.enabled) {
    tick().catch(err => console.error('[pv-curtailment] plan update tick failed:', (err as Error).message));
  }
}

export function getPvCurtailmentStatus(configFallback?: PvCurtailmentConfig): PvCurtailmentStatus {
  const cfg = activeConfig ?? configFallback;
  return {
    enabled: cfg?.enabled ?? false,
    dryRun: cfg?.dryRun ?? true,
    ownsDisable,
    restorePending,
    externalDisable,
    lastTickAt: isoOrNull(lastTickAtMs),
    lastWriteAt: isoOrNull(lastWriteAtMs),
    lastDecision,
    recentWrites: [...recentWrites],
  };
}

async function tick(): Promise<void> {
  const cfg = activeConfig;
  if (!cfg?.enabled || tickInFlight || restoreInFlight) return;
  const generation = serviceGeneration;

  tickInFlight = true;
  try {
    const nowMs = Date.now();
    lastTickAtMs = nowMs;

    const decision = activePlan
      ? decidePvCurtailment(activePlan.rows, activePlan.cfg, nowMs, cfg)
      : decidePvCurtailment([], { stepSize_m: 15, maxGridImport_W: 0 }, nowMs, cfg);
    lastDecision = decision;

    /* v8 ignore next — defensive guard against generation race; unreachable in single-threaded JS but kept for safety */
    if (generation !== serviceGeneration) return;

    if (decision.shouldDisable) {
      await applyPvDisabled(true, decision, generation);
      return;
    }

    logGateBlock(decision);
    if (ownsDisable || restorePending) {
      await applyPvDisabled(false, decision, generation);
    }
  } finally {
    tickInFlight = false;
  }
}

function pvDisablePath(acsystemInstance: number): string {
  return `acsystem/${acsystemInstance}/Pv/Disable`;
}

function restoreRecord(reason: string, dryRun = false): PvCurtailmentWriteRecord {
  const d = lastDecision;
  return {
    ts: new Date().toISOString(),
    disabled: false,
    reason: d?.reason ?? reason,
    dryRun,
    currentPv_W: d?.currentPv_W ?? 0,
    currentGridHeadroom_W: d?.currentGridHeadroom_W ?? 0,
    remainingPv_Wh: d?.remainingPv_Wh ?? 0,
    remainingGridHeadroom_Wh: d?.remainingGridHeadroom_Wh ?? 0,
  };
}

async function applyPvDisabled(disabled: boolean, decision: PvCurtailmentDecision, generation: number): Promise<void> {
  const cfg = activeConfig;
  /* v8 ignore next — caller paths only run while activeConfig is set */
  if (!cfg) return;

  if (disabled && ownsDisable) return;
  /* v8 ignore next — every caller already guards on ownsDisable/restorePending before invoking with disabled=false */
  if (!disabled && !ownsDisable && !restorePending) return;

  const record: PvCurtailmentWriteRecord = {
    ts: new Date().toISOString(),
    disabled,
    reason: decision.reason,
    dryRun: cfg.dryRun,
    currentPv_W: decision.currentPv_W,
    currentGridHeadroom_W: decision.currentGridHeadroom_W,
    remainingPv_Wh: decision.remainingPv_Wh,
    remainingGridHeadroom_Wh: decision.remainingGridHeadroom_Wh,
  };

  // A real disable left by a live run is always restored for real, even in dry-run
  // (which must never keep PV curtailed on the hardware).
  if (restorePending && !ownsDisable && (!disabled || cfg.dryRun)) {
    await restoreOwnedPv({ ...record, disabled: false, dryRun: false });
    if (!disabled) return;
  }

  if (cfg.dryRun) {
    ownsDisable = disabled;
    pushWriteRecord(record);
    console.info('[pv-curtailment] dry-run Pv/Disable write', record);
    if (cfg.enphaseSwitchEntity) {
      console.info('[pv-curtailment] dry-run Enphase switch toggle', {
        entity: cfg.enphaseSwitchEntity,
        turnOn: !disabled,
      });
    }
    return;
  }

  if (!disabled) {
    await restoreOwnedPv(record);
    return;
  }

  const serial = cfg.portalId || await getVictronSerial();
  const target: PvDisableTarget = {
    serial,
    acsystemInstance: cfg.acsystemInstance,
    enphaseSwitchEntity: cfg.enphaseSwitchEntity ?? '',
  };
  // Write-ahead: record ownership before acting, so a process that dies with PV
  // disabled is restored at the next boot. A failed save aborts the disable.
  await savePvCurtailmentState({ ownsDisable: true, sinceMs: Date.now(), ...target });
  ownedTarget = target;
  restorePending = true;
  // Stopped while saving: do not disable. The record makes the next start restore,
  // which is a harmless Pv/Disable=0.
  if (generation !== serviceGeneration) return;

  await writeVictronSetting(pvDisablePath(target.acsystemInstance), 1, { serial });
  ownsDisable = true;
  restorePending = false;
  externalDisable = false;
  lastWriteAtMs = Date.now();
  pushWriteRecord(record);
  console.info('[pv-curtailment] Pv/Disable write', record);

  if (target.enphaseSwitchEntity) {
    try {
      await callHaSwitch(target.enphaseSwitchEntity, false);
      console.info('[pv-curtailment] Enphase switch toggle', {
        entity: target.enphaseSwitchEntity,
        turnOn: false,
      });
    } catch (err) {
      console.warn('[pv-curtailment] Enphase switch toggle failed:', (err as Error).message);
    }
  }
}

/**
 * Restore the PV we own: Pv/Disable=0 and the Enphase switch back on, using the target
 * recorded when it was disabled. The ownership record is dropped only once the restore is
 * confirmed (read-back 0 and the switch call succeeded); otherwise it stays pending and is
 * retried. Concurrent callers share one attempt. Resolves true when confirmed; runRestore
 * catches every step's failure, so this never rejects.
 */
function restoreOwnedPv(record: PvCurtailmentWriteRecord): Promise<boolean> {
  if (!restoreInFlight) {
    restoreInFlight = runRestore(record)
      .finally(() => {
        restoreInFlight = null;
        syncRestoreRetry();
      });
  }
  return restoreInFlight;
}

async function runRestore(record: PvCurtailmentWriteRecord): Promise<boolean> {
  const target = ownedTarget;
  /* v8 ignore next 5 — every live disable records its target first; defensive */
  if (!target) {
    ownsDisable = false;
    restorePending = false;
    return true;
  }
  restorePending = true;

  // A retry that only waits on the Enphase switch does not rewrite Pv/Disable.
  const victronDone = victronRestoredFor === target;
  if (!victronDone) {
    try {
      await writeVictronSetting(pvDisablePath(target.acsystemInstance), 0, { serial: target.serial });
    } catch (err) {
      console.warn('[pv-curtailment] failed to restore PV (Pv/Disable=0):', (err as Error).message);
      return false;
    }
    ownsDisable = false;
    externalDisable = false;
    lastWriteAtMs = Date.now();
    pushWriteRecord(record);
    console.info('[pv-curtailment] Pv/Disable write', record);
  }

  let switchRestored = true;
  if (target.enphaseSwitchEntity) {
    try {
      await callHaSwitch(target.enphaseSwitchEntity, true);
      console.info('[pv-curtailment] Enphase switch toggle', {
        entity: target.enphaseSwitchEntity,
        turnOn: true,
      });
    } catch (err) {
      switchRestored = false;
      console.warn('[pv-curtailment] Enphase switch toggle failed:', (err as Error).message);
    }
  }

  if (!victronDone && await confirmPvEnabled(target)) victronRestoredFor = target;
  if (victronRestoredFor !== target || !switchRestored) return false;

  try {
    await clearPvCurtailmentState();
  } catch (err) {
    console.warn('[pv-curtailment] failed to clear the persisted PV-disable record:', (err as Error).message);
    return false;
  }
  /* v8 ignore next — no new disable can start while a restore is in flight (tick() waits) */
  if (ownedTarget === target) ownedTarget = null;
  restorePending = false;
  return true;
}

async function confirmPvEnabled(target: PvDisableTarget): Promise<boolean> {
  const path = pvDisablePath(target.acsystemInstance);
  try {
    const payload = await readVictronSetting(path, {
      serial: target.serial,
      timeoutMs: RESTORE_READBACK_TIMEOUT_MS,
    }) as { value?: unknown } | null;
    if (Number(payload?.value) === 0) return true;
    console.warn(`[pv-curtailment] ${path} still reads ${JSON.stringify(payload?.value)} after the restore; will retry`);
  } catch (err) {
    console.warn(`[pv-curtailment] could not confirm the PV restore (${path}):`, (err as Error).message);
  }
  return false;
}

/** Run the standalone restore retry only while it is needed and the live loop isn't covering it. */
function syncRestoreRetry(): void {
  const needed = serviceRunning && restorePending && !ownsDisable && !activeConfig?.enabled;
  if (!needed) {
    clearRestoreRetry();
    return;
  }
  if (restoreRetryHandle !== null) return;
  restoreRetryHandle = setInterval(() => {
    void restoreOwnedPv(restoreRecord('restore-retry'));
  }, RESTORE_RETRY_MS);
}

function clearRestoreRetry(): void {
  if (restoreRetryHandle !== null) {
    clearInterval(restoreRetryHandle);
    restoreRetryHandle = null;
  }
}

async function callHaSwitch(entityId: string, turnOn: boolean): Promise<void> {
  const haConfig = resolveHaHttpConfig(activeHaUrl, activeHaToken);
  if (!haConfig) {
    throw new Error('Home Assistant credentials not configured');
  }
  const { baseUrl, token } = haConfig;
  const service = turnOn ? 'turn_on' : 'turn_off';
  const url = `${baseUrl}/api/services/switch/${service}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entityId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HA service call returned ${res.status} for switch.${service} ${entityId}`);
  }
}

function logGateBlock(decision: PvCurtailmentDecision): void {
  const nowMs = Date.now();
  const signature = JSON.stringify({
    reason: decision.reason,
    currentIndex: decision.currentIndex,
    currentPv_W: Math.round(decision.currentPv_W),
    currentGridHeadroom_W: Math.round(decision.currentGridHeadroom_W),
  });
  const shouldLog =
    signature !== lastGateBlockSignature
    || lastGateBlockLogAtMs == null
    || nowMs - lastGateBlockLogAtMs >= GATE_BLOCK_LOG_INTERVAL_MS;

  if (!shouldLog) return;

  lastGateBlockSignature = signature;
  lastGateBlockLogAtMs = nowMs;
  console.debug('[pv-curtailment] gate blocked', {
    reason: decision.reason,
    currentIndex: decision.currentIndex,
    currentPv_W: decision.currentPv_W,
    currentGridHeadroom_W: decision.currentGridHeadroom_W,
    remainingPv_Wh: decision.remainingPv_Wh,
    remainingGridHeadroom_Wh: decision.remainingGridHeadroom_Wh,
  });
}

function pushWriteRecord(record: PvCurtailmentWriteRecord): void {
  recentWrites.push(record);
  if (recentWrites.length > RECENT_WRITE_LIMIT) {
    recentWrites.splice(0, recentWrites.length - RECENT_WRITE_LIMIT);
  }
}

function isoOrNull(ms: number | null): string | null {
  /* v8 ignore next — null branch only fires before any tick has run; not reachable once tests have called startPvCurtailment */
  return ms == null ? null : new Date(ms).toISOString();
}
