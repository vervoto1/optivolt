import { describe, it, expect } from 'vitest';
import {
  computeDayMeanTemps,
  computeEffectiveDayTemps,
  buildTemperatureAnchors,
  buildAnchorsFromDaySummaries,
  generateTemperatureConfigs,
  predictHourFromAnchors,
  predictTemperatureLoad,
  predictTemperatureLoadRolling,
  summarizeTemperatureDays,
  temperaturePastDays,
  missingTemperatureDays,
  dayKey,
  dayStartMs,
  shiftDayKey,
  TEMPERATURE_GRID_BINS,
  TEMPERATURE_GRID_LOOKBACK_WEEKS,
} from '../../lib/load-predictor-temperature.ts';
import { OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA } from '../../lib/open-meteo.ts';

// Ported from upstream tests/lib/load-predictor-temperature.test.js (e318148),
// adapted to the fork's local-calendar day/hour keys. The suite runs with
// TZ=Europe/Amsterdam (vitest.config.js).

const HOUR_MS = 3600 * 1000;

function parts(dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return [y, m - 1, d];
}

/** Epoch ms of local clock hour `h` on `dayIso`. */
function localHourMs(dayIso, h) {
  const [y, m, d] = parts(dayIso);
  return new Date(y, m, d, h).getTime();
}

/** Hourly TemperatureRecords for one local day. */
function tempsForDay(dayIso, temp_C) {
  return Array.from({ length: 24 }, (_, h) => ({ time: localHourMs(dayIso, h), temp_C }));
}

/** Hourly StatRecords for one local day with value = profile(local hour). */
function loadForDay(dayIso, sensor, profile) {
  return Array.from({ length: 24 }, (_, h) => {
    const time = localHourMs(dayIso, h);
    const d = new Date(time);
    return { date: d.toISOString(), time, hour: d.getUTCHours(), dayOfWeek: d.getUTCDay(), sensor, value: profile(h) };
  });
}

/** N consecutive local days ending the day before `endExclusiveIso`. */
function dayRange(endExclusiveIso, n) {
  return Array.from({ length: n }, (_, i) => shiftDayKey(endExclusiveIso, n - i));
}

describe('local day keys', () => {
  it('keys a timestamp on its local calendar day, not its UTC day', () => {
    // 23:30 UTC on Jan 10 is 00:30 on Jan 11 in Amsterdam (UTC+1).
    expect(dayKey(Date.UTC(2026, 0, 10, 23, 30))).toBe('2026-01-11');
    expect(dayStartMs('2026-01-11')).toBe(Date.UTC(2026, 0, 10, 23));
  });

  it('steps calendar days across a DST switch', () => {
    expect(shiftDayKey('2026-10-26', 1)).toBe('2026-10-25');
    expect(shiftDayKey('2026-03-30', 2)).toBe('2026-03-28');
    expect(shiftDayKey('2026-01-01', 1)).toBe('2025-12-31');
  });
});

describe('computeDayMeanTemps / computeEffectiveDayTemps', () => {
  it('averages hourly temps per local day', () => {
    const temps = [...tempsForDay('2026-01-10', 4), ...tempsForDay('2026-01-11', 8)];
    const means = computeDayMeanTemps(temps);
    expect(means.get('2026-01-10')).toBe(4);
    expect(means.get('2026-01-11')).toBe(8);
  });

  it('leaves out days with too few hourly temperatures', () => {
    const partial = tempsForDay('2026-01-12', 20).slice(0, 10);
    const means = computeDayMeanTemps([...tempsForDay('2026-01-11', 8), ...partial]);
    expect(means.has('2026-01-12')).toBe(false);
    expect(means.get('2026-01-11')).toBe(8);
  });

  it('skips non-finite temperatures', () => {
    const temps = tempsForDay('2026-01-10', 4);
    temps.push({ time: localHourMs('2026-01-10', 5), temp_C: NaN });
    expect(computeDayMeanTemps(temps).get('2026-01-10')).toBe(4);
  });

  it('blends 4:2:1 over today, yesterday, and the day before', () => {
    const temps = [...tempsForDay('2026-01-10', 0), ...tempsForDay('2026-01-11', 7), ...tempsForDay('2026-01-12', 14)];
    const eff = computeEffectiveDayTemps(computeDayMeanTemps(temps));
    // (4*14 + 2*7 + 1*0) / 7 = 10
    expect(eff.get('2026-01-12')).toBeCloseTo(10, 10);
  });

  it('renormalizes when earlier days are missing', () => {
    const eff = computeEffectiveDayTemps(new Map([['2026-01-10', 6]]));
    expect(eff.get('2026-01-10')).toBe(6);
  });
});

describe('buildTemperatureAnchors', () => {
  // 16 days ending 2026-02-28 (now = 2026-03-01 10:00 local): first 8 cold
  // (2 °C, high load), last 8 warm (14 °C, low load). All within a 4-week lookback.
  const nowMs = localHourMs('2026-03-01', 10);
  const days = dayRange('2026-03-01', 16);
  const coldProfile = h => (h >= 6 && h < 22 ? 1200 : 50);
  const warmProfile = h => (h >= 6 && h < 22 ? 200 : 50);

  function makeInputs() {
    const data = [];
    const temps = [];
    days.forEach((day, i) => {
      const cold = i < 8;
      data.push(...loadForDay(day, 'Heat Pump', cold ? coldProfile : warmProfile));
      temps.push(...tempsForDay(day, cold ? 2 : 14));
    });
    return { data, effTemps: computeEffectiveDayTemps(computeDayMeanTemps(temps)) };
  }

  const cfg = { sensor: 'Heat Pump', lookbackWeeks: 4, dayFilter: 'all', bins: 2 };

  it('builds temperature-sorted anchors with median profiles per local hour', () => {
    const { data, effTemps } = makeInputs();
    const model = buildTemperatureAnchors(data, effTemps, cfg, nowMs);

    const anchors = model.buckets.get('all');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].temp_C).toBeLessThan(anchors[1].temp_C);
    expect(anchors[0].profile[12]).toBe(1200);
    expect(anchors[1].profile[12]).toBe(200);
    expect(anchors[0].profile[2]).toBe(50);
    expect(anchors[1].profile[2]).toBe(50);
    // Local 06:00 is the first high hour (05:00 UTC in winter).
    expect(anchors[0].profile[6]).toBe(1200);
    expect(anchors[0].profile[5]).toBe(50);
  });

  it('excludes today and days outside the lookback window', () => {
    const { data, effTemps } = makeInputs();
    const withToday = [...data, ...loadForDay('2026-03-01', 'Heat Pump', () => 99999)];
    const model = buildTemperatureAnchors(withToday, effTemps, { ...cfg, lookbackWeeks: 1 }, nowMs);

    // Only the 7 days before today fit in a 1-week lookback → a single anchor,
    // and today's absurd values must not appear in it.
    const anchors = model.buckets.get('all');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].dayCount).toBe(7);
    expect(anchors[0].profile[12]).toBe(200);
  });

  it('drops days with too few hourly readings', () => {
    const { data, effTemps } = makeInputs();
    const partial = loadForDay(shiftDayKey('2026-03-01', 17), 'Heat Pump', () => 5000).slice(0, 10);
    const model = buildTemperatureAnchors([...data, ...partial], effTemps, cfg, nowMs);
    for (const anchor of model.buckets.get('all')) {
      expect(anchor.profile[5]).not.toBe(5000);
    }
  });

  it('keeps weekday and weekend buckets separate and provides pooled anchors', () => {
    const { data, effTemps } = makeInputs();
    const model = buildTemperatureAnchors(data, effTemps, { ...cfg, dayFilter: 'weekday-weekend' }, nowMs);
    expect([...model.buckets.keys()].sort()).toEqual(['weekday', 'weekend']);
    expect(model.pooled.length).toBeGreaterThan(0);
  });

  it('returns no anchors when there are fewer days than one bin needs', () => {
    const { data, effTemps } = makeInputs();
    const summaries = summarizeTemperatureDays(data, 'Heat Pump', effTemps);
    // Cut off so only 3 days fit: too few for even one 4-day bin.
    const model = buildAnchorsFromDaySummaries(summaries, cfg, localHourMs(days[3], 0));
    expect(model.pooled).toEqual([]);
    expect(model.buckets.size).toBe(0);
  });
});

describe('summarizeTemperatureDays across DST', () => {
  it('averages the repeated hour of a fall-back day instead of summing it', () => {
    // 2026-10-25: 02:00-03:00 local happens twice (00:00 and 01:00 UTC).
    const start = Date.UTC(2026, 9, 24, 22); // local midnight, CEST
    const data = [];
    for (let i = 0; i < 25; i++) {
      const time = start + i * HOUR_MS;
      const d = new Date(time);
      data.push({ date: d.toISOString(), time, hour: d.getUTCHours(), dayOfWeek: d.getUTCDay(), sensor: 'L', value: 100 });
    }
    const days = summarizeTemperatureDays(data, 'L', new Map([['2026-10-25', 10]]));
    const day = days.get('2026-10-25');
    expect(day.hourCount).toBe(24);
    expect(day.hours[2]).toBe(100);
  });

  it('keeps a routine on its wall-clock hour after the clocks go back', () => {
    // Summer-time history: an evening peak at local 18:00 (16:00 UTC). After
    // the switch the same 18:00 peak is at 17:00 UTC; a UTC-hour model would
    // predict it an hour late.
    const peak = h => (h === 18 ? 3000 : 100);
    const history = dayRange('2026-10-25', 14).flatMap(day => loadForDay(day, 'L', peak));
    const effTemps = new Map([...dayRange('2026-10-28', 20).map(day => [day, 12])]);
    const model = buildTemperatureAnchors(history, effTemps, { sensor: 'L', lookbackWeeks: 3, dayFilter: 'all', bins: 2 }, localHourMs('2026-10-27', 9));

    const at = (h) => {
      const time = localHourMs('2026-10-27', h);
      const d = new Date(time);
      return { date: d.toISOString(), time, hour: d.getUTCHours(), dayOfWeek: d.getUTCDay(), value: null };
    };
    const [p17, p18] = predictTemperatureLoad(model, 'all', [at(17), at(18)], effTemps);
    expect(new Date(localHourMs('2026-10-27', 18)).getUTCHours()).toBe(17);
    expect(p18.predicted).toBe(3000);
    expect(p17.predicted).toBe(100);
  });
});

describe('predictHourFromAnchors', () => {
  const anchors = [
    { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
    { temp_C: 12, profile: Array(24).fill(200), dayCount: 5 },
  ];

  it('interpolates linearly between bracketing anchors', () => {
    expect(predictHourFromAnchors(anchors, 7, 10)).toBeCloseTo(600, 10);
  });

  it('extrapolates along the outermost segment for colder temperatures', () => {
    // slope = -80 W/°C; at -1 °C → 1000 + 3*80 = 1240
    expect(predictHourFromAnchors(anchors, -1, 10)).toBeCloseTo(1240, 10);
  });

  it('clamps extrapolation to half the anchor span', () => {
    // span 10 °C → clamp at 2 - 5 = -3 °C → 1000 + 5*80 = 1400, even at -30 °C
    expect(predictHourFromAnchors(anchors, -30, 10)).toBeCloseTo(1400, 10);
  });

  it('floors extrapolation at the lowest anchor value, not 0', () => {
    expect(predictHourFromAnchors(anchors, 30, 10)).toBe(200);
  });

  it('takes the floor over all hours, not just the predicted hour', () => {
    const profile = Array(24).fill(200);
    profile[3] = 50;
    const withNightIdle = [
      { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
      { temp_C: 12, profile, dayCount: 5 },
    ];
    expect(predictHourFromAnchors(withNightIdle, 30, 10)).toBe(50);
  });

  it('still floors at 0 when the lowest anchor value is 0', () => {
    const withIdleOff = [
      { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
      { temp_C: 12, profile: Array(24).fill(0), dayCount: 5 },
    ];
    expect(predictHourFromAnchors(withIdleOff, 30, 10)).toBe(0);
  });

  it('interpolates on the inner segment with three anchors', () => {
    const three = [
      { temp_C: 0, profile: Array(24).fill(1200), dayCount: 4 },
      { temp_C: 10, profile: Array(24).fill(600), dayCount: 4 },
      { temp_C: 20, profile: Array(24).fill(200), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(three, 15, 0)).toBeCloseTo(400, 10);
    expect(predictHourFromAnchors(three, 5, 0)).toBeCloseTo(900, 10);
  });

  it('returns the profile as-is for a single anchor', () => {
    expect(predictHourFromAnchors([anchors[0]], -5, 3)).toBe(1000);
  });

  it('averages instead of dividing when anchor temps nearly coincide', () => {
    const flat = [
      { temp_C: 10, profile: Array(24).fill(100), dayCount: 4 },
      { temp_C: 10.2, profile: Array(24).fill(300), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(flat, 10.1, 0)).toBe(200);
  });

  it('uses the observed side when one anchor lacks the hour', () => {
    const gap = [
      { temp_C: 2, profile: Array(24).fill(null), dayCount: 4 },
      { temp_C: 12, profile: Array(24).fill(300), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(gap, 5, 0)).toBe(300);
  });

  it('returns null when no anchors exist or the hour is unobserved', () => {
    expect(predictHourFromAnchors([], 5, 0)).toBeNull();
    const gappy = [
      { temp_C: 2, profile: Array(24).fill(null), dayCount: 4 },
      { temp_C: 12, profile: Array(24).fill(null), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(gappy, 5, 0)).toBeNull();
  });
});

describe('predictTemperatureLoad', () => {
  it('predicts targets from the matching bucket and reports actuals', () => {
    const model = {
      buckets: new Map([['all', [
        { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
        { temp_C: 12, profile: Array(24).fill(200), dayCount: 5 },
      ]]]),
      pooled: [],
    };
    const time = localHourMs('2026-04-02', 10);
    const effTemps = new Map([['2026-04-02', 7]]);
    const targets = [{ date: new Date(time).toISOString(), time, hour: 8, dayOfWeek: 4, value: 550 }];

    const [result] = predictTemperatureLoad(model, 'all', targets, effTemps);
    expect(result.predicted).toBeCloseTo(600, 10);
    expect(result.actual).toBe(550);
    expect(result.hour).toBe(8); // the target's own fields are passed through
  });

  it('falls back to pooled anchors when the target bucket has none', () => {
    const model = {
      buckets: new Map([['weekend', [{ temp_C: 5, profile: Array(24).fill(900), dayCount: 4 }]]]),
      pooled: [{ temp_C: 5, profile: Array(24).fill(400), dayCount: 8 }],
    };
    const time = localHourMs('2026-04-02', 10); // a Thursday
    const [result] = predictTemperatureLoad(model, 'weekday-weekend', [{ date: '', time, hour: 8, dayOfWeek: 4 }], new Map([['2026-04-02', 5]]));
    expect(result.predicted).toBe(400);
    expect(result.actual).toBeNull();
  });

  it('returns null predictions for days without a temperature', () => {
    const model = { buckets: new Map(), pooled: [] };
    const time = localHourMs('2026-04-02', 10);
    const targets = [{ date: new Date(time).toISOString(), time, hour: 8, dayOfWeek: 4, value: null }];
    const [result] = predictTemperatureLoad(model, 'all', targets, new Map());
    expect(result.predicted).toBeNull();
  });
});

describe('predictTemperatureLoadRolling', () => {
  it('predicts each day from only the history before it', () => {
    // 100 W through 2026-04-03, 500 W from 2026-04-04 on, constant temp.
    const cfg = { sensor: 'Heat Pump', lookbackWeeks: 1, dayFilter: 'all', bins: 4 };
    const days = dayRange('2026-04-10', 12); // 2026-03-29 .. 2026-04-09
    const data = days.flatMap(day => loadForDay(day, 'Heat Pump', () => (day < '2026-04-04' ? 100 : 500)));
    const effTemps = new Map(days.map(day => [day, 10]));

    const targetFor = day => data.find(d => dayKey(d.time) === day && new Date(d.time).getHours() === 12);
    const summaries = summarizeTemperatureDays(data, 'Heat Pump', effTemps);
    const results = predictTemperatureLoadRolling(summaries, cfg, [targetFor('2026-04-04'), targetFor('2026-04-09')], effTemps);

    // The first 500 W day is predicted from 100 W days only — its own values
    // never feed its anchors — while five days later the rolling lookback
    // has caught up with the new level.
    expect(results[0].predicted).toBe(100);
    expect(results[0].actual).toBe(500);
    expect(results[1].predicted).toBe(500);
  });
});

describe('grid and Open-Meteo window helpers', () => {
  it('generates lookback × day filter × bins configs per sensor', () => {
    const configs = generateTemperatureConfigs(['A', 'B']);
    expect(configs).toHaveLength(2 * TEMPERATURE_GRID_LOOKBACK_WEEKS.length * 4 * TEMPERATURE_GRID_BINS.length);
    expect(configs[0]).toEqual({ sensor: 'A', lookbackWeeks: 2, dayFilter: 'same', bins: 2 });
  });

  it('keeps the grid inside the past days Open-Meteo fills, for a 7-day comparison window', () => {
    const maxLookback = Math.max(...TEMPERATURE_GRID_LOOKBACK_WEEKS);
    // Window start can be up to 8 days back (just before UTC midnight).
    expect(temperaturePastDays(maxLookback, 8)).toBe(67);
    expect(temperaturePastDays(maxLookback, 8)).toBeLessThanOrEqual(OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA);
  });

  it('keeps the live predictor’s largest lookback inside those days with the recent week', () => {
    expect(temperaturePastDays(8, 7)).toBe(66);
    expect(temperaturePastDays(9, 7)).toBeGreaterThan(OPEN_METEO_TEMPERATURE_PAST_DAYS_WITH_DATA);
  });

  it('lists the days of a range that have no effective temperature', () => {
    const effTemps = new Map([['2026-03-01', 5], ['2026-03-03', 6], ['2026-03-04', 7]]);
    expect(missingTemperatureDays(effTemps, '2026-02-27', '2026-03-04'))
      .toEqual({ missing: ['2026-02-27', '2026-02-28', '2026-03-02'], total: 5 });
    expect(missingTemperatureDays(effTemps, '2026-03-03', '2026-03-05')).toEqual({ missing: [], total: 2 });
    expect(missingTemperatureDays(effTemps, '2026-03-05', '2026-03-05')).toEqual({ missing: [], total: 0 });
  });

  it('steps calendar days across a DST switch', () => {
    // 2026-03-29 is the spring-forward day in Europe/Amsterdam (the test TZ).
    const { total } = missingTemperatureDays(new Map(), '2026-03-28', '2026-03-31');
    expect(total).toBe(3);
  });
});
