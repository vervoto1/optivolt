// Mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

import type { PlanRow, SolverConfig, DessDiagnostics, DessResult, DessSlot } from './types.ts';
import { DEFAULT_INVERTER_EFFICIENCY_PERCENT } from './build-lp.ts';

const FLOW_EPSILON_W = 1; // treat flows below this as zero
const SOC_EPSILON_PERCENT = 0.5; // treat SoC within this of min/max as at boundary
// Start-of-slot SoC within this of a CV threshold counts as at/above it (LP
// feasibility tolerance; build-lp's cv binary may be on exactly at the threshold).
const SOC_THRESHOLD_EPSILON_PERCENT = 1e-4;

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
  /**
   * Slot range (inclusive) of the rebalance hold the solver chose. Its slots
   * are mapped to a DESS hold instead of the price-driven strategy.
   */
  rebalanceWindow?: {
    startIdx: number;
    endIdx: number;
  };
}

function feedInForRow(row: PlanRow, options: DessMapperOptions): number {
  return options.blockFeedInOnNegativePrices !== false && row.ec < 0
    ? FeedIn.blocked
    : FeedIn.allowed;
}

function isRebalanceSlot(index: number, options: DessMapperOptions): boolean {
  const window = options.rebalanceWindow;
  return window != null && index >= window.startIdx && index <= window.endIdx;
}

/**
 * Generic helper to find extreme prices (min/max) over a segment based on flow conditions.
 */
function aggregateSegmentPrice(
  rows: PlanRow[],
  segment: Segment,
  condition: (row: PlanRow, t: number) => boolean,
  getPrice: (row: PlanRow) => number,
  aggregator: 'max' | 'min'
): number {
  let bestPrice = aggregator === 'max' ? -Infinity : Infinity;

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    if (condition(row, t)) {
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
function findHighestGridUsageCost(rows: PlanRow[], segment: Segment, cfg: SolverConfig): number {
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
function findHighestGridChargeCost(rows: PlanRow[], segment: Segment): number {
  return aggregateSegmentPrice(rows, segment, r => r.g2b > FLOW_EPSILON_W, r => r.ic, 'max');
}

/**
 * We want to find the tipping point price where battery exporting is favored.
 * Within the given segment, we look for battery→grid flows and keep track of the LOWEST export price (revenue) observed.
 * (i.e. we were willing to sell at this low price, so we'd definitely sell at higher prices).
 */
function findLowestGridExportRevenue(rows: PlanRow[], segment: Segment): number {
  return aggregateSegmentPrice(rows, segment, r => r.b2g > FLOW_EPSILON_W && r.ec >= 0, r => r.ec, 'min');
}

/**
 * We want to find the tipping point price where PV export is favored.
 * Within the given segment, we look for pv→grid flows and keep track of the LOWEST export price.
 * (i.e. we were willing to export PV at this low price, so we'd definitely export at higher prices).
 */
function findLowestPvExportPrice(rows: PlanRow[], segment: Segment, cfg: SolverConfig): number {
  // Charge cap is DC at the battery. pv2b is already DC; g2b is AC, so DC charging
  // contribution from grid = η_inv * g2b.
  const eta_inv = (cfg.inverterEfficiency_percent ?? DEFAULT_INVERTER_EFFICIENCY_PERCENT) / 100;
  return aggregateSegmentPrice(
    rows,
    segment,
    (r, t) => {
      if (r.pv2g <= FLOW_EPSILON_W || r.ec < 0) return false;
      const chargePower_DC = r.pv2b + eta_inv * r.g2b;
      // Against the cap in force at the slot's start SoC (CV/charge taper), so
      // PV the tapered battery could not absorb is not read as a voluntary export.
      const startSoc_percent = t === 0 ? cfg.initialSoc_percent : rows[t - 1].soc_percent;
      const isChargeConstrained = chargePower_DC >= effectiveChargeCap_W(cfg, startSoc_percent) - FLOW_EPSILON_W;
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
 * DC battery charge cap the LP enforces in a slot that starts at
 * `startSoc_percent`, mirroring `c_charge_cap_t` in build-lp: the flat
 * `maxChargePower_W` minus the decremental step of every CV threshold whose
 * binary is on (start-of-slot SoC at or above the threshold). Without
 * thresholds this is `maxChargePower_W`.
 */
export function effectiveChargeCap_W(cfg: SolverConfig, startSoc_percent: number): number {
  const thresholds = cfg.cvPhaseThresholds ?? [];
  let cap_W = cfg.maxChargePower_W;
  for (let k = 0; k < thresholds.length; k++) {
    const prevPower_W = k === 0 ? cfg.maxChargePower_W : thresholds[k - 1].maxChargePower_W;
    if (startSoc_percent >= thresholds[k].soc_percent - SOC_THRESHOLD_EPSILON_PERCENT) {
      cap_W -= prevPower_W - thresholds[k].maxChargePower_W;
    }
  }
  return cap_W;
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
 *
 * Slots inside `options.rebalanceWindow` bypass the price logic and become a
 * hold: proBattery, battery→grid blocked (grid→battery allowed) and the
 * rebalance target SoC as-is. At max SoC every window slot is its own SoC
 * segment, so the price logic would otherwise emit selfConsumption for PV
 * surplus slots (Victron then drops the target and the load drains the
 * battery) or clamp a saturated charge slot to maxSoc − 1 (which misses
 * Victron's keep-charged path for a target of 100).
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

    if (isRebalanceSlot(t, options)) {
      // Rebalance hold: keep the battery at the target and cover load from
      // grid/PV. Grid→battery stays allowed so DESS can top up; battery→grid
      // is blocked so the hold is never drained by an export. Feed-in keeps
      // the slot's price-based value (negative-price block still applies).
      // No CV / maxSoc − 1 clamp: the target is constant across the window.
      strategy = Strategy.proBattery;
      restrictions = Restrictions.batteryToGrid;
      socTarget_percent = Math.min(cfg.rebalanceTargetSoc_percent ?? cfg.maxSoc_percent, cfg.maxSoc_percent);
    } else if (importCost <= gridChargeTp) {
      // Electricity is cheap enough to charge the battery from grid
      strategy = Strategy.proBattery;
      restrictions = Restrictions.batteryToGrid; // allow grid→battery
      // Saturated = the plan charges as hard as the LP allowed in this slot:
      // at the grid import cap, or at the battery charge cap in force at the
      // slot's START SoC (the CV/charge taper lowers it as SoC rises). Testing
      // only the flat maxChargePower_W missed every taper-capped slot, so DESS
      // got no boost there, under-delivered, and the calibrator learned an even
      // lower curve from it.
      const chargeCap_W = effectiveChargeCap_W(cfg, t === 0 ? cfg.initialSoc_percent : rows[t - 1].soc_percent);
      if (gridImport >= cfg.maxGridImport_W - FLOW_EPSILON_W || chargePower_DC >= chargeCap_W - FLOW_EPSILON_W) {
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
