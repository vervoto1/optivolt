import type { Settings, PvCurtailmentConfig, PlanRowWithDess } from '../types.ts';
import type { SolverConfig } from '../../lib/types.ts';
import { decidePvCurtailment, type PvCurtailmentDecision } from '../../lib/pv-curtailment.ts';
import { getVictronSerial, writeVictronSetting } from './mqtt-service.ts';

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
  lastTickAt: string | null;
  lastWriteAt: string | null;
  lastDecision: PvCurtailmentDecision | null;
  recentWrites: PvCurtailmentWriteRecord[];
}

const RECENT_WRITE_LIMIT = 50;
const GATE_BLOCK_LOG_INTERVAL_MS = 60_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let activeConfig: PvCurtailmentConfig | null = null;
let activePlan: ActivePlan | null = null;
let tickInFlight = false;
let ownsDisable = false;
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
  activeConfig = cfg ?? null;
  activePlan = null;
  lastDecision = null;
  lastGateBlockSignature = null;
  lastGateBlockLogAtMs = null;

  if (!cfg?.enabled) return;

  const tickMs = Math.max(1000, cfg.tickMs ?? 30_000);
  intervalHandle = setInterval(() => {
    tick().catch(err => console.error('[pv-curtailment] tick failed:', (err as Error).message));
  }, tickMs);

  tick().catch(err => console.error('[pv-curtailment] initial tick failed:', (err as Error).message));
  console.log(`[pv-curtailment] started (tick=${tickMs}ms, dryRun=${cfg.dryRun})`);
}

export async function stopPvCurtailment(): Promise<void> {
  serviceGeneration += 1;

  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[pv-curtailment] stopped');
  }

  activePlan = null;

  if (ownsDisable) {
    try {
      await restorePv();
    } catch (err) {
      console.warn('[pv-curtailment] failed to restore PV on stop:', (err as Error).message);
    }
  }

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
    lastTickAt: isoOrNull(lastTickAtMs),
    lastWriteAt: isoOrNull(lastWriteAtMs),
    lastDecision,
    recentWrites: [...recentWrites],
  };
}

async function tick(): Promise<void> {
  const cfg = activeConfig;
  if (!cfg?.enabled || tickInFlight) return;
  const generation = serviceGeneration;

  tickInFlight = true;
  try {
    const nowMs = Date.now();
    lastTickAtMs = nowMs;

    const decision = activePlan
      ? decidePvCurtailment(activePlan.rows, activePlan.cfg, nowMs, cfg)
      : decidePvCurtailment([], { stepSize_m: 15, maxGridImport_W: 0 }, nowMs, cfg);
    lastDecision = decision;

    if (generation !== serviceGeneration) return;

    if (decision.shouldDisable) {
      await applyPvDisabled(true, decision);
      return;
    }

    logGateBlock(decision);
    if (ownsDisable) {
      await applyPvDisabled(false, decision);
    }
  } finally {
    tickInFlight = false;
  }
}

async function restorePv(): Promise<void> {
  const cfg = activeConfig;
  if (!cfg) return;
  await applyPvDisabled(false, lastDecision ?? {
    shouldDisable: false,
    reason: 'disabled',
    currentIndex: null,
    negativeBlockEndIndex: null,
    currentPv_W: 0,
    currentPvCurtail_W: 0,
    currentGridImport_W: 0,
    currentGridHeadroom_W: 0,
    remainingPv_Wh: 0,
    remainingGridHeadroom_Wh: 0,
  });
}

async function applyPvDisabled(disabled: boolean, decision: PvCurtailmentDecision): Promise<void> {
  const cfg = activeConfig;
  if (!cfg) return;

  if (disabled && ownsDisable) return;
  if (!disabled && !ownsDisable) return;

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

  if (cfg.dryRun) {
    ownsDisable = disabled;
    pushWriteRecord(record);
    console.info('[pv-curtailment] dry-run Pv/Disable write', record);
    return;
  }

  const serial = cfg.portalId || await getVictronSerial();
  const relativePath = `acsystem/${cfg.acsystemInstance}/Pv/Disable`;
  await writeVictronSetting(relativePath, disabled ? 1 : 0, { serial });
  ownsDisable = disabled;
  lastWriteAtMs = Date.now();
  pushWriteRecord(record);
  console.info('[pv-curtailment] Pv/Disable write', record);
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
  return ms == null ? null : new Date(ms).toISOString();
}
