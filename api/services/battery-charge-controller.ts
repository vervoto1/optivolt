import type { Settings, BatteryChargeControlConfig } from '../types.ts';
import { fetchHaEntityState, callHaService } from './ha-client.ts';
import {
  decideBatteryChargeLevel,
  nearestLevelIndex,
  type BatteryChargeDecision,
} from '../../lib/battery-charge-controller.ts';

/**
 * Real-time charge-current limiter — a port of the HA "Battery Charge Current
 * State Machine" automation. Each tick it reads the live max cell voltage across
 * the pack, runs the pure state machine (see lib/battery-charge-controller.ts),
 * and writes the Victron ESS max-charge-current register via an HA service call.
 *
 * Safety properties (mirroring ev-actuator-service.ts):
 *  - idempotent: only writes when the target level differs from the last command
 *  - fail-safe: NO write on uncertainty (HA error, missing/invalid voltage). The
 *    register holds its last value.
 *  - clean startup: tick 1 seeds the command level from the observed register and
 *    writes nothing; tick 2+ apply normal idempotent writes.
 *  - single owner: contention (observed register ≠ commanded) is detected and
 *    surfaced — catches the HA automation still running on the same register.
 *  - dry-run: logs the intended write without actuating.
 */

export type ChargeControlStatus =
  | 'never_run'
  | 'disabled'
  | 'misconfigured'
  | 'no_voltage'
  | 'seeded'
  | 'ok'
  | 'dry_run'
  | 'contention'
  | 'error';

export interface ChargeControlRecord {
  status: ChargeControlStatus;
  reason: string;
  maxCellVoltage: number | null;
  observedLevel: number | null;
  commandedLevel: number | null;
  targetLevel: number | null;
  wrote: boolean;
  dryRun: boolean;
  contentionCount: number;
  error: string | null;
  timestampMs: number;
}

export interface ChargeControlStatusView extends ChargeControlRecord {
  enabled: boolean;
  intervalSeconds: number | null;
  lastWriteAt: string | null;
}

const CONTENTION_THRESHOLD = 3;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let activeSettings: Settings | null = null;
// null = not yet boot-seeded.
let lastCommandLevel: number | null = null;
let lastChangeMs = 0;
let contentionCount = 0;
let lastWriteAtMs: number | null = null;
let lastRecord: ChargeControlRecord = {
  status: 'never_run', reason: 'controller has not run', maxCellVoltage: null,
  observedLevel: null, commandedLevel: null, targetLevel: null, wrote: false,
  dryRun: true, contentionCount: 0, error: null, timestampMs: 0,
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseNum(state: string | undefined): number | null {
  if (state == null) return null;
  const s = state.trim().toLowerCase();
  if (s === '' || s === 'unavailable' || s === 'unknown' || s === 'none') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function record(rec: Partial<ChargeControlRecord> & { status: ChargeControlStatus; reason: string; timestampMs: number }): ChargeControlRecord {
  lastRecord = {
    maxCellVoltage: null, observedLevel: null, commandedLevel: lastCommandLevel,
    targetLevel: null, wrote: false, dryRun: activeSettings?.batteryChargeControl?.dryRun ?? true,
    contentionCount, error: null, ...rec,
  };
  return lastRecord;
}

/** Resolve the max-cell-voltage source entities: explicit override, else essConfig batteries. */
function voltageEntities(settings: Settings, cfg: BatteryChargeControlConfig): string[] {
  const explicit = (cfg.maxCellVoltageEntities ?? []).filter(e => e);
  if (explicit.length > 0) return explicit;
  return (settings.essConfig?.batteries ?? [])
    .map(b => b.maxCellVoltageEntity)
    .filter((e): e is string => !!e);
}

/** Resolve the charge-current write target: explicit override, else essConfig.system. */
function chargeCurrentEntity(settings: Settings, cfg: BatteryChargeControlConfig): string | undefined {
  return cfg.maxChargeCurrentEntity || settings.essConfig?.system?.maxChargeCurrentEntity || undefined;
}

export function getBatteryChargeStatus(): ChargeControlStatusView {
  const cfg = activeSettings?.batteryChargeControl;
  return {
    ...lastRecord,
    enabled: cfg?.enabled ?? false,
    intervalSeconds: cfg?.controlIntervalSeconds ?? null,
    lastWriteAt: lastWriteAtMs ? new Date(lastWriteAtMs).toISOString() : null,
  };
}

/** Reset in-memory state (tests + clean restarts). */
export function resetBatteryChargeState(): void {
  lastCommandLevel = null;
  lastChangeMs = 0;
  contentionCount = 0;
  lastWriteAtMs = null;
  lastRecord = {
    status: 'never_run', reason: 'controller has not run', maxCellVoltage: null,
    observedLevel: null, commandedLevel: null, targetLevel: null, wrote: false,
    dryRun: true, contentionCount: 0, error: null, timestampMs: 0,
  };
}

/** Run one control tick. Never throws. `settingsOverride` is for tests; production uses activeSettings. */
export async function runBatteryChargeTick(nowMs: number = Date.now(), settingsOverride?: Settings): Promise<ChargeControlRecord> {
  const settings = settingsOverride ?? activeSettings;
  if (settingsOverride) activeSettings = settingsOverride;
  const cfg = settings?.batteryChargeControl;
  if (!settings || !cfg?.enabled) {
    return record({ status: 'disabled', reason: 'controller disabled', timestampMs: nowMs });
  }

  const vEntities = voltageEntities(settings, cfg);
  const currentEntity = chargeCurrentEntity(settings, cfg);
  if (vEntities.length === 0 || !currentEntity) {
    return record({ status: 'misconfigured', reason: 'no voltage source and/or charge-current entity configured', timestampMs: nowMs });
  }

  // Read the live max cell voltage across all configured sources.
  let maxCellVoltage: number | null = null;
  try {
    const states = await Promise.all(
      vEntities.map(id => fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: id })),
    );
    for (const s of states) {
      const v = parseNum(s.state);
      if (v != null && (maxCellVoltage == null || v > maxCellVoltage)) maxCellVoltage = v;
    }
  } catch (err) {
    return record({ status: 'error', reason: 'cell voltage read failed', error: msg(err), timestampMs: nowMs });
  }
  if (maxCellVoltage == null) {
    return record({ status: 'no_voltage', reason: 'no valid cell voltage → hold', timestampMs: nowMs });
  }

  // Read the observed register (for seeding + contention). Tolerate failure on
  // later ticks; only a missing seed read forces a hold.
  let observedLevel: number | null = null;
  try {
    const s = await fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: currentEntity });
    observedLevel = parseNum(s.state);
  } catch (err) {
    if (lastCommandLevel === null) {
      return record({ status: 'error', reason: 'charge-current read failed (cannot seed)', error: msg(err), maxCellVoltage, timestampMs: nowMs });
    }
  }

  // Clean startup: seed from the observed register, write nothing.
  if (lastCommandLevel === null) {
    const idx = nearestLevelIndex(cfg.currentLevels, observedLevel ?? 0);
    lastCommandLevel = cfg.currentLevels[idx] ?? observedLevel ?? 0;
    lastChangeMs = nowMs;
    return record({
      status: 'seeded', reason: 'boot seed — no write on first tick',
      maxCellVoltage, observedLevel, commandedLevel: lastCommandLevel, targetLevel: lastCommandLevel,
      timestampMs: nowMs,
    });
  }

  const dwellElapsed = (nowMs - lastChangeMs) >= cfg.stabilizationSeconds * 1000;
  const decision: BatteryChargeDecision = decideBatteryChargeLevel(
    { maxCellVoltage, currentLevel: lastCommandLevel, dwellElapsed },
    cfg,
  );

  // Single-owner contention (live writes only — in dry-run the register never moves).
  if (!cfg.dryRun && observedLevel != null) {
    const observedRung = cfg.currentLevels[nearestLevelIndex(cfg.currentLevels, observedLevel)];
    if (observedRung !== lastCommandLevel) {
      contentionCount++;
      if (contentionCount >= CONTENTION_THRESHOLD) {
        console.warn(`[battery-charge-controller] contention: register observed ${observedLevel}A (~${observedRung}A) but last command was ${lastCommandLevel}A for ${contentionCount} ticks (another controller?)`);
      }
    } else {
      contentionCount = 0;
    }
  }

  if (!decision.changed) {
    return record({
      status: contentionCount >= CONTENTION_THRESHOLD ? 'contention' : 'ok',
      reason: decision.reason, maxCellVoltage, observedLevel,
      commandedLevel: lastCommandLevel, targetLevel: decision.level, timestampMs: nowMs,
    });
  }

  // Dry-run: advance the virtual state so dwell/hysteresis still progress, but don't write.
  if (cfg.dryRun) {
    console.info(`[battery-charge-controller] dry-run: ${lastCommandLevel}A → ${decision.level}A (${decision.reason}, maxV=${maxCellVoltage})`);
    lastCommandLevel = decision.level;
    lastChangeMs = nowMs;
    return record({
      status: 'dry_run', reason: decision.reason, maxCellVoltage, observedLevel,
      commandedLevel: decision.level, targetLevel: decision.level, wrote: false, timestampMs: nowMs,
    });
  }

  // Live write.
  try {
    await callHaService({
      haUrl: settings.haUrl, haToken: settings.haToken,
      domain: 'number', service: 'set_value',
      target: { entity_id: currentEntity }, data: { value: decision.level },
    });
  } catch (err) {
    return record({ status: 'error', reason: `charge-current write failed (${decision.reason})`, error: msg(err), maxCellVoltage, observedLevel, targetLevel: decision.level, timestampMs: nowMs });
  }
  lastCommandLevel = decision.level;
  lastChangeMs = nowMs;
  lastWriteAtMs = nowMs;
  console.info(`[battery-charge-controller] set charge current → ${decision.level}A (${decision.reason}, maxV=${maxCellVoltage})`);
  return record({
    status: contentionCount >= CONTENTION_THRESHOLD ? 'contention' : 'ok',
    reason: decision.reason, maxCellVoltage, observedLevel,
    commandedLevel: decision.level, targetLevel: decision.level, wrote: true, timestampMs: nowMs,
  });
}

async function tickGuarded(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runBatteryChargeTick();
  } catch (err) {
    console.error('[battery-charge-controller] tick error:', msg(err));
  } finally {
    ticking = false;
  }
}

/** Start the control loop. Stops any previous loop first. */
export function startBatteryChargeController(settings: Settings): void {
  const wasRunning = intervalHandle !== null;
  stopBatteryChargeController();
  activeSettings = settings;
  const cfg = settings.batteryChargeControl;
  if (!cfg?.enabled) return;
  // Reset ownership state only on a genuine (re)enable, not on every settings save.
  if (!wasRunning) resetBatteryChargeState();
  const sec = Math.max(5, cfg.controlIntervalSeconds || 30);
  console.log(`[battery-charge-controller] started (every ${sec}s, dryRun=${cfg.dryRun})`);
  intervalHandle = setInterval(() => { void tickGuarded(); }, sec * 1000);
  void tickGuarded();
}

export function stopBatteryChargeController(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[battery-charge-controller] stopped');
  }
}

export function isBatteryChargeControllerRunning(): boolean {
  return intervalHandle !== null;
}
