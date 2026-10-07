/**
 * Config construction for the solver-refresh gate (scripts/compare-highs-builds.ts).
 *
 * The gate must solve the LP production solves, so it builds the config through
 * the planner's own path — `preparePlanData` + `buildPlannerConfig` from
 * api/services/config-builder.ts (prediction adjustments → build → learned
 * charge taper → learned EV taper) — fed from snapshot files instead of the
 * local DATA_DIR:
 *
 * - data.json and settings.json (GET /data and GET /settings, or the files);
 *   data.json carries the stored prediction adjustments.
 * - optional calibration: the GET /plan-accuracy/calibration response
 *   (`{ calibration, evCalibration }`, which is the persisted CalibrationResult /
 *   EvCalibrationResult verbatim — exactly what applyCalibration consumes), or
 *   the DATA_DIR files calibration.json / ev-calibration.json.
 * - optional prediction adjustments: the GET /predictions/adjustments response
 *   (`{ adjustments }`) or a bare array; replaces data.json's own list.
 *
 * The local DATA_DIR calibration is never read: without a calibration snapshot
 * the gate solves uncalibrated and says so.
 */
import { buildPlannerConfig, preparePlanData, type CalibrationSources } from '../api/services/config-builder.ts';
import { validatePredictionAdjustment } from '../api/services/prediction-adjustments.ts';
import { resolveEvMode } from '../api/services/ev-mode.ts';
import type { SolverConfig } from '../lib/types.ts';
import type { CalibrationResult, Data, EvCalibrationResult, PredictionAdjustment, Settings } from '../api/types.ts';

export interface CalibrationSnapshot {
  calibration: CalibrationResult | null;
  evCalibration: EvCalibrationResult | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one calibration snapshot file: the GET /plan-accuracy/calibration
 * response, or a DATA_DIR calibration.json (battery) / ev-calibration.json (EV).
 */
export function parseCalibrationSnapshot(json: unknown, source = 'calibration snapshot'): CalibrationSnapshot {
  if (isObject(json)) {
    if (Array.isArray(json.chargeCurve)) return { calibration: json as unknown as CalibrationResult, evCalibration: null };
    if (Array.isArray(json.evChargeCurve)) return { calibration: null, evCalibration: json as unknown as EvCalibrationResult };
    if ('calibration' in json || 'evCalibration' in json) {
      return {
        calibration: (json.calibration ?? null) as CalibrationResult | null,
        evCalibration: (json.evCalibration ?? null) as EvCalibrationResult | null,
      };
    }
  }
  throw new Error(`${source}: not a GET /plan-accuracy/calibration response, calibration.json or ev-calibration.json`);
}

/** Combine several calibration files (e.g. calibration.json + ev-calibration.json); a later non-null part wins. */
export function mergeCalibrationSnapshots(parts: CalibrationSnapshot[]): CalibrationSnapshot {
  return parts.reduce<CalibrationSnapshot>((acc, part) => ({
    calibration: part.calibration ?? acc.calibration,
    evCalibration: part.evCalibration ?? acc.evCalibration,
  }), { calibration: null, evCalibration: null });
}

/** Read a prediction-adjustments snapshot: the GET /predictions/adjustments response or a bare array. */
export function parseAdjustmentsSnapshot(json: unknown, source = 'adjustments snapshot'): PredictionAdjustment[] {
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.adjustments) ? json.adjustments : null;
  if (!list) throw new Error(`${source}: not a GET /predictions/adjustments response or an array of adjustments`);
  for (const adjustment of list) {
    if (!isObject(adjustment)) throw new Error(`${source}: every adjustment must be an object`);
    validatePredictionAdjustment(adjustment as unknown as PredictionAdjustment);
  }
  return list as PredictionAdjustment[];
}

export interface GateConfigInput {
  settings: Settings;
  data: Data;
  startMs: number;
  /** Omitted: no calibration snapshot was given (the gate then runs uncalibrated). */
  calibration?: CalibrationSnapshot;
  /** Omitted: the adjustments stored in data.json are used, as production does. */
  adjustments?: PredictionAdjustment[];
}

export interface GateConfig {
  cfg: SolverConfig;
  /** What the config does and does not reproduce of production, one line each. */
  notes: string[];
  /** True when production would apply a calibration the gate could not (no snapshot given). */
  uncalibrated: boolean;
}

export async function buildGateConfig({ settings, data, startMs, calibration, adjustments }: GateConfigInput): Promise<GateConfig> {
  const notes: string[] = [];
  const snapshotData = adjustments ? { ...data, predictionAdjustments: adjustments } : data;
  const planData = preparePlanData(snapshotData, startMs);
  const activeAdjustments = planData.predictionAdjustments?.length ?? 0;
  notes.push(`prediction adjustments: ${activeAdjustments} active (from ${adjustments ? 'the adjustments snapshot' : 'data.json'})`);

  // Never fall back to the local DATA_DIR: a dev box's calibration.json is not production's.
  const sources: CalibrationSources = {
    loadCalibration: async () => calibration?.calibration ?? null,
    loadEvCalibration: async () => calibration?.evCalibration ?? null,
  };
  // No live EV state: a snapshot has no plug/SoC reading, so the EV is never in the plan.
  const cfg = await buildPlannerConfig(settings, planData, startMs, undefined, sources);

  const auto = !!settings.adaptiveLearning?.enabled && settings.adaptiveLearning.mode === 'auto';
  let uncalibrated = false;
  if (!auto) {
    notes.push('calibration: not applied (adaptive learning is not in auto mode, as in production)');
  } else if (!calibration) {
    uncalibrated = true;
    notes.push('WARNING: running UNCALIBRATED: adaptive learning is in auto mode but no calibration snapshot was given, '
      + 'so this is not the LP production solves (pass --calibration <GET /plan-accuracy/calibration response>)');
  } else if (!calibration.calibration) {
    notes.push('calibration: the snapshot has no battery calibration (production has none either), solving uncalibrated as production does');
  } else if (calibration.calibration.confidence < 0.5) {
    notes.push(`calibration: confidence ${calibration.calibration.confidence} < 0.5, not applied (as in production)`);
  } else {
    notes.push(`calibration: applied (confidence ${calibration.calibration.confidence}, ${calibration.calibration.sampleCount} samples, `
      + `${cfg.cvPhaseThresholds?.length ?? 0} charge thresholds in the LP)`);
  }
  if (resolveEvMode(settings) === 'native') {
    notes.push('EV: not planned (a snapshot has no live plug/SoC state; production plans the EV only while it is plugged in)');
  }
  if (cfg.rebalanceMaxStartSlot != null) {
    notes.push('rebalance: the hold is pinned to slot 0; if that LP is infeasible the planner runs a relaxation search the gate does not');
  }
  return { cfg, notes, uncalibrated };
}
