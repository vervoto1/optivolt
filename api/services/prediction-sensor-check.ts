/**
 * prediction-sensor-check.ts
 *
 * Check the prediction config's sensor entities against Home Assistant and
 * its derived formulas against the sensor names (upstream a954991 + 0e05b6b,
 * redone for the fork's JSON sensor editor and server-side).
 *
 * Why: the forecast pipeline is silent about a bad sensor. A mistyped or
 * renamed entity id simply returns no statistics, `postprocess` treats a
 * formula term with no data as 0, and a unit the code does not convert is
 * read as Wh — each of these biases the load or PV series the LP plans on,
 * with no error anywhere. This check names each problem per entity.
 *
 * It is advisory only. It never blocks saving the config, and an unreachable
 * HA is reported as such (`reachable: false`) instead of failing every
 * sensor. One `GET /api/states` covers every entity.
 */

import type { HaEntityState } from './ha-client.ts';
import { fetchHaEntityStates } from './ha-client.ts';
import { WH_PER_UNIT, whPerUnit } from '../../lib/ha-postprocess.ts';
import type { HaDerivedSensor, HaSensor } from '../../lib/ha-postprocess.ts';

export type SensorCheckStatus = 'ok' | 'warning' | 'error';

export interface SensorEntityCheck {
  id: string;
  name: string;
  configuredUnit: string | null;
  /** 'ok' only when HA was reached and nothing is wrong; without HA only the config-side checks run. */
  status: SensorCheckStatus;
  /** Whether the entity was looked up in HA (false when HA was unreachable). */
  checked: boolean;
  state: string | null;
  unit: string | null;
  stateClass: string | null;
  messages: string[];
}

export interface DerivedFormulaCheck {
  name: string;
  status: 'ok' | 'error';
  messages: string[];
}

export interface SensorCheckResult {
  reachable: boolean;
  /** Why HA could not be read (only when `reachable` is false). */
  error?: string;
  sensors: SensorEntityCheck[];
  derived: DerivedFormulaCheck[];
}

/** Deadline for the one `GET /api/states` the check makes. */
export const SENSOR_CHECK_TIMEOUT_MS = 10_000;

/** State classes HA keeps `sum`/`change` long-term statistics for — what the predictors read. */
const ENERGY_STATE_CLASSES = new Set(['total', 'total_increasing']);
const KNOWN_UNITS = Object.keys(WH_PER_UNIT).join('/');

function worst(a: SensorCheckStatus, b: SensorCheckStatus): SensorCheckStatus {
  const rank = { ok: 0, warning: 1, error: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function stringAttr(state: HaEntityState | undefined, key: string): string | null {
  const value = state?.attributes?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Pure check of the configured sensors and derived formulas. `states` is the
 * HA `/api/states` list, or null when HA could not be read (then only the
 * config-side checks run and `checked` is false).
 */
export function checkPredictionSensors(
  sensors: readonly HaSensor[],
  derived: readonly HaDerivedSensor[],
  states: readonly HaEntityState[] | null,
): Pick<SensorCheckResult, 'sensors' | 'derived'> {
  const byId = states ? new Map(states.map(s => [s.entity_id, s])) : null;
  const seen = new Set<string>();
  const sensorChecks: SensorEntityCheck[] = [];

  for (const sensor of sensors) {
    const id = String(sensor?.id ?? '').trim();
    const name = String(sensor?.name ?? id);
    const configuredUnit = typeof sensor?.unit === 'string' ? sensor.unit.trim() : null;
    const messages: string[] = [];
    let status: SensorCheckStatus = 'ok';
    const flag = (level: SensorCheckStatus, message: string) => {
      status = worst(status, level);
      messages.push(message);
    };

    if (seen.has(id)) flag('warning', 'listed more than once; only one entry\'s name and unit are used');
    seen.add(id);

    const configuredFactor = whPerUnit(configuredUnit ?? undefined);
    if (configuredFactor === null) {
      flag('error', `configured unit ${JSON.stringify(configuredUnit ?? '')} is not ${KNOWN_UNITS}; its values would be read as Wh`);
    }

    const state = byId?.get(id);
    const unit = stringAttr(state, 'unit_of_measurement');
    const stateClass = stringAttr(state, 'state_class');

    if (byId) {
      if (!state) {
        flag('error', 'not found in Home Assistant; it would contribute no data (a derived term using it counts as 0)');
      } else {
        if (!Number.isFinite(Number.parseFloat(state.state))) {
          flag('warning', `current state is ${JSON.stringify(state.state)}, not a number`);
        }
        const haFactor = whPerUnit(unit ?? undefined);
        if (unit === null) {
          flag('warning', 'Home Assistant reports no unit of measurement');
        } else if (haFactor === null) {
          flag('error', `Home Assistant unit ${JSON.stringify(unit)} is not an energy unit (${KNOWN_UNITS})`);
        } else if (configuredFactor !== null && haFactor !== configuredFactor) {
          flag('error', `configured as ${configuredUnit} but Home Assistant reports ${unit}; values would be off by ×${haFactor / configuredFactor}`);
        }
        if (stateClass === null || !ENERGY_STATE_CLASSES.has(stateClass)) {
          flag('warning', `state_class is ${stateClass === null ? 'not set' : JSON.stringify(stateClass)}; Home Assistant keeps energy-change statistics only for total/total_increasing`);
        }
      }
    }

    sensorChecks.push({
      id,
      name,
      configuredUnit,
      status,
      checked: !!byId,
      state: state?.state ?? null,
      unit,
      stateClass,
      messages,
    });
  }

  // postprocess() computes derived series in config order, so a term may use
  // any sensor name or a derived series defined before it; anything else
  // silently contributes 0.
  const known = new Set(sensors.map(s => String(s?.name ?? s?.id ?? '')));
  const derivedNames = new Set(derived.map(d => String(d?.name ?? '')));
  const derivedChecks: DerivedFormulaCheck[] = derived.map(d => {
    const messages: string[] = [];
    const formula = Array.isArray(d?.formula) ? d.formula : [];
    if (formula.length === 0) messages.push('formula is empty');
    for (const term of formula) {
      const text = String(term);
      const sign = text[0];
      const ref = text.slice(1);
      if (sign !== '+' && sign !== '-') {
        messages.push(`term ${JSON.stringify(text)} must start with + or -`);
      } else if (!known.has(ref)) {
        messages.push(derivedNames.has(ref)
          ? `term ${JSON.stringify(text)} uses derived "${ref}" before it is defined; it counts as 0`
          : `term ${JSON.stringify(text)} matches no sensor name; it counts as 0`);
      }
    }
    known.add(String(d?.name ?? ''));
    return { name: String(d?.name ?? ''), status: messages.length > 0 ? 'error' : 'ok', messages };
  });

  return { sensors: sensorChecks, derived: derivedChecks };
}

/** Read every HA state once and check the given sensors and formulas. Never throws for an HA failure. */
export async function runPredictionSensorCheck(
  { haUrl, haToken }: { haUrl: string; haToken: string },
  sensors: readonly HaSensor[],
  derived: readonly HaDerivedSensor[],
): Promise<SensorCheckResult> {
  let states: HaEntityState[] | null = null;
  let error: string | undefined;
  try {
    states = await fetchHaEntityStates({ haUrl, haToken, timeoutMs: SENSOR_CHECK_TIMEOUT_MS });
    if (!Array.isArray(states)) throw new Error('Home Assistant returned no state list');
  } catch (err) {
    states = null;
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    reachable: states !== null,
    ...(error !== undefined ? { error } : {}),
    ...checkPredictionSensors(sensors, derived, states),
  };
}
