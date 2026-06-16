import type { Settings } from '../types.ts';
import type { PlanRow } from '../../lib/types.ts';
import { evChargeWattsPerAmp } from '../../lib/build-lp.ts';
import { fetchHaEntityState } from './ha-client.ts';
import { resolveEvMode } from './ev-mode.ts';
import { resolveDepartureMs } from './ev-departure.ts';

/**
 * Effective live EV mode. Reactive overrides (low_soc/low_price/min_soc/keep_on)
 * take priority over the day-ahead plan; otherwise the planned label flows
 * through. Separate from the LP's EvPlanMode and the hardware EvChargeMode.
 */
export type EvDecisionMode =
  | 'low_soc'
  | 'low_price'
  | 'min_soc'
  | 'opportunistic'
  | 'planned'
  | 'keep_on'
  | 'idle';

export interface EvDecision {
  mode: EvDecisionMode;
  is_charging: boolean;
  ev_charge_W: number;
  ev_charge_A: number;
  reason: string;
  liveSoc_percent: number | null;
  currentPrice_cents_per_kWh: number | null;
  plugConnected: boolean | null; // null = uncertain (sensor unavailable/unknown)
  targetSoc_percent: number;
  targetMet: boolean | null;
  readyBy: string | null;
  planSlotTimestampMs: number | null;
}

/** Minimal shape of the cached plan used by the decision layer. */
export interface LastPlanLike {
  rows: PlanRow[];
  timing: { startMs: number; stepMin: number };
}

/** Find the plan row covering `nowMs` (last row whose timestamp is ≤ now). */
function currentRow(rows: PlanRow[], nowMs: number): PlanRow | null {
  if (rows.length === 0) return null;
  let row = rows[0];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].timestampMs <= nowMs) { row = rows[i]; break; }
  }
  return row;
}

/**
 * Interpret a plug/connection sensor state.
 *   true  — definitely connected
 *   false — definitely not connected
 *   null  — uncertain (unavailable/unknown) → callers must not assume "off"
 */
function interpretPlug(state: string | undefined): boolean | null {
  if (state == null) return null;
  const s = state.trim().toLowerCase();
  if (s === 'unavailable' || s === 'unknown' || s === '') return null;
  if (s === 'disconnected' || s === 'off' || s === 'false' || s === 'not_connected' || s === 'no') {
    return false;
  }
  return true;
}

/**
 * Compute the effective current EV charging decision, overlaying live reactive
 * overrides on the day-ahead plan. Priority:
 *   low_soc > low_price > min_soc floor > planned/opportunistic > keep_on > idle
 *
 * Reads live EV SoC + plug status from HA (best-effort: HA failures fall back to
 * the plan). The current buy price is taken from the plan row covering now.
 * Overrides apply only in native EV mode.
 */
export async function computeEvDecision(
  settings: Settings,
  lastPlan: LastPlanLike | undefined,
  nowMs: number = Date.now(),
): Promise<EvDecision> {
  const wattsPerAmp = evChargeWattsPerAmp(settings.evChargePhases);
  const maxA = settings.evMaxChargeCurrent_A;
  const minA = settings.evMinChargeCurrent_A;
  const maxW = maxA * wattsPerAmp;
  const minW = minA * wattsPerAmp;
  const targetSoc = settings.evTargetSoc_percent;
  // Resolve the wall-clock "ready by" time-of-day + today/tomorrow selector to an
  // absolute instant relative to now (null when unset). Surfaced as ISO metadata
  // and used by the keep-on window check below.
  const departureMs = resolveDepartureMs(settings.evDepartureTime, settings.evDepartureDay, nowMs);
  const readyBy = departureMs != null ? new Date(departureMs).toISOString() : null;
  const isNative = resolveEvMode(settings) === 'native';

  const row = lastPlan ? currentRow(lastPlan.rows, nowMs) : null;
  const currentPrice = row ? row.ic : null;
  const planSlotTimestampMs = row ? row.timestampMs : null;

  // Departure-slot target-met flag, if present in the plan.
  const targetMet = lastPlan
    ? (lastPlan.rows.find(r => r.ev_target_met != null)?.ev_target_met ?? null)
    : null;

  // Live HA reads (best-effort).
  let liveSoc: number | null = null;
  let plugConnected: boolean | null = null;
  if (settings.haUrl || process.env.SUPERVISOR_TOKEN) {
    if (settings.evSocSensor) {
      try {
        const s = await fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evSocSensor });
        const v = parseFloat(s.state);
        if (Number.isFinite(v)) liveSoc = v;
      } catch { /* HA unavailable → fall back to plan */ }
    }
    if (settings.evPlugSensor) {
      try {
        const p = await fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evPlugSensor });
        plugConnected = interpretPlug(p.state);
      } catch { plugConnected = null; }
    }
  }

  const base = {
    liveSoc_percent: liveSoc,
    currentPrice_cents_per_kWh: currentPrice,
    plugConnected,
    targetSoc_percent: targetSoc,
    targetMet,
    readyBy,
    planSlotTimestampMs,
  };

  const charge = (mode: EvDecisionMode, w: number, a: number, reason: string): EvDecision => ({
    mode, is_charging: w > 0, ev_charge_W: w, ev_charge_A: a, reason, ...base,
  });

  // A definitely-not-connected car can't charge.
  if (plugConnected === false) {
    return charge('idle', 0, 0, 'EV not connected');
  }

  if (isNative) {
    // 1. Low-SoC override (highest priority): charge now regardless of price.
    if (settings.evLowSocChargingEnabled
        && Number.isFinite(settings.evLowSocChargingLevel_percent)
        && liveSoc != null && liveSoc < (settings.evLowSocChargingLevel_percent as number)) {
      return charge('low_soc', maxW, maxA, `Live SoC ${liveSoc}% below low-SoC level ${settings.evLowSocChargingLevel_percent}%`);
    }
    // 2. Low-price override: charge now when the live price is at/below the level.
    if (settings.evLowPriceChargingEnabled
        && Number.isFinite(settings.evLowPriceChargingLevel_cents_per_kWh)
        && currentPrice != null && currentPrice <= (settings.evLowPriceChargingLevel_cents_per_kWh as number)) {
      return charge('low_price', maxW, maxA, `Price ${currentPrice} c€/kWh at/below low-price level ${settings.evLowPriceChargingLevel_cents_per_kWh}`);
    }
    // 3. Minimum-SoC floor: bring the car up to the safety floor ASAP.
    if (Number.isFinite(settings.evMinSoc_percent) && (settings.evMinSoc_percent as number) > 0
        && liveSoc != null && liveSoc < (settings.evMinSoc_percent as number)) {
      return charge('min_soc', maxW, maxA, `Live SoC ${liveSoc}% below minimum ${settings.evMinSoc_percent}%`);
    }
  }

  // 4. Planned decision from the LP for the current slot.
  if (row && row.ev_charge > 0) {
    const planned: EvDecisionMode = row.ev_plan_mode === 'opportunistic'
      ? 'opportunistic'
      : row.ev_plan_mode === 'min_soc' ? 'min_soc' : 'planned';
    return charge(planned, row.ev_charge, row.ev_charge_A, 'Following day-ahead plan');
  }

  // 5. Keep-on: hold the charger energized once charging has begun within the
  // window, rather than pausing between cheap slots, until ready time / target.
  if (isNative && settings.evKeepOn && row && lastPlan) {
    const firstCharge = lastPlan.rows.find(r => r.ev_charge > 0);
    const depMs = departureMs ?? NaN;
    const started = firstCharge != null && nowMs >= firstCharge.timestampMs;
    const beforeReady = Number.isFinite(depMs) ? nowMs < depMs : true;
    const notDone = targetMet !== true && (liveSoc == null || liveSoc < targetSoc);
    if (started && beforeReady && notDone) {
      return charge('keep_on', minW, minA, 'Keep-charger-on within charge window');
    }
  }

  return charge('idle', 0, 0, row ? 'Plan idle this slot' : 'No plan');
}
