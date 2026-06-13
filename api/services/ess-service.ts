/**
 * ess-service.ts
 *
 * Orchestration for the ESS dashboard tab over the HA client. Two endpoints:
 *
 *  - `getEssState`   — one bulk `/api/states` read, indexed by entity id, shaped
 *                      into per-battery + system snapshots. Per-entity tolerant:
 *                      a missing/renamed id yields a `null` value rather than
 *                      blanking the tab.
 *  - `getEssHistory` — trend series for cells/temperatures/SoC. Prefers
 *                      pre-aggregated statistics; falls back to raw recorder
 *                      history for entities that have no statistics (the common
 *                      case for per-cell BMS voltages/temperatures), and
 *                      downsamples server-side so the payload stays bounded.
 */

import type {
  Settings,
  EssConfig,
  EssBatteryConfig,
  EssSystemConfig,
  EssHistoryPeriod,
} from '../types.ts';
import { HttpError } from '../http-errors.ts';
import { resolveHaHttpConfig, resolveHaWsConfig } from './ha-config.ts';
import {
  fetchHaEntityStates,
  fetchHaStats,
  fetchHaHistory,
  type HaEntityState,
  type HaHistoryEntry,
} from './ha-client.ts';
import type { HaReading } from '../../lib/ha-postprocess.ts';

// ----------------------------- Response shapes ---------------------------

export interface EssScalar {
  entity: string;
  value: number | null;
  unit?: string;
}

export interface EssCellReading {
  entity: string;
  value: number | null;
}

export interface EssTemperatureReading {
  entity: string;
  name: string;
  value: number | null;
  unit?: string;
}

export interface EssExtraReading {
  entity: string;
  name: string;
  value: string | null;
  unit?: string;
}

export interface EssBatteryState {
  name: string;
  cells: EssCellReading[];
  temperatures: EssTemperatureReading[];
  scalars: Record<string, EssScalar>;
  balancing: { entity: string; value: string | null } | null;
  extras: EssExtraReading[];
}

export interface EssSystemState {
  name: string;
  scalars: Record<string, EssScalar>;
  extras: EssExtraReading[];
}

export interface EssStateResponse {
  batteries: EssBatteryState[];
  system: EssSystemState | null;
  /** Echoed so the client can drive its live-poll cadence without a settings fetch. */
  refreshIntervalSeconds: number;
  fetchedAtMs: number;
}

export interface EssHistoryPoint {
  t: number;
  v: number;
}

export interface EssHistorySeries {
  source: 'statistics' | 'history' | 'none';
  points: EssHistoryPoint[];
}

export interface EssHistoryResponse {
  hours: number;
  period: EssHistoryPeriod;
  series: Record<string, EssHistorySeries>;
  /** Entity ids for which `statistics_during_period` returned no data. */
  noStatistics: string[];
  fetchedAtMs: number;
}

// ----------------------------- Config helpers ----------------------------

function requireEssConfig(settings: Settings): EssConfig {
  const cfg = settings.essConfig;
  if (!cfg || !cfg.enabled) {
    throw new HttpError(422, 'ESS dashboard is not enabled');
  }
  return cfg;
}

/**
 * Resolve a battery's cell-voltage entity ids: the explicit list wins; otherwise
 * expand `cellVoltagePrefix` + `cellCount` to `${prefix}${n}` for n in 1..count.
 */
export function expandCellEntities(battery: EssBatteryConfig): string[] {
  if (battery.cellVoltageEntities && battery.cellVoltageEntities.length > 0) {
    return battery.cellVoltageEntities;
  }
  if (battery.cellVoltagePrefix && battery.cellCount && battery.cellCount > 0) {
    return Array.from({ length: battery.cellCount }, (_unused, i) => `${battery.cellVoltagePrefix}${i + 1}`);
  }
  return [];
}

// ----------------------------- Live state --------------------------------

function numericValue(state: HaEntityState | undefined): number | null {
  if (!state) return null;
  const n = Number(state.state);
  return Number.isFinite(n) ? n : null;
}

function unitOf(state: HaEntityState | undefined): string | undefined {
  const unit = state?.attributes?.unit_of_measurement;
  return typeof unit === 'string' ? unit : undefined;
}

function scalarFor(entity: string | undefined, byId: Map<string, HaEntityState>): EssScalar | null {
  if (!entity) return null;
  const state = byId.get(entity);
  const value = numericValue(state);
  const unit = unitOf(state);
  return unit !== undefined ? { entity, value, unit } : { entity, value };
}

function extrasFor(
  entries: { entity: string; name?: string }[] | undefined,
  byId: Map<string, HaEntityState>,
): EssExtraReading[] {
  return (entries ?? []).map(({ entity, name }) => {
    const state = byId.get(entity);
    const unit = unitOf(state);
    return {
      entity,
      name: name ?? entity,
      value: state ? state.state : null,
      ...(unit !== undefined ? { unit } : {}),
    };
  });
}

function buildBatteryState(battery: EssBatteryConfig, byId: Map<string, HaEntityState>): EssBatteryState {
  const cells = expandCellEntities(battery).map(entity => ({ entity, value: numericValue(byId.get(entity)) }));

  const temperatures = (battery.temperatureEntities ?? []).map(({ entity, name }) => {
    const state = byId.get(entity);
    const unit = unitOf(state);
    return {
      entity,
      name,
      value: numericValue(state),
      ...(unit !== undefined ? { unit } : {}),
    };
  });

  const scalarEntities: Record<string, string | undefined> = {
    soc: battery.socEntity,
    current: battery.currentEntity,
    totalVoltage: battery.totalVoltageEntity,
    chargingPower: battery.chargingPowerEntity,
    dischargingPower: battery.dischargingPowerEntity,
    capacitySetting: battery.capacitySettingEntity,
    capacityRemaining: battery.capacityRemainingEntity,
    minCellVoltage: battery.minCellVoltageEntity,
    maxCellVoltage: battery.maxCellVoltageEntity,
    balancingCurrent: battery.balancingCurrentEntity,
  };
  const scalars: Record<string, EssScalar> = {};
  for (const [key, entity] of Object.entries(scalarEntities)) {
    const scalar = scalarFor(entity, byId);
    if (scalar) scalars[key] = scalar;
  }

  let balancing: { entity: string; value: string | null } | null = null;
  if (battery.balancingBinaryEntity) {
    const state = byId.get(battery.balancingBinaryEntity);
    balancing = { entity: battery.balancingBinaryEntity, value: state ? state.state : null };
  }

  return {
    name: battery.name,
    cells,
    temperatures,
    scalars,
    balancing,
    extras: extrasFor(battery.extraEntities, byId),
  };
}

function buildSystemState(system: EssSystemConfig, byId: Map<string, HaEntityState>): EssSystemState {
  const scalarEntities: Record<string, string | undefined> = {
    maxChargeCurrent: system.maxChargeCurrentEntity,
    batteryPower: system.batteryPowerEntity,
    batteryCurrent: system.batteryCurrentEntity,
    batteryVoltage: system.batteryVoltageEntity,
    soc: system.socEntity,
  };
  const scalars: Record<string, EssScalar> = {};
  for (const [key, entity] of Object.entries(scalarEntities)) {
    const scalar = scalarFor(entity, byId);
    if (scalar) scalars[key] = scalar;
  }

  return {
    name: system.name ?? 'System',
    scalars,
    extras: extrasFor(system.extraEntities, byId),
  };
}

/**
 * Live snapshot of every configured ESS entity, fetched in a single bulk
 * `/api/states` request and indexed by id.
 */
export async function getEssState(settings: Settings): Promise<EssStateResponse> {
  const cfg = requireEssConfig(settings);

  // Fail fast when HA is not configured (e.g. no token in standalone mode)
  // rather than issuing a doomed REST call.
  if (!resolveHaHttpConfig(settings.haUrl, settings.haToken)) {
    throw new HttpError(422, 'Home Assistant is not configured');
  }

  let states: HaEntityState[];
  try {
    states = await fetchHaEntityStates({ haUrl: settings.haUrl, haToken: settings.haToken });
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : 'Failed to fetch entity states from Home Assistant');
  }

  const byId = new Map<string, HaEntityState>();
  for (const state of states) byId.set(state.entity_id, state);

  return {
    batteries: cfg.batteries.map(battery => buildBatteryState(battery, byId)),
    system: cfg.system ? buildSystemState(cfg.system, byId) : null,
    refreshIntervalSeconds: cfg.refreshIntervalSeconds,
    fetchedAtMs: Date.now(),
  };
}

// ----------------------------- History -----------------------------------

/** Trend-chart entities: all cell voltages, all temperatures, all per-battery SoC. */
export function collectHistoryEntities(cfg: EssConfig): string[] {
  const ids = new Set<string>();
  for (const battery of cfg.batteries) {
    for (const cell of expandCellEntities(battery)) ids.add(cell);
    for (const temp of battery.temperatureEntities ?? []) ids.add(temp.entity);
    if (battery.socEntity) ids.add(battery.socEntity);
  }
  return [...ids];
}

function statsToPoints(readings: HaReading[]): EssHistoryPoint[] {
  const points: EssHistoryPoint[] = [];
  for (const reading of readings) {
    // measurement sensors carry `mean`; fall back to `state`, then `change`.
    const raw = reading.mean ?? reading.state ?? reading.change;
    const t = Number(reading.start);
    if (raw != null && Number.isFinite(raw) && Number.isFinite(t)) {
      points.push({ t, v: Number(raw) });
    }
  }
  return points;
}

function historyToPoints(entries: HaHistoryEntry[]): EssHistoryPoint[] {
  const points: EssHistoryPoint[] = [];
  for (const entry of entries) {
    const v = Number(entry.state);
    const stamp = entry.last_changed ?? entry.last_updated;
    const t = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(v) && Number.isFinite(t)) {
      points.push({ t, v });
    }
  }
  return points;
}

/**
 * Bucket points to `bucketMs` granularity (mean per bucket). Keeps the payload
 * bounded regardless of how dense raw recorder history is.
 */
function downsample(points: EssHistoryPoint[], bucketMs: number): EssHistoryPoint[] {
  if (points.length === 0) return [];
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const point of points) {
    const key = Math.floor(point.t / bucketMs);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sum += point.v;
      bucket.count += 1;
    } else {
      buckets.set(key, { sum: point.v, count: 1 });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, bucket]) => ({ t: key * bucketMs, v: bucket.sum / bucket.count }));
}

/** Match an entity's history sub-array by id (preferred) or request order. */
function pickHistoryFor(history: HaHistoryEntry[][], requestIndex: number, entityId: string): HaHistoryEntry[] {
  for (const inner of history) {
    if (inner.length > 0 && inner[0].entity_id === entityId) return inner;
  }
  return history[requestIndex] ?? [];
}

/**
 * Trend series for the dashboard. Statistics where available (cheap,
 * pre-aggregated); raw history otherwise — the headline fix for blank cell
 * voltage/temperature trends.
 */
export async function getEssHistory(
  settings: Settings,
  { hours, period }: { hours: number; period: EssHistoryPeriod },
): Promise<EssHistoryResponse> {
  const cfg = requireEssConfig(settings);

  if (!resolveHaWsConfig(settings.haUrl, settings.haToken)) {
    throw new HttpError(422, 'Home Assistant is not configured');
  }

  const entityIds = collectHistoryEntities(cfg);
  const startTime = new Date(Date.now() - hours * 3600_000).toISOString();
  const bucketMs = period === 'hour' ? 3600_000 : 5 * 60_000;

  let stats: Record<string, HaReading[]> = {};
  if (entityIds.length > 0) {
    try {
      stats = await fetchHaStats({ haUrl: settings.haUrl, haToken: settings.haToken, entityIds, startTime, period });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'Failed to fetch statistics from Home Assistant');
    }
  }

  const series: Record<string, EssHistorySeries> = {};
  const noStatistics: string[] = [];

  for (const id of entityIds) {
    const readings = stats[id];
    if (readings && readings.length > 0) {
      series[id] = { source: 'statistics', points: downsample(statsToPoints(readings), bucketMs) };
    } else {
      noStatistics.push(id);
    }
  }

  // Raw-history fallback for entities lacking statistics (best-effort; a failure
  // here leaves those series empty rather than failing the whole request).
  if (noStatistics.length > 0) {
    let history: HaHistoryEntry[][] = [];
    try {
      history = await fetchHaHistory({ haUrl: settings.haUrl, haToken: settings.haToken, entityIds: noStatistics, startTime });
    } catch {
      history = [];
    }
    noStatistics.forEach((id, index) => {
      const points = downsample(historyToPoints(pickHistoryFor(history, index, id)), bucketMs);
      series[id] = { source: points.length > 0 ? 'history' : 'none', points };
    });
  }

  return { hours, period, series, noStatistics, fetchedAtMs: Date.now() };
}
