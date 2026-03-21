import type { TimeSeries, PlanRow, DessSlot, TerminalSocValuation } from '../lib/types.ts';
import type { DayFilter, Aggregation } from '../lib/predict-load.ts';
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
  batteryCost_cent_per_kWh: number;
  idleDrain_W: number;
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;
  dataSources: DataSources;
  rebalanceEnabled: boolean;
  rebalanceHoldHours: number;
  haUrl: string;
  haToken: string;
  evConfig?: EvConfig;
  autoCalculate?: AutoCalculateConfig;
  haPriceConfig?: HaPriceConfig;
  dessPriceRefresh?: DessPriceRefreshConfig;
  cvPhase?: CvPhaseConfig;
  adaptiveLearning?: AdaptiveLearningConfig;
}

export interface EvConfig {
  enabled: boolean;
  chargerPower_W: number;
  disableDischargeWhileCharging: boolean;
  scheduleSensor: string;
  scheduleAttribute: string;
  connectedSwitch: string;
  alwaysApplySchedule: boolean;
}

export interface CvPhaseConfig {
  enabled: boolean;
  thresholds: { soc_percent: number; maxChargePower_W: number }[];
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

// ----------------------------- Persisted data ---------------------------

export interface SocData {
  timestamp: string;
  value: number;
}

export interface RebalanceState {
  startMs: number | null;
}

export interface Data {
  load: TimeSeries;
  pv: TimeSeries;
  importPrice: TimeSeries;
  exportPrice: TimeSeries;
  soc: SocData;
  rebalanceState?: RebalanceState;
  evLoad?: TimeSeries;
}

// ----------------------------- Plan rows with DESS ----------------------

export interface PlanRowWithDess extends PlanRow {
  dess: DessSlot;
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

export interface PredictionActiveConfig {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
}

export interface PredictionValidationWindow {
  start: string;
  end: string;
}

/** Prediction mode for PV forecasting. Replaces the deprecated forecastResolution field. */
export type PvMode = 'hourly' | 'hybrid' | '15min';

export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;
  pvSensor: string;
  pvMode?: PvMode;
  /** @deprecated Use pvMode instead. 60 → 'hourly', 15 → 'hybrid'. */
  forecastResolution?: 15 | 60;
}

export interface PredictionConfig {
  sensors: HaSensor[];
  derived: HaDerivedSensor[];
  activeConfig?: PredictionActiveConfig;
  validationWindow?: PredictionValidationWindow;
  includeRecent?: boolean;
  pvConfig?: PvPredictionConfig;
}

/** PredictionConfig enriched with HA credentials from Settings, passed to prediction services. */
export interface PredictionRunConfig extends PredictionConfig {
  haUrl: string;
  haToken: string;
}
