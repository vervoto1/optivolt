import type { Settings } from '../types.ts';
import type { TimeSeries } from '../../lib/types.ts';
import { resolveHaHttpConfig } from './ha-config.ts';

interface PriceSlot {
  [key: string]: unknown;
}

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60_000;
const HOUR_MS = 3_600_000;

export interface PricePointsOptions {
  timeKey: string;
  valueKey: string;
  /** Applied to each raw value (e.g. 100 for EUR/kWh -> cents/kWh). */
  multiplier: number;
  /** Minutes covered by one feed point: 60 (hourly) or 15. */
  interval: number;
  /** Current time; picks the contiguous run to use when the feed has a defect. */
  nowMs: number;
}

/**
 * Strict price check: only a finite number or a strictly numeric string is a
 * price. `Number()` would turn null, '', false and [] into 0 (and true into 1),
 * which the LP would read as free electricity.
 */
export function parseStrictPrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null; // '1e999' overflows to Infinity
}

interface InstantCandidate {
  ms: number;
  /** UTC offset of the timestamp's wall-clock reading at this instant (ms). */
  offsetMs: number;
}

const EXPLICIT_OFFSET = /(?:Z|([+-])(\d{2}):?(\d{2}))$/i;

function localOffsetMs(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}

/**
 * Every instant a feed timestamp can denote. A timestamp with an explicit
 * offset (or Z) is unambiguous. A bare wall-clock timestamp is read in the
 * server time zone; inside the repeated autumn DST hour it has two candidates
 * (ascending). Empty when unparseable.
 */
function timestampCandidates(raw: unknown): InstantCandidate[] {
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (text === '') return [];
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return [];

  const explicit = EXPLICIT_OFFSET.exec(text);
  if (explicit) {
    const offsetMs = explicit[1]
      ? (explicit[1] === '-' ? -1 : 1) * (Number(explicit[2]) * 60 + Number(explicit[3])) * 60_000
      : 0;
    return [{ ms, offsetMs }];
  }

  const candidates: InstantCandidate[] = [{ ms, offsetMs: localOffsetMs(ms) }];
  // JS resolves an ambiguous local time to the earlier instant; the later one
  // shows the same wall-clock reading one hour on (after the clocks go back).
  const laterMs = ms + HOUR_MS;
  if (laterMs + localOffsetMs(laterMs) === ms + localOffsetMs(ms)) {
    candidates.push({ ms: laterMs, offsetMs: localOffsetMs(laterMs) });
  }
  return candidates;
}

interface Run {
  startMs: number;
  values: number[];
}

function runEndMs(run: Run): number {
  return run.startMs + run.values.length * SLOT_MS;
}

/**
 * Convert HA price points into a contiguous 15-min series, placing each point
 * by its timestamp instead of by its position in the list.
 *
 * - Only finite numeric prices are accepted (see parseStrictPrice).
 * - The autumn DST change is resolved: a bare repeated wall-clock time maps to
 *   the occurrence that continues the sequence, and a feed that merged the two
 *   occurrences into one entry (GE-Spot's hourly average does this: 24 entries
 *   for the 25-hour day) has the missing hour filled with that merged entry's
 *   price, since it is the price of that wall-clock hour on both occurrences.
 * - Any other gap, or an invalid price or timestamp, splits the feed into
 *   contiguous runs; an out-of-order, duplicate or overlapping timestamp ends
 *   the feed.
 *   Prices are never shifted onto the wrong slots.
 *
 * A clean feed returns its single run unchanged. A defective feed returns the
 * run that covers `nowMs` (truncated at the next defect), or null when no run
 * covers now, so the caller keeps the previously stored prices.
 */
export function pricePointsToSeries(points: PriceSlot[], opts: PricePointsOptions): TimeSeries | null {
  const slotsPerPoint = opts.interval === 60 ? 4 : 1;
  const pointMs = slotsPerPoint * SLOT_MS;

  const runs: Run[] = [];
  let run: Run | null = null;
  let lastMs: number | null = null;
  let lastOffsetMs = 0;
  let defects = 0;

  for (const point of points) {
    const rawPrice = parseStrictPrice(point?.[opts.valueKey]);
    const candidates = timestampCandidates(point?.[opts.timeKey]);
    if (rawPrice === null || candidates.length === 0) {
      defects++;
      run = null;
      continue;
    }
    const price = rawPrice * opts.multiplier;

    const expectedMs: number = run ? runEndMs(run) : NaN;
    const chosen: InstantCandidate = candidates.find(c => c.ms === expectedMs)
      ?? candidates.find(c => lastMs === null || c.ms >= lastMs + pointMs)
      ?? candidates[0];

    if (lastMs !== null && chosen.ms < lastMs + pointMs) {
      // Out-of-order, duplicate or overlapping timestamp: nothing after it can
      // be trusted.
      defects++;
      break;
    }

    if (run && chosen.ms !== expectedMs) {
      const holeMs = chosen.ms - expectedMs;
      const holeSlots = holeMs / SLOT_MS;
      // lastMs is non-null whenever a run is open.
      const wallStepMs = (chosen.ms + chosen.offsetMs) - (lastMs! + lastOffsetMs);
      const isMergedFallBackHour = wallStepMs === pointMs
        && holeMs === lastOffsetMs - chosen.offsetMs
        && holeMs <= HOUR_MS
        && Number.isInteger(holeSlots)
        && holeSlots <= run.values.length;
      if (isMergedFallBackHour) {
        // The hole is the second occurrence of the wall-clock time just
        // covered: repeat those slots' prices.
        run.values.push(...run.values.slice(-holeSlots));
        console.log('[ha-price] Filled the repeated DST hour merged by the price feed', {
          from: new Date(expectedMs).toISOString(),
          to: new Date(chosen.ms).toISOString(),
        });
      } else {
        defects++;
        run = null;
      }
    }

    if (!run) {
      run = { startMs: chosen.ms, values: [] };
      runs.push(run);
    }
    for (let i = 0; i < slotsPerPoint; i++) run.values.push(price);
    lastMs = chosen.ms;
    lastOffsetMs = chosen.offsetMs;
  }

  const toSeries = (r: Run): TimeSeries => ({
    start: new Date(r.startMs).toISOString(),
    step: SLOT_MINUTES,
    values: r.values,
  });
  const describeRuns = () => runs.map(r => ({
    start: new Date(r.startMs).toISOString(),
    end: new Date(runEndMs(r)).toISOString(),
  }));

  if (runs.length === 0) {
    console.warn('[ha-price] No valid price points in the sensor attributes');
    return null;
  }
  if (defects === 0) return toSeries(runs[0]);

  const current = runs.find(r => r.startMs <= opts.nowMs && opts.nowMs < runEndMs(r));
  if (!current) {
    console.warn('[ha-price] Price feed has gaps or invalid entries and no contiguous run covers now; keeping previous prices', {
      runs: describeRuns(),
    });
    return null;
  }
  console.warn('[ha-price] Price feed has gaps or invalid entries; using the contiguous run around now', {
    runs: describeRuns(),
    used: { start: new Date(current.startMs).toISOString(), end: new Date(runEndMs(current)).toISOString() },
  });
  return toSeries(current);
}

/**
 * Fetch electricity prices from a Home Assistant sensor.
 * Reads today + tomorrow price arrays from sensor attributes,
 * converts to 15-min slot TimeSeries in cents/kWh.
 */
export async function fetchPricesFromHA(settings: Settings): Promise<{ importPrice: TimeSeries; exportPrice: TimeSeries } | null> {
  const { haPriceConfig, haUrl, haToken } = settings;

  if (!haPriceConfig?.sensor) {
    return null;
  }

  const haConfig = resolveHaHttpConfig(haUrl, haToken);
  if (!haConfig) {
    return null;
  }
  const { baseUrl, token } = haConfig;

  try {
    const state = await fetchEntityState(baseUrl, token, haPriceConfig.sensor);
    if (!state?.attributes) {
      console.warn('[ha-price] No attributes found on sensor', haPriceConfig.sensor);
      return null;
    }

    const todayAttr = haPriceConfig.todayAttribute || 'today_hourly_prices';
    const tomorrowAttr = haPriceConfig.tomorrowAttribute || 'tomorrow_hourly_prices';
    const timeKey = haPriceConfig.timeKey || 'time';
    const valueKey = haPriceConfig.valueKey || 'value';
    const multiplier = haPriceConfig.valueMultiplier ?? 100;
    const interval = haPriceConfig.priceInterval ?? 60;

    const todayPrices = state.attributes[todayAttr] as PriceSlot[] | undefined;
    const tomorrowPrices = state.attributes[tomorrowAttr] as PriceSlot[] | undefined;

    if (!Array.isArray(todayPrices) || todayPrices.length === 0) {
      console.warn('[ha-price] No today prices found in attribute', todayAttr);
      return null;
    }

    // Combine today + tomorrow (tomorrow may be empty before ~14:00). Feed
    // order is authoritative: it is what resolves a bare wall-clock timestamp
    // in the repeated autumn DST hour.
    const allPrices = [...todayPrices];
    if (Array.isArray(tomorrowPrices) && tomorrowPrices.length > 0) {
      allPrices.push(...tomorrowPrices);
    }

    const series = pricePointsToSeries(allPrices, {
      timeKey, valueKey, multiplier, interval, nowMs: Date.now(),
    });
    if (!series) return null;
    const { start: startTime, values } = series;

    const importPrice: TimeSeries = { start: startTime, step: 15, values };
    const exportPrice: TimeSeries = haPriceConfig.importEqualsExport !== false
      ? { start: startTime, step: 15, values: [...values] }
      : { start: startTime, step: 15, values: new Array(values.length).fill(0) };

    return { importPrice, exportPrice };
  } catch (err) {
    console.warn('[ha-price] Failed to fetch prices from HA:', (err as Error).message);
    return null;
  }
}

async function fetchEntityState(
  baseUrl: string,
  token: string,
  entityId: string,
): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  const url = `${baseUrl}/api/states/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HA API returned ${res.status} for ${entityId}`);
  }
  return res.json() as Promise<{ state: string; attributes: Record<string, unknown> }>;
}
