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

interface ParsedTimestamp {
  candidates: InstantCandidate[];
  /** True when the timestamp carries its own offset (or Z). */
  explicit: boolean;
  /**
   * True for a bare wall-clock time the server zone skips (the spring-forward
   * hour). It has no instant; `candidates` is empty.
   */
  nonexistent: boolean;
}

const EXPLICIT_OFFSET = /(?:Z|([+-])(\d{2}):?(\d{2}))$/i;
const BARE_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

function localOffsetMs(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}

/**
 * Every instant a feed timestamp can denote. A timestamp with an explicit
 * offset (or Z) is unambiguous. A bare wall-clock timestamp is read in the
 * server time zone; inside the repeated autumn DST hour it has two candidates
 * (ascending), and inside the skipped spring hour it has none (`nonexistent`).
 * No candidates when unparseable.
 */
function parseTimestamp(raw: unknown): ParsedTimestamp {
  const none: ParsedTimestamp = { candidates: [], explicit: false, nonexistent: false };
  if (typeof raw !== 'string') return none;
  const text = raw.trim();
  if (text === '') return none;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return none;

  const explicit = EXPLICIT_OFFSET.exec(text);
  if (explicit) {
    const offsetMs = explicit[1]
      ? (explicit[1] === '-' ? -1 : 1) * (Number(explicit[2]) * 60 + Number(explicit[3])) * 60_000
      : 0;
    return { candidates: [{ ms, offsetMs }], explicit: true, nonexistent: false };
  }

  // JS moves a wall-clock time the zone skips forward by the DST step, onto
  // the same instant as the next real hour (02:00 -> 03:00 on the spring
  // day). Detect that by reading the resolved instant back in local time.
  const fields = BARE_WALL_CLOCK.exec(text);
  if (fields) {
    const [, y, mo, d, h, mi] = fields.map(Number);
    const wallMinute = Date.UTC(y, mo - 1, d, h, mi) / 60_000;
    if (Math.floor((ms + localOffsetMs(ms)) / 60_000) !== wallMinute) {
      return { candidates: [], explicit: false, nonexistent: true };
    }
  }

  const candidates: InstantCandidate[] = [{ ms, offsetMs: localOffsetMs(ms) }];
  // JS resolves an ambiguous local time to the earlier instant; the later one
  // shows the same wall-clock reading one hour on (after the clocks go back).
  const laterMs = ms + HOUR_MS;
  if (laterMs + localOffsetMs(laterMs) === ms + localOffsetMs(ms)) {
    candidates.push({ ms: laterMs, offsetMs: localOffsetMs(laterMs) });
  }
  return { candidates, explicit: false, nonexistent: false };
}

interface Run {
  startMs: number;
  /** Slot prices; NaN placeholders mark a hole awaiting a forward fill. */
  values: number[];
  /** Holes [index, index + count) to fill from the `count` slots right after them. */
  forwardFills: Array<{ index: number; count: number }>;
  /** Omitted feed intervals bridged by carrying the previous price forward. */
  bridged: number;
}

/**
 * Omitted intervals a run may bridge before a further hole splits it. One
 * dropped hour is the documented GE-Spot behaviour on incomplete source data;
 * a feed missing more than that is not trusted for made-up prices.
 */
const MAX_BRIDGED_PER_RUN = 1;

function runEndMs(run: Run): number {
  return run.startMs + run.values.length * SLOT_MS;
}

/**
 * Resolve forward fills once the walk is done. A hole whose source slots never
 * arrived (the run ended first) cuts the run at the hole, and any slot that is
 * still not a finite price cuts it there too, so no placeholder escapes.
 */
function finalizeRun(run: Run): void {
  for (const { index, count } of run.forwardFills) {
    if (index + 2 * count > run.values.length) {
      run.values.length = index;
      break;
    }
    for (let i = 0; i < count; i++) run.values[index + i] = run.values[index + count + i];
  }
  const firstInvalid = run.values.findIndex(v => !Number.isFinite(v));
  if (firstInvalid !== -1) run.values.length = firstInvalid;
}

/**
 * Convert HA price points into a contiguous 15-min series, placing each point
 * by its timestamp instead of by its position in the list.
 *
 * - Only finite numeric prices are accepted (see parseStrictPrice). A point
 *   with an invalid price ends the run at its time: the feed listed that
 *   interval but gave no usable price for it, so it is never bridged. A point
 *   whose timestamp cannot be parsed has no time to end the run at; it is
 *   dropped and no hole in that feed is filled, since the dropped point may
 *   belong there. A bare wall-clock time the server zone skips (02:00 on the
 *   spring-forward day) is dropped too: that hour does not exist.
 * - When every timestamp carries an explicit offset the points are sorted by
 *   time first (lossless). For bare wall-clock timestamps feed order is
 *   authoritative: it is what resolves the repeated autumn DST hour, where a
 *   bare time maps to the occurrence that continues the sequence.
 * - A feed that merged the two occurrences of the repeated hour into one entry
 *   (GE-Spot's hourly average does this: 24 entries for the 25-hour day) has
 *   the missing occurrence filled with that merged entry's price, since it is
 *   the price of that wall-clock hour on both occurrences.
 * - One other omitted interval per run (one dropped hour, the documented
 *   GE-Spot behaviour on incomplete source data) is bridged by carrying the
 *   previous price forward, with a warning, so a single missing hour costs
 *   neither the horizon nor an hour without a plan. A second one splits the
 *   run like a larger hole.
 * - A larger hole splits the feed into contiguous runs; a duplicate or
 *   overlapping timestamp (or an out-of-order one in a bare wall-clock feed)
 *   ends the feed. Prices are never shifted onto the wrong slots.
 *
 * A clean feed returns its single run unchanged, unless that run starts after
 * the current slot: then null, so the caller keeps the previously stored
 * prices instead of replacing them with a series the planner refuses. A
 * defective feed returns the run that covers the current slot, or null when no
 * run covers it.
 */
export function pricePointsToSeries(points: PriceSlot[], opts: PricePointsOptions): TimeSeries | null {
  const slotsPerPoint = opts.interval === 60 ? 4 : 1;
  const pointMs = slotsPerPoint * SLOT_MS;

  let defects = 0;
  /** Set when a point could not be placed: holes may hide it, so none is filled. */
  let unplaced = false;
  const skippedWallClock: unknown[] = [];
  /** price === null: a placed point without a usable price (ends the run there). */
  const parsed: Array<{ price: number | null; candidates: InstantCandidate[]; explicit: boolean }> = [];
  for (const point of points) {
    const rawPrice = parseStrictPrice(point?.[opts.valueKey]);
    const { candidates, explicit, nonexistent } = parseTimestamp(point?.[opts.timeKey]);
    if (nonexistent) {
      defects++;
      skippedWallClock.push(point?.[opts.timeKey]);
      continue;
    }
    if (candidates.length === 0) {
      defects++;
      unplaced = true;
      continue;
    }
    parsed.push({ price: rawPrice === null ? null : rawPrice * opts.multiplier, candidates, explicit });
  }
  if (skippedWallClock.length > 0) {
    console.warn('[ha-price] Dropped price points at wall-clock times the server time zone skips', skippedWallClock);
  }
  if (parsed.length > 0 && parsed.every(p => p.explicit)) {
    // Stable sort: equal timestamps keep feed order and are caught as duplicates.
    parsed.sort((a, b) => a.candidates[0].ms - b.candidates[0].ms);
  }

  const runs: Run[] = [];
  let run: Run | null = null;
  let lastMs: number | null = null;
  let lastOffsetMs = 0;

  for (const { price, candidates } of parsed) {
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

    if (price === null) {
      // The feed has this interval but no usable price for it: end the run
      // here instead of bridging it with a made-up price.
      defects++;
      run = null;
      lastMs = chosen.ms;
      lastOffsetMs = chosen.offsetMs;
      continue;
    }

    if (run && chosen.ms !== expectedMs) {
      const holeMs = chosen.ms - expectedMs;
      const holeSlots = holeMs / SLOT_MS;
      // lastMs is non-null whenever a run is open.
      const prevMs = lastMs!;
      const wallStepMs = (chosen.ms + chosen.offsetMs) - (prevMs + lastOffsetMs);
      const fillable = !unplaced && Number.isInteger(holeSlots) && holeSlots <= run.values.length;
      const isMergedFallBackHour = fillable
        && wallStepMs === pointMs
        && holeMs === lastOffsetMs - chosen.offsetMs
        && holeMs <= HOUR_MS;
      const hole = { from: new Date(expectedMs).toISOString(), to: new Date(chosen.ms).toISOString() };
      if (isMergedFallBackHour) {
        // The hole is one occurrence of the merged wall-clock hour. Usually
        // (Python fold=0, as GE-Spot stamps it) the merged entry carries the
        // first occurrence's offset and the hole is the second: repeat the
        // slots just covered. A feed stamped with the second occurrence's
        // offset leaves the first one open instead: fill it from the merged
        // entry's slots, which follow the hole. The offsets alone cannot tell
        // the two apart; the server time zone can when it agrees with the
        // feed's offsets (otherwise the fold=0 reading is kept).
        const tzAgrees = localOffsetMs(prevMs) === lastOffsetMs && localOffsetMs(chosen.ms) === chosen.offsetMs;
        const holeIsFirstOccurrence = tzAgrees
          && expectedMs + localOffsetMs(expectedMs) === chosen.ms + chosen.offsetMs;
        if (holeIsFirstOccurrence) {
          run.forwardFills.push({ index: run.values.length, count: holeSlots });
          for (let i = 0; i < holeSlots; i++) run.values.push(NaN);
        } else {
          run.values.push(...run.values.slice(-holeSlots));
        }
        console.log('[ha-price] Filled the repeated DST hour merged by the price feed', hole);
      } else if (fillable && holeMs <= pointMs && run.bridged < MAX_BRIDGED_PER_RUN) {
        run.bridged++;
        const previous = run.values[run.values.length - 1];
        for (let i = 0; i < holeSlots; i++) run.values.push(previous);
        console.warn('[ha-price] Price feed is missing one interval; carrying the previous price forward', hole);
      } else {
        defects++;
        run = null;
      }
    }

    if (!run) {
      run = { startMs: chosen.ms, values: [], forwardFills: [], bridged: 0 };
      runs.push(run);
    }
    for (let i = 0; i < slotsPerPoint; i++) run.values.push(price);
    lastMs = chosen.ms;
    lastOffsetMs = chosen.offsetMs;
  }

  for (const r of runs) finalizeRun(r);
  const usable = runs.filter(r => r.values.length > 0);

  const toSeries = (r: Run): TimeSeries => ({
    start: new Date(r.startMs).toISOString(),
    step: SLOT_MINUTES,
    values: r.values,
  });
  const describeRuns = () => usable.map(r => ({
    start: new Date(r.startMs).toISOString(),
    end: new Date(runEndMs(r)).toISOString(),
  }));

  if (usable.length === 0) {
    console.warn('[ha-price] No valid price points in the sensor attributes');
    return null;
  }

  // The planner's window starts at the current slot (config-builder).
  const windowStartMs = Math.floor(opts.nowMs / SLOT_MS) * SLOT_MS;

  if (defects === 0 && usable.length === 1) {
    const only = usable[0];
    if (only.startMs > windowStartMs) {
      // The planner refuses a price series that starts after its window; keep
      // the stored prices (which may still cover now) instead.
      console.warn('[ha-price] Price feed starts after the current slot; keeping previous prices', {
        now: new Date(windowStartMs).toISOString(),
        start: new Date(only.startMs).toISOString(),
      });
      return null;
    }
    return toSeries(only);
  }

  const current = usable.find(r => r.startMs <= windowStartMs && windowStartMs < runEndMs(r));
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

    // Combine today + tomorrow (tomorrow may be empty before ~14:00).
    // pricePointsToSeries sorts explicit-offset timestamps itself; for bare
    // wall-clock ones feed order is what resolves the repeated DST hour.
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
