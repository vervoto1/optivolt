import type { SolverConfig, TerminalSocValuation } from './types.ts';

/**
 * Default inverter efficiency used when SolverConfig.inverterEfficiency_percent
 * is omitted by a caller. MUST be kept in sync between buildLP, parseSolution,
 * and dess-mapper — otherwise the LP is solved at one efficiency while readout
 * and DESS saturation checks operate at another, silently misclassifying
 * capacity-limited slots.
 */
export const DEFAULT_INVERTER_EFFICIENCY_PERCENT = 95;

// AC line voltage per phase, used to convert EV charge current (A) <-> power (W).
// A single-phase charger delivers `A * AC_PHASE_VOLTAGE_V` watts; a three-phase
// charger delivers `A * AC_PHASE_VOLTAGE_V * 3`. The phase count is per-config
// (EvConfig.evChargePhases), so this constant is the single source for both the
// amps->watts conversion (config-builder) and the watts->amps conversion
// (parse-solution).
export const AC_PHASE_VOLTAGE_V = 230;

/**
 * Single source for the EV charge amps<->watts conversion:
 * `watts = amps * AC_PHASE_VOLTAGE_V * phases`. Three-phase delivers 3x the
 * power per amp; anything other than 3 is treated as single-phase. Used by
 * config-builder (A->W), parse-solution (W->A), and the decision service so all
 * sites agree on one factor.
 */
export function evChargeWattsPerAmp(phases: number | undefined): number {
  return AC_PHASE_VOLTAGE_V * (phases === 3 ? 3 : 1);
}

/*
 * LP unit conventions
 * ───────────────────
 * Each flow variable carries its physical power in its NATURAL unit:
 *
 *                ┌────────── DC bus ──────────┐
 *                │                            │
 *   pv_W ──────► pv_to_load    ──η_inv──►  AC load
 *   (DC)         pv_to_grid    ──η_inv──►  AC grid (export)
 *                pv_to_battery (no inv)──►  battery (charge)
 *                pv_to_ev      ──η_inv──►  AC EV charger
 *                pv_curtail    (discarded)
 *
 *   AC grid ───► grid_to_load                   (no conversion)
 *   AC grid ──η_inv──► grid_to_battery        ──► battery (charge)
 *   AC grid ───► grid_to_ev                     (no inverter; EV charger is AC-input)
 *
 *   battery ──► battery_to_load   ──η_inv──►  AC load
 *   battery ──► battery_to_grid   ──η_inv──►  AC grid (export)
 *   battery ──► battery_to_ev     ──η_inv──►  AC EV charger
 *
 * pv_to_X and battery_to_X are DC W; grid_to_X is AC W. AC↔DC crossings
 * carry an explicit η_inv (= inverterEfficiency_percent / 100) factor.
 *
 * Battery charge efficiency η_bc applies on top of η_inv when charging from grid.
 * Battery discharge efficiency η_bd applies once when draining storage; the
 * inverter loss to AC is in η_inv on the consuming side.
 *
 * EV onboard charger is AC-input, so its η_ev applies after η_inv on
 * pv_to_ev and battery_to_ev (both go DC→AC→DC), and alone on grid_to_ev.
 */

export function buildLP({
  // time series data of length T
  load_W, // expected house load in W (AC)
  pv_W, // expected PV production in W (DC, from MPPT)
  importPrice, // import price in c€/kWh
  exportPrice, // export price in c€/kWh

  // static parameters
  stepSize_m = 15,
  batteryCapacity_Wh = 204800,
  minSoc_percent = 20,
  maxSoc_percent = 100,
  maxChargePower_W = 3600,        // DC charging cap at battery
  maxDischargePower_W = 4000,     // DC discharging cap at battery (post-η_bd, on DC bus)
  maxGridImport_W = 2500,         // AC
  maxGridExport_W = 5000,         // AC
  chargeEfficiency_percent = 95,     // battery only (DC → stored)
  dischargeEfficiency_percent = 95,  // battery only (stored → DC bus)
  inverterEfficiency_percent = 95,   // applied at every AC↔DC crossing
  batteryCost_cent_per_kWh = 2,
  idleDrain_W = 40,

  // terminal SOC valuation:
  // - "zero": no valuation
  // - "min" | "avg" | "max": derived from importPrice array
  // - "custom": use terminalSocCustomPrice_cents_per_kWh
  terminalSocValuation = "zero",
  terminalSocCustomPrice_cents_per_kWh = 0,

  // variable parameters
  initialSoc_percent = 20,

  // rebalancing (MILP)
  rebalanceRemainingSlots,
  rebalanceTargetSoc_percent,

  // EV charging
  evLoad_W,

  // CV phase
  cvPhaseThresholds,

  // Discharge phase
  dischargePhaseThresholds,

  ev,
}: SolverConfig): string {
  const T = load_W.length;
  // v8 ignore next — simple length check
  if (pv_W.length !== T || importPrice.length !== T || exportPrice.length !== T) {
    throw new Error("Arrays must have same length");
  }

  // Effective load per slot: house load + EV load (uncontrollable)
  const effectiveLoad_W = new Array<number>(T);
  for (let t = 0; t < T; t++) {
    effectiveLoad_W[t] = load_W[t] + (evLoad_W?.[t] ?? 0);
  }

  // Tiebreak hierarchy (at near-zero prices, zero batteryCost):
  //   PV is preferred for the DC battery over grid charging when the slot is
  //   charging anyway, while PV still prefers load over battery if that avoids
  //   paid grid import.
  //   pv→load (0) < pv→battery (1.5e-6) < pv→ev (2e-6) < pv→grid (4e-6)
  //   grid→ev tiebreak (1e-6) < pv→ev (2e-6): PV is strictly preferred for EV at real prices.
  //   At zero prices grid→ev (1e-6) < pv→ev (2e-6), but PV still prefers load because
  //   routing PV to EV only saves 1e-6 net (grid_to_ev tiebreak - pv_to_ev tiebreak = -1e-6).
  const TIEBREAK = {
    avoidExport: 4e-6,           // prefer pv used locally over pv→grid
    pvToBattery: 1.5e-6,         // prefer DC-coupled PV→battery over grid→battery in charging slots
    gridToBattery: 4e-6,         // prefer PV→battery + grid→load over PV→load + grid→battery when import is equal
    preferPvForEv: 1e-6,         // extra cost on grid→ev and pv→ev; ensures pv→battery+grid→ev (2.5e-6) > pv→ev (2e-6)
    pvLoadOverEv: 1e-6,          // extra cost on pv→ev beyond preferPvForEv; prefer pv→load over pv→ev
    evOnPerSlot: 1e-6,           // escalating per-slot penalty on ev_on_t: breaks symmetry between equivalent charging schedules
    rebalanceStartPerSlot: 1e-6, // escalating per-window penalty on start_balance_k: breaks symmetry between equivalent rebalance windows
    avoidGridRoundTrip: 5e-7, // prefer battery→load over grid→load when battery is already discharging (must exceed HiGHS dual_feasibility_tolerance of 1e-7)
    preferEarlierCharging: 5e-7, // per-slot increasing penalty on g2b to prefer continuous charging from start of price block
    preferEarlierDischarge: 5e-7, // per-slot increasing penalty on battery→grid to front-load export within an equal-price block (must exceed HiGHS dual_feasibility_tolerance of 1e-7)
    preferEarlierEvCharging: 5e-7, // per-slot increasing penalty on the EV charge flows to front-load EV charging within an equal-price window (mirrors preferEarlierCharging; the binary ev_on penalty alone is too small to survive the production MIP gap)
    allowCurtailAtNegativePrice: 1e-8, // permit PV curtailment when import/export prices make PV economically harmful
    avoidCurtail: 1e-4, // otherwise prefer using/storing/exporting PV over curtailment
  }
  const softMinSocPenalty_cents_per_Wh = 0.05; // penalty to keep soc above minSoc when possible

  // Unit helpers
  const stepHours = stepSize_m / 60; // hours per slot
  const priceCoeff = stepHours / 1000; // converts c€/kWh * W  →  c€ over the slot
  const eta_inv = inverterEfficiency_percent / 100;
  const eta_bc = chargeEfficiency_percent / 100;
  const eta_bd = dischargeEfficiency_percent / 100;
  // Storage gained per W of charging flow over a slot.
  // PV→battery is DC→DC: only battery charge loss applies.
  // Grid→battery is AC→DC→battery: inverter loss + battery charge loss apply.
  const chargeWhPerW_pv = stepHours * eta_bc;
  const chargeWhPerW_grid = stepHours * eta_inv * eta_bc;
  // Storage drained per W of discharging flow on the DC bus.
  // battery_to_X variables are DC W on the bus (after battery's own discharge loss),
  // so storage drains by 1/η_bd Wh per W per stepHours. Inverter loss to AC is
  // accounted for in the load/export constraints via η_inv.
  const dischargeWhPerW = stepHours / eta_bd;
  const batteryCost_cents = 0.5 * batteryCost_cent_per_kWh * priceCoeff; // c€ cost per W throughput (charge+discharge)
  const idleDrain_Wh = idleDrain_W * stepHours; // Wh drained from battery per slot due to inverter idle consumption

  // Terminal SoC valuation: 1 Wh stored, fully discharged to AC, yields η_bd * η_inv W·h of AC export.
  const terminalPrice_cents_per_Wh = selectTerminalPriceCentsPerKWh(terminalSocValuation, importPrice, terminalSocCustomPrice_cents_per_kWh) / 1000 * (eta_bd * eta_inv);

  // Convert soc percentages to Wh
  const minSoc_Wh = (minSoc_percent / 100) * batteryCapacity_Wh;
  const maxSoc_Wh = (maxSoc_percent / 100) * batteryCapacity_Wh;
  const initialSoc_Wh = (initialSoc_percent / 100) * batteryCapacity_Wh;

  // Rebalancing MILP: number of slots remaining in the hold window.
  // Truncate to integer to guard against fractional values from future callers.
  // Clamp to [0, T] — D > T is unsatisfiable; D <= 0 means no rebalancing this solve.
  const D = Math.min(T, Math.max(0, Math.trunc(rebalanceRemainingSlots ?? 0)));
  // Clamp target SoC to maxSoc_percent so the model is never forced above its own upper bound.
  const safeTargetSoc_percent = Math.min(rebalanceTargetSoc_percent ?? maxSoc_percent, maxSoc_percent);
  const rebalanceTargetSoc_Wh = D > 0
    ? (safeTargetSoc_percent / 100) * batteryCapacity_Wh
    : 0;
  const startBalance = (k: number) => `start_balance_${k}`;

  // CV phase: sorted thresholds with decremental power reductions
  const cvThresholds = cvPhaseThresholds ?? [];
  const cvK = cvThresholds.length; // number of CV thresholds
  // Power step reductions: how much each threshold reduces from the previous level
  // p_0 = maxChargePower_W (full rate), p_1 = threshold[0].maxChargePower_W, p_2 = threshold[1].maxChargePower_W
  const cvPowerSteps: number[] = [];
  for (let k = 0; k < cvK; k++) {
    const prevPower = k === 0 ? maxChargePower_W : cvThresholds[k - 1].maxChargePower_W;
    cvPowerSteps.push(prevPower - cvThresholds[k].maxChargePower_W);
  }
  const cvThresholdWh: number[] = cvThresholds.map(t => (t.soc_percent / 100) * batteryCapacity_Wh);

  // Discharge phase: sorted thresholds (descending soc_percent) with decremental power reductions
  const dpThresholds = dischargePhaseThresholds ?? [];
  const dpK = dpThresholds.length; // number of discharge thresholds
  const dpPowerSteps: number[] = [];
  for (let k = 0; k < dpK; k++) {
    const prevPower = k === 0 ? maxDischargePower_W : dpThresholds[k - 1].maxDischargePower_W;
    dpPowerSteps.push(prevPower - dpThresholds[k].maxDischargePower_W);
  }
  const dpThresholdWh: number[] = dpThresholds.map(t => (t.soc_percent / 100) * batteryCapacity_Wh);

  // EV variable name helpers
  const gridToEv    = (t: number) => `grid_to_ev_${t}`;
  const pvToEv      = (t: number) => `pv_to_ev_${t}`;
  const batteryToEv = (t: number) => `battery_to_ev_${t}`;
  const evOn        = (t: number) => `ev_on_${t}`;
  const evSocVar    = (t: number) => `ev_soc_${t}`;
  // Mask-exempt minimum-SoC floor flows (fully sourced; never free energy).
  const gridToEvFloor    = (t: number) => `grid_to_ev_floor_${t}`;
  const pvToEvFloor      = (t: number) => `pv_to_ev_floor_${t}`;
  const batteryToEvFloor = (t: number) => `battery_to_ev_floor_${t}`;
  const evFloorShortfall = (t: number) => `ev_floor_shortfall_${t}`;
  const evTargetShortfall = 'ev_target_shortfall';
  const evOppBand        = 'ev_opp_band';
  const evOppBand2       = 'ev_opp_band2';
  const evTrans          = (t: number) => `ev_trans_${t}`;
  // EV charge-acceptance taper binary: 1 iff start-of-slot EV SoC >= threshold k.
  const evCvBin          = (k: number, t: number) => `ev_cv_${k}_${t}`;
  // EV target-landing relaxation binary: may be 1 only when start-of-slot EV SoC is
  // within one full slot of the target, letting that crossing slot charge partially
  // so the plan lands ON the target instead of overshooting it (forced-rate chargers).
  const evTgtBin         = (t: number) => `ev_tgt_${t}`;

  // EV derived constants (only used when ev is defined)
  const evActive        = ev != null;
  const evCapacityWh    = ev?.evBatteryCapacity_Wh ?? 0;
  const evInitialWh     = (ev?.evInitialSoc_percent ?? 0) / 100 * evCapacityWh;
  const evTargetWh      = (ev?.evTargetSoc_percent  ?? 0) / 100 * evCapacityWh;
  const evMinPow_W      = ev?.evMinChargePower_W ?? 0;
  const evMaxPow_W      = ev?.evMaxChargePower_W ?? 0;
  const evDepSlot       = ev?.evDepartureSlot ?? (T + 1);
  const eta_ev          = (ev?.evChargeEfficiency_percent ?? 100) / 100;
  // Storage gained in EV battery per W of AC delivered to the EV charger over a slot.
  const evChargeWhPerW  = stepHours * eta_ev;
  // pv_to_ev and battery_to_ev are DC; AC arriving at the EV charger = η_inv * variable.
  // So storage gained per W of those flows = η_inv * evChargeWhPerW.
  const evChargeWhPerW_dc = evChargeWhPerW * eta_inv;

  // EV charge-acceptance taper (forecast-only): SoC-dependent reductions of the EV
  // charge cap, mirroring the home-battery CV taper but keyed on the EV SoC variable.
  // Each threshold drops the effective max (and, symmetrically, the min) by a step,
  // so a forced-rate charger keeps charging — just slower — near full rather than
  // becoming infeasible. Sorted ascending SoC; steps are decremental from evMaxPow_W.
  const evCvThresholds = (evActive ? (ev?.evChargeThresholds ?? []) : [])
    .filter(th => th.soc_percent > 0 && th.maxChargePower_W > 0 && th.maxChargePower_W < evMaxPow_W)
    .sort((a, b) => a.soc_percent - b.soc_percent);
  const evCvK = evCvThresholds.length;
  const evCvThresholdWh: number[] = evCvThresholds.map(th => (th.soc_percent / 100) * evCapacityWh);
  const evCvPowerSteps: number[] = [];
  for (let k = 0; k < evCvK; k++) {
    const prevPower = k === 0 ? evMaxPow_W : evCvThresholds[k - 1].maxChargePower_W;
    evCvPowerSteps.push(prevPower - evCvThresholds[k].maxChargePower_W);
  }
  // Per-slot taper reduction term `+ Σ step·ev_cv_k_t`, reused across the min/max/total caps.
  const evCvTerms = (t: number) =>
    evCvPowerSteps.map((step, k) => ` + ${toNum(step)} ${evCvBin(k, t)}`).join('');

  // ---- Feature-parity planning controls ----
  const evStartSlot       = Math.max(0, Math.trunc(ev?.evStartSlot ?? 0));
  const evApplyPriceLimit = !!ev?.evApplyPriceLimit;
  const evMaxPrice        = ev?.evMaxPrice_cents_per_kWh ?? Number.POSITIVE_INFINITY;
  const evMinFloorWh      = (ev?.evMinSocFloor_percent ?? 0) / 100 * evCapacityWh;
  // Floor only matters when it sits above the initial SoC.
  const evFloorActive     = evActive && evMinFloorWh > evInitialWh + 1e-6;
  const evOppCapWh        = ev?.evOpportunisticCap_percent != null
    ? (ev.evOpportunisticCap_percent / 100) * evCapacityWh : 0;
  const evOppCap2Wh       = ev?.evOpportunisticType2Cap_percent != null
    ? (ev.evOpportunisticType2Cap_percent / 100) * evCapacityWh : 0;
  // Opportunistic bands are only meaningful when there is a hard departure slot
  // (the band SoC is measured at depSlot-1) and a cap above target.
  const evHasDepConstraint = evActive && evDepSlot <= T && evDepSlot > 0;
  const evOppActive  = evHasDepConstraint && evOppCapWh  > evTargetWh + 1e-6;
  const evOppActive2 = evOppActive && evOppCap2Wh > evOppCapWh + 1e-6;
  const evContinuous = !!ev?.evContinuous && evActive;

  // Target-landing relaxation. A forced-rate charger (evMin == evMax) can only move
  // SoC in whole-slot chunks, so meeting the soft target floor forces a full slot
  // that OVERSHOOTS the target. Let the single slot that crosses the target charge
  // partially by relaxing its minimum-power floor (ev_tgt_t), so the plan lands on
  // the target rather than stepping past it. ev_tgt_t may be 1 only when start-of-slot
  // SoC is within one full slot of the target (constraint below). Cost minimisation
  // then lands exactly on the target — no overshoot, no spurious above-target SoC.
  const evOneSlotMaxChargeWh = evMaxPow_W * evChargeWhPerW;
  const evTgtRelaxActive = evActive && evHasDepConstraint
    && evMinPow_W > 1e-6
    && evTargetWh > evInitialWh + 1e-6
    && evTargetWh < evCapacityWh - 1e-6
    && evOneSlotMaxChargeWh > 1e-6
    // Skip when the learned acceptance taper is active: it already relaxes the min
    // near full, and double-relaxing lets the solve land a slot-start exactly on a
    // taper SoC threshold (where the taper binary isn't strictly forced). The taper
    // is off by default, so production charging still gets target-landing.
    && evCvK === 0;
  const evTgtThresholdWh = Math.max(0, evTargetWh - evOneSlotMaxChargeWh);
  const evTgtTerm = (t: number) =>
    evTgtRelaxActive ? ` + ${toNum(evMinPow_W)} ${evTgtBin(t)}` : '';

  // A slot is masked (normal EV charge forced to 0) when it is before the
  // earliest-start window, at/after the departure slot, or — under a price
  // limit — priced above the ceiling. The min-SoC floor flow is exempt.
  const evMaskedSlot = (t: number): boolean => evActive && (
    t < evStartSlot ||
    t >= evDepSlot ||
    (evApplyPriceLimit && importPrice[t] > evMaxPrice)
  );

  // Soft-constraint penalty magnitudes (c€ per Wh of shortfall / reward).
  // BIG_PENALTY must strictly exceed the largest achievable per-Wh saving from
  // NOT charging (= most expensive per-Wh charge cost over the horizon) so the
  // solver always meets the target when physically/price-mask feasible.
  // FLOOR_PENALTY outranks BIG_PENALTY so the safety floor wins over the target.
  let maxAbsPriceCoeff = 0;
  let minChargeCostPerWh = Number.POSITIVE_INFINITY;
  if (evActive) {
    for (let t = 0; t < T; t++) {
      const a = Math.max(Math.abs(importPrice[t]), Math.abs(exportPrice[t])) * priceCoeff;
      if (a > maxAbsPriceCoeff) maxAbsPriceCoeff = a;
      // Cheapest per-Wh charge cost among slots that can actually charge.
      if (!evMaskedSlot(t) && evChargeWhPerW > 0) {
        const c = (importPrice[t] * priceCoeff) / evChargeWhPerW;
        if (c < minChargeCostPerWh) minChargeCostPerWh = c;
      }
    }
  }
  const maxChargeCostPerWh = evChargeWhPerW > 0 ? maxAbsPriceCoeff / evChargeWhPerW : 0;
  const BIG_PENALTY = Math.max(maxChargeCostPerWh * 10, softMinSocPenalty_cents_per_Wh * 10, 1);
  const FLOOR_PENALTY = BIG_PENALTY * 10;
  // Opportunistic reward (per Wh stored above target at departure). Strictly
  // below the cheapest per-Wh charge cost so grid never fills the band — only
  // surplus PV that is worth more stored than exported. Band 2 rewards slightly
  // less so band 1 fills first.
  const evOppReward1 = (evOppActive && Number.isFinite(minChargeCostPerWh))
    ? Math.max(0, minChargeCostPerWh * 0.99) : 0;
  const evOppReward2 = evOppReward1 * 0.98;
  // Small contiguity weight: penalize on/off transitions to bias one block.
  const evContWeight = TIEBREAK.evOnPerSlot * 0.5;

  // Variable name helpers
  const gridToLoad = (t: number) => `grid_to_load_${t}`;
  const gridToBattery = (t: number) => `grid_to_battery_${t}`;
  const pvToLoad = (t: number) => `pv_to_load_${t}`;
  const pvToBattery = (t: number) => `pv_to_battery_${t}`;
  const pvToGrid = (t: number) => `pv_to_grid_${t}`;
  const pvCurtail = (t: number) => `pv_curtail_${t}`;
  const batteryToLoad = (t: number) => `battery_to_load_${t}`;
  const batteryToGrid = (t: number) => `battery_to_grid_${t}`;
  const soc = (t: number) => `soc_${t}`;
  const socShortfall = (t: number) => `soc_shortfall_${t}`;
  const batteryCharging = (t: number) => `battery_charging_${t}`;
  const cvBin = (k: number, t: number) => `cv_${k}_${t}`;
  const dpBin = (k: number, t: number) => `dp_${k}_${t}`;

  const lines: string[] = [];

  // ===============
  // Objective
  // ===============
  lines.push("Minimize");
  const objTerms = [" obj:"];
  for (let t = 0; t < T; t++) {
    const importCoeff_cents = importPrice[t] * priceCoeff; // c€ per W AC imported
    const exportCoeff_cents = exportPrice[t] * priceCoeff; // c€ per W AC exported
    // 1 W of pv_to_grid (DC) → η_inv W AC exported; revenue scales with η_inv.
    const acExportCoeff_cents = eta_inv * exportCoeff_cents;

    // Aggregate coefficients for each variable
    const gridToLoadCoeff = importCoeff_cents + TIEBREAK.avoidGridRoundTrip; // import cost + tiny nudge to prefer battery→load when prices are equal
    const gridToBatteryCoeff = importCoeff_cents + batteryCost_cents + TIEBREAK.gridToBattery + t * TIEBREAK.preferEarlierCharging; // import cost + battery cost + prefer DC PV charging + slight preference for earlier charging
    const pvToGridCoeff = -acExportCoeff_cents + TIEBREAK.avoidExport; // export revenue (post-inverter) + slight penalty to prefer using PV locally
    const batteryToGridCoeff = -acExportCoeff_cents + batteryCost_cents + t * TIEBREAK.preferEarlierDischarge; // export revenue (post-inverter) + battery cost + slight preference for earlier export (symmetry-break for equal-price drain windows)
    const batteryToLoadCoeff = batteryCost_cents; // battery cost
    const pvToBatteryCoeff = batteryCost_cents + TIEBREAK.pvToBattery; // battery cost + tiny routing tiebreak
    const socShortfallCoeff = softMinSocPenalty_cents_per_Wh; // penalty for being below minSoc
    const pvCurtailCoeff =
      importPrice[t] < 0 || exportPrice[t] < 0
        ? TIEBREAK.allowCurtailAtNegativePrice
        : TIEBREAK.avoidCurtail;

    // Add each variable to the objective once with its final coefficient
    /* v8 ignore start — v8 statement counter artifact inside covered if-block */
    if (gridToLoadCoeff !== 0) objTerms.push(` + ${toNum(gridToLoadCoeff)} ${gridToLoad(t)}`);
    if (gridToBatteryCoeff !== 0) objTerms.push(` + ${toNum(gridToBatteryCoeff)} ${gridToBattery(t)}`);
    if (pvToGridCoeff !== 0) objTerms.push(` + ${toNum(pvToGridCoeff)} ${pvToGrid(t)}`);
    if (batteryToGridCoeff !== 0) objTerms.push(` + ${toNum(batteryToGridCoeff)} ${batteryToGrid(t)}`);
    if (batteryToLoadCoeff !== 0) objTerms.push(` + ${toNum(batteryToLoadCoeff)} ${batteryToLoad(t)}`);
    if (pvToBatteryCoeff !== 0) objTerms.push(` + ${toNum(pvToBatteryCoeff)} ${pvToBattery(t)}`);
    objTerms.push(` + ${toNum(pvCurtailCoeff)} ${pvCurtail(t)}`);
    /* v8 ignore end */
    if (evActive) {
      // Per-slot escalating tiebreak added equally to every EV charge flow so it
      // front-loads charging within an equal-price window WITHOUT disturbing the
      // grid/pv/battery routing preferences (those are constant offsets, preserved
      // because the same t-term is added to all three). The binary ev_on penalty
      // below is too small to survive the production MIP gap; this rides on the
      // continuous flow variables, which the simplex resolves to dual-feasibility
      // precision — so it actually biases placement earlier.
      const evEarlier = t * TIEBREAK.preferEarlierEvCharging;
      /* v8 ignore next — v8 statement counter artifact inside covered if-block */
      const gridToEvCoeff = importCoeff_cents + TIEBREAK.preferPvForEv + evEarlier;
      const pvToEvCoeff = TIEBREAK.preferPvForEv + TIEBREAK.pvLoadOverEv + evEarlier;
      const batteryToEvCoeff = batteryCost_cents + evEarlier;
      // v8 ignore next — loop body push (covered by tests that exercise evActive)
      objTerms.push(` + ${toNum(gridToEvCoeff)} ${gridToEv(t)}`);
      objTerms.push(` + ${toNum(pvToEvCoeff)} ${pvToEv(t)}`);
      if (batteryToEvCoeff !== 0) objTerms.push(` + ${toNum(batteryToEvCoeff)} ${batteryToEv(t)}`);
      // Symmetry-breaking: escalating penalty prefers earlier charging when slots are cost-equivalent.
      objTerms.push(` + ${toNum(TIEBREAK.evOnPerSlot * (t + 1))} ${evOn(t)}`);
      if (evFloorActive) {
        // Floor flows are priced exactly like their normal counterparts so the
        // mask-exempt floor energy is never free — it is paid at market.
        objTerms.push(` + ${toNum(gridToEvCoeff)} ${gridToEvFloor(t)}`);
        objTerms.push(` + ${toNum(TIEBREAK.preferPvForEv + TIEBREAK.pvLoadOverEv)} ${pvToEvFloor(t)}`);
        if (batteryCost_cents !== 0) objTerms.push(` + ${toNum(batteryCost_cents)} ${batteryToEvFloor(t)}`);
        // Soft floor penalty (per slot below the floor) — drives charging to the
        // floor ASAP; outranks the target penalty.
        objTerms.push(` + ${toNum(FLOOR_PENALTY)} ${evFloorShortfall(t)}`);
      }
    }
    objTerms.push(` + ${toNum(socShortfallCoeff)} ${socShortfall(t)}`);
  }
  // EV soft target + opportunistic reward + contiguity (objective, outside the
  // per-slot loop).
  if (evHasDepConstraint) {
    objTerms.push(` + ${toNum(BIG_PENALTY)} ${evTargetShortfall}`);
  }
  if (evOppActive && evOppReward1 > 0) {
    objTerms.push(` - ${toNum(evOppReward1)} ${evOppBand}`);
    if (evOppActive2 && evOppReward2 > 0) {
      objTerms.push(` - ${toNum(evOppReward2)} ${evOppBand2}`);
    }
  }
  if (evContinuous) {
    for (let t = 1; t < T; t++) {
      objTerms.push(` + ${toNum(evContWeight)} ${evTrans(t)}`);
    }
  }
  // Terminal SOC valuation
  if (terminalPrice_cents_per_Wh > 0) {
    objTerms.push(` - ${toNum(terminalPrice_cents_per_Wh)} ${soc(T - 1)}`);
  }
  // Rebalancing symmetry-breaking: escalating penalty prefers earlier windows when cost-equivalent.
  if (D > 0) {
    for (let k = 0; k <= T - D; k++) {
      objTerms.push(` + ${toNum(TIEBREAK.rebalanceStartPerSlot * (k + 1))} ${startBalance(k)}`);
    }
  }
  lines.push(objTerms.join(""));
  lines.push("");

  // ===============
  // Constraints
  // ===============
  lines.push("Subject To");

  // Load must be met (house load + EV load).
  // pv_to_load and battery_to_load are DC W; AC delivered = η_inv * variable.
  // grid_to_load is already AC.
  for (let t = 0; t < T; t++) {
    lines.push(` c_load_${t}: ${toNum(eta_inv)} ${pvToLoad(t)} + ${gridToLoad(t)} + ${toNum(eta_inv)} ${batteryToLoad(t)} = ${effectiveLoad_W[t]}`
    );
  }

  // PV split (DC W from PV bus). pv_to_load/grid/ev are DC W consumed; pv_curtail discards DC.
  for (let t = 0; t < T; t++) {
    const pvEvTerm = evActive
      ? ` + ${pvToEv(t)}${evFloorActive ? ` + ${pvToEvFloor(t)}` : ''}`
      : '';
    lines.push(` c_pv_split_${t}: ${pvToLoad(t)} + ${pvToBattery(t)} + ${pvToGrid(t)} + ${pvCurtail(t)}${pvEvTerm} = ${pv_W[t]}`);
  }

  // SOC evolution (includes idle drain: inverter consumes idleDrain_Wh per slot from DC battery).
  // soc_t = soc_{t-1} - idleDrain_Wh
  //        + chargeWhPerW_pv * pv_to_battery_t           (DC→DC, only η_bc)
  //        + chargeWhPerW_grid * grid_to_battery_t       (AC→DC→bat: η_inv * η_bc)
  //        - dischargeWhPerW * (battery_to_load + battery_to_grid + battery_to_ev)  (DC bus drain → 1/η_bd)
  const evBatTerm = (t: number) => {
    if (!evActive) return '';
    let s = ` + ${toNum(dischargeWhPerW)} ${batteryToEv(t)}`;
    // Floor flow also drains the home battery — count it in the SoC evolution.
    if (evFloorActive) s += ` + ${toNum(dischargeWhPerW)} ${batteryToEvFloor(t)}`;
    return s;
  };
  lines.push(` c_soc_0: ${soc(0)} - ${toNum(chargeWhPerW_grid)} ${gridToBattery(0)} - ${toNum(chargeWhPerW_pv)} ${pvToBattery(0)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(0)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(0)}${evBatTerm(0)} = ${toNum(initialSoc_Wh - idleDrain_Wh)}`);
  for (let t = 1; t < T; t++) {
    lines.push(` c_soc_${t}: ${soc(t)} - ${soc(t - 1)} - ${toNum(chargeWhPerW_grid)} ${gridToBattery(t)} - ${toNum(chargeWhPerW_pv)} ${pvToBattery(t)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(t)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(t)}${evBatTerm(t)} = ${toNum(-idleDrain_Wh)}`);
  }

  // Limits per slot
  for (let t = 0; t < T; t++) {
    // DC-side battery charge cap. pv_to_battery is DC; grid_to_battery (AC) becomes η_inv DC.
    // With CV phase binaries, the effective limit decreases as SoC rises.
    if (cvK > 0) {
      const cvTerms = cvPowerSteps.map((step, k) => ` + ${toNum(step)} ${cvBin(k, t)}`).join('');
      lines.push(` c_charge_cap_${t}: ${pvToBattery(t)} + ${toNum(eta_inv)} ${gridToBattery(t)}${cvTerms} <= ${maxChargePower_W}`);
    } else {
      lines.push(` c_charge_cap_${t}: ${pvToBattery(t)} + ${toNum(eta_inv)} ${gridToBattery(t)} <= ${maxChargePower_W}`);
    }
    // DC-side battery discharge cap. battery_to_X variables are DC W on bus.
    const batEvTerm = evActive
      ? ` + ${batteryToEv(t)}${evFloorActive ? ` + ${batteryToEvFloor(t)}` : ''}`
      : '';
    if (dpK > 0) {
      const dpTerms = dpPowerSteps.map((step, k) => ` + ${toNum(step)} ${dpBin(k, t)}`).join('');
      lines.push(` c_discharge_cap_${t}: ${batteryToLoad(t)} + ${batteryToGrid(t)}${batEvTerm}${dpTerms} <= ${maxDischargePower_W}`);
    } else {
      lines.push(` c_discharge_cap_${t}: ${batteryToLoad(t)} + ${batteryToGrid(t)}${batEvTerm} <= ${maxDischargePower_W}`);
    }

    // Grid import cap (AC). Unchanged: every grid_to_X is already AC.
    // The floor flow's grid leg is counted here too (no free import headroom).
    const gridEvTerm = evActive
      ? ` + ${gridToEv(t)}${evFloorActive ? ` + ${gridToEvFloor(t)}` : ''}`
      : '';
    lines.push(` c_grid_import_cap_${t}: ${gridToLoad(t)} + ${gridToBattery(t)}${gridEvTerm} <= ${maxGridImport_W}`);
    // Grid export cap (AC). pv_to_grid and battery_to_grid are DC; AC = η_inv * variable.
    lines.push(` c_grid_export_cap_${t}: ${toNum(eta_inv)} ${pvToGrid(t)} + ${toNum(eta_inv)} ${batteryToGrid(t)} <= ${maxGridExport_W}`);

    // Victron cannot charge and discharge the battery in the same DESS slot.
    // Charge mode binary measures DC charging power at the battery; same form as the charge cap.
    lines.push(` c_battery_charge_mode_${t}: ${pvToBattery(t)} + ${toNum(eta_inv)} ${gridToBattery(t)} - ${toNum(maxChargePower_W)} ${batteryCharging(t)} <= 0`);
    lines.push(` c_battery_discharge_mode_${t}: ${batteryToLoad(t)} + ${batteryToGrid(t)}${batEvTerm} + ${toNum(maxDischargePower_W)} ${batteryCharging(t)} <= ${toNum(maxDischargePower_W)}`);

    // Soft min SOC constraint
    lines.push(` c_min_soc_${t}: ${socShortfall(t)} + ${soc(t)} >= ${minSoc_Wh}`);

    // CV phase: cv_k_t = 1 if and only if start-of-slot SoC >= threshold.
    // Forward constraint: forces cv=1 when SoC > threshold.
    // Reverse constraint: forces cv=0 when SoC < threshold (prevents the solver
    //   from voluntarily activating CV throttling below threshold to game charge distribution).
    for (let k = 0; k < cvK; k++) {
      const tightM = maxSoc_Wh - cvThresholdWh[k];
      if (t === 0) {
        // Slot 0: start-of-slot SoC is the known initialSoc_Wh constant
        lines.push(` c_cv_${k}_${t}: ${toNum(initialSoc_Wh)} - ${toNum(tightM)} ${cvBin(k, t)} <= ${toNum(cvThresholdWh[k])}`);
        // Reverse: threshold * cv <= initialSoc (cv=1 only if initialSoc >= threshold)
        lines.push(` c_cv_rev_${k}_${t}: ${toNum(cvThresholdWh[k])} ${cvBin(k, t)} <= ${toNum(initialSoc_Wh)}`);
      } else {
        // Slot t>0: start-of-slot SoC is soc_{t-1}
        lines.push(` c_cv_${k}_${t}: ${soc(t - 1)} - ${toNum(tightM)} ${cvBin(k, t)} <= ${toNum(cvThresholdWh[k])}`);
        // Reverse: threshold * cv <= soc_{t-1} (cv=1 only if soc >= threshold)
        lines.push(` c_cv_rev_${k}_${t}: ${toNum(cvThresholdWh[k])} ${cvBin(k, t)} - ${soc(t - 1)} <= 0`);
      }
    }

    // Discharge phase: dp_k_t = 1 if and only if start-of-slot SoC <= threshold.
    // Forward constraint: forces dp=1 when SoC < threshold.
    //   soc + M * dp >= threshold  →  if soc < threshold, dp must be 1
    // Reverse constraint: forces dp=0 when SoC > threshold.
    //   soc - threshold + M * (1 - dp) >= 0  →  rearranged: -M * dp + soc >= threshold - M
    for (let k = 0; k < dpK; k++) {
      const tightM = dpThresholdWh[k] - minSoc_Wh;
      if (t === 0) {
        // Slot 0: start-of-slot SoC is the known initialSoc_Wh constant
        // Forward: initialSoc + M * dp >= threshold  →  M * dp >= threshold - initialSoc
        //   rearranged: -M * dp <= initialSoc - threshold  →  same form as CV but inverted
        lines.push(` c_dp_${k}_${t}: ${toNum(-tightM)} ${dpBin(k, t)} <= ${toNum(initialSoc_Wh - dpThresholdWh[k])}`);
        // Reverse: dp=1 only if initialSoc <= threshold
        //   threshold * (1 - dp) <= initialSoc  →  threshold - threshold * dp <= initialSoc
        //   rearranged: -threshold * dp <= initialSoc - threshold ... always true when initialSoc >= threshold
        //   Instead: initialSoc * dp <= threshold  (dp=1 only allowed when initialSoc <= threshold)
        //   But initialSoc is constant, so: if initialSoc > threshold → dp must be 0
        //   Use: (capacity - threshold) * dp <= capacity - initialSoc
        //   When initialSoc > threshold: RHS < capacity - threshold, so dp=0 forced
        //   When initialSoc <= threshold: RHS >= capacity - threshold, so dp free
        const revM = maxSoc_Wh - dpThresholdWh[k];
        lines.push(` c_dp_rev_${k}_${t}: ${toNum(revM)} ${dpBin(k, t)} <= ${toNum(maxSoc_Wh - initialSoc_Wh)}`);
      } else {
        // Slot t>0: start-of-slot SoC is soc_{t-1}
        // Forward: soc_{t-1} + M * dp >= threshold  →  -soc_{t-1} - M * dp <= -threshold
        //   rearranged: -M * dp - soc_{t-1} <= -threshold  →  or: -M * dp + soc_{t-1} >= threshold - ... no
        //   Cleaner: soc_{t-1} + tightM * dp >= threshold
        //   LP form: -soc_{t-1} - tightM * dp <= -threshold
        lines.push(` c_dp_${k}_${t}: - ${soc(t - 1)} - ${toNum(tightM)} ${dpBin(k, t)} <= ${toNum(-dpThresholdWh[k])}`);
        // Reverse: (maxSoc - threshold) * dp <= maxSoc - soc_{t-1}
        //   rearranged: (maxSoc - threshold) * dp + soc_{t-1} <= maxSoc
        const revM = maxSoc_Wh - dpThresholdWh[k];
        lines.push(` c_dp_rev_${k}_${t}: ${toNum(revM)} ${dpBin(k, t)} + ${soc(t - 1)} <= ${toNum(maxSoc_Wh)}`);
      }
    }
  }

  // MILP rebalancing: force a contiguous window of D slots to hold the battery at target SoC
  if (D > 0) {
    // Exactly-one-start constraint: exactly one window starting position is chosen
    const startVars: string[] = [];
    for (let k = 0; k <= T - D; k++) {
      startVars.push(startBalance(k));
    }
    lines.push(` c_balance_start: ${startVars.join(' + ')} = 1`);

    // Per-slot SoC forcing: soc_t >= rebalanceTargetSoc_Wh when slot t is in the chosen window
    for (let t = 0; t < T; t++) {
      const kLow = Math.max(0, t - D + 1);
      const kHigh = Math.min(t, T - D);
      if (kLow > kHigh) continue; // no valid start position covers this slot
      const terms: string[] = [];
      for (let k = kLow; k <= kHigh; k++) {
        terms.push(` - ${toNum(rebalanceTargetSoc_Wh)} ${startBalance(k)}`);
      }
      lines.push(` c_rebalance_${t}: ${soc(t)}${terms.join('')} >= 0`);
    }
  }

  // EV charging constraints (MILP).
  // EV charger is AC-input. AC arriving at the charger:
  //   = grid_to_ev (AC) + η_inv * pv_to_ev (DC→AC) + η_inv * battery_to_ev (DC→AC)
  // Min/max constraints bound that NORMAL charger AC power. The mask-exempt floor
  // flow adds a parallel AC path; the two together never exceed the charger max.
  if (evActive) {
    // Floor charge terms that feed EV SoC (mask-exempt; same source factors).
    const evSocFloorTerms = (t: number): string => evFloorActive
      ? ` - ${toNum(evChargeWhPerW)} ${gridToEvFloor(t)} - ${toNum(evChargeWhPerW_dc)} ${pvToEvFloor(t)} - ${toNum(evChargeWhPerW_dc)} ${batteryToEvFloor(t)}`
      : '';

    for (let t = 0; t < T; t++) {
      // Min relaxes by the SAME taper step as the max (see c_ev_taper below). The
      // term is additive on a >= constraint, so when ev_on=0 (flow pinned to 0) it
      // only loosens the bound — never infeasible. When charging near full it lets
      // a forced-rate charger draw below its nominal minimum as the BMS tapers.
      lines.push(` c_ev_min_${t}: ${gridToEv(t)} + ${toNum(eta_inv)} ${pvToEv(t)} + ${toNum(eta_inv)} ${batteryToEv(t)} - ${toNum(evMinPow_W)} ${evOn(t)}${evCvTerms(t)}${evTgtTerm(t)} >= 0`);
      lines.push(` c_ev_max_${t}: ${gridToEv(t)} + ${toNum(eta_inv)} ${pvToEv(t)} + ${toNum(eta_inv)} ${batteryToEv(t)} - ${toNum(evMaxPow_W)} ${evOn(t)} <= 0`);
      if (evCvK > 0) {
        // Constant-RHS max cap carrying the taper. Unlike c_ev_max (gated by
        // ev_on), the RHS here is evMaxPow_W minus the SoC-dependent reduction, so
        // it stays >= 0 even when ev_on=0 (flow=0) — modelling a SLOWDOWN near full,
        // not a cutoff. cv binaries are forced from the EV SoC just below.
        lines.push(` c_ev_taper_${t}: ${gridToEv(t)} + ${toNum(eta_inv)} ${pvToEv(t)} + ${toNum(eta_inv)} ${batteryToEv(t)}${evCvTerms(t)} <= ${toNum(evMaxPow_W)}`);
        // ev_cv_k_t = 1 iff start-of-slot EV SoC >= threshold k (mirrors c_cv_*).
        for (let k = 0; k < evCvK; k++) {
          const tightM = evCapacityWh - evCvThresholdWh[k];
          if (t === 0) {
            lines.push(` c_ev_cv_${k}_${t}: ${toNum(evInitialWh)} - ${toNum(tightM)} ${evCvBin(k, t)} <= ${toNum(evCvThresholdWh[k])}`);
            lines.push(` c_ev_cv_rev_${k}_${t}: ${toNum(evCvThresholdWh[k])} ${evCvBin(k, t)} <= ${toNum(evInitialWh)}`);
          } else {
            lines.push(` c_ev_cv_${k}_${t}: ${evSocVar(t - 1)} - ${toNum(tightM)} ${evCvBin(k, t)} <= ${toNum(evCvThresholdWh[k])}`);
            lines.push(` c_ev_cv_rev_${k}_${t}: ${toNum(evCvThresholdWh[k])} ${evCvBin(k, t)} - ${evSocVar(t - 1)} <= 0`);
          }
        }
      }
      if (evTgtRelaxActive) {
        // Allow the target-landing relaxation (ev_tgt_t = 1) only when start-of-slot
        // EV SoC is at/above the threshold (within one full slot of the target).
        // One-directional: the LP raises ev_tgt_t to relax the min when it wants a
        // partial top-off slot; it can't raise it early to dodge the forced rate.
        if (t === 0) {
          lines.push(` c_ev_tgt_${t}: ${toNum(evTgtThresholdWh)} ${evTgtBin(t)} <= ${toNum(evInitialWh)}`);
        } else {
          lines.push(` c_ev_tgt_${t}: ${toNum(evTgtThresholdWh)} ${evTgtBin(t)} - ${evSocVar(t - 1)} <= 0`);
        }
        // A relaxed slot must COMPLETE the charge to the target within that one slot
        // (end-of-slot SoC >= target). This forces a single partial top-off slot —
        // full forced rate until then — instead of dribbling a sub-rate charge across
        // several slots, which would misrepresent what the charger actually does
        // (16 A, then cut off). M = evTargetWh, so it's vacuous when ev_tgt_t = 0.
        lines.push(` c_ev_tgt_reach_${t}: ${evSocVar(t)} - ${toNum(evTargetWh)} ${evTgtBin(t)} >= 0`);
      }
      if (evFloorActive) {
        // Total charger AC power (normal + floor) is bounded by the charger max,
        // reduced by the same taper so floor+normal together respect acceptance.
        // NOTE: floor flows have no minimum-power constraint (no ev_on binary), so
        // the final partial floor slot may plan a sub-minimum rate. That is a
        // fractional-slot artifact; the actuator clamps the commanded current to
        // evMinChargeCurrent_A (= evMinChargePower_W), so the real charger never
        // runs below its minimum — it just slightly overshoots the floor.
        lines.push(` c_ev_charger_total_${t}: ${gridToEv(t)} + ${toNum(eta_inv)} ${pvToEv(t)} + ${toNum(eta_inv)} ${batteryToEv(t)} + ${gridToEvFloor(t)} + ${toNum(eta_inv)} ${pvToEvFloor(t)} + ${toNum(eta_inv)} ${batteryToEvFloor(t)}${evCvTerms(t)} <= ${toNum(evMaxPow_W)}`);
      }
    }

    // EV SoC evolution: 1 W AC into charger → η_ev W·h stored per stepHours.
    // grid_to_ev (AC) → evChargeWhPerW factor.
    // pv_to_ev / battery_to_ev (DC) → η_inv * evChargeWhPerW factor.
    // Floor flows add to the same accumulation (mask-exempt sourced charging).
    lines.push(` c_ev_soc_0: ${evSocVar(0)} - ${toNum(evChargeWhPerW)} ${gridToEv(0)} - ${toNum(evChargeWhPerW_dc)} ${pvToEv(0)} - ${toNum(evChargeWhPerW_dc)} ${batteryToEv(0)}${evSocFloorTerms(0)} = ${toNum(evInitialWh)}`);
    for (let t = 1; t < T; t++) {
      lines.push(` c_ev_soc_${t}: ${evSocVar(t)} - ${evSocVar(t - 1)} - ${toNum(evChargeWhPerW)} ${gridToEv(t)} - ${toNum(evChargeWhPerW_dc)} ${pvToEv(t)} - ${toNum(evChargeWhPerW_dc)} ${batteryToEv(t)}${evSocFloorTerms(t)} = 0`);
    }

    // Soft target SoC at the departure slot: ev_soc + shortfall >= target.
    // BIG_PENALTY on the shortfall (objective) drives the target to be met
    // whenever the window + price mask physically allow, without making the LP
    // infeasible when they do not (the old hard c_ev_target could).
    if (evHasDepConstraint) {
      lines.push(` c_ev_target: ${evSocVar(evDepSlot - 1)} + ${evTargetShortfall} >= ${toNum(evTargetWh)}`);
    }

    // Minimum-SoC floor (soft, mask-exempt). Applied each slot up to departure;
    // FLOOR_PENALTY on the per-slot shortfall (objective) drives the floor to be
    // reached ASAP. Soft ⇒ never infeasible even when house-load balance / grid
    // cap make the floor physically unreachable.
    if (evFloorActive) {
      const floorLimit = Math.min(evDepSlot, T);
      for (let t = 0; t < floorLimit; t++) {
        lines.push(` c_ev_floor_${t}: ${evSocVar(t)} + ${evFloorShortfall(t)} >= ${toNum(evMinFloorWh)}`);
      }
      // Cap total mask-exempt floor energy at the floor DEFICIT so the floor flow
      // can only reach the floor, never charge beyond it. Without this, the
      // mask-exempt floor would also satisfy the (soft) target, defeating the
      // price limit for normal target charging. (When floor == target the whole
      // target deficit is price-exempt — by design: a min-SoC that high is the
      // user asking for that SoC regardless of price.)
      const floorBudgetWh = evMinFloorWh - evInitialWh;
      const budgetTerms: string[] = [];
      for (let t = 0; t < floorLimit; t++) {
        budgetTerms.push(`${toNum(evChargeWhPerW)} ${gridToEvFloor(t)} + ${toNum(evChargeWhPerW_dc)} ${pvToEvFloor(t)} + ${toNum(evChargeWhPerW_dc)} ${batteryToEvFloor(t)}`);
      }
      // Guard against an empty LHS (floorLimit === 0, e.g. evDepartureSlot <= 0),
      // which would emit a malformed `c_ev_floor_budget:  <= x` constraint.
      if (budgetTerms.length > 0) {
        lines.push(` c_ev_floor_budget: ${budgetTerms.join(' + ')} <= ${toNum(floorBudgetWh)}`);
      }
    }

    // Opportunistic band: SoC above target at departure, bounded by the caps and
    // backed by actual SoC. ev_opp_band(2) earn a bounded reward (objective).
    if (evOppActive) {
      const bandTerms = ` - ${evOppBand}` + (evOppActive2 ? ` - ${evOppBand2}` : '');
      lines.push(` c_ev_opp_band: ${evSocVar(evDepSlot - 1)}${bandTerms} >= ${toNum(evTargetWh)}`);
    }

    // Continuity bias: ev_trans_t >= |ev_on_t - ev_on_{t-1}| (penalized) ⇒ fewer
    // on/off transitions ⇒ a single contiguous block is preferred.
    if (evContinuous) {
      for (let t = 1; t < T; t++) {
        lines.push(` c_ev_trans_a_${t}: ${evTrans(t)} - ${evOn(t)} + ${evOn(t - 1)} >= 0`);
        lines.push(` c_ev_trans_b_${t}: ${evTrans(t)} + ${evOn(t)} - ${evOn(t - 1)} >= 0`);
      }
    }
  }

  lines.push("");

  // ===============
  // Bounds
  // ===============
  // Variables that cross AC↔DC have their physical caps rescaled by 1/η_inv when bounded
  // against the cap on the other side (e.g. an AC export cap bounding a DC source).
  // Guard against eta_inv === 0; the schema clamps but be defensive.
  const invScale = eta_inv > 0 ? 1 / eta_inv : Number.POSITIVE_INFINITY;
  lines.push("Bounds");
  for (let t = 0; t < T; t++) {
    // Grid → load/battery (AC). Load branch capped by AC load; battery branch capped
    // by AC import limit AND by what the inverter can push to DC (maxChargePower_W / η_inv).
    lines.push(` 0 <= ${gridToLoad(t)} <= ${toNum(Math.min(maxGridImport_W, effectiveLoad_W[t]))}`);
    lines.push(` 0 <= ${gridToBattery(t)} <= ${toNum(Math.min(maxGridImport_W, maxChargePower_W * invScale))}`);

    // PV splits (DC). pv_to_load is bounded by the DC PV needed to satisfy the AC load:
    // η_inv * pv_to_load <= effectiveLoad → pv_to_load <= effectiveLoad / η_inv.
    lines.push(` 0 <= ${pvToLoad(t)} <= ${toNum(Math.min(pv_W[t], effectiveLoad_W[t] * invScale))}`);
    lines.push(` 0 <= ${pvToBattery(t)} <= ${toNum(Math.min(pv_W[t], maxChargePower_W))}`);
    lines.push(` 0 <= ${pvToGrid(t)} <= ${toNum(Math.min(pv_W[t], maxGridExport_W * invScale))}`);
    lines.push(` 0 <= ${pvCurtail(t)} <= ${toNum(pv_W[t])}`);

    // Battery → load/grid (DC W on bus). Discharge cap is DC; load/export caps are AC.
    lines.push(` 0 <= ${batteryToLoad(t)} <= ${toNum(Math.min(maxDischargePower_W, effectiveLoad_W[t] * invScale))}`);
    lines.push(` 0 <= ${batteryToGrid(t)} <= ${toNum(Math.min(maxDischargePower_W, maxGridExport_W * invScale))}`);

    // SOC bounds
    // minSoc handled via soft constraint
    lines.push(` ${soc(t)} <= ${toNum(maxSoc_Wh)}`);
    lines.push(` ${socShortfall(t)} >= 0`);
    if (evActive) {
      // Masked slots (before earliest-start, after departure, or above the price
      // ceiling) pin the NORMAL EV flows to 0 — which forces ev_on=0 via c_ev_min.
      // grid_to_ev is AC into the charger. pv_to_ev / battery_to_ev are DC; AC into charger = η_inv * variable,
      // so the per-variable bound on AC charger limit becomes evMaxPow_W / η_inv on the DC side.
      const masked = evMaskedSlot(t);
      lines.push(` 0 <= ${gridToEv(t)} <= ${toNum(masked ? 0 : evMaxPow_W)}`);
      lines.push(` 0 <= ${pvToEv(t)} <= ${toNum(masked ? 0 : Math.min(pv_W[t], evMaxPow_W * invScale))}`);
      lines.push(` 0 <= ${batteryToEv(t)} <= ${toNum(masked ? 0 : Math.min(maxDischargePower_W, evMaxPow_W * invScale))}`);
      lines.push(` 0 <= ${evSocVar(t)} <= ${toNum(evCapacityWh)}`);
      if (evFloorActive) {
        // Floor flows are mask-EXEMPT (the safety floor must be reachable even
        // when every slot is over the price limit), but only before departure.
        const floorOff = t >= evDepSlot;
        lines.push(` 0 <= ${gridToEvFloor(t)} <= ${toNum(floorOff ? 0 : evMaxPow_W)}`);
        lines.push(` 0 <= ${pvToEvFloor(t)} <= ${toNum(floorOff ? 0 : Math.min(pv_W[t], evMaxPow_W * invScale))}`);
        lines.push(` 0 <= ${batteryToEvFloor(t)} <= ${toNum(floorOff ? 0 : Math.min(maxDischargePower_W, evMaxPow_W * invScale))}`);
        lines.push(` ${evFloorShortfall(t)} >= 0`);
      }
    }
  }
  // EV scalar bounds (target shortfall, opportunistic bands, contiguity vars).
  if (evHasDepConstraint) lines.push(` ${evTargetShortfall} >= 0`);
  if (evOppActive) {
    lines.push(` 0 <= ${evOppBand} <= ${toNum(evOppCapWh - evTargetWh)}`);
    if (evOppActive2) lines.push(` 0 <= ${evOppBand2} <= ${toNum(evOppCap2Wh - evOppCapWh)}`);
  }
  if (evContinuous) {
    for (let t = 1; t < T; t++) lines.push(` 0 <= ${evTrans(t)} <= 1`);
  }
  lines.push("");

  const hasBinaries = T > 0 || D > 0 || cvK > 0 || dpK > 0 || evActive;
  if (hasBinaries) {
    lines.push("Binaries");
    // Battery direction binaries
    for (let t = 0; t < T; t++) {
      lines.push(` ${batteryCharging(t)}`);
    }
    // Rebalancing binaries
    if (D > 0) {
      for (let k = 0; k <= T - D; k++) {
        lines.push(` start_balance_${k}`);
      }
    }
    // CV phase binaries
    for (let k = 0; k < cvK; k++) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${cvBin(k, t)}`);
      }
    }
    // Discharge phase binaries
    for (let k = 0; k < dpK; k++) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${dpBin(k, t)}`);
      }
    }
    // EV on/off binaries
    if (evActive) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${evOn(t)}`);
      }
    }
    // EV charge-acceptance taper binaries (only when learned thresholds are present)
    for (let k = 0; k < evCvK; k++) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${evCvBin(k, t)}`);
      }
    }
    // EV target-landing relaxation binaries
    if (evTgtRelaxActive) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${evTgtBin(t)}`);
      }
    }
    lines.push("");
  }

  lines.push("End");

  return lines.join("\n");
}

function selectTerminalPriceCentsPerKWh(mode: TerminalSocValuation, prices: number[], customPrice_cents_per_kWh = 0): number {
  if (mode === "min") return Math.min(...prices);
  if (mode === "avg") return prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mode === "max") return Math.max(...prices);
  if (mode === "custom") return customPrice_cents_per_kWh;
  return 0; // "zero"
}

// Pretty numeric printing; avoids scientific notation and ensures pure numbers.
function toNum(x: number): string {
  // keep reasonable precision for LP parser; strip trailing zeros
  const s = (Math.round((+x + Number.EPSILON) * 1e12) / 1e12).toString();
  return s.includes("e") ? (+x).toFixed(12) : s;
}
