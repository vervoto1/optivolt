// Mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

import type { PlanRow, SolverConfig, DessDiagnostics, DessResult, DessSlot } from './types.ts';
import { DEFAULT_INVERTER_EFFICIENCY_PERCENT } from './build-lp.ts';

const FLOW_EPSILON_W = 1; // treat flows below this as zero
const SOC_EPSILON_PERCENT = 0.5; // treat SoC within this of min/max as at boundary

export const Strategy = {
  targetSoc: 0,       // excess PV and load to/from grid
  selfConsumption: 1, // excess PV and load to/from battery
  proBattery: 2,      // excess PV to battery, excess load from grid
  proGrid: 3,         // excess PV to grid, excess load from battery
  unknown: -1,
} as const;

export const Restrictions = {
  none: 0,            // no restrictions between battery and grid
  batteryToGrid: 1,   // restrict battery → grid
  gridToBattery: 2,   // restrict grid → battery
  both: 3,            // block both directions
  unknown: -1,
} as const;

export const FeedIn = {
  // v8 ignore next — module const
  allowed: 1,
  // v8 ignore next — module const
  blocked: 0,
} as const;

interface Segment {
  start: number;
  end: number;
}

interface SegmentTippingPoints {
  gridChargeTp: number;
  gridBatteryTp: number;
  batteryExportTp: number;
  pvExportTp: number;
}

export interface DessMapperOptions {
  blockFeedInOnNegativePrices?: boolean;
}

function feedInForRow(row: PlanRow, options: DessMapperOptions): number {
  return options.blockFeedInOnNegativePrices !== false && row.ec < 0
    ? FeedIn.blocked
    : FeedIn.allowed;
}

export function mapRowsToDess(rows: PlanRow[], cfg: SolverConfig, options: DessMapperOptions = {}): DessResult {
  const segments = buildSegments(rows, cfg);
  const perSlot = new Array<DessSlot>(rows.length);

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];

    const feedin = feedInForRow(row, options);
    const feedinAllowed = feedin === FeedIn.allowed;

    // Primitive flows — all non-negative by LP construction
    /* v8 ignore start — destructured assignments are v8 counting artifacts */
    const g2l = row.g2l;
    const g2b = row.g2b;
    const pv2l = row.pv2l;
    const pv2b = row.pv2b;
    const pv2g = row.pv2g;
    const b2l = row.b2l;
    const b2g = row.b2g;
    /* v8 ignore end */

    // Flow booleans
    const hasG2L = g2l > FLOW_EPSILON_W;
    const hasG2B = g2b > FLOW_EPSILON_W;
    const hasB2L = b2l > FLOW_EPSILON_W;
    const hasB2G = b2g > FLOW_EPSILON_W;
    const hasPV2B = pv2b > FLOW_EPSILON_W;

    // PV presence (realized flows)
    // v8 ignore next — simple addition
    const pvFlow = pv2l + pv2b + pv2g;
    const hasNoPvFlow = pvFlow <= FLOW_EPSILON_W;

    // Expectations (from inputs)
    const expectedPv = row.pv;
    const expectedLoad = row.load + (row.ev_charge ?? 0);
    const pvCoversLoad = expectedPv >= (expectedLoad - FLOW_EPSILON_W);
    const loadExceedsPv = expectedLoad > (expectedPv + FLOW_EPSILON_W);

    // Combine branches: "no PV flow" behaves like "expected deficit"
    const deficitOrNoPv = hasNoPvFlow || loadExceedsPv;

    // costs and prices
    const importCost = row.ic;
    // const exportPrice = row.ec;

    // SoC refs
    const _startOfSlotSoc_Wh = t > 0 ? rows[t - 1].soc : row.soc;
    let socTarget_percent = row.soc_percent;

    // Strategy selection
    let strategy: number = Strategy.unknown;

    if (hasG2B) {
      // There's a grid charging flow which probably means electricity is cheap.
      // This means we'll want to use the grid as much as possible and store PV in the battery.
      // So we set pro-battery (and a target SoC that's higher than current SoC)
      strategy = Strategy.proBattery;
      if (g2l + g2b >= cfg.maxGridImport_W - FLOW_EPSILON_W) {
        // Grid import is at (or very close to) max capacity.
        // We want to make sure to charge at max speed, even if the load would be lower than expected.
        // So we artificially increase the target SoC.
        socTarget_percent = Math.min(socTarget_percent + 5, cfg.maxSoc_percent - 1);
      }
    } else if (hasB2G) {
      // There's an active discharge to grid which probably means electricity is expensive.
      // This means we'll want to use the battery for our own load as much as possible and export excess PV to the grid.
      // I haven't observed this case yet, but it's presumably pro-grid (and a target SoC lower than current SoC)
      // TODO: validate
      strategy = Strategy.proGrid;
    } else {
      if (deficitOrNoPv) {
        // We have a deficit to cover our planned loads.
        // Based on how this deficit is covered according to the plan, we can use the same handling for unexpected loads.
        // TODO: technically, if we have an unexpected PV surplus, we might also want to inject that into the grid. We don't handle that yet.
        // We can look if we have x2g flows (not due to inverter power cap) on the same day and determine the lowest price of any of these periods. If the current price is higher than that, we can assume excess PV should go to grid.
        if (hasB2L && !hasG2L) {
          // The battery is used to cover the deficit, so we'll do the same for unexpected loads.
          strategy = Strategy.selfConsumption;
        } else if (hasG2L && !hasB2L) {
          // The grid is used to cover the deficit, so we'll do the same for unexpected loads.
          // Target SoC should be close to current SoC or the reactive strategy will ignore the grid restrictions
          strategy = Strategy.proBattery;
        } else if (!hasB2L && !hasG2L) {
          // Predicted PV is exactly equal to predicted load, so there's no deficit handling in the plan.
          // We have thus no indication of how to handle unexpected loads.
          // We try to infer this from price signals.
          if (importCost <= findHighestGridUsageCost(rows, getSegmentForIndex(segments, t), cfg)) {
            strategy = Strategy.proBattery;
          } else {
            strategy = Strategy.selfConsumption;
          }
        } else {
          // PV deficit is served by both battery and grid.
          // We have thus no clear indication of how to handle unexpected loads.
          // A potential reason is that predicted load is higher than grid capacity which is why battery is also used.
          // Another reason might be that this quarter is a price tipping point where the last of the available battery is planned in.
          strategy = Strategy.proBattery;
        }
      } else if (pvCoversLoad) {
        // In this case, PV is expected to cover all load and we have additional PV.
        // Based on how this additional PV is used according to the plan, we can use the same handling for excess PV.
        // It is however less clear how unexpected loads should be covered in this case.
        if (hasPV2B) {
          // If we see PV2B -> use self-consumption to cover the unexpected loads by battery or pro battery to cover by grid.
          // We also use the price signals to decide.
          if (importCost <= findHighestGridUsageCost(rows, getSegmentForIndex(segments, t), cfg)) {
            strategy = Strategy.proBattery;
          } else {
            strategy = Strategy.selfConsumption;
          }
        } else {
          // In this case, we see PV2G, but I haven't observed this yet.
          // Excess PV should go to grid, so we have targetSoC or pro-grid.
          // Since we're already exporting to grid, pro-grid makes more sense. Or should we also use a price indicator here?
          // TODO: validate
          strategy = Strategy.proGrid;
        }
      } else {
        // I don't think we can reach this branch?
      }
    }

    // Restrictions: start with both blocked; allow only directions actually used
    let restrictions: number;
    if (hasG2B && hasB2G) {
      restrictions = Restrictions.none;
    } else if (hasG2B && !hasB2G) {
      restrictions = Restrictions.batteryToGrid;   // allow grid→battery
    } else if (!hasG2B && hasB2G) {
      restrictions = Restrictions.gridToBattery;   // allow battery→grid
    } else {
      restrictions = Restrictions.both;
    }

    perSlot[t] = {
      feedin,               // FeedIn.allowed | FeedIn.blocked
      restrictions,         // Restrictions.*
      strategy,             // Strategy.* or unknown
      flags: 0,
      socTarget_percent,
    };
  }

  const diagnostics = computeDessDiagnostics(rows, segments, cfg);

  return { perSlot, diagnostics };
}

/**
 * Generic helper to find extreme prices (min/max) over a segment based on flow conditions.
 */
function aggregateSegmentPrice(
  rows: PlanRow[],
  segment: Segment | null,
  condition: (row: PlanRow) => boolean,
  getPrice: (row: PlanRow) => number,
  aggregator: 'max' | 'min'
): number {
  let bestPrice = aggregator === 'max' ? -Infinity : Infinity;
  if (!segment) return bestPrice;

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    if (condition(row)) {
      const price = getPrice(row);
      bestPrice = aggregator === 'max' ? Math.max(bestPrice, price) : Math.min(bestPrice, price);
    }
  }
  return bestPrice;
}

/**
 * We want to find the tipping point price where battery usage is favored over grid usage.
 * Within the given segment, we look for grid→load flows and keep track of the highest price observed during these flows.
 */
function findHighestGridUsageCost(rows: PlanRow[], segment: Segment | null, cfg: SolverConfig): number {
  // maxDischargePower_W is the DC cap at the battery; PlanRow b2l/b2ev are AC
  // (post-η_inv from parseSolution). Convert AC back to DC for the saturation check
  // so a slot at the DC discharge cap isn't mis-classified as unconstrained.
  const eta_inv = (cfg.inverterEfficiency_percent ?? DEFAULT_INVERTER_EFFICIENCY_PERCENT) / 100;
  const maxDischarge = cfg.maxDischargePower_W - FLOW_EPSILON_W;
  return aggregateSegmentPrice(
    rows,
    segment,
    r => {
      if (r.g2l <= FLOW_EPSILON_W) return false;
      const dischargePower_DC = eta_inv > 0 ? (r.b2l + (r.b2ev ?? 0)) / eta_inv : 0;
      return dischargePower_DC < maxDischarge;
    },
    r => r.ic,
    'max',
  );
}

/**
 * We want to find the tipping point price where grid charging is favored.
 * Within the given segment, we look for grid→battery flows and keep track of the highest price observed during these flows.
 */
function findHighestGridChargeCost(rows: PlanRow[], segment: Segment | null): number {
  return aggregateSegmentPrice(rows, segment, r => r.g2b > FLOW_EPSILON_W, r => r.ic, 'max');
}

/**
 * We want to find the tipping point price where battery exporting is favored.
 * Within the given segment, we look for battery→grid flows and keep track of the LOWEST export price (revenue) observed.
 * (i.e. we were willing to sell at this low price, so we'd definitely sell at higher prices).
 */
function findLowestGridExportRevenue(rows: PlanRow[], segment: Segment | null): number {
  return aggregateSegmentPrice(rows, segment, r => r.b2g > FLOW_EPSILON_W && r.ec >= 0, r => r.ec, 'min');
}

/**
 * We want to find the tipping point price where PV export is favored.
 * Within the given segment, we look for pv→grid flows and keep track of the LOWEST export price.
 * (i.e. we were willing to export PV at this low price, so we'd definitely export at higher prices).
 */
function findLowestPvExportPrice(rows: PlanRow[], segment: Segment | null, cfg: SolverConfig): number {
  // Charge cap is DC at the battery. pv2b is already DC; g2b is AC, so DC charging
  // contribution from grid = η_inv * g2b.
  const eta_inv = (cfg.inverterEfficiency_percent ?? DEFAULT_INVERTER_EFFICIENCY_PERCENT) / 100;
  return aggregateSegmentPrice(
    rows,
    segment,
    r => {
      if (r.pv2g <= FLOW_EPSILON_W || r.ec < 0) return false;
      const chargePower_DC = r.pv2b + eta_inv * r.g2b;
      const isChargeConstrained = chargePower_DC >= cfg.maxChargePower_W - FLOW_EPSILON_W;
      const isSocConstrained = r.soc_percent >= cfg.maxSoc_percent - SOC_EPSILON_PERCENT;
      return !isChargeConstrained && !isSocConstrained;
    },
    r => r.ec,
    'min'
  );
}

/**
 * Checks if a rows's SoC is at (or very close to) either the min or max boundary.
 */
function isAtSocBoundary(row: PlanRow, cfg: SolverConfig): boolean {
  const soc = row.soc_percent;
  const atMin = soc <= cfg.minSoc_percent + SOC_EPSILON_PERCENT;
  const atMax = soc >= cfg.maxSoc_percent - SOC_EPSILON_PERCENT;
  return atMin || atMax;
}

function buildSegments(rows: PlanRow[], cfg: SolverConfig): Segment[] {
  const segments: Segment[] = [];
  let segmentStart = 0;

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];
    if (isAtSocBoundary(row, cfg)) {
      segments.push({ start: segmentStart, end: t });
      segmentStart = t + 1;
    }
  }
  segments.push({ start: segmentStart, end: rows.length - 1 });

  return segments;
}

function getSegmentForIndex(segments: Segment[], index: number): Segment | null {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (index >= segment.start && index <= segment.end) {
      return segment;
    }
  }
  /* v8 ignore next — unreachable: segments always cover all row indices */
  return null;
}

/**
 * Diagnostics helper for the UI:
 * - gridBatteryTippingPoint_cents_per_kWh: highest grid usage price
 *   in the first SoC segment (or null if none).
 * - gridChargeTippingPoint_cents_per_kWh: highest grid charge price
 *   in the first SoC segment (or null if none).
 * - batteryExportTippingPoint_cents_per_kWh: lowest battery export price
 *   in the first SoC segment (or null if none).
 * - pvExportTippingPoint_cents_per_kWh: lowest PV export price
 *   in the first SoC segment (or null if none).
 */
function computeDessDiagnostics(rows: PlanRow[], segments: Segment[], cfg: SolverConfig): DessDiagnostics {
  if (!rows.length) {
    return {
      gridBatteryTippingPoint_cents_per_kWh: -Infinity,
      gridChargeTippingPoint_cents_per_kWh: -Infinity,
      batteryExportTippingPoint_cents_per_kWh: Infinity,
      pvExportTippingPoint_cents_per_kWh: Infinity,
    };
  }
  const firstSegment = segments[0];
  const gridBatteryTp = findHighestGridUsageCost(rows, firstSegment, cfg);
  const gridChargeTp = findHighestGridChargeCost(rows, firstSegment);
  const batteryExportTp = findLowestGridExportRevenue(rows, firstSegment);
  const pvExportTp = findLowestPvExportPrice(rows, firstSegment, cfg);

  return {
    gridBatteryTippingPoint_cents_per_kWh: gridBatteryTp,
    gridChargeTippingPoint_cents_per_kWh: gridChargeTp,
    batteryExportTippingPoint_cents_per_kWh: batteryExportTp,
    pvExportTippingPoint_cents_per_kWh: pvExportTp,
  };
}

/**
 * V2 DESS mapper: simplified tipping-point-based strategy selection.
 *
 * Instead of analysing individual energy flows per slot, we compare
 * the slot's prices against per-segment tipping points:
 *   1. importCost <= gridChargeTp   → proBattery + allow grid→battery (charge)
 *   2. importCost <= gridBatteryTp  → proBattery + block both (use grid for load)
 *   3. exportPrice >= exportTp      → proGrid    + allow battery→grid (export)
 *   4. exportPrice >= pvExportTp    → proGrid    + block both (PV surplus to grid)
 *      (only when expected PV > expected load)
 *   5. else                         → selfConsumption + block both
 */
export function mapRowsToDessV2(rows: PlanRow[], cfg: SolverConfig, options: DessMapperOptions = {}): DessResult {
  const segments = buildSegments(rows, cfg);
  const perSlot = new Array<DessSlot>(rows.length);

  // Precompute tipping points once per segment (avoids O(T²) re-scanning)
  const segTps = new Map<Segment, SegmentTippingPoints>();
  for (const seg of segments) {
    segTps.set(seg, {
      gridChargeTp: findHighestGridChargeCost(rows, seg),
      gridBatteryTp: findHighestGridUsageCost(rows, seg, cfg),
      batteryExportTp: findLowestGridExportRevenue(rows, seg),
      pvExportTp: findLowestPvExportPrice(rows, seg, cfg),
    });
  }

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];

    const feedin = feedInForRow(row, options);
    const feedinAllowed = feedin === FeedIn.allowed;

    const importCost = row.ic;
    const exportPrice = row.ec;
    let socTarget_percent = row.soc_percent;

    // Expected PV/load for PV surplus check
    const pvSurplus = row.pv > row.load + row.ev_charge + FLOW_EPSILON_W;

    // Precompute flow totals for the grid-charge saturation check. Caps:
    //   maxGridImport_W is AC (utility connection limit).
    //   maxChargePower_W is DC (battery limit).
    // PlanRow flows: g2* are AC; pv2b is DC; pv2g/pv2l/b2l/b2g/b2ev/pv2ev are AC after parseSolution conversion.
    const eta_inv_v2 = (cfg.inverterEfficiency_percent ?? DEFAULT_INVERTER_EFFICIENCY_PERCENT) / 100;
    const gridImport = row.g2l + row.g2b + (row.g2ev ?? 0);
    const chargePower_DC = row.pv2b + eta_inv_v2 * row.g2b;

    // O(1) tipping-point lookup for this slot's segment
    const seg = getSegmentForIndex(segments, t);
    const { gridChargeTp, gridBatteryTp, batteryExportTp, pvExportTp } = segTps.get(seg!)!;

    let strategy: number;
    let restrictions: number;

    if (importCost <= gridChargeTp) {
      // Electricity is cheap enough to charge the battery from grid
      strategy = Strategy.proBattery;
      restrictions = Restrictions.batteryToGrid; // allow grid→battery
      if (gridImport >= cfg.maxGridImport_W - FLOW_EPSILON_W || chargePower_DC >= cfg.maxChargePower_W - FLOW_EPSILON_W) {
        // Cap the +5% boost at the first CV phase threshold to prevent target
        // oscillation: without the cap, the target overshoots into the CV region
        // (e.g. 93%→98%), then next slot CV throttles charge power, the saturation
        // check fails, and the target drops back (98%→96%). Capping at the CV
        // threshold keeps the target smooth (93%→95%, 95%→95%, 96%→96%).
        // Use the first CV threshold that is above the current SoC target as the
        // cap.  Auto-calibrated thresholds may start well below the current SoC
        // (e.g. 40%) — using such a low cap would reduce the target instead of
        // boosting it.  Fall back to maxSoc_percent when no applicable threshold.
        const applicableCv = cfg.cvPhaseThresholds?.find(th => th.soc_percent > socTarget_percent);
        const cvCap = applicableCv?.soc_percent ?? cfg.maxSoc_percent;
        socTarget_percent = Math.min(socTarget_percent + 5, cvCap, cfg.maxSoc_percent - 1);
      }
    } else if (importCost <= gridBatteryTp) {
      // Electricity is cheap enough to use grid for load (save battery)
      // In Mode 4, proBattery still needs grid→battery allowed so GX can
      // charge toward target SoC if needed.
      strategy = Strategy.proBattery;
      restrictions = Restrictions.batteryToGrid; // allow grid→battery
    } else if (feedinAllowed && exportPrice >= batteryExportTp) {
      // Export price is high enough to dump battery to grid
      strategy = Strategy.proGrid;
      restrictions = Restrictions.gridToBattery; // allow battery→grid
      // Target the END SoC of the contiguous battery-export run that starts here,
      // rather than this slot's interpolated SoC. The LP's per-slot SoC trajectory
      // can be gentle; DESS then races each per-slot target at max power, reaches
      // it within the slot, and idles covering only house load for the remainder —
      // leaving export on the table during a high-price window and deferring it to
      // a later, cheaper slot. Pulling the target to the run's end SoC tells DESS
      // to dump at max now. We extend the run only while it keeps draining
      // (b2g > 0) AND the export price never rises above this slot's, so we never
      // front-load across a price increase we'd rather wait for. SoC falls
      // monotonically during a drain, so the run-end SoC is its minimum and the
      // target only ever moves down.
      let runEnd = t;
      for (let j = t + 1; j < rows.length; j++) {
        if (rows[j].b2g <= FLOW_EPSILON_W) break;        // run stopped draining
        if (rows[j].ec > exportPrice + 1e-6) break;      // higher price ahead — wait for it
        runEnd = j;
      }
      socTarget_percent = rows[runEnd].soc_percent;
    } else if (feedinAllowed && pvSurplus && exportPrice >= pvExportTp) {
      // PV surplus goes to grid (battery likely full)
      // Only applies when we actually expect PV to exceed load
      // Allow battery→grid so GX can discharge toward target SoC
      strategy = Strategy.proGrid;
      restrictions = Restrictions.gridToBattery; // allow battery→grid
    } else {
      // Default: use battery for self-consumption
      // In Mode 4, GX needs unrestricted access to reach target SoC
      strategy = Strategy.selfConsumption;
      restrictions = Restrictions.none;
    }

    if (!feedinAllowed && restrictions === Restrictions.none) {
      restrictions = Restrictions.batteryToGrid;
    }

    perSlot[t] = {
      feedin,
      restrictions,
      strategy,
      flags: 0,
      socTarget_percent,
    };
  }

  const diagnostics = computeDessDiagnostics(rows, segments, cfg);

  return { perSlot, diagnostics };
}
