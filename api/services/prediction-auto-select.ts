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
import { loadPredictionConfig, savePredictionConfig } from './prediction-config-store.ts';
import { scoreStrategies } from './load-prediction-service.ts';
import type { ValidationWindow } from './load-prediction-service.ts';
import { appendAutoSelectRun, getLatestAutoSelectRun } from './prediction-auto-select-store.ts';
import { generateAllConfigs } from '../../lib/load-predictor-historical.ts';
import type { PredictConfig } from '../../lib/load-predictor-historical.ts';
import { formatStrategy, isSameStrategy, selectStrategy } from '../../lib/strategy-selector.ts';
import type { SelectionResult, StrategyKey } from '../../lib/strategy-selector.ts';

const CHECK_INTERVAL_MS = 60_000;
/** The scheduled run fires once inside [time, time + this) — wide enough to survive a slow tick. */
const FIRE_WINDOW_MINUTES = 5;
/** Delay after boot before the catch-up check, so startup I/O settles first. */
const BOOT_CATCH_UP_DELAY_MS = 2 * 60_000;
const CATCH_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Scored points required for eligibility, as a share of the window's hourly slots. */
const MIN_SAMPLES_SHARE = 0.8;
/** Ranking entries kept in the persisted run record. */
const RANKING_LIMIT = 10;

export const DEFAULT_AUTO_SELECT_CONFIG: PredictionAutoSelectConfig = {
  enabled: false,
  mode: 'suggest',
  time: '03:30',
  metric: 'mae',
  minImprovement_percent: 10,
  windowDays: 28,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let catchUpHandle: ReturnType<typeof setTimeout> | null = null;
let configEnabled = false;
let configTime = '';
let lastRunDayKey: string | null = null;
let running = false;

/** True while a run (scheduled or manual) is in flight. */
export function isAutoSelectRunning(): boolean {
  return running;
}

/** True while the daily timer is armed (for tests). */
export function isAutoSelectScheduled(): boolean {
  return intervalHandle !== null;
}

/**
 * The previous `windowDays` full UTC days, ending at today's UTC midnight —
 * the same construction `loadPredictionConfig()` uses for its 7-day window.
 */
export function computeValidationWindow(windowDays: number, nowMs: number = Date.now()): ValidationWindow {
  const now = new Date(nowMs);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(end - windowDays * DAY_MS).toISOString(),
    end: new Date(end).toISOString(),
  };
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** True when the local time is inside [time, time + FIRE_WINDOW_MINUTES). */
function isInFireWindow(now: Date, time: string): boolean {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const startMinutes = h * 60 + m;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= startMinutes && nowMinutes < startMinutes + FIRE_WINDOW_MINUTES;
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
  const delta = selection.improvement_percent == null ? '' : ` (${selection.improvement_percent > 0 ? '−' : ''}${Math.abs(selection.improvement_percent).toFixed(1)} %)`;
  return `${selection.reason}: best ${best}, current ${inc}${delta}`;
}

/**
 * Score every strategy for the active sensor and decide. Always records a run
 * (including skips) so the UI and the catch-up logic can see what happened.
 * Throws 409 when a run is already in flight. `enabled` only gates the timer —
 * a manual run always executes.
 */
export async function runAutoSelect(
  { apply = true, trigger = 'manual' }: { apply?: boolean; trigger?: AutoSelectTrigger } = {},
): Promise<AutoSelectRun> {
  if (running) throw new HttpError(409, 'Auto-select run already in progress');
  running = true;
  try {
    const [settings, predConfig] = await Promise.all([loadSettings(), loadPredictionConfig()]);
    const cfg: PredictionAutoSelectConfig = { ...DEFAULT_AUTO_SELECT_CONFIG, ...settings.predictionAutoSelect };

    const base: AutoSelectRun = {
      at: new Date().toISOString(),
      trigger,
      sensor: predConfig.historicalPredictor?.sensor ?? null,
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
      minSamples: Math.round(MIN_SAMPLES_SHARE * 24 * cfg.windowDays),
    });

    let action: AutoSelectAction = 'kept';
    if (selection.shouldSwitch) {
      action = cfg.mode === 'auto' && apply ? 'applied' : 'suggested';
    }

    if (action === 'applied') {
      const best = selection.best!;
      await savePredictionConfig({
        ...predConfig,
        historicalPredictor: {
          ...hp,
          lookbackWeeks: best.lookbackWeeks,
          dayFilter: best.dayFilter,
          aggregation: best.aggregation,
        },
      });
      console.log(`[auto-select] switched ${formatStrategy(incumbent)} → ${formatStrategy(best)} — ${describeSelection(selection, cfg.metric, incumbent)}`);
    } else {
      console.log(`[auto-select] ${action} (${trigger}) — ${describeSelection(selection, cfg.metric, incumbent)}`);
    }

    const record: AutoSelectRun = {
      ...base,
      incumbent: selection.incumbent,
      best: selection.best,
      improvement_percent: selection.improvement_percent,
      reason: selection.reason,
      action,
      ranking: selection.ranking.slice(0, RANKING_LIMIT),
    };
    await appendAutoSelectRun(record);
    return record;
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

async function runScheduled(trigger: AutoSelectTrigger): Promise<void> {
  try {
    await runAutoSelect({ apply: true, trigger });
  } catch (err) {
    console.error(`[auto-select] ${trigger} run failed:`, (err as Error).message);
  }
}

async function tick(): Promise<void> {
  /* v8 ignore next 2 — configEnabled is set before the interval is armed and
  stop() clears the interval, so a tick never observes it false */
  if (!configEnabled) return;
  const now = new Date();
  const dayKey = localDayKey(now);
  if (!isInFireWindow(now, configTime) || lastRunDayKey === dayKey) return;
  lastRunDayKey = dayKey;

  // A restart inside the fire window must not repeat a run that already happened today.
  const latest = await latestRunOrNull();
  if (latest && localDayKey(new Date(latest.at)) === dayKey) {
    console.log('[auto-select] already ran today — skipping scheduled run');
    return;
  }
  await runScheduled('scheduled');
}

async function catchUp(): Promise<void> {
  /* v8 ignore next 2 — same as tick(): stop() cancels the pending catch-up */
  if (!configEnabled) return;
  const latest = await latestRunOrNull();
  if (latest && Date.now() - new Date(latest.at).getTime() < CATCH_UP_AFTER_MS) return;
  console.log('[auto-select] no run in the last 24 h — running catch-up');
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

  configEnabled = true;
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
 * Stop the daily timer if running.
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
  configEnabled = false;
  // The persisted run history is the real "already ran today" guard (see tick);
  // the in-memory key only de-duplicates ticks within one armed timer.
  lastRunDayKey = null;
}
