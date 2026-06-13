import type { Settings } from '../types.ts';

export type EvMode = 'off' | 'native' | 'haSchedule';

/**
 * Resolve the single authoritative EV mode from settings.
 *
 * `evEnabled` is the master switch; `evSource` selects the planning path.
 * Returning exactly one of 'native' | 'haSchedule' | 'off' guarantees the
 * native LP charge path and the legacy `evLoad` injection path can never both
 * be active — eliminating the historical double-count where one shared
 * `ev-enabled` checkbox drove both `evConfig.enabled` and flat `evEnabled`.
 *
 * Server-side authoritative: even if a client somehow sets both `evEnabled` and
 * a stale `evConfig.enabled`, callers gate on this resolver, not on the raw
 * fields, so only the selected path fires.
 */
export function resolveEvMode(settings: Pick<Settings, 'evEnabled' | 'evSource'>): EvMode {
  if (!settings.evEnabled) return 'off';
  return settings.evSource === 'haSchedule' ? 'haSchedule' : 'native';
}
