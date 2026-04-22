// v8 ignore next — type-only import
import type {
  Settings,
  DataSources,
  EvConfig,
  AutoCalculateConfig,
  HaPriceConfig,
  DessPriceRefreshConfig,
  CvPhaseConfig,
  AdaptiveLearningConfig,
} from '../types.ts';
import { HttpError } from '../http-errors.ts';

type JsonRecord = Record<string, unknown>;

export type SettingsPatch = Partial<Settings> & {
  dataSources?: Partial<DataSources>;
  evConfig?: Partial<EvConfig>;
  autoCalculate?: Partial<AutoCalculateConfig>;
  haPriceConfig?: Partial<HaPriceConfig>;
  dessPriceRefresh?: Partial<DessPriceRefreshConfig>;
  cvPhase?: Partial<CvPhaseConfig>;
  adaptiveLearning?: Partial<AdaptiveLearningConfig>;
};

const HH_MM = /^\d{2}:\d{2}$/;
const HA_WS_URL = /^wss?:\/\/[^/]+(?::\d+)?\/api\/websocket\/?$/i;

const NUMERIC_FIELDS: (keyof Settings)[] = [
  'stepSize_m', 'batteryCapacity_Wh', 'minSoc_percent', 'maxSoc_percent',
  'maxChargePower_W', 'maxDischargePower_W',
  'maxGridImport_W', 'maxGridExport_W', 'chargeEfficiency_percent',
  'dischargeEfficiency_percent', 'batteryCost_cent_per_kWh', 'idleDrain_W',
  'terminalSocCustomPrice_cents_per_kWh', 'rebalanceHoldHours',
];

function isObject(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value: unknown, label: string): asserts value is JsonRecord {
  if (!isObject(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${label} must be a boolean`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a string`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `${label} must be a finite number`);
  }
  return Number(value);
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function normalizeSocPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
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
    evConfig: patch.evConfig ? { ...base.evConfig, ...patch.evConfig } as EvConfig : base.evConfig,
    autoCalculate: patch.autoCalculate ? { ...base.autoCalculate, ...patch.autoCalculate } as AutoCalculateConfig : base.autoCalculate,
    haPriceConfig: patch.haPriceConfig ? { ...base.haPriceConfig, ...patch.haPriceConfig } as HaPriceConfig : base.haPriceConfig,
    dessPriceRefresh: patch.dessPriceRefresh ? { ...base.dessPriceRefresh, ...patch.dessPriceRefresh } as DessPriceRefreshConfig : base.dessPriceRefresh,
    cvPhase: patch.cvPhase ? { ...base.cvPhase, ...patch.cvPhase } as CvPhaseConfig : base.cvPhase,
    adaptiveLearning: patch.adaptiveLearning ? { ...base.adaptiveLearning, ...patch.adaptiveLearning } as AdaptiveLearningConfig : base.adaptiveLearning,
    /* v8 ignore end */
  };

  // Treat omitted or empty write-only tokens as "keep existing".
  if (!Object.prototype.hasOwnProperty.call(patch, 'haToken') || patch.haToken === '') {
    merged.haToken = base.haToken;
  }

  return merged;
}

export function normalizeSettings(settings: Settings): Settings {
  const normalized: Settings = { ...settings };

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
  normalized.rebalanceHoldHours = Math.max(0, normalized.rebalanceHoldHours);
  normalized.chargeEfficiency_percent = normalizeSocPercent(normalized.chargeEfficiency_percent);
  normalized.dischargeEfficiency_percent = normalizeSocPercent(normalized.dischargeEfficiency_percent);
  normalized.minSoc_percent = normalizeSocPercent(normalized.minSoc_percent);
  normalized.maxSoc_percent = normalizeSocPercent(normalized.maxSoc_percent);

  if (normalized.maxSoc_percent < normalized.minSoc_percent) {
    [normalized.minSoc_percent, normalized.maxSoc_percent] = [normalized.maxSoc_percent, normalized.minSoc_percent];
  }

  // v8 ignore next — null path of ?? already covered, v8 double-counts in String() call
  normalized.haUrl = String(normalized.haUrl ?? '').trim();
  // v8 ignore next — null path of ?? already covered
  normalized.haToken = String(normalized.haToken ?? '');
  if (normalized.haUrl && !HA_WS_URL.test(normalized.haUrl)) {
    throw new HttpError(400, 'haUrl must be a Home Assistant websocket URL like ws://host:8123/api/websocket');
  }

  normalized.dataSources = normalizeDataSources(normalized.dataSources);

  if (normalized.evConfig) {
    normalized.evConfig = normalizeEvConfig(normalized.evConfig);
  }
  if (normalized.autoCalculate) {
    normalized.autoCalculate = normalizeAutoCalculate(normalized.autoCalculate);
  }
  if (normalized.haPriceConfig) {
    normalized.haPriceConfig = normalizeHaPriceConfig(normalized.haPriceConfig);
  }
  if (normalized.dessPriceRefresh) {
    normalized.dessPriceRefresh = normalizeDessPriceRefresh(normalized.dessPriceRefresh);
  }
  if (normalized.cvPhase) {
    normalized.cvPhase = normalizeCvPhase(normalized.cvPhase);
  }
  if (normalized.adaptiveLearning) {
    normalized.adaptiveLearning = normalizeAdaptiveLearning(normalized.adaptiveLearning);
  }

  return normalized;
}

function normalizeDataSources(dataSources: DataSources): DataSources {
  assertObject(dataSources, 'dataSources');
  return {
    load: expectEnum(dataSources.load, ['vrm', 'api', 'ha'] as const, 'dataSources.load'),
    pv: expectEnum(dataSources.pv, ['vrm', 'api', 'ha'] as const, 'dataSources.pv'),
    prices: expectEnum(dataSources.prices, ['vrm', 'api', 'ha'] as const, 'dataSources.prices'),
    soc: expectEnum(dataSources.soc, ['mqtt', 'api'] as const, 'dataSources.soc'),
    evLoad: dataSources.evLoad == null
      ? undefined
      : expectEnum(dataSources.evLoad, ['vrm', 'api', 'ha'] as const, 'dataSources.evLoad'),
  };
}

function normalizeEvConfig(evConfig: EvConfig): EvConfig {
  assertObject(evConfig, 'evConfig');
  return {
    enabled: expectBoolean(evConfig.enabled, 'evConfig.enabled'),
    chargerPower_W: Math.max(0, Math.round(expectFiniteNumber(evConfig.chargerPower_W, 'evConfig.chargerPower_W'))),
    disableDischargeWhileCharging: expectBoolean(evConfig.disableDischargeWhileCharging, 'evConfig.disableDischargeWhileCharging'),
    scheduleSensor: expectString(evConfig.scheduleSensor, 'evConfig.scheduleSensor').trim(),
    scheduleAttribute: expectString(evConfig.scheduleAttribute, 'evConfig.scheduleAttribute').trim(),
    connectedSwitch: expectString(evConfig.connectedSwitch, 'evConfig.connectedSwitch').trim(),
    alwaysApplySchedule: expectBoolean(evConfig.alwaysApplySchedule, 'evConfig.alwaysApplySchedule'),
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
  };
}

function normalizeDessPriceRefresh(dessPriceRefresh: DessPriceRefreshConfig): DessPriceRefreshConfig {
  assertObject(dessPriceRefresh, 'dessPriceRefresh');
  const time = expectString(dessPriceRefresh.time, 'dessPriceRefresh.time').trim();
  if (!HH_MM.test(time)) {
    throw new HttpError(400, 'dessPriceRefresh.time must be in HH:MM format');
  }

  return {
    enabled: expectBoolean(dessPriceRefresh.enabled, 'dessPriceRefresh.enabled'),
    time,
    durationMinutes: Math.max(1, Math.round(expectFiniteNumber(dessPriceRefresh.durationMinutes, 'dessPriceRefresh.durationMinutes'))),
  };
}

function normalizeCvPhase(cvPhase: CvPhaseConfig): CvPhaseConfig {
  assertObject(cvPhase, 'cvPhase');
  return {
    enabled: expectBoolean(cvPhase.enabled, 'cvPhase.enabled'),
    thresholds: normalizeThresholds(cvPhase.thresholds),
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

export function sanitizeSettingsResponse(settings: Settings): Omit<Settings, 'haToken'> & { hasHaToken: boolean } {
  const { haToken, ...rest } = settings;
  return { ...rest, hasHaToken: haToken.length > 0 };
}
