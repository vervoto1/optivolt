// v8 ignore next — type-only import
import type {
  Settings,
  DataSources,
  AutoCalculateConfig,
  HaPriceConfig,
  DessPriceRefreshConfig,
  ShoreOptimizerConfig,
  PvCurtailmentConfig,
  CvPhaseConfig,
  BatteryChargeControlConfig,
  BatteryBalanceControlConfig,
  AdaptiveLearningConfig,
  PredictionAutoSelectConfig,
  EssConfig,
  EssBatteryConfig,
  EssSystemConfig,
  ExportTariffConfig,
  ExtendedHorizonConfig,
} from '../types.ts';
import { HttpError } from '../http-errors.ts';
import { parseEffectiveFrom } from '../../lib/export-tariff.ts';
import {
  AUTO_FORECAST_URL,
  PRICE_FORECAST_REGIONS,
  forecastUrlSettingError,
  isAutoForecastUrl,
} from '../../lib/price-forecast.ts';
import {
  assertObject,
  clampInt,
  isObject,
  expectBoolean,
  expectEnum,
  expectFiniteNumber,
  expectString,
} from './schema-validators.ts';

export type SettingsPatch = Partial<Settings> & {
  dataSources?: Partial<DataSources>;
  autoCalculate?: Partial<AutoCalculateConfig>;
  haPriceConfig?: Partial<HaPriceConfig>;
  dessPriceRefresh?: Partial<DessPriceRefreshConfig>;
  shoreOptimizer?: Partial<ShoreOptimizerConfig>;
  pvCurtailment?: Partial<PvCurtailmentConfig>;
  exportTariff?: Partial<ExportTariffConfig>;
  extendedHorizon?: Partial<ExtendedHorizonConfig>;
  cvPhase?: Partial<CvPhaseConfig>;
  batteryChargeControl?: Partial<BatteryChargeControlConfig>;
  batteryBalanceControl?: Partial<BatteryBalanceControlConfig>;
  adaptiveLearning?: Partial<AdaptiveLearningConfig>;
  predictionAutoSelect?: Partial<PredictionAutoSelectConfig>;
  essConfig?: Partial<EssConfig>;
};

const HH_MM = /^\d{2}:\d{2}$/;

/**
 * Bounds for the `predictionAutoSelect` numeric fields. The HTML `min`/`max`
 * attributes on the Strategy Selection card mirror these.
 *
 * The margin floor is 1 %, not 0: at 0 the selector switches to anything
 * strictly better every day, which is exactly the flapping the hysteresis
 * exists to prevent.
 */
export const AUTO_SELECT_LIMITS = {
  minImprovement_percent: { min: 1, max: 50 },
  windowDays: { min: 14, max: 56 },
} as const;
/**
 * Bounds for the DESS price-refresh window. The ceiling is a hard one: the
 * window is found by `findDailyWindowStart`, which looks at today's and
 * yesterday's start, so a duration of a day or more is open at every instant —
 * DESS would be switched to Mode 1 once and never restored, with every
 * schedule write skipped until a restart. (The settings form caps the input
 * at 60 minutes; the HTML attribute is advisory, this is not.)
 */
export const DESS_PRICE_REFRESH_LIMITS = {
  durationMinutes: { min: 1, max: 24 * 60 - 1 },
} as const;
/**
 * Bounds for `rebalanceHoldHours`. A rebalance hold keeps the pack at the
 * target with battery-to-grid export blocked for the whole window, so a typo
 * (e.g. 30 instead of 3) would block discharge for more than a day; 12 h is
 * well above any balancing hold a BMS needs. The settings form's `max`
 * attribute mirrors the ceiling. A POST outside the range is rejected; a
 * stored value is clamped on load (as the floor already was).
 */
export const REBALANCE_HOLD_HOURS_LIMITS = { min: 0, max: 12 } as const;
/**
 * The `exportTariff` defaults (mirrored in default-settings.json). A stored
 * field that fails validation falls back to its default here, with a warning.
 */
export const EXPORT_TARIFF_DEFAULTS: Readonly<ExportTariffConfig> = {
  mode: 'auto',
  effectiveFrom: '2027-01-01T00:00:00+01:00',
  fee_cents_per_kWh: 0,
  negativePrice: 'floorZero',
  terminalSocValuation: 'tailMin',
  terminalTail_h: 6,
};
export const EXPORT_TARIFF_TAIL_HOURS_LIMITS = { min: 1, max: 24 } as const;
const EXPORT_TARIFF_MODES = ['auto', 'netMetering', 'marketPrice'] as const;
const EXPORT_NEGATIVE_PRICE_RULES = ['floorZero', 'passThrough'] as const;
const EXPORT_TERMINAL_VALUATIONS = ['tailMin', 'zero', 'min', 'avg', 'max', 'custom'] as const;
/**
 * The `extendedHorizon` defaults (mirrored in default-settings.json). As with
 * `exportTariff`, a stored field that fails validation falls back to its
 * default here, with a warning; a POST with a bad value is rejected.
 */
export const EXTENDED_HORIZON_DEFAULTS: Readonly<ExtendedHorizonConfig> = {
  mode: 'off',
  extraDays: 3,
  forecastUrl: AUTO_FORECAST_URL,
  region: 'NL',
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1.0,
  refreshMinutes: 60,
};
/**
 * Bounds for the `extendedHorizon` numbers. `extraDays` is a whole number;
 * the refresh floor keeps the public feed's fair-use terms, and its ceiling
 * keeps the forecast younger than the 12 h after which it counts as missing.
 */
export const EXTENDED_HORIZON_LIMITS = {
  extraDays: { min: 1, max: 4 },
  importVat_percent: { min: 0, max: 100 },
  // At most 10 h: a refresh is then due well before the 12 h staleness
  // (price-forecast-service MAX_REFRESH_AGE_MS).
  refreshMinutes: { min: 30, max: 600 },
} as const;
const EXTENDED_HORIZON_MODES = ['off', 'collect', 'on'] as const;
const HA_WS_URL = /^wss?:\/\/[^/]+(?::\d+)?\/api\/websocket\/?$/i;
const MAX_SAFE_SHORE_A = 25;

const NUMERIC_FIELDS: (keyof Settings)[] = [
  'stepSize_m', 'batteryCapacity_Wh', 'minSoc_percent', 'maxSoc_percent',
  'maxChargePower_W', 'maxDischargePower_W',
  'maxGridImport_W', 'maxGridExport_W', 'chargeEfficiency_percent',
  'dischargeEfficiency_percent', 'inverterEfficiency_percent',
  'batteryCost_cent_per_kWh', 'idleDrain_W',
  'terminalSocCustomPrice_cents_per_kWh', 'rebalanceHoldHours',
];

/**
 * Pre-v0.7.20 settings did not have inverterEfficiency_percent.
 * The legacy chargeEfficiency_percent / dischargeEfficiency_percent values
 * were applied as a single lumped factor, which silently bundled the
 * inverter's DC↔AC conversion into the battery efficiency. The new model
 * splits them. To preserve the user's existing combined grid→battery /
 * battery-export round-trip behavior we back out an inverter value that,
 * times the (rescaled) battery efficiency, equals the legacy combined value.
 *
 * For default-equal settings (e.g. 95/95) this gives ~97.47/97.47/97.47.
 * For asymmetric legacy values we anchor the inverter at sqrt(max(legacy))
 * so neither battery efficiency exceeds 100%.
 */
function autoSplitLegacyEfficiency(settings: Settings): void {
  // Already migrated — leave alone.
  if (Number.isFinite(settings.inverterEfficiency_percent)) return;

  const legacy_charge = Number.isFinite(settings.chargeEfficiency_percent)
    ? Math.max(0.01, Math.min(100, settings.chargeEfficiency_percent)) / 100
    : 0.95;
  const legacy_discharge = Number.isFinite(settings.dischargeEfficiency_percent)
    ? Math.max(0.01, Math.min(100, settings.dischargeEfficiency_percent)) / 100
    : 0.95;
  const anchor = Math.max(legacy_charge, legacy_discharge);
  const inverter = Math.sqrt(anchor);
  settings.inverterEfficiency_percent = Math.max(1, Math.min(100, Math.round(inverter * 100)));
  settings.chargeEfficiency_percent = Math.max(1, Math.min(100, Math.round((legacy_charge / inverter) * 100)));
  settings.dischargeEfficiency_percent = Math.max(1, Math.min(100, Math.round((legacy_discharge / inverter) * 100)));
}

function normalizeSocPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

/**
 * Normalize the "ready by" deadline to a wall-clock time-of-day (`"HH:MM"`) or
 * `""` (unset). A legacy absolute datetime (pre-0.7.38) is migrated down to its
 * local time-of-day so an old stored deadline keeps working under the new
 * time-of-day + today/tomorrow model. Invalid input → `""`.
 */
function normalizeDepartureTime(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const min = Number(hm[2]);
    if (h > 23 || min > 59) return '';
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (Number.isFinite(d.getTime())) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return '';
}

function normalizeThresholds(thresholds: unknown): CvPhaseConfig['thresholds'] {
  if (!Array.isArray(thresholds)) {
    throw new HttpError(400, 'cvPhase.thresholds must be an array');
  }

  const normalized = thresholds.map((threshold, idx) => {
    assertObject(threshold, `cvPhase.thresholds[${idx}]`);
    return {
      soc_percent: normalizeSocPercent(expectFiniteNumber(threshold.soc_percent, `cvPhase.thresholds[${idx}].soc_percent`)),
      maxChargePower_W: Math.max(0, Math.round(expectFiniteNumber(threshold.maxChargePower_W, `cvPhase.thresholds[${idx}].maxChargePower_W`))),
    };
  });

  return normalized
    .filter(t => t.soc_percent > 0 && t.maxChargePower_W > 0)
    .sort((a, b) => a.soc_percent - b.soc_percent);
}

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const merged: Settings = {
    ...base,
    ...patch,
    /* v8 ignore start — ternary null branches for missing patch fields are untestable when patch is always {sources:{api}} */
    dataSources: patch.dataSources ? { ...base.dataSources, ...patch.dataSources } : base.dataSources,
    autoCalculate: patch.autoCalculate ? { ...base.autoCalculate, ...patch.autoCalculate } as AutoCalculateConfig : base.autoCalculate,
    haPriceConfig: patch.haPriceConfig ? { ...base.haPriceConfig, ...patch.haPriceConfig } as HaPriceConfig : base.haPriceConfig,
    dessPriceRefresh: patch.dessPriceRefresh ? { ...base.dessPriceRefresh, ...patch.dessPriceRefresh } as DessPriceRefreshConfig : base.dessPriceRefresh,
    shoreOptimizer: patch.shoreOptimizer ? { ...base.shoreOptimizer, ...patch.shoreOptimizer } as ShoreOptimizerConfig : base.shoreOptimizer,
    pvCurtailment: patch.pvCurtailment ? { ...base.pvCurtailment, ...patch.pvCurtailment } as PvCurtailmentConfig : base.pvCurtailment,
    exportTariff: patch.exportTariff ? { ...base.exportTariff, ...patch.exportTariff } as ExportTariffConfig : base.exportTariff,
    extendedHorizon: patch.extendedHorizon ? { ...base.extendedHorizon, ...patch.extendedHorizon } as ExtendedHorizonConfig : base.extendedHorizon,
    cvPhase: patch.cvPhase ? { ...base.cvPhase, ...patch.cvPhase } as CvPhaseConfig : base.cvPhase,
    batteryChargeControl: patch.batteryChargeControl ? { ...base.batteryChargeControl, ...patch.batteryChargeControl } as BatteryChargeControlConfig : base.batteryChargeControl,
    batteryBalanceControl: patch.batteryBalanceControl ? { ...base.batteryBalanceControl, ...patch.batteryBalanceControl } as BatteryBalanceControlConfig : base.batteryBalanceControl,
    adaptiveLearning: patch.adaptiveLearning ? { ...base.adaptiveLearning, ...patch.adaptiveLearning } as AdaptiveLearningConfig : base.adaptiveLearning,
    predictionAutoSelect: patch.predictionAutoSelect ? { ...base.predictionAutoSelect, ...patch.predictionAutoSelect } as PredictionAutoSelectConfig : base.predictionAutoSelect,
    // Deep-merge essConfig so a PATCH of one scalar (e.g. historyWindowHours)
    // does not shallow-replace the whole block and wipe `batteries`.
    essConfig: patch.essConfig ? { ...base.essConfig, ...patch.essConfig } as EssConfig : base.essConfig,
    /* v8 ignore end */
  };

  // Treat omitted or empty write-only tokens as "keep existing".
  if (!Object.prototype.hasOwnProperty.call(patch, 'haToken') || patch.haToken === '') {
    merged.haToken = base.haToken;
  }

  return merged;
}

type OrderedPairKey = 'minSoc_percent' | 'maxSoc_percent' | 'evMinChargeCurrent_A' | 'evMaxChargeCurrent_A';

/**
 * Keep a min/max pair ordered. On a save (`savingPatch` given), a pair the
 * patch inverts is rejected with a 400 naming the patch key, so a half-typed
 * value (max SoC "8" on the way to "85" with min 20) is refused instead of
 * being stored swapped. When the patch carries both keys, the one whose value
 * it changes is blamed (min when it changes both). When loading a stored
 * file, or when the patch touches neither key, an inverted pair is repaired
 * by swapping it.
 */
function orderPair(
  s: Settings,
  minKey: OrderedPairKey,
  maxKey: OrderedPairKey,
  options: NormalizeSettingsOptions,
): void {
  const min = s[minKey];
  const max = s[maxKey];
  if (max >= min) return;
  const { savingPatch, previous } = options;
  if (savingPatch) {
    const has = (key: string) => Object.prototype.hasOwnProperty.call(savingPatch, key) && savingPatch[key] !== undefined;
    const changes = (key: OrderedPairKey) => has(key) && (previous == null || previous[key] !== s[key]);
    const minError = () => new HttpError(400, `${minKey} (${min}) must not be above ${maxKey} (${max})`);
    const maxError = () => new HttpError(400, `${maxKey} (${max}) must not be below ${minKey} (${min})`);
    if (changes(minKey)) throw minError();
    if (changes(maxKey)) throw maxError();
    if (has(minKey)) throw minError();
    if (has(maxKey)) throw maxError();
  }
  s[minKey] = max;
  s[maxKey] = min;
}

export interface NormalizeSettingsOptions {
  /**
   * The POST /settings patch being saved. With it, a min/max pair the patch
   * inverts is rejected (400) rather than swapped; see orderPair.
   */
  savingPatch?: Record<string, unknown>;
  /**
   * The stored settings the patch is merged onto. When the patch carries both
   * keys of an inverted pair, the key whose value it changes is the one named.
   */
  previous?: Settings;
}

export function normalizeSettings(settings: Settings, options: NormalizeSettingsOptions = {}): Settings {
  const normalized: Settings = { ...settings };

  // Migrate pre-v0.7.20 settings that lack inverterEfficiency_percent.
  // Must run before NUMERIC_FIELDS validation, which would otherwise reject undefined.
  autoSplitLegacyEfficiency(normalized);

  for (const field of NUMERIC_FIELDS) {
    normalized[field] = expectFiniteNumber(normalized[field], field) as never;
  }

  normalized.stepSize_m = Math.max(1, Math.round(normalized.stepSize_m));
  normalized.batteryCapacity_Wh = Math.max(1, Math.round(normalized.batteryCapacity_Wh));
  normalized.maxChargePower_W = Math.max(0, Math.round(normalized.maxChargePower_W));
  normalized.maxDischargePower_W = Math.max(0, Math.round(normalized.maxDischargePower_W));
  normalized.maxGridImport_W = Math.max(0, Math.round(normalized.maxGridImport_W));
  normalized.maxGridExport_W = Math.max(0, Math.round(normalized.maxGridExport_W));
  normalized.batteryCost_cent_per_kWh = Math.max(0, normalized.batteryCost_cent_per_kWh);
  normalized.idleDrain_W = Math.max(0, normalized.idleDrain_W);
  normalized.rebalanceHoldHours = Math.max(REBALANCE_HOLD_HOURS_LIMITS.min,
    Math.min(REBALANCE_HOLD_HOURS_LIMITS.max, normalized.rebalanceHoldHours));
  normalized.chargeEfficiency_percent = normalizeSocPercent(normalized.chargeEfficiency_percent);
  normalized.dischargeEfficiency_percent = normalizeSocPercent(normalized.dischargeEfficiency_percent);
  normalized.inverterEfficiency_percent = normalizeSocPercent(normalized.inverterEfficiency_percent);
  normalized.minSoc_percent = normalizeSocPercent(normalized.minSoc_percent);
  normalized.maxSoc_percent = normalizeSocPercent(normalized.maxSoc_percent);

  orderPair(normalized, 'minSoc_percent', 'maxSoc_percent', options);

  normalized.optimizerQuickSettings = Array.isArray(normalized.optimizerQuickSettings)
    ? normalized.optimizerQuickSettings.filter((id): id is string => typeof id === 'string')
    : [];

  // v8 ignore next — null path of ?? already covered, v8 double-counts in String() call
  normalized.haUrl = String(normalized.haUrl ?? '').trim();
  // v8 ignore next — null path of ?? already covered
  normalized.haToken = String(normalized.haToken ?? '');
  if (normalized.haUrl && !HA_WS_URL.test(normalized.haUrl)) {
    throw new HttpError(400, 'haUrl must be a Home Assistant websocket URL like ws://host:8123/api/websocket');
  }

  normalized.dataSources = normalizeDataSources(normalized.dataSources);
  normalized.evEnabled = normalized.evEnabled == null
    ? false
    : expectBoolean(normalized.evEnabled, 'evEnabled');
  normalized.evMinChargeCurrent_A = Math.max(0, Math.round(
    Number.isFinite(normalized.evMinChargeCurrent_A) ? normalized.evMinChargeCurrent_A : 0,
  ));
  normalized.evMaxChargeCurrent_A = Math.max(0, Math.round(
    Number.isFinite(normalized.evMaxChargeCurrent_A) ? normalized.evMaxChargeCurrent_A : 0,
  ));
  orderPair(normalized, 'evMinChargeCurrent_A', 'evMaxChargeCurrent_A', options);
  // EV charger AC phases: only 1 or 3 are meaningful. Default to 3 (the target
  // hardware is a three-phase Wall Connector); single-phase users set 1.
  normalized.evChargePhases = Number(normalized.evChargePhases) === 1 ? 1 : 3;
  normalized.evBatteryCapacity_kWh = Math.max(
    0,
    Number.isFinite(normalized.evBatteryCapacity_kWh) ? normalized.evBatteryCapacity_kWh : 0,
  );
  normalized.evTargetSoc_percent = normalizeSocPercent(
    Number.isFinite(normalized.evTargetSoc_percent) ? normalized.evTargetSoc_percent : 0,
  );
  normalized.evChargeEfficiency_percent = normalizeSocPercent(
    Number.isFinite(normalized.evChargeEfficiency_percent) ? normalized.evChargeEfficiency_percent : 100,
  );
  normalized.evSocSensor = String(normalized.evSocSensor ?? '').trim();
  normalized.evPlugSensor = String(normalized.evPlugSensor ?? '').trim();
  normalized.evDepartureTime = normalizeDepartureTime(normalized.evDepartureTime);
  normalized.evDepartureDay = normalized.evDepartureDay === 'today' ? 'today' : 'tomorrow';

  normalizeEvNativeSettings(normalized);

  if (normalized.autoCalculate) {
    normalized.autoCalculate = normalizeAutoCalculate(normalized.autoCalculate);
  }
  if (normalized.haPriceConfig) {
    normalized.haPriceConfig = normalizeHaPriceConfig(normalized.haPriceConfig);
  }
  if (normalized.dessPriceRefresh) {
    normalized.dessPriceRefresh = normalizeDessPriceRefresh(normalized.dessPriceRefresh);
  }
  if (normalized.shoreOptimizer) {
    normalized.shoreOptimizer = normalizeShoreOptimizer(normalized.shoreOptimizer);
  }
  if (normalized.pvCurtailment) {
    normalized.pvCurtailment = normalizePvCurtailment(normalized.pvCurtailment);
  }
  if (normalized.exportTariff) {
    normalized.exportTariff = normalizeExportTariff(normalized.exportTariff);
  }
  if (normalized.extendedHorizon) {
    normalized.extendedHorizon = normalizeExtendedHorizon(normalized.extendedHorizon);
  }
  if (normalized.cvPhase) {
    normalized.cvPhase = normalizeCvPhase(normalized.cvPhase);
  }
  if (normalized.batteryChargeControl) {
    normalized.batteryChargeControl = normalizeBatteryChargeControl(normalized.batteryChargeControl);
  }
  if (normalized.batteryBalanceControl) {
    normalized.batteryBalanceControl = normalizeBatteryBalanceControl(normalized.batteryBalanceControl);
  }
  if (normalized.adaptiveLearning) {
    normalized.adaptiveLearning = normalizeAdaptiveLearning(normalized.adaptiveLearning);
  }
  if (normalized.predictionAutoSelect) {
    normalized.predictionAutoSelect = normalizePredictionAutoSelect(normalized.predictionAutoSelect);
  }
  if (normalized.essConfig) {
    normalized.essConfig = normalizeEssConfig(normalized.essConfig);
  }

  return normalized;
}

/** Coerce to a finite number, or undefined (for optional numeric settings). */
function optNumber(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}

/**
 * Validate a daily trigger time. The format must be `HH:MM`; a value past the
 * end of the day (`24:00`, `99:99`, `12:75`) is clamped to the latest valid
 * time at or before it rather than rejected, because this runs on *load* as
 * well as on `POST /settings` — a throw here would fail startup for anyone
 * with such a value already stored. A clamped time still fires once a day;
 * the unclamped one never matched any minute of the day.
 */
function normalizeClockTime(value: unknown, label: string): string {
  const time = expectString(value, label).trim();
  if (!HH_MM.test(time)) {
    throw new HttpError(400, `${label} must be in HH:MM format`);
  }
  const [h, m] = time.split(':').map(Number);
  if (h > 23) return '23:59';
  return `${String(h).padStart(2, '0')}:${String(Math.min(59, m)).padStart(2, '0')}`;
}

/**
 * Normalize the native EV planning + actuation settings (feature-parity port).
 * All fields are optional; booleans default false, the actuation numerics get
 * sane defaults, and optional numeric levels are left undefined when absent so a
 * disabled toggle never activates from a stray default.
 */
function normalizeEvNativeSettings(s: Settings): void {
  // Earliest-start window (ISO local datetime or empty)
  s.evStartTime = typeof s.evStartTime === 'string' ? s.evStartTime : '';

  // Target-SoC source: optional HA entity (e.g. the car's own charge limit)
  // that overrides evTargetSoc_percent while it is readable. Empty = static.
  s.evTargetSocEntity = String(s.evTargetSocEntity ?? '').trim();

  // Price limit
  s.evApplyPriceLimit = s.evApplyPriceLimit === true;
  s.evMaxPrice_cents_per_kWh = optNumber(s.evMaxPrice_cents_per_kWh); // may be negative

  // Minimum-SoC floor
  const minSoc = optNumber(s.evMinSoc_percent);
  s.evMinSoc_percent = minSoc === undefined ? undefined : normalizeSocPercent(minSoc);

  // Forecast-deferral threshold (multi-day horizon, no deadline)
  const deferMin = optNumber(s.evDeferMinSoc_percent);
  s.evDeferMinSoc_percent = deferMin === undefined ? undefined : normalizeSocPercent(deferMin);

  // Opportunistic bands
  s.evOpportunisticEnabled = s.evOpportunisticEnabled === true;
  const opp1 = optNumber(s.evOpportunisticLevel_percent);
  s.evOpportunisticLevel_percent = opp1 === undefined ? undefined : normalizeSocPercent(opp1);
  s.evOpportunisticType2Enabled = s.evOpportunisticType2Enabled === true;
  const opp2 = optNumber(s.evOpportunisticType2Level_percent);
  s.evOpportunisticType2Level_percent = opp2 === undefined ? undefined : normalizeSocPercent(opp2);

  // Reactive overrides
  s.evLowPriceChargingEnabled = s.evLowPriceChargingEnabled === true;
  s.evLowPriceChargingLevel_cents_per_kWh = optNumber(s.evLowPriceChargingLevel_cents_per_kWh); // may be negative
  s.evLowSocChargingEnabled = s.evLowSocChargingEnabled === true;
  const lowSoc = optNumber(s.evLowSocChargingLevel_percent);
  s.evLowSocChargingLevel_percent = lowSoc === undefined ? undefined : normalizeSocPercent(lowSoc);

  // Behaviour
  s.evContinuous = s.evContinuous === true;
  s.evKeepOn = s.evKeepOn === true;
  s.evChargeCurveEnabled = s.evChargeCurveEnabled === true;

  // Actuation
  s.evActuationEnabled = s.evActuationEnabled === true;
  s.evChargerSwitchEntity = String(s.evChargerSwitchEntity ?? '').trim();
  s.evChargerCurrentEntity = String(s.evChargerCurrentEntity ?? '').trim();
  s.evControlIntervalSeconds = clampInt(s.evControlIntervalSeconds, 5, 3600, 60);
  s.evMaxPlanAgeSeconds = clampInt(s.evMaxPlanAgeSeconds, 60, 86_400, 1800);
  s.evFailSafeMode = s.evFailSafeMode === 'stop' ? 'stop' : 'hold';
  s.evActuationPaused = s.evActuationPaused === true;
  s.evOverrideMode = (s.evOverrideMode === 'charge' || s.evOverrideMode === 'stop')
    ? s.evOverrideMode
    : 'auto';
}

function normalizeDataSources(dataSources: DataSources): DataSources {
  assertObject(dataSources, 'dataSources');
  return {
    load: expectEnum(dataSources.load, ['vrm', 'api', 'ha'] as const, 'dataSources.load'),
    pv: expectEnum(dataSources.pv, ['vrm', 'api', 'ha'] as const, 'dataSources.pv'),
    prices: expectEnum(dataSources.prices, ['vrm', 'api', 'ha'] as const, 'dataSources.prices'),
    soc: expectEnum(dataSources.soc, ['mqtt', 'api'] as const, 'dataSources.soc'),
    // 'ha' was the legacy EV Smart Charging schedule reader (removed); the only
    // remaining injection path is manual/API, so coerce stale 'ha' values to 'api'.
    evLoad: dataSources.evLoad == null
      ? undefined
      : expectEnum(dataSources.evLoad === 'ha' ? 'api' : dataSources.evLoad, ['vrm', 'api'] as const, 'dataSources.evLoad'),
  };
}

function normalizeAutoCalculate(autoCalculate: AutoCalculateConfig): AutoCalculateConfig {
  assertObject(autoCalculate, 'autoCalculate');
  return {
    enabled: expectBoolean(autoCalculate.enabled, 'autoCalculate.enabled'),
    intervalMinutes: Math.max(1, Math.round(expectFiniteNumber(autoCalculate.intervalMinutes, 'autoCalculate.intervalMinutes'))),
    updateData: expectBoolean(autoCalculate.updateData, 'autoCalculate.updateData'),
    writeToVictron: expectBoolean(autoCalculate.writeToVictron, 'autoCalculate.writeToVictron'),
  };
}

function normalizeHaPriceConfig(haPriceConfig: HaPriceConfig): HaPriceConfig {
  assertObject(haPriceConfig, 'haPriceConfig');
  const priceInterval = Math.round(expectFiniteNumber(haPriceConfig.priceInterval, 'haPriceConfig.priceInterval'));
  if (priceInterval !== 15 && priceInterval !== 60) {
    throw new HttpError(400, 'haPriceConfig.priceInterval must be 15 or 60');
  }

  return {
    sensor: expectString(haPriceConfig.sensor, 'haPriceConfig.sensor').trim(),
    todayAttribute: expectString(haPriceConfig.todayAttribute, 'haPriceConfig.todayAttribute').trim(),
    tomorrowAttribute: expectString(haPriceConfig.tomorrowAttribute, 'haPriceConfig.tomorrowAttribute').trim(),
    timeKey: expectString(haPriceConfig.timeKey, 'haPriceConfig.timeKey').trim(),
    valueKey: expectString(haPriceConfig.valueKey, 'haPriceConfig.valueKey').trim(),
    valueMultiplier: expectFiniteNumber(haPriceConfig.valueMultiplier, 'haPriceConfig.valueMultiplier'),
    importEqualsExport: expectBoolean(haPriceConfig.importEqualsExport, 'haPriceConfig.importEqualsExport'),
    priceInterval,
    exportSensor: haPriceConfig.exportSensor == null
      ? ''
      : expectString(haPriceConfig.exportSensor, 'haPriceConfig.exportSensor').trim(),
  };
}

function normalizeDessPriceRefresh(dessPriceRefresh: DessPriceRefreshConfig): DessPriceRefreshConfig {
  assertObject(dessPriceRefresh, 'dessPriceRefresh');
  const time = normalizeClockTime(dessPriceRefresh.time, 'dessPriceRefresh.time');

  return {
    enabled: expectBoolean(dessPriceRefresh.enabled, 'dessPriceRefresh.enabled'),
    time,
    durationMinutes: clampInt(
      expectFiniteNumber(dessPriceRefresh.durationMinutes, 'dessPriceRefresh.durationMinutes'),
      DESS_PRICE_REFRESH_LIMITS.durationMinutes.min,
      DESS_PRICE_REFRESH_LIMITS.durationMinutes.max,
      DESS_PRICE_REFRESH_LIMITS.durationMinutes.min,
    ),
  };
}

function normalizeShoreOptimizer(shoreOptimizer: ShoreOptimizerConfig): ShoreOptimizerConfig {
  assertObject(shoreOptimizer, 'shoreOptimizer');

  let minShoreA = Math.max(0, Math.min(
    MAX_SAFE_SHORE_A,
    expectFiniteNumber(shoreOptimizer.minShoreA, 'shoreOptimizer.minShoreA'),
  ));
  let maxShoreA = Math.max(0, Math.min(
    MAX_SAFE_SHORE_A,
    expectFiniteNumber(shoreOptimizer.maxShoreA, 'shoreOptimizer.maxShoreA'),
  ));

  if (maxShoreA < minShoreA) {
    [minShoreA, maxShoreA] = [maxShoreA, minShoreA];
  }

  return {
    enabled: expectBoolean(shoreOptimizer.enabled, 'shoreOptimizer.enabled'),
    dryRun: expectBoolean(shoreOptimizer.dryRun, 'shoreOptimizer.dryRun'),
    tickMs: Math.max(1000, Math.round(expectFiniteNumber(shoreOptimizer.tickMs, 'shoreOptimizer.tickMs'))),
    stepA: Math.max(0.1, expectFiniteNumber(shoreOptimizer.stepA, 'shoreOptimizer.stepA')),
    minShoreA,
    maxShoreA,
    minChargingPowerW: Math.max(0, Math.round(expectFiniteNumber(shoreOptimizer.minChargingPowerW, 'shoreOptimizer.minChargingPowerW'))),
    gateOnDessSchedule: expectBoolean(shoreOptimizer.gateOnDessSchedule, 'shoreOptimizer.gateOnDessSchedule'),
    portalId: expectString(shoreOptimizer.portalId, 'shoreOptimizer.portalId').trim(),
    multiInstance: Math.max(0, Math.round(expectFiniteNumber(shoreOptimizer.multiInstance, 'shoreOptimizer.multiInstance'))),
    acInputIndex: Math.max(0, Math.round(expectFiniteNumber(shoreOptimizer.acInputIndex, 'shoreOptimizer.acInputIndex'))),
    mpptInstance: Math.max(0, Math.round(expectFiniteNumber(shoreOptimizer.mpptInstance, 'shoreOptimizer.mpptInstance'))),
    batteryInstance: Math.max(0, Math.round(expectFiniteNumber(shoreOptimizer.batteryInstance, 'shoreOptimizer.batteryInstance'))),
  };
}

function normalizePvCurtailment(pvCurtailment: PvCurtailmentConfig): PvCurtailmentConfig {
  assertObject(pvCurtailment, 'pvCurtailment');

  return {
    enabled: expectBoolean(pvCurtailment.enabled, 'pvCurtailment.enabled'),
    dryRun: expectBoolean(pvCurtailment.dryRun, 'pvCurtailment.dryRun'),
    tickMs: Math.max(1000, Math.round(expectFiniteNumber(pvCurtailment.tickMs, 'pvCurtailment.tickMs'))),
    minPvPowerW: Math.max(0, Math.round(expectFiniteNumber(pvCurtailment.minPvPowerW, 'pvCurtailment.minPvPowerW'))),
    minGridHeadroomW: Math.max(0, Math.round(expectFiniteNumber(pvCurtailment.minGridHeadroomW, 'pvCurtailment.minGridHeadroomW'))),
    negativePriceThreshold_cents_per_kWh: expectFiniteNumber(
      pvCurtailment.negativePriceThreshold_cents_per_kWh,
      'pvCurtailment.negativePriceThreshold_cents_per_kWh',
    ),
    portalId: expectString(pvCurtailment.portalId, 'pvCurtailment.portalId').trim(),
    acsystemInstance: Math.max(0, Math.round(expectFiniteNumber(pvCurtailment.acsystemInstance, 'pvCurtailment.acsystemInstance'))),
    enphaseSwitchEntity: expectString(pvCurtailment.enphaseSwitchEntity ?? '', 'pvCurtailment.enphaseSwitchEntity').trim(),
  };
}

function isValidTailHours(value: unknown): value is number {
  const { min, max } = EXPORT_TARIFF_TAIL_HOURS_LIMITS;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isValidFee(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Lenient on purpose: this runs on load, and a bad stored value must not stop
 * the add-on. An invalid field falls back to its default with a warning (a
 * missing one silently); `validateSettingsPatch` rejects bad values on save.
 */
function normalizeExportTariff(exportTariff: unknown): ExportTariffConfig {
  const source = isObject(exportTariff) ? exportTariff : {};
  if (source !== exportTariff) {
    console.warn('[settings] exportTariff is not an object; using the defaults');
  }
  const pick = <K extends keyof ExportTariffConfig>(
    key: K,
    valid: (value: unknown) => boolean,
  ): ExportTariffConfig[K] => {
    const value = source[key];
    if (value === undefined) return EXPORT_TARIFF_DEFAULTS[key];
    if (valid(value)) return (typeof value === 'string' ? value.trim() : value) as ExportTariffConfig[K];
    console.warn(`[settings] invalid exportTariff.${key} (${JSON.stringify(value)}); using the default ${JSON.stringify(EXPORT_TARIFF_DEFAULTS[key])}`);
    return EXPORT_TARIFF_DEFAULTS[key];
  };
  const isOneOf = (allowed: readonly string[]) => (value: unknown) => typeof value === 'string' && allowed.includes(value);

  return {
    mode: pick('mode', isOneOf(EXPORT_TARIFF_MODES)),
    effectiveFrom: pick('effectiveFrom', value => parseEffectiveFrom(value).ok),
    fee_cents_per_kWh: pick('fee_cents_per_kWh', isValidFee),
    negativePrice: pick('negativePrice', isOneOf(EXPORT_NEGATIVE_PRICE_RULES)),
    terminalSocValuation: pick('terminalSocValuation', isOneOf(EXPORT_TERMINAL_VALUATIONS)),
    terminalTail_h: pick('terminalTail_h', isValidTailHours),
  };
}

/** Strict `exportTariff` checks for a `POST /settings` patch (only the keys it carries). */
function validateExportTariffPatch(value: unknown): void {
  assertObject(value, 'exportTariff');
  const has = (key: string) => value[key] !== undefined;
  if (has('mode')) expectEnum(value.mode, EXPORT_TARIFF_MODES, 'exportTariff.mode');
  if (has('effectiveFrom')) {
    const parsed = parseEffectiveFrom(value.effectiveFrom);
    if (!parsed.ok) throw new HttpError(400, `exportTariff.effectiveFrom ${parsed.error}`);
  }
  if (has('fee_cents_per_kWh') && !isValidFee(value.fee_cents_per_kWh)) {
    throw new HttpError(400, 'exportTariff.fee_cents_per_kWh must be a finite number ≥ 0');
  }
  if (has('negativePrice')) expectEnum(value.negativePrice, EXPORT_NEGATIVE_PRICE_RULES, 'exportTariff.negativePrice');
  if (has('terminalSocValuation')) {
    expectEnum(value.terminalSocValuation, EXPORT_TERMINAL_VALUATIONS, 'exportTariff.terminalSocValuation');
  }
  if (has('terminalTail_h') && !isValidTailHours(value.terminalTail_h)) {
    const { min, max } = EXPORT_TARIFF_TAIL_HOURS_LIMITS;
    throw new HttpError(400, `exportTariff.terminalTail_h must be a number between ${min} and ${max}`);
  }
}

const isNumberIn = ({ min, max }: { min: number; max: number }) => (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const isValidExtraDays = (value: unknown): value is number =>
  Number.isInteger(value) && isNumberIn(EXTENDED_HORIZON_LIMITS.extraDays)(value);
const isValidVat = isNumberIn(EXTENDED_HORIZON_LIMITS.importVat_percent);
const isValidRefreshMinutes = isNumberIn(EXTENDED_HORIZON_LIMITS.refreshMinutes);
const isValidRegion = (value: unknown): boolean =>
  typeof value === 'string' && (PRICE_FORECAST_REGIONS as readonly string[]).includes(value);

/**
 * Lenient on purpose, like `normalizeExportTariff`: this runs on load, so an
 * invalid stored field falls back to its default with a warning (a missing
 * one silently); `validateSettingsPatch` rejects bad values on save.
 */
function normalizeExtendedHorizon(extendedHorizon: unknown): ExtendedHorizonConfig {
  const source = isObject(extendedHorizon) ? extendedHorizon : {};
  if (source !== extendedHorizon) {
    console.warn('[settings] extendedHorizon is not an object; using the defaults');
  }
  const pick = <K extends keyof ExtendedHorizonConfig>(
    key: K,
    valid: (value: unknown) => boolean,
  ): ExtendedHorizonConfig[K] => {
    const value = source[key];
    if (value === undefined) return EXTENDED_HORIZON_DEFAULTS[key];
    if (valid(value)) return (typeof value === 'string' ? value.trim() : value) as ExtendedHorizonConfig[K];
    console.warn(`[settings] invalid extendedHorizon.${key} (${JSON.stringify(value)}); using the default ${JSON.stringify(EXTENDED_HORIZON_DEFAULTS[key])}`);
    return EXTENDED_HORIZON_DEFAULTS[key];
  };

  return {
    mode: pick('mode', value => typeof value === 'string' && (EXTENDED_HORIZON_MODES as readonly string[]).includes(value)),
    extraDays: pick('extraDays', isValidExtraDays),
    // `auto` is stored lower-case, whatever case it was written in.
    forecastUrl: normalizeForecastUrl(pick('forecastUrl', value => forecastUrlSettingError(value) === null)),
    region: pick('region', isValidRegion),
    importVat_percent: pick('importVat_percent', isValidVat),
    riskMargin_cents_per_kWh: pick('riskMargin_cents_per_kWh', isValidFee),
    refreshMinutes: pick('refreshMinutes', isValidRefreshMinutes),
  };
}

function normalizeForecastUrl(value: string): string {
  return isAutoForecastUrl(value) ? AUTO_FORECAST_URL : value;
}

/** Strict `extendedHorizon` checks for a `POST /settings` patch (only the keys it carries). */
function validateExtendedHorizonPatch(value: unknown): void {
  assertObject(value, 'extendedHorizon');
  const has = (key: string) => value[key] !== undefined;
  if (has('mode')) expectEnum(value.mode, EXTENDED_HORIZON_MODES, 'extendedHorizon.mode');
  if (has('extraDays') && !isValidExtraDays(value.extraDays)) {
    const { min, max } = EXTENDED_HORIZON_LIMITS.extraDays;
    throw new HttpError(400, `extendedHorizon.extraDays must be a whole number between ${min} and ${max}`);
  }
  if (has('forecastUrl')) {
    const error = forecastUrlSettingError(value.forecastUrl);
    if (error) throw new HttpError(400, `extendedHorizon.forecastUrl ${error}`);
  }
  if (has('region')) expectEnum(value.region, PRICE_FORECAST_REGIONS, 'extendedHorizon.region');
  if (has('importVat_percent') && !isValidVat(value.importVat_percent)) {
    const { min, max } = EXTENDED_HORIZON_LIMITS.importVat_percent;
    throw new HttpError(400, `extendedHorizon.importVat_percent must be a number between ${min} and ${max}`);
  }
  if (has('riskMargin_cents_per_kWh') && !isValidFee(value.riskMargin_cents_per_kWh)) {
    throw new HttpError(400, 'extendedHorizon.riskMargin_cents_per_kWh must be a finite number ≥ 0');
  }
  if (has('refreshMinutes') && !isValidRefreshMinutes(value.refreshMinutes)) {
    const { min, max } = EXTENDED_HORIZON_LIMITS.refreshMinutes;
    throw new HttpError(400, `extendedHorizon.refreshMinutes must be a number between ${min} and ${max}`);
  }
}

function normalizeCvPhase(cvPhase: CvPhaseConfig): CvPhaseConfig {
  assertObject(cvPhase, 'cvPhase');
  return {
    enabled: expectBoolean(cvPhase.enabled, 'cvPhase.enabled'),
    thresholds: normalizeThresholds(cvPhase.thresholds),
  };
}

/** Clamp a value to the plausible LiFePO4 cell-voltage range (V). */
function clampCellVoltage(value: unknown, label: string): number {
  return Math.max(1.5, Math.min(4.5, expectFiniteNumber(value, label)));
}

function normalizeBatteryChargeControl(cfg: BatteryChargeControlConfig): BatteryChargeControlConfig {
  assertObject(cfg, 'batteryChargeControl');

  if (!Array.isArray(cfg.currentLevels)) {
    throw new HttpError(400, 'batteryChargeControl.currentLevels must be an array');
  }
  const levels = cfg.currentLevels.map((v, i) =>
    Math.max(0, Math.round(expectFiniteNumber(v, `batteryChargeControl.currentLevels[${i}]`))),
  );
  if (levels.length === 0) {
    throw new HttpError(400, 'batteryChargeControl.currentLevels must be a non-empty array');
  }
  // Discrete ladder, highest first, deduped, with a guaranteed 0 A bottom rung so the
  // emergency branch always commands zero current regardless of configured levels.
  const currentLevels = [...new Set([...levels, 0])].sort((a, b) => b - a);

  // Enforce restore < reduce < emergency by sorting the three voltages ascending.
  const [restoreVoltage, reduceVoltage, emergencyVoltage] = [
    clampCellVoltage(cfg.restoreVoltage, 'batteryChargeControl.restoreVoltage'),
    clampCellVoltage(cfg.reduceVoltage, 'batteryChargeControl.reduceVoltage'),
    clampCellVoltage(cfg.emergencyVoltage, 'batteryChargeControl.emergencyVoltage'),
  ].sort((a, b) => a - b);

  const result: BatteryChargeControlConfig = {
    enabled: expectBoolean(cfg.enabled, 'batteryChargeControl.enabled'),
    dryRun: expectBoolean(cfg.dryRun, 'batteryChargeControl.dryRun'),
    controlIntervalSeconds: clampInt(cfg.controlIntervalSeconds, 5, 3600, 30),
    emergencyVoltage,
    reduceVoltage,
    restoreVoltage,
    stabilizationSeconds: Math.max(0, Math.round(expectFiniteNumber(cfg.stabilizationSeconds, 'batteryChargeControl.stabilizationSeconds'))),
    currentLevels,
  };

  if (cfg.maxCellVoltageEntities != null) {
    if (!Array.isArray(cfg.maxCellVoltageEntities)) {
      throw new HttpError(400, 'batteryChargeControl.maxCellVoltageEntities must be an array');
    }
    const entities = cfg.maxCellVoltageEntities.map(e => optEntity(e)).filter((e): e is string => e !== undefined);
    if (entities.length > 0) result.maxCellVoltageEntities = entities;
  }
  const chargeEntity = optEntity(cfg.maxChargeCurrentEntity);
  if (chargeEntity) result.maxChargeCurrentEntity = chargeEntity;

  return result;
}

function normalizeBatteryBalanceControl(cfg: BatteryBalanceControlConfig): BatteryBalanceControlConfig {
  assertObject(cfg, 'batteryBalanceControl');
  const nonNeg = (v: unknown, label: string) => Math.max(0, expectFiniteNumber(v, label));

  // Clamp each voltage to the plausible cell range, then enforce a sane monotonic
  // ordering (bottomFloor ≤ bottomTop ≤ topStart ≤ topCap, and criticalHigh ≥ topStart)
  // so misordered config can't write nonsensical balance thresholds to the BMS.
  const bottomFloor = clampCellVoltage(cfg.bottomFloor, 'batteryBalanceControl.bottomFloor');
  const bottomTop = Math.max(clampCellVoltage(cfg.bottomTop, 'batteryBalanceControl.bottomTop'), bottomFloor);
  const topStart = Math.max(clampCellVoltage(cfg.topStart, 'batteryBalanceControl.topStart'), bottomTop);
  const topCap = Math.max(clampCellVoltage(cfg.topCap, 'batteryBalanceControl.topCap'), topStart);
  const criticalHighVoltage = Math.max(clampCellVoltage(cfg.criticalHighVoltage, 'batteryBalanceControl.criticalHighVoltage'), topStart);

  return {
    enabled: expectBoolean(cfg.enabled, 'batteryBalanceControl.enabled'),
    dryRun: expectBoolean(cfg.dryRun, 'batteryBalanceControl.dryRun'),
    controlIntervalSeconds: clampInt(cfg.controlIntervalSeconds, 5, 3600, 300),
    highCurrentThreshold_A: nonNeg(cfg.highCurrentThreshold_A, 'batteryBalanceControl.highCurrentThreshold_A'),
    tightTrigger: nonNeg(cfg.tightTrigger, 'batteryBalanceControl.tightTrigger'),
    looseTrigger: nonNeg(cfg.looseTrigger, 'batteryBalanceControl.looseTrigger'),
    step: Math.max(0.001, expectFiniteNumber(cfg.step, 'batteryBalanceControl.step')),
    topCap,
    criticalHighVoltage,
    topStart,
    bottomTop,
    bottomFloor,
    maxWarnVoltage: clampCellVoltage(cfg.maxWarnVoltage, 'batteryBalanceControl.maxWarnVoltage'),
  };
}

function normalizeAdaptiveLearning(adaptiveLearning: AdaptiveLearningConfig): AdaptiveLearningConfig {
  assertObject(adaptiveLearning, 'adaptiveLearning');
  return {
    enabled: expectBoolean(adaptiveLearning.enabled, 'adaptiveLearning.enabled'),
    mode: expectEnum(adaptiveLearning.mode, ['suggest', 'auto'], 'adaptiveLearning.mode'),
    minDataDays: Math.max(1, Math.round(expectFiniteNumber(adaptiveLearning.minDataDays, 'adaptiveLearning.minDataDays'))),
  };
}

function normalizePredictionAutoSelect(cfg: PredictionAutoSelectConfig): PredictionAutoSelectConfig {
  assertObject(cfg, 'predictionAutoSelect');
  const time = normalizeClockTime(cfg.time, 'predictionAutoSelect.time');
  const margin = AUTO_SELECT_LIMITS.minImprovement_percent;
  const window = AUTO_SELECT_LIMITS.windowDays;
  return {
    enabled: expectBoolean(cfg.enabled, 'predictionAutoSelect.enabled'),
    mode: expectEnum(cfg.mode, ['suggest', 'auto'], 'predictionAutoSelect.mode'),
    time,
    metric: expectEnum(cfg.metric, ['mae', 'rmse'], 'predictionAutoSelect.metric'),
    minImprovement_percent: Math.max(margin.min, Math.min(margin.max,
      expectFiniteNumber(cfg.minImprovement_percent, 'predictionAutoSelect.minImprovement_percent'))),
    windowDays: Math.max(window.min, Math.min(window.max,
      Math.round(expectFiniteNumber(cfg.windowDays, 'predictionAutoSelect.windowDays')))),
  };
}

/** Trim a value to a non-empty entity-id string, or undefined. Permissive: any non-empty string is accepted. */
function optEntity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeExtraEntities(value: unknown, label: string): { entity: string; name?: string }[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an array`);
  }
  return value
    .map((raw, i) => {
      assertObject(raw, `${label}[${i}]`);
      const entity = optEntity(raw.entity);
      if (!entity) return null;
      const name = optEntity(raw.name);
      return name ? { entity, name } : { entity };
    })
    .filter((e): e is { entity: string; name?: string } => e !== null);
}

const ESS_BATTERY_ENTITY_KEYS = [
  'socEntity', 'currentEntity', 'totalVoltageEntity', 'chargingPowerEntity',
  'dischargingPowerEntity', 'capacitySettingEntity', 'capacityRemainingEntity',
  'minCellVoltageEntity', 'maxCellVoltageEntity', 'balancingBinaryEntity',
  'balancingCurrentEntity', 'balanceStartVoltageEntity', 'balanceTriggerVoltageEntity',
  'alarmEntity', 'socCalibrationEntity',
] as const;

function normalizeEssBattery(battery: unknown, idx: number): EssBatteryConfig {
  assertObject(battery, `essConfig.batteries[${idx}]`);
  const name = expectString(battery.name, `essConfig.batteries[${idx}].name`).trim();
  if (!name) {
    throw new HttpError(400, `essConfig.batteries[${idx}].name must be a non-empty string`);
  }

  const result: EssBatteryConfig = { name };

  const prefix = optEntity(battery.cellVoltagePrefix);
  if (prefix) result.cellVoltagePrefix = prefix;
  if (battery.cellCount != null) {
    result.cellCount = Math.max(0, Math.round(expectFiniteNumber(battery.cellCount, `essConfig.batteries[${idx}].cellCount`)));
  }
  if (battery.cellVoltageEntities != null) {
    if (!Array.isArray(battery.cellVoltageEntities)) {
      throw new HttpError(400, `essConfig.batteries[${idx}].cellVoltageEntities must be an array`);
    }
    result.cellVoltageEntities = battery.cellVoltageEntities
      .map(e => optEntity(e))
      .filter((e): e is string => e !== undefined);
  }
  if (battery.temperatureEntities != null) {
    if (!Array.isArray(battery.temperatureEntities)) {
      throw new HttpError(400, `essConfig.batteries[${idx}].temperatureEntities must be an array`);
    }
    result.temperatureEntities = battery.temperatureEntities
      .map((t, tIdx) => {
        assertObject(t, `essConfig.batteries[${idx}].temperatureEntities[${tIdx}]`);
        const entity = optEntity(t.entity);
        if (!entity) return null;
        return { entity, name: optEntity(t.name) ?? entity };
      })
      .filter((t): t is { entity: string; name: string } => t !== null);
  }

  for (const key of ESS_BATTERY_ENTITY_KEYS) {
    const v = optEntity(battery[key]);
    if (v) result[key] = v;
  }

  if (battery.extraEntities != null) {
    result.extraEntities = normalizeExtraEntities(battery.extraEntities, `essConfig.batteries[${idx}].extraEntities`);
  }

  return result;
}

const ESS_SYSTEM_ENTITY_KEYS = [
  'maxChargeCurrentEntity', 'batteryPowerEntity', 'batteryCurrentEntity',
  'batteryVoltageEntity', 'socEntity',
] as const;

function normalizeEssSystem(system: unknown): EssSystemConfig {
  assertObject(system, 'essConfig.system');
  const result: EssSystemConfig = {};
  const name = optEntity(system.name);
  if (name) result.name = name;
  for (const key of ESS_SYSTEM_ENTITY_KEYS) {
    const v = optEntity(system[key]);
    if (v) result[key] = v;
  }
  if (system.extraEntities != null) {
    result.extraEntities = normalizeExtraEntities(system.extraEntities, 'essConfig.system.extraEntities');
  }
  return result;
}

function normalizeEssConfig(essConfig: EssConfig): EssConfig {
  assertObject(essConfig, 'essConfig');
  if (!Array.isArray(essConfig.batteries)) {
    throw new HttpError(400, 'essConfig.batteries must be an array');
  }
  return {
    enabled: expectBoolean(essConfig.enabled, 'essConfig.enabled'),
    batteries: essConfig.batteries.map((b, i) => normalizeEssBattery(b, i)),
    ...(essConfig.system != null ? { system: normalizeEssSystem(essConfig.system) } : {}),
    historyWindowHours: Math.max(1, Math.min(168, Math.round(expectFiniteNumber(essConfig.historyWindowHours, 'essConfig.historyWindowHours')))),
    historyPeriod: expectEnum(essConfig.historyPeriod, ['5minute', 'hour'] as const, 'essConfig.historyPeriod'),
    refreshIntervalSeconds: Math.max(5, Math.min(3600, Math.round(expectFiniteNumber(essConfig.refreshIntervalSeconds, 'essConfig.refreshIntervalSeconds')))),
  };
}

/**
 * Efficiency fields (percent). Each one divides or scales LP coefficients:
 * a zero discharge efficiency emits literal `Infinity` coefficients that
 * HiGHS refuses to parse, and a zero inverter efficiency turns zero-capped
 * bounds into NaN.
 */
const EFFICIENCY_FIELDS = [
  'chargeEfficiency_percent',
  'dischargeEfficiency_percent',
  'inverterEfficiency_percent',
  'evChargeEfficiency_percent',
] as const satisfies readonly (keyof Settings)[];

/** Top-level flags that must arrive as real JSON booleans. */
const STRICT_BOOLEAN_FIELDS = [
  'blockFeedInOnNegativePrices',
  'rebalanceEnabled',
  'evEnabled',
  'evApplyPriceLimit',
  'evOpportunisticEnabled',
  'evOpportunisticType2Enabled',
  'evLowPriceChargingEnabled',
  'evLowSocChargingEnabled',
  'evContinuous',
  'evKeepOn',
  'evChargeCurveEnabled',
  'evActuationEnabled',
  'evActuationPaused',
] as const satisfies readonly (keyof Settings)[];

/** Top-level string enums and their allowed values. */
const STRICT_ENUM_FIELDS = {
  terminalSocValuation: ['zero', 'min', 'avg', 'max', 'custom'],
  evDepartureDay: ['today', 'tomorrow'],
  evFailSafeMode: ['hold', 'stop'],
  evOverrideMode: ['auto', 'charge', 'stop'],
} as const satisfies Partial<Record<keyof Settings, readonly string[]>>;

/**
 * Strict checks for an incoming `POST /settings` patch, run before anything
 * is merged or persisted. A bad value is rejected with a 400 naming the
 * field rather than coerced: `normalizeSettings` would silently keep
 * `rebalanceEnabled: "off"` (truthy, so it forces a charge to maxSoc), keep
 * an unknown `terminalSocValuation`, and store a zero efficiency that makes
 * every later solve fail.
 *
 * Only the patch is checked, never the stored settings: `normalizeSettings`
 * also runs on load, and a value that is already on disk must keep failing
 * loudly at solve time instead of either bricking startup or being clamped
 * into a silently wrong plan.
 */
export function validateSettingsPatch(patch: Record<string, unknown>): void {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;

  for (const field of EFFICIENCY_FIELDS) {
    if (!has(field)) continue;
    const value = patch[field];
    // The EV efficiency has always fallen back to its default when null.
    if (value === null && field === 'evChargeEfficiency_percent') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) {
      throw new HttpError(400, `${field} must be a number between 1 and 100`);
    }
  }

  for (const field of STRICT_BOOLEAN_FIELDS) {
    if (has(field)) expectBoolean(patch[field], field);
  }

  for (const [field, allowed] of Object.entries(STRICT_ENUM_FIELDS)) {
    if (has(field)) expectEnum(patch[field], allowed, field);
  }

  // A non-number is left to normalizeSettings, which rejects it as before.
  const holdHours = patch.rebalanceHoldHours;
  const { min, max } = REBALANCE_HOLD_HOURS_LIMITS;
  if (typeof holdHours === 'number' && Number.isFinite(holdHours) && (holdHours < min || holdHours > max)) {
    throw new HttpError(400, `rebalanceHoldHours must be a number between ${min} and ${max}`);
  }

  if (has('exportTariff')) validateExportTariffPatch(patch.exportTariff);
  if (has('extendedHorizon')) validateExtendedHorizonPatch(patch.extendedHorizon);
}

export function sanitizeSettingsResponse(settings: Settings): Omit<Settings, 'haToken'> & { hasHaToken: boolean } {
  const { haToken, ...rest } = settings;
  return { ...rest, hasHaToken: haToken.length > 0 };
}
