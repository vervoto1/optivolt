/**
 * Helpers for the multi-day horizon what-if (scripts/horizon-whatif.ts).
 *
 * The what-if solves one snapshot twice: the firm-only plan (exactly what the
 * planner solves first, the fallback) and the extended plan built from it by
 * `buildExtendedSolverConfig`, and prints both side by side. Everything here
 * is pure; the script does the file and solver I/O.
 *
 * Local days and midnights are the process time zone's, as on the add-on
 * (run with TZ=<the box's zone> when the dev box differs).
 */
import { EXTENDED_HORIZON_DEFAULTS } from '../api/services/settings-schema.ts';
import { parsePriceForecastResponse } from '../lib/price-forecast.ts';
import type { PlanRow, TimeSeries } from '../lib/types.ts';
import type { Data, ExtendedHorizonMode, PriceForecastData, PriceForecastFit, PriceForecastRegion, Settings } from '../api/types.ts';

const DAY_MS = 24 * 60 * 60_000;

/**
 * The snapshot's settings with `extendedHorizon.mode` forced (and `extraDays`
 * when given). A snapshot taken before the block existed gets the defaults.
 */
export function settingsWithHorizon(settings: Settings, mode: ExtendedHorizonMode, extraDays?: number): Settings {
  return {
    ...settings,
    extendedHorizon: {
      ...EXTENDED_HORIZON_DEFAULTS,
      ...settings.extendedHorizon,
      mode,
      ...(extraDays !== undefined ? { extraDays } : {}),
    },
  };
}

/** Parse `--extra-days`: a whole number 1–4, or undefined when absent. Throws otherwise. */
export function parseExtraDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error(`--extra-days must be a whole number from 1 to 4 (got ${JSON.stringify(value)})`);
  return n;
}

/**
 * A saved EpexPredictor response (GET <feed>/prices?region=..&unit=CT_PER_KWH&startTs=..)
 * as `data.priceForecast`, the shape the background refresh stores. The
 * snapshot has no fetch time for it, so `fetchedAt` is the caller's (the plan
 * start keeps it fresh for the solve). A stored `fit` for the same region is
 * kept as the fallback fit, as the refresh does.
 */
export function forecastFromResponse(body: unknown, { region, fetchedAt, stored }: {
  region: PriceForecastRegion;
  fetchedAt: string;
  stored?: PriceForecastData;
}): { forecast: PriceForecastData; truncated: boolean } {
  const parsed = parsePriceForecastResponse(body);
  const fit: PriceForecastFit | undefined = stored?.region === region ? stored.fit : undefined;
  return {
    forecast: {
      fetchedAt,
      publishedEnd: new Date(parsed.publishedEndMs).toISOString(),
      region,
      series: parsed.series,
      ...(fit ? { fit } : {}),
    },
    truncated: parsed.truncated,
  };
}

/**
 * Extend `series` to `targetEndMs` by repeating its last 24 h slot for slot
 * (each new slot copies the slot one day earlier). A synthetic profile for
 * exercising the extension when the snapshot's load/PV stop at the old
 * horizon; a DST change shifts it by an hour, which is irrelevant for that.
 * Throws when the series covers less than a day.
 */
export function extendByRepeatingLastDay(series: TimeSeries, targetEndMs: number, label = 'series'): { series: TimeSeries; addedSlots: number } {
  const step = series.step || 15;
  const stepMs = step * 60_000;
  const daySlots = Math.round(DAY_MS / stepMs);
  const endMs = Date.parse(series.start) + series.values.length * stepMs;
  if (endMs >= targetEndMs) return { series, addedSlots: 0 };
  if (series.values.length < daySlots) {
    throw new Error(`${label} covers ${(series.values.length * step / 60).toFixed(2)} h; a synthetic tail needs at least 24 h to repeat`);
  }
  const values = [...series.values];
  const addedSlots = Math.ceil((targetEndMs - endMs) / stepMs);
  for (let i = 0; i < addedSlots; i++) values.push(values[values.length - daySlots]);
  return { series: { ...series, values }, addedSlots };
}

/** `data` with load and PV extended to `targetEndMs` (see extendByRepeatingLastDay), plus one note per series. */
export function withSyntheticTail(data: Data, targetEndMs: number): { data: Data; notes: string[] } {
  const notes: string[] = [];
  const next = { ...data };
  for (const key of ['load', 'pv'] as const) {
    const { series, addedSlots } = extendByRepeatingLastDay(data[key], targetEndMs, key);
    next[key] = series;
    notes.push(addedSlots > 0
      ? `SYNTHETIC: ${key} extended by ${addedSlots} slots to ${new Date(targetEndMs).toISOString()} by repeating its last 24 h`
      : `${key}: already reaches ${new Date(targetEndMs).toISOString()}, not extended`);
  }
  return { data: next, notes };
}

/**
 * Start slot of the rebalance hold the solver chose: the `start_balance_k`
 * binary that is 1 (the planner's `extractRebalanceWindow`). Undefined when
 * there is none.
 */
export function rebalanceStartFromColumns(columns: Record<string, { Primal?: number }> | undefined): number | undefined {
  for (const [name, col] of Object.entries(columns ?? {})) {
    const m = /^start_balance_(\d+)$/.exec(name);
    if (m && Math.round(col.Primal ?? 0) === 1) return Number(m[1]);
  }
  return undefined;
}

/** Local midnights strictly after `startMs` and at or before `endMs`. */
export function localMidnightsBetween(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  const d = new Date(startMs);
  d.setHours(0, 0, 0, 0);
  for (;;) {
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() > endMs) return out;
    out.push(d.getTime());
  }
}

/** SoC (%) at the end of the slot that ends at `atMs`, or null when no row ends there. */
export function socAt(rows: PlanRow[], stepMin: number, atMs: number): number | null {
  const stepMs = stepMin * 60_000;
  const row = rows.find(r => r.timestampMs + stepMs === atMs);
  return row ? row.soc_percent : null;
}

/** Local calendar day of `ms`, as YYYY-MM-DD. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Short local label, e.g. "Wed 14 Oct 00:00". */
export function localLabel(ms: number, withTime = true): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '');
  return withTime ? `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day;
}

/** Grid→battery energy per local day of the slot start, in kWh, in day order. */
export function gridToBatteryByDay(rows: PlanRow[], stepMin: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = localDayKey(r.timestampMs);
    out.set(key, (out.get(key) ?? 0) + r.g2b * stepMin / 60 / 1000);
  }
  return out;
}

/** Planned import cost minus export revenue of rows [from, to), in euros. */
export function netCostEuros(rows: PlanRow[], from = 0, to = rows.length): number {
  let cents = 0;
  for (const r of rows.slice(from, to)) cents += r.importCost_cents - r.exportCost_cents;
  return cents / 100;
}

export interface LpDifference {
  /** 1-based line and column of the first differing character. */
  line: number;
  column: number;
  /** Up to `context` characters either side of it in each LP ("<end of LP>" past the last line). */
  a: string;
  b: string;
  linesA: number;
  linesB: number;
}

/** Where two LP strings first differ, or null when they are identical. LP lines can be very long, so only an excerpt is kept. */
export function firstLpDifference(a: string, b: string, context = 60): LpDifference | null {
  if (a === b) return null;
  const la = a.split('\n');
  const lb = b.split('\n');
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const lineA = la[i];
  const lineB = lb[i];
  let c = 0;
  if (lineA !== undefined && lineB !== undefined) {
    while (c < lineA.length && c < lineB.length && lineA[c] === lineB[c]) c++;
  }
  const excerpt = (line: string | undefined) => {
    if (line === undefined) return '<end of LP>';
    const from = Math.max(0, c - context);
    const to = Math.min(line.length, c + context);
    return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
  };
  return { line: i + 1, column: c + 1, a: excerpt(lineA), b: excerpt(lineB), linesA: la.length, linesB: lb.length };
}

const pad = (s: string, n: number) => s.padStart(n);
const watts = (r: PlanRow | undefined, key: 'imp' | 'exp') => (r ? String(Math.round(r[key])) : '');
const pct = (r: PlanRow | undefined) => (r ? r.soc_percent.toFixed(1) : '');

/**
 * The first `count` slots of both plans side by side: grid import/export (W)
 * and SoC (%) per plan, and the SoC difference (extended − firm). Rows past
 * the firm plan's end are left blank on the firm side; forecast rows of the
 * extended plan are marked `f`.
 */
export function sideBySideLines(firm: PlanRow[], extended: PlanRow[] | null, count: number): string[] {
  const lines = [[
    pad('slot', 4), 'time'.padEnd(16), pad('firm imp', 9), pad('exp', 6), pad('soc%', 6),
    ...(extended ? [pad('ext imp', 9), pad('exp', 6), pad('soc%', 6), pad('Δsoc', 6), ' '] : []),
  ].join(' ')];
  const n = Math.min(count, Math.max(firm.length, extended?.length ?? 0));
  for (let t = 0; t < n; t++) {
    const f = firm[t];
    const e = extended?.[t];
    const ts = (f ?? e)!.timestampMs;
    const cells = [pad(String(t), 4), localLabel(ts).padEnd(16), pad(watts(f, 'imp'), 9), pad(watts(f, 'exp'), 6), pad(pct(f), 6)];
    if (extended) {
      const delta = f && e ? (e.soc_percent - f.soc_percent).toFixed(1) : '';
      cells.push(pad(watts(e, 'imp'), 9), pad(watts(e, 'exp'), 6), pad(pct(e), 6), pad(delta, 6), e?.priceForecast ? 'f' : ' ');
    }
    lines.push(cells.join(' ').trimEnd());
  }
  return lines;
}
