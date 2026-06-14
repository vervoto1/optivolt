import type { Settings } from '../types.ts';

export type EvMode = 'off' | 'native';

/**
 * Resolve the single authoritative EV mode from settings.
 *
 * `evEnabled` is the master switch: when on, OptiVolt plans EV charging natively
 * in the LP; when off, no EV charge is planned (any manually-injected `evLoad`
 * is treated as uncontrollable house load). Callers gate on this resolver rather
 * than the raw flag so the EV planning path has a single source of truth.
 */
export function resolveEvMode(settings: Pick<Settings, 'evEnabled'>): EvMode {
  return settings.evEnabled ? 'native' : 'off';
}
