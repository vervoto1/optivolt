import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Multi-day horizon pipeline (plans/multi-day-horizon-plan.md, "Solve
// pipeline" and "Fences outside the LP"): real HiGHS and the real config
// builder; persistence, hardware I/O and HA are mocked. The vendored highs
// factory is wrapped so a test can replace the extended solve (recognised by
// its options: mip_rel_gap 0) or the firm one.
const solverCtl = vi.hoisted(() => ({ solveHook: null, calls: [] }));

vi.mock('../../../vendor/highs-build/highs.js', async (importOriginal) => {
  const actual = await importOriginal();
  const realFactory = actual.default;
  const factory = vi.fn(async (opts) => {
    const instance = await realFactory(opts);
    return {
      solve(lp, options) {
        const extended = options.mip_rel_gap === 0;
        solverCtl.calls.push({ extended, options });
        if (solverCtl.solveHook) return solverCtl.solveHook({ extended, instance, lp, options });
        return instance.solve(lp, options);
      },
    };
  });
  return { default: factory };
});

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/plan-history-store.ts');
vi.mock('../../../api/services/ha-client.ts');
vi.mock('../../../api/services/pv-curtailment.ts');

import { loadSettings, saveSettings, updateSettings } from '../../../api/services/settings-store.ts';
import { wireUpdateSettings } from '../helpers/settings-store-mock.js';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { savePlanSnapshot } from '../../../api/services/plan-history-store.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';
import { updatePvCurtailmentPlan } from '../../../api/services/pv-curtailment.ts';
import {
  computePlan,
  planAndMaybeWrite,
  getLastPlan,
  getLastEvPreview,
  getCurrentSlotMode,
  writePlanToVictron,
} from '../../../api/services/planner-service.ts';
import { Strategy, Restrictions, FeedIn, mapRowsToDessV2 } from '../../../lib/dess-mapper.ts';
import { buildPlanSummary } from '../../../lib/plan-summary.ts';
import { resolvePlanningWindow } from '../../../lib/time-series-utils.ts';

// Tests run with TZ=Europe/Amsterdam (vitest.config.js).
const Q = 15 * 60_000;
const MIDNIGHT = Date.parse('2026-10-12T22:00:00Z'); // 00:00 CEST, 13 Oct
const NOW = Date.parse('2026-10-13T10:00:00Z');      // 12:00 CEST
const FIRM_SLOTS = 46;
const FIRM_END = NOW + FIRM_SLOTS * Q;                // 23:30 CEST: end of the posted prices
// extraDays 1: the local midnight at or after the firm end, plus one day.
const WINDOW_END = Date.parse('2026-10-14T22:00:00Z'); // 00:00 CEST, 15 Oct
const TOTAL_SLOTS = (WINDOW_END - NOW) / Q;           // 144
const iso = ms => new Date(ms).toISOString();

const market = q => 10 + 6 * Math.sin(q / 9) + (q % 4) * 0.5;
const quarterIndex = ms => Math.round((ms - MIDNIGHT) / Q);
const importAt = i => 1.21 * market(quarterIndex(NOW + i * Q)) + 14;

const extendedHorizon = (overrides = {}) => ({
  mode: 'on',
  extraDays: 1,
  forecastUrl: 'https://epexpredictor.batzill.com',
  region: 'NL',
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1,
  refreshMinutes: 60,
  ...overrides,
});

const baseSettings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 20000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 1,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  // Posted (api) prices end at the firm end; VRM load/PV reach past the window.
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'api', soc: 'api' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 1,
};
const onSettings = (overrides = {}) => ({ ...baseSettings, extendedHorizon: extendedHorizon(), ...overrides });

const forecast = (overrides = {}) => ({
  fetchedAt: iso(NOW - 30 * 60_000),
  publishedEnd: iso(FIRM_END),
  region: 'NL',
  series: { start: iso(MIDNIGHT), step: 15, values: Array.from({ length: 5 * 96 }, (_, q) => market(q)) },
  ...overrides,
});

const LONG = 300;
const series = (n, f) => ({ start: iso(NOW), step: 15, values: Array.from({ length: n }, (_, i) => f(i)) });
const makeData = (overrides = {}) => ({
  load: series(LONG, () => 800),
  pv: series(LONG, i => (i % 96 > 70 || i % 96 < 20 ? 3000 : 0)),
  importPrice: series(FIRM_SLOTS, importAt),
  exportPrice: series(FIRM_SLOTS, importAt),
  soc: { timestamp: iso(NOW), value: 50 },
  rebalanceState: { startMs: null },
  priceForecast: forecast(),
  ...overrides,
});

const evSettings = {
  evEnabled: true,
  evSource: 'native',
  evSocSensor: 'sensor.ev_soc',
  evPlugSensor: 'binary_sensor.ev_plug',
  evChargePhases: 1,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 10,
  evTargetSoc_percent: 80,
  evChargeEfficiency_percent: 100,
  evDepartureTime: '',
  evStartTime: '',
  evMinSoc_percent: 0,
  evApplyPriceLimit: false,
  evOpportunisticEnabled: false,
};

let warnSpy;
let errorSpy;
let logSpy;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  solverCtl.solveHook = null;
  solverCtl.calls = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  refreshSeriesFromVrmAndPersist.mockResolvedValue();
  setDynamicEssSchedule.mockResolvedValue();
  saveSettings.mockResolvedValue();
  wireUpdateSettings({ loadSettings, saveSettings, updateSettings });
  wireUpdateData({ loadData, saveData, updateData });
  saveData.mockResolvedValue();
  savePlanSnapshot.mockResolvedValue();
  // Car disconnected; the SoC sensor still reads (EV tests only).
  fetchHaEntityState.mockImplementation(async ({ entityId }) =>
    entityId === 'binary_sensor.ev_plug' ? { state: 'off' } : { state: '55' });
  loadSettings.mockResolvedValue(onSettings());
  loadData.mockResolvedValue(makeData());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const extendedWarnings = () => warnSpy.mock.calls.map(([m]) => m).filter(m => typeof m === 'string' && m.startsWith('[extended-horizon]'));

describe('computePlan — multi-day horizon on', () => {
  it('replaces the firm-only plan with the Optimal extended plan', async () => {
    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(plan.rows).toHaveLength(TOTAL_SLOTS);
    expect(plan.cfg.firmSlots).toBe(FIRM_SLOTS);
    expect(plan.cfg.load_W).toHaveLength(TOTAL_SLOTS);
    expect(plan.rows.slice(0, FIRM_SLOTS).every(r => r.priceForecast === undefined)).toBe(true);
    expect(plan.rows.slice(FIRM_SLOTS).every(r => r.priceForecast === true)).toBe(true);
    // Firm solve first, then the extended one with its own options.
    expect(solverCtl.calls.map(c => c.extended)).toEqual([false, true]);
    expect(solverCtl.calls[1].options).toMatchObject({ mip_rel_gap: 0, time_limit: 15 });
    expect(getLastPlan()).toBe(plan);

    expect(plan.summary.extendedHorizon).toEqual({
      mode: 'on',
      firmEndMs: FIRM_END,
      endMs: WINDOW_END,
      extendedSlots: TOTAL_SLOTS - FIRM_SLOTS,
      firmObjective: expect.any(Number),
      fit: { a: expect.closeTo(1.21, 6), b: expect.closeTo(14, 5), source: 'fresh' },
      status: 'extended',
    });
    expect(plan.summary.horizonWarnings).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('[extended-horizon] solve', expect.objectContaining({
      status: 'Optimal', firmSlots: FIRM_SLOTS, extendedSlots: TOTAL_SLOTS - FIRM_SLOTS, endReason: 'window', solveMs: expect.any(Number),
    }));
    // The fresh fit is stored as the fallback (fire-and-forget).
    await vi.waitFor(() => expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      priceForecast: expect.objectContaining({ fit: expect.objectContaining({ a: expect.closeTo(1.21, 6) }) }),
    })));
  });

  it('maps DESS on the firm rows only; forecast rows get the never-written sentinel', async () => {
    loadSettings.mockResolvedValue(onSettings({ pvCurtailment: { enabled: true } }));
    const plan = await computePlan();

    const firm = plan.rows.slice(0, FIRM_SLOTS);
    const expected = mapRowsToDessV2(firm, plan.cfg, { blockFeedInOnNegativePrices: true });
    expect(firm.map(r => r.dess)).toEqual(expected.perSlot);
    expect(firm.every(r => r.dess.strategy !== Strategy.unknown)).toBe(true);
    for (const row of plan.rows.slice(FIRM_SLOTS)) {
      expect(row.dess).toEqual({
        feedin: FeedIn.blocked,
        restrictions: Restrictions.unknown,
        strategy: Strategy.unknown,
        flags: 0,
        socTarget_percent: row.soc_percent,
      });
      expect(row.pvControl.reason).toBe('no_current_slot');
    }
    // Tipping points from the firm rows only.
    expect(plan.summary.gridChargeTippingPoint_cents_per_kWh)
      .toBe(Number.isFinite(expected.diagnostics.gridChargeTippingPoint_cents_per_kWh) ? expected.diagnostics.gridChargeTippingPoint_cents_per_kWh : null);
  });

  it('reports firm totals as before and the forecast rows separately', async () => {
    const plan = await computePlan();

    const firmOnly = buildPlanSummary(plan.rows.slice(0, FIRM_SLOTS), plan.cfg);
    const forecastOnly = buildPlanSummary(plan.rows.slice(FIRM_SLOTS).map(({ priceForecast: _f, ...r }) => r), plan.cfg);
    expect(plan.summary.loadTotal_kWh).toBeCloseTo(firmOnly.loadTotal_kWh, 9);
    expect(plan.summary.netGridCost_cents).toBeCloseTo(firmOnly.netGridCost_cents, 9);
    expect(plan.summary.forecast.loadTotal_kWh).toBeCloseTo(forecastOnly.loadTotal_kWh, 9);
    expect(plan.summary.forecast.netGridCost_cents).toBeCloseTo(forecastOnly.netGridCost_cents, 9);
    expect(plan.summary.forecast).not.toHaveProperty('rebalanceStatus');
  });

  it('writes and fingerprints the firm slots only (46 < 48)', async () => {
    const plan = await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });

    expect(plan.rows.length).toBeGreaterThan(48);
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);
    expect(setDynamicEssSchedule.mock.calls[0][1]).toBe(FIRM_SLOTS);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('skipping write'));

    // Same firm slots: the fingerprint matches and the write is skipped.
    await planAndMaybeWrite({ writeToVictron: true });
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(`[mqtt] DESS schedule unchanged, skipping write (${FIRM_SLOTS} slots)`);
  });

  it('stores the firm slots only in plan history and hands every row to the PV-curtailment loop', async () => {
    const plan = await computePlan();

    const snapshot = savePlanSnapshot.mock.calls[0][0];
    expect(snapshot.slots).toHaveLength(FIRM_SLOTS);
    expect(snapshot.slots.every(s => s.timestampMs < FIRM_END)).toBe(true);
    expect(updatePvCurtailmentPlan).toHaveBeenCalledWith({ cfg: plan.cfg, rows: plan.rows });
  });

  it('reads a forecast row as no current slot for the shore optimizer', async () => {
    const plan = await computePlan();

    expect(getCurrentSlotMode(NOW)).not.toBe('unknown');
    expect(getCurrentSlotMode(FIRM_END + Q)).toBe('unknown');
    expect(plan.rows[FIRM_SLOTS + 1].timestampMs).toBe(FIRM_END + Q);
  });

  it('keeps the EV preview firm-only', async () => {
    loadSettings.mockResolvedValue(onSettings(evSettings));

    const plan = await computePlan();

    expect(plan.rows).toHaveLength(TOTAL_SLOTS);
    const preview = getLastEvPreview();
    expect(preview.hasSchedule).toBe(true);
    expect(preview.rows).toHaveLength(FIRM_SLOTS);
    expect(preview.rows.some(r => r.priceForecast)).toBe(false);
    // Firm solve, extended solve, then the (firm-only) preview solve.
    expect(solverCtl.calls.map(c => c.extended)).toEqual([false, true, false]);
  });

  it('keeps the flat EV preview track firm-only when the preview has no charge window', async () => {
    // Earliest start past the firm end: no EV window in the (firm) preview config.
    loadSettings.mockResolvedValue(onSettings({ ...evSettings, evStartTime: iso(FIRM_END + Q) }));

    await computePlan();

    const preview = getLastEvPreview();
    expect(preview.hasSchedule).toBe(false);
    expect(preview.rows).toHaveLength(FIRM_SLOTS);
    expect(preview.rows.every(r => r.ev_soc_percent === 55 && !r.priceForecast)).toBe(true);
  });

  it('warns when the price forecast ends before the planning window', async () => {
    const short = forecast();
    short.series = { ...short.series, values: short.series.values.slice(0, quarterIndex(WINDOW_END) - 8) };
    loadData.mockResolvedValue(makeData({ priceForecast: short }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.status).toBe('extended');
    expect(plan.summary.extendedHorizon.endMs).toBe(WINDOW_END - 8 * Q);
    const warning = `Multi-day horizon cut short at ${iso(WINDOW_END - 8 * Q)}: the price forecast does not reach further`;
    expect(plan.summary.horizonWarnings).toEqual([warning]);
    expect(warnSpy).toHaveBeenCalledWith(`[extended-horizon] ${warning}`);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('STALE DATA'));
  });

  it('names a VRM load forecast that caps the extension', async () => {
    loadData.mockResolvedValue(makeData({ load: series(TOTAL_SLOTS - 10, () => 800) }));

    const plan = await computePlan();

    expect(plan.summary.horizonWarnings).toEqual([
      `Multi-day horizon cut short at ${iso(WINDOW_END - 10 * Q)}: the VRM load forecast does not reach further`,
    ]);
  });

  it('checks api load/PV against the extended window end instead', async () => {
    loadSettings.mockResolvedValue(onSettings({ dataSources: { load: 'api', pv: 'api', prices: 'api', soc: 'api' } }));
    loadData.mockResolvedValue(makeData({ pv: series(TOTAL_SLOTS - 20, () => 0) }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.endMs).toBe(WINDOW_END - 20 * Q);
    // Reported once, as a series warning (not again as "cut short").
    expect(plan.summary.horizonWarnings).toEqual(['PV forecast ends 5h short of the multi-day horizon — the extension is cut short there']);
    expect(extendedWarnings()).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('STALE DATA'));
  });

  it('reports the firm-only objective next to the extended plan\'s own', async () => {
    const firmObjectives = [];
    solverCtl.solveHook = ({ extended, instance, lp, options }) => {
      const result = instance.solve(lp, options);
      if (!extended) firmObjectives.push(result.ObjectiveValue);
      return result;
    };

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.status).toBe('extended');
    expect(plan.summary.extendedHorizon.firmObjective).toBe(firmObjectives[0]);
    // /calculate's objectiveValue is the extended solve's (forecast slots included).
    expect(plan.result.ObjectiveValue).not.toBe(firmObjectives[0]);
  });

  it('leaves firmObjective out when the firm solve reports none', async () => {
    solverCtl.solveHook = ({ extended, instance, lp, options }) => (extended
      ? instance.solve(lp, options)
      : { ...instance.solve(lp, options), ObjectiveValue: undefined });

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.status).toBe('extended');
    expect(plan.summary.extendedHorizon).not.toHaveProperty('firmObjective');
    // The extended MIP gap falls back to its floor without a firm objective.
    expect(solverCtl.calls[1].options.mip_abs_gap).toBe(0.01);
  });

  it('keeps the extended end and warns about nothing when midnight passes', async () => {
    // Wed 14 Oct 00:00 CEST; prices published through Wed 24:00 (since Tue
    // 13:00). The api load/PV were predicted at Tue 23:45, when the
    // predictor window ended Fri 00:00 (tomorrow 24:00 + 1 day); since
    // midnight it would end Sat 00:00, but the extension ends Fri 00:00
    // (the firm end + 1 day) as it did a quarter-hour earlier.
    const now = Date.parse('2026-10-13T22:00:00Z');
    const firmEnd = Date.parse('2026-10-14T22:00:00Z');
    const settings = onSettings({ dataSources: { load: 'api', pv: 'api', prices: 'api', soc: 'api' } });
    const predicted = resolvePlanningWindow(settings, now - Q);
    expect(predicted.endIso).toBe('2026-10-15T22:00:00.000Z');
    const n = (Date.parse(predicted.endIso) - Date.parse(predicted.startIso)) / Q;
    const prices = { start: iso(now), step: 15, values: Array.from({ length: (firmEnd - now) / Q }, (_, i) => 1.21 * market(quarterIndex(now + i * Q)) + 14) };
    vi.setSystemTime(new Date(now));
    loadSettings.mockResolvedValue(settings);
    loadData.mockResolvedValue(makeData({
      load: { start: predicted.startIso, step: 15, values: new Array(n).fill(700) },
      pv: { start: predicted.startIso, step: 15, values: Array.from({ length: n }, (_, i) => (i % 96 > 30 && i % 96 < 70 ? 2000 : 0)) },
      importPrice: prices,
      exportPrice: prices,
      soc: { timestamp: iso(now), value: 50 },
      priceForecast: forecast({ fetchedAt: iso(now - 30 * 60_000), publishedEnd: iso(firmEnd) }),
    }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon).toMatchObject({ status: 'extended', firmEndMs: firmEnd, endMs: Date.parse(predicted.endIso) });
    expect(plan.summary.horizonWarnings).toBeUndefined();
    expect(extendedWarnings()).toEqual([]);
  });

  it('cuts the extension at 1 January when the fit is on this year\'s prices', async () => {
    // Thu 31 Dec 2026 12:00 CET; prices posted through 22:00 CET.
    const now = Date.parse('2026-12-31T11:00:00Z');
    const midnight = Date.parse('2026-12-30T23:00:00Z');
    const firmEnd = Date.parse('2026-12-31T21:00:00Z');
    const newYear = Date.parse('2026-12-31T23:00:00Z');
    const m = ms => market(Math.round((ms - midnight) / Q));
    const prices = { start: iso(now), step: 15, values: Array.from({ length: (firmEnd - now) / Q }, (_, i) => 1.21 * m(now + i * Q) + 14) };
    vi.setSystemTime(new Date(now));
    loadData.mockResolvedValue(makeData({
      load: { start: iso(now), step: 15, values: new Array(LONG).fill(800) },
      pv: { start: iso(now), step: 15, values: new Array(LONG).fill(0) },
      importPrice: prices,
      exportPrice: prices,
      soc: { timestamp: iso(now), value: 50 },
      priceForecast: forecast({
        fetchedAt: iso(now - 30 * 60_000),
        publishedEnd: iso(firmEnd),
        series: { start: iso(midnight), step: 15, values: Array.from({ length: 5 * 96 }, (_, q) => market(q)) },
      }),
    }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon).toMatchObject({ status: 'extended', firmEndMs: firmEnd, endMs: newYear, extendedSlots: 8 });
    expect(plan.rows.at(-1).timestampMs).toBe(newYear - Q);
    expect(plan.summary.horizonWarnings).toEqual([
      `Multi-day horizon cut short at ${iso(newYear)}: the import fit is on this year's published prices and does not price next year's slots (taxes change on 1 January)`,
    ]);
  });

  it('extends with the stored fit when the fresh one is rejected, without re-persisting it', async () => {
    const noisy = forecast({ fit: { a: 1.2, b: 15, n: 30, mad: 0.3, fittedAt: iso(NOW - 24 * 3600_000) } });
    noisy.series = { ...noisy.series, values: noisy.series.values.map((_, q) => ((q * 7919) % 23) - 5) };
    loadData.mockResolvedValue(makeData({ priceForecast: noisy }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon).toMatchObject({ status: 'extended', fit: { a: 1.2, b: 15, source: 'stored' } });
    await Promise.resolve();
    expect(saveData).not.toHaveBeenCalledWith(expect.objectContaining({ priceForecast: expect.anything() }));
  });

  it('names an EV load series that caps the extension', async () => {
    loadData.mockResolvedValue(makeData({ evLoad: series(TOTAL_SLOTS - 4, () => 0) }));

    const plan = await computePlan();

    expect(plan.summary.horizonWarnings).toEqual([
      `Multi-day horizon cut short at ${iso(WINDOW_END - 4 * Q)}: the EV load series does not reach further`,
    ]);
  });
});

describe('computePlan — multi-day horizon falls back to the firm-only plan', () => {
  async function firmOnlyReference() {
    loadSettings.mockResolvedValueOnce(onSettings({ extendedHorizon: extendedHorizon({ mode: 'off' }) }));
    const ref = await computePlan();
    vi.clearAllMocks();
    solverCtl.calls = [];
    return ref;
  }

  it('when the extended solve is not Optimal', async () => {
    const ref = await firmOnlyReference();
    solverCtl.solveHook = ({ extended, instance, lp, options }) => (extended
      ? { Status: 'Time limit reached', ObjectiveValue: 1, Columns: {} }
      : instance.solve(lp, options));

    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(plan.rows).toEqual(ref.rows);
    expect(plan.cfg).toEqual(ref.cfg);
    expect(plan.rows.some(r => r.priceForecast)).toBe(false);
    expect(getLastPlan()).toBe(plan);
    const reason = 'the extended solve ended with status "Time limit reached"';
    expect(plan.summary.extendedHorizon).toEqual({
      mode: 'on',
      firmEndMs: FIRM_END,
      endMs: FIRM_END,
      extendedSlots: 0,
      firmObjective: ref.result.ObjectiveValue,
      fit: { a: expect.closeTo(1.21, 6), b: expect.closeTo(14, 5), source: 'fresh' },
      status: 'firmOnly',
      reason,
    });
    // Firm-only: the plan's objective is the firm objective.
    expect(plan.result.ObjectiveValue).toBe(ref.result.ObjectiveValue);
    expect(plan.summary.horizonWarnings).toEqual([`Multi-day horizon not used: ${reason} — planning with published prices only`]);
    expect(extendedWarnings()).toEqual([`[extended-horizon] Multi-day horizon not used: ${reason} — planning with published prices only`]);

    await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });
    expect(setDynamicEssSchedule.mock.calls[0][1]).toBe(FIRM_SLOTS);
  });

  it('when the extended solve throws, and the EV preview solves on a fresh HiGHS instance', async () => {
    loadSettings.mockResolvedValue(onSettings(evSettings));
    const ref = await firmOnlyReference();
    loadSettings.mockResolvedValue(onSettings(evSettings));
    const instances = [];
    solverCtl.solveHook = ({ extended, instance, lp, options }) => {
      instances.push(instance);
      if (extended) throw new Error('RuntimeError: unreachable');
      return instance.solve(lp, options);
    };

    const plan = await computePlan();

    expect(plan.result.Status).toBe('Optimal');
    expect(plan.rows).toEqual(ref.rows);
    expect(plan.cfg).toEqual(ref.cfg);
    expect(getLastPlan()).toBe(plan);
    const reason = 'the extended solve failed';
    expect(plan.summary.extendedHorizon).toEqual({
      mode: 'on',
      firmEndMs: FIRM_END,
      endMs: FIRM_END,
      extendedSlots: 0,
      firmObjective: ref.result.ObjectiveValue,
      fit: { a: expect.closeTo(1.21, 6), b: expect.closeTo(14, 5), source: 'fresh' },
      status: 'firmOnly',
      reason,
    });
    expect(plan.summary.horizonWarnings).toEqual([`Multi-day horizon not used: ${reason} — planning with published prices only`]);
    expect(errorSpy).toHaveBeenCalledWith('[extended-horizon] extended solve threw:', 'RuntimeError: unreachable');
    // Firm solve and extended solve on one instance; the preview on a new one.
    expect(solverCtl.calls.map(c => c.extended)).toEqual([false, true, false]);
    expect(instances[1]).toBe(instances[0]);
    expect(instances[2]).not.toBe(instances[0]);
    const preview = getLastEvPreview();
    expect(preview.hasSchedule).toBe(true);
    expect(preview.rows).toHaveLength(FIRM_SLOTS);

    // The next plan keeps using the fresh instance.
    solverCtl.solveHook = ({ instance, lp, options }) => {
      instances.push(instance);
      return instance.solve(lp, options);
    };
    await computePlan();
    expect(instances[3]).toBe(instances[2]);
  });

  it.each([
    ['missing', { priceForecast: undefined }, 'the price forecast is missing'],
    ['stale', { priceForecast: forecast({ fetchedAt: iso(NOW - 13 * 3600_000) }) }, 'the price forecast is stale'],
    ['for another region', { priceForecast: forecast({ region: 'DE-LU' }) }, 'the price forecast is for another region'],
  ])('when the forecast is %s', async (_label, overrides, reason) => {
    const ref = await firmOnlyReference();
    loadData.mockResolvedValue(makeData(overrides));

    const plan = await computePlan();

    expect(plan.rows).toEqual(ref.rows);
    expect(solverCtl.calls.map(c => c.extended)).toEqual([false]);
    expect(plan.summary.extendedHorizon).toEqual({
      mode: 'on', firmEndMs: FIRM_END, endMs: FIRM_END, extendedSlots: 0, firmObjective: ref.result.ObjectiveValue, status: 'firmOnly', reason,
    });
    expect(plan.summary.horizonWarnings).toEqual([`Multi-day horizon not used: ${reason} — planning with published prices only`]);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('STALE DATA'));
  });

  it('when the import fit is rejected', async () => {
    const noisy = forecast();
    noisy.series = { ...noisy.series, values: noisy.series.values.map((_, q) => ((q * 7919) % 23) - 5) };
    loadData.mockResolvedValue(makeData({ priceForecast: noisy }));

    const plan = await computePlan();

    expect(plan.rows).toHaveLength(FIRM_SLOTS);
    expect(plan.summary.extendedHorizon.status).toBe('firmOnly');
    expect(plan.summary.extendedHorizon.reason).toMatch(/fit/i);
    expect(plan.summary.horizonWarnings[0]).toMatch(/^Multi-day horizon not used: /);
  });

  it('when nothing can be appended', async () => {
    loadData.mockResolvedValue(makeData({ load: series(FIRM_SLOTS, () => 800) }));

    const plan = await computePlan();

    expect(plan.rows).toHaveLength(FIRM_SLOTS);
    expect(plan.summary.extendedHorizon.reason).toBe('no slots to append: the load data ends at or before the firm end');
  });

  it('without an extended solve when the firm-only plan is not Optimal', async () => {
    // An early stop that keeps its incumbent: display-only, never extended.
    solverCtl.solveHook = ({ instance, lp, options }) => ({ ...instance.solve(lp, options), Status: 'Time limit reached' });

    const plan = await computePlan();

    expect(solverCtl.calls).toHaveLength(1);
    expect(plan.rows).toHaveLength(FIRM_SLOTS);
    expect(plan.summary.extendedHorizon).toEqual({
      mode: 'on', firmEndMs: FIRM_END, endMs: FIRM_END, extendedSlots: 0, firmObjective: plan.result.ObjectiveValue, status: 'firmOnly', reason: 'the published-price plan is not Optimal',
    });
    expect(plan.summary.horizonWarnings).toBeUndefined();
  });
});

describe('computePlan — multi-day horizon and the rebalance hold', () => {
  it('fixes the extended hold at the start the firm-only plan chose', async () => {
    loadSettings.mockResolvedValue(onSettings({ rebalanceEnabled: true, rebalanceHoldHours: 1 }));
    const lps = [];
    solverCtl.solveHook = ({ extended, instance, lp, options }) => {
      lps.push({ extended, lp });
      return instance.solve(lp, options);
    };

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.status).toBe('extended');
    const start = plan.rebalanceWindow.startIdx;
    expect(plan.rebalanceWindow).toEqual({ startIdx: start, endIdx: start + 3 });
    expect(start + 3).toBeLessThan(FIRM_SLOTS);
    expect(plan.cfg.rebalanceMinStartSlot).toBe(start);
    expect(plan.cfg.rebalanceMaxStartSlot).toBe(start);
    // The firm LP searched the window; the extended LP has the one start.
    const firmStarts = lps[0].lp.match(/c_balance_start:[^\n]*/)[0];
    const extStarts = lps[1].lp.match(/c_balance_start:[^\n]*/)[0];
    expect(firmStarts).toContain(`start_balance_${start} `);
    expect(extStarts.trim()).toBe(`c_balance_start: start_balance_${start} = 1`);
    // The hold slots map to the DESS hold.
    expect(plan.rows[start].dess.strategy).toBe(Strategy.proBattery);
  });

  it('defers a hold longer than the firm part and keeps it pending', async () => {
    // 12 h = 48 slots > 46 firm slots. The firm-only plan can only hold from
    // slot 0 (fast charging reaches the target within it); that forced start
    // is not inherited, so the extended plan defers the hold.
    loadSettings.mockResolvedValue(onSettings({
      rebalanceEnabled: true,
      rebalanceHoldHours: 12,
      maxChargePower_W: 20000,
    }));
    loadData.mockResolvedValue(makeData({ soc: { timestamp: iso(NOW), value: 90 } }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon.status).toBe('extended');
    expect(plan.cfg.rebalanceMaxStartSlot).toBeUndefined();
    expect(plan.rebalanceWindow).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[extended-horizon] the rebalance hold does not fit'));
    expect(logSpy).toHaveBeenCalledWith('[extended-horizon] solve', expect.objectContaining({ rebalanceDeferred: true }));
    // Still pending: rebalancing stays on, the pending marker is recorded, no start.
    expect(saveSettings).not.toHaveBeenCalled();
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ rebalanceState: { startMs: null, pendingSinceMs: NOW } }));
    expect(plan.summary.rebalanceStatus).toBe('scheduled');
  });
});

describe('computePlan — multi-day horizon off or collect', () => {
  // Tue 13 Oct 12:50 CEST: before 13:00 the old window ends tonight, but the
  // posted (api) prices already reach tomorrow 24:00 (HA has tomorrow from
  // about 12:45 too). The planner's own load/PV predictors write the
  // planning window of each mode: tonight with off, days ahead with collect.
  const now = Date.parse('2026-10-13T10:50:00Z');
  const slotStart = Date.parse('2026-10-13T10:45:00Z');
  const tomorrowEnd = Date.parse('2026-10-14T22:00:00Z');
  const priceSeries = { start: iso(slotStart), step: 15, values: Array.from({ length: (tomorrowEnd - slotStart) / Q }, (_, i) => 20 + 8 * Math.sin(i / 7)) };
  const apiSources = { load: 'api', pv: 'api', prices: 'api', soc: 'api' };

  /** Data as the predictors leave it for `settings`: load/PV over its planning window. */
  const dataFor = (settings) => {
    const { startIso, endIso } = resolvePlanningWindow(settings, now);
    const n = (Date.parse(endIso) - Date.parse(startIso)) / Q;
    return makeData({
      load: { start: startIso, step: 15, values: Array.from({ length: n }, (_, i) => 600 + (i % 5) * 40) },
      pv: { start: startIso, step: 15, values: Array.from({ length: n }, (_, i) => (i % 96 < 24 ? 2500 : 0)) },
      importPrice: priceSeries,
      exportPrice: priceSeries,
      soc: { timestamp: iso(now), value: 50 },
    });
  };

  const run = async (settings) => {
    vi.clearAllMocks();
    solverCtl.calls = [];
    loadSettings.mockResolvedValue(settings);
    const data = dataFor(settings);
    loadData.mockResolvedValue(data);
    const plan = await planAndMaybeWrite({ writeToVictron: true, forceWrite: true });
    return {
      loadSlots: data.load.values.length,
      out: {
        T: plan.cfg.load_W.length,
        cfg: plan.cfg,
        rows: plan.rows,
        summary: plan.summary,
        result: plan.result,
        timing: plan.timing,
        snapshot: JSON.stringify({ ...savePlanSnapshot.mock.calls[0][0], planId: 0, createdAtMs: 0 }),
        write: setDynamicEssSchedule.mock.calls[0],
        solves: solverCtl.calls.length,
      },
    };
  };

  it('plans, maps DESS and writes exactly as off, although collect\'s load/PV run days further', async () => {
    vi.setSystemTime(new Date(now));
    const settings = mode => ({ ...baseSettings, dataSources: apiSources, extendedHorizon: extendedHorizon({ mode, extraDays: 3 }) });

    const off = await run(settings('off'));
    const collect = await run(settings('collect'));
    const { dataSources: _d, ...noBlock } = settings('off');
    delete noBlock.extendedHorizon;
    const none = await run({ ...noBlock, dataSources: apiSources });

    // The window ends tonight: 45 slots from 12:45; collect's load/PV reach 4 days further.
    expect(off.out.T).toBe(45);
    expect(off.loadSlots).toBe(45);
    expect(collect.loadSlots).toBe(45 + 4 * 96);
    expect(off.out.write[1]).toBe(45);
    expect(off.out.solves).toBe(1);
    expect(collect.out).toEqual(off.out);
    expect(none.out).toEqual(off.out);
    expect(collect.out.summary).not.toHaveProperty('extendedHorizon');
    expect(collect.out.rows.some(r => 'priceForecast' in r)).toBe(false);
  });
});

describe('computePlan — forecast source', () => {
  const PUBLIC = 'https://epexpredictor.batzill.com';
  const fallback = (reason = 'not installed') => forecast({ source: 'public', url: PUBLIC, sourceReason: reason });

  it('reports where the stored forecast came from in summary.extendedHorizon', async () => {
    loadData.mockResolvedValue(makeData({ priceForecast: forecast({ source: 'local', url: 'http://601a68d0-epexpredictor' }) }));
    loadSettings.mockResolvedValue(onSettings({ extendedHorizon: extendedHorizon({ forecastUrl: 'auto' }) }));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon).toMatchObject({
      status: 'extended',
      forecastSource: { source: 'local', url: 'http://601a68d0-epexpredictor' },
    });
    expect(plan.summary.horizonWarnings).toBeUndefined();
  });

  it('leaves forecastSource out for a forecast stored without one (before 0.7.73)', async () => {
    const plan = await computePlan();
    expect(plan.summary.extendedHorizon).not.toHaveProperty('forecastSource');
  });

  it('reports it on a firm-only plan too', async () => {
    loadData.mockResolvedValue(makeData({ priceForecast: forecast({ source: 'configured', url: 'http://192.0.2.10:8000' }) }));
    solverCtl.solveHook = ({ extended, instance, lp, options }) => (extended ? { Status: 'Infeasible' } : instance.solve(lp, options));

    const plan = await computePlan();

    expect(plan.summary.extendedHorizon).toMatchObject({ status: 'firmOnly', forecastSource: { source: 'configured', url: 'http://192.0.2.10:8000' } });
  });

  it('warns when auto fell back to the public server, with the stored reason', async () => {
    loadData.mockResolvedValue(makeData({ priceForecast: fallback('not started (state stopped)') }));
    loadSettings.mockResolvedValue(onSettings({ extendedHorizon: extendedHorizon({ forecastUrl: 'auto' }) }));

    const plan = await computePlan();

    const warning = 'Local EpexPredictor add-on not used (not started (state stopped)): forecast from the public server';
    expect(plan.summary.extendedHorizon.forecastSource).toEqual({ source: 'public', url: PUBLIC });
    expect(plan.summary.horizonWarnings).toEqual([warning]);
    expect(extendedWarnings()).toEqual([`[extended-horizon] ${warning}`]);
  });

  it('warns in collect mode as well, and names no reason when none was stored', async () => {
    const { sourceReason: _r, ...noReason } = fallback();
    loadData.mockResolvedValue(makeData({ priceForecast: noReason }));
    loadSettings.mockResolvedValue(onSettings({ extendedHorizon: extendedHorizon({ mode: 'collect', forecastUrl: 'auto' }) }));

    const plan = await computePlan();

    expect(plan.summary).not.toHaveProperty('extendedHorizon');
    expect(plan.summary.horizonWarnings).toEqual(['Local EpexPredictor add-on not used (reason unknown): forecast from the public server']);
  });

  it('does not warn with the mode off, a configured URL, or a forecast that did not fall back', async () => {
    const cases = [
      [extendedHorizon({ mode: 'off', forecastUrl: 'auto' }), fallback()],
      [extendedHorizon({ forecastUrl: PUBLIC }), fallback()],
      [extendedHorizon({ forecastUrl: 'auto' }), forecast({ source: 'local', url: 'http://h' })],
      [extendedHorizon({ forecastUrl: 'auto' }), forecast()],
    ];
    for (const [eh, priceForecast] of cases) {
      loadSettings.mockResolvedValue(onSettings({ extendedHorizon: eh }));
      loadData.mockResolvedValue(makeData({ priceForecast }));
      const plan = await computePlan();
      expect(plan.summary.horizonWarnings ?? []).not.toContainEqual(expect.stringContaining('EpexPredictor'));
    }
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue(makeData({ priceForecast: fallback() }));
    expect((await computePlan()).summary.horizonWarnings).toBeUndefined();
  });
});

describe('writePlanToVictron — firm slots only', () => {
  const dessRow = (i, overrides = {}) => ({
    timestampMs: NOW + i * Q,
    dess: { strategy: Strategy.selfConsumption, restrictions: Restrictions.none, feedin: FeedIn.allowed, flags: 0, socTarget_percent: 50 },
    ...overrides,
  });
  const sentinel = { strategy: Strategy.unknown, restrictions: Restrictions.unknown, feedin: FeedIn.blocked, flags: 0, socTarget_percent: 50 };
  const plan = (firm, forecastCount, forecastDess = sentinel) => [
    ...Array.from({ length: firm }, (_, i) => dessRow(i)),
    ...Array.from({ length: forecastCount }, (_, i) => dessRow(firm + i, { priceForecast: true, dess: forecastDess })),
  ];

  it('writes min(48, firm slots) and fingerprints the same slots', async () => {
    await writePlanToVictron(plan(46, 100), { force: true });
    expect(setDynamicEssSchedule).toHaveBeenLastCalledWith(expect.any(Array), 46);

    // Only forecast rows differ: unchanged fingerprint, no write.
    await writePlanToVictron(plan(46, 100, { ...sentinel, socTarget_percent: 99 }));
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(1);

    // The firm part grows (prices published): a different fingerprint, rewritten.
    await writePlanToVictron(plan(47, 99));
    expect(setDynamicEssSchedule).toHaveBeenCalledTimes(2);
    expect(setDynamicEssSchedule).toHaveBeenLastCalledWith(expect.any(Array), 47);

    // More firm slots than DESS holds: capped at 48 as today.
    await writePlanToVictron(plan(60, 100), { force: true });
    expect(setDynamicEssSchedule).toHaveBeenLastCalledWith(expect.any(Array), 48);
  });
});
