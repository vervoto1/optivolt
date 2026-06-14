import type { TimeSeries, PlanRow, DessSlot, TerminalSocValuation } from '../lib/types.ts';
import type { PvCurtailmentSlot } from '../lib/pv-curtailment.ts';
import type { DayFilter, Aggregation } from '../lib/load-predictor-historical.ts';
import type { HaSensor, HaDerivedSensor } from '../lib/ha-postprocess.ts';

export type { TimeSeries };

// Re-export HA types used by prediction config
export type { HaSensor, HaDerivedSensor };

// ----------------------------- Data sources -----------------------------

export type DataSource = 'vrm' | 'api' | 'ha';
export type SocSource = 'mqtt' | 'api';

export interface DataSources {
  load: DataSource;
  pv: DataSource;
  prices: DataSource;
  soc: SocSource;
  evLoad?: DataSource;
}

// ----------------------------- Settings ---------------------------------

export interface Settings {
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  maxChargePower_W: number;
  maxDischargePower_W: number;
  maxGridImport_W: number;
  maxGridExport_W: number;
  chargeEfficiency_percent: number;
  dischargeEfficiency_percent: number;
  inverterEfficiency_percent: number;
  batteryCost_cent_per_kWh: number;
  idleDrain_W: number;
  blockFeedInOnNegativePrices: boolean;
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;
  optimizerQuickSettings: string[];
  dataSources: DataSources;
  rebalanceEnabled: boolean;
  rebalanceHoldHours: number;
  haUrl: string;
  haToken: string;
  autoCalculate?: AutoCalculateConfig;
  haPriceConfig?: HaPriceConfig;
  dessPriceRefresh?: DessPriceRefreshConfig;
  shoreOptimizer?: ShoreOptimizerConfig;
  pvCurtailment?: PvCurtailmentConfig;
  cvPhase?: CvPhaseConfig;
  adaptiveLearning?: AdaptiveLearningConfig;
  essConfig?: EssConfig;
  evEnabled: boolean;
  evMinChargeCurrent_A: number;
  evMaxChargeCurrent_A: number;
  /** AC phases the EV charger uses (1 or 3). Three-phase delivers 3x the power per amp. */
  evChargePhases: number;
  evBatteryCapacity_kWh: number;
  evSocSensor: string;
  evPlugSensor: string;
  evDepartureTime: string;
  evTargetSoc_percent: number;
  evChargeEfficiency_percent: number;

  // ---- Feature-parity planning controls (port of EV Smart Charging) ----
  /** Earliest charge time (ISO local datetime). Empty = no earliest-start restriction. */
  evStartTime?: string;
  /** Never charge (normal planning) in slots whose import price exceeds evMaxPrice. */
  evApplyPriceLimit?: boolean;
  evMaxPrice_cents_per_kWh?: number;
  /** Minimum-SoC safety floor (%) reached ASAP, independent of price. */
  evMinSoc_percent?: number;
  /** Top up beyond target toward this SoC (%) when energy is cheap/surplus. */
  evOpportunisticEnabled?: boolean;
  evOpportunisticLevel_percent?: number;
  /** Second, higher opportunistic band. */
  evOpportunisticType2Enabled?: boolean;
  evOpportunisticType2Level_percent?: number;
  /** Reactive override: charge now at full power when the live buy price is at/below the level. */
  evLowPriceChargingEnabled?: boolean;
  evLowPriceChargingLevel_cents_per_kWh?: number;
  /** Reactive override: charge now when live EV SoC is below the level (priority over low-price). */
  evLowSocChargingEnabled?: boolean;
  evLowSocChargingLevel_percent?: number;
  /** Prefer a single contiguous charging block (MILP contiguity bias). */
  evContinuous?: boolean;
  /** Keep the charger energized once started within the charge window. */
  evKeepOn?: boolean;

  // ---- Actuation (OptiVolt drives the charger itself via HA service calls) ----
  /** When true, the actuator controls the physical charger. Default false. */
  evActuationEnabled?: boolean;
  /** switch.* entity that starts/stops charging. */
  evChargerSwitchEntity?: string;
  /** number.* entity for charge current in A (optional). */
  evChargerCurrentEntity?: string;
  /** Actuator tick cadence in seconds. Default 60. */
  evControlIntervalSeconds?: number;
  /** Ignore plans older than this (fail-safe). Default 1800. */
  evMaxPlanAgeSeconds?: number;
  /** On sustained error/restart: 'hold' = no write (default), 'stop' = turn off. */
  evFailSafeMode?: EvFailSafeMode;
  /** User kill-switch to suspend OptiVolt charger control. */
  evActuationPaused?: boolean;
}

export type EvFailSafeMode = 'hold' | 'stop';

export interface CvPhaseConfig {
  enabled: boolean;
  thresholds: { soc_percent: number; maxChargePower_W: number }[];
}

// ----------------------------- ESS dashboard ----------------------------

/**
 * One battery in the ESS dashboard. Entity ids are user-specific and may drift
 * (BMS firmware updates, renames), so every scalar/series entity is optional —
 * a missing or unresolved id renders as a "not found" placeholder rather than
 * blanking the tab.
 */
export interface EssBatteryConfig {
  /** Display name, e.g. "Basen Green". */
  name: string;
  /**
   * Cell voltages: either a `prefix` + `cellCount` that expands to
   * `${cellVoltagePrefix}${n}` for n in 1..cellCount, or an explicit list
   * (`cellVoltageEntities`) which wins over the prefix form.
   */
  cellVoltagePrefix?: string;
  cellCount?: number;
  cellVoltageEntities?: string[];
  /** Temperature sensors with display names (e.g. "MOS Temperature"). */
  temperatureEntities?: { entity: string; name: string }[];
  socEntity?: string;
  currentEntity?: string;
  totalVoltageEntity?: string;
  chargingPowerEntity?: string;
  dischargingPowerEntity?: string;
  capacitySettingEntity?: string;
  capacityRemainingEntity?: string;
  minCellVoltageEntity?: string;
  maxCellVoltageEntity?: string;
  balancingBinaryEntity?: string;
  balancingCurrentEntity?: string;
  /** Free-form extra entities, e.g. calibration numbers. */
  extraEntities?: { entity: string; name?: string }[];
}

export interface EssSystemConfig {
  name?: string;
  maxChargeCurrentEntity?: string;
  batteryPowerEntity?: string;
  batteryCurrentEntity?: string;
  batteryVoltageEntity?: string;
  socEntity?: string;
  extraEntities?: { entity: string; name?: string }[];
}

export type EssHistoryPeriod = '5minute' | 'hour';

export interface EssConfig {
  enabled: boolean;
  batteries: EssBatteryConfig[];
  system?: EssSystemConfig;
  /** Trend-chart lookback window, in hours. Default 24. */
  historyWindowHours: number;
  /** Statistics aggregation granularity for trends. Default '5minute'. */
  historyPeriod: EssHistoryPeriod;
  /** Live-state poll cadence while the tab is open, in seconds. Default 30. */
  refreshIntervalSeconds: number;
}

export interface AutoCalculateConfig {
  enabled: boolean;
  intervalMinutes: number;
  updateData: boolean;
  writeToVictron: boolean;
}

export interface DessPriceRefreshConfig {
  enabled: boolean;
  time: string;             // HH:MM local time, e.g. "23:00"
  durationMinutes: number;  // how long to stay in Mode 1, e.g. 15
}

export interface HaPriceConfig {
  sensor: string;
  todayAttribute: string;
  tomorrowAttribute: string;
  timeKey: string;
  valueKey: string;
  valueMultiplier: number;
  importEqualsExport: boolean;
  priceInterval: number;
}

export interface ShoreOptimizerConfig {
  enabled: boolean;
  dryRun: boolean;
  tickMs: number;
  stepA: number;
  minShoreA: number;
  maxShoreA: number;
  minChargingPowerW: number;
  gateOnDessSchedule: boolean;
  portalId: string;
  multiInstance: number;
  acInputIndex: number;
  mpptInstance: number;
  batteryInstance: number;
}

export interface PvCurtailmentConfig {
  enabled: boolean;
  dryRun: boolean;
  tickMs: number;
  minPvPowerW: number;
  minGridHeadroomW: number;
  negativePriceThreshold_cents_per_kWh: number;
  portalId: string;
  acsystemInstance: number;
  enphaseSwitchEntity: string;
}

// ----------------------------- Persisted data ---------------------------

export interface SocData {
  timestamp: string;
  value: number;
}

export interface RebalanceState {
  startMs: number | null;
}

export type PredictionAdjustmentSeries = 'load' | 'pv';
export type PredictionAdjustmentMode = 'set' | 'add';

export interface PredictionAdjustment {
  id: string;
  series: PredictionAdjustmentSeries;
  mode: PredictionAdjustmentMode;
  value_W: number;
  start: string;
  end: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Data {
  load: TimeSeries;
  pv: TimeSeries;
  importPrice: TimeSeries;
  exportPrice: TimeSeries;
  soc: SocData;
  lastFullSocAt?: string | null;
  rebalanceState?: RebalanceState;
  evLoad?: TimeSeries;
  predictionAdjustments?: PredictionAdjustment[];
}

// ----------------------------- Plan rows with DESS ----------------------

export interface PlanRowWithDess extends PlanRow {
  dess: DessSlot;
  pvControl?: PvCurtailmentSlot;
}

// ----------------------------- Adaptive learning -------------------------

export interface AdaptiveLearningConfig {
  enabled: boolean;
  mode: 'suggest' | 'auto';
  /** Minimum days of data before calibration is applied */
  minDataDays: number;
}

export interface PlanSnapshot {
  planId: string;
  createdAtMs: number;
  initialSoc_percent: number;
  slots: PlanSnapshotSlot[];
  config: PlanSnapshotConfig;
}

export interface PlanSnapshotSlot {
  timestampMs: number;
  predictedSoc_percent: number;
  chargePower_W: number;   // g2b + pv2b
  dischargePower_W: number; // b2l + b2g
  predictedLoad_W: number; // expected load at this slot
  predictedPv_W: number;   // expected PV at this slot
  strategy: number;
}

export interface PlanSnapshotConfig {
  chargeEfficiency_percent: number;
  dischargeEfficiency_percent: number;
  inverterEfficiency_percent: number;
  maxChargePower_W: number;
  maxDischargePower_W: number;
  batteryCapacity_Wh: number;
  idleDrain_W: number;
  stepSize_m: number;
}

export interface SocSample {
  timestampMs: number;
  soc_percent: number;
  actualLoad_W?: number;
  actualPv_W?: number;
}

export interface SlotDeviation {
  timestampMs: number;
  predictedSoc_percent: number;
  actualSoc_percent: number;
  deviation_percent: number;
}

export interface PlanAccuracyReport {
  planId: string;
  createdAtMs: number;
  evaluatedAtMs: number;
  slotsCompared: number;
  meanDeviation_percent: number;
  maxDeviation_percent: number;
  deviations: SlotDeviation[];
}

/** Per-SoC-band prediction accuracy curve: 100 entries indexed by SoC% (0–99). */
export type AccuracyCurve = number[];

/** Per-SoC-band sample counts: 100 entries indexed by SoC% (0–99). */
export type BandSampleCounts = number[];

export interface CalibrationResult {
  /** Per-SoC charge prediction accuracy (100 entries, index = SoC%). Each value is a multiplier, e.g. 0.82 = 82% of predicted charge occurred. */
  chargeCurve: AccuracyCurve;
  /** Per-SoC discharge prediction accuracy (100 entries, index = SoC%). */
  dischargeCurve: AccuracyCurve;
  /** Number of calibration samples per SoC band for charge. */
  chargeSamples: BandSampleCounts;
  /** Number of calibration samples per SoC band for discharge. */
  dischargeSamples: BandSampleCounts;
  /** Aggregate charge prediction accuracy (weighted average). */
  effectiveChargeRate: number;
  /** Aggregate discharge prediction accuracy (weighted average). */
  effectiveDischargeRate: number;
  sampleCount: number;
  confidence: number;             // 0..1
  lastCalibratedMs: number;
}

// ----------------------------- Prediction config ------------------------

export interface PredictionValidationWindow {
  start: string;
  end: string;
}

/** Prediction mode for PV forecasting. Replaces the deprecated forecastResolution field. */
export type PvMode = 'hourly' | 'hybrid' | '15min';
export type PvModel = 'clearSkyRatio' | 'robustLinear';

export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;
  pvSensor: string;
  pvMode?: PvMode;
  pvModel?: PvModel;
  /** @deprecated Use pvMode instead. 60 → 'hourly', 15 → 'hybrid'. */
  forecastResolution?: 15 | 60;
}

export interface PredictionConfig {
  sensors: HaSensor[];
  derived: HaDerivedSensor[];
  activeType?: 'historical' | 'fixed';
  historicalPredictor?: { sensor: string; lookbackWeeks: number; dayFilter: DayFilter; aggregation: Aggregation };
  fixedPredictor?: { load_W: number };
  validationWindow?: PredictionValidationWindow;
  includeRecent?: boolean;
  pvConfig?: PvPredictionConfig;
}

/** PredictionConfig enriched with HA credentials from Settings, passed to prediction services. */
export interface PredictionRunConfig extends PredictionConfig {
  haUrl: string;
  haToken: string;
}
