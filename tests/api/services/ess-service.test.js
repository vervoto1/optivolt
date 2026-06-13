import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the HA I/O layer; the service + ha-config run for real.
vi.mock('../../../api/services/ha-client.ts');

import {
  fetchHaEntityStates,
  fetchHaStats,
  fetchHaHistory,
} from '../../../api/services/ha-client.ts';
import {
  getEssState,
  getEssHistory,
  expandCellEntities,
  collectHistoryEntities,
} from '../../../api/services/ess-service.ts';

const HA = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
};

function makeBattery(prefix, extra = {}) {
  return {
    name: `Battery ${prefix}`,
    cellVoltagePrefix: `sensor.${prefix}_cell_voltage_`,
    cellCount: 3,
    temperatureEntities: [
      { entity: `sensor.${prefix}_temperature_sensor_1`, name: 'Temp 1' },
    ],
    socEntity: `sensor.${prefix}_state_of_charge`,
    currentEntity: `sensor.${prefix}_current`,
    ...extra,
  };
}

function makeSettings(overrides = {}) {
  return {
    ...HA,
    essConfig: {
      enabled: true,
      historyWindowHours: 24,
      historyPeriod: '5minute',
      refreshIntervalSeconds: 30,
      batteries: [makeBattery('bms0')],
    },
    ...overrides,
  };
}

function state(entity_id, value, unit) {
  return {
    entity_id,
    state: String(value),
    attributes: unit ? { unit_of_measurement: unit } : {},
    last_changed: '2026-06-13T10:00:00Z',
    last_updated: '2026-06-13T10:00:00Z',
  };
}

describe('expandCellEntities', () => {
  it('expands prefix + count to 1..N', () => {
    expect(expandCellEntities({ name: 'b', cellVoltagePrefix: 'sensor.c_', cellCount: 3 }))
      .toEqual(['sensor.c_1', 'sensor.c_2', 'sensor.c_3']);
  });

  it('prefers an explicit list over the prefix form', () => {
    expect(expandCellEntities({ name: 'b', cellVoltagePrefix: 'sensor.c_', cellCount: 3, cellVoltageEntities: ['sensor.x'] }))
      .toEqual(['sensor.x']);
  });

  it('returns [] when neither form is configured', () => {
    expect(expandCellEntities({ name: 'b' })).toEqual([]);
  });
});

describe('getEssState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws 422 when ESS is disabled', async () => {
    await expect(getEssState(makeSettings({ essConfig: { enabled: false, batteries: [] } })))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('throws 422 when HA is not configured (no token)', async () => {
    await expect(getEssState(makeSettings({ haUrl: '', haToken: '' })))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(fetchHaEntityStates).not.toHaveBeenCalled();
  });

  it('issues a single bulk states call and expands cells, tolerating a missing entity', async () => {
    fetchHaEntityStates.mockResolvedValue([
      state('sensor.bms0_cell_voltage_1', 3.31, 'V'),
      state('sensor.bms0_cell_voltage_2', 3.33, 'V'),
      // cell_voltage_3 intentionally absent -> value null
      state('sensor.bms0_state_of_charge', 87, '%'),
      state('sensor.bms0_current', -4.2, 'A'),
      state('sensor.bms0_temperature_sensor_1', 21.5, '°C'),
    ]);

    const result = await getEssState(makeSettings());

    expect(fetchHaEntityStates).toHaveBeenCalledTimes(1);
    expect(result.batteries).toHaveLength(1);
    const battery = result.batteries[0];
    expect(battery.cells).toHaveLength(3);
    expect(battery.cells[0].value).toBe(3.31);
    expect(battery.cells[2]).toEqual({ entity: 'sensor.bms0_cell_voltage_3', value: null });
    expect(battery.scalars.soc).toEqual({ entity: 'sensor.bms0_state_of_charge', value: 87, unit: '%' });
    expect(battery.scalars.current.value).toBe(-4.2);
    expect(battery.temperatures[0]).toMatchObject({ name: 'Temp 1', value: 21.5, unit: '°C' });
    expect(result.refreshIntervalSeconds).toBe(30);
  });

  it('maps non-numeric / unavailable states to null', async () => {
    fetchHaEntityStates.mockResolvedValue([
      state('sensor.bms0_state_of_charge', 'unavailable'),
    ]);
    const result = await getEssState(makeSettings());
    expect(result.batteries[0].scalars.soc.value).toBeNull();
  });

  it('includes the system card when configured', async () => {
    fetchHaEntityStates.mockResolvedValue([
      state('sensor.sys_power', 1200, 'W'),
    ]);
    const settings = makeSettings();
    settings.essConfig.system = { name: 'Victron system', batteryPowerEntity: 'sensor.sys_power' };
    const result = await getEssState(settings);
    expect(result.system.name).toBe('Victron system');
    expect(result.system.scalars.batteryPower).toEqual({ entity: 'sensor.sys_power', value: 1200, unit: 'W' });
  });

  it('maps a bulk-fetch failure to 502', async () => {
    fetchHaEntityStates.mockRejectedValue(new Error('network down'));
    await expect(getEssState(makeSettings())).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('collectHistoryEntities', () => {
  it('collects cell, temperature and per-battery SoC entities (deduped)', () => {
    const cfg = {
      enabled: true,
      historyWindowHours: 24,
      historyPeriod: '5minute',
      refreshIntervalSeconds: 30,
      batteries: [makeBattery('bms0'), makeBattery('bms1')],
    };
    const ids = collectHistoryEntities(cfg);
    expect(ids).toContain('sensor.bms0_cell_voltage_1');
    expect(ids).toContain('sensor.bms0_temperature_sensor_1');
    expect(ids).toContain('sensor.bms0_state_of_charge');
    expect(ids).toContain('sensor.bms1_cell_voltage_3');
    // 2 batteries * (3 cells + 1 temp + 1 soc) = 10 unique ids
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });
});

describe('getEssHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws 422 when HA is not configured', async () => {
    await expect(getEssHistory(makeSettings({ haUrl: '', haToken: '' }), { hours: 24, period: '5minute' }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('passes the full entity-id set and a startTime derived from hours', async () => {
    fetchHaStats.mockResolvedValue({});
    fetchHaHistory.mockResolvedValue([]);
    const before = Date.now();
    await getEssHistory(makeSettings(), { hours: 12, period: 'hour' });

    const args = fetchHaStats.mock.calls[0][0];
    expect(new Set(args.entityIds)).toEqual(new Set([
      'sensor.bms0_cell_voltage_1', 'sensor.bms0_cell_voltage_2', 'sensor.bms0_cell_voltage_3',
      'sensor.bms0_temperature_sensor_1', 'sensor.bms0_state_of_charge',
    ]));
    expect(args.period).toBe('hour');
    const startMs = Date.parse(args.startTime);
    expect(before - startMs).toBeGreaterThanOrEqual(12 * 3600_000 - 5000);
    expect(before - startMs).toBeLessThanOrEqual(12 * 3600_000 + 5000);
  });

  it('maps statistics readings to points (mean preferred) and downsamples per bucket', async () => {
    const t0 = 1_700_000_000_000;
    fetchHaStats.mockResolvedValue({
      'sensor.bms0_cell_voltage_1': [
        { start: t0, mean: 3.30 },
        { start: t0 + 60_000, mean: 3.32 }, // same 5-min bucket -> averaged with previous
        { start: t0 + 5 * 60_000, mean: 3.40 },
      ],
    });
    fetchHaHistory.mockResolvedValue([]);

    const result = await getEssHistory(makeSettings(), { hours: 24, period: '5minute' });
    const series = result.series['sensor.bms0_cell_voltage_1'];
    expect(series.source).toBe('statistics');
    expect(series.points).toHaveLength(2); // two distinct 5-min buckets
    expect(series.points[0].v).toBeCloseTo(3.31, 5); // (3.30 + 3.32) / 2
    expect(series.points[1].v).toBeCloseTo(3.40, 5);
  });

  it('falls back to raw history when statistics are empty (the blank-trend guard)', async () => {
    // No statistics for any entity -> all fall through to the history fallback.
    fetchHaStats.mockResolvedValue({});
    const t0 = 1_700_000_000_000;
    // History returns one inner array per requested entity, in order.
    fetchHaHistory.mockImplementation(async ({ entityIds }) =>
      entityIds.map((id) =>
        id === 'sensor.bms0_cell_voltage_1'
          ? [
              { entity_id: id, state: '3.29', last_changed: new Date(t0).toISOString() },
              { entity_id: id, state: '3.35', last_changed: new Date(t0 + 6 * 60_000).toISOString() },
            ]
          : [],
      ),
    );

    const result = await getEssHistory(makeSettings(), { hours: 24, period: '5minute' });

    expect(result.noStatistics).toContain('sensor.bms0_cell_voltage_1');
    const series = result.series['sensor.bms0_cell_voltage_1'];
    expect(series.source).toBe('history');
    expect(series.points).toHaveLength(2);
    expect(series.points[0].v).toBeCloseTo(3.29, 5);

    // An entity with neither statistics nor history is reported as 'none'.
    expect(result.series['sensor.bms0_state_of_charge'].source).toBe('none');
  });

  it('tolerates a history-fetch failure by leaving fallback series empty', async () => {
    fetchHaStats.mockResolvedValue({});
    fetchHaHistory.mockRejectedValue(new Error('history endpoint down'));
    const result = await getEssHistory(makeSettings(), { hours: 24, period: '5minute' });
    expect(result.series['sensor.bms0_cell_voltage_1'].source).toBe('none');
    expect(result.series['sensor.bms0_cell_voltage_1'].points).toEqual([]);
  });
});
