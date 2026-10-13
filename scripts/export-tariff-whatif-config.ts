/**
 * Helpers for the export-tariff what-if (scripts/export-tariff-whatif.ts).
 *
 * The what-if solves one snapshot three times, differing only in
 * `settings.exportTariff`: the block absent (pre-tariff behaviour), forced
 * `netMetering`, and forced `marketPrice`. Every other field of a stored block
 * (fee, negative-price rule, terminal valuation, tail hours) is kept, so the
 * market run shows what the box would plan with its own tariff settings.
 */
import { EXPORT_TARIFF_DEFAULTS } from '../api/services/settings-schema.ts';
import { pricePointsToSeries } from '../api/services/ha-price-service.ts';
import { buildPlanSummary } from '../lib/plan-summary.ts';
import type { PlanRow, TimeSeries } from '../lib/types.ts';
import type { Settings } from '../api/types.ts';

export type WhatIfMode = 'absent' | 'netMetering' | 'marketPrice';
export const WHATIF_MODES: readonly WhatIfMode[] = ['absent', 'netMetering', 'marketPrice'];

/** The snapshot's settings with `exportTariff` removed or forced to `mode`. */
export function settingsForMode(settings: Settings, mode: WhatIfMode): Settings {
  const { exportTariff, ...rest } = settings;
  if (mode === 'absent') return rest as Settings;
  return { ...rest, exportTariff: { ...EXPORT_TARIFF_DEFAULTS, ...exportTariff, mode } };
}

/**
 * The snapshot's settings with an injected (`--market`) series counting as the
 * market source, the way a marketPrice posted to /data does under API prices.
 * The planner ignores `data.marketPrice` under VRM prices, and under HA prices
 * without an `exportSensor`. Only the market-source rule reads the price source
 * here: the price series themselves come from data.json.
 */
export function withInjectedMarketSource(settings: Settings): Settings {
  return { ...settings, dataSources: { ...settings.dataSources, prices: 'api' } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turn a market-price entity (the GET /ha/entity/<id> response, or its bare
 * attributes) into a 15-minute series in c€/kWh, read with the same attribute,
 * key, multiplier and interval settings as the import sensor (`haPriceConfig`).
 * `nowMs` is the plan start: the feed must have a contiguous run covering it,
 * exactly as the add-on's own fetch requires. Throws when it has none.
 */
export function marketSeriesFromEntity(entity: unknown, settings: Settings, nowMs: number, source = 'market entity'): TimeSeries {
  const attributes = isObject(entity) && isObject(entity.attributes) ? entity.attributes : entity;
  if (!isObject(attributes)) throw new Error(`${source}: not a Home Assistant entity state or attributes object`);
  const cfg = settings.haPriceConfig;
  const todayAttr = cfg?.todayAttribute || 'today_hourly_prices';
  const tomorrowAttr = cfg?.tomorrowAttribute || 'tomorrow_hourly_prices';
  const points = [todayAttr, tomorrowAttr].flatMap(key => (Array.isArray(attributes[key]) ? attributes[key] : []));
  if (points.length === 0) throw new Error(`${source}: no price points in "${todayAttr}" or "${tomorrowAttr}"`);
  const series = pricePointsToSeries(points as Parameters<typeof pricePointsToSeries>[0], {
    timeKey: cfg?.timeKey || 'time',
    valueKey: cfg?.valueKey || 'value',
    multiplier: cfg?.valueMultiplier ?? 100,
    interval: cfg?.priceInterval ?? 60,
    nowMs,
  });
  if (!series) {
    throw new Error(`${source}: no contiguous run of prices covers the plan start ${new Date(nowMs).toISOString()} (set NOW=<ISO> inside the feed)`);
  }
  return series;
}

export interface FlowTotals {
  batteryToGrid_kWh: number;
  pvToGrid_kWh: number;
  pvToBattery_kWh: number;
  gridToBattery_kWh: number;
  /** SoC at the end of the last slot. */
  finalSoc_percent: number;
  /** Planned import cost minus export revenue over the horizon, in c€. */
  netGridCost_cents: number;
}

/** The energy flows and cost the what-if compares between modes. */
export function summarizeFlows(rows: PlanRow[], stepSize_m: number): FlowTotals {
  const summary = buildPlanSummary(rows, { stepSize_m });
  const toKWh = (key: 'pv2g' | 'pv2b') => rows.reduce((sum, r) => sum + r[key], 0) * stepSize_m / 60 / 1000;
  return {
    batteryToGrid_kWh: summary.batteryToGrid_kWh,
    pvToGrid_kWh: toKWh('pv2g'),
    pvToBattery_kWh: toKWh('pv2b'),
    gridToBattery_kWh: summary.gridToBattery_kWh,
    finalSoc_percent: rows.length ? rows[rows.length - 1].soc_percent : NaN,
    netGridCost_cents: summary.netGridCost_cents,
  };
}
