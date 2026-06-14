/**
 * Shared type definitions for the OptiVolt solver pipeline.
 */

export type TerminalSocValuation = 'zero' | 'min' | 'avg' | 'max' | 'custom';

/**
 * How HA should control the charger for a given slot:
 *   fixed      — set exactly ev_charge_A amps (charger is at minimum rate; can't track dynamically)
 *   solar_only — track actual PV surplus only; may turn off if PV drops below minimum
 *   solar_grid — track PV surplus + grid headroom; no battery draw (covers grid-only slots too)
 *   max        — charge at maximum amps using all available sources (battery involved)
 *   off        — no charging
 */
export type EvChargeMode = 'off' | 'fixed' | 'solar_only' | 'solar_grid' | 'max';

/**
 * Planning-semantics label for an EV charge slot, produced by parseSolution from
 * the LP solution. SEPARATE from EvChargeMode (the hardware-actuation hint
 * consumed by dess-mapper) — do not conflate them.
 *   planned       — normal cost-optimal LP charging toward target
 *   opportunistic — charging beyond target into the opportunistic band
 *   min_soc       — mask-exempt floor charging to reach the minimum-SoC floor
 * Runtime overrides (low_price, low_soc, keep_on) live on the decision object,
 * not on the plan row.
 */
export type EvPlanMode = 'planned' | 'opportunistic' | 'min_soc';

export interface EvConfig {
  evMinChargePower_W: number;
  evMaxChargePower_W: number;
  evBatteryCapacity_Wh: number;
  evInitialSoc_percent: number;
  evTargetSoc_percent: number;
  /** Number of available charging slots before departure. Constraint emitted if <= T. */
  evDepartureSlot: number;
  /** AC-to-DC efficiency of the EV's onboard charger, as a percentage (e.g. 90 = 90%). */
  evChargeEfficiency_percent: number;
  /**
   * Number of AC phases the charger uses (1 or 3). Sets the A<->W conversion:
   * watts = amps * AC_PHASE_VOLTAGE_V * evChargePhases. Defaults to 1 (single-phase)
   * when omitted so existing callers keep their prior behavior.
   */
  evChargePhases?: number;

  // ---- Feature-parity planning controls (all optional; absent = inactive) ----
  /**
   * Earliest allowed charging slot index (inclusive). Slots before this are
   * masked (ev_charge forced to 0). Default 0 (no earliest-start restriction).
   */
  evStartSlot?: number;
  /**
   * When true, slots whose import price exceeds evMaxPrice_cents_per_kWh are
   * masked off for normal planning (the min-SoC floor stays exempt).
   */
  evApplyPriceLimit?: boolean;
  evMaxPrice_cents_per_kWh?: number;
  /**
   * Minimum-SoC safety floor (% of EV capacity). Enforced as soon as physically
   * possible via a soft, mask-exempt, fully-sourced floor flow. Soft ⇒ never
   * makes the LP infeasible; penalty ⇒ met whenever reachable.
   */
  evMinSocFloor_percent?: number;
  /**
   * Opportunistic top-up cap (% of EV capacity, > target). EV energy stored in
   * (target, cap] at departure earns a bounded reward so the car only tops up
   * beyond target when energy is cheap/surplus.
   */
  evOpportunisticCap_percent?: number;
  /** Second, higher opportunistic cap (% of EV capacity, > type-1 cap). */
  evOpportunisticType2Cap_percent?: number;
  /** When true, bias toward one contiguous charging block (MILP transition penalty). */
  evContinuous?: boolean;
  /**
   * Learned charge-acceptance taper: SoC% breakpoints above which the EV's onboard
   * charger physically accepts less power (the car's BMS tapers near full). Same
   * shape/semantics as the home-battery cvPhaseThresholds — a pure forecast input;
   * OptiVolt does not command the taper, it predicts it so the plan stops assuming
   * a flat rate to the target. Absent = flat cap (today's behaviour).
   */
  evChargeThresholds?: CvPhaseThreshold[];
}

/**
 * Fully resolved solver configuration, as produced by config-builder.
 * All scalar fields are validated and present; arrays are aligned time series.
 */
export interface SolverConfig {
  // Time series
  load_W: number[];
  pv_W: number[];
  importPrice: number[];
  exportPrice: number[];

  // Battery parameters
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  maxChargePower_W: number;
  maxDischargePower_W: number;
  maxGridImport_W: number;
  maxGridExport_W: number;
  /** Battery-only DC charge efficiency (e.g. 95 = 5% lost on the battery's own charge step). Inverter loss is modeled separately by inverterEfficiency_percent. */
  chargeEfficiency_percent: number;
  /** Battery-only DC discharge efficiency. Paired with inverterEfficiency_percent for AC-side flows. */
  dischargeEfficiency_percent: number;
  /** Inverter conversion efficiency, applied symmetrically on every AC↔DC crossing (PV→AC, battery→AC, AC→battery). 100 = lossless wire. */
  inverterEfficiency_percent: number;
  batteryCost_cent_per_kWh: number;
  idleDrain_W: number;

  // Terminal SoC valuation
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;

  // Initial state
  initialSoc_percent: number;

  // EV charging
  evLoad_W?: number[];

  // Rebalancing (optional — only present when rebalanceEnabled is true)
  rebalanceHoldSlots?: number;
  rebalanceRemainingSlots?: number;
  rebalanceTargetSoc_percent?: number;

  // Constant Voltage phase: reduced charge power at high SoC
  cvPhaseThresholds?: CvPhaseThreshold[];

  // Discharge phase: reduced discharge power at low SoC
  dischargePhaseThresholds?: DischargePhaseThreshold[];

  // EV charging (optional — only present when evEnabled is true and EV is plugged in)
  ev?: EvConfig;
}

export interface CvPhaseThreshold {
  soc_percent: number;       // SoC % above which charge power is reduced
  maxChargePower_W: number;  // reduced max charge power in watts
}

export interface DischargePhaseThreshold {
  soc_percent: number;          // SoC % below which discharge power is reduced
  maxDischargePower_W: number;  // reduced max discharge power in watts
}

/**
 * A time-series source object as stored in data.json.
 */
export interface TimeSeries {
  start: string;
  step?: number;
  values: number[];
}

/**
 * A single per-slot row produced by parseSolution.
 * All flow values are in W (rounded to 3 decimal places); soc is in Wh.
 */
export interface PlanRow {
  tIdx: number;
  timestampMs: number;
  load: number;       // expected load W
  pv: number;         // expected PV W
  evLoad: number;  // expected EV load W
  originalLoad?: number; // unadjusted prediction W when a manual adjustment changed the slot
  originalPv?: number;   // unadjusted prediction W when a manual adjustment changed the slot
  ic: number;  // import price c€/kWh
  ec: number;  // export price c€/kWh
  g2l: number;   // grid → load W
  g2b: number;   // grid → battery W
  pv2l: number;  // PV → load W
  pv2b: number;  // PV → battery W
  pv2g: number;  // PV → grid W
  pvCurtail: number; // curtailed PV W
  b2l: number;   // battery → load W
  b2g: number;   // battery → grid W
  imp: number;   // total import W (g2l + g2b)
  exp: number;   // total export W (pv2g + b2g)
  importCost_cents: number;  // import energy cost for this slot, in c€
  exportCost_cents: number;  // export energy value for this slot, in c€
  soc: number;   // battery SoC Wh
  soc_percent: number;  // battery SoC %
  g2ev: number;         // grid → EV W
  pv2ev: number;        // PV → EV W
  b2ev: number;         // battery → EV W
  ev_charge: number;    // total EV charge power W
  ev_charge_A: number;  // charge current A (ev_charge / (AC_PHASE_VOLTAGE_V * evChargePhases))
  ev_charge_mode: EvChargeMode;
  ev_soc_percent: number;  // EV SoC %
  /** Planning-semantics label (separate from ev_charge_mode). Optional: only meaningful for EV-active solves. */
  ev_plan_mode?: EvPlanMode;
  /** Shortfall vs requested target SoC at this slot's EV SoC, in Wh (0 when met). Set on the departure slot. */
  ev_target_shortfall_Wh?: number;
  /** True when the requested EV target SoC is met by the departure slot (shortfall ≈ 0). */
  ev_target_met?: boolean;
}

/**
 * Tipping-point diagnostics produced by the DESS mapper.
 * Infinity / -Infinity indicate "no flow observed" in the relevant direction.
 */
export interface DessDiagnostics {
  gridBatteryTippingPoint_cents_per_kWh: number;
  gridChargeTippingPoint_cents_per_kWh: number;
  batteryExportTippingPoint_cents_per_kWh: number;
  pvExportTippingPoint_cents_per_kWh: number;
}

/**
 * A single DESS schedule slot as sent to Victron Dynamic ESS.
 */
export interface DessSlot {
  feedin: number;
  restrictions: number;
  strategy: number;
  flags: number;
  socTarget_percent: number;
}

/**
 * Full output of the DESS mapper.
 */
export interface DessResult {
  perSlot: DessSlot[];
  diagnostics: DessDiagnostics;
}

/**
 * High-level plan summary computed from solved rows.
 */
export interface PlanSummary {
  loadTotal_kWh: number;
  pvTotal_kWh: number;
  evLoadTotal_kWh: number;
  loadFromGrid_kWh: number;
  loadFromBattery_kWh: number;
  loadFromPv_kWh: number;
  gridToBattery_kWh: number;
  batteryToGrid_kWh: number;
  pvCurtailed_kWh: number;
  importEnergy_kWh: number;
  importCost_cents: number;
  exportCost_cents: number;
  netGridCost_cents: number;
  avgImportPrice_cents_per_kWh: number | null;
  gridBatteryTippingPoint_cents_per_kWh: number | null;
  gridChargeTippingPoint_cents_per_kWh: number | null;
  batteryExportTippingPoint_cents_per_kWh: number | null;
  pvExportTippingPoint_cents_per_kWh: number | null;
  rebalanceStatus: 'disabled' | 'scheduled' | 'active';
  evChargeTotal_kWh: number;
  evChargeFromGrid_kWh: number;
  evChargeFromPv_kWh: number;
  evChargeFromBattery_kWh: number;
  horizonWarnings?: string[];
}
