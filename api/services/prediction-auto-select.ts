/**
 * prediction-auto-select.ts
 *
 * Daily backtest of every historical load-predictor strategy for the active
 * sensor. In `suggest` mode the winner is only recorded (the UI offers an
 * Apply button); in `auto` mode `historicalPredictor` is rewritten when the
 * winner clears the configured margin. Only the three strategy fields are
 * ever written — the sensor, predictor type, and PV config are untouched.
 *
 * See plans/load-strategy-auto-select-plan.md for the design and the data
 * behind the defaults (28-day window, 10 % hysteresis).
 */

import { HttpError } from '../http-errors.ts';
import type {
  AutoSelectAction,
  AutoSelectRun,
  AutoSelectTrigger,
  PredictionAutoSelectConfig,
  PredictionConfig,
  Settings,
} from '../types.ts';
import { loadSettings } from './settings-store.ts';
import { computeValidationWindow, loadPredictionConfig, updatePredictionConfig } from './prediction-config-store.ts';
import { scoreStrategies } from './load-prediction-service.ts';
import type { ValidationEntry } from './load-prediction-service.ts';
import { appendAutoSelectRun, getLatestAutoSelectRun } from './prediction-auto-select-store.ts';
import { findDailyWindowStart } from './daily-window.ts';
import { generateAllConfigs } from '../../lib/load-predictor-historical.ts';
import type { PredictConfig } from '../../lib/load-predictor-historical.ts';
import { formatStrategy, isSameStrategy, selectStrategy } from '../../lib/strategy-selector.ts';
import type { SelectionResult, StrategyKey, StrategyScore } from '../../lib/strategy-selector.ts';

const CHECK_INTERVAL_MS = 60_000;
/** The scheduled run fires once inside [time, time + this) — wide enough to survive a slow tick. */
const FIRE_WINDOW_MINUTES = 5;
/** Delay after boot before the catch-up check, so startup I/O settles first. */
const BOOT_CATCH_UP_DELAY_MS = 2 * 60_000;
const CATCH_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/** Scored points required for eligibility, as a share of the window's hourly slots. */
export const MIN_SAMPLES_SHARE = 0.8;
/** Ranking entries kept in the persisted run record. */
const RANKING_LIMIT = 10;

/** Pinned to `api/defaults/default-settings.json` by a test — change both together. */
export const DEFAULT_AUTO_SELECT_CONFIG: PredictionAutoSelectConfig = {
  enabled: false,
  mode: 'suggest',
  time: '03:30',
  metric: 'mae',
  minImprovement_percent: 10,
  windowDays: 28,
};

type HistoricalPredictor = NonNullable<PredictionConfig['historicalPredictor']>;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let catchUpHandle: ReturnType<typeof setTimeout> | null = null;
let configTime = '';
/**
 * Bumped by stop(). A tick or catch-up that was suspended on I/O when the
 * timer was stopped or replaced (every `POST /settings` restarts it) compares
 * its captured generation afterwards and abandons the run.
 */
let generation = 0;
/** Start of the fire window the current timer already served (in-memory de-dup between ticks). */
let firedWindowMs: number | null = null;
let running = false;

/** True while a run (scheduled or manual) is in flight (for tests). */
export function isAutoSelectRunning(): boolean {
  return running;
}

/** True while the daily timer is armed (for tests). */
export function isAutoSelectScheduled(): boolean {
  return intervalHandle !== null;
}

/** Eligibility floor for a window: 80 % of its hourly slots must have been scored. */
export function minSamplesFor(windowDays: number): number {
  return Math.round(MIN_SAMPLES_SHARE * 24 * windowDays);
}

/**
 * Project a scoring entry onto the declared `StrategyScore` shape. The
 * scorer's entries also carry `sensor` and a `validationPredictions` array;
 * persisting them as-is leaked both into every run record and API response
 * (and spreading `best` into the prediction form once moved the active sensor).
 */
function toStrategyScore(entry: ValidationEntry | StrategyScore): StrategyScore {
  const { lookbackWeeks, dayFilter, aggregation, mae, rmse, mape, n, nSkipped } = entry;
  return { lookbackWeeks, dayFilter, aggregation, mae, rmse, mape, n, nSkipped };
}

function findSkipReason(settings: Settings, predConfig: PredictionConfig): string | null {
  if (predConfig.activeType !== 'historical') {
    return `active predictor is "${predConfig.activeType}", not historical`;
  }
  if (!predConfig.historicalPredictor?.sensor) {
    return 'no historical predictor configured';
  }
  if (predConfig.sensors.length === 0) {
    return 'no sensors configured';
  }
  const haUrl = settings.haUrl ?? '';
  const haToken = settings.haToken ?? '';
  if (!process.env.SUPERVISOR_TOKEN && !(haUrl.length > 0 && haToken.length > 0)) {
    return 'Home Assistant connection not configured';
  }
  return null;
}

function fmt(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(0);
}

function describeSelection(selection: SelectionResult, metric: 'mae' | 'rmse', incumbent: StrategyKey): string {
  const label = metric.toUpperCase();
  const best = selection.best ? `${formatStrategy(selection.best)} ${label} ${fmt(selection.best[metric])}` : 'none';
  const inc = `${formatStrategy(incumbent)} ${label} ${fmt(selection.incumbent?.[metric])}`;
  const delta = selection.improvement_percent == null ? '' : ` (${selection.improvement_percent.toFixed(1)} % better)`;
  return `${selection.reason}: best ${best}, current ${inc}${delta}`;
}

function emptyRun(at: string, trigger: AutoSelectTrigger, cfg: PredictionAutoSelectConfig, sensor: string | null): AutoSelectRun {
  return {
    at,
    trigger,
    sensor,
    windowDays: cfg.windowDays,
    metric: cfg.metric,
    mode: cfg.mode,
    minImprovement_percent: cfg.minImprovement_percent,
    incumbent: null,
    best: null,
    improvement_percent: null,
    reason: null,
    action: 'skipped',
    ranking: [],
  };
}

/**
 * Write the winning strategy into `historicalPredictor`.
 *
 * The config is re-read under the store's update lock and only the three
 * strategy fields are overlaid, so a UI edit that landed during the (long)
 * scoring phase — to the sensor list, PV config or predictor type — is not
 * reverted. Returns false without writing when the strategy that was scored
 * is no longer the active one (the user changed it mid-run) or, for a
 * timer-triggered run, when the selector was disabled or switched to suggest
 * mode while the run was in flight (`POST /settings` restarts the timer but
 * cannot cancel a run that is already scoring).
 */
async function applyStrategy(scored: HistoricalPredictor, best: StrategyKey, trigger: AutoSelectTrigger): Promise<boolean> {
  if (trigger !== 'manual') {
    const cfg = { ...DEFAULT_AUTO_SELECT_CONFIG, ...(await loadSettings()).predictionAutoSelect };
    if (!cfg.enabled || cfg.mode !== 'auto') {
      console.log('[auto-select] not applied — selector disabled or switched to suggest mode during the run');
      return false;
    }
  }
  let applied = false;
  await updatePredictionConfig(fresh => {
    const hp = fresh.historicalPredictor;
    if (fresh.activeType !== 'historical' || !hp || hp.sensor !== scored.sensor || !isSameStrategy(hp, scored)) {
      return null;
    }
    applied = true;
    return {
      ...fresh,
      historicalPredictor: { ...hp, lookbackWeeks: best.lookbackWeeks, dayFilter: best.dayFilter, aggregation: best.aggregation },
    };
  });
  if (!applied) console.log('[auto-select] not applied — the active predictor changed during the run');
  return applied;
}

/**
 * Score every strategy for the active sensor and decide. Always records a run
 * — including skips and failures — so the UI and the scheduler can see what
 * happened. Throws 409 when a run is already in flight, and rethrows run
 * errors after recording them. `enabled` only gates the timer — a manual run
 * always executes.
 */
export async function runAutoSelect(
  { apply = true, trigger = 'manual' }: { apply?: boolean; trigger?: AutoSelectTrigger } = {},
): Promise<AutoSelectRun> {
  if (running) throw new HttpError(409, 'Auto-select run already in progress');
  running = true;
  let base = emptyRun(new Date().toISOString(), trigger, DEFAULT_AUTO_SELECT_CONFIG, null);
  try {
    const [settings, predConfig] = await Promise.all([loadSettings(), loadPredictionConfig()]);
    const cfg: PredictionAutoSelectConfig = { ...DEFAULT_AUTO_SELECT_CONFIG, ...settings.predictionAutoSelect };
    base = emptyRun(base.at, trigger, cfg, predConfig.historicalPredictor?.sensor ?? null);

    const skipReason = findSkipReason(settings, predConfig);
    if (skipReason) {
      const record: AutoSelectRun = { ...base, skipReason };
      await appendAutoSelectRun(record);
      console.log(`[auto-select] skipped (${trigger}): ${skipReason}`);
      return record;
    }

    const hp = predConfig.historicalPredictor!;
    const incumbent: StrategyKey = { lookbackWeeks: hp.lookbackWeeks, dayFilter: hp.dayFilter, aggregation: hp.aggregation };
    const strategies: PredictConfig[] = generateAllConfigs([hp.sensor]);
    // Always score the incumbent explicitly, even when it sits outside the grid.
    if (!strategies.some(s => isSameStrategy(s, incumbent))) {
      strategies.push({ sensor: hp.sensor, ...incumbent });
    }

    const validationWindow = computeValidationWindow(cfg.windowDays);
    const runConfig = { ...predConfig, haUrl: settings.haUrl ?? '', haToken: settings.haToken ?? '' };
    const scores = await scoreStrategies(runConfig, strategies, validationWindow);

    const selection = selectStrategy(scores, incumbent, {
      metric: cfg.metric,
      minImprovement_percent: cfg.minImprovement_percent,
      minSamples: minSamplesFor(cfg.windowDays),
    });

    let action: AutoSelectAction = 'kept';
    if (selection.shouldSwitch) {
      action = cfg.mode === 'auto' && apply ? 'applied' : 'suggested';
    } else if (selection.reason === 'incumbent-unscored' && selection.best) {
      // No margin can be measured against an unscored incumbent, so this is
      // only ever offered, never applied (see selectStrategy).
      action = 'suggested';
    }

    if (action === 'applied') {
      const best = selection.best!;
      if (await applyStrategy(hp, best, trigger)) {
        console.log(`[auto-select] switched ${formatStrategy(incumbent)} → ${formatStrategy(best)} — ${describeSelection(selection, cfg.metric, incumbent)}`);
      } else {
        action = 'suggested';
      }
    }
    if (action !== 'applied') {
      console.log(`[auto-select] ${action} (${trigger}) — ${describeSelection(selection, cfg.metric, incumbent)}`);
    }

    const record: AutoSelectRun = {
      ...base,
      incumbent: selection.incumbent && toStrategyScore(selection.incumbent),
      best: selection.best && toStrategyScore(selection.best),
      improvement_percent: selection.improvement_percent,
      reason: selection.reason,
      action,
      ranking: selection.ranking.slice(0, RANKING_LIMIT).map(toStrategyScore),
    };
    await appendAutoSelectRun(record);
    return record;
  } catch (err) {
    // Persist the failure: otherwise a permanently broken selector (expired HA
    // token, recorder down) keeps showing its last *successful* outcome in the
    // UI forever, with the only signal a console line inside a container.
    const message = err instanceof Error ? err.message : String(err);
    await appendAutoSelectRun({ ...base, action: 'failed', error: message })
      .catch(storeErr => console.warn('[auto-select] Failed to record the failed run:', (storeErr as Error).message));
    throw err;
  } finally {
    running = false;
  }
}

async function latestRunOrNull(): Promise<AutoSelectRun | null> {
  try {
    return await getLatestAutoSelectRun();
  } catch (err) {
    console.warn('[auto-select] Failed to read run history:', (err as Error).message);
    return null;
  }
}

/** Runs the timer never repeat: a scheduled/catch-up attempt that did not fail. */
function isAutomaticAttempt(run: AutoSelectRun): boolean {
  return run.trigger !== 'manual' && run.action !== 'failed';
}

/** Runs that satisfy the boot catch-up: an automatic attempt that actually scored. */
function isCompletedAutomaticRun(run: AutoSelectRun): boolean {
  return isAutomaticAttempt(run) && run.action !== 'skipped';
}

/** True when the run completed (any outcome); false when it threw or was deferred behind a manual run. */
async function runScheduled(trigger: AutoSelectTrigger): Promise<boolean> {
  try {
    await runAutoSelect({ apply: true, trigger });
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) {
      console.log(`[auto-select] ${trigger} run deferred — a manual run is in flight`);
    } else {
      console.error(`[auto-select] ${trigger} run failed:`, (err as Error).message);
    }
    return false;
  }
}

async function tick(): Promise<void> {
  const gen = generation;
  const windowStart = findDailyWindowStart(new Date(), configTime, FIRE_WINDOW_MINUTES);
  if (!windowStart || firedWindowMs === windowStart.getTime()) return;

  // A restart inside the fire window must not repeat a run that already happened
  // for it. Manual runs earlier in the day do not count — they must not cancel
  // the scheduled run — and neither does a failed one, which is retried below.
  const latest = await latestRunOrNull();
  if (gen !== generation) return;
  if (latest && isAutomaticAttempt(latest) && new Date(latest.at).getTime() >= windowStart.getTime()) {
    firedWindowMs = windowStart.getTime();
    console.log('[auto-select] already ran today — skipping scheduled run');
    return;
  }

  // Only a completed run consumes the window. A failure, or a 409 from a manual
  // run in flight, is retried on the next tick until the window closes.
  if (await runScheduled('scheduled')) firedWindowMs = windowStart.getTime();
}

async function catchUp(): Promise<void> {
  const gen = generation;
  const latest = await latestRunOrNull();
  if (gen !== generation) return;
  if (latest && isCompletedAutomaticRun(latest) && Date.now() - new Date(latest.at).getTime() < CATCH_UP_AFTER_MS) return;
  console.log('[auto-select] no completed run in the last 24 h — running catch-up');
  await runScheduled('catch-up');
}

/**
 * Start the daily timer. Idempotent — stops any existing timer first.
 *
 * `runCatchUp` arms the post-boot catch-up and must only be set by the boot
 * path in `api/index.ts`. `POST /settings` restarts every timer service on each
 * save, so arming it here unconditionally would fire an unrequested run two
 * minutes after any settings save — in `auto` mode that is a live rewrite of
 * `historicalPredictor`, and the card's debounced per-keystroke save would
 * re-arm the fuse on every edit.
 */
export function startPredictionAutoSelect(
  settings: Settings,
  { runCatchUp = false }: { runCatchUp?: boolean } = {},
): void {
  stopPredictionAutoSelect();

  const cfg = settings.predictionAutoSelect;
  if (!cfg?.enabled) return;

  configTime = cfg.time ?? DEFAULT_AUTO_SELECT_CONFIG.time;

  console.log(`[auto-select] started (daily at ${configTime}, mode ${cfg.mode ?? DEFAULT_AUTO_SELECT_CONFIG.mode})`);

  intervalHandle = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  if (runCatchUp) {
    catchUpHandle = setTimeout(() => {
      catchUpHandle = null;
      void catchUp();
    }, BOOT_CATCH_UP_DELAY_MS);
  }
}

/**
 * Stop the daily timer if running. A tick or catch-up already suspended on I/O
 * notices the generation change and abandons its run.
 */
export function stopPredictionAutoSelect(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[auto-select] stopped');
  }
  if (catchUpHandle !== null) {
    clearTimeout(catchUpHandle);
    catchUpHandle = null;
  }
  generation++;
  // The persisted run history is the real "already ran today" guard (see tick);
  // the in-memory key only de-duplicates ticks within one armed timer.
  firedWindowMs = null;
}
