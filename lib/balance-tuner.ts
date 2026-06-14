/**
 * Pure decision logic for the per-BMS adaptive balancer-threshold tuner — a port
 * of the Home Assistant `periodic_balance_check` automation.
 *
 * For one BMS, given its live max cell voltage and pack current, it computes the
 * balance START voltage (the cell voltage above which the BMS balances) and the
 * TRIGGER delta (the inter-cell spread above which balancing kicks in):
 *
 *  - **High current**: while charging/discharging hard, back off — fixed high
 *    start (topCap) + loose trigger so balancing doesn't fight a high-current pass.
 *  - **Top region** (v ≥ topStart): aggressive top balancing — start tracks the
 *    voltage in `step` increments (capped at topCap, and at the value implied by
 *    `criticalHighVoltage`), with the tight trigger.
 *  - **Transition** (bottomTop ≤ v < topStart): fixed start at bottomTop, loose trigger.
 *  - **Bottom** (v < bottomTop): start tracks the voltage down to bottomFloor in
 *    `step` increments, loose trigger.
 *
 * `warning` flags an out-of-range cell voltage (below floor or above the warn cap).
 * This module is pure; the service does the per-battery HA reads/writes.
 */

export type BalanceReason =
  | 'high_current'
  | 'critical_high'
  | 'top'
  | 'transition'
  | 'bottom';

/** The subset of BatteryBalanceControlConfig the pure decider needs. */
export interface BalancePolicy {
  highCurrentThreshold_A: number;
  tightTrigger: number;
  looseTrigger: number;
  step: number;
  topCap: number;
  criticalHighVoltage: number;
  topStart: number;
  bottomTop: number;
  bottomFloor: number;
  maxWarnVoltage: number;
}

export interface BalanceDecision {
  /** Balance start voltage to write (V), rounded to mV. */
  startVoltage: number;
  /** Balance trigger/delta voltage to write (V). */
  triggerVoltage: number;
  reason: BalanceReason;
  /** True when the cell voltage is outside [bottomFloor, maxWarnVoltage]. */
  warning: boolean;
}

const FLOOR_EPS = 1e-6; // guards Math.floor against float dust at step boundaries

/** Quantize `v` to the grid `base + k*step` (k ≥ 0), not exceeding `cap`. */
function steppedVoltage(v: number, base: number, step: number, cap: number): number {
  if (step <= 0) return Math.min(cap, Math.max(base, v));
  const steps = Math.max(0, Math.floor((v - base) / step + FLOOR_EPS));
  return Math.min(cap, base + steps * step);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function decideBalanceSettings(
  maxCellVoltage: number,
  currentA: number,
  policy: BalancePolicy,
): BalanceDecision {
  const warning = maxCellVoltage < policy.bottomFloor || maxCellVoltage > policy.maxWarnVoltage;

  // High current overrides the voltage logic: back off to a high start + loose trigger.
  if (Math.abs(currentA) > policy.highCurrentThreshold_A) {
    return { startVoltage: round2(policy.topCap), triggerVoltage: policy.looseTrigger, reason: 'high_current', warning };
  }

  const v = maxCellVoltage;

  if (v >= policy.topStart) {
    // Clamp the working voltage to the critical-high ceiling so the start never
    // climbs past the level that ceiling implies (mirrors the HA critical-high pin).
    const vEff = Math.min(v, policy.criticalHighVoltage);
    const start = steppedVoltage(vEff, policy.topStart, policy.step, policy.topCap);
    return {
      startVoltage: round2(start),
      triggerVoltage: policy.tightTrigger,
      reason: v > policy.criticalHighVoltage ? 'critical_high' : 'top',
      warning,
    };
  }

  if (v >= policy.bottomTop) {
    return { startVoltage: round2(policy.bottomTop), triggerVoltage: policy.looseTrigger, reason: 'transition', warning };
  }

  // Bottom region: track down to the floor in `step` increments.
  const start = steppedVoltage(v, policy.bottomFloor, policy.step, policy.topCap);
  return { startVoltage: round2(start), triggerVoltage: policy.looseTrigger, reason: 'bottom', warning };
}
