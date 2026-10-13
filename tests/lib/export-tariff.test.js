import { describe, it, expect } from 'vitest';
import {
  resolveExportPrices,
  terminalTailMinPrice,
  parseEffectiveFrom,
  MISSING_MARKET_SOURCE_LEAD_MS,
} from '../../lib/export-tariff.ts';

const STEP_MS = 15 * 60_000;
// 2027-01-01 00:00 Europe/Amsterdam (CET, +01:00)
const SWITCH = '2027-01-01T00:00:00+01:00';
const SWITCH_MS = Date.parse('2026-12-31T23:00:00Z');

const slots = (startMs, n) => Array.from({ length: n }, (_, t) => startMs + t * STEP_MS);

const tariff = (overrides = {}) => ({
  mode: 'auto',
  effectiveFrom: SWITCH,
  fee_cents_per_kWh: 0,
  negativePrice: 'floorZero',
  ...overrides,
});

// Four slots straddling the switch: 22:30Z, 22:45Z (net metering), 23:00Z, 23:15Z (market).
const STRADDLE = slots(SWITCH_MS - 2 * STEP_MS, 4);
const SOURCE = [30, 31, 32, 33];
const MARKET = [10, 11, 12, 13];

describe('resolveExportPrices', () => {
  it('keeps the source export everywhere when the tariff is absent', () => {
    for (const absent of [undefined, null]) {
      const r = resolveExportPrices({
        slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET, tariff: absent, marketSourceConfigured: true,
      });
      expect(r).toEqual({
        exportPrice: SOURCE,
        regime: ['netMetering', 'netMetering', 'netMetering', 'netMetering'],
        marketPricedSlots: 0,
        fallbackSlots: 0,
        missingMarketSource: false,
      });
    }
  });

  it('netMetering mode keeps the source export even after effectiveFrom', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET,
      tariff: tariff({ mode: 'netMetering' }), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual(SOURCE);
    expect(r.regime.every(x => x === 'netMetering')).toBe(true);
    expect(r.missingMarketSource).toBe(false);
  });

  it('auto switches per slot at effectiveFrom (2026-12-31T23:00Z = 2027-01-01 00:00 CET)', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET,
      tariff: tariff(), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual([30, 31, 12, 13]);
    expect(r.regime).toEqual(['netMetering', 'netMetering', 'market', 'market']);
    expect(r.marketPricedSlots).toBe(2);
    expect(r.fallbackSlots).toBe(0);
    expect(r.missingMarketSource).toBe(false);
  });

  it('marketPrice mode prices every slot at market, before the switch too', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET,
      tariff: tariff({ mode: 'marketPrice' }), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual(MARKET);
    expect(r.marketPricedSlots).toBe(4);
  });

  it('subtracts the fee and floors at zero under floorZero', () => {
    const r = resolveExportPrices({
      slotStartsMs: slots(SWITCH_MS, 4), sourceExport: SOURCE, market: [10, 1, -3, 0.5],
      tariff: tariff({ fee_cents_per_kWh: 1 }), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual([9, 0, 0, 0]);
    expect(r.regime).toEqual(['market', 'market', 'market', 'market']);
  });

  it('passes negative values through under passThrough', () => {
    const r = resolveExportPrices({
      slotStartsMs: slots(SWITCH_MS, 4), sourceExport: SOURCE, market: [10, 1, -3, 0.5],
      tariff: tariff({ fee_cents_per_kWh: 1, negativePrice: 'passThrough' }), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual([9, 0, -4, -0.5]);
  });

  it('falls back to 0 (not −fee, not the source export) for missing or non-finite market values and counts them', () => {
    const r = resolveExportPrices({
      slotStartsMs: slots(SWITCH_MS, 5), sourceExport: [30, 30, 30, 30, 30],
      market: [10, NaN, Infinity, -Infinity, undefined],
      tariff: tariff({ fee_cents_per_kWh: 2, negativePrice: 'passThrough' }), marketSourceConfigured: true,
    });
    expect(r.exportPrice).toEqual([8, 0, 0, 0, 0]);
    expect(r.regime).toEqual(['market', 'fallback', 'fallback', 'fallback', 'fallback']);
    expect(r.marketPricedSlots).toBe(1);
    expect(r.fallbackSlots).toBe(4);
  });

  it('marketPrice mode without a source still uses the market rule, falling back to 0', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: [NaN, NaN, NaN, NaN],
      tariff: tariff({ mode: 'marketPrice' }), marketSourceConfigured: false,
    });
    expect(r.exportPrice).toEqual([0, 0, 0, 0]);
    expect(r.fallbackSlots).toBe(4);
    expect(r.missingMarketSource).toBe(false);
  });

  it('auto without a market source keeps net metering everywhere and flags the missing source', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET,
      tariff: tariff(), marketSourceConfigured: false,
    });
    expect(r.exportPrice).toEqual(SOURCE);
    expect(r.regime.every(x => x === 'netMetering')).toBe(true);
    expect(r.marketPricedSlots).toBe(0);
    expect(r.missingMarketSource).toBe(true);
  });

  it('flags the missing source only once the horizon reaches effectiveFrom − 7 days', () => {
    const leadStart = SWITCH_MS - MISSING_MARKET_SOURCE_LEAD_MS;
    const run = (startMs, n) => resolveExportPrices({
      slotStartsMs: slots(startMs, n), sourceExport: new Array(n).fill(30), market: new Array(n).fill(NaN),
      tariff: tariff(), marketSourceConfigured: false,
    }).missingMarketSource;

    expect(MISSING_MARKET_SOURCE_LEAD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    // Horizon ends one slot before the lead window: no warning yet.
    expect(run(leadStart - 4 * STEP_MS, 3)).toBe(false);
    // Its last slot starts exactly at effectiveFrom − 7 d: warning.
    expect(run(leadStart - 3 * STEP_MS, 4)).toBe(true);
    // Long after the switch, still missing: warning stays.
    expect(run(SWITCH_MS + 30 * 24 * 3600_000, 4)).toBe(true);
    // An empty horizon never warns.
    expect(run(SWITCH_MS, 0)).toBe(false);
  });

  it('auto with an unparseable effectiveFrom never switches (guard for configs built outside the store)', () => {
    const r = resolveExportPrices({
      slotStartsMs: STRADDLE, sourceExport: SOURCE, market: MARKET,
      tariff: tariff({ effectiveFrom: '2027-01-01T00:00:00' }), marketSourceConfigured: false,
    });
    expect(r.exportPrice).toEqual(SOURCE);
    expect(r.missingMarketSource).toBe(false);
  });
});

describe('parseEffectiveFrom', () => {
  it('returns the instant for a valid value with Z, a positive or a negative offset', () => {
    expect(parseEffectiveFrom(SWITCH)).toEqual({ ok: true, ms: SWITCH_MS });
    expect(parseEffectiveFrom('2026-12-31T23:00Z')).toEqual({ ok: true, ms: SWITCH_MS });
    expect(parseEffectiveFrom('2026-12-31T18:00:00-05:00')).toEqual({ ok: true, ms: SWITCH_MS });
  });

  it('explains why a value is rejected', () => {
    expect(parseEffectiveFrom(undefined)).toEqual({ ok: false, error: 'must be a string' });
    expect(parseEffectiveFrom('2027-01-01T00:00:00').ok).toBe(false);
    expect(parseEffectiveFrom('2027-02-30T00:00:00Z')).toEqual({ ok: false, error: 'is not a valid date-time' });
    expect(parseEffectiveFrom('2027-13-01T00:00:00Z')).toEqual({ ok: false, error: 'is not a valid date-time' });
    expect(parseEffectiveFrom('2027-01-01T00:00:00+25:00')).toEqual({ ok: false, error: 'is not a valid date-time' });
    expect(parseEffectiveFrom('2027-01-01T00:05:00Z')).toEqual({ ok: false, error: 'must fall on a 15-minute boundary in UTC' });
  });
});

describe('terminalTailMinPrice', () => {
  it('takes the minimum import price over the last tail_h hours', () => {
    // 15-min slots: the last 1 h is the last 4 slots.
    const prices = [5, 40, 30, 28, 35, 29, 31];
    expect(terminalTailMinPrice(prices, 15, 1)).toBe(28);
    expect(terminalTailMinPrice(prices, 15, 0.5)).toBe(29);
  });

  it('floors a negative tail at 0', () => {
    expect(terminalTailMinPrice([30, 30, -2, 25], 15, 1)).toBe(0);
  });

  it('uses the whole horizon when the tail is longer than it', () => {
    expect(terminalTailMinPrice([12, 40, 30], 15, 6)).toBe(12);
  });

  it('uses at least one slot, and an empty horizon is worth 0', () => {
    expect(terminalTailMinPrice([12, 40, 30], 60, 0.1)).toBe(30);
    expect(terminalTailMinPrice([], 15, 6)).toBe(0);
  });
});
