import type { Settings, EssBatteryConfig } from '../types.ts';
import { fetchHaEntityState, callHaService } from './ha-client.ts';
import { decideBalanceSettings, type BalanceDecision } from '../../lib/balance-tuner.ts';

/**
 * Per-BMS adaptive balancer-threshold tuner — a port of the HA
 * `periodic_balance_check` automation. Each tick, for every configured battery,
 * it reads the live max cell voltage + pack current, computes the balance start
 * voltage + trigger delta (see lib/balance-tuner.ts), and writes the two JK BMS
 * number entities — but only when the decided values differ from what the BMS
 * currently has (idempotent, mirroring the automation's `settings_changed` guard).
 *
 * Safety: each BMS is handled independently and failures never throw out of the
 * tick; a read/write error records an error for that BMS and moves on. Dry-run
 * logs the intended writes without actuating.
 */

export type BalanceBmsStatus = 'ok' | 'dry_run' | 'misconfigured' | 'no_voltage' | 'error';

export interface BalanceBmsRecord {
  name: string;
  status: BalanceBmsStatus;
  reason: string;
  maxCellVoltage: number | null;
  current: number | null;
  startVoltage: number | null;
  triggerVoltage: number | null;
  warning: boolean;
  wrote: boolean;
  error: string | null;
}

export interface BalanceStatusView {
  enabled: boolean;
  dryRun: boolean;
  intervalSeconds: number | null;
  lastTickAt: string | null;
  lastWriteAt: string | null;
  batteries: BalanceBmsRecord[];
}

// Two values agreeing within half a millivolt are "the same" write.
const V_EPS = 0.0005;

// Physically plausible LiFePO4 cell-voltage band (V); reads outside it are sensor
// faults and must not drive a balance-threshold write.
const MIN_PLAUSIBLE_CELL_V = 1.5;
const MAX_PLAUSIBLE_CELL_V = 4.5;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let activeSettings: Settings | null = null;
let lastTickAtMs: number | null = null;
let lastWriteAtMs: number | null = null;
let lastRecords: BalanceBmsRecord[] = [];
/** Fallback baseline (per battery name) when the observed read fails. */
const lastCommanded = new Map<string, { start: number; trigger: number }>();

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

async function processBattery(settings: Settings, battery: EssBatteryConfig): Promise<BalanceBmsRecord> {
  const cfg = settings.batteryBalanceControl!;
  const name = battery.name;
  const base: BalanceBmsRecord = {
    name, status: 'ok', reason: '', maxCellVoltage: null, current: null,
    startVoltage: null, triggerVoltage: null, warning: false, wrote: false, error: null,
  };

  const vEntity = battery.maxCellVoltageEntity;
  const iEntity = battery.currentEntity;
  const startEntity = battery.balanceStartVoltageEntity;
  const triggerEntity = battery.balanceTriggerVoltageEntity;
  if (!vEntity || !iEntity || !startEntity || !triggerEntity) {
    return { ...base, status: 'misconfigured', reason: 'missing voltage/current/balance entity' };
  }

  // Reads: voltage + current are required; observed start/trigger are best-effort.
  let maxCellVoltage: number | null;
  let current: number | null;
  let observedStart: number | null = null;
  let observedTrigger: number | null = null;
  try {
    const [vS, iS, sS, tS] = await Promise.all([
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: vEntity }),
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: iEntity }),
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: startEntity }),
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: triggerEntity }),
    ]);
    maxCellVoltage = parseNum(vS.state);
    current = parseNum(iS.state);
    observedStart = parseNum(sS.state);
    observedTrigger = parseNum(tS.state);
  } catch (err) {
    return { ...base, status: 'error', reason: 'BMS read failed', error: msg(err) };
  }
  if (maxCellVoltage == null || current == null) {
    return { ...base, status: 'no_voltage', reason: 'no valid voltage/current → hold', maxCellVoltage, current };
  }
  // Reject physically implausible voltage reads (sensor fault) — never write balance
  // thresholds to the BMS off a glitched value. Hold instead.
  if (maxCellVoltage < MIN_PLAUSIBLE_CELL_V || maxCellVoltage > MAX_PLAUSIBLE_CELL_V) {
    return { ...base, status: 'no_voltage', reason: `implausible cell voltage ${maxCellVoltage}V → hold`, maxCellVoltage, current };
  }

  const decision: BalanceDecision = decideBalanceSettings(maxCellVoltage, current, cfg);
  const filled: BalanceBmsRecord = {
    ...base, maxCellVoltage, current,
    startVoltage: decision.startVoltage, triggerVoltage: decision.triggerVoltage,
    warning: decision.warning, reason: decision.reason,
  };

  // Idempotency baseline: prefer the observed BMS values, fall back to last command.
  const fallback = lastCommanded.get(name);
  const baseStart = observedStart ?? fallback?.start ?? null;
  const baseTrigger = observedTrigger ?? fallback?.trigger ?? null;
  const changed = baseStart == null || baseTrigger == null
    || Math.abs(decision.startVoltage - baseStart) > V_EPS
    || Math.abs(decision.triggerVoltage - baseTrigger) > V_EPS;

  if (!changed) {
    return filled;
  }

  if (cfg.dryRun) {
    console.info(`[balance-tuner] dry-run ${name}: start→${decision.startVoltage}V trigger→${decision.triggerVoltage}V (${decision.reason}, maxV=${maxCellVoltage}, I=${current}A)`);
    lastCommanded.set(name, { start: decision.startVoltage, trigger: decision.triggerVoltage });
    return { ...filled, status: 'dry_run' };
  }

  try {
    await callHaService({
      haUrl: settings.haUrl, haToken: settings.haToken,
      domain: 'number', service: 'set_value',
      target: { entity_id: startEntity }, data: { value: decision.startVoltage },
    });
    await callHaService({
      haUrl: settings.haUrl, haToken: settings.haToken,
      domain: 'number', service: 'set_value',
      target: { entity_id: triggerEntity }, data: { value: decision.triggerVoltage },
    });
  } catch (err) {
    return { ...filled, status: 'error', reason: `balance write failed (${decision.reason})`, error: msg(err) };
  }
  lastCommanded.set(name, { start: decision.startVoltage, trigger: decision.triggerVoltage });
  lastWriteAtMs = Date.now();
  console.info(`[balance-tuner] ${name}: start→${decision.startVoltage}V trigger→${decision.triggerVoltage}V (${decision.reason}, maxV=${maxCellVoltage}, I=${current}A)`);
  return { ...filled, wrote: true };
}

/** Run one tuner tick. `settingsOverride` is for tests; production uses activeSettings. */
export async function runBalanceTunerTick(nowMs: number = Date.now(), settingsOverride?: Settings): Promise<BalanceBmsRecord[]> {
  const settings = settingsOverride ?? activeSettings;
  if (settingsOverride) activeSettings = settingsOverride;
  const cfg = settings?.batteryBalanceControl;
  if (!settings || !cfg?.enabled) {
    lastRecords = [];
    return lastRecords;
  }
  lastTickAtMs = nowMs;
  const batteries = settings.essConfig?.batteries ?? [];
  // Sequential per-BMS to keep HA request bursts modest; each is independently fail-safe.
  const records: BalanceBmsRecord[] = [];
  for (const battery of batteries) {
    records.push(await processBattery(settings, battery));
  }
  lastRecords = records;
  return records;
}

async function tickGuarded(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runBalanceTunerTick();
  } catch (err) {
    console.error('[balance-tuner] tick error:', msg(err));
  } finally {
    ticking = false;
  }
}

export function getBalanceTunerStatus(): BalanceStatusView {
  const cfg = activeSettings?.batteryBalanceControl;
  return {
    enabled: cfg?.enabled ?? false,
    dryRun: cfg?.dryRun ?? true,
    intervalSeconds: cfg?.controlIntervalSeconds ?? null,
    lastTickAt: lastTickAtMs ? new Date(lastTickAtMs).toISOString() : null,
    lastWriteAt: lastWriteAtMs ? new Date(lastWriteAtMs).toISOString() : null,
    batteries: [...lastRecords],
  };
}

export function resetBalanceTunerState(): void {
  lastTickAtMs = null;
  lastWriteAtMs = null;
  lastRecords = [];
  lastCommanded.clear();
}

export function startBalanceTuner(settings: Settings): void {
  stopBalanceTuner();
  activeSettings = settings;
  const cfg = settings.batteryBalanceControl;
  if (!cfg?.enabled) return;
  const sec = Math.max(5, cfg.controlIntervalSeconds || 300);
  console.log(`[balance-tuner] started (every ${sec}s, dryRun=${cfg.dryRun})`);
  intervalHandle = setInterval(() => { void tickGuarded(); }, sec * 1000);
  void tickGuarded();
}

export function stopBalanceTuner(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[balance-tuner] stopped');
  }
}

export function isBalanceTunerRunning(): boolean {
  return intervalHandle !== null;
}
