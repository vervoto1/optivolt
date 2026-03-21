import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(),
}));

vi.mock('../../../api/services/efficiency-calibrator.ts', () => ({
  loadCalibration: vi.fn(),
}));

import { buildSolverConfigFromSettings, applyCalibration, getSolverInputs } from '../../../api/services/config-builder.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { loadData } from '../../../api/services/data-store.ts';
import { loadCalibration } from '../../../api/services/efficiency-calibrator.ts';

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

describe('buildSolverConfigFromSettings — step fallback and evLoad in error details', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses step=15 when series step is undefined (line 10: step ?? 15)', () => {
    // Line 10: const step = source.step ?? 15
    const data = {
      ...makeData(),
      // omit step in load — should default to 15
      load: { start: NOW_STRING, values: Array(96).fill(100) }, // no step field
      pv: { start: NOW_STRING, step: 15, values: Array(96).fill(0) },
      importPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(10) },
      exportPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(5) },
    };
    // Should not throw — step defaults to 15
    const cfg = buildSolverConfigFromSettings(mockSettings, data, NOW_MS);
    expect(Array.isArray(cfg.load_W)).toBe(true);
  });

  it('includes evLoadEnd in error details when data.evLoad is present', () => {
    // Line 44: ...(data.evLoad ? { evLoadEnd: ... } : {})
    const pastStart = '2024-01-01T10:00:00Z';
    const data = {
      load: { start: pastStart, step: 15, values: [100] },
      pv: { start: pastStart, step: 15, values: [0] },
      importPrice: { start: pastStart, step: 15, values: [10] },
      exportPrice: { start: pastStart, step: 15, values: [5] },
      soc: { timestamp: NOW_STRING, value: 50 },
      evLoad: { start: pastStart, step: 15, values: [0] }, // evLoad present
    };

    let caught;
    try {
      buildSolverConfigFromSettings(mockSettings, data, NOW_MS);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toBe('Insufficient future data');
    // Error details should include evLoadEnd since data.evLoad is set
    expect(caught.details?.evLoadEnd).toBeDefined();
  });
});

describe('buildSolverConfigFromSettings — insufficient data', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws 422 when all series end before now', () => {
    // Series that ended 1 hour before NOW_STRING
    const pastStart = '2024-01-01T10:00:00Z'; // 2h before NOW (12:00)
    const pastData = {
      load: { start: pastStart, step: 15, values: [100] },          // ends 10:15
      pv: { start: pastStart, step: 15, values: [0] },
      importPrice: { start: pastStart, step: 15, values: [10] },
      exportPrice: { start: pastStart, step: 15, values: [5] },
      soc: { timestamp: NOW_STRING, value: 50 },
    };

    expect(() => buildSolverConfigFromSettings(mockSettings, pastData, NOW_MS))
      .toThrow('Insufficient future data');
  });
});

describe('buildSolverConfigFromSettings — cvPhase thresholds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes cvPhase thresholds through filtered and sorted when cvPhase is enabled', () => {
    const settings = {
      ...mockSettings,
      cvPhase: {
        enabled: true,
        thresholds: [
          { soc_percent: 90, maxChargePower_W: 1000 },
          { soc_percent: 80, maxChargePower_W: 2000 },
          { soc_percent: 0, maxChargePower_W: 500 },   // filtered: soc_percent = 0
          { soc_percent: 70, maxChargePower_W: 0 },    // filtered: maxChargePower_W = 0
        ],
      },
    };

    const cfg = buildSolverConfigFromSettings(settings, makeData(), NOW_MS);

    expect(cfg.cvPhaseThresholds).toBeDefined();
    // Two valid thresholds (80 and 90), sorted ascending by soc_percent
    expect(cfg.cvPhaseThresholds).toHaveLength(2);
    expect(cfg.cvPhaseThresholds[0].soc_percent).toBe(80);
    expect(cfg.cvPhaseThresholds[1].soc_percent).toBe(90);
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

describe('getSolverInputs — adaptive learning calibration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSettingsWithAdaptive(mode) {
    return {
      ...mockSettings,
      adaptiveLearning: { enabled: true, mode },
    };
  }

  function makeCalibration(chargeRate = 0.8, dischargeRate = 0.9) {
    const chargeCurve = new Array(100).fill(chargeRate);
    const dischargeCurve = new Array(100).fill(dischargeRate);
    return {
      chargeCurve,
      dischargeCurve,
      effectiveChargeRate: chargeRate,
      effectiveDischargeRate: dischargeRate,
      sampleCount: 100,
      confidence: 0.8,
      lastCalibratedMs: Date.now(),
    };
  }

  it('applies calibration to solver config when mode is auto and calibration exists', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('auto'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(makeCalibration(0.8, 0.9));

    const { cfg } = await getSolverInputs();

    // chargeEfficiency: 95% * 0.8 = 76%
    expect(cfg.chargeEfficiency_percent).toBe(76);
    // dischargeEfficiency: 95% * 0.9 = 85.5
    expect(cfg.dischargeEfficiency_percent).toBeCloseTo(85.5, 1);
  });

  it('skips calibration when mode is suggest', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('suggest'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(makeCalibration(0.8, 0.9));

    const { cfg } = await getSolverInputs();

    // No calibration applied — efficiencies should match settings values
    expect(cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
    expect(cfg.dischargeEfficiency_percent).toBe(mockSettings.dischargeEfficiency_percent);
    expect(loadCalibration).not.toHaveBeenCalled();
  });

  it('skips calibration when adaptiveLearning is absent', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings });
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(makeCalibration(0.8, 0.9));

    const { cfg } = await getSolverInputs();

    expect(cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
    expect(loadCalibration).not.toHaveBeenCalled();
  });

  it('skips calibration when loadCalibration returns null', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('auto'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    const { cfg } = await getSolverInputs();

    expect(cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
  });

  it('logs warning but still returns config when loadCalibration throws', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('auto'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockRejectedValueOnce(new Error('disk I/O error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await getSolverInputs();

    // Config still returned with original efficiency (calibration skipped on error)
    expect(result.cfg).toBeDefined();
    expect(result.cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[config-builder]'),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('returns settings and data alongside cfg', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('auto'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    const result = await getSolverInputs();

    expect(result.cfg).toBeDefined();
    expect(result.settings).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.timing.stepMin).toBe(mockSettings.stepSize_m);
  });
});
