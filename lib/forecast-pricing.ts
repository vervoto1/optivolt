/**
 * Prices for the forecast slots of a multi-day horizon
 * (plans/multi-day-horizon-plan.md, "Pricing the forecast slots").
 *
 * The forecast feed gives the bare market price `m` (c/kWh ex VAT). The plan
 * needs the all-in import price and the export value per slot, so:
 *
 *   1. the firm import's resolution is detected (hourly when the published
 *      import is constant within every clock hour of the firm part) and the
 *      forecast is resampled to it, so the LP never sees quarter-hour
 *      arbitrage the user is not billed on;
 *   2. `import = a·m + b` is fitted (Theil–Sen) on the overlap of the
 *      published import prices and the feed's published part, so taxes and
 *      the supplier markup — including the 1 January change — follow the
 *      published prices; a rejected fit falls back to the stored one when it
 *      is recent and from the same calendar year, else there is no extension;
 *      a fresh fit prices only the slots in its overlap's calendar year;
 *   3. export continues the firm part's relation (net metering) or uses the
 *      forecast market price where `resolveExportPrices` would choose the
 *      market rule.
 *
 * Pure: no I/O. `api/services/config-builder.ts` (`buildExtendedSolverConfig`)
 * applies the result. Prices stay unbiased; the risk margin lives in the LP.
 * Clock hours are UTC hours, which are local hours in every feed region
 * (whole-hour offsets); "calendar year" is the server time zone's.
 */

import { resolveExportPrices, type ExportTariffRule, type ResolvedExportPrices } from './export-tariff.ts';
import { sampleSeriesAt } from './time-series-utils.ts';
import type { TimeSeries } from './types.ts';

/** Accepted slope range of the import fit (1 + VAT plus some markup on the market price). */
export const FIT_SLOPE_MIN = 0.95;
export const FIT_SLOPE_MAX = 1.30;
/** Below this spread of the market price (c/kWh) the slope is not identifiable: use a = 1 + VAT. */
export const FIT_LOW_SPREAD_CENTS = 3;
/** A fit whose median absolute residual exceeds this (c/kWh) is rejected. */
export const FIT_MAX_MAD_CENTS = 1;
/** Fewer overlap points than this is not enough to fit. */
export const FIT_MIN_POINTS = 6;
/** A stored fit is usable as a fallback while younger than this. */
export const STORED_FIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Net metering: a firm slot "deviates" from the median export offset by more than this (c/kWh)… */
export const EXPORT_OFFSET_TOLERANCE_CENTS = 1;
/** …and more than this share of deviating firm slots makes the relation inconsistent. */
export const EXPORT_OFFSET_MAX_DEVIATING_FRACTION = 0.1;

const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;
/** Prices are compared with this tolerance (c/kWh), well below any real price step. */
const EQUAL_EPS = 1e-6;

export type ImportResolution = 'hourly' | 'slot';

export interface ImportFit {
  a: number;
  b: number;
  /** Overlap points used. */
  n: number;
  /** Median absolute residual, c/kWh. */
  mad: number;
  /** `theilSen`: median pairwise slope; `lowSpread`: a = 1 + VAT (spread under 3 c). */
  method: 'theilSen' | 'lowSpread';
}

/** A fit as stored in `data.priceForecast.fit`. */
export interface StoredImportFit {
  a: number;
  b: number;
  n: number;
  mad: number;
  fittedAt: string;
}

export type FitRejectionReason = 'insufficientOverlap' | 'slopeOutOfRange' | 'residualTooLarge';

export type FitImportResult =
  | {
      ok: true;
      fit: ImportFit;
      /** Start (ms) of the last overlap point (the last slot of the last hour with `hourly`): its local year is the fit's. */
      lastPointMs: number;
    }
  | { ok: false; reason: FitRejectionReason; message: string; n: number; a?: number; b?: number; mad?: number };

export type StoredFitRejectionReason = 'none' | 'tooOld' | 'otherYear';

export type SelectImportFitResult =
  | { ok: true; fit: StoredImportFit; source: 'fresh' | 'stored'; method?: ImportFit['method']; freshRejection?: Extract<FitImportResult, { ok: false }> }
  | { ok: false; message: string; freshRejection: Extract<FitImportResult, { ok: false }>; storedRejection: StoredFitRejectionReason };

export type ExportRelation =
  | { kind: 'equal' }
  | { kind: 'zero' }
  | { kind: 'offset'; offset_cents_per_kWh: number };

export type ExportRelationResult =
  | { ok: true; relation: ExportRelation }
  | { ok: false; message: string; deviatingFraction: number };

export function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `hourly` when the firm import has at least one clock hour with two or more
 * slots and is constant within every clock hour of the firm part (an hourly
 * tariff sampled at 15 minutes); otherwise `slot` (prices vary per slot, or
 * the step is an hour or longer, so slot and hour coincide).
 */
export function detectImportResolution(firmImport: number[], firmStartMs: number, stepSize_m: number): ImportResolution {
  if (stepSize_m >= 60) return 'slot';
  const stepMs = stepSize_m * 60_000;
  const firstByHour = new Map<number, number>();
  let sharedHour = false;
  for (let t = 0; t < firmImport.length; t++) {
    const hour = Math.floor((firmStartMs + t * stepMs) / HOUR_MS);
    const first = firstByHour.get(hour);
    if (first === undefined) {
      firstByHour.set(hour, firmImport[t]);
      continue;
    }
    if (!(Math.abs(firmImport[t] - first) <= EQUAL_EPS)) return 'slot';
    sharedHour = true;
  }
  return sharedHour ? 'hourly' : 'slot';
}

/**
 * The forecast market price per slot: the mean of the feed's quarter-hours in
 * the slot's clock hour (`hourly`) or in the slot itself (`slot`; a slot
 * shorter than 15 minutes reads the quarter it lies in). NaN when any of
 * those quarters is missing from the series.
 */
export function resampleForecast(
  series: TimeSeries,
  slotStartsMs: number[],
  stepSize_m: number,
  resolution: ImportResolution,
): number[] {
  const stepMs = stepSize_m * 60_000;
  return slotStartsMs.map((slotMs) => {
    const bucketStart = resolution === 'hourly' ? Math.floor(slotMs / HOUR_MS) * HOUR_MS : slotMs;
    const bucketEnd = resolution === 'hourly' ? bucketStart + HOUR_MS : slotMs + stepMs;
    const times: number[] = [];
    for (let ms = bucketStart; ms < bucketEnd; ms += QUARTER_MS) times.push(ms);
    const samples = sampleSeriesAt(series, times);
    if (samples.some(v => !Number.isFinite(v))) return NaN;
    return samples.reduce((s, v) => s + v, 0) / samples.length;
  });
}

export interface FitImportInput {
  /** Published import prices (c/kWh, all-in). */
  importSeries: TimeSeries;
  /**
   * Exclusive end of the real import prices (VRM zero-fills after it); slots
   * at or after it are left out. Null/undefined: the series end.
   */
  importPublishedUntilMs?: number | null;
  /** Forecast feed series (market c/kWh ex VAT, 15-minute). */
  forecast: TimeSeries;
  /** End of the feed's published part (`knownUntil` + 15 min); later points are model output. */
  forecastPublishedEndMs: number;
  resolution: ImportResolution;
  /** Fallback slope 1 + VAT for a low-spread overlap. */
  vat_percent: number;
}

interface FitPoint { x: number; y: number }

/**
 * The overlap points: each import slot that lies wholly inside the feed's
 * published part and before `importPublishedUntilMs`, with the mean market
 * price over that slot. With `hourly`, the points of each complete clock hour
 * are averaged into one point (partial hours are dropped).
 */
export function collectFitPoints(input: Omit<FitImportInput, 'vat_percent'>): FitPoint[] {
  return collectTimedFitPoints(input).map(({ x, y }) => ({ x, y }));
}

/** `collectFitPoints` with each point's time (the last slot's start for an hourly point), in time order. */
function collectTimedFitPoints(input: Omit<FitImportInput, 'vat_percent'>): Array<FitPoint & { t: number }> {
  const { importSeries, importPublishedUntilMs, forecast, forecastPublishedEndMs, resolution } = input;
  const startMs = Date.parse(importSeries.start);
  const stepMs = (importSeries.step || 15) * 60_000;
  const forecastStartMs = Date.parse(forecast.start);
  const endMs = Math.min(forecastPublishedEndMs, importPublishedUntilMs ?? Infinity);

  const points: Array<FitPoint & { t: number }> = [];
  for (let i = 0; i < importSeries.values.length; i++) {
    const t = startMs + i * stepMs;
    if (t < forecastStartMs || t + stepMs > endMs) continue;
    const y = importSeries.values[i];
    const [x] = resampleForecast(forecast, [t], stepMs / 60_000, 'slot');
    if (!(typeof y === 'number' && Number.isFinite(y)) || !Number.isFinite(x)) continue;
    points.push({ t, x, y });
  }
  if (resolution !== 'hourly' || stepMs >= HOUR_MS) return points;

  const perHour = HOUR_MS / stepMs;
  const byHour = new Map<number, Array<FitPoint & { t: number }>>();
  for (const p of points) {
    const hour = Math.floor(p.t / HOUR_MS);
    const list = byHour.get(hour) ?? [];
    list.push(p);
    byHour.set(hour, list);
  }
  const hourly: Array<FitPoint & { t: number }> = [];
  for (const list of byHour.values()) {
    if (list.length < perHour) continue;
    hourly.push({
      x: list.reduce((s, p) => s + p.x, 0) / list.length,
      y: list.reduce((s, p) => s + p.y, 0) / list.length,
      t: list[list.length - 1].t,
    });
  }
  return hourly;
}

/**
 * Fit `import = a·m + b` on the overlap (see `collectFitPoints`).
 *
 * - Theil–Sen: `a` is the median of all pairwise slopes, `b` the median of
 *   `y − a·x`; `a` must lie in [0.95, 1.30].
 * - When the market price spreads less than 3 c over the overlap the slope is
 *   not identifiable: `a = 1 + VAT`, `b` the median of `y − a·x`.
 * - Either way the fit is rejected when the median absolute residual exceeds
 *   1 c, or with fewer than 6 points.
 */
export function fitImportPrice(input: FitImportInput): FitImportResult {
  const points = collectTimedFitPoints(input);
  const n = points.length;
  if (n < FIT_MIN_POINTS) {
    return { ok: false, reason: 'insufficientOverlap', n, message: `only ${n} overlap point(s) between published import and market prices (need ${FIT_MIN_POINTS})` };
  }
  const xs = points.map(p => p.x);
  const spread = Math.max(...xs) - Math.min(...xs);

  let a: number;
  let method: ImportFit['method'];
  if (spread < FIT_LOW_SPREAD_CENTS) {
    a = 1 + input.vat_percent / 100;
    method = 'lowSpread';
  } else {
    const slopes: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = points[j].x - points[i].x;
        if (Math.abs(dx) > EQUAL_EPS) slopes.push((points[j].y - points[i].y) / dx);
      }
    }
    a = median(slopes);
    method = 'theilSen';
  }
  const b = median(points.map(p => p.y - a * p.x));
  const mad = median(points.map(p => Math.abs(p.y - (a * p.x + b))));

  if (method === 'theilSen' && (a < FIT_SLOPE_MIN || a > FIT_SLOPE_MAX)) {
    return { ok: false, reason: 'slopeOutOfRange', n, a, b, mad, message: `fitted slope ${a.toFixed(3)} is outside [${FIT_SLOPE_MIN}, ${FIT_SLOPE_MAX}]` };
  }
  if (mad > FIT_MAX_MAD_CENTS) {
    return { ok: false, reason: 'residualTooLarge', n, a, b, mad, message: `fit residual MAD ${mad.toFixed(2)} c/kWh exceeds ${FIT_MAX_MAD_CENTS} c/kWh` };
  }
  return { ok: true, fit: { a, b, n, mad, method }, lastPointMs: points[n - 1].t };
}

export function localYear(ms: number): number {
  return new Date(ms).getFullYear();
}

/**
 * The fit to price with: the fresh fit when accepted; otherwise the stored fit
 * when it is younger than 7 days (a `fittedAt` in the future counts as age 0)
 * and from the same local calendar year as `lastPricedSlotMs` (so a 2026 fit
 * never prices 2027 slots: taxes change on 1 January); otherwise none.
 */
export function selectImportFit({ fresh, stored, nowMs, lastPricedSlotMs }: {
  fresh: FitImportResult;
  stored?: StoredImportFit | null;
  nowMs: number;
  lastPricedSlotMs: number;
}): SelectImportFitResult {
  if (fresh.ok) {
    const { a, b, n, mad, method } = fresh.fit;
    return { ok: true, fit: { a, b, n, mad, fittedAt: new Date(nowMs).toISOString() }, source: 'fresh', method };
  }
  if (!stored) {
    return { ok: false, freshRejection: fresh, storedRejection: 'none', message: `import fit rejected (${fresh.message}) and no stored fit` };
  }
  const fittedAtMs = Date.parse(stored.fittedAt);
  const ageMs = Math.max(0, nowMs - fittedAtMs);
  if (!(ageMs < STORED_FIT_MAX_AGE_MS)) {
    return { ok: false, freshRejection: fresh, storedRejection: 'tooOld', message: `import fit rejected (${fresh.message}); the stored fit from ${stored.fittedAt} is 7 days old or more` };
  }
  if (localYear(fittedAtMs) !== localYear(lastPricedSlotMs)) {
    return { ok: false, freshRejection: fresh, storedRejection: 'otherYear', message: `import fit rejected (${fresh.message}); the stored fit from ${stored.fittedAt} is from another calendar year than the forecast slots` };
  }
  return { ok: true, fit: { ...stored }, source: 'stored', freshRejection: fresh };
}

/**
 * The net-metering export relation of the firm part (source export vs import,
 * per slot):
 *   - `equal`: every export equals the import (within 1e-6 c);
 *   - `zero`: every export is 0;
 *   - `offset`: export = import + median(export − import), when at most 10 %
 *     of the firm slots deviate from that median offset by more than 1 c;
 *   - otherwise (or without any finite price pair) inconsistent: the relation
 *     cannot be continued and there is no extension.
 */
export function deriveExportRelation(firmImport: number[], firmSourceExport: number[]): ExportRelationResult {
  const pairs: Array<[number, number]> = [];
  for (let t = 0; t < Math.min(firmImport.length, firmSourceExport.length); t++) {
    const i = firmImport[t];
    const e = firmSourceExport[t];
    if (Number.isFinite(i) && Number.isFinite(e)) pairs.push([i, e]);
  }
  if (pairs.length === 0) return { ok: false, deviatingFraction: 1, message: 'no firm import/export prices to derive the export relation from' };
  if (pairs.every(([i, e]) => Math.abs(e - i) <= EQUAL_EPS)) return { ok: true, relation: { kind: 'equal' } };
  if (pairs.every(([, e]) => Math.abs(e) <= EQUAL_EPS)) return { ok: true, relation: { kind: 'zero' } };
  const diffs = pairs.map(([i, e]) => e - i);
  const offset = median(diffs);
  const deviating = diffs.filter(d => Math.abs(d - offset) > EXPORT_OFFSET_TOLERANCE_CENTS).length;
  const deviatingFraction = deviating / diffs.length;
  if (deviatingFraction > EXPORT_OFFSET_MAX_DEVIATING_FRACTION) {
    return {
      ok: false,
      deviatingFraction,
      message: `firm export prices follow no consistent relation to import (${Math.round(deviatingFraction * 100)} % of slots deviate more than ${EXPORT_OFFSET_TOLERANCE_CENTS} c/kWh from the median offset ${offset.toFixed(2)} c/kWh)`,
    };
  }
  return { ok: true, relation: { kind: 'offset', offset_cents_per_kWh: offset } };
}

/** Net-metering export for forecast slots from their forecast import price. */
export function applyExportRelation(relation: ExportRelation, importPrice: number[]): number[] {
  switch (relation.kind) {
    case 'equal': return [...importPrice];
    case 'zero': return importPrice.map(() => 0);
    case 'offset': return importPrice.map(p => p + relation.offset_cents_per_kWh);
  }
}

export interface PriceForecastSlotsInput {
  nowMs: number;
  stepSize_m: number;
  /** Start of the plan (slot 0). */
  firmStartMs: number;
  /** Firm import prices (the solver config's `importPrice`), one per firm slot. */
  firmImport: number[];
  /** Firm export prices from the price source, before the export tariff, one per firm slot. */
  firmSourceExport: number[];
  /** Start of each forecast slot to price (t ≥ firmSlots), contiguous. */
  slotStartsMs: number[];
  /** Published import series and the exclusive end of its real values (VRM). */
  importSeries: TimeSeries;
  importPublishedUntilMs?: number | null;
  forecast: { series: TimeSeries; publishedEndMs: number; fit?: StoredImportFit | null };
  vat_percent: number;
  tariff?: ExportTariffRule | null;
  marketSourceConfigured: boolean;
}

export type ForecastPricingRejection = 'noForecastSlots' | 'fitRejected' | 'exportInconsistent';

export type PriceForecastSlotsResult =
  | {
      ok: true;
      resolution: ImportResolution;
      /** Slots priced: the leading slots of `slotStartsMs` the forecast covers. */
      slots: number;
      /** Start of the first requested slot that is not priced, when cut short. */
      truncatedAtMs?: number;
      /**
       * Why the slots end at `truncatedAtMs`: `forecast`, the forecast lacks a
       * quarter of that slot; `fitYear`, the fresh fit's overlap is in an
       * earlier local year than that slot (taxes change on 1 January).
       */
      truncationReason?: 'forecast' | 'fitYear';
      market: number[];
      importPrice: number[];
      /** Net-metering export value (the continued firm relation); the import price where no relation was needed. */
      sourceExport: number[];
      export: ResolvedExportPrices;
      fit: StoredImportFit;
      fitSource: 'fresh' | 'stored';
      fitMethod?: ImportFit['method'];
      freshFitRejection?: { reason: FitRejectionReason; message: string };
      /** The continued relation, or null when no forecast slot is net-metered. */
      exportRelation: ExportRelation | null;
    }
  | {
      ok: false;
      reason: ForecastPricingRejection;
      message: string;
      /** Absent when the fresh fit was accepted but is from an earlier year than every forecast slot. */
      fitRejection?: { reason: FitRejectionReason; message: string; storedRejection: StoredFitRejectionReason };
    };

/**
 * Price the forecast slots: resample, fit (or the stored fit), import =
 * a·m + b, then export per `resolveExportPrices` with the forecast market
 * price as the market series and the continued firm relation as the
 * net-metering value. The result covers the leading slots the forecast has
 * every quarter for and, with a fresh fit, that lie in the local calendar
 * year of the fit's last overlap point: a fit on this year's published
 * prices never prices next year's slots (a stored fit from another year is
 * already refused by `selectImportFit`). Every rejection carries a reason
 * and a message.
 */
export function priceForecastSlots(input: PriceForecastSlotsInput): PriceForecastSlotsResult {
  const { stepSize_m, firmImport, forecast } = input;
  const resolution = detectImportResolution(firmImport, input.firmStartMs, stepSize_m);

  const resampled = resampleForecast(forecast.series, input.slotStartsMs, stepSize_m, resolution);
  const firstMissing = resampled.findIndex(v => !Number.isFinite(v));
  const covered = firstMissing === -1 ? resampled.length : firstMissing;
  if (covered === 0) {
    return { ok: false, reason: 'noForecastSlots', message: 'the price forecast does not cover the first slot after the published prices' };
  }

  const fresh = fitImportPrice({
    importSeries: input.importSeries,
    importPublishedUntilMs: input.importPublishedUntilMs,
    forecast: forecast.series,
    forecastPublishedEndMs: forecast.publishedEndMs,
    resolution,
    vat_percent: input.vat_percent,
  });
  const selected = selectImportFit({ fresh, stored: forecast.fit, nowMs: input.nowMs, lastPricedSlotMs: input.slotStartsMs[covered - 1] });
  if (!selected.ok) {
    const { reason, message } = selected.freshRejection;
    return { ok: false, reason: 'fitRejected', message: selected.message, fitRejection: { reason, message, storedRejection: selected.storedRejection } };
  }

  let slots = covered;
  let truncationReason: 'forecast' | 'fitYear' = 'forecast';
  if (fresh.ok) {
    const fitYear = localYear(fresh.lastPointMs);
    const otherYear = input.slotStartsMs.slice(0, covered).findIndex(ms => localYear(ms) !== fitYear);
    if (otherYear === 0) {
      return {
        ok: false,
        reason: 'fitRejected',
        message: `the import fit is on ${fitYear} published prices and cannot price the ${localYear(input.slotStartsMs[0])} forecast slots (taxes change on 1 January)`,
      };
    }
    if (otherYear > 0) {
      slots = otherYear;
      truncationReason = 'fitYear';
    }
  }
  const slotStartsMs = input.slotStartsMs.slice(0, slots);
  const market = resampled.slice(0, slots);
  const { a, b } = selected.fit;
  const importPrice = market.map(m => a * m + b);

  // Which slots the tariff values at net metering (the source export value
  // is only read there); the relation is only needed when there are any.
  const exportInput = { slotStartsMs, market, tariff: input.tariff, marketSourceConfigured: input.marketSourceConfigured };
  const probe = resolveExportPrices({ ...exportInput, sourceExport: importPrice });
  let exportRelation: ExportRelation | null = null;
  let sourceExport = [...importPrice];
  if (probe.regime.includes('netMetering')) {
    const relation = deriveExportRelation(firmImport, input.firmSourceExport);
    if (!relation.ok) return { ok: false, reason: 'exportInconsistent', message: relation.message };
    exportRelation = relation.relation;
    sourceExport = applyExportRelation(relation.relation, importPrice);
  }
  const resolved = resolveExportPrices({ ...exportInput, sourceExport });

  return {
    ok: true,
    resolution,
    slots,
    ...(slots < input.slotStartsMs.length ? { truncatedAtMs: input.slotStartsMs[slots], truncationReason } : {}),
    market,
    importPrice,
    sourceExport,
    export: resolved,
    fit: selected.fit,
    fitSource: selected.source,
    ...(selected.method ? { fitMethod: selected.method } : {}),
    ...(selected.freshRejection ? { freshFitRejection: { reason: selected.freshRejection.reason, message: selected.freshRejection.message } } : {}),
    exportRelation,
  };
}
