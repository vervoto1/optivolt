import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The planner's stored calibration (DATA_DIR). The gate must never read it.
vi.mock('../../api/services/efficiency-calibrator.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadCalibration: vi.fn(), loadEvCalibration: vi.fn() };
});

import {
  buildGateConfig,
  mergeCalibrationSnapshots,
  parseAdjustmentsSnapshot,
  parseCalibrationSnapshot,
} from '../../scripts/solver-gate-config.ts';
import { buildPlannerConfig, preparePlanData } from '../../api/services/config-builder.ts';
import { loadCalibration, loadEvCalibration } from '../../api/services/efficiency-calibrator.ts';

const root = path.resolve(import.meta.dirname, '../..');
const NOW_STRING = '2024-01-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_STRING);

const settings = {
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
  rebalanceEnabled: false,
  rebalanceHoldHours: 3,
  evEnabled: false,
};
const autoSettings = { ...settings, adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 7 } };

const makeData = (predictionAdjustments) => ({
  load: { start: NOW_STRING, step: 15, values: Array(16).fill(100) },
  pv: { start: NOW_STRING, step: 15, values: Array(16).fill(0) },
  importPrice: { start: NOW_STRING, step: 15, values: Array(16).fill(10) },
  exportPrice: { start: NOW_STRING, step: 15, values: Array(16).fill(5) },
  soc: { timestamp: NOW_STRING, value: 50 },
  ...(predictionAdjustments ? { predictionAdjustments } : {}),
});

// A confident calibration whose charge curve tapers above 78 % (yields thresholds).
function makeCalibration(overrides = {}) {
  const chargeCurve = new Array(100).fill(1.0);
  for (let i = 78; i < 100; i++) chargeCurve[i] = 0.6;
  return {
    chargeCurve,
    dischargeCurve: new Array(100).fill(1.0),
    chargeSamples: new Array(100).fill(10),
    dischargeSamples: new Array(100).fill(10),
    effectiveChargeRate: 0.9,
    effectiveDischargeRate: 1.0,
    sampleCount: 1000,
    confidence: 0.8,
    lastCalibratedMs: NOW_MS,
    ...overrides,
  };
}
const evCalibration = {
  evChargeCurve: new Array(100).fill(1.0),
  evChargeSamples: new Array(100).fill(5),
  effectiveChargeRate: 1.0,
  sampleCount: 50,
  confidence: 0.6,
  lastCalibratedMs: NOW_MS,
};

function makeAdjustment(overrides = {}) {
  return {
    id: 'adj-1',
    series: 'load',
    mode: 'set',
    value_W: 900,
    start: NOW_STRING,
    end: '2024-01-01T13:00:00.000Z',
    createdAt: NOW_STRING,
    updatedAt: NOW_STRING,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('parseCalibrationSnapshot', () => {
  it('reads the GET /plan-accuracy/calibration response', () => {
    const calibration = makeCalibration();
    expect(parseCalibrationSnapshot({ calibration, evCalibration })).toEqual({ calibration, evCalibration });
  });

  it('reads the endpoint response of a box without calibration yet', () => {
    expect(parseCalibrationSnapshot({ message: 'No calibration data yet (collecting data)', calibration: null, evCalibration: null }))
      .toEqual({ calibration: null, evCalibration: null });
  });

  it('reads the DATA_DIR calibration.json and ev-calibration.json files', () => {
    const calibration = makeCalibration();
    expect(parseCalibrationSnapshot(calibration)).toEqual({ calibration, evCalibration: null });
    expect(parseCalibrationSnapshot(evCalibration)).toEqual({ calibration: null, evCalibration });
  });

  it('rejects anything else, naming the file', () => {
    expect(() => parseCalibrationSnapshot({ adjustments: [] }, 'x.json')).toThrow(/x\.json/);
    expect(() => parseCalibrationSnapshot([], 'y.json')).toThrow(/y\.json/);
    expect(() => parseCalibrationSnapshot(null)).toThrow();
  });

  it('merges calibration.json + ev-calibration.json, a later non-null part winning', () => {
    const first = makeCalibration({ confidence: 0.6 });
    const second = makeCalibration({ confidence: 0.9 });
    expect(mergeCalibrationSnapshots([
      { calibration: first, evCalibration: null },
      { calibration: null, evCalibration },
      { calibration: second, evCalibration: null },
    ])).toEqual({ calibration: second, evCalibration });
  });
});

describe('parseAdjustmentsSnapshot', () => {
  it('reads the GET /predictions/adjustments response or a bare array', () => {
    const adjustment = makeAdjustment();
    expect(parseAdjustmentsSnapshot({ adjustments: [adjustment] })).toEqual([adjustment]);
    expect(parseAdjustmentsSnapshot([adjustment])).toEqual([adjustment]);
    expect(parseAdjustmentsSnapshot({ adjustments: [] })).toEqual([]);
  });

  it('rejects a wrong shape or an invalid adjustment', () => {
    expect(() => parseAdjustmentsSnapshot({ calibration: null }, 'adj.json')).toThrow(/adj\.json/);
    expect(() => parseAdjustmentsSnapshot([null])).toThrow(/object/);
    expect(() => parseAdjustmentsSnapshot([makeAdjustment({ series: 'price' })])).toThrow(/series/);
  });
});

describe('buildGateConfig', () => {
  it('builds exactly the config the planner builds from the same calibration and adjustments', async () => {
    const calibration = makeCalibration();
    const data = makeData([makeAdjustment()]);
    loadCalibration.mockResolvedValue(calibration);
    loadEvCalibration.mockResolvedValue(evCalibration);
    const planner = await buildPlannerConfig(autoSettings, preparePlanData(data, NOW_MS), NOW_MS);
    loadCalibration.mockClear();

    const gate = await buildGateConfig({ settings: autoSettings, data, startMs: NOW_MS, calibration: { calibration, evCalibration } });

    expect(gate.cfg).toEqual(planner);
    expect(gate.cfg.cvPhaseThresholds?.length).toBeGreaterThan(0);
    expect(gate.cfg.load_W.slice(0, 5)).toEqual([900, 900, 900, 900, 100]);
    expect(gate.uncalibrated).toBe(false);
    expect(gate.notes).toContainEqual(expect.stringMatching(/^calibration: applied \(confidence 0\.8, 1000 samples, \d+ charge thresholds/));
    expect(loadCalibration).not.toHaveBeenCalled();
  });

  it('runs uncalibrated without a snapshot, says so, and never reads the local DATA_DIR calibration', async () => {
    loadCalibration.mockResolvedValue(makeCalibration());
    const gate = await buildGateConfig({ settings: autoSettings, data: makeData(), startMs: NOW_MS });

    expect(loadCalibration).not.toHaveBeenCalled();
    expect(gate.cfg.cvPhaseThresholds).toBeUndefined();
    expect(gate.uncalibrated).toBe(true);
    expect(gate.notes).toContainEqual(expect.stringMatching(/^WARNING: running UNCALIBRATED/));
  });

  it('does not apply a calibration when adaptive learning is not in auto mode, as production', async () => {
    const suggest = { ...settings, adaptiveLearning: { enabled: true, mode: 'suggest', minDataDays: 7 } };
    for (const s of [settings, suggest]) {
      const gate = await buildGateConfig({ settings: s, data: makeData(), startMs: NOW_MS, calibration: { calibration: makeCalibration(), evCalibration: null } });
      expect(gate.cfg.cvPhaseThresholds).toBeUndefined();
      expect(gate.uncalibrated).toBe(false);
      expect(gate.notes).toContainEqual(expect.stringMatching(/^calibration: not applied \(adaptive learning is not in auto mode/));
    }
  });

  it('reports a snapshot without battery calibration and one below the confidence threshold', async () => {
    const none = await buildGateConfig({ settings: autoSettings, data: makeData(), startMs: NOW_MS, calibration: { calibration: null, evCalibration: null } });
    expect(none.uncalibrated).toBe(false);
    expect(none.notes).toContainEqual(expect.stringMatching(/no battery calibration/));

    const weak = await buildGateConfig({ settings: autoSettings, data: makeData(), startMs: NOW_MS, calibration: { calibration: makeCalibration({ confidence: 0.3 }), evCalibration: null } });
    expect(weak.cfg.cvPhaseThresholds).toBeUndefined();
    expect(weak.notes).toContainEqual(expect.stringMatching(/confidence 0\.3 < 0\.5, not applied/));
  });

  it('uses the adjustments stored in data.json, pruning expired ones like the planner', async () => {
    const expired = makeAdjustment({ id: 'old', start: '2024-01-01T10:00:00.000Z', end: '2024-01-01T11:00:00.000Z' });
    const gate = await buildGateConfig({ settings, data: makeData([makeAdjustment(), expired]), startMs: NOW_MS });
    expect(gate.cfg.load_W[0]).toBe(900);
    expect(gate.notes).toContain('prediction adjustments: 1 active (from data.json)');
  });

  it('replaces the stored adjustments with the adjustments snapshot', async () => {
    const snapshot = [makeAdjustment({ id: 'snap', mode: 'add', value_W: 50 })];
    const gate = await buildGateConfig({ settings, data: makeData([makeAdjustment()]), startMs: NOW_MS, adjustments: snapshot });
    expect(gate.cfg.load_W[0]).toBe(150);
    expect(gate.notes).toContain('prediction adjustments: 1 active (from the adjustments snapshot)');
  });

  it('notes that the EV is not planned in native mode', async () => {
    const gate = await buildGateConfig({ settings: { ...settings, evEnabled: true }, data: makeData(), startMs: NOW_MS });
    expect(gate.cfg.ev).toBeUndefined();
    expect(gate.notes).toContainEqual(expect.stringMatching(/^EV: not planned/));
  });
});

describe('compare-highs-builds.ts CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/compare-highs-builds.ts', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });

  it('keeps the positional form and takes --calibration / --adjustments snapshots', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-cli-'));
    try {
      const defaults = JSON.parse(readFileSync(path.join(root, 'api/defaults/default-settings.json'), 'utf8'));
      const auto = { ...defaults, adaptiveLearning: { enabled: true, mode: 'auto', minDataDays: 7 } };
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(auto));
      writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({ calibration: makeCalibration(), evCalibration: null }));
      writeFileSync(path.join(dir, 'adjustments.json'), JSON.stringify({ adjustments: [] }));
      const data = path.join(root, 'api/defaults/default-data.json');
      const vendored = 'vendor/highs-build/highs.js';

      const bare = run(vendored, data, path.join(dir, 'settings.json'));
      expect(bare.status, bare.stderr).toBe(0);
      expect(bare.stderr).toMatch(/WARNING: running UNCALIBRATED/);
      expect(bare.stdout).toMatch(/OK \(identical plan\)/);

      const calibrated = run(vendored, data, path.join(dir, 'settings.json'), '--calibration', path.join(dir, 'calibration.json'), '--adjustments', path.join(dir, 'adjustments.json'));
      expect(calibrated.status, calibrated.stderr).toBe(0);
      expect(calibrated.stderr).not.toMatch(/UNCALIBRATED/);
      expect(calibrated.stdout).toMatch(/calibration: applied/);
      expect(calibrated.stdout).toMatch(/prediction adjustments: 0 active \(from the adjustments snapshot\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with the usage on a bad invocation', () => {
    expect(run().status).toBe(2);
    const unknown = run('vendor/highs-build/highs.js', '--bogus');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/usage:/);
  });
});
