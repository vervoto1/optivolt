/**
 * Shared type definitions for the OptiVolt solver pipeline.
 */

export type TerminalSocValuation = 'zero' | 'min' | 'avg' | 'max' | 'custom';

/**
 * What the export tariff resolved to, attached by config-builder as
 * `SolverConfig.exportTariffInfo` (only when settings carry an `exportTariff`
 * block). Diagnostics only: buildLP never reads it.
 */
export interface ExportTariffInfo {
  /** Slots valued at the market price (minus fee, after the negative-price rule). */
  marketPricedSlots: number;
  /** Market-rule slots with no finite market price, valued at 0. */
  fallbackSlots: number;
  /** `auto` mode, no market source configured, and the horizon reaches effectiveFrom − 7 days. */
  missingMarketSource: boolean;
  /** The configured switch instant, as stored (ISO with offset). */
  effectiveFrom: string;
  /**
   * The terminal valuation that replaced the top-level one because the last
   * slot is market-priced (or fallback), or null when the top-level setting
   * was used.
   */
  terminalOverride: {
    terminalSocValuation: TerminalSocValuation;
    terminalSocCustomPrice_cents_per_kWh: number;
  } | null;
}

/**
 * How HA should control the charger for a given slot:
 *   fixed      — set exactly ev_charge_A amps (minimum, partial, or source-limited planned rate)
 *   solar_only — track actual PV surplus only; may turn off if PV drops below minimum
 *   solar_grid — track PV surplus + grid headroom; no battery draw (covers grid-only slots too)
 *   max        — set the charger to its configured maximum current
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
  /**
   * SoC the LP requires through the hold window, when lower than
   * `rebalanceTargetSoc_percent` (which stays the DESS-mapped target). Unset,
   * the LP holds at `rebalanceTargetSoc_percent`. The planner sets it to
   * target − REBALANCE_START_TOLERANCE_PERCENT once the live SoC is within that
   * tolerance, so a hold from slot 0 is reachable from the current SoC.
   */
  rebalanceHoldSoc_percent?: number;
  /**
   * Latest slot index (inclusive) at which the rebalance hold window may start.
   * Set to 0 once the hold has started so the solver cannot re-place the rest
   * of a running hold later in the horizon; the planner raises it to the
   * smallest feasible cap when the battery has sagged too far for slot 0.
   */
  rebalanceMaxStartSlot?: number;
  /**
   * Earliest slot index (inclusive) at which the rebalance hold window may
   * start; absent = 0. Clamped to [0, the resolved latest start]. Set equal to
   * `rebalanceMaxStartSlot` to fix the start exactly — the multi-day extended
   * solve inherits the firm-only plan's start this way so it never searches
   * the window (much faster than a cap alone).
   */
  rebalanceMinStartSlot?: number;

  // Constant Voltage phase: reduced charge power at high SoC
  cvPhaseThresholds?: CvPhaseThreshold[];

  // Discharge phase: reduced discharge power at low SoC
  dischargePhaseThresholds?: DischargePhaseThreshold[];

  // EV charging (optional — only present when evEnabled is true and EV is plugged in)
  ev?: EvConfig;

  // Export-tariff diagnostics (ignored by buildLP)
  exportTariffInfo?: ExportTariffInfo;

  // Multi-day horizon (plans/multi-day-horizon-plan.md). All optional: with
  // `firmSlots` absent (or >= T) buildLP emits the single-horizon LP unchanged.
  /**
   * Number of firm (published-price, executable) slots at the start of the
   * horizon; slots `t >= firmSlots` are priced with forecast prices and are
   * never executed. Truncated and clamped to [1, T] by buildLP. When
   * `firmSlots < T`, buildLP caps the slot-indexed tie-breaks at
   * `firmSlots − 1`, relaxes every binary of the forecast slots (battery
   * direction, CV/DP taper with running-minimum powers), freezes the floor
   * ratchet at the boundary, keeps the rebalance hold inside the firm part
   * (or defers it, see `resolveRebalanceWindow`), and confines the EV to firm
   * slots (departure clamped to `firmSlots + 1`; no EV when its start is at or
   * after `firmSlots`). parseSolution flags forecast rows `priceForecast: true`.
   */
  firmSlots?: number;
  /**
   * Reference SoC in Wh at the end of the firm part (slot `firmSlots − 1`),
   * normally the firm-only plan's `rows[firmSlots − 1].soc`. Used with
   * `carryOverMargin_cents_per_kWh` for the carry-over dead-band; ignored
   * unless `firmSlots < T`.
   */
  socRef_Wh?: number;
  /**
   * Carry-over risk margin r (c€ per kWh of SoC, the `riskMargin_cents_per_kWh`
   * setting). When `firmSlots < T`, `socRef_Wh` is finite and r > 0, buildLP
   * charges r per kWh of |soc_{firmSlots−1} − socRef_Wh| (two-sided dead-band,
   * variables `carry_dev_pos` / `carry_dev_neg`, row `c_carry_over`).
   */
  carryOverMargin_cents_per_kWh?: number;
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
  /** EV SoC %; null on forecast rows (the EV is not modelled past the firm part). */
  ev_soc_percent: number | null;
  /** Planning-semantics label (separate from ev_charge_mode). Optional: only meaningful for EV-active solves. */
  ev_plan_mode?: EvPlanMode;
  /** Shortfall vs requested target SoC at this slot's EV SoC, in Wh (0 when met). Set on the departure slot. */
  ev_target_shortfall_Wh?: number;
  /** True when the requested EV target SoC is met by the departure slot (shortfall ≈ 0). */
  ev_target_met?: boolean;
  /**
   * The EV target SoC (%) the LP enforced, set only on the row it is pinned to
   * (the slot ending at the resolved deadline, or the last slot when there is
   * none). Absent when the deadline lies beyond the horizon (no target enforced).
   */
  ev_target_soc_percent?: number;
  /**
   * Present (always `true`) only on rows at or after `SolverConfig.firmSlots`:
   * the slot is priced with forecast prices and must never be written to
   * Victron or acted on. Absent on firm rows and on every row of a
   * single-horizon plan, so those payloads are unchanged.
   */
  priceForecast?: true;
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
 * Energy and cost totals over a set of plan rows (the summary's own totals
 * fields, and the shape of `PlanSummary.forecast`).
 */
export interface PlanTotals {
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
  evChargeTotal_kWh: number;
  evChargeFromGrid_kWh: number;
  evChargeFromPv_kWh: number;
  evChargeFromBattery_kWh: number;
}

/**
 * Multi-day horizon status of a plan, for the UI (present only with
 * `extendedHorizon.mode` `on`).
 */
export interface ExtendedHorizonSummary {
  mode: 'on';
  /** End (exclusive, ms) of the firm (published-price) part of the plan. */
  firmEndMs: number;
  /** End (exclusive, ms) of the plan: the extended end, or `firmEndMs` when firm-only. */
  endMs: number;
  /** Forecast-priced slots in the plan (0 when firm-only). */
  extendedSlots: number;
  /**
   * Objective of the firm-only (published-price) solve, when it reported a
   * finite one. With `status: 'extended'` the plan's own objective (`/calculate`
   * `objectiveValue`) is the extended solve's, which also covers the forecast
   * slots and the carry-over dead-band, so the two are not comparable.
   */
  firmObjective?: number;
  /** The import fit `import = a·market + b` the forecast slots were priced with. */
  fit?: { a: number; b: number; source: 'fresh' | 'stored' };
  /** `extended`: the plan includes forecast slots; `firmOnly`: it is the published-price plan. */
  status: 'extended' | 'firmOnly';
  /** Why the plan is firm-only (absent when extended). */
  reason?: string;
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
  /**
   * Present only when a started rebalance hold could not be held from slot 0
   * this plan (the battery sagged below what slot 0 can recover): the latest
   * slot index the hold window was allowed to start at instead.
   */
  rebalanceHoldMaxStartSlot?: number;
  /**
   * Multi-day horizon only: totals of the forecast-priced rows. The fields
   * above then cover the firm rows only. Absent when the plan has no forecast rows.
   */
  forecast?: PlanTotals;
  /** Multi-day horizon status (present only with `extendedHorizon.mode` `on`). */
  extendedHorizon?: ExtendedHorizonSummary;
}
