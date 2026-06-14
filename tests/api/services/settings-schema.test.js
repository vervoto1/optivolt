import { describe, it, expect } from 'vitest';
import {
  mergeSettings,
  normalizeSettings,
  sanitizeSettingsResponse,
} from '../../../api/services/settings-schema.ts';

function validSettings() {
  return {
    stepSize_m: 15,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 20,
    maxSoc_percent: 100,
    maxChargePower_W: 3000,
    maxDischargePower_W: 3000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 2,
    idleDrain_W: 40,
    terminalSocValuation: 'zero',
    terminalSocCustomPrice_cents_per_kWh: 0,
    rebalanceHoldHours: 0,
    rebalanceEnabled: false,
    haUrl: 'ws://ha:8123/api/websocket',
    haToken: 'secret',
    dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt', evLoad: 'api' },
    autoCalculate: { enabled: false, intervalMinutes: 15, updateData: true, writeToVictron: true },
    haPriceConfig: {
      sensor: '', todayAttribute: 'today', tomorrowAttribute: 'tomorrow',
      timeKey: 'time', valueKey: 'value', valueMultiplier: 1,
      importEqualsExport: false, priceInterval: 60,
    },
    dessPriceRefresh: { enabled: false, time: '23:00', durationMinutes: 15 },
    shoreOptimizer: {
      enabled: false,
      dryRun: true,
      tickMs: 3000,
      stepA: 0.5,
      minShoreA: 0,
      maxShoreA: 25,
      minChargingPowerW: 200,
      gateOnDessSchedule: true,
      portalId: 'c0619ab6bd28',
      multiInstance: 6,
      acInputIndex: 1,
      mpptInstance: 0,
      batteryInstance: 512,
    },
    pvCurtailment: {
      enabled: false,
      dryRun: true,
      tickMs: 30000,
      minPvPowerW: 100,
      minGridHeadroomW: 100,
      negativePriceThreshold_cents_per_kWh: 0,
      portalId: 'c0619ab6bd28',
      acsystemInstance: 0,
    },
    cvPhase: { enabled: false, thresholds: [{ soc_percent: 95, maxChargePower_W: 1200 }] },
    adaptiveLearning: { enabled: false, mode: 'suggest', minDataDays: 3 },
  };
}

describe('settings-schema', () => {
  describe('normalizeSettings', () => {
    it('normalizes valid settings without error', () => {
      const result = normalizeSettings(validSettings());
      expect(result.stepSize_m).toBe(15);
    });

    it('swaps minSoc/maxSoc when inverted', () => {
      const s = validSettings();
      s.minSoc_percent = 80;
      s.maxSoc_percent = 20;
      const result = normalizeSettings(s);
      expect(result.minSoc_percent).toBe(20);
      expect(result.maxSoc_percent).toBe(80);
    });

    it('throws on non-object dataSources', () => {
      const s = validSettings();
      s.dataSources = 'invalid';
      expect(() => normalizeSettings(s)).toThrow('dataSources must be an object');
    });

    it('throws on non-finite number', () => {
      const s = validSettings();
      s.stepSize_m = NaN;
      expect(() => normalizeSettings(s)).toThrow('stepSize_m must be a finite number');
    });

    it('throws on non-finite number Infinity', () => {
      const s = validSettings();
      s.batteryCapacity_Wh = Infinity;
      expect(() => normalizeSettings(s)).toThrow('batteryCapacity_Wh must be a finite number');
    });

    it('throws on invalid enum value', () => {
      const s = validSettings();
      s.dataSources.load = 'invalid';
      expect(() => normalizeSettings(s)).toThrow('dataSources.load must be one of');
    });

    it('throws on non-array thresholds', () => {
      const s = validSettings();
      s.cvPhase.thresholds = 'not-array';
      expect(() => normalizeSettings(s)).toThrow('cvPhase.thresholds must be an array');
    });

    it('throws on invalid threshold item', () => {
      const s = validSettings();
      s.cvPhase.thresholds = ['not-object'];
      expect(() => normalizeSettings(s)).toThrow('cvPhase.thresholds[0] must be an object');
    });

    it('throws on invalid haPriceConfig.priceInterval', () => {
      const s = validSettings();
      s.haPriceConfig.priceInterval = 30;
      expect(() => normalizeSettings(s)).toThrow('haPriceConfig.priceInterval must be 15 or 60');
    });

    it('throws on invalid dessPriceRefresh.time format', () => {
      const s = validSettings();
      s.dessPriceRefresh.time = 'noon';
      expect(() => normalizeSettings(s)).toThrow('dessPriceRefresh.time must be in HH:MM format');
    });

    it('throws on non-object autoCalculate', () => {
      const s = validSettings();
      s.autoCalculate = [];
      expect(() => normalizeSettings(s)).toThrow('autoCalculate must be an object');
    });

    it('throws on non-object haPriceConfig', () => {
      const s = validSettings();
      s.haPriceConfig = 'bad';
      expect(() => normalizeSettings(s)).toThrow('haPriceConfig must be an object');
    });

    it('throws on non-object dessPriceRefresh', () => {
      const s = validSettings();
      s.dessPriceRefresh = 42;
      expect(() => normalizeSettings(s)).toThrow('dessPriceRefresh must be an object');
    });

    it('throws on non-object shoreOptimizer', () => {
      const s = validSettings();
      s.shoreOptimizer = 'bad';
      expect(() => normalizeSettings(s)).toThrow('shoreOptimizer must be an object');
    });

    it('throws on non-object pvCurtailment', () => {
      const s = validSettings();
      s.pvCurtailment = 'bad';
      expect(() => normalizeSettings(s)).toThrow('pvCurtailment must be an object');
    });

    it('normalizes shoreOptimizer limits and instances', () => {
      const s = validSettings();
      s.shoreOptimizer.maxShoreA = 200;
      s.shoreOptimizer.minShoreA = -5;
      s.shoreOptimizer.tickMs = 500;
      s.shoreOptimizer.stepA = 0;
      s.shoreOptimizer.multiInstance = 6.4;
      const result = normalizeSettings(s);
      expect(result.shoreOptimizer.maxShoreA).toBe(25);
      expect(result.shoreOptimizer.minShoreA).toBe(0);
      expect(result.shoreOptimizer.tickMs).toBe(1000);
      expect(result.shoreOptimizer.stepA).toBe(0.1);
      expect(result.shoreOptimizer.multiInstance).toBe(6);
    });

    it('throws on invalid shoreOptimizer booleans', () => {
      const s = validSettings();
      s.shoreOptimizer.enabled = 'yes';
      expect(() => normalizeSettings(s)).toThrow('shoreOptimizer.enabled must be a boolean');
    });

    it('normalizes pvCurtailment numeric fields', () => {
      const s = validSettings();
      s.pvCurtailment.tickMs = 500;
      s.pvCurtailment.minPvPowerW = -10;
      s.pvCurtailment.minGridHeadroomW = -1;
      s.pvCurtailment.acsystemInstance = 0.7;
      const result = normalizeSettings(s);
      expect(result.pvCurtailment.tickMs).toBe(1000);
      expect(result.pvCurtailment.minPvPowerW).toBe(0);
      expect(result.pvCurtailment.minGridHeadroomW).toBe(0);
      expect(result.pvCurtailment.acsystemInstance).toBe(1);
    });

    it('throws on invalid pvCurtailment boolean', () => {
      const s = validSettings();
      s.pvCurtailment.enabled = 'yes';
      expect(() => normalizeSettings(s)).toThrow('pvCurtailment.enabled must be a boolean');
    });

    it('throws on non-object cvPhase', () => {
      const s = validSettings();
      s.cvPhase = true;
      expect(() => normalizeSettings(s)).toThrow('cvPhase must be an object');
    });

    it('throws on non-object adaptiveLearning', () => {
      const s = validSettings();
      s.adaptiveLearning = 'x';
      expect(() => normalizeSettings(s)).toThrow('adaptiveLearning must be an object');
    });

    it('throws on invalid haUrl', () => {
      const s = validSettings();
      s.haUrl = 'http://ha:8123';
      expect(() => normalizeSettings(s)).toThrow('haUrl must be a Home Assistant websocket URL');
    });

    it('allows empty haUrl', () => {
      const s = validSettings();
      s.haUrl = '';
      const result = normalizeSettings(s);
      expect(result.haUrl).toBe('');
    });

    it('normalizes undefined evLoad in dataSources', () => {
      const s = validSettings();
      delete s.dataSources.evLoad;
      const result = normalizeSettings(s);
      expect(result.dataSources.evLoad).toBeUndefined();
    });

    it('filters out zero-value thresholds', () => {
      const s = validSettings();
      s.cvPhase.thresholds = [
        { soc_percent: 95, maxChargePower_W: 1200 },
        { soc_percent: 0, maxChargePower_W: 500 },
      ];
      const result = normalizeSettings(s);
      expect(result.cvPhase.thresholds).toHaveLength(1);
    });

    it('sorts thresholds by soc_percent', () => {
      const s = validSettings();
      s.cvPhase.thresholds = [
        { soc_percent: 97, maxChargePower_W: 500 },
        { soc_percent: 95, maxChargePower_W: 1200 },
      ];
      const result = normalizeSettings(s);
      expect(result.cvPhase.thresholds[0].soc_percent).toBe(95);
    });

    it('accepts priceInterval 15', () => {
      const s = validSettings();
      s.haPriceConfig.priceInterval = 15;
      const result = normalizeSettings(s);
      expect(result.haPriceConfig.priceInterval).toBe(15);
    });

    it('throws on invalid adaptiveLearning.mode', () => {
      const s = validSettings();
      s.adaptiveLearning.mode = 'invalid';
      expect(() => normalizeSettings(s)).toThrow("adaptiveLearning.mode must be one of");
    });

    it('throws on non-boolean adaptiveLearning.enabled', () => {
      const s = validSettings();
      s.adaptiveLearning.enabled = 'yes';
      expect(() => normalizeSettings(s)).toThrow('adaptiveLearning.enabled must be a boolean');
    });

    it('throws on non-finite adaptiveLearning.minDataDays', () => {
      const s = validSettings();
      s.adaptiveLearning.minDataDays = 'x';
      expect(() => normalizeSettings(s)).toThrow('adaptiveLearning.minDataDays must be a finite number');
    });
  });

  describe('mergeSettings', () => {
    it('merges patch into base with shallow merge of nested objects', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { autoCalculate: { enabled: true } });
      expect(merged.autoCalculate.enabled).toBe(true);
      expect(merged.autoCalculate.intervalMinutes).toBe(15);
    });

    it('merges shoreOptimizer patches without dropping defaults', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { shoreOptimizer: { enabled: true } });
      expect(merged.shoreOptimizer.enabled).toBe(true);
      expect(merged.shoreOptimizer.dryRun).toBe(true);
      expect(merged.shoreOptimizer.multiInstance).toBe(6);
    });

    it('merges pvCurtailment patches without dropping defaults', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { pvCurtailment: { enabled: true } });
      expect(merged.pvCurtailment.enabled).toBe(true);
      expect(merged.pvCurtailment.dryRun).toBe(true);
      expect(merged.pvCurtailment.acsystemInstance).toBe(0);
    });

    it('keeps existing haToken when patch omits it', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { stepSize_m: 30 });
      expect(merged.haToken).toBe('secret');
    });

    it('keeps existing haToken when patch sends empty string', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { haToken: '' });
      expect(merged.haToken).toBe('secret');
    });

    it('overwrites haToken when patch provides value', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { haToken: 'new-token' });
      expect(merged.haToken).toBe('new-token');
    });
  });

  describe('essConfig', () => {
    function withEss(essConfig) {
      const s = validSettings();
      s.essConfig = essConfig;
      return s;
    }

    const validEss = () => ({
      enabled: true,
      historyWindowHours: 24,
      historyPeriod: '5minute',
      refreshIntervalSeconds: 30,
      batteries: [
        { name: 'Basen Green', cellVoltagePrefix: 'sensor.bms0_cell_', cellCount: 16, socEntity: 'sensor.bms0_soc' },
      ],
      system: { name: 'Victron system', batteryPowerEntity: 'sensor.sys_power' },
    });

    it('normalizes a valid essConfig', () => {
      const result = normalizeSettings(withEss(validEss()));
      expect(result.essConfig.batteries).toHaveLength(1);
      expect(result.essConfig.batteries[0].cellCount).toBe(16);
      expect(result.essConfig.system.name).toBe('Victron system');
    });

    it('clamps historyWindowHours to 1..168 and refreshIntervalSeconds to >=5', () => {
      const result = normalizeSettings(withEss({ ...validEss(), historyWindowHours: 9999, refreshIntervalSeconds: 1 }));
      expect(result.essConfig.historyWindowHours).toBe(168);
      expect(result.essConfig.refreshIntervalSeconds).toBe(5);
    });

    it('rejects a battery without a name', () => {
      const ess = validEss();
      ess.batteries = [{ cellCount: 4 }];
      expect(() => normalizeSettings(withEss(ess))).toThrow('essConfig.batteries[0].name');
    });

    it('rejects a non-array batteries field', () => {
      expect(() => normalizeSettings(withEss({ ...validEss(), batteries: {} }))).toThrow('essConfig.batteries must be an array');
    });

    it('validates historyPeriod against the enum', () => {
      expect(() => normalizeSettings(withEss({ ...validEss(), historyPeriod: 'daily' }))).toThrow('essConfig.historyPeriod');
    });

    it('drops empty/blank entity ids but keeps the battery', () => {
      const ess = validEss();
      ess.batteries[0].currentEntity = '   ';
      const result = normalizeSettings(withEss(ess));
      expect(result.essConfig.batteries[0].currentEntity).toBeUndefined();
      expect(result.essConfig.batteries[0].socEntity).toBe('sensor.bms0_soc');
    });

    // The headline merge guard: a PATCH of one scalar field must not wipe batteries.
    it('PATCHing one scalar field via mergeSettings preserves batteries', () => {
      const base = withEss(validEss());
      const merged = mergeSettings(base, { essConfig: { historyWindowHours: 12 } });
      expect(merged.essConfig.historyWindowHours).toBe(12);
      expect(merged.essConfig.batteries).toHaveLength(1);
      expect(merged.essConfig.batteries[0].name).toBe('Basen Green');
      expect(merged.essConfig.system.name).toBe('Victron system');
    });
  });

  describe('sanitizeSettingsResponse', () => {
    it('removes haToken and adds hasHaToken flag', () => {
      const s = validSettings();
      const result = sanitizeSettingsResponse(s);
      expect(result.haToken).toBeUndefined();
      expect(result.hasHaToken).toBe(true);
    });

    it('sets hasHaToken false when token empty', () => {
      const s = validSettings();
      s.haToken = '';
      const result = sanitizeSettingsResponse(s);
      expect(result.hasHaToken).toBe(false);
    });
  });

  describe('EV native-charging settings', () => {
    it('coerces a stale "ha" evLoad data source to "api" (legacy reader removed)', () => {
      const s = normalizeSettings({
        ...validSettings(),
        dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt', evLoad: 'ha' },
      });
      expect(s.dataSources.evLoad).toBe('api');
    });

    it('throws on an invalid evLoad data source', () => {
      const s = validSettings();
      s.dataSources.evLoad = 'invalid';
      expect(() => normalizeSettings(s)).toThrow('dataSources.evLoad must be one of');
    });

    it('coerces booleans and clamps actuation numerics', () => {
      const s = normalizeSettings({
        ...validSettings(),
        evApplyPriceLimit: 'yes',          // non-boolean → false
        evLowSocChargingEnabled: true,
        evControlIntervalSeconds: 2,        // below min → 5
        evMaxPlanAgeSeconds: 10_000_000,    // above max → 86400
        evFailSafeMode: 'bogus',            // invalid → hold
      });
      expect(s.evApplyPriceLimit).toBe(false);
      expect(s.evLowSocChargingEnabled).toBe(true);
      expect(s.evControlIntervalSeconds).toBe(5);
      expect(s.evMaxPlanAgeSeconds).toBe(86_400);
      expect(s.evFailSafeMode).toBe('hold');
    });

    it('leaves optional numeric levels undefined when absent, allows negative prices', () => {
      const s = normalizeSettings(validSettings());
      expect(s.evMaxPrice_cents_per_kWh).toBeUndefined();
      const s2 = normalizeSettings({ ...validSettings(), evMaxPrice_cents_per_kWh: -3 });
      expect(s2.evMaxPrice_cents_per_kWh).toBe(-3);
    });

    it('PATCH of one EV field preserves the others (flat merge)', () => {
      const base = normalizeSettings({ ...validSettings(), evMaxChargeCurrent_A: 16, evChargePhases: 3 });
      const merged = mergeSettings(base, { evLowSocChargingEnabled: true });
      expect(merged.evLowSocChargingEnabled).toBe(true);
      expect(merged.evMaxChargeCurrent_A).toBe(16);
      expect(merged.evChargePhases).toBe(3);
    });
  });

  describe('battery controllers', () => {
    function chargeCfg(over = {}) {
      return {
        enabled: true, dryRun: false, controlIntervalSeconds: 30,
        emergencyVoltage: 3.65, reduceVoltage: 3.5, restoreVoltage: 3.4,
        stabilizationSeconds: 30, currentLevels: [400, 180, 50, 0], ...over,
      };
    }
    function balanceCfg(over = {}) {
      return {
        enabled: true, dryRun: true, controlIntervalSeconds: 300,
        highCurrentThreshold_A: 50, tightTrigger: 0.005, looseTrigger: 0.02, step: 0.05,
        topCap: 3.55, criticalHighVoltage: 3.549, topStart: 3.45, bottomTop: 3.4,
        bottomFloor: 2.9, maxWarnVoltage: 3.6, ...over,
      };
    }

    it('sorts currentLevels descending + dedupes and orders the voltages', () => {
      const r = normalizeSettings({
        ...validSettings(),
        batteryChargeControl: chargeCfg({
          currentLevels: [50, 400, 50, 180, 0],
          emergencyVoltage: 3.4, reduceVoltage: 3.65, restoreVoltage: 3.5, // intentionally jumbled
          controlIntervalSeconds: 2, // below the 5s floor
        }),
      });
      expect(r.batteryChargeControl.currentLevels).toEqual([400, 180, 50, 0]);
      expect(r.batteryChargeControl.restoreVoltage).toBe(3.4);
      expect(r.batteryChargeControl.reduceVoltage).toBe(3.5);
      expect(r.batteryChargeControl.emergencyVoltage).toBe(3.65);
      expect(r.batteryChargeControl.controlIntervalSeconds).toBe(5);
    });

    it('rejects an empty currentLevels array', () => {
      expect(() => normalizeSettings({
        ...validSettings(),
        batteryChargeControl: chargeCfg({ currentLevels: [] }),
      })).toThrow();
    });

    it('always includes a 0 A rung so emergency can reach zero current', () => {
      const r = normalizeSettings({
        ...validSettings(),
        batteryChargeControl: chargeCfg({ currentLevels: [400, 180, 50] }), // no 0
      });
      expect(r.batteryChargeControl.currentLevels).toEqual([400, 180, 50, 0]);
    });

    it('enforces a monotonic ordering on the balance voltage thresholds', () => {
      const r = normalizeSettings({
        ...validSettings(),
        batteryBalanceControl: balanceCfg({
          bottomFloor: 2.9, bottomTop: 3.5, topStart: 3.45, topCap: 3.4, criticalHighVoltage: 3.3,
        }),
      });
      const b = r.batteryBalanceControl;
      expect(b.bottomFloor).toBeLessThanOrEqual(b.bottomTop);
      expect(b.bottomTop).toBeLessThanOrEqual(b.topStart);
      expect(b.topStart).toBeLessThanOrEqual(b.topCap);
      expect(b.criticalHighVoltage).toBeGreaterThanOrEqual(b.topStart);
    });

    it('clamps balance-control numerics', () => {
      const r = normalizeSettings({
        ...validSettings(),
        batteryBalanceControl: balanceCfg({ controlIntervalSeconds: 1, highCurrentThreshold_A: -5, step: 0 }),
      });
      expect(r.batteryBalanceControl.controlIntervalSeconds).toBe(5);
      expect(r.batteryBalanceControl.highCurrentThreshold_A).toBe(0);
      expect(r.batteryBalanceControl.step).toBe(0.001);
    });

    it('preserves the per-battery balance write entities through essConfig normalization', () => {
      const r = normalizeSettings({
        ...validSettings(),
        essConfig: {
          enabled: true, historyWindowHours: 24, historyPeriod: '5minute', refreshIntervalSeconds: 5,
          batteries: [{
            name: 'B0', maxCellVoltageEntity: 'sensor.v0', currentEntity: 'sensor.i0',
            balanceStartVoltageEntity: 'number.s0', balanceTriggerVoltageEntity: 'number.t0',
          }],
        },
      });
      expect(r.essConfig.batteries[0].balanceStartVoltageEntity).toBe('number.s0');
      expect(r.essConfig.batteries[0].balanceTriggerVoltageEntity).toBe('number.t0');
    });

    it('deep-merges a partial batteryChargeControl PATCH', () => {
      const base = normalizeSettings({ ...validSettings(), batteryChargeControl: chargeCfg() });
      const merged = mergeSettings(base, { batteryChargeControl: { enabled: true } });
      expect(merged.batteryChargeControl.enabled).toBe(true);
      expect(merged.batteryChargeControl.currentLevels).toEqual([400, 180, 50, 0]);
    });
  });
});
