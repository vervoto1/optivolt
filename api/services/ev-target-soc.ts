/**
 * ev-target-soc.ts
 *
 * Resolves the EV target SoC. `evTargetSoc_percent` is the baseline, but when
 * `evTargetSocEntity` names a Home Assistant entity — typically the car's own
 * charge limit (`number.tesla_charge_limit`) — its numeric state wins.
 *
 * That keeps a single owner for the target. Without it the two drift apart, and
 * a car limit *below* OptiVolt's target is the expensive failure: the car stops
 * at its own limit while the planner keeps booking cheap slots for a charge that
 * never happens, keeps the charger energized, and keeps battery→grid discharge
 * suppressed for a session that is already finished.
 *
 * Every read is best-effort: no entity configured, no HA connection, a
 * non-numeric state (`unavailable`, `unknown`), or a non-positive one falls back
 * to the static setting.
 */

import type { Settings } from '../types.ts';
import { fetchHaEntityState } from './ha-client.ts';

/**
 * Parse an HA state string into a 0–100 target SoC, or null when unusable.
 *
 * Zero and negative states are unusable, not a 0% target. Nobody sets a car to
 * "charge to 0%", but an `input_number` helper before its first sync, a template
 * sensor that evaluates to 0, or an entity id pointing at the wrong thing all
 * report it — and taking it literally is silent and expensive: the LP plans no
 * EV charge at all, `evMinSocFloor_percent` clamps to 0 so the minimum-SoC floor
 * stops protecting the car, and the decision layer's `liveSoc >= targetSoc`
 * cutoff idles every planned slot. Fall back to the setting instead.
 */
export function parseTargetSocState(state: string | undefined): number | null {
  const value = parseFloat(String(state ?? ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(100, value);
}

/**
 * Live target SoC from the configured HA entity, or null when no entity is set,
 * HA is not configured/reachable, or the state is not a number.
 */
export async function fetchEvTargetSoc(settings: Settings): Promise<number | null> {
  const entityId = (settings.evTargetSocEntity ?? '').trim();
  if (!entityId) return null;
  // Same guard the decision layer uses: standalone needs haUrl, add-on mode goes
  // through the supervisor proxy.
  if (!settings.haUrl && !process.env.SUPERVISOR_TOKEN) return null;

  try {
    const entity = await fetchHaEntityState({
      haUrl: settings.haUrl,
      haToken: settings.haToken,
      entityId,
    });
    return parseTargetSocState(entity.state);
  } catch {
    return null; // HA unavailable → caller falls back to the setting
  }
}

/** Effective target SoC: the live entity value when readable, else the setting. */
export async function resolveEvTargetSoc(settings: Settings): Promise<number> {
  return (await fetchEvTargetSoc(settings)) ?? settings.evTargetSoc_percent;
}
