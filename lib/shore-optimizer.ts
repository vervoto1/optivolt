export const MppOperationMode = {
  off: 0,
  voltageCurrentLimited: 1,
  mpptActive: 2,
  notAvailable: 255,
} as const;

export type MppOperationModeId =
  | 'off'
  | 'voltage_current_limited'
  | 'mppt_active'
  | 'not_available'
  | 'unknown';

export type ShoreOptimizerSlotMode = 'grid_charge' | 'discharge' | 'idle' | 'unknown';

export interface MppOperationModeState {
  id: MppOperationModeId;
  display: string;
  rawValue: unknown;
}

export interface ShoreOptimizerDecisionConfig {
  stepA: number;
  minShoreA: number;
  maxShoreA: number;
  minChargingPowerW: number;
}

export interface ShoreOptimizerDecisionInput {
  enabled: boolean;
  stateFresh: boolean;
  gateOnDessSchedule: boolean;
  slotMode: ShoreOptimizerSlotMode;
  currentShoreA: number | null;
  batteryPowerW: number | null;
  mppOperationMode: unknown;
  config: ShoreOptimizerDecisionConfig;
}

export type ShoreOptimizerBlockReason =
  | 'disabled'
  | 'stale_state'
  | 'missing_current_shore'
  | 'battery_not_charging'
  | 'dess_not_grid_charge'
  | 'mppt_idle'
  | 'unchanged';

export interface ShoreOptimizerDecision {
  shouldWrite: boolean;
  reason?: ShoreOptimizerBlockReason;
  oldA: number | null;
  newA: number | null;
  mpptState: MppOperationModeState;
}

const ABSOLUTE_MAX_SHORE_A = 25;
const DEFAULT_STEP_A = 0.5;
const CURRENT_STEP_A = 0.1;

export function normalizeMppOperationMode(value: unknown): MppOperationModeState {
  const rawValue = value;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  const numeric = typeof normalized === 'number'
    ? normalized
    : typeof normalized === 'string' && normalized !== ''
      ? Number(normalized)
      : NaN;

  if (numeric === MppOperationMode.off || normalized === 'off') {
    return { id: 'off', display: 'Off', rawValue };
  }
  if (
    numeric === MppOperationMode.voltageCurrentLimited
    || normalized === 'voltage_current_limited'
    || normalized === 'voltage/current limited'
  ) {
    return { id: 'voltage_current_limited', display: 'Voltage/current limited', rawValue };
  }
  if (
    numeric === MppOperationMode.mpptActive
    || normalized === 'mppt_active'
    || normalized === 'mppt active'
  ) {
    return { id: 'mppt_active', display: 'MPPT active', rawValue };
  }
  if (numeric === MppOperationMode.notAvailable || normalized === 'not_available') {
    return { id: 'not_available', display: 'Not available', rawValue };
  }

  return { id: 'unknown', display: 'Unknown', rawValue };
}

export function decideShoreCurrent(input: ShoreOptimizerDecisionInput): ShoreOptimizerDecision {
  const mpptState = normalizeMppOperationMode(input.mppOperationMode);
  const oldA = Number.isFinite(input.currentShoreA) ? Number(input.currentShoreA) : null;

  if (!input.enabled) {
    return blocked('disabled', oldA, mpptState);
  }
  if (!input.stateFresh) {
    return blocked('stale_state', oldA, mpptState);
  }
  if (oldA == null) {
    return blocked('missing_current_shore', oldA, mpptState);
  }

  const minChargingPowerW = finiteOr(input.config.minChargingPowerW, 0);
  if (!Number.isFinite(input.batteryPowerW) || Number(input.batteryPowerW) < minChargingPowerW) {
    return blocked('battery_not_charging', oldA, mpptState);
  }

  if (input.gateOnDessSchedule && input.slotMode !== 'grid_charge') {
    return blocked('dess_not_grid_charge', oldA, mpptState);
  }

  if (mpptState.id !== 'voltage_current_limited' && mpptState.id !== 'mppt_active') {
    return blocked('mppt_idle', oldA, mpptState);
  }

  const limits = normalizeShoreLimits(input.config);
  const direction = mpptState.id === 'voltage_current_limited' ? -1 : 1;
  const candidate = roundToCurrentStep(oldA + direction * limits.stepA);
  const newA = clamp(candidate, limits.minShoreA, limits.maxShoreA);

  if (Math.abs(newA - oldA) < 0.000001) {
    return blocked('unchanged', oldA, mpptState, newA);
  }

  return { shouldWrite: true, oldA, newA, mpptState };
}

function normalizeShoreLimits(config: ShoreOptimizerDecisionConfig): {
  stepA: number;
  minShoreA: number;
  maxShoreA: number;
} {
  let minShoreA = clamp(finiteOr(config.minShoreA, 0), 0, ABSOLUTE_MAX_SHORE_A);
  let maxShoreA = clamp(finiteOr(config.maxShoreA, ABSOLUTE_MAX_SHORE_A), 0, ABSOLUTE_MAX_SHORE_A);
  if (maxShoreA < minShoreA) {
    [minShoreA, maxShoreA] = [maxShoreA, minShoreA];
  }

  return {
    stepA: Math.max(CURRENT_STEP_A, finiteOr(config.stepA, DEFAULT_STEP_A)),
    minShoreA,
    maxShoreA,
  };
}

function blocked(
  reason: ShoreOptimizerBlockReason,
  oldA: number | null,
  mpptState: MppOperationModeState,
  newA: number | null = null,
): ShoreOptimizerDecision {
  return { shouldWrite: false, reason, oldA, newA, mpptState };
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToCurrentStep(value: number): number {
  return Number((Math.round(value / CURRENT_STEP_A) * CURRENT_STEP_A).toFixed(1));
}
