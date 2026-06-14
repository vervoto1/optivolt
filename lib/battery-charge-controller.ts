/**
 * Pure decision logic for the real-time charge-current limiter — a port of the
 * Home Assistant "Battery Charge Current State Machine (Improved)" automation.
 *
 * The controller walks a discrete ladder of charge-current levels (e.g.
 * [400, 180, 50, 0] A) driven by the live max cell voltage across the pack:
 *
 *  - **Emergency** (maxV > emergencyVoltage): drop straight to the lowest level
 *    (0 A), bypassing the stabilization dwell.
 *  - **Reduce** (maxV > reduceVoltage): step DOWN one rung immediately
 *    (reductions are a safety action and are never dwell-gated).
 *  - **Restore** (maxV < restoreVoltage): step UP one rung, but only once the
 *    stabilization dwell has elapsed (cautious recovery).
 *  - Otherwise hold (inside the hysteresis band reduce..restore).
 *
 * This module is pure: the service computes `dwellElapsed` from timestamps and
 * seeds `currentLevel` from the observed register, then this decides the target.
 */

export type BatteryChargeReason =
  | 'emergency'
  | 'reduce'
  | 'reduce_at_min'
  | 'restore'
  | 'restore_wait_dwell'
  | 'at_max'
  | 'hold';

/** The subset of BatteryChargeControlConfig the pure decider needs. */
export interface BatteryChargePolicy {
  emergencyVoltage: number;
  reduceVoltage: number;
  restoreVoltage: number;
  /** Discrete current levels (A); the decider sorts a defensive copy descending. */
  currentLevels: number[];
}

export interface BatteryChargeInput {
  /** Live max cell voltage across the pack (V). */
  maxCellVoltage: number;
  /** Last commanded charge-current level (A). */
  currentLevel: number;
  /** Whether `stabilizationSeconds` has elapsed since the last level change. */
  dwellElapsed: boolean;
}

export interface BatteryChargeDecision {
  /** Target charge-current level to command (A). */
  level: number;
  /** Index of the target level within the (descending) ladder. */
  levelIndex: number;
  reason: BatteryChargeReason;
  /** True when the change bypasses the dwell (emergency or reduction). */
  forced: boolean;
  /** True when `level` differs from the input `currentLevel`. */
  changed: boolean;
}

/** Descending, deduped ladder. Falls back to [0] if empty so callers never crash. */
function ladder(levels: number[]): number[] {
  const sorted = [...new Set(levels.filter(v => Number.isFinite(v)))].sort((a, b) => b - a);
  return sorted.length > 0 ? sorted : [0];
}

/**
 * Map a measured/commanded current (A) to the nearest rung on the ladder.
 * Used by the service to seed the state from the observed register value.
 */
export function nearestLevelIndex(levels: number[], measuredA: number): number {
  const rungs = ladder(levels);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rungs.length; i++) {
    const dist = Math.abs(rungs[i] - measuredA);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function decideBatteryChargeLevel(
  input: BatteryChargeInput,
  policy: BatteryChargePolicy,
): BatteryChargeDecision {
  const rungs = ladder(policy.currentLevels);
  const lastIdx = rungs.length - 1;
  const idx = nearestLevelIndex(rungs, input.currentLevel);
  const v = input.maxCellVoltage;

  const make = (levelIndex: number, reason: BatteryChargeReason, forced: boolean): BatteryChargeDecision => ({
    level: rungs[levelIndex],
    levelIndex,
    reason,
    forced,
    changed: rungs[levelIndex] !== input.currentLevel,
  });

  // Emergency: straight to the lowest level (0 A), ignoring dwell.
  if (v > policy.emergencyVoltage) {
    return make(lastIdx, 'emergency', true);
  }

  // Reduce: step down one rung immediately (safety — never dwell-gated).
  if (v > policy.reduceVoltage) {
    return idx < lastIdx ? make(idx + 1, 'reduce', true) : make(idx, 'reduce_at_min', true);
  }

  // Restore: step up one rung, gated by the stabilization dwell.
  if (v < policy.restoreVoltage) {
    if (idx <= 0) return make(0, 'at_max', false);
    return input.dwellElapsed ? make(idx - 1, 'restore', false) : make(idx, 'restore_wait_dwell', false);
  }

  // Inside the hysteresis band: hold.
  return make(idx, 'hold', false);
}
