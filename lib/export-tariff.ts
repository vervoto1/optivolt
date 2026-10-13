/**
 * Export valuation around the end of net metering (salderingsregeling).
 *
 * Under net metering an exported kWh earns the import price (`sourceExport`).
 * Once it ends, export earns only the bare market price minus a fee. These
 * helpers decide, per slot, which rule applies; the LP itself is unchanged and
 * only sees the resulting `exportPrice` array and terminal valuation.
 */

export type ExportPriceRegime = 'netMetering' | 'market' | 'fallback';

/** The parts of the `exportTariff` settings block the price resolution needs. */
export interface ExportTariffRule {
  mode: 'auto' | 'netMetering' | 'marketPrice';
  /** ISO instant with an explicit offset, on a 15-minute UTC boundary. */
  effectiveFrom: string;
  fee_cents_per_kWh: number;
  negativePrice: 'floorZero' | 'passThrough';
}

export interface ResolveExportPricesInput {
  /** Start of each plan slot (ms since epoch); its length is the horizon T. */
  slotStartsMs: number[];
  /** Export price from the price source (today's net-metering value), per slot. */
  sourceExport: number[];
  /** Market price per slot; NaN (or any non-finite value) where it is missing. */
  market: number[];
  /** Absent behaves as `netMetering`. */
  tariff?: ExportTariffRule | null;
  /** Whether a market-price source is configured (see config-builder). */
  marketSourceConfigured: boolean;
}

export interface ResolvedExportPrices {
  exportPrice: number[];
  regime: ExportPriceRegime[];
  marketPricedSlots: number;
  fallbackSlots: number;
  /**
   * `auto` mode without a market source, and the horizon reaches
   * effectiveFrom − 7 days (its last slot starts at or after that instant).
   * Stays true after the switch, while the source is still missing.
   */
  missingMarketSource: boolean;
}

/** How long before `effectiveFrom` the "no market source" warning starts. */
export const MISSING_MARKET_SOURCE_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** What an absent tariff block means: today's behaviour. */
const NET_METERING: ExportTariffRule = {
  mode: 'netMetering', effectiveFrom: '', fee_cents_per_kWh: 0, negativePrice: 'floorZero',
};

const SLOT_BOUNDARY_MS = 15 * 60 * 1000;
const EFFECTIVE_FROM_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export type EffectiveFromParse = { ok: true; ms: number } | { ok: false; error: string };

/**
 * Parse an `effectiveFrom` instant. It must carry an explicit offset (`Z` or
 * `±hh:mm`; a bare local time would be ambiguous across time zones), name a
 * real calendar date and time (Date.parse rolls `02-30` over into March), and
 * fall on a 15-minute boundary in UTC so no slot straddles the switch.
 */
export function parseEffectiveFrom(value: unknown): EffectiveFromParse {
  if (typeof value !== 'string') return { ok: false, error: 'must be a string' };
  const text = value.trim();
  const match = EFFECTIVE_FROM_RE.exec(text);
  if (!match) {
    return { ok: false, error: 'must be an ISO date-time with an explicit offset (Z or ±hh:mm)' };
  }
  const ms = Date.parse(text);
  const offset_m = match[2] === 'Z'
    ? 0
    : (match[3] === '-' ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]));
  // Rebuild the local wall-clock fields from the instant and the offset: a
  // rolled-over date (Feb 30, 24:00) or an out-of-range offset no longer matches.
  const local = Number.isFinite(ms) ? new Date(ms + offset_m * 60_000).toISOString().slice(0, 16) : '';
  if (local !== match[1]) return { ok: false, error: 'is not a valid date-time' };
  if (ms % SLOT_BOUNDARY_MS !== 0) return { ok: false, error: 'must fall on a 15-minute boundary in UTC' };
  return { ok: true, ms };
}

/**
 * Resolve the export price of every slot. Per slot:
 *   1. no tariff, `netMetering`, `auto` without a market source, or `auto`
 *      before `effectiveFrom` → `sourceExport[t]` (regime `netMetering`);
 *   2. otherwise a finite `market[t]` → `market[t] − fee`, floored at 0 under
 *      `floorZero` (regime `market`);
 *   3. otherwise 0 (regime `fallback`): missing market data must not bring
 *      back the net-metering value, which over-values battery export ~2×.
 * An unparseable `effectiveFrom` in `auto` mode never switches (settings are
 * normalised on load, so this only guards configs built outside the store).
 */
export function resolveExportPrices({
  slotStartsMs, sourceExport, market, tariff, marketSourceConfigured,
}: ResolveExportPricesInput): ResolvedExportPrices {
  const T = slotStartsMs.length;
  const exportPrice: number[] = new Array(T);
  const regime: ExportPriceRegime[] = new Array(T);
  let marketPricedSlots = 0;
  let fallbackSlots = 0;

  const { mode, effectiveFrom, fee_cents_per_kWh, negativePrice } = tariff ?? NET_METERING;
  const parsed = parseEffectiveFrom(effectiveFrom);
  const effectiveFromMs = parsed.ok ? parsed.ms : Infinity;
  const autoWithoutSource = mode === 'auto' && !marketSourceConfigured;

  for (let t = 0; t < T; t++) {
    const netMetering = mode === 'netMetering'
      || autoWithoutSource
      || (mode === 'auto' && slotStartsMs[t] < effectiveFromMs);
    if (netMetering) {
      exportPrice[t] = sourceExport[t];
      regime[t] = 'netMetering';
    } else if (Number.isFinite(market[t])) {
      const net = market[t] - fee_cents_per_kWh;
      exportPrice[t] = negativePrice === 'floorZero' ? Math.max(0, net) : net;
      regime[t] = 'market';
      marketPricedSlots++;
    } else {
      exportPrice[t] = 0;
      regime[t] = 'fallback';
      fallbackSlots++;
    }
  }

  const missingMarketSource = autoWithoutSource
    && T > 0
    && slotStartsMs[T - 1] >= effectiveFromMs - MISSING_MARKET_SOURCE_LEAD_MS;

  return { exportPrice, regime, marketPricedSlots, fallbackSlots, missingMarketSource };
}

/**
 * Terminal SoC value for `tailMin`: max(0, min import price over the last
 * `tail_h` hours of the horizon). Stored charge at the end displaces import the
 * following night and morning, best approximated by the horizon's own tail; the
 * minimum keeps it below every evening import price so the battery still covers
 * the evening load. A tail longer than the horizon uses the whole horizon; an
 * empty horizon is worth 0.
 */
export function terminalTailMinPrice(importPrice: number[], stepSize_m: number, tail_h: number): number {
  if (importPrice.length === 0) return 0;
  const tailSlots = Math.max(1, Math.round((tail_h * 60) / stepSize_m));
  return Math.max(0, Math.min(...importPrice.slice(-tailSlots)));
}
