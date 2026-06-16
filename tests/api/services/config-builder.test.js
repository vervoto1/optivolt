import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(),
}));

vi.mock('../../../api/services/efficiency-calibrator.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadCalibration: vi.fn(),
  };
});

// Mock ha-client for fetchHaEntityState — needed because config-builder imports it directly
vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
}));

import { buildSolverConfigFromSettings, applyCalibration, applyEvCalibration, getSolverInputs } from '../../../api/services/config-builder.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { loadData } from '../../../api/services/data-store.ts';
import { loadCalibration } from '../../../api/services/efficiency-calibrator.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';

const NOW_STRING = '2024-01-01T12:00:00Z';
const MID_SLOT_NOW_STRING = '2024-01-01T14:22:00Z';
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
          { soc_percent: 0, maxChargePower_W: 500 },
          { soc_percent: 70, maxChargePower_W: 0 },
        ],
      },
    };

    const cfg = buildSolverConfigFromSettings(settings, makeData(), NOW_MS);

    expect(cfg.cvPhaseThresholds).toBeDefined();
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

  it('SUPPRESSES data.evLoad injection in native mode (no double-count)', () => {
    // Native mode plans EV charge in the LP, so the uncontrollable data.evLoad
    // must NOT also be folded into the house load — else the EV is counted twice.
    const evValues = Array(96).fill(0);
    evValues[2] = 11000;
    const data = { ...makeData(), evLoad: { start: NOW_STRING, step: 15, values: evValues } };
    const nativeSettings = { ...mockSettings, evEnabled: true };
    const cfg = buildSolverConfigFromSettings(nativeSettings, data, NOW_MS);
    expect(cfg.evLoad_W.every(v => v === 0)).toBe(true);
  });

  it('keeps data.evLoad injection in off mode (manual/API uncontrollable load)', () => {
    const evValues = Array(96).fill(0);
    evValues[2] = 11000;
    const data = { ...makeData(), evLoad: { start: NOW_STRING, step: 15, values: evValues } };
    const offSettings = { ...mockSettings, evEnabled: false };
    const cfg = buildSolverConfigFromSettings(offSettings, data, NOW_MS);
    expect(cfg.evLoad_W[2]).toBe(11000);
  });
});

describe('applyCalibration', () => {
  const baseCfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);

  function makeCal(overrides = {}) {
    return {
      chargeCurve: new Array(100).fill(1.0),
      dischargeCurve: new Array(100).fill(1.0),
      chargeSamples: new Array(100).fill(10),
      dischargeSamples: new Array(100).fill(10),
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
    // Even with low curve values, low confidence should skip calibration
    cal.chargeCurve.fill(0.5);
    const result = applyCalibration(baseCfg, cal);
    expect(result.chargeEfficiency_percent).toBe(baseCfg.chargeEfficiency_percent);
    expect(result.dischargeEfficiency_percent).toBe(baseCfg.dischargeEfficiency_percent);
    expect(result.cvPhaseThresholds).toBeUndefined();
    expect(result.dischargePhaseThresholds).toBeUndefined();
  });

  it('does NOT modify chargeEfficiency_percent or dischargeEfficiency_percent', () => {
    const cal = makeCal();
    // Set low curve values that would have changed efficiency in the old code
    cal.chargeCurve.fill(0.7);
    cal.dischargeCurve.fill(0.7);
    const result = applyCalibration(baseCfg, cal);
    expect(result.chargeEfficiency_percent).toBe(baseCfg.chargeEfficiency_percent);
    expect(result.dischargeEfficiency_percent).toBe(baseCfg.dischargeEfficiency_percent);
  });

  it('populates cvPhaseThresholds when charge curve has reductions', () => {
    const cal = makeCal();
    // Set a segment of the charge curve to show significant reduction
    // Segment width = ceil(100/8) = 13, so bands 78-90 are segment 6
    for (let i = 78; i < 91; i++) cal.chargeCurve[i] = 0.7;
    const result = applyCalibration(baseCfg, cal);
    expect(result.cvPhaseThresholds).toBeDefined();
    expect(result.cvPhaseThresholds.length).toBeGreaterThan(0);
    // Each threshold should have soc_percent and maxChargePower_W
    for (const t of result.cvPhaseThresholds) {
      expect(t).toHaveProperty('soc_percent');
      expect(t).toHaveProperty('maxChargePower_W');
      expect(t.maxChargePower_W).toBeLessThan(baseCfg.maxChargePower_W);
    }
  });

  it('populates dischargePhaseThresholds when discharge curve has reductions', () => {
    const cal = makeCal();
    // Set a segment of the discharge curve to show significant reduction
    // Bands 0-12 are segment 0
    for (let i = 0; i < 13; i++) cal.dischargeCurve[i] = 0.6;
    const result = applyCalibration(baseCfg, cal);
    expect(result.dischargePhaseThresholds).toBeDefined();
    expect(result.dischargePhaseThresholds.length).toBeGreaterThan(0);
    for (const t of result.dischargePhaseThresholds) {
      expect(t).toHaveProperty('soc_percent');
      expect(t).toHaveProperty('maxDischargePower_W');
      expect(t.maxDischargePower_W).toBeLessThan(baseCfg.maxDischargePower_W);
    }
  });

  it('does not set thresholds when all curve values are >= 0.95', () => {
    // All values at 1.0 (default) — no meaningful reduction
    const cal = makeCal();
    const result = applyCalibration(baseCfg, cal);
    expect(result.cvPhaseThresholds).toBeUndefined();
    expect(result.dischargePhaseThresholds).toBeUndefined();
  });

  it('does not mutate the original config', () => {
    const original = { ...baseCfg };
    const cal = makeCal();
    for (let i = 78; i < 91; i++) cal.chargeCurve[i] = 0.7;
    applyCalibration(baseCfg, cal);
    expect(baseCfg.chargeEfficiency_percent).toBe(original.chargeEfficiency_percent);
    expect(baseCfg.cvPhaseThresholds).toBeUndefined();
  });
});

describe('applyEvCalibration', () => {
  function makeEvCfg() {
    return {
      ...buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS),
      ev: {
        evMinChargePower_W: 11040,
        evMaxChargePower_W: 11040,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 70,
        evTargetSoc_percent: 95,
        evDepartureSlot: 16,
        evChargeEfficiency_percent: 90,
      },
    };
  }

  function makeEvCal(overrides = {}) {
    return {
      evChargeCurve: new Array(100).fill(1.0),
      evChargeSamples: new Array(100).fill(10),
      effectiveChargeRate: 1.0,
      sampleCount: 100,
      confidence: 0.8,
      lastCalibratedMs: Date.now(),
      ...overrides,
    };
  }

  it('is a no-op when there is no EV in the plan', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS); // no .ev
    const cal = makeEvCal();
    for (let i = 80; i < 100; i++) cal.evChargeCurve[i] = 0.3;
    const result = applyEvCalibration(cfg, cal);
    expect(result).toBe(cfg); // unchanged reference
  });

  it('does not modify the config when confidence is below threshold', () => {
    const cfg = makeEvCfg();
    const cal = makeEvCal({ confidence: 0.3 });
    for (let i = 80; i < 100; i++) cal.evChargeCurve[i] = 0.3;
    const result = applyEvCalibration(cfg, cal);
    expect(result.ev.evChargeThresholds).toBeUndefined();
  });

  it('populates ev.evChargeThresholds when the acceptance curve tapers near full', () => {
    const cfg = makeEvCfg();
    const cal = makeEvCal();
    for (let i = 80; i < 100; i++) cal.evChargeCurve[i] = 0.3;
    const result = applyEvCalibration(cfg, cal);
    expect(result.ev.evChargeThresholds).toBeDefined();
    expect(result.ev.evChargeThresholds.length).toBeGreaterThan(0);
    for (const t of result.ev.evChargeThresholds) {
      expect(t).toHaveProperty('soc_percent');
      expect(t).toHaveProperty('maxChargePower_W');
      expect(t.maxChargePower_W).toBeLessThan(cfg.ev.evMaxChargePower_W);
    }
  });

  it('does not set thresholds when acceptance stays high (>= 0.95)', () => {
    const cfg = makeEvCfg();
    const result = applyEvCalibration(cfg, makeEvCal());
    expect(result.ev.evChargeThresholds).toBeUndefined();
  });

  it('does not mutate the original config.ev', () => {
    const cfg = makeEvCfg();
    const cal = makeEvCal();
    for (let i = 80; i < 100; i++) cal.evChargeCurve[i] = 0.3;
    applyEvCalibration(cfg, cal);
    expect(cfg.ev.evChargeThresholds).toBeUndefined();
  });

  it('forces a monotonic-decreasing taper from a non-monotonic learned curve', () => {
    const cfg = makeEvCfg();
    const cal = makeEvCal();
    // Physically-impossible curve: deep taper mid-pack, SHALLOWER taper near full
    // (acceptance rising with SoC). Raw thresholds would have power rising with SoC.
    for (let i = 50; i < 75; i++) cal.evChargeCurve[i] = 0.25;
    for (let i = 75; i < 100; i++) cal.evChargeCurve[i] = 0.65;
    const result = applyEvCalibration(cfg, cal);
    const th = result.ev.evChargeThresholds;
    expect(th.length).toBeGreaterThanOrEqual(2);
    // Ascending SoC → power must never increase (running-min projection).
    for (let i = 1; i < th.length; i++) {
      expect(th[i].soc_percent).toBeGreaterThan(th[i - 1].soc_percent);
      expect(th[i].maxChargePower_W).toBeLessThanOrEqual(th[i - 1].maxChargePower_W);
    }
  });
});

describe('getSolverInputs — EV state fetching from HA', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEvSettings() {
    return {
      ...mockSettings,
      evEnabled: true,
      evSocSensor: 'sensor.ev_soc',
      evPlugSensor: 'sensor.ev_plug',
      haUrl: 'http://ha.local:8123',
      haToken: 'my-token',
    };
  }

  it('fetches EV state from HA and passes to buildSolverConfigFromSettings', async () => {
    loadSettings.mockResolvedValue(makeEvSettings());
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // EV state should be undefined because fetchHaEntityState returns undefined by default
    // in the vi.mock. We test the error path below.
    expect(cfg.ev).toBeUndefined();
  });

  it('resolves EV state when fetchHaEntityState returns valid entity states (line 208-214)', async () => {
    loadSettings.mockResolvedValue({
      ...makeEvSettings(),
      evMinChargeCurrent_A: 6,
      evMaxChargeCurrent_A: 16,
      evBatteryCapacity_kWh: 60,
      evDepartureTime: '2024-01-01T14:00:00Z',
      evTargetSoc_percent: 80,
      evChargeEfficiency_percent: 100,
    });
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    // Mock fetchHaEntityState to return valid entity states
    fetchHaEntityState.mockImplementation(({ entityId }) => {
      if (entityId === 'sensor.ev_soc') {
        return Promise.resolve({
          entity_id: 'sensor.ev_soc', state: '75',
          attributes: {}, last_changed: '', last_updated: '',
        });
      }
      if (entityId === 'sensor.ev_plug') {
        return Promise.resolve({
          entity_id: 'sensor.ev_plug', state: 'connected',
          attributes: {}, last_changed: '', last_updated: '',
        });
      }
      return Promise.resolve({
        entity_id: '', state: 'unknown',
        attributes: {}, last_changed: '', last_updated: '',
      });
    });

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // EV state was read successfully: parseFloat('75') = 75, pluggedIn = true
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evInitialSoc_percent).toBe(75);
    expect(cfg.ev.evDepartureSlot).toBe(8);
  });

  it('falls back to end-of-horizon (keeps EV planning) when the ready-by deadline has elapsed', async () => {
    loadSettings.mockResolvedValue({
      ...makeEvSettings(),
      evMinChargeCurrent_A: 6,
      evMaxChargeCurrent_A: 16,
      evBatteryCapacity_kWh: 60,
      // Absolute deadline an hour BEFORE "now" → departureTimeToSlot returns 0.
      // Previously this disabled EV planning entirely (cfg.ev undefined). It must
      // now be treated as "no deadline" — charge to target by end of horizon — so a
      // stale absolute deadline doesn't silently stop daily charging.
      evDepartureTime: '2024-01-01T11:00:00Z',
      evTargetSoc_percent: 80,
      evChargeEfficiency_percent: 100,
    });
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    fetchHaEntityState.mockImplementation(({ entityId }) => {
      if (entityId === 'sensor.ev_soc') {
        return Promise.resolve({
          entity_id: 'sensor.ev_soc', state: '75',
          attributes: {}, last_changed: '', last_updated: '',
        });
      }
      return Promise.resolve({
        entity_id: 'sensor.ev_plug', state: 'connected',
        attributes: {}, last_changed: '', last_updated: '',
      });
    });

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    expect(cfg.ev).toBeDefined();
    // No deadline → reach target by the last slot we have prices for.
    expect(cfg.ev.evDepartureSlot).toBe(cfg.load_W.length);
  });

  it('marks EV as not plugged when plug sensor returns "disconnected" (line 209)', async () => {
    loadSettings.mockResolvedValue({
      ...makeEvSettings(),
      evMinChargeCurrent_A: 6,
      evMaxChargeCurrent_A: 16,
      evBatteryCapacity_kWh: 60,
      evDepartureTime: '2024-01-01T14:00:00Z',
      evTargetSoc_percent: 80,
      evChargeEfficiency_percent: 100,
    });
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    fetchHaEntityState.mockImplementation(({ entityId }) => {
      if (entityId === 'sensor.ev_soc') {
        return Promise.resolve({
          entity_id: 'sensor.ev_soc', state: '60',
          attributes: {}, last_changed: '', last_updated: '',
        });
      }
      return Promise.resolve({
        entity_id: 'sensor.ev_plug', state: 'disconnected',
        attributes: {}, last_changed: '', last_updated: '',
      });
    });

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // pluggedIn = false, so cfg.ev should not be included
    // (the pluggedIn check on line 114 prevents ev from being set)
    expect(cfg.ev).toBeUndefined();
  });

  it('catches HA error and still returns config without EV state', async () => {
    loadSettings.mockResolvedValue(makeEvSettings());
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    fetchHaEntityState.mockRejectedValue(new Error('HA unreachable'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // EV state should be undefined because fetchHaEntityState rejects
    expect(cfg.ev).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Could not read EV state from HA:',
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('handles non-Error throwable from fetchHaEntityState (String(err) branch)', async () => {
    loadSettings.mockResolvedValue(makeEvSettings());
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    // Reject with a string, not an Error instance
    fetchHaEntityState.mockRejectedValue('connection refused');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // EV state should be undefined because fetchHaEntityState rejects
    expect(cfg.ev).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Could not read EV state from HA:',
      'connection refused',
    );
    warnSpy.mockRestore();
  });

  it('skips EV state when parseFloat returns NaN (line 213)', async () => {
    loadSettings.mockResolvedValue(makeEvSettings());
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(null);

    fetchHaEntityState.mockImplementation(({ entityId }) => {
      if (entityId === 'sensor.ev_soc') {
        return Promise.resolve({
          entity_id: 'sensor.ev_soc', state: 'not-a-number',
          attributes: {}, last_changed: '', last_updated: '',
        });
      }
      return Promise.resolve({
        entity_id: 'sensor.ev_plug', state: 'connected',
        attributes: {}, last_changed: '', last_updated: '',
      });
    });

    const { getSolverInputs } = await import('../../../api/services/config-builder.ts');

    const { cfg } = await getSolverInputs();

    // soc_percent is NaN, so Number.isFinite fails (line 213), evState stays undefined
    expect(cfg.ev).toBeUndefined();
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
      chargeSamples: new Array(100).fill(10),
      dischargeSamples: new Array(100).fill(10),
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
    loadCalibration.mockResolvedValue(makeCalibration(0.7, 0.6));

    const { cfg } = await getSolverInputs();

    // Efficiencies should NOT be modified
    expect(cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
    expect(cfg.dischargeEfficiency_percent).toBe(mockSettings.dischargeEfficiency_percent);
    // With curve values < 0.95, thresholds should be generated
    expect(cfg.cvPhaseThresholds).toBeDefined();
    expect(cfg.cvPhaseThresholds.length).toBeGreaterThan(0);
    expect(cfg.dischargePhaseThresholds).toBeDefined();
    expect(cfg.dischargePhaseThresholds.length).toBeGreaterThan(0);
  });

  it('skips calibration when mode is suggest', async () => {
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('suggest'));
    loadData.mockResolvedValue(makeData());
    loadCalibration.mockResolvedValue(makeCalibration(0.7, 0.6));

    const { cfg } = await getSolverInputs();

    // No calibration applied — efficiencies should match settings values
    expect(cfg.chargeEfficiency_percent).toBe(mockSettings.chargeEfficiency_percent);
    expect(cfg.dischargeEfficiency_percent).toBe(mockSettings.dischargeEfficiency_percent);
    expect(cfg.cvPhaseThresholds).toBeUndefined();
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

  it('starts live planning at the current slot boundary when called mid-slot', async () => {
    vi.setSystemTime(new Date(MID_SLOT_NOW_STRING));
    loadSettings.mockResolvedValue(makeSettingsWithAdaptive('auto'));
    loadData.mockResolvedValue({
      load: { start: '2024-01-01T14:00:00.000Z', step: 15, values: [10, 20, 30, 40, 50, 60] },
      pv: { start: '2024-01-01T14:00:00.000Z', step: 15, values: [0, 0, 0, 0, 0, 0] },
      importPrice: { start: '2024-01-01T14:00:00.000Z', step: 15, values: [1, 2, 3, 4, 5, 6] },
      exportPrice: { start: '2024-01-01T14:00:00.000Z', step: 15, values: [0, 0, 0, 0, 0, 0] },
      soc: { timestamp: '2024-01-01T14:22:00.000Z', value: 50 },
    });
    loadCalibration.mockResolvedValue(null);

    const result = await getSolverInputs();

    expect(new Date(result.timing.startMs).toISOString()).toBe('2024-01-01T14:15:00.000Z');
    expect(result.cfg.load_W.slice(0, 3)).toEqual([20, 30, 40]);
    expect(result.cfg.importPrice.slice(0, 3)).toEqual([2, 3, 4]);
  });
});

// EV settings: 6–16 A @ 230 V, 60 kWh battery, 80% target
const evSettings = {
  ...mockSettings,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evChargePhases: 1, // explicit single-phase so the power assertions below are unambiguous
  evBatteryCapacity_kWh: 60,
  evDepartureTime: '2024-01-01T14:00:00Z', // 2 h after NOW_MS → 8 slots @ 15 min
  evTargetSoc_percent: 80,
  evChargeEfficiency_percent: 100,
};

describe('buildSolverConfigFromSettings — EV config', () => {
  it('does not add ev when evEnabled is false', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when evState is undefined', () => {
    const cfg = buildSolverConfigFromSettings(evSettings, makeData(), NOW_MS, undefined);
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when EV is not plugged in', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: false, soc_percent: 50 },
    );
    expect(cfg.ev).toBeUndefined();
  });

  it('adds ev config when evEnabled and pluggedIn', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evMinChargePower_W).toBe(6 * 230);   // 1380
    expect(cfg.ev.evMaxChargePower_W).toBe(16 * 230);  // 3680
    expect(cfg.ev.evBatteryCapacity_Wh).toBe(60_000);
    expect(cfg.ev.evInitialSoc_percent).toBe(50);
    expect(cfg.ev.evDepartureSlot).toBe(8); // 2h / 15min = 8 slots
    expect(cfg.ev.evChargePhases).toBe(1);
  });

  it('uses three-phase power (3x per amp) when evChargePhases is 3', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargePhases: 3 }, makeData(), NOW_MS,
      { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evMinChargePower_W).toBe(6 * 230 * 3);   // 4140
    expect(cfg.ev.evMaxChargePower_W).toBe(16 * 230 * 3);  // 11040 ≈ 11 kW
    expect(cfg.ev.evChargePhases).toBe(3);
  });

  it('treats an unset/invalid evChargePhases as single-phase', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargePhases: undefined }, makeData(), NOW_MS,
      { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evMaxChargePower_W).toBe(16 * 230); // falls back to ×230
    expect(cfg.ev.evChargePhases).toBe(1);
  });

  it('defaults the departure deadline to the end of the horizon when "ready by" is unset', () => {
    // No evDepartureTime → charge across the full known horizon, reaching target
    // by the last slot. (Still gated on a connected EV via evState.pluggedIn.)
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evDepartureTime: '' }, makeData(), NOW_MS,
      { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evDepartureSlot).toBe(cfg.load_W.length);
  });

  it('passes the REQUESTED target through unclamped (capacity-only; soft target carries feasibility)', () => {
    // The old achievable-charge clamp silently lowered the target before the LP
    // saw it, so the (now soft) target read as "met" while the car sat below the
    // user's requested SoC. The requested 80% must pass through verbatim.
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evTargetSoc_percent).toBe(80);
  });

  it('does not lower the target by charge efficiency (no achievable clamp)', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargeEfficiency_percent: 90 },
      makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evTargetSoc_percent).toBe(80);
  });

  it('passes evChargeEfficiency_percent through to EvConfig', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargeEfficiency_percent: 85 },
      makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evChargeEfficiency_percent).toBe(85);
  });

  it('falls back to end-of-horizon when the departure is in the past (elapsed deadline keeps EV planning)', () => {
    // An absolute deadline that has elapsed used to collapse the window to D=0 and
    // disable EV planning. It must now be treated as "no deadline" so daily charging
    // doesn't stop the morning after each deadline.
    const pastDeparture = { ...evSettings, evDepartureTime: '2024-01-01T11:00:00Z' };
    const cfg = buildSolverConfigFromSettings(
      pastDeparture, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evDepartureSlot).toBe(cfg.load_W.length);
  });

  it('falls back to end-of-horizon when the departure string is not a valid date', () => {
    const badDeparture = { ...evSettings, evDepartureTime: '07:30' };
    const cfg = buildSolverConfigFromSettings(
      badDeparture, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evDepartureSlot).toBe(cfg.load_W.length);
  });
});
