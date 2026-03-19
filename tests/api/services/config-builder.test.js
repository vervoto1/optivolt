import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSolverConfigFromSettings, applyCalibration } from '../../../api/services/config-builder.ts';

const NOW_STRING = '2024-01-01T12:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

const mockSettings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 3,
};

// 96 slots of data starting at NOW so there's always sufficient future data
const makeData = (rebalanceState = undefined) => ({
  load: { start: NOW_STRING, step: 15, values: Array(96).fill(100) },
  pv: { start: NOW_STRING, step: 15, values: Array(96).fill(0) },
  importPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(10) },
  exportPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(5) },
  soc: { timestamp: NOW_STRING, value: 50 },
  rebalanceState,
});

describe('buildSolverConfigFromSettings — rebalancing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not include rebalance fields when rebalanceEnabled is false', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBeUndefined();
    expect(cfg.rebalanceRemainingSlots).toBeUndefined();
    expect(cfg.rebalanceTargetSoc_percent).toBeUndefined();
  });

  it('sets rebalanceRemainingSlots = holdSlots when startMs is null (not started)', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // 3h / (15min / 60) = 3 / 0.25 = 12 slots
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(12);
    expect(cfg.rebalanceRemainingSlots).toBe(12);
    expect(cfg.rebalanceTargetSoc_percent).toBe(100);
  });

  it('counts down correctly when startMs is set (mid-cycle)', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // 2 slots elapsed (30 min ago): remaining = 12 - 2 = 10
    const startMs = NOW_MS - 2 * 15 * 60_000;
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(12);
    expect(cfg.rebalanceRemainingSlots).toBe(10);
  });

  it('returns rebalanceRemainingSlots = 0 when cycle is complete', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // Started 12 slots (3h) ago — cycle is done
    const startMs = NOW_MS - 12 * 15 * 60_000;
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs }), NOW_MS);
    expect(cfg.rebalanceRemainingSlots).toBe(0);
  });

  it('uses Math.ceil so the hold is never shorter than requested (fractional hours)', () => {
    // 1.1h / 0.25h = 4.4 → ceil → 5 slots (not round-down 4)
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 1.1 };
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(5); // ceil(4.4) = 5
    expect(cfg.rebalanceRemainingSlots).toBe(5);
  });

  it('clamps holdSlots to at least 1 when rebalanceHoldHours is 0', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 0 };
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBeGreaterThanOrEqual(1);
    expect(cfg.rebalanceRemainingSlots).toBeGreaterThanOrEqual(1);
  });
});

describe('buildSolverConfigFromSettings — EV', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes evLoad_W from data.evLoad when present', () => {
    const evValues = Array(96).fill(0);
    evValues[2] = 11000;
    evValues[3] = 11000;
    const data = {
      ...makeData(),
      evLoad: { start: NOW_STRING, step: 15, values: evValues },
    };
    const cfg = buildSolverConfigFromSettings(mockSettings, data, NOW_MS);
    expect(Array.isArray(cfg.evLoad_W)).toBe(true);
    expect(cfg.evLoad_W[2]).toBe(11000);
    expect(cfg.evLoad_W[3]).toBe(11000);
    expect(cfg.evLoad_W[0]).toBe(0);
  });

  it('defaults evLoad_W to zeros when data.evLoad is absent', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(Array.isArray(cfg.evLoad_W)).toBe(true);
    expect(cfg.evLoad_W.length).toBe(cfg.load_W.length);
    expect(cfg.evLoad_W.every(v => v === 0)).toBe(true);
  });

  it('passes disableDischargeWhileEvCharging from settings.evConfig', () => {
    const settings = {
      ...mockSettings,
      evConfig: { enabled: true, disableDischargeWhileCharging: true },
    };
    const cfg = buildSolverConfigFromSettings(settings, makeData(), NOW_MS);
    expect(cfg.disableDischargeWhileEvCharging).toBe(true);
  });

  it('defaults disableDischargeWhileEvCharging to false when evConfig is absent', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.disableDischargeWhileEvCharging).toBe(false);
  });
});

describe('applyCalibration', () => {
  const baseCfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);

  function makeCal(overrides = {}) {
    return {
      chargeCurve: new Array(100).fill(1.0),
      dischargeCurve: new Array(100).fill(1.0),
      effectiveChargeRate: 1.0,
      effectiveDischargeRate: 1.0,
      sampleCount: 100,
      confidence: 0.8,
      lastCalibratedMs: Date.now(),
      ...overrides,
    };
  }

  it('does not modify config when confidence is below threshold', () => {
    const cal = makeCal({ confidence: 0.3 });
    cal.chargeCurve[50] = 0.8;
    const result = applyCalibration(baseCfg, cal);
    expect(result.chargeEfficiency_percent).toBe(baseCfg.chargeEfficiency_percent);
    expect(result.dischargeEfficiency_percent).toBe(baseCfg.dischargeEfficiency_percent);
  });

  it('uses per-SoC curve value at initialSoc_percent', () => {
    // baseCfg.initialSoc_percent = 50 (from mockData.soc.value)
    const cal = makeCal();
    cal.chargeCurve[50] = 0.8;
    const result = applyCalibration(baseCfg, cal);
    // 95% * 0.8 = 76%
    expect(result.chargeEfficiency_percent).toBe(76);
    expect(result.dischargeEfficiency_percent).toBe(baseCfg.dischargeEfficiency_percent);
  });

  it('scales discharge efficiency from curve', () => {
    const cal = makeCal();
    cal.dischargeCurve[50] = 0.85;
    const result = applyCalibration(baseCfg, cal);
    expect(result.chargeEfficiency_percent).toBe(baseCfg.chargeEfficiency_percent);
    // 95% * 0.85 = 80.75
    expect(result.dischargeEfficiency_percent).toBeCloseTo(80.75, 1);
  });

  it('clamps calibrated efficiency to 50-99% bounds', () => {
    const cal = makeCal();
    cal.chargeCurve[50] = 0.4;  // 95% * 0.4 = 38% → clamped to 50%
    cal.dischargeCurve[50] = 1.2; // 95% * 1.2 = 114% → clamped to 99%
    const result = applyCalibration(baseCfg, cal);
    expect(result.chargeEfficiency_percent).toBe(50);
    expect(result.dischargeEfficiency_percent).toBe(99);
  });

  it('falls back to aggregate rate when curves are missing', () => {
    const cal = makeCal({
      chargeCurve: [], // empty = no curve
      dischargeCurve: [],
      effectiveChargeRate: 0.8,
      effectiveDischargeRate: 0.9,
    });
    const result = applyCalibration(baseCfg, cal);
    // 95% * 0.8 = 76%
    expect(result.chargeEfficiency_percent).toBe(76);
    // 95% * 0.9 = 85.5
    expect(result.dischargeEfficiency_percent).toBeCloseTo(85.5, 1);
  });

  it('does not mutate the original config', () => {
    const original = { ...baseCfg };
    const cal = makeCal();
    cal.chargeCurve[50] = 0.8;
    applyCalibration(baseCfg, cal);
    expect(baseCfg.chargeEfficiency_percent).toBe(original.chargeEfficiency_percent);
  });
});
