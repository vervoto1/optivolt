import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(),
  saveData: vi.fn(),
  updateData: vi.fn(),
}));

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
}));

import {
  buildSolverConfigFromSettings,
  buildPlannerConfig,
  buildExtendedSolverConfig,
  persistPriceForecastFit,
  FIT_REWRITE_MIN_AGE_MS,
} from '../../../api/services/config-builder.ts';
import { loadData, saveData, updateData } from '../../../api/services/data-store.ts';
import { wireUpdateData } from '../helpers/data-store-mock.js';
import { HttpError } from '../../../api/http-errors.ts';
import { isRebalanceHoldDeferred } from '../../../lib/build-lp.ts';

// Tests run with TZ=Europe/Amsterdam (vitest.config.js).
const Q = 15 * 60_000;
const DAY = 86_400_000;
const MIDNIGHT = Date.parse('2026-10-12T22:00:00Z'); // 00:00 CEST, 13 Oct
const NOW = Date.parse('2026-10-13T10:00:00Z');      // 12:00 CEST
const FIRM_END = Date.parse('2026-10-13T22:00:00Z'); // 00:00 CEST, 14 Oct: end of published prices
const WINDOW_END = Date.parse('2026-10-16T22:00:00Z'); // 00:00 CEST, 17 Oct: the firm end + 3 extra days
const iso = ms => new Date(ms).toISOString();

const market = q => 10 + 6 * Math.sin(q / 9) + (q % 4) * 0.5;
const hourMean = q => {
  const h0 = q - (q % 4);
  return (market(h0) + market(h0 + 1) + market(h0 + 2) + market(h0 + 3)) / 4;
};
const quarterIndex = ms => Math.round((ms - MIDNIGHT) / Q);
const slotTimes = (startMs, n) => Array.from({ length: n }, (_, i) => startMs + i * Q);

/** Published hourly import 1.21·m + 14 for the firm part. */
const published = slotTimes(NOW, 48).map(ms => 1.21 * hourMean(quarterIndex(ms)) + 14);

const extendedHorizon = (overrides = {}) => ({
  mode: 'on',
  extraDays: 3,
  forecastUrl: 'https://epexpredictor.batzill.com',
  region: 'NL',
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1,
  refreshMinutes: 60,
  ...overrides,
});

const makeSettings = (overrides = {}) => ({
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
  extendedHorizon: extendedHorizon(),
  ...overrides,
});

const forecast = (overrides = {}) => ({
  fetchedAt: iso(NOW - 30 * 60_000),
  publishedEnd: iso(FIRM_END),
  region: 'NL',
  series: { start: iso(MIDNIGHT), step: 15, values: Array.from({ length: 5 * 96 }, (_, q) => market(q)) },
  ...overrides,
});

/**
 * VRM-style data: published import until FIRM_END, then zero-filled to the
 * end of tomorrow (96 more slots); load and PV for 5 days.
 */
const makeData = (overrides = {}) => ({
  load: { start: iso(NOW), step: 15, values: Array.from({ length: 480 }, (_, i) => 300 + (i % 7)) },
  pv: { start: iso(NOW), step: 15, values: Array.from({ length: 480 }, (_, i) => (i % 96 < 40 ? 500 : 0)) },
  importPrice: { start: iso(NOW), step: 15, values: [...published, ...new Array(96).fill(0)] },
  importPricePublishedUntil: iso(FIRM_END),
  exportPrice: { start: iso(NOW), step: 15, values: [...published, ...new Array(96).fill(0)] },
  soc: { timestamp: iso(NOW), value: 50 },
  priceForecast: forecast(),
  ...overrides,
});

const firmResult = (overrides = {}) => ({ objective: 123, socAtFirmEnd_Wh: 4200, ...overrides });

function extend({ settings = makeSettings(), data = makeData(), firmCfg, result = firmResult() } = {}) {
  const cfg = firmCfg ?? buildSolverConfigFromSettings(settings, data, NOW);
  return { firmCfg: cfg, out: buildExtendedSolverConfig({ firmCfg: cfg, settings, data, nowMs: NOW, firmResult: result }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  wireUpdateData({ loadData, saveData, updateData });
});

describe('buildSolverConfigFromSettings — firm end', () => {
  it('caps the firm part at VRM publishedUntil with the multi-day horizon on', () => {
    const cfg = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
    expect(cfg.load_W).toHaveLength(48);
    expect(cfg.importPrice.every(v => v > 0)).toBe(true);
    expect(cfg).not.toHaveProperty('firmSlots');
  });

  it('falls back to trimming VRM trailing zeros without a stored publishedUntil', () => {
    const { importPricePublishedUntil: _drop, ...data } = makeData();
    expect(buildSolverConfigFromSettings(makeSettings(), data, NOW).load_W).toHaveLength(48);
  });

  it('keeps today\'s horizon, zero-fill included, with mode off, collect, no block, or a non-VRM source', () => {
    const data = makeData();
    const { extendedHorizon: _drop, ...noBlock } = makeSettings();
    const before = buildSolverConfigFromSettings(noBlock, data, NOW);
    expect(before.load_W).toHaveLength(144);
    for (const mode of ['off', 'collect']) {
      const cfg = buildSolverConfigFromSettings(makeSettings({ extendedHorizon: extendedHorizon({ mode }) }), data, NOW);
      expect(cfg).toEqual(before);
      expect(cfg).not.toHaveProperty('firmSlots');
    }
    const ha = makeSettings({ dataSources: { load: 'vrm', pv: 'vrm', prices: 'ha', soc: 'mqtt' } });
    expect(buildSolverConfigFromSettings(ha, data, NOW).load_W).toHaveLength(144);
  });

  describe('collect leaves the horizon as with the mode off', () => {
    // Tue 13 Oct 12:50 CEST (before 13:00): the old window ends tonight, but
    // the price source already has tomorrow (HA from about 12:45, or posted
    // multi-day api prices). With the mode off the planner's own load/PV
    // predictors end tonight; with collect they run on for days.
    const now = Date.parse('2026-10-13T10:45:00Z'); // slot start of 12:50
    const tonight = Date.parse('2026-10-13T22:00:00Z');
    const tomorrowEnd = Date.parse('2026-10-14T22:00:00Z');
    const slots = (from, to) => (to - from) / Q;
    const prices = { start: iso(now), step: 15, values: new Array(slots(now, tomorrowEnd)).fill(25) };
    const dataFor = loadEnd => ({
      load: { start: iso(now), step: 15, values: new Array(slots(now, loadEnd)).fill(400) },
      pv: { start: iso(now), step: 15, values: new Array(slots(now, loadEnd)).fill(0) },
      importPrice: prices,
      exportPrice: prices,
      soc: { timestamp: iso(now), value: 50 },
    });
    const sources = prices => ({ load: 'api', pv: 'api', prices, soc: 'api' });

    it.each(['ha', 'api'])('caps the planner\'s own load/PV at the old window end (%s prices)', prices => {
      const off = buildSolverConfigFromSettings(
        makeSettings({ dataSources: sources(prices), extendedHorizon: extendedHorizon({ mode: 'off' }) }), dataFor(tonight), now);
      const collect = buildSolverConfigFromSettings(
        makeSettings({ dataSources: sources(prices), extendedHorizon: extendedHorizon({ mode: 'collect' }) }), dataFor(WINDOW_END), now);
      expect(off.load_W).toHaveLength(slots(now, tonight));
      expect(collect).toEqual(off);
    });

    it('does not cap VRM/HA load and PV, which are never extended', () => {
      const settings = mode => makeSettings({
        dataSources: { load: 'vrm', pv: 'ha', prices: 'ha', soc: 'api' },
        extendedHorizon: extendedHorizon({ mode }),
      });
      const off = buildSolverConfigFromSettings(settings('off'), dataFor(WINDOW_END), now);
      expect(off.load_W).toHaveLength(slots(now, tomorrowEnd));
      expect(buildSolverConfigFromSettings(settings('collect'), dataFor(WINDOW_END), now)).toEqual(off);
    });

    it('does not cap the firm part with the mode on: published prices past the old window are real prices', () => {
      const on = buildSolverConfigFromSettings(makeSettings({ dataSources: sources('ha') }), dataFor(WINDOW_END), now);
      expect(on.load_W).toHaveLength(slots(now, tomorrowEnd));
    });
  });

  it('throws the same 422 when the published prices have ended, even with a fresh forecast', () => {
    const data = makeData({ importPricePublishedUntil: iso(NOW) });
    let error;
    try {
      buildSolverConfigFromSettings(makeSettings(), data, NOW);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(422);
    expect(error.message).toBe('Insufficient future data');
    expect(error.details).toEqual({
      now: iso(NOW),
      loadEnd: iso(NOW + 480 * Q),
      pvEnd: iso(NOW + 480 * Q),
      importEnd: iso(NOW + 144 * Q),
      exportEnd: iso(NOW + 144 * Q),
      publishedUntil: iso(NOW),
    });
  });

  it('treats an all-zero VRM import without a stored publishedUntil as nothing published', () => {
    const { importPricePublishedUntil: _drop, ...data } = makeData();
    data.importPrice = { ...data.importPrice, values: new Array(144).fill(0) };
    expect(() => buildSolverConfigFromSettings(makeSettings(), data, NOW)).toThrow('Insufficient future data');
  });
});

describe('buildExtendedSolverConfig — extended config', () => {
  it('appends forecast slots to the planning window end', () => {
    const { firmCfg, out } = extend();
    expect(out.skipped).toBeUndefined();
    const { cfg, info } = out;
    const total = (WINDOW_END - NOW) / Q;
    expect(info).toMatchObject({
      firmSlots: 48,
      extendedSlots: total - 48,
      totalSlots: total,
      firmEnd: iso(FIRM_END),
      end: iso(WINDOW_END),
      endReason: 'window',
      resolution: 'hourly',
      exportRelation: { kind: 'equal' },
      region: 'NL',
      fit: { source: 'fresh', method: 'theilSen', n: 12, fittedAt: iso(NOW) },
    });
    expect(info.fit.a).toBeCloseTo(1.21, 6);
    expect(info.fit.b).toBeCloseTo(14, 6);
    expect(info.newFit).toEqual({ a: info.fit.a, b: info.fit.b, n: 12, mad: info.fit.mad, fittedAt: iso(NOW) });
    expect(info.freshFitRejection).toBeUndefined();

    for (const key of ['load_W', 'pv_W', 'importPrice', 'exportPrice', 'evLoad_W']) {
      expect(cfg[key]).toHaveLength(total);
      expect(cfg[key].slice(0, 48)).toEqual(firmCfg[key]);
    }
    const data = makeData();
    expect(cfg.load_W.slice(48)).toEqual(data.load.values.slice(48, total));
    expect(cfg.pv_W.slice(48)).toEqual(data.pv.values.slice(48, total));
    expect(cfg.evLoad_W.slice(48).every(v => v === 0)).toBe(true);
    const t = 48 + 9;
    expect(cfg.importPrice[t]).toBeCloseTo(1.21 * hourMean(quarterIndex(NOW + t * Q)) + 14, 6);
    expect(cfg.exportPrice.slice(48)).toEqual(cfg.importPrice.slice(48));
    expect(cfg).toMatchObject({ firmSlots: 48, socRef_Wh: 4200, carryOverMargin_cents_per_kWh: 1 });
    expect(cfg.exportTariffInfo).toBeUndefined();
    expect(cfg.rebalanceMaxStartSlot).toBeUndefined();
    // The firm config is not mutated.
    expect(firmCfg.load_W).toHaveLength(48);
    expect(firmCfg).not.toHaveProperty('firmSlots');
  });

  it('keeps the extended end when midnight passes and the firm end does not move', () => {
    // Published (VRM) through Wed 14 Oct 24:00 (since Tue 13:00); planned
    // at Tue 23:45 and at Wed 00:00, when the predictor window (tomorrow
    // 24:00 + extraDays) moves a day on.
    const firmEnd = Date.parse('2026-10-14T22:00:00Z');
    const values = slotTimes(NOW, (firmEnd - NOW) / Q).map(ms => 1.21 * hourMean(quarterIndex(ms)) + 14);
    const series = { start: iso(NOW), step: 15, values };
    const endAt = nowMs => {
      const data = makeData({
        importPrice: series,
        exportPrice: series,
        importPricePublishedUntil: iso(firmEnd),
        priceForecast: forecast({
          fetchedAt: iso(nowMs - 30 * 60_000),
          publishedEnd: iso(firmEnd),
          series: { start: iso(MIDNIGHT), step: 15, values: Array.from({ length: 7 * 96 }, (_, q) => market(q)) },
        }),
      });
      const settings = makeSettings();
      const firmCfg = buildSolverConfigFromSettings(settings, data, nowMs);
      return buildExtendedSolverConfig({ firmCfg, settings, data, nowMs, firmResult: firmResult() }).info;
    };
    const before = endAt(Date.parse('2026-10-13T21:45:00Z')); // Tue 23:45 CEST
    const after = endAt(Date.parse('2026-10-13T22:00:00Z'));  // Wed 00:00 CEST
    // Thu 15 Oct 00:00 + 3 days = Sun 18 Oct 00:00 CEST, both times.
    expect(before).toMatchObject({ firmEnd: iso(firmEnd), end: '2026-10-17T22:00:00.000Z', endReason: 'window' });
    expect(after).toMatchObject({ firmEnd: iso(firmEnd), end: '2026-10-17T22:00:00.000Z', endReason: 'window' });
  });

  it('ends at the earliest of load, PV and forecast, and where pricing runs out', () => {
    const shortPv = makeData();
    shortPv.pv = { ...shortPv.pv, values: shortPv.pv.values.slice(0, 100) };
    expect(extend({ data: shortPv }).out.info).toMatchObject({ endReason: 'pv', totalSlots: 100 });

    const shortLoad = makeData();
    shortLoad.load = { ...shortLoad.load, values: shortLoad.load.values.slice(0, 90) };
    expect(extend({ data: shortLoad }).out.info).toMatchObject({ endReason: 'load', totalSlots: 90 });

    // The forecast ends 2 h 30 after FIRM_END, mid-hour: the window ends at the forecast
    // end (58 slots) and the hourly resampling drops the incomplete last hour.
    const fc = forecast();
    fc.series = { ...fc.series, values: fc.series.values.slice(0, 96 + 10) };
    expect(extend({ data: makeData({ priceForecast: fc }) }).out.info)
      .toMatchObject({ endReason: 'forecast', extendedSlots: 8, totalSlots: 56, end: iso(FIRM_END + 8 * Q) });
  });

  it('keeps calibration and adjustments of the firm planner config and adjusts the forecast part alike', async () => {
    const settings = makeSettings();
    const data = makeData({
      predictionAdjustments: [{
        id: 'load-add', series: 'load', mode: 'add', value_W: 1000,
        start: iso(FIRM_END - 4 * Q), end: iso(FIRM_END + 4 * Q),
        createdAt: iso(NOW), updatedAt: iso(NOW),
      }],
    });
    const firmCfg = await buildPlannerConfig(settings, data, NOW);
    firmCfg.cvPhaseThresholds = [{ soc_percent: 90, maxChargePower_W: 500 }];
    const { out } = extend({ settings, data, firmCfg });
    expect(out.cfg.cvPhaseThresholds).toEqual(firmCfg.cvPhaseThresholds);
    expect(out.cfg.load_W.slice(44, 52)).toEqual(data.load.values.slice(44, 52).map(v => v + 1000));
    expect(out.cfg.load_W[52]).toBe(data.load.values[52]);
  });

  it('fixes the rebalance hold at the firm plan\'s start', () => {
    const firm = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
    const firmCfg = { ...firm, rebalanceRemainingSlots: 12, rebalanceHoldSlots: 12, rebalanceTargetSoc_percent: 100 };
    const pinned = extend({ firmCfg, result: firmResult({ rebalanceStartSlot: 20.7 }) }).out.cfg;
    expect(pinned.rebalanceMaxStartSlot).toBe(20);
    expect(pinned.rebalanceMinStartSlot).toBe(20);
    const clamped = extend({ firmCfg, result: firmResult({ rebalanceStartSlot: -3 }) }).out.cfg;
    expect(clamped.rebalanceMaxStartSlot).toBe(0);
    expect(clamped.rebalanceMinStartSlot).toBe(0);
    // A hold exactly as long as the firm part is still pinned.
    expect(extend({ firmCfg: { ...firmCfg, rebalanceRemainingSlots: 48 }, result: firmResult({ rebalanceStartSlot: 0 }) }).out.cfg.rebalanceMinStartSlot).toBe(0);
    // No start reported: the firm cap is kept.
    expect(extend({ firmCfg: { ...firmCfg, rebalanceMaxStartSlot: 0 } }).out.cfg.rebalanceMaxStartSlot).toBe(0);
    expect(extend({ firmCfg, result: firmResult({ rebalanceStartSlot: NaN }) }).out.cfg.rebalanceMaxStartSlot).toBeUndefined();
    // A hold longer than the firm part: the firm plan's forced start 0 is not
    // passed on, so the extended LP defers it ...
    const long = { ...firmCfg, rebalanceRemainingSlots: 60 };
    const deferred = extend({ firmCfg: long, result: firmResult({ rebalanceStartSlot: 0 }) }).out.cfg;
    expect(deferred.rebalanceMaxStartSlot).toBeUndefined();
    expect(deferred.rebalanceMinStartSlot).toBeUndefined();
    expect(isRebalanceHoldDeferred(deferred)).toBe(true);
    // ... unless the firm config pins it to slot 0 (a started hold): kept, not deferred.
    const started = extend({ firmCfg: { ...long, rebalanceMaxStartSlot: 0 }, result: firmResult({ rebalanceStartSlot: 0 }) }).out.cfg;
    expect(started.rebalanceMaxStartSlot).toBe(0);
    expect(started.rebalanceMinStartSlot).toBeUndefined();
    expect(isRebalanceHoldDeferred(started)).toBe(false);
    // Nothing to hold (a finished cycle): no pin.
    expect(extend({ firmCfg: { ...firmCfg, rebalanceRemainingSlots: 0 }, result: firmResult({ rebalanceStartSlot: 5 }) }).out.cfg.rebalanceMaxStartSlot).toBeUndefined();
  });

  it('keeps the EV config as in the firm config', () => {
    const firm = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
    const ev = { evMinChargePower_W: 1380, evMaxChargePower_W: 3680, evBatteryCapacity_Wh: 60000, evInitialSoc_percent: 40, evTargetSoc_percent: 80, evDepartureSlot: 48, evChargeEfficiency_percent: 90, evChargePhases: 1 };
    expect(extend({ firmCfg: { ...firm, ev } }).out.cfg.ev).toEqual(ev);
  });

  it('extends an uncontrollable evLoad, which also caps the horizon', () => {
    const data = makeData({ evLoad: { start: iso(NOW), step: 15, values: new Array(60).fill(2000) } });
    const { out } = extend({ data });
    expect(out.info).toMatchObject({ endReason: 'evLoad', totalSlots: 60 });
    expect(out.cfg.evLoad_W).toEqual(new Array(60).fill(2000));
  });

  it('fills a missing firm evLoad_W with zeros', () => {
    const { evLoad_W: _drop, ...firmCfg } = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
    const { out } = extend({ firmCfg });
    expect(out.cfg.evLoad_W).toHaveLength(out.info.totalSlots);
    expect(out.cfg.evLoad_W.every(v => v === 0)).toBe(true);
  });

  it('uses the stored fit when the fresh one is rejected', () => {
    const noisy = published.map((v, i) => v + (i % 8 < 4 ? 3 : -3));
    const stored = { a: 1.2, b: 15, n: 30, mad: 0.3, fittedAt: iso(NOW - DAY) };
    const data = makeData({
      importPrice: { start: iso(NOW), step: 15, values: noisy },
      exportPrice: { start: iso(NOW), step: 15, values: noisy },
      priceForecast: forecast({ fit: stored }),
    });
    const { out } = extend({ data });
    expect(out.info.fit).toEqual({ ...stored, source: 'stored' });
    expect(out.info.freshFitRejection).toMatchObject({ reason: 'residualTooLarge' });
    expect(out.info.newFit).toBeUndefined();
  });
});

describe('buildExtendedSolverConfig — export tariff', () => {
  // API prices with a posted market series: the market source is configured.
  const apiData = (overrides = {}) => makeData({
    importPrice: { start: iso(NOW), step: 15, values: [...published] },
    exportPrice: { start: iso(NOW), step: 15, values: [...published] },
    importPricePublishedUntil: undefined,
    marketPrice: { start: iso(NOW), step: 15, values: slotTimes(NOW, 48).map(ms => market(quarterIndex(ms))) },
    ...overrides,
  });
  const tariffSettings = (tariff = {}) => makeSettings({
    dataSources: { load: 'vrm', pv: 'vrm', prices: 'api', soc: 'mqtt' },
    exportTariff: {
      mode: 'auto', effectiveFrom: '2026-10-15T00:00:00+02:00', fee_cents_per_kWh: 2,
      negativePrice: 'floorZero', terminalSocValuation: 'tailMin', terminalTail_h: 6, ...tariff,
    },
  });

  it('applies the market rule to forecast slots from effectiveFrom and re-derives the terminal valuation', () => {
    const settings = tariffSettings();
    const { firmCfg, out } = extend({ settings, data: apiData() });
    expect(firmCfg.exportTariffInfo).toMatchObject({ marketPricedSlots: 0, terminalOverride: null });
    const { cfg, info } = out;
    const switchIdx = (Date.parse('2026-10-14T22:00:00Z') - NOW) / Q;
    expect(cfg.exportPrice.slice(48, switchIdx)).toEqual(cfg.importPrice.slice(48, switchIdx));
    const m = hourMean(quarterIndex(NOW + switchIdx * Q));
    expect(cfg.exportPrice[switchIdx]).toBeCloseTo(Math.max(0, m - 2), 10);
    expect(cfg.exportTariffInfo).toMatchObject({
      marketPricedSlots: info.totalSlots - switchIdx,
      fallbackSlots: 0,
      missingMarketSource: false,
      effectiveFrom: '2026-10-15T00:00:00+02:00',
      terminalOverride: { terminalSocValuation: 'custom' },
    });
    const tail = cfg.importPrice.slice(-24);
    expect(cfg.terminalSocValuation).toBe('custom');
    expect(cfg.terminalSocCustomPrice_cents_per_kWh).toBeCloseTo(Math.max(0, Math.min(...tail)), 10);
  });

  it('resets a firm terminal override to the settings before re-deriving it', () => {
    const settings = tariffSettings({ effectiveFrom: '2026-10-01T00:00:00+02:00', terminalSocValuation: 'min' });
    const { firmCfg, out } = extend({ settings, data: apiData() });
    expect(firmCfg.exportTariffInfo.terminalOverride).toEqual({ terminalSocValuation: 'min', terminalSocCustomPrice_cents_per_kWh: 0 });
    expect(out.cfg.exportTariffInfo.marketPricedSlots).toBe(out.info.totalSlots);
    expect(out.info.exportRelation).toBeNull();
    expect(out.cfg.terminalSocValuation).toBe('min');

    const netMetering = tariffSettings({ mode: 'netMetering' });
    const firm = buildSolverConfigFromSettings(netMetering, apiData(), NOW);
    const overridden = { ...firm, terminalSocValuation: 'max' };
    const result = extend({ settings: netMetering, data: apiData(), firmCfg: overridden }).out;
    expect(result.cfg.terminalSocValuation).toBe('zero');
    expect(result.cfg.exportTariffInfo.terminalOverride).toBeNull();
  });

  it('flags a missing market source over the extended horizon', () => {
    const settings = tariffSettings();
    const { firmCfg, out } = extend({ settings, data: apiData({ marketPrice: undefined }) });
    expect(firmCfg.exportTariffInfo.missingMarketSource).toBe(true);
    expect(out.cfg.exportTariffInfo.missingMarketSource).toBe(true);
    expect(out.cfg.exportPrice.slice(48)).toEqual(out.cfg.importPrice.slice(48));
  });

  it('skips the tariff info when the firm config has none', () => {
    const settings = tariffSettings();
    const { exportTariffInfo: _drop, ...firmCfg } = buildSolverConfigFromSettings(settings, apiData(), NOW);
    expect(extend({ settings, data: apiData(), firmCfg }).out.cfg.exportTariffInfo).toBeUndefined();
  });
});

describe('buildExtendedSolverConfig — skipped', () => {
  it('when the mode is not on', () => {
    for (const settings of [makeSettings({ extendedHorizon: extendedHorizon({ mode: 'collect' }) }), makeSettings({ extendedHorizon: undefined })]) {
      const firmCfg = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
      expect(buildExtendedSolverConfig({ firmCfg, settings, data: makeData(), nowMs: NOW, firmResult: firmResult() }))
        .toEqual({ skipped: 'off', message: expect.any(String) });
    }
  });

  it('without a finite firm-end SoC', () => {
    expect(extend({ result: firmResult({ socAtFirmEnd_Wh: NaN }) }).out).toMatchObject({ skipped: 'invalidFirmResult' });
  });

  it('when the forecast is missing, stale or for another region', () => {
    const firmCfg = buildSolverConfigFromSettings(makeSettings(), makeData(), NOW);
    const cases = [
      [makeData({ priceForecast: undefined }), 'forecastMissing', 'missing'],
      [makeData({ priceForecast: forecast({ fetchedAt: iso(NOW - 13 * 3_600_000) }) }), 'forecastStale', 'stale'],
      [makeData({ priceForecast: forecast({ region: 'DE' }) }), 'forecastRegion', 'another region'],
    ];
    for (const [data, skipped, text] of cases) {
      expect(extend({ data, firmCfg }).out).toEqual({ skipped, message: expect.stringContaining(text) });
    }
  });

  it('when nothing can be appended', () => {
    const data = makeData();
    data.load = { ...data.load, values: data.load.values.slice(0, 48) };
    expect(extend({ data }).out).toMatchObject({ skipped: 'noForecastSlots', endReason: 'load' });

    // The forecast covers 2 quarters past FIRM_END: not a whole hour of the hourly import.
    const fc = forecast();
    fc.series = { ...fc.series, values: fc.series.values.slice(0, 96 + 2) };
    expect(extend({ data: makeData({ priceForecast: fc }) }).out).toMatchObject({ skipped: 'noForecastSlots', endReason: 'forecast' });
  });

  it('when the fit is rejected without a usable stored fit', () => {
    const noisy = published.map((v, i) => v + (i % 8 < 4 ? 3 : -3));
    const data = makeData({
      importPrice: { start: iso(NOW), step: 15, values: noisy },
      exportPrice: { start: iso(NOW), step: 15, values: noisy },
      priceForecast: forecast({ fit: { a: 1.2, b: 15, n: 30, mad: 0.3, fittedAt: iso(NOW - 8 * DAY) } }),
    });
    expect(extend({ data }).out).toMatchObject({
      skipped: 'fitRejected',
      fitRejection: { reason: 'residualTooLarge', storedRejection: 'tooOld' },
    });
  });

  it('when the firm export relation is inconsistent', () => {
    const data = makeData({ exportPrice: { start: iso(NOW), step: 15, values: published.map(v => v * 0.4) } });
    expect(extend({ data }).out).toMatchObject({ skipped: 'exportInconsistent', message: expect.stringContaining('no consistent relation') });
  });
});

describe('persistPriceForecastFit', () => {
  const fit = { a: 1.21, b: 14, n: 12, mad: 0.1, fittedAt: iso(NOW) };
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('stores a new fit on the forecast of the same region', async () => {
    loadData.mockResolvedValue(makeData());
    await expect(persistPriceForecastFit(fit, 'NL', NOW)).resolves.toBe(true);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ priceForecast: expect.objectContaining({ fit, region: 'NL' }) }));
  });

  it('skips without a forecast, for another region, or when the same fit is recent', async () => {
    loadData.mockResolvedValue(makeData({ priceForecast: undefined }));
    await expect(persistPriceForecastFit(fit, 'NL', NOW)).resolves.toBe(false);
    loadData.mockResolvedValue(makeData());
    await expect(persistPriceForecastFit(fit, 'DE', NOW)).resolves.toBe(false);
    loadData.mockResolvedValue(makeData({ priceForecast: forecast({ fit: { ...fit, fittedAt: iso(NOW - 3_600_000) } }) }));
    await expect(persistPriceForecastFit(fit, 'NL', NOW)).resolves.toBe(false);
    expect(saveData).not.toHaveBeenCalled();
  });

  it('rewrites the same fit once the stored one is old, and a changed fit at once', async () => {
    loadData.mockResolvedValue(makeData({ priceForecast: forecast({ fit: { ...fit, fittedAt: iso(NOW - FIT_REWRITE_MIN_AGE_MS) } }) }));
    await expect(persistPriceForecastFit(fit, 'NL', NOW)).resolves.toBe(true);
    for (const changed of [{ a: 1.2 }, { b: 13 }, { n: 11 }, { mad: 0.2 }]) {
      loadData.mockResolvedValue(makeData({ priceForecast: forecast({ fit: { ...fit, ...changed, fittedAt: iso(NOW) } }) }));
      await expect(persistPriceForecastFit(fit, 'NL', NOW)).resolves.toBe(true);
    }
  });

  it('never throws', async () => {
    updateData.mockRejectedValueOnce(new Error('disk full'));
    await expect(persistPriceForecastFit(fit, 'NL')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not store'), 'disk full');
  });
});
