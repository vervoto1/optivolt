// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import { fetchEvLoadFromHA } from './ha-ev-service.ts';
import { extractWindow } from '../../lib/time-series-utils.ts';
import type { PlanRowWithDess, Data } from '../types.ts';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

// Lazy, shared HiGHS instance
type HighsInstance = Awaited<ReturnType<typeof highsFactory>>;
let highsPromise: Promise<HighsInstance> | undefined;

async function getHighsInstance(): Promise<HighsInstance> {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error: unknown) => {
      highsPromise = undefined;
      throw error;
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
  let result: ReturnType<typeof highs.solve>;
  try {
    result = highs.solve(lpText);
  } catch (err) {
    highsPromise = undefined; // force re-initialisation on next call
    throw err;
  }

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

  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalanceRemainingSlots ?? 0,
  );

  return { cfg, data, timing, result, rows: rowsWithDess, summary, rebalanceWindow };
}

let lastDessFingerprint: string | null = null;

function dessFingerprint(rows: PlanRowWithDess[], slotCount: number): string {
  const n = Math.min(slotCount, rows.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = rows[i].dess;
    parts.push(`${d.strategy}:${d.restrictions}:${d.feedin}:${Math.round(d.socTarget_percent)}`);
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
