import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts');

import { fetchHaEntityStates } from '../../../api/services/ha-client.ts';
import {
  checkPredictionSensors,
  runPredictionSensorCheck,
  SENSOR_CHECK_TIMEOUT_MS,
} from '../../../api/services/prediction-sensor-check.ts';

const energy = (entity_id, state, unit = 'kWh', state_class = 'total_increasing') => ({
  entity_id,
  state,
  attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...(state_class ? { state_class } : {}) },
});

const sensor = (id, name, unit = 'kWh') => ({ id, name, unit });

describe('checkPredictionSensors', () => {
  it('passes an existing numeric energy entity whose unit matches', () => {
    const { sensors } = checkPredictionSensors(
      [sensor('sensor.envoy', 'Enphase Solar', 'MWh')],
      [],
      [energy('sensor.envoy', '0.77626', 'MWh')],
    );
    expect(sensors).toEqual([{
      id: 'sensor.envoy',
      name: 'Enphase Solar',
      configuredUnit: 'MWh',
      status: 'ok',
      checked: true,
      state: '0.77626',
      unit: 'MWh',
      stateClass: 'total_increasing',
      messages: [],
    }]);
  });

  it('flags an entity HA does not have — a typo that would silently contribute nothing', () => {
    const [check] = checkPredictionSensors([sensor('sensor.dsmr_t2_typo', 'Grid Import')], [], [energy('sensor.dsmr_t2', '1')]).sensors;
    expect(check.status).toBe('error');
    expect(check.messages[0]).toContain('not found in Home Assistant');
  });

  it('flags a unit mismatch with the scaling error it would cause', () => {
    const [check] = checkPredictionSensors([sensor('sensor.e', 'E', 'kWh')], [], [energy('sensor.e', '0.5', 'MWh')]).sensors;
    expect(check.status).toBe('error');
    expect(check.messages[0]).toContain('configured as kWh but Home Assistant reports MWh; values would be off by ×1000');
  });

  it('flags a power (non-energy) entity and an unknown configured unit', () => {
    const [power] = checkPredictionSensors([sensor('sensor.p', 'P', 'W')], [], [energy('sensor.p', '300', 'W', 'measurement')]).sensors;
    expect(power.status).toBe('error');
    expect(power.messages.join(' ')).toMatch(/configured unit "W" is not Wh\/kWh\/MWh/);
    expect(power.messages.join(' ')).toMatch(/Home Assistant unit "W" is not an energy unit/);
    expect(power.messages.join(' ')).toMatch(/state_class is "measurement"/);
  });

  it('warns on a non-numeric state, a missing unit or a missing state_class', () => {
    const [check] = checkPredictionSensors([sensor('sensor.x', 'X')], [], [energy('sensor.x', 'unavailable', null, null)]).sensors;
    expect(check.status).toBe('warning');
    expect(check.messages).toEqual([
      'current state is "unavailable", not a number',
      'Home Assistant reports no unit of measurement',
      expect.stringContaining('state_class is not set'),
    ]);
  });

  it('warns on a duplicated entity id', () => {
    const states = [energy('sensor.a', '1')];
    const { sensors } = checkPredictionSensors([sensor('sensor.a', 'A'), sensor('sensor.a', 'A')], [], states);
    expect(sensors.map(s => s.status)).toEqual(['ok', 'warning']);
  });

  it('runs only the config-side checks without HA', () => {
    const { sensors } = checkPredictionSensors([sensor('sensor.a', 'A'), sensor('sensor.b', 'B', 'GWh')], [], null);
    expect(sensors[0]).toMatchObject({ status: 'ok', checked: false, state: null, messages: [] });
    expect(sensors[1]).toMatchObject({ status: 'error', checked: false });
  });

  it('checks derived formula terms against the sensor names, in definition order', () => {
    const { derived } = checkPredictionSensors(
      [sensor('sensor.i', 'Grid Import'), sensor('sensor.e', 'Grid Export')],
      [
        { name: 'Total Load', formula: ['+Grid Import', '-Grid Export'] },
        { name: 'Load without EV', formula: ['+Total Load', '-EV Charging'] },
        { name: 'Early', formula: ['+Late'] },
        { name: 'Late', formula: ['Grid Import'] },
        { name: 'Empty', formula: [] },
      ],
      [],
    );
    expect(derived.map(d => d.status)).toEqual(['ok', 'error', 'error', 'error', 'error']);
    expect(derived[1].messages).toEqual(['term "-EV Charging" matches no sensor name; it counts as 0']);
    expect(derived[2].messages[0]).toContain('uses derived "Late" before it is defined');
    expect(derived[3].messages[0]).toContain('must start with + or -');
    expect(derived[4].messages).toEqual(['formula is empty']);
  });
});

describe('runPredictionSensorCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads all states once, with a deadline', async () => {
    fetchHaEntityStates.mockResolvedValue([energy('sensor.a', '1')]);
    const result = await runPredictionSensorCheck({ haUrl: 'ws://ha', haToken: 't' }, [sensor('sensor.a', 'A')], []);
    expect(fetchHaEntityStates).toHaveBeenCalledOnce();
    expect(fetchHaEntityStates).toHaveBeenCalledWith({ haUrl: 'ws://ha', haToken: 't', timeoutMs: SENSOR_CHECK_TIMEOUT_MS });
    expect(result).toMatchObject({ reachable: true, sensors: [{ status: 'ok' }] });
    expect(result).not.toHaveProperty('error');
  });

  it('reports an unreachable HA instead of failing every sensor', async () => {
    fetchHaEntityStates.mockRejectedValue(new Error('Home Assistant connection is not configured'));
    const result = await runPredictionSensorCheck({ haUrl: '', haToken: '' }, [sensor('sensor.a', 'A')], []);
    expect(result).toMatchObject({ reachable: false, error: 'Home Assistant connection is not configured' });
    expect(result.sensors[0]).toMatchObject({ checked: false, status: 'ok' });
  });

  it('treats a non-list response as unreachable', async () => {
    fetchHaEntityStates.mockResolvedValue({ message: 'nope' });
    const result = await runPredictionSensorCheck({ haUrl: 'x', haToken: 'y' }, [], []);
    expect(result).toMatchObject({ reachable: false, error: 'Home Assistant returned no state list' });
  });
});
