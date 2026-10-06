/* v8 ignore start — vendor wasm import, not a runtime statement */
// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
/* v8 ignore end */
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { annotatePvCurtailmentSlots } from '../../lib/pv-curtailment.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { solveOptionsFor } from '../../lib/solve-options.ts';
import { parseSolution, assertUsableSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary, PlanRow, TimeSeries } from '../../lib/types.ts';
import { getSolverInputs, buildPlannerConfig, REBALANCE_PENDING_GIVE_UP_MS } from './config-builder.ts';
import { resolveEvMode } from './ev-mode.ts';
import { updateSettings, loadSettings } from './settings-store.ts';
// Aliased: computePlan's `updateData` option means "refresh the series first".
import { updateData as updateStoredData } from './data-store.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { readVictronSocPercent, setDynamicEssSchedule } from './mqtt-service.ts';
import { getRebalanceNudge, type RebalanceNudge } from './rebalance-nudge.ts';
import { HttpError } from '../http-errors.ts';
import { getNextQuarterStart, getForecastTimeRange, getSeriesEndMs } from '../../lib/time-series-utils.ts';
import { savePlanSnapshot } from './plan-history-store.ts';
import { updatePvCurtailmentPlan } from './pv-curtailment.ts';
import type { PlanRowWithDess, PlanSnapshot, Data, Settings } from '../types.ts';
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

/**
 * Advisory EV preview: what the EV charge schedule WOULD look like if the car
 * were plugged in right now (seeded from the live SoC), computed only when the
 * real plan excludes the EV because the car is disconnected. Purely for display
 * — it is never written to Victron and never drives actuation. `rows` is the
 * solved EV schedule; when there is no valid charge window it falls back to a
 * flat live-SoC track so the chart still shows the actual battery percentage.
 */
export interface EvPreviewSummary {
  evChargeTotal_kWh: number;
  evChargeFromGrid_kWh: number;
  evChargeFromPv_kWh: number;
  evChargeFromBattery_kWh: number;
}

export interface EvPreview {
  rows: PlanRow[];
  timing: { startMs: number; stepMin: number };
  liveSoc_percent: number;
  hasSchedule: boolean;
  summary: EvPreviewSummary;
  computedAtMs: number;
}

/** Sum per-slot EV power columns (W) into kWh totals for a preview row set. */
function summarizeEvPreview(rows: PlanRow[], stepMin: number): EvPreviewSummary {
  const stepH = stepMin / 60;
  let ev = 0, grid = 0, pv = 0, bat = 0;
  for (const r of rows) {
    ev += r.ev_charge ?? 0;
    grid += r.g2ev ?? 0;
    pv += r.pv2ev ?? 0;
    bat += r.b2ev ?? 0;
  }
  return {
    evChargeTotal_kWh: ev * stepH / 1000,
    evChargeFromGrid_kWh: grid * stepH / 1000,
    evChargeFromPv_kWh: pv * stepH / 1000,
    evChargeFromBattery_kWh: bat * stepH / 1000,
  };
}

let lastEvPreview: EvPreview | null = null;

export function getLastEvPreview(): EvPreview | null {
  return lastEvPreview;
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

/**
 * Live battery SoC for a soc=mqtt plan, handed to getSolverInputs so the
 * config is built once from it. Throws a 503 rather than planning from a
 * stale SoC.
 */
async function readMqttSocForPlan(settings: Settings): Promise<number> {
  const batteryInstance = settings.shoreOptimizer?.batteryInstance;
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

  console.log(`[calculate] MQTT SoC refreshed: ${socPercent}%`);
  return socPercent;
}

/**
 * Post-solve: a completed hold cycle switches rebalancing off and clears its
 * start marker. Deliberately not pre-solve — a failed solve (or a failure
 * mapping its result) must never mutate user settings. Both writes are locked
 * patches of the current files, never the snapshots loaded for this plan.
 */
async function finishCompletedRebalanceCycle(settings: Settings, data: Data): Promise<{ settings: Settings; data: Data }> {
  if (data.rebalanceState?.startMs == null) {
    // remainingSlots is 0 without a started hold only when config-builder gave
    // up on a hold that never started (REBALANCE_PENDING_GIVE_UP_MS).
    const pendingSinceMs = data.rebalanceState?.pendingSinceMs;
    const since = pendingSinceMs != null ? ` (pending since ${new Date(pendingSinceMs).toISOString()})` : '';
    console.warn(
      `[calculate] rebalance hold did not start within ${REBALANCE_PENDING_GIVE_UP_MS / 86_400_000} days of being enabled${since}; `
      + 'switching rebalancing off so the battery is no longer held for it and export is not blocked indefinitely',
    );
  } else {
    console.log('[calculate] rebalance hold cycle complete; switching rebalancing off');
  }
  const rebalanceState = { startMs: null };
  await Promise.all([
    updateSettings(s => ({ ...s, rebalanceEnabled: false })),
    updateStoredData(d => ({ ...d, rebalanceState })),
  ]);
  return { settings: { ...settings, rebalanceEnabled: false }, data: { ...data, rebalanceState } };
}

/** How the solve treated a started hold's slot-0 pin. */
interface PinnedHoldSolve {
  /** The config actually solved (its `rebalanceMaxStartSlot` is the cap that applied). */
  cfg: SolverConfig;
  result: HighsSolution;
  /**
   * Set only when a pinned hold could not be held from slot 0: the latest
   * start slot the window was then allowed (T - D when the pin was released).
   */
  relaxedMaxStartSlot?: number;
}

// Bounds on the pin-relaxation search below. Each probe is a full solve that
// runs synchronously on the event loop, so the search stops after this many
// probes or this much wall-clock time, keeping the best cap found so far
// (or, when none is feasible yet, releasing the pin). Each probe's own solver
// time limit is cut to what is left of the budget (never below
// PIN_RELAX_MIN_PROBE_LIMIT_S), so one probe cannot overrun it by a full
// SOLVE_TIME_LIMIT_S.
const PIN_RELAX_MAX_PROBES = 8;
const PIN_RELAX_BUDGET_MS = 20_000;
const PIN_RELAX_MIN_PROBE_LIMIT_S = 1;

/**
 * A lower bound on the latest start slot a sagged hold needs: the window
 * starting at slot k needs SoC at target by the end of slot k, and no slot can
 * store more than maxChargePower_W x charge efficiency (taper, idle drain and
 * import limits only lower that). Never below `pin + 1` (the pin itself was
 * just found infeasible).
 */
function pinnedHoldStartLowerBound(cfg: SolverConfig, pin: number): number {
  const target_percent = Math.min(cfg.rebalanceTargetSoc_percent ?? cfg.maxSoc_percent, cfg.maxSoc_percent);
  const deficit_Wh = (target_percent - cfg.initialSoc_percent) / 100 * cfg.batteryCapacity_Wh;
  const perSlotStored_Wh = cfg.maxChargePower_W * (cfg.chargeEfficiency_percent / 100) * (cfg.stepSize_m / 60);
  const slotsNeeded = perSlotStored_Wh > 0 ? Math.ceil(deficit_Wh / perSlotStored_Wh) : Infinity;
  return Math.max(pin + 1, Number.isFinite(slotsNeeded) ? slotsNeeded - 1 : pin + 1);
}

function hasUsableSolution(result: HighsSolution, T: number): boolean {
  try {
    assertUsableSolution(result, T);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build and solve the LP for `solveCfg`. A throwing WASM solve may leave the
 * heap corrupted, so it drops the cached instance and the next solve gets a
 * fresh one.
 *
 * A started rebalance hold is pinned to slot 0 (`rebalanceMaxStartSlot = 0`).
 * When the battery has sagged too far below the target to be back there by
 * the end of slot 0 the pin is infeasible. Releasing it outright would let the
 * solver export now and hold much later while the wall-clock countdown keeps
 * running, so the pin is relaxed only as far as needed: the smallest start cap
 * k at which the hold is feasible (feasibility only grows with k), found by a
 * galloping search from a physical lower bound plus bisection, both bounded
 * (PIN_RELAX_*). When the gallop reaches T - D (a cap that equals no cap) it
 * solves the window free to move and still bisects below it, so a feasible
 * cap under T - D is not skipped. Only a probe Status of "Optimal" counts as
 * feasible: a time-limited incumbent would make computePlan show the plan
 * without caching or writing it, so it never replaces an Optimal answer.
 *
 * The window is freed entirely (the pre-pin behaviour) rather than failing the
 * plan and leaving a stale schedule on the GX when no cap below T - D is
 * found, the budget runs out before any feasible cap, or a pinned or gallop
 * solve ends with a status other than Optimal or Infeasible (e.g. a time
 * limit, even with an incumbent). When the hold covers the whole horizon
 * (T - D = 0) an infeasible pin is returned as is: the free LP is the same LP.
 *
 * `startHint` is the main plan's relaxed cap, passed by the EV preview: the
 * pin already failed there and the preview only adds EV charging, so the
 * pinned solve is skipped and the search starts at the hint. `quiet`
 * suppresses the warnings (the preview would repeat the main plan's).
 */
function solveWithPinnedHoldFallback(
  highs: HighsInstance,
  solveCfg: SolverConfig,
  { startHint, quiet = false }: { startHint?: number; quiet?: boolean } = {},
): PinnedHoldSolve {
  const solveOnce = (c: SolverConfig, timeLimit_s?: number): HighsSolution => {
    const options = solveOptionsFor(c);
    if (timeLimit_s !== undefined) options.time_limit = Math.min(options.time_limit, timeLimit_s);
    try {
      return highs.solve(buildLP(c), options);
    } catch (err) {
      /* v8 ignore start */
      highsPromise = undefined; // force re-initialisation on next call
      throw err;
      /* v8 ignore stop */
    }
  };
  const pin = solveCfg.rebalanceMaxStartSlot;
  if (pin == null) return { cfg: solveCfg, result: solveOnce(solveCfg) };

  const T = solveCfg.load_W.length;
  const D = Math.min(T, Math.max(0, Math.trunc(solveCfg.rebalanceRemainingSlots ?? 0)));
  const maxStart = T - D; // the cap that equals no cap at all
  const { rebalanceMaxStartSlot: _pinnedStartSlot, ...unpinnedCfg } = solveCfg;
  const warn = (message: string) => {
    if (!quiet) console.warn(`[calculate] rebalance hold cannot be held from slot ${pin} (${message}`);
  };
  const release = (reason: string): PinnedHoldSolve => {
    warn(`${reason}); re-solving with the hold window free to move`);
    return { cfg: unpinnedCfg, result: solveOnce(unpinnedCfg), relaxedMaxStartSlot: maxStart };
  };

  if (startHint === undefined) {
    const result = solveOnce(solveCfg);
    if (result.Status === 'Optimal' && hasUsableSolution(result, T)) return { cfg: solveCfg, result };
    // Neither Optimal nor Infeasible (e.g. a time-limited incumbent): free the window.
    if (result.Status !== 'Infeasible') return release(`solver status "${result.Status}"`);
    if (maxStart <= pin) {
      // The hold covers the whole horizon, so there is no later start to relax
      // to: the free LP is this same LP. Let the plan fail on it as it is.
      warn('infeasible; the hold covers the whole horizon, so there is no later start to relax to)');
      return { cfg: solveCfg, result };
    }
  }

  const isOptimal = (r: HighsSolution) => r.Status === 'Optimal' && hasUsableSolution(r, T);
  const capped = (k: number): SolverConfig => ({ ...solveCfg, rebalanceMaxStartSlot: k });
  const deadlineMs = performance.now() + PIN_RELAX_BUDGET_MS;
  const remainingBudget_s = () => (deadlineMs - performance.now()) / 1000;
  let probes = 0;
  const canProbe = () => probes < PIN_RELAX_MAX_PROBES && remainingBudget_s() > 0;
  const probe = (k: number): HighsSolution => {
    probes++;
    return solveOnce(capped(k), Math.max(PIN_RELAX_MIN_PROBE_LIMIT_S, remainingBudget_s()));
  };

  // Gallop: lo is the largest cap known infeasible, hi the smallest known feasible.
  // Caps below the physical lower bound are infeasible without a solve. Caps
  // below a hint are treated as infeasible too: the EV preview's hint is the
  // main plan's smallest feasible cap, and the preview only adds EV charging,
  // so it is no easier (and is display-only).
  const k0 = Math.max(pinnedHoldStartLowerBound(solveCfg, pin), startHint ?? 0);
  let lo = k0 - 1;
  let hi: number | undefined;
  let best: HighsSolution | undefined;
  let step = 1;
  let k = k0;
  while (hi === undefined) {
    if (k >= maxStart) {
      // A cap of T - D is no cap: this is the release solve (full time limit,
      // not a probe). Keep it as the fallback and bisect below it.
      const r = solveOnce(unpinnedCfg);
      if (!isOptimal(r)) {
        warn(`infeasible; free window solved with status "${r.Status}"); hold window free to move`);
        return { cfg: unpinnedCfg, result: r, relaxedMaxStartSlot: maxStart };
      }
      hi = maxStart;
      best = r;
      break;
    }
    if (!canProbe()) return release('infeasible; relaxation search budget exhausted');
    const r = probe(k);
    if (isOptimal(r)) {
      hi = k;
      best = r;
    } else if (r.Status === 'Infeasible') {
      lo = k;
      k = Math.min(maxStart, k + step);
      step *= 2;
    } else {
      return release(`infeasible; relaxed probe ended with solver status "${r.Status}"`);
    }
  }
  // Bisect (lo, hi] down to the smallest feasible cap while the budget lasts.
  let stoppedBy: string | undefined;
  while (hi - lo > 1) {
    if (!canProbe()) {
      stoppedBy = 'budget/time limit';
      break;
    }
    const mid = Math.floor((lo + hi) / 2);
    const r = probe(mid);
    if (isOptimal(r)) {
      hi = mid;
      best = r;
    } else if (r.Status === 'Infeasible') {
      lo = mid;
    } else {
      stoppedBy = `solver status "${r.Status}"`;
      break; // keep the Optimal cap already found
    }
  }
  if (hi >= maxStart) {
    const outcome = stoppedBy
      ? `search stopped (${stoppedBy}) before finding a start cap below slot ${maxStart}`
      : `no start cap below slot ${maxStart} found`;
    warn(`infeasible; ${outcome}, ${probes} relaxed solves); hold window free to move`);
    return { cfg: unpinnedCfg, result: best!, relaxedMaxStartSlot: maxStart };
  }
  warn(`infeasible); hold window allowed to start up to slot ${hi} (${probes} relaxed solves)`);
  return { cfg: capped(hi), result: best!, relaxedMaxStartSlot: hi };
}

/**
 * How far below the rebalance target the live SoC may read and still start the
 * hold clock. Packs whose system SoC tops out at 99 % (as in production) would
 * otherwise never start the hold, and every plan would keep the battery held
 * with battery-to-grid export blocked.
 */
export const REBALANCE_START_TOLERANCE_PERCENT = 1;

/**
 * Post-solve rebalance bookkeeping, run only for an Optimal plan (an early-stop
 * incumbent is display-only and must not start the countdown).
 *
 * - With rebalancing on and no hold started yet: stamp the hold start once the
 *   live SoC is within REBALANCE_START_TOLERANCE_PERCENT of the target and this
 *   plan holds from slot 0. A plan whose own window starts later (e.g. it
 *   exports at a high price first) is not a hold yet; stamping it would start
 *   the wall-clock countdown while the written schedule drains the battery.
 *   Otherwise record when the hold first became pending (`pendingSinceMs`), so
 *   config-builder can give up on a hold that never starts.
 * - With rebalancing off: drop a leftover `pendingSinceMs`, so re-enabling
 *   later starts a fresh give-up period. Nothing is written when there is none.
 */
async function recordRebalanceProgress(
  settings: Settings,
  cfg: SolverConfig,
  data: Data,
  startMs: number,
  rebalanceWindow: RebalanceWindow | undefined,
): Promise<Data> {
  const state = data.rebalanceState;
  if (!settings.rebalanceEnabled) {
    if (state?.pendingSinceMs == null) return data;
    const rebalanceState = { startMs: state.startMs ?? null };
    await updateStoredData(d => ({ ...d, rebalanceState }));
    return { ...data, rebalanceState };
  }
  if (state?.startMs != null) return data;
  const target_percent = Math.min(cfg.rebalanceTargetSoc_percent ?? cfg.maxSoc_percent, cfg.maxSoc_percent);
  if (data.soc.value >= target_percent - REBALANCE_START_TOLERANCE_PERCENT && rebalanceWindow?.startIdx === 0) {
    const rebalanceState = { startMs };
    await updateStoredData(d => ({ ...d, rebalanceState }));
    return { ...data, rebalanceState };
  }
  if (state?.pendingSinceMs != null) return data;
  const rebalanceState = { startMs: null, pendingSinceMs: startMs };
  await updateStoredData(d => ({ ...d, rebalanceState }));
  return { ...data, rebalanceState };
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

  // The config is built exactly once, inside getSolverInputs, from the live
  // SoC (soc=mqtt), the prediction adjustments and the adaptive-learning
  // calibration. Rebuilding it here used to drop the last two on every
  // soc=mqtt plan.
  const solverInputs = await getSolverInputs({ readLiveSoc: readMqttSocForPlan });
  const { timing, evState } = solverInputs;
  let { cfg, data, settings } = solverInputs;

  // A just-completed hold cycle solves like any rebalance-free plan
  // (remainingSlots = 0 builds no rebalance variables or constraints); the
  // actual switch-off happens in post-solve bookkeeping.
  const rebalanceCycleComplete = settings.rebalanceEnabled && (cfg.rebalanceRemainingSlots ?? Infinity) === 0;

  const highs = await getHighsInstance();
  const t0 = performance.now();
  let result: HighsSolution;
  let relaxedMaxStartSlot: number | undefined;
  ({ cfg, result, relaxedMaxStartSlot } = solveWithPinnedHoldFallback(highs, cfg));
  const solveMs = performance.now() - t0;
  const evCfg = cfg.ev;
  const evInfo = evCfg ? {
    depSlot: evCfg.evDepartureSlot,
    deficitWh: Math.round((evCfg.evTargetSoc_percent - evCfg.evInitialSoc_percent) / 100 * evCfg.evBatteryCapacity_Wh),
    minW: evCfg.evMinChargePower_W,
    maxW: evCfg.evMaxChargePower_W,
  } : null;
  console.log('[calculate] solve', {
    status: result.Status,
    slots: cfg.load_W.length,
    ev: evInfo,
    rebalance: (cfg.rebalanceRemainingSlots ?? 0) > 0,
    solveMs: Math.round(solveMs),
  });

  const rows = attachOriginalPredictionValues(parseSolution(result, cfg, timing), data);

  // The hold window the solver chose; the mapper turns its slots into a DESS
  // hold (proBattery, grid charging allowed, target = rebalance target).
  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalanceRemainingSlots ?? 0,
  );

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg, {
    blockFeedInOnNegativePrices: settings.blockFeedInOnNegativePrices !== false,
    rebalanceWindow,
  });

  const pvControl = annotatePvCurtailmentSlots(rows, cfg, settings.pvCurtailment);
  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i], pvControl: pvControl[i] }));

  // Post-solve bookkeeping — reached only when the solve, parse and DESS
  // mapping succeeded, so a failure never flips settings or rebalance state.
  // The hold start (and its pending marker) is recorded only from an Optimal
  // plan: a non-Optimal incumbent is display-only (see below).
  if (rebalanceCycleComplete) {
    ({ settings, data } = await finishCompletedRebalanceCycle(settings, data));
  } else if (result.Status === 'Optimal') {
    data = await recordRebalanceProgress(settings, cfg, data, timing.startMs, rebalanceWindow);
  }

  /* v8 ignore next 4 — rebalanceCtx undefined branch (tests cover enabled=true;
  ternary false branch not tracked by v8 statement counter) */
  const rebalanceCtx = settings.rebalanceEnabled ? {
    enabled: true,
    startMs: data.rebalanceState?.startMs ?? null,
    remainingSlots: cfg.rebalanceRemainingSlots ?? 0,
  } : undefined;

  const summary = buildPlanSummary(rowsWithDess, cfg, diagnostics, rebalanceCtx);
  if (relaxedMaxStartSlot !== undefined) summary.rebalanceHoldMaxStartSlot = relaxedMaxStartSlot;

  const horizonWarnings = computeHorizonWarnings(data, timing.startMs);
  if (horizonWarnings.length > 0) {
    summary.horizonWarnings = horizonWarnings;
    for (const w of horizonWarnings) {
      console.error(`[calculate] STALE DATA: ${w}`);
    }
  }

  const rebalanceNudge = getRebalanceNudge(data);

  const plan: ComputePlanResult = { cfg, data, timing, result, rows: rowsWithDess, summary, rebalanceWindow, rebalanceNudge, computedAtMs: Date.now() };

  // Only an Optimal solve may become the plan the hardware loops act on.
  // parseSolution has already rejected results with no usable solution; what
  // is left here is an early-stop incumbent (e.g. "Time limit reached" with a
  // feasible but unproven plan). Return it for display only: keep the previous
  // lastPlan (and its EV preview) for the EV actuator, shore optimizer and
  // /calculate/last, skip the PV-curtailment update and the adaptive-learning
  // snapshot. planAndMaybeWrite separately refuses to write it to Victron.
  if (result.Status !== 'Optimal') {
    console.warn(`[calculate] solver status "${result.Status}": returning the incumbent for display only; the previous plan stays active`);
    return plan;
  }

  lastPlan = plan;
  updatePvCurtailmentPlan({ cfg, rows: rowsWithDess });

  // EV preview: when the real plan excludes the EV because the car is
  // disconnected, separately solve what the schedule WOULD be if it were
  // plugged in now (seeded from the live SoC). Display-only — never written to
  // Victron, never cached as lastPlan, never used for actuation.
  lastEvPreview = null;
  if (!cfg.ev && resolveEvMode(settings) === 'native' && evState?.soc_percent != null) {
    const liveSoc = evState.soc_percent;
    try {
      // Same assembly as the main plan (adjustments + calibration + EV taper).
      const previewCfg = await buildPlannerConfig(
        settings,
        data,
        timing.startMs,
        { pluggedIn: true, soc_percent: liveSoc, targetSoc_percent: evState.targetSoc_percent },
      );
      if (previewCfg.ev) {
        // Same solve policy as the main plan (pinned-hold fallback; a throwing
        // WASM solve drops the instance). A SolverStatusError from parsing the
        // preview below is not a solver fault and leaves the instance alone.
        const preview = solveWithPinnedHoldFallback(highs, previewCfg, { startHint: relaxedMaxStartSlot, quiet: true });
        // Throws SolverStatusError (caught below) when the preview has no usable solution.
        const previewRows = parseSolution(preview.result, preview.cfg, timing);
        lastEvPreview = {
          rows: previewRows,
          timing,
          liveSoc_percent: liveSoc,
          hasSchedule: true,
          summary: summarizeEvPreview(previewRows, timing.stepMin),
          computedAtMs: Date.now(),
        };
      } else {
        // No valid charge window (e.g. departure already elapsed): surface the
        // live SoC as a flat track so the chart still shows the real battery %.
        lastEvPreview = {
          rows: rows.map(r => ({ ...r, ev_charge: 0, ev_charge_A: 0, ev_charge_mode: 'off', ev_soc_percent: liveSoc })),
          timing,
          liveSoc_percent: liveSoc,
          hasSchedule: false,
          summary: { evChargeTotal_kWh: 0, evChargeFromGrid_kWh: 0, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
          computedAtMs: Date.now(),
        };
      }
    } catch (err) {
      console.warn('[calculate] EV preview solve failed:', (err as Error).message);
    }
  }

  // Persist plan snapshot for adaptive learning (fire-and-forget)
  const snapshotCreatedAtMs = Date.now();
  const snapshotStartMs = getNextQuarterStart(snapshotCreatedAtMs, cfg.stepSize_m);
  const snapshotSlots = rowsWithDess
    .map((row, index) => ({
      row,
      predictedSoc_percent: index === 0 ? cfg.initialSoc_percent : rowsWithDess[index - 1].soc_percent,
      // Start-of-slot EV SoC, same shift as the battery. Only meaningful on
      // EV-active solves; otherwise left undefined so the EV calibrator ignores it.
      predictedEvSoc_percent: cfg.ev
        ? (index === 0 ? cfg.ev.evInitialSoc_percent : rowsWithDess[index - 1].ev_soc_percent)
        : undefined,
    }))
    .filter(({ row }) => row.timestampMs >= snapshotStartMs)
    .map(({ row, predictedSoc_percent, predictedEvSoc_percent }) => ({
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
      predictedEvSoc_percent,
      evChargePower_W: cfg.ev ? row.ev_charge : undefined,
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

  return plan;
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
// Enqueue time of every run on planWriteChain that has not settled yet, for /health:
// a run whose await never settles blocks every later POST /calculate, price refresh
// and EV reconcile behind it.
let pendingPlanRunSeq = 0;
const pendingPlanRunsSinceMs = new Map<number, number>();

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
  forceWrite = false,
} = {}): Promise<ComputePlanResult> {
  const run = async (): Promise<ComputePlanResult> => {
    const result = await computePlan({ updateData });
    if (writeToVictron) {
      // Never push a non-optimal solve to the hardware. Results with no usable
      // solution (infeasible, unbounded, error, early stop without an incumbent)
      // already throw SolverStatusError in parseSolution; this refuses an
      // early-stop incumbent, which computePlan returns for display only.
      if (result.result.Status !== 'Optimal') {
        throw new HttpError(503, 'Refusing to write schedule to Victron: solver did not reach an optimal solution', {
          details: { solverStatus: result.result.Status ?? 'unknown' },
        });
      }
      await writePlanToVictron(result.rows, { force: forceWrite });
    }
    return result;
  };
  // Chain after whatever is in flight (run regardless of its outcome), and keep
  // the chain alive past rejections so one failed solve doesn't wedge the queue.
  const seq = ++pendingPlanRunSeq;
  pendingPlanRunsSinceMs.set(seq, Date.now());
  const next = planWriteChain.then(run, run);
  planWriteChain = next.catch(() => {}).finally(() => { pendingPlanRunsSinceMs.delete(seq); });
  return next;
}

/** Runs queued or in flight on the plan/write chain, and how long the oldest has been waiting. */
export function getPlanWriteChainHealth(nowMs: number = Date.now()): { pending: number; oldestPendingMs: number | null } {
  let oldestSinceMs: number | null = null;
  for (const sinceMs of pendingPlanRunsSinceMs.values()) {
    if (oldestSinceMs === null || sinceMs < oldestSinceMs) oldestSinceMs = sinceMs;
  }
  return {
    pending: pendingPlanRunsSinceMs.size,
    oldestPendingMs: oldestSinceMs === null ? null : nowMs - oldestSinceMs,
  };
}
