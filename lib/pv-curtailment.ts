import type { PlanRow, SolverConfig } from './types.ts';

export type PvCurtailmentReason =
  | 'disabled'
  | 'no_plan'
  | 'no_current_slot'
  | 'price_not_negative'
  | 'no_expected_pv'
  | 'planned_pv_curtailment'
  | 'insufficient_current_grid_headroom'
  | 'insufficient_remaining_grid_headroom'
  | 'negative_price_grid_headroom';

export interface PvCurtailmentPolicy {
  enabled: boolean;
  negativePriceThreshold_cents_per_kWh: number;
  minPvPowerW: number;
  minGridHeadroomW: number;
}

export interface PvCurtailmentDecision {
  shouldDisable: boolean;
  reason: PvCurtailmentReason;
  currentIndex: number | null;
  negativeBlockEndIndex: number | null;
  currentPv_W: number;
  currentPvCurtail_W: number;
  currentGridImport_W: number;
  currentGridHeadroom_W: number;
  remainingPv_Wh: number;
  remainingGridHeadroom_Wh: number;
}

export interface PvCurtailmentSlot {
  disable: boolean;
  reason: PvCurtailmentReason;
  currentGridHeadroom_W: number;
  remainingPv_Wh: number;
  remainingGridHeadroom_Wh: number;
}

const DEFAULT_POLICY: PvCurtailmentPolicy = {
  enabled: false,
  negativePriceThreshold_cents_per_kWh: 0,
  minPvPowerW: 100,
  minGridHeadroomW: 100,
};

const FLOW_TOLERANCE_W = 25;
const ENERGY_TOLERANCE_WH = 25;

export function normalizePvCurtailmentPolicy(policy?: Partial<PvCurtailmentPolicy>): PvCurtailmentPolicy {
  return {
    enabled: policy?.enabled ?? DEFAULT_POLICY.enabled,
    negativePriceThreshold_cents_per_kWh:
      Number.isFinite(policy?.negativePriceThreshold_cents_per_kWh)
        ? Number(policy?.negativePriceThreshold_cents_per_kWh)
        : DEFAULT_POLICY.negativePriceThreshold_cents_per_kWh,
    minPvPowerW: Math.max(0, Math.round(
      Number.isFinite(policy?.minPvPowerW) ? Number(policy?.minPvPowerW) : DEFAULT_POLICY.minPvPowerW,
    )),
    minGridHeadroomW: Math.max(0, Math.round(
      Number.isFinite(policy?.minGridHeadroomW) ? Number(policy?.minGridHeadroomW) : DEFAULT_POLICY.minGridHeadroomW,
    )),
  };
}

export function decidePvCurtailment(
  rows: PlanRow[],
  cfg: Pick<SolverConfig, 'stepSize_m' | 'maxGridImport_W'>,
  nowMs: number,
  policyInput?: Partial<PvCurtailmentPolicy>,
): PvCurtailmentDecision {
  const policy = normalizePvCurtailmentPolicy(policyInput);
  const empty = (reason: PvCurtailmentReason, currentIndex: number | null = null): PvCurtailmentDecision => ({
    shouldDisable: false,
    reason,
    currentIndex,
    negativeBlockEndIndex: null,
    currentPv_W: 0,
    currentPvCurtail_W: 0,
    currentGridImport_W: 0,
    currentGridHeadroom_W: 0,
    remainingPv_Wh: 0,
    remainingGridHeadroom_Wh: 0,
  });

  if (!policy.enabled) return empty('disabled');
  if (rows.length === 0) return empty('no_plan');

  const stepMs = Math.max(1, cfg.stepSize_m) * 60_000;
  const currentIndex = rows.findIndex(row => nowMs >= row.timestampMs && nowMs < row.timestampMs + stepMs);
  if (currentIndex < 0) return empty('no_current_slot');

  const row = rows[currentIndex];
  const currentPv_W = Math.max(0, Number(row.pv) || 0);
  const currentPvCurtail_W = Math.max(0, Number(row.pvCurtail) || 0);
  const currentPvToReplace_W = Math.max(0, currentPv_W - currentPvCurtail_W);
  const currentGridImport_W = Math.max(0, Number(row.imp) || 0);
  const currentGridHeadroom_W = Math.max(0, cfg.maxGridImport_W - currentGridImport_W);

  const base = (reason: PvCurtailmentReason, shouldDisable = false, blockEndIndex: number | null = null): PvCurtailmentDecision => ({
    shouldDisable,
    reason,
    currentIndex,
    negativeBlockEndIndex: blockEndIndex,
    currentPv_W,
    currentPvCurtail_W,
    currentGridImport_W,
    currentGridHeadroom_W,
    remainingPv_Wh: 0,
    remainingGridHeadroom_Wh: 0,
  });

  if (!isNegativePrice(row, policy)) return base('price_not_negative');
  if (currentPv_W < policy.minPvPowerW) return base('no_expected_pv');

  const negativeBlockEndIndex = findNegativeBlockEnd(rows, currentIndex, policy);
  const remaining = computeRemainingEnergy(rows, currentIndex, negativeBlockEndIndex, cfg, policy, nowMs);

  const withEnergy = (reason: PvCurtailmentReason, shouldDisable = false): PvCurtailmentDecision => ({
    ...base(reason, shouldDisable, negativeBlockEndIndex),
    remainingPv_Wh: remaining.remainingPv_Wh,
    remainingGridHeadroom_Wh: remaining.remainingGridHeadroom_Wh,
  });

  if (currentPvCurtail_W >= Math.max(policy.minPvPowerW, currentPv_W - FLOW_TOLERANCE_W)) {
    return withEnergy('planned_pv_curtailment', true);
  }

  if (currentGridHeadroom_W + FLOW_TOLERANCE_W < Math.max(policy.minGridHeadroomW, currentPvToReplace_W)) {
    return withEnergy('insufficient_current_grid_headroom');
  }

  if (
    remaining.hasInsufficientSlotHeadroom
    || remaining.remainingGridHeadroom_Wh + ENERGY_TOLERANCE_WH < remaining.remainingPv_Wh
  ) {
    return withEnergy('insufficient_remaining_grid_headroom');
  }

  return withEnergy('negative_price_grid_headroom', true);
}

export function annotatePvCurtailmentSlots(
  rows: PlanRow[],
  cfg: Pick<SolverConfig, 'stepSize_m' | 'maxGridImport_W'>,
  policyInput?: Partial<PvCurtailmentPolicy>,
): PvCurtailmentSlot[] {
  return rows.map(row => {
    const decision = decidePvCurtailment(rows, cfg, row.timestampMs, policyInput);
    return {
      disable: decision.shouldDisable,
      reason: decision.reason,
      currentGridHeadroom_W: decision.currentGridHeadroom_W,
      remainingPv_Wh: decision.remainingPv_Wh,
      remainingGridHeadroom_Wh: decision.remainingGridHeadroom_Wh,
    };
  });
}

function isNegativePrice(row: PlanRow, policy: PvCurtailmentPolicy): boolean {
  return row.ic < policy.negativePriceThreshold_cents_per_kWh;
}

function findNegativeBlockEnd(rows: PlanRow[], startIndex: number, policy: PvCurtailmentPolicy): number {
  let endIndex = startIndex;
  for (let i = startIndex + 1; i < rows.length; i += 1) {
    if (!isNegativePrice(rows[i], policy)) break;
    endIndex = i;
  }
  return endIndex;
}

function computeRemainingEnergy(
  rows: PlanRow[],
  startIndex: number,
  endIndex: number,
  cfg: Pick<SolverConfig, 'stepSize_m' | 'maxGridImport_W'>,
  policy: PvCurtailmentPolicy,
  nowMs: number,
): { remainingPv_Wh: number; remainingGridHeadroom_Wh: number; hasInsufficientSlotHeadroom: boolean } {
  const stepHours = Math.max(1, cfg.stepSize_m) / 60;
  const stepMs = Math.max(1, cfg.stepSize_m) * 60_000;
  let remainingPv_Wh = 0;
  let remainingGridHeadroom_Wh = 0;
  let hasInsufficientSlotHeadroom = false;

  for (let i = startIndex; i <= endIndex; i += 1) {
    const row = rows[i];
    const slotPv_W = Math.max(0, Number(row.pv) || 0);
    const slotPvCurtail_W = Math.max(0, Number(row.pvCurtail) || 0);
    const slotPvToReplace_W = Math.max(0, slotPv_W - slotPvCurtail_W);
    const slotGridHeadroom_W = Math.max(0, cfg.maxGridImport_W - (Number(row.imp) || 0));
    const fractionRemaining = i === startIndex
      ? clamp((row.timestampMs + stepMs - nowMs) / stepMs, 0, 1)
      : 1;

    remainingPv_Wh += slotPvToReplace_W * stepHours * fractionRemaining;
    remainingGridHeadroom_Wh += slotGridHeadroom_W * stepHours * fractionRemaining;

    if (
      slotPvToReplace_W > FLOW_TOLERANCE_W
      && slotGridHeadroom_W + FLOW_TOLERANCE_W < Math.max(policy.minGridHeadroomW, slotPvToReplace_W)
    ) {
      hasInsufficientSlotHeadroom = true;
    }
  }

  return { remainingPv_Wh, remainingGridHeadroom_Wh, hasInsufficientSlotHeadroom };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
