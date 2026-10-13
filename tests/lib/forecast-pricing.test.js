import { describe, it, expect } from 'vitest';
import {
  FIT_MIN_POINTS,
  STORED_FIT_MAX_AGE_MS,
  applyExportRelation,
  collectFitPoints,
  deriveExportRelation,
  detectImportResolution,
  fitImportPrice,
  median,
  priceForecastSlots,
  resampleForecast,
  selectImportFit,
} from '../../lib/forecast-pricing.ts';

// Tests run with TZ=Europe/Amsterdam (vitest.config.js).
const Q = 15 * 60_000;
const H = 4 * Q;
const MIDNIGHT = Date.parse('2026-10-12T22:00:00Z'); // 00:00 CEST, 13 Oct
const NOW = Date.parse('2026-10-13T10:00:00Z');      // 12:00 CEST
const FIRM_END = Date.parse('2026-10-13T22:00:00Z'); // 00:00 CEST, 14 Oct

const series = (startMs, values, step = 15) => ({ start: new Date(startMs).toISOString(), step, values });
const times = (startMs, n, stepMs = Q) => Array.from({ length: n }, (_, i) => startMs + i * stepMs);

/** Market price (c/kWh ex VAT) of the q-th quarter after local midnight: varies within each hour. */
const market = q => 10 + 6 * Math.sin(q / 9) + (q % 4) * 0.5;
const hourMean = q => {
  const h0 = q - (q % 4);
  return (market(h0) + market(h0 + 1) + market(h0 + 2) + market(h0 + 3)) / 4;
};
const quarterIndex = ms => Math.round((ms - MIDNIGHT) / Q);

/** Forecast feed from local midnight, 5 days, published until FIRM_END. */
const forecastSeries = (slots = 5 * 96) => series(MIDNIGHT, Array.from({ length: slots }, (_, q) => market(q)));

/** Hourly import (constant within each hour) 1.21·hourMean + 14 for the firm part. */
const hourlyImport = (a = 1.21, b = 14) => times(NOW, 48).map(ms => a * hourMean(quarterIndex(ms)) + b);
const quarterImport = (a = 1.21, b = 14) => times(NOW, 48).map(ms => a * market(quarterIndex(ms)) + b);

describe('median', () => {
  it('handles odd and even lengths without mutating', () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('detectImportResolution', () => {
  it('is hourly when every clock hour is constant', () => {
    expect(detectImportResolution(hourlyImport(), NOW, 15)).toBe('hourly');
  });

  it('is per slot when a value changes within an hour', () => {
    expect(detectImportResolution(quarterImport(), NOW, 15)).toBe('slot');
  });

  it('is per slot for steps of an hour or longer, and without any hour holding two slots', () => {
    expect(detectImportResolution([1, 1, 1], NOW, 60)).toBe('slot');
    expect(detectImportResolution([5], NOW, 15)).toBe('slot');
    // 10:45 and 11:00 fall in different hours.
    expect(detectImportResolution([5, 5], NOW + 3 * Q, 15)).toBe('slot');
    expect(detectImportResolution([], NOW, 15)).toBe('slot');
  });
});

describe('resampleForecast', () => {
  const fc = forecastSeries(96);

  it('averages the clock hour (hourly) or reads the slot (slot)', () => {
    const slots = [MIDNIGHT + 5 * Q, MIDNIGHT + 8 * Q];
    expect(resampleForecast(fc, slots, 15, 'hourly')).toEqual([hourMean(5), hourMean(8)].map(v => expect.closeTo(v, 10)));
    expect(resampleForecast(fc, slots, 15, 'slot')).toEqual([market(5), market(8)]);
  });

  it('averages the quarters of a longer slot and reads the containing quarter of a shorter one', () => {
    expect(resampleForecast(fc, [MIDNIGHT + 4 * Q], 60, 'slot')[0]).toBeCloseTo(hourMean(4), 10);
    expect(resampleForecast(fc, [MIDNIGHT + Q + 5 * 60_000], 5, 'slot')).toEqual([market(1)]);
  });

  it('is NaN where any quarter of the bucket is missing', () => {
    const short = series(MIDNIGHT, [1, 2, 3, 4, 5, 6]); // 1.5 h
    expect(resampleForecast(short, [MIDNIGHT + 4 * Q], 15, 'hourly')).toEqual([NaN]);
    expect(resampleForecast(short, [MIDNIGHT + 4 * Q], 15, 'slot')).toEqual([5]);
    expect(resampleForecast(short, [MIDNIGHT - Q], 15, 'slot')).toEqual([NaN]);
  });
});

describe('fitImportPrice', () => {
  const fitInput = (overrides = {}) => ({
    importSeries: series(NOW, quarterImport()),
    forecast: forecastSeries(),
    forecastPublishedEndMs: FIRM_END,
    resolution: 'slot',
    vat_percent: 21,
    ...overrides,
  });

  it('recovers a and b with Theil–Sen', () => {
    const result = fitImportPrice(fitInput());
    expect(result.ok).toBe(true);
    expect(result.fit.a).toBeCloseTo(1.21, 6);
    expect(result.fit.b).toBeCloseTo(14, 6);
    expect(result.fit.n).toBe(48);
    expect(result.fit.mad).toBeCloseTo(0, 6);
    expect(result.fit.method).toBe('theilSen');
    // The last overlap point: the slot before the published end.
    expect(result.lastPointMs).toBe(FIRM_END - Q);
    // Hourly: the last slot of the last complete hour.
    expect(fitImportPrice(fitInput({ importSeries: series(NOW, hourlyImport()), resolution: 'hourly' })).lastPointMs).toBe(FIRM_END - Q);
  });

  it('is robust to a few outliers', () => {
    const values = quarterImport();
    values[3] += 20;
    values[17] -= 15;
    values[30] += 9;
    const result = fitImportPrice(fitInput({ importSeries: series(NOW, values) }));
    expect(result.ok).toBe(true);
    expect(result.fit.a).toBeCloseTo(1.21, 6);
    expect(result.fit.b).toBeCloseTo(14, 6);
  });

  it('skips pairs with equal market prices', () => {
    const steps = series(MIDNIGHT, Array.from({ length: 96 }, (_, q) => 10 + Math.floor(q / 8) * 2));
    const values = times(NOW, 48).map(ms => 1.1 * (10 + Math.floor(quarterIndex(ms) / 8) * 2) + 15);
    const result = fitImportPrice(fitInput({ importSeries: series(NOW, values), forecast: steps }));
    expect(result.fit.a).toBeCloseTo(1.1, 10);
    expect(result.fit.b).toBeCloseTo(15, 10);
  });

  it('rejects a slope outside [0.95, 1.30]', () => {
    for (const a of [1.5, 0.9]) {
      const result = fitImportPrice(fitInput({ importSeries: series(NOW, quarterImport(a, 10)) }));
      expect(result).toMatchObject({ ok: false, reason: 'slopeOutOfRange', n: 48 });
      expect(result.a).toBeCloseTo(a, 6);
      expect(result.message).toContain('outside [0.95, 1.3]');
    }
  });

  it('uses a = 1 + VAT and the median offset when the market spread is under 3 c', () => {
    const flat = series(MIDNIGHT, Array.from({ length: 96 }, (_, q) => 10 + (q % 8) * 0.3)); // spread 2.1 c
    const values = times(NOW, 48).map(ms => 1.3 * (10 + (quarterIndex(ms) % 8) * 0.3) + 12);
    const result = fitImportPrice(fitInput({ importSeries: series(NOW, values), forecast: flat, vat_percent: 9 }));
    expect(result.ok).toBe(true);
    expect(result.fit.method).toBe('lowSpread');
    expect(result.fit.a).toBeCloseTo(1.09, 10);
    // b = median(y − 1.09·x); residuals stay under 1 c over the small spread.
    expect(result.fit.mad).toBeLessThan(1);
  });

  it('rejects a residual MAD over 1 c, also on the low-spread path', () => {
    const noisy = quarterImport().map((v, i) => v + (i % 2 === 0 ? 2 : -2));
    expect(fitImportPrice(fitInput({ importSeries: series(NOW, noisy) })))
      .toMatchObject({ ok: false, reason: 'residualTooLarge', message: expect.stringContaining('MAD 2.00') });

    const flat = series(MIDNIGHT, new Array(96).fill(10));
    const noisyFlat = times(NOW, 48).map((_, i) => 26 + (i % 2 === 0 ? 3 : -3));
    expect(fitImportPrice(fitInput({ importSeries: series(NOW, noisyFlat), forecast: flat })))
      .toMatchObject({ ok: false, reason: 'residualTooLarge' });
  });

  it('needs at least FIT_MIN_POINTS overlap points', () => {
    const result = fitImportPrice(fitInput({ importSeries: series(FIRM_END - (FIT_MIN_POINTS - 1) * Q, quarterImport().slice(0, FIT_MIN_POINTS - 1)) }));
    expect(result).toMatchObject({ ok: false, reason: 'insufficientOverlap', n: FIT_MIN_POINTS - 1 });
  });

  it('excludes VRM zero-fill slots after importPublishedUntilMs', () => {
    // 24 real slots, then zero-filled to the end of the day.
    const values = quarterImport().map((v, i) => (i < 24 ? v : 0));
    const cutoff = NOW + 24 * Q;
    expect(fitImportPrice(fitInput({ importSeries: series(NOW, values) })).ok).toBe(false);
    const result = fitImportPrice(fitInput({ importSeries: series(NOW, values), importPublishedUntilMs: cutoff }));
    expect(result.ok).toBe(true);
    expect(result.fit.n).toBe(24);
    expect(result.fit.a).toBeCloseTo(1.21, 6);
  });

  it('only uses the published part of the feed and skips non-finite import values', () => {
    // The model part after FIRM_END would not fit the relation.
    const fc = forecastSeries();
    const values = [...quarterImport(), ...new Array(48).fill(99)];
    values[5] = null;
    const result = fitImportPrice(fitInput({ importSeries: series(NOW, values), forecast: fc }));
    expect(result.ok).toBe(true);
    expect(result.fit.n).toBe(47);
  });

  it('fits hourly means when the import is hourly, dropping partial hours', () => {
    // Starting at 10:15Z leaves 10:00–11:00 partial.
    const start = NOW + Q;
    const values = hourlyImport().slice(1);
    const points = collectFitPoints({ importSeries: series(start, values), forecast: forecastSeries(), forecastPublishedEndMs: FIRM_END, resolution: 'hourly' });
    expect(points).toHaveLength(11);
    const result = fitImportPrice(fitInput({ importSeries: series(start, values), resolution: 'hourly' }));
    expect(result.ok).toBe(true);
    expect(result.fit.n).toBe(11);
    expect(result.fit.a).toBeCloseTo(1.21, 6);
    expect(result.fit.b).toBeCloseTo(14, 6);
    // A per-quarter fit of the same hourly import against the quarter prices is not exact.
    expect(fitImportPrice(fitInput({ importSeries: series(start, values) })).fit?.mad ?? Infinity).toBeGreaterThan(0.01);
  });

  it('treats a series without step as 15-minute and hourly import series as hourly points', () => {
    const noStep = { start: new Date(NOW).toISOString(), values: quarterImport() };
    expect(fitImportPrice(fitInput({ importSeries: noStep })).fit.n).toBe(48);
    const hourly = series(NOW, times(NOW, 12, H).map(ms => 1.21 * hourMean(quarterIndex(ms)) + 14), 60);
    const result = fitImportPrice(fitInput({ importSeries: hourly, resolution: 'hourly' }));
    expect(result.fit.n).toBe(12);
    expect(result.fit.a).toBeCloseTo(1.21, 6);
  });
});

describe('selectImportFit', () => {
  const fresh = { ok: true, fit: { a: 1.2, b: 14, n: 40, mad: 0.2, method: 'theilSen' } };
  const rejected = { ok: false, reason: 'residualTooLarge', n: 40, message: 'fit residual MAD 2.00 c/kWh exceeds 1 c/kWh' };
  const stored = (fittedAt) => ({ a: 1.19, b: 13, n: 30, mad: 0.3, fittedAt });

  it('prefers the fresh fit, stamped now', () => {
    expect(selectImportFit({ fresh, stored: stored('2026-10-12T10:00:00Z'), nowMs: NOW, lastPricedSlotMs: NOW + 3 * 86_400_000 })).toEqual({
      ok: true, source: 'fresh', method: 'theilSen', fit: { a: 1.2, b: 14, n: 40, mad: 0.2, fittedAt: new Date(NOW).toISOString() },
    });
  });

  it('falls back to a recent stored fit of the same year', () => {
    const result = selectImportFit({ fresh: rejected, stored: stored('2026-10-10T10:00:00Z'), nowMs: NOW, lastPricedSlotMs: NOW + 3 * 86_400_000 });
    expect(result).toEqual({ ok: true, source: 'stored', fit: stored('2026-10-10T10:00:00Z'), freshRejection: rejected });
  });

  it('treats a fittedAt in the future as age 0', () => {
    expect(selectImportFit({ fresh: rejected, stored: stored('2026-10-14T10:00:00Z'), nowMs: NOW, lastPricedSlotMs: NOW }).ok).toBe(true);
  });

  it('refuses without a stored fit, with a fit 7 days old or more', () => {
    expect(selectImportFit({ fresh: rejected, stored: null, nowMs: NOW, lastPricedSlotMs: NOW }))
      .toMatchObject({ ok: false, storedRejection: 'none', freshRejection: rejected, message: expect.stringContaining('no stored fit') });
    expect(selectImportFit({ fresh: rejected, nowMs: NOW, lastPricedSlotMs: NOW }))
      .toMatchObject({ ok: false, storedRejection: 'none' });
    const old = new Date(NOW - STORED_FIT_MAX_AGE_MS).toISOString();
    expect(selectImportFit({ fresh: rejected, stored: stored(old), nowMs: NOW, lastPricedSlotMs: NOW }))
      .toMatchObject({ ok: false, storedRejection: 'tooOld' });
    expect(selectImportFit({ fresh: rejected, stored: stored('garbage'), nowMs: NOW, lastPricedSlotMs: NOW }))
      .toMatchObject({ ok: false, storedRejection: 'tooOld' });
  });

  it('refuses a stored fit from another local calendar year than the forecast slots', () => {
    // 23:30 local on 31 Dec 2026; the last slot is 00:00 local on 1 Jan 2027.
    const fit = stored('2026-12-31T22:30:00Z');
    const now = Date.parse('2026-12-31T22:45:00Z');
    expect(selectImportFit({ fresh: rejected, stored: fit, nowMs: now, lastPricedSlotMs: Date.parse('2026-12-31T23:00:00Z') }))
      .toMatchObject({ ok: false, storedRejection: 'otherYear', message: expect.stringContaining('another calendar year') });
    // 22:45 local on 31 Dec is still 2026: same year.
    expect(selectImportFit({ fresh: rejected, stored: fit, nowMs: now, lastPricedSlotMs: Date.parse('2026-12-31T22:45:00Z') }).ok).toBe(true);
  });
});

describe('deriveExportRelation / applyExportRelation', () => {
  const imp = [20, 25, 30, 22, 18, 27, 31, 24, 26, 21];

  it('detects equal and zero relations', () => {
    expect(deriveExportRelation(imp, [...imp])).toEqual({ ok: true, relation: { kind: 'equal' } });
    expect(deriveExportRelation(imp, imp.map(() => 0))).toEqual({ ok: true, relation: { kind: 'zero' } });
    expect(deriveExportRelation([0, 0], [0, 0])).toEqual({ ok: true, relation: { kind: 'equal' } });
  });

  it('uses the median offset when at most 10 % of slots deviate by more than 1 c', () => {
    const exp = imp.map(v => v - 2.5);
    exp[4] = 0; // one negative-price-style outlier (10 %)
    expect(deriveExportRelation(imp, exp)).toEqual({ ok: true, relation: { kind: 'offset', offset_cents_per_kWh: -2.5 } });
  });

  it('is inconsistent when more than 10 % deviate', () => {
    const exp = imp.map(v => v * 0.5); // proportional, not an offset
    const result = deriveExportRelation(imp, exp);
    expect(result.ok).toBe(false);
    expect(result.deviatingFraction).toBeGreaterThan(0.1);
    expect(result.message).toContain('no consistent relation');
  });

  it('skips non-finite pairs and is inconsistent without any', () => {
    expect(deriveExportRelation([1, NaN], [1, 5])).toEqual({ ok: true, relation: { kind: 'equal' } });
    expect(deriveExportRelation([], [])).toMatchObject({ ok: false, deviatingFraction: 1 });
  });

  it('continues each relation', () => {
    expect(applyExportRelation({ kind: 'equal' }, [1, 2])).toEqual([1, 2]);
    expect(applyExportRelation({ kind: 'zero' }, [1, 2])).toEqual([0, 0]);
    expect(applyExportRelation({ kind: 'offset', offset_cents_per_kWh: -1.5 }, [1, 2])).toEqual([-0.5, 0.5]);
  });
});

describe('priceForecastSlots', () => {
  const firmImport = hourlyImport();
  const base = (overrides = {}) => ({
    nowMs: NOW,
    stepSize_m: 15,
    firmStartMs: NOW,
    firmImport,
    firmSourceExport: [...firmImport],
    slotStartsMs: times(FIRM_END, 96),
    importSeries: series(NOW, firmImport),
    forecast: { series: forecastSeries(), publishedEndMs: FIRM_END },
    vat_percent: 21,
    marketSourceConfigured: false,
    ...overrides,
  });

  it('prices hourly with the fresh fit and continues an equal export', () => {
    const result = priceForecastSlots(base());
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ resolution: 'hourly', slots: 96, fitSource: 'fresh', fitMethod: 'theilSen', exportRelation: { kind: 'equal' } });
    expect(result.truncatedAtMs).toBeUndefined();
    expect(result.freshFitRejection).toBeUndefined();
    const q = quarterIndex(FIRM_END + 5 * Q);
    expect(result.market[5]).toBeCloseTo(hourMean(q), 10);
    expect(result.importPrice[5]).toBeCloseTo(1.21 * hourMean(q) + 14, 6);
    // Constant within each hour.
    expect(result.importPrice[4]).toBeCloseTo(result.importPrice[7], 10);
    expect(result.export.exportPrice).toEqual(result.importPrice);
    expect(result.export.regime.every(r => r === 'netMetering')).toBe(true);
  });

  it('continues zero and offset export relations', () => {
    expect(priceForecastSlots(base({ firmSourceExport: firmImport.map(() => 0) })).export.exportPrice.every(v => v === 0)).toBe(true);
    const offset = priceForecastSlots(base({ firmSourceExport: firmImport.map(v => v - 3) }));
    expect(offset.exportRelation).toEqual({ kind: 'offset', offset_cents_per_kWh: expect.closeTo(-3, 10) });
    expect(offset.export.exportPrice[0]).toBeCloseTo(offset.importPrice[0] - 3, 10);
  });

  it('refuses an inconsistent export relation where forecast slots are net-metered', () => {
    expect(priceForecastSlots(base({ firmSourceExport: firmImport.map(v => v * 0.4) })))
      .toMatchObject({ ok: false, reason: 'exportInconsistent', message: expect.stringContaining('no consistent relation') });
  });

  it('cuts at the end of the forecast and refuses when nothing is covered', () => {
    const shortFc = { series: forecastSeries(96 + 8), publishedEndMs: FIRM_END }; // 2 h past FIRM_END
    const cut = priceForecastSlots(base({ forecast: shortFc }));
    expect(cut).toMatchObject({ ok: true, slots: 8, truncatedAtMs: FIRM_END + 8 * Q });
    expect(cut.importPrice).toHaveLength(8);

    const none = priceForecastSlots(base({ forecast: { series: forecastSeries(96), publishedEndMs: FIRM_END } }));
    expect(none).toMatchObject({ ok: false, reason: 'noForecastSlots' });
  });

  it('refuses when the fit is rejected and no stored fit is usable, with the reasons', () => {
    const noisy = firmImport.map((v, i) => v + (i % 8 < 4 ? 3 : -3));
    const result = priceForecastSlots(base({ importSeries: series(NOW, noisy), firmImport: noisy, firmSourceExport: noisy }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'fitRejected',
      fitRejection: { reason: 'residualTooLarge', storedRejection: 'none' },
    });
  });

  it('falls back to the stored fit and reports why', () => {
    const noisy = firmImport.map((v, i) => v + (i % 8 < 4 ? 3 : -3));
    const stored = { a: 1.2, b: 15, n: 30, mad: 0.3, fittedAt: '2026-10-12T12:00:00Z' };
    const result = priceForecastSlots(base({
      importSeries: series(NOW, noisy), firmImport: noisy, firmSourceExport: noisy,
      forecast: { series: forecastSeries(), publishedEndMs: FIRM_END, fit: stored },
    }));
    expect(result).toMatchObject({ ok: true, fitSource: 'stored', fit: stored, freshFitRejection: { reason: 'residualTooLarge' } });
    expect(result.fitMethod).toBeUndefined();
    expect(result.importPrice[0]).toBeCloseTo(1.2 * result.market[0] + 15, 10);
  });

  describe('market regime across effectiveFrom', () => {
    // Plan from 12:00 local on 30 Dec; firm until 00:00 local 31 Dec;
    // forecast slots 30 Dec 22:00 – 31 Dec 02:00, with the tariff switching
    // on 31 Dec 00:00 (inside one calendar year: a fresh fit never prices
    // next year's slots, see below).
    const now = Date.parse('2026-12-30T11:00:00Z');
    const firmEnd = Date.parse('2026-12-30T23:00:00Z');
    const midnight = Date.parse('2026-12-29T23:00:00Z');
    const fcValues = Array.from({ length: 4 * 96 }, (_, q) => (q % 96 < 8 ? -4 : 8 + 6 * Math.sin(q / 9)));
    const fc = { series: series(midnight, fcValues), publishedEndMs: firmEnd };
    const hm = ms => {
      const q0 = Math.floor((ms - midnight) / H) * 4;
      return (fcValues[q0] + fcValues[q0 + 1] + fcValues[q0 + 2] + fcValues[q0 + 3]) / 4;
    };
    const firm = times(now, 48).map(ms => 1.21 * hm(ms) + 14);
    const tariff = { mode: 'auto', effectiveFrom: '2026-12-31T00:00:00+01:00', fee_cents_per_kWh: 1.5, negativePrice: 'floorZero' };
    const input = (overrides = {}) => base({
      nowMs: now, firmStartMs: now, firmImport: firm, firmSourceExport: [...firm],
      slotStartsMs: times(firmEnd - 2 * H, 16), importSeries: series(now, firm), forecast: fc, tariff, marketSourceConfigured: true,
      ...overrides,
    });

    it('nets meters before effectiveFrom and uses market − fee (floored) from then on', () => {
      const result = priceForecastSlots(input());
      expect(result.ok).toBe(true);
      // 22:00–00:00 local on 30 Dec: net metering at the forecast import price.
      expect(result.export.regime.slice(0, 8).every(r => r === 'netMetering')).toBe(true);
      expect(result.export.exportPrice.slice(0, 8)).toEqual(result.importPrice.slice(0, 8));
      // 00:00–02:00 local on 31 Dec: the market is −4 c → floored at 0.
      expect(result.export.regime.slice(8).every(r => r === 'market')).toBe(true);
      expect(result.export.exportPrice.slice(8)).toEqual(new Array(8).fill(0));
      expect(result.export.marketPricedSlots).toBe(8);
      expect(result.exportRelation).toEqual({ kind: 'equal' });
    });

    it('passes negative market prices through when configured', () => {
      const result = priceForecastSlots(input({ tariff: { ...tariff, negativePrice: 'passThrough' } }));
      expect(result.export.exportPrice[8]).toBeCloseTo(-5.5, 10);
    });

    it('needs no export relation when every forecast slot is market-priced', () => {
      const result = priceForecastSlots(input({ slotStartsMs: times(firmEnd, 16), firmSourceExport: firm.map(v => v * 0.4) }));
      expect(result.ok).toBe(true);
      expect(result.exportRelation).toBeNull();
      expect(result.export.regime.every(r => r === 'market')).toBe(true);
      expect(result.export.exportPrice[12]).toBeCloseTo(Math.max(0, result.market[12] - 1.5), 10);
    });

    it('keeps net metering without a market source', () => {
      const result = priceForecastSlots(input({ slotStartsMs: times(firmEnd, 16), marketSourceConfigured: false }));
      expect(result.export.regime.every(r => r === 'netMetering')).toBe(true);
      expect(result.export.missingMarketSource).toBe(true);
    });
  });

  describe('a fresh fit across the year boundary', () => {
    // Wed 30 Dec 2026 14:00 CET, after the day-ahead publication: the
    // published prices (and the overlap the fit is made on) are 2026's.
    const now = Date.parse('2026-12-30T13:00:00Z');
    const midnight = Date.parse('2026-12-29T23:00:00Z'); // 00:00 CET, 30 Dec
    const published = Date.parse('2026-12-31T23:00:00Z'); // 00:00 CET, 1 Jan 2027
    const fcValues = Array.from({ length: 5 * 96 }, (_, q) => 8 + 6 * Math.sin(q / 9));
    const fc = { series: series(midnight, fcValues), publishedEndMs: published };
    const hm = ms => {
      const q0 = Math.floor((ms - midnight) / H) * 4;
      return (fcValues[q0] + fcValues[q0 + 1] + fcValues[q0 + 2] + fcValues[q0 + 3]) / 4;
    };
    const firmSlots = (published - now) / Q; // 136, through 31 Dec 24:00
    const firm = times(now, firmSlots).map(ms => 1.21 * hm(ms) + 14);
    const input = (overrides = {}) => base({
      nowMs: now, firmStartMs: now, firmImport: firm, firmSourceExport: [...firm],
      importSeries: series(now, firm), forecast: fc,
      ...overrides,
    });

    it('prices no 2027 slot with a fit on 2026 prices', () => {
      // The firm part runs through 31 Dec 24:00, so every forecast slot is in 2027.
      const result = priceForecastSlots(input({ slotStartsMs: times(published, 96) }));
      expect(result).toEqual({
        ok: false,
        reason: 'fitRejected',
        message: 'the import fit is on 2026 published prices and cannot price the 2027 forecast slots (taxes change on 1 January)',
      });
    });

    it('cuts the extension at 1 Jan 00:00 when it starts in 2026', () => {
      // Firm prices ending at 22:00 on 31 Dec (e.g. posted prices): the
      // fit is still on 2026 prices; the slots from 1 Jan are left out.
      const start = published - 2 * H;
      const result = priceForecastSlots(input({ slotStartsMs: times(start, 16) }));
      expect(result).toMatchObject({ ok: true, fitSource: 'fresh', slots: 8, truncatedAtMs: published, truncationReason: 'fitYear' });
      expect(result.importPrice).toHaveLength(8);
      expect(result.importPrice[0]).toBeCloseTo(1.21 * hm(start) + 14, 6);
    });

    it('reports a forecast cut before the year end as a forecast cut', () => {
      const start = published - 4 * H;
      const shortFc = { ...fc, series: series(midnight, fcValues.slice(0, (start - midnight) / Q + 8)) };
      const result = priceForecastSlots(input({ slotStartsMs: times(start, 32), forecast: shortFc }));
      expect(result).toMatchObject({ ok: true, slots: 8, truncatedAtMs: start + 8 * Q, truncationReason: 'forecast' });
    });

    it('keeps pricing 2027 slots with a fit on 2027 prices', () => {
      // A day later the overlap includes 1 Jan's published prices.
      const later = now + 24 * H;
      const firm2027 = times(later, (published + 24 * H - later) / Q).map(ms => 1.25 * hm(ms) + 16);
      const result = priceForecastSlots(input({
        nowMs: later, firmStartMs: later, firmImport: firm2027, firmSourceExport: [...firm2027],
        importSeries: series(later, firm2027),
        forecast: { series: fc.series, publishedEndMs: published + 24 * H },
        slotStartsMs: times(published + 24 * H, 16),
      }));
      expect(result).toMatchObject({ ok: true, slots: 16, fitSource: 'fresh' });
      expect(result.truncatedAtMs).toBeUndefined();
      expect(result.fit.a).toBeCloseTo(1.25, 6);
    });
  });
});
