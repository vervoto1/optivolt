import type { Settings, ShoreOptimizerConfig } from '../types.ts';
import {
  decideShoreCurrent,
  normalizeMppOperationMode,
  type MppOperationModeState,
  type ShoreOptimizerSlotMode,
} from '../../lib/shore-optimizer.ts';
import { getCurrentSlotMode } from './planner-service.ts';
import { getVictronSerial, subscribeVictronJson, writeVictronSetting } from './mqtt-service.ts';

interface Reading<T> {
  value: T | null;
  raw: unknown;
  updatedAtMs: number | null;
}

export interface ShoreOptimizerWriteRecord {
  ts: string;
  oldA: number;
  newA: number;
  mpptState: string;
  batteryPowerW: number;
  slotMode: ShoreOptimizerSlotMode;
  dryRun: boolean;
}

export interface ShoreOptimizerStatus {
  enabled: boolean;
  dryRun: boolean;
  lastTickAt: string | null;
  lastWriteAt: string | null;
  currentShoreA: number | null;
  mpptState: string | null;
  mpptStateDisplay: string | null;
  mpptStateRaw: unknown;
  batteryPowerW: number | null;
  slotMode: ShoreOptimizerSlotMode;
  stale: {
    currentShoreA: boolean;
    mpptState: boolean;
    batteryPowerW: boolean;
  };
  recentWrites: ShoreOptimizerWriteRecord[];
}

const STALE_AFTER_MS = 30_000;
const RECENT_WRITE_LIMIT = 50;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let unsubscribeFns: (() => Promise<void>)[] = [];
let startToken = 0;
let tickInFlight = false;

let activeConfig: ShoreOptimizerConfig | null = null;
let activeSerial: string | null = null;
let activeShoreRelativePath: string | null = null;

let currentShoreA: Reading<number> = emptyReading();
let batteryPowerW: Reading<number> = emptyReading();
let mppOperationMode: Reading<unknown> = emptyReading();

let lastTickAtMs: number | null = null;
let lastWriteAtMs: number | null = null;
let latestSlotMode: ShoreOptimizerSlotMode = 'unknown';
const recentWrites: ShoreOptimizerWriteRecord[] = [];

export function startShoreOptimizer(settings: Settings): void {
  stopShoreOptimizer();

  const cfg = settings.shoreOptimizer;
  activeConfig = cfg ?? null;
  activeSerial = null;
  activeShoreRelativePath = null;
  resetReadings();

  if (!cfg?.enabled) return;

  const token = ++startToken;
  const tickMs = Math.max(1000, cfg.tickMs ?? 3000);

  initializeSubscriptions(token, cfg).catch(err => {
    console.error('[shore-optimizer] subscription setup failed:', (err as Error).message);
  });

  intervalHandle = setInterval(() => {
    tick().catch(err => console.error('[shore-optimizer] tick failed:', (err as Error).message));
  }, tickMs);

  tick().catch(err => console.error('[shore-optimizer] initial tick failed:', (err as Error).message));
  console.log(`[shore-optimizer] started (tick=${tickMs}ms, dryRun=${cfg.dryRun})`);
}

export function stopShoreOptimizer(): void {
  startToken += 1;

  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[shore-optimizer] stopped');
  }

  const unsubs = unsubscribeFns;
  unsubscribeFns = [];
  for (const unsubscribe of unsubs) {
    unsubscribe().catch(err =>
      console.warn('[shore-optimizer] unsubscribe failed:', (err as Error).message),
    );
  }

  tickInFlight = false;
}

export function getShoreOptimizerStatus(configFallback?: ShoreOptimizerConfig): ShoreOptimizerStatus {
  const cfg = activeConfig ?? configFallback;
  const nowMs = Date.now();
  const mppt = normalizeMppOperationMode(mppOperationMode.value);
  const slotMode = getCurrentSlotMode(nowMs);

  latestSlotMode = slotMode;

  return {
    enabled: cfg?.enabled ?? false,
    dryRun: cfg?.dryRun ?? true,
    lastTickAt: isoOrNull(lastTickAtMs),
    lastWriteAt: isoOrNull(lastWriteAtMs),
    currentShoreA: currentShoreA.value,
    mpptState: mppt.id === 'unknown' ? null : mppt.id,
    mpptStateDisplay: mppt.id === 'unknown' ? null : mppt.display,
    mpptStateRaw: mppOperationMode.raw,
    batteryPowerW: batteryPowerW.value,
    slotMode,
    stale: {
      currentShoreA: isStale(currentShoreA, nowMs),
      mpptState: isStale(mppOperationMode, nowMs),
      batteryPowerW: isStale(batteryPowerW, nowMs),
    },
    recentWrites: [...recentWrites],
  };
}

async function initializeSubscriptions(token: number, cfg: ShoreOptimizerConfig): Promise<void> {
  const serial = cfg.portalId || await getVictronSerial();
  const topics = buildTopics(serial, cfg);

  const subscriptions = await Promise.all([
    subscribeNumber(topics.currentLimit, topics.currentLimitRequest, currentShoreA),
    subscribeNumber(topics.batteryPower, topics.batteryPowerRequest, batteryPowerW),
    subscribeValue(topics.mppOperationMode, topics.mppOperationModeRequest, mppOperationMode),
  ]);

  if (token !== startToken) {
    await Promise.allSettled(subscriptions.map(unsubscribe => unsubscribe()));
    return;
  }

  activeSerial = serial;
  activeShoreRelativePath = topics.currentLimitRelativePath;
  unsubscribeFns = subscriptions;
}

async function tick(): Promise<void> {
  const cfg = activeConfig;
  if (!cfg?.enabled || tickInFlight) return;

  tickInFlight = true;
  try {
    const nowMs = Date.now();
    lastTickAtMs = nowMs;
    latestSlotMode = getCurrentSlotMode(nowMs);

    const stateFresh =
      !isStale(currentShoreA, nowMs)
      && !isStale(mppOperationMode, nowMs)
      && !isStale(batteryPowerW, nowMs);

    const decision = decideShoreCurrent({
      enabled: cfg.enabled,
      stateFresh,
      gateOnDessSchedule: cfg.gateOnDessSchedule,
      slotMode: latestSlotMode,
      currentShoreA: currentShoreA.value,
      batteryPowerW: batteryPowerW.value,
      mppOperationMode: mppOperationMode.value,
      config: cfg,
    });

    if (!decision.shouldWrite) {
      logGateBlock(decision.reason ?? 'unchanged', decision.mpptState);
      return;
    }

    const oldA = decision.oldA;
    const newA = decision.newA;
    if (oldA == null || newA == null || batteryPowerW.value == null) return;

    const record = {
      ts: new Date(nowMs).toISOString(),
      oldA,
      newA,
      mpptState: decision.mpptState.id,
      batteryPowerW: batteryPowerW.value,
      slotMode: latestSlotMode,
      dryRun: cfg.dryRun,
    };

    if (cfg.dryRun) {
      pushWriteRecord(record);
      console.info('[shore-optimizer] dry-run setpoint write', record);
      return;
    }

    const serial = (activeSerial ?? cfg.portalId) || undefined;
    const relativePath = activeShoreRelativePath ?? buildTopics(serial ?? cfg.portalId, cfg).currentLimitRelativePath;
    await writeVictronSetting(relativePath, newA, { serial });
    lastWriteAtMs = Date.now();
    pushWriteRecord(record);
    console.info('[shore-optimizer] setpoint write', record);
  } finally {
    tickInFlight = false;
  }
}

function buildTopics(serial: string, cfg: ShoreOptimizerConfig): {
  currentLimit: string;
  currentLimitRequest: string;
  currentLimitRelativePath: string;
  batteryPower: string;
  batteryPowerRequest: string;
  mppOperationMode: string;
  mppOperationModeRequest: string;
} {
  const currentLimitRelativePath = `multi/${cfg.multiInstance}/Ac/In/${cfg.acInputIndex}/CurrentLimit`;
  const batteryPowerRelativePath = `battery/${cfg.batteryInstance}/Dc/0/Power`;
  const mppRelativePath = `multi/${cfg.multiInstance}/Pv/${cfg.mpptInstance}/MppOperationMode`;

  return {
    currentLimit: `N/${serial}/${currentLimitRelativePath}`,
    currentLimitRequest: `R/${serial}/${currentLimitRelativePath}`,
    currentLimitRelativePath,
    batteryPower: `N/${serial}/${batteryPowerRelativePath}`,
    batteryPowerRequest: `R/${serial}/${batteryPowerRelativePath}`,
    mppOperationMode: `N/${serial}/${mppRelativePath}`,
    mppOperationModeRequest: `R/${serial}/${mppRelativePath}`,
  };
}

async function subscribeNumber(
  topic: string,
  requestTopic: string,
  reading: Reading<number>,
): Promise<() => Promise<void>> {
  return subscribeVictronJson(topic, (_topic, payload) => {
    const value = payloadValue(payload);
    const n = Number(value);
    if (!Number.isFinite(n)) {
      console.debug('[shore-optimizer] ignored non-numeric MQTT payload', { topic, payload });
      return;
    }
    updateReading(reading, n, payload);
  }, { requestTopic });
}

async function subscribeValue(
  topic: string,
  requestTopic: string,
  reading: Reading<unknown>,
): Promise<() => Promise<void>> {
  return subscribeVictronJson(topic, (_topic, payload) => {
    updateReading(reading, payloadValue(payload), payload);
  }, { requestTopic });
}

function payloadValue(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'value' in payload) {
    return (payload as { value?: unknown }).value;
  }
  return undefined;
}

function updateReading<T>(reading: Reading<T>, value: T, raw: unknown): void {
  reading.value = value;
  reading.raw = raw;
  reading.updatedAtMs = Date.now();
}

function emptyReading<T>(): Reading<T> {
  return { value: null, raw: null, updatedAtMs: null };
}

function resetReadings(): void {
  currentShoreA = emptyReading();
  batteryPowerW = emptyReading();
  mppOperationMode = emptyReading();
  latestSlotMode = 'unknown';
}

function isStale(reading: Reading<unknown>, nowMs: number): boolean {
  return reading.updatedAtMs == null || nowMs - reading.updatedAtMs > STALE_AFTER_MS;
}

function logGateBlock(reason: string, mpptState: MppOperationModeState): void {
  console.debug('[shore-optimizer] gate blocked', {
    reason,
    currentShoreA: currentShoreA.value,
    mpptState: mpptState.id,
    batteryPowerW: batteryPowerW.value,
    slotMode: latestSlotMode,
  });
}

function pushWriteRecord(record: ShoreOptimizerWriteRecord): void {
  recentWrites.push(record);
  if (recentWrites.length > RECENT_WRITE_LIMIT) {
    recentWrites.splice(0, recentWrites.length - RECENT_WRITE_LIMIT);
  }
}

function isoOrNull(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}
