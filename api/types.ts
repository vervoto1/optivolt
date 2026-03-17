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
  cvPhase?: CvPhaseConfig;
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
