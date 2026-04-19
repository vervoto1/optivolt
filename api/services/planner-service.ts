// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings, loadSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import { fetchEvLoadFromHA } from './ha-ev-service.ts';
import { extractWindow, getNextQuarterStart, getForecastTimeRange, getSeriesEndMs } from '../../lib/time-series-utils.ts';
import { savePlanSnapshot } from './plan-history-store.ts';
import type { PlanRowWithDess, PlanSnapshot, Data } from '../types.ts';
import type { TimeSeries } from '../../lib/types.ts';

function computeHorizonWarnings(data: Data, nowMs: number): string[] {
  const warnings: string[] = [];
  const expectedEndMs = new Date(getForecastTimeRange(nowMs).endIso).getTime();
  const toleranceMs = 2 * 60 * 60 * 1000;

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

// Cache of the last computed plan, used by /ev/* endpoints
let lastPlan: ComputePlanResult | undefined;

export function getLastPlan(): ComputePlanResult | undefined {
  return lastPlan;
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

  // Always refresh EV load from HA when evConfig is enabled (schedule changes frequently)
  if (settings.evConfig?.enabled) {
    try {
      const evLoad = await fetchEvLoadFromHA(settings);
      if (evLoad) {
        cfg.evLoad_W = extractWindow(evLoad, timing.startMs, timing.startMs + cfg.load_W.length * settings.stepSize_m * 60_000);
        console.log(`[calculate] EV load refreshed from HA (${cfg.evLoad_W.filter(v => v > 0).length} active slots)`);
      } else {
        // Clear stale EV load (e.g., car disconnected, schedule empty)
        cfg.evLoad_W = new Array(cfg.load_W.length).fill(0);
        console.log('[calculate] EV load cleared (not available from HA)');
      }
    } catch (err) {
      console.warn('[calculate] Failed to refresh EV load from HA:', (err as Error).message);
    }
  }

  // Pre-solve bookkeeping: if a rebalance cycle just completed, auto-disable
  if (settings.rebalanceEnabled && (cfg.rebalanceRemainingSlots ?? Infinity) === 0) {
    data = { ...data, rebalanceState: { startMs: null } };
    settings = { ...settings, rebalanceEnabled: false };
    await Promise.all([saveSettings(settings), saveData(data)]);
    // Rebuild cfg without rebalance constraints
    cfg = buildSolverConfigFromSettings(settings, data, timing.startMs);
  }

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const hasBinaries = cfg.ev != null || (cfg.rebalanceRemainingSlots ?? 0) > 0;
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

  const rows = parseSolution(result, cfg, timing);

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg);

  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i] }));

  // Post-solve bookkeeping: if rebalancing is enabled but hasn't started, check actual SoC
  if (settings.rebalanceEnabled && (data.rebalanceState?.startMs == null)) {
    if (data.soc.value >= settings.maxSoc_percent) {
      data = { ...data, rebalanceState: { startMs: timing.startMs } };
      await saveData(data);
    }
  }

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

  lastPlan = { cfg, data, timing, result, rows: rowsWithDess, summary, rebalanceWindow };

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

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
  forceWrite = false,
} = {}): Promise<ComputePlanResult> {
  const result = await computePlan({ updateData });
  if (writeToVictron) {
    try {
      await writePlanToVictron(result.rows, { force: forceWrite });
    } catch (err) {
      console.error('[calculate] Failed to write to Victron:', (err as Error).message);
    }
  }
  return result;
}
