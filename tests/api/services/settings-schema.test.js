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
    evConfig: {
      enabled: false,
      chargerPower_W: 11000,
      disableDischargeWhileCharging: true,
      scheduleSensor: '',
      scheduleAttribute: '',
      connectedSwitch: '',
      alwaysApplySchedule: false,
    },
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

    it('throws on non-boolean evConfig field', () => {
      const s = validSettings();
      s.evConfig.enabled = 'yes';
      expect(() => normalizeSettings(s)).toThrow('evConfig.enabled must be a boolean');
    });

    it('throws on non-string evConfig field', () => {
      const s = validSettings();
      s.evConfig.scheduleSensor = 123;
      expect(() => normalizeSettings(s)).toThrow('evConfig.scheduleSensor must be a string');
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

    it('throws on non-object evConfig', () => {
      const s = validSettings();
      s.evConfig = 'bad';
      expect(() => normalizeSettings(s)).toThrow('evConfig must be an object');
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
      const merged = mergeSettings(base, { evConfig: { enabled: true } });
      expect(merged.evConfig.enabled).toBe(true);
      expect(merged.evConfig.chargerPower_W).toBe(11000);
    });

    it('merges shoreOptimizer patches without dropping defaults', () => {
      const base = validSettings();
      const merged = mergeSettings(base, { shoreOptimizer: { enabled: true } });
      expect(merged.shoreOptimizer.enabled).toBe(true);
      expect(merged.shoreOptimizer.dryRun).toBe(true);
      expect(merged.shoreOptimizer.multiInstance).toBe(6);
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
});
