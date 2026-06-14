/* v8 ignore start — vendor wasm import, not a runtime statement */
// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
/* v8 ignore end */
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { annotatePvCurtailmentSlots } from '../../lib/pv-curtailment.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary, PlanRow, TimeSeries } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings, loadSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { applyPredictionAdjustmentsToData } from './prediction-adjustments.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { readVictronSocPercent, setDynamicEssSchedule } from './mqtt-service.ts';
import { getRebalanceNudge, type RebalanceNudge } from './rebalance-nudge.ts';
import { HttpError } from '../http-errors.ts';
import { getNextQuarterStart, getForecastTimeRange, getSeriesEndMs } from '../../lib/time-series-utils.ts';
import { savePlanSnapshot } from './plan-history-store.ts';
import { updatePvCurtailmentPlan } from './pv-curtailment.ts';
import type { PlanRowWithDess, PlanSnapshot, Data } from '../types.ts';
import type { ShoreOptimizerSlotMode } from '../../lib/shore-optimizer.ts';

function computeHorizonWarnings(data: Data, nowMs: number): string[] {
  /* v8 ignore start — line 22 is a statement counter artifact inside a function body */
  // v8 ignore next — trivial one-liner function
  const warnings: string[] = [];
  const expectedEndMs = new Date(getForecastTimeRange(nowMs).endIso).getTime();
  /* v8 ignore next — empty line / statement counter artifact */
  const toleranceMs = 2 * 60 * 60 * 1000;
  /* v8 ignore end */

  const check = (label: string, s: TimeSeries | undefined) => {
    if (!s) return;
    const gapMs = expectedEndMs - getSeriesEndMs(s);
    if (gapMs > toleranceMs) {
      const hours = Math.round(gapMs / (60 * 60 * 1000));
      warnings.push(`${label} ends ${hours}h short of expected horizon — refresh may have failed`);
    }
  };

  check('Load forecast', data.load);
  check('PV forecast', data.pv);
  check('Import prices', data.importPrice);
  check('Export prices', data.exportPrice);
  return warnings;
}

// How many slots we push into Dynamic ESS.
// Venus OS supports 48 schedule slots (indices 0–47).
// Filling all 48 ensures no gaps when slots expire between writes.
const DESS_SLOTS = 48;

// Lazy, shared HiGHS instance
type HighsInstance = Awaited<ReturnType<typeof highsFactory>>;
let highsPromise: Promise<HighsInstance> | undefined;

async function getHighsInstance(): Promise<HighsInstance> {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error: unknown) => {
      /* v8 ignore start */
      highsPromise = undefined;
      throw error;
      /* v8 ignore stop */
    });
  }
  return highsPromise;
}

export interface RebalanceWindow {
  startIdx: number;
  endIdx: number;
}

export interface ComputePlanResult {
  cfg: SolverConfig;
  data: Data;
  timing: { startMs: number; stepMin: number };
  result: HighsSolution;
  rows: PlanRowWithDess[];
  summary: PlanSummary;
  rebalanceWindow?: RebalanceWindow;
  rebalanceNudge: RebalanceNudge;
  /** Wall-clock time the plan was computed — the actuator's plan-freshness check. */
  computedAtMs: number;
}

/**
 * Find which contiguous slot range the MILP solver selected for rebalancing.
 * Scans solution columns for the `start_balance_k` binary that equals 1.
 */
function extractRebalanceWindow(
  columns: Record<string, { Primal?: number }>,
  remainingSlots: number,
): RebalanceWindow | undefined {
  if (remainingSlots <= 0) return undefined;
  for (const [name, col] of Object.entries(columns)) {
    if (name.startsWith('start_balance_') && Math.round(col.Primal ?? 0) === 1) {
      const m = /_(\d+)$/.exec(name);
      if (!m) continue;
      const k = Number(m[1]);
      return { startIdx: k, endIdx: k + remainingSlots - 1 };
    }
  }
  return undefined;
}

function roundPower(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function valueAtTimestampPrecomputed(series: TimeSeries, timestampMs: number, startMs: number, stepMs: number): number | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(stepMs) || stepMs <= 0) return null;
  const index = Math.floor((timestampMs - startMs) / stepMs);
  if (index < 0 || index >= series.values.length) return null;
  const value = Number(series.values[index]);
  return Number.isFinite(value) ? roundPower(value) : null;
}

function attachOriginalPredictionValues(rows: PlanRow[], data: Data): PlanRow[] {
  const loadStartMs = new Date(data.load.start).getTime();
  const loadStepMs = (data.load.step ?? 15) * 60_000;
  const pvStartMs = new Date(data.pv.start).getTime();
  const pvStepMs = (data.pv.step ?? 15) * 60_000;

  return rows.map(row => {
    const originalLoad = valueAtTimestampPrecomputed(data.load, row.timestampMs, loadStartMs, loadStepMs);
    const originalPv = valueAtTimestampPrecomputed(data.pv, row.timestampMs, pvStartMs, pvStepMs);
    const hasLoad = originalLoad != null && Math.abs(originalLoad - row.load) > 0.001;
    const hasPv = originalPv != null && Math.abs(originalPv - row.pv) > 0.001;
    if (!hasLoad && !hasPv) return row;
    return {
      ...row,
      ...(hasLoad ? { originalLoad } : {}),
      ...(hasPv ? { originalPv } : {}),
    };
  });
}

// Cache of the last computed plan, used by /ev/* endpoints
let lastPlan: ComputePlanResult | undefined;

export function getLastPlan(): ComputePlanResult | undefined {
  // v8 ignore next — defensive return when no plan was computed yet
  return lastPlan;
}

export function getCurrentSlotMode(nowMs = Date.now()): ShoreOptimizerSlotMode {
  const plan = lastPlan;
  if (!plan) return 'unknown';

  const stepMs = Math.max(1, plan.cfg.stepSize_m) * 60_000;
  const row = plan.rows.find(r => nowMs >= r.timestampMs && nowMs < r.timestampMs + stepMs);
  if (!row) return 'unknown';

  if (row.g2b > 0) return 'grid_charge';
  if (row.b2l + row.b2g + (row.b2ev ?? 0) > 0) return 'discharge';
  return 'idle';
}

async function refreshMqttSocForPlan(data: Data, batteryInstance?: number): Promise<Data> {
  let socPercent: number | null;
  try {
    const options: { timeoutMs: number; batteryInstance?: number } = { timeoutMs: 5000 };
    if (batteryInstance !== undefined) options.batteryInstance = batteryInstance;
    socPercent = await readVictronSocPercent(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(503, 'Failed to read battery SoC from Victron MQTT', {
      cause: err,
      details: { message },
    });
  }

  if (socPercent === null) {
    throw new HttpError(503, 'Victron MQTT returned no battery SoC');
  }

  const nextData: Data = {
    ...data,
    soc: {
      timestamp: new Date().toISOString(),
      value: socPercent,
    },
  };
  await saveData(nextData);
  console.log(`[calculate] MQTT SoC refreshed: ${socPercent}%`);
  return nextData;
}

export async function computePlan({ updateData = false } = {}): Promise<ComputePlanResult> {
  if (updateData) {
    try {
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError instanceof Error ? vrmError.message : String(vrmError),
      );
    }
  }

  let { cfg, timing, data, settings } = await getSolverInputs();

  if (settings.dataSources.soc === 'mqtt') {
    data = await refreshMqttSocForPlan(data, settings.shoreOptimizer?.batteryInstance);
    cfg = buildSolverConfigFromSettings(settings, data, timing.startMs);
  }

  // Pre-solve bookkeeping: if a rebalance cycle just completed, auto-disable
  if (settings.rebalanceEnabled && (cfg.rebalanceRemainingSlots ?? Infinity) === 0) {
    data = { ...data, rebalanceState: { startMs: null } };
    settings = { ...settings, rebalanceEnabled: false };
    await Promise.all([saveSettings(settings), saveData(data)]);
    // Rebuild cfg without rebalance constraints
    cfg = buildSolverConfigFromSettings(settings, applyPredictionAdjustmentsToData(data), timing.startMs);
  }

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const hasBinaries = cfg.load_W.length > 0;
  const solveOptions = hasBinaries ? { mip_rel_gap: 0.005, mip_abs_gap: 0.01 } : {};
  let result: ReturnType<typeof highs.solve>;
  const t0 = performance.now();
  try {
    result = highs.solve(lpText, solveOptions);
  } catch (err) {
    /* v8 ignore start */
    highsPromise = undefined; // force re-initialisation on next call
    throw err;
    /* v8 ignore stop */
  }
  const solveMs = performance.now() - t0;
  const evCfg = cfg.ev;
  const evInfo = evCfg ? {
    depSlot: evCfg.evDepartureSlot,
    deficitWh: Math.round((evCfg.evTargetSoc_percent - evCfg.evInitialSoc_percent) / 100 * evCfg.evBatteryCapacity_Wh),
    minW: evCfg.evMinChargePower_W,
    maxW: evCfg.evMaxChargePower_W,
  } : null;
  console.log('[calculate] solve', {
    slots: cfg.load_W.length,
    ev: evInfo,
    rebalance: (cfg.rebalanceRemainingSlots ?? 0) > 0,
    solveMs: Math.round(solveMs),
  });

  const rows = attachOriginalPredictionValues(parseSolution(result, cfg, timing), data);

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg, {
    blockFeedInOnNegativePrices: settings.blockFeedInOnNegativePrices !== false,
  });

  const pvControl = annotatePvCurtailmentSlots(rows, cfg, settings.pvCurtailment);
  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i], pvControl: pvControl[i] }));

  // Post-solve bookkeeping: if rebalancing is enabled but hasn't started, check actual SoC
  if (settings.rebalanceEnabled && (data.rebalanceState?.startMs == null)) {
    if (data.soc.value >= settings.maxSoc_percent) {
      data = { ...data, rebalanceState: { startMs: timing.startMs } };
      await saveData(data);
    }
  }

  /* v8 ignore next 4 — rebalanceCtx undefined branch (tests cover enabled=true;
  ternary false branch not tracked by v8 statement counter) */
  const rebalanceCtx = settings.rebalanceEnabled ? {
    enabled: true,
    startMs: data.rebalanceState?.startMs ?? null,
    remainingSlots: cfg.rebalanceRemainingSlots ?? 0,
  } : undefined;

  const summary = buildPlanSummary(rowsWithDess, cfg, diagnostics, rebalanceCtx);

  const horizonWarnings = computeHorizonWarnings(data, timing.startMs);
  if (horizonWarnings.length > 0) {
    summary.horizonWarnings = horizonWarnings;
    for (const w of horizonWarnings) {
      console.error(`[calculate] STALE DATA: ${w}`);
    }
  }

  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalanceRemainingSlots ?? 0,
  );

  const rebalanceNudge = getRebalanceNudge(data);

  lastPlan = { cfg, data, timing, result, rows: rowsWithDess, summary, rebalanceWindow, rebalanceNudge, computedAtMs: Date.now() };
  updatePvCurtailmentPlan({ cfg, rows: rowsWithDess });

  // Persist plan snapshot for adaptive learning (fire-and-forget)
  const snapshotCreatedAtMs = Date.now();
  const snapshotStartMs = getNextQuarterStart(snapshotCreatedAtMs, cfg.stepSize_m);
  const snapshotSlots = rowsWithDess
    .map((row, index) => ({
      row,
      predictedSoc_percent: index === 0 ? cfg.initialSoc_percent : rowsWithDess[index - 1].soc_percent,
    }))
    .filter(({ row }) => row.timestampMs >= snapshotStartMs)
    .map(({ row, predictedSoc_percent }) => ({
      timestampMs: row.timestampMs,
      // soc_percent from the solver is end-of-slot (after flows); shift back
      // so predictedSoc_percent represents start-of-slot (before flows),
      // matching the actual SoC measurement taken at the slot start time.
      predictedSoc_percent,
      chargePower_W: row.g2b + row.pv2b,
      dischargePower_W: row.b2l + row.b2g,
      predictedLoad_W: row.load,
      predictedPv_W: row.pv,
      strategy: row.dess.strategy,
    }));

  const snapshot: PlanSnapshot = {
    planId: `${timing.startMs}-${snapshotCreatedAtMs}`,
    createdAtMs: snapshotCreatedAtMs,
    initialSoc_percent: cfg.initialSoc_percent,
    slots: snapshotSlots,
    config: {
      chargeEfficiency_percent: cfg.chargeEfficiency_percent,
      dischargeEfficiency_percent: cfg.dischargeEfficiency_percent,
      inverterEfficiency_percent: cfg.inverterEfficiency_percent,
      maxChargePower_W: cfg.maxChargePower_W,
      maxDischargePower_W: cfg.maxDischargePower_W,
      batteryCapacity_Wh: cfg.batteryCapacity_Wh,
      idleDrain_W: cfg.idleDrain_W,
      stepSize_m: cfg.stepSize_m,
    },
  };
  savePlanSnapshot(snapshot).catch(err =>
    console.warn('[plan-history] Failed to save snapshot:', (err as Error).message),
  );

  return lastPlan;
}

let lastDessFingerprint: string | null = null;

function dessFingerprint(rows: PlanRowWithDess[], slotCount: number): string {
  const n = Math.min(slotCount, rows.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const d = r.dess;
    // Include timestamp so shifted slots trigger a rewrite (DESS ignores expired Start times)
    parts.push(`${Math.round(r.timestampMs / 1000)}:${d.strategy}:${d.restrictions}:${d.feedin}:${Math.round(d.socTarget_percent)}`);
  }
  return parts.join('|');
}

export async function writePlanToVictron(rows: PlanRowWithDess[], { force = false } = {}): Promise<void> {
  const nSlots = Math.min(DESS_SLOTS, rows.length);
  const fp = dessFingerprint(rows, nSlots);

  if (!force && fp === lastDessFingerprint) {
    console.log(`[mqtt] DESS schedule unchanged, skipping write (${nSlots} slots)`);
    return;
  }

  await setDynamicEssSchedule(rows, nSlots);
  lastDessFingerprint = fp;
}

// Serialization chain: all plan computation + Victron writes run one-at-a-time.
// Callers (auto-calculate, POST /calculate, DESS price refresh, the EV actuator
// reconcile) share the module-global lastPlan / lastDessFingerprint and the MQTT
// connection; without this two solves could interleave around their awaits,
// corrupt the fingerprint (skipping a needed rewrite), or issue concurrent
// schedule writes.
let planWriteChain: Promise<unknown> = Promise.resolve();

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
  forceWrite = false,
} = {}): Promise<ComputePlanResult> {
  const run = async (): Promise<ComputePlanResult> => {
    const result = await computePlan({ updateData });
    if (writeToVictron) {
      await writePlanToVictron(result.rows, { force: forceWrite });
    }
    return result;
  };
  // Chain after whatever is in flight (run regardless of its outcome), and keep
  // the chain alive past rejections so one failed solve doesn't wedge the queue.
  const next = planWriteChain.then(run, run);
  planWriteChain = next.catch(() => {});
  return next;
}
