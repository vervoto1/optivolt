import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  extendByRepeatingLastDay,
  firstLpDifference,
  forecastFromResponse,
  gridToBatteryByDay,
  localDayKey,
  localLabel,
  localMidnightsBetween,
  netCostEuros,
  parseExtraDays,
  rebalanceStartFromColumns,
  settingsWithHorizon,
  sideBySideLines,
  socAt,
  withSyntheticTail,
} from '../../scripts/horizon-whatif-config.ts';
import { EXTENDED_HORIZON_DEFAULTS } from '../../api/services/settings-schema.ts';

const root = path.resolve(import.meta.dirname, '../..');
const defaults = JSON.parse(readFileSync(path.join(root, 'api/defaults/default-settings.json'), 'utf8'));
const HOUR = 3_600_000;
// Local (process time zone) instants, so the tests hold in any TZ.
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const row = (t, startMs, over = {}) => ({
  tIdx: t, timestampMs: startMs + t * 15 * 60_000, imp: 0, exp: 0, g2b: 0, soc_percent: 50, soc: 5000,
  importCost_cents: 0, exportCost_cents: 0, ...over,
});

describe('settingsWithHorizon', () => {
  it('forces the mode and keeps the stored fields, filling defaults for an old snapshot', () => {
    const stored = { ...defaults, extendedHorizon: { ...EXTENDED_HORIZON_DEFAULTS, riskMargin_cents_per_kWh: 2.5 } };
    expect(settingsWithHorizon(stored, 'on').extendedHorizon)
      .toEqual({ ...EXTENDED_HORIZON_DEFAULTS, riskMargin_cents_per_kWh: 2.5, mode: 'on' });
    expect(settingsWithHorizon(stored, 'on', 2).extendedHorizon.extraDays).toBe(2);
    expect(stored.extendedHorizon.mode).toBe('off'); // the snapshot is untouched

    const { extendedHorizon: _omit, ...old } = defaults;
    expect(settingsWithHorizon(old, 'off').extendedHorizon).toEqual({ ...EXTENDED_HORIZON_DEFAULTS, mode: 'off' });
  });
});

describe('parseExtraDays', () => {
  it('accepts 1–4 and rejects anything else', () => {
    expect(parseExtraDays(undefined)).toBeUndefined();
    expect(parseExtraDays('1')).toBe(1);
    expect(parseExtraDays('4')).toBe(4);
    for (const bad of ['0', '5', '2.5', 'x', '']) expect(() => parseExtraDays(bad)).toThrow(/--extra-days/);
  });
});

describe('forecastFromResponse', () => {
  const body = {
    prices: Array.from({ length: 8 }, (_, i) => ({ startsAt: new Date(Date.UTC(2026, 9, 12, 22) + i * 15 * 60_000).toISOString(), total: 10 + i })),
    knownUntil: '2026-10-12T22:45:00Z',
  };
  const fit = { a: 1.2, b: 14, n: 24, mad: 0.1, fittedAt: '2026-10-12T12:00:00Z' };

  it('stores the parsed feed as data.priceForecast, keeping a stored fit of the same region', () => {
    const stored = { fetchedAt: 'x', publishedEnd: 'x', region: 'NL', series: { start: 'x', step: 15, values: [] }, fit };
    const { forecast, truncated } = forecastFromResponse(body, { region: 'NL', fetchedAt: '2026-10-13T10:00:00.000Z', stored });
    expect(truncated).toBe(false);
    expect(forecast).toEqual({
      fetchedAt: '2026-10-13T10:00:00.000Z',
      publishedEnd: '2026-10-12T23:00:00.000Z',
      region: 'NL',
      series: { start: '2026-10-12T22:00:00.000Z', step: 15, values: [10, 11, 12, 13, 14, 15, 16, 17] },
      fit,
    });
  });

  it('drops a stored fit of another region and rejects a malformed response', () => {
    const stored = { region: 'BE', fit };
    expect(forecastFromResponse(body, { region: 'NL', fetchedAt: 'now', stored }).forecast).not.toHaveProperty('fit');
    expect(() => forecastFromResponse({ prices: [] }, { region: 'NL', fetchedAt: 'now' })).toThrow(/no prices/);
  });
});

describe('extendByRepeatingLastDay / withSyntheticTail', () => {
  const start = Date.UTC(2026, 9, 13, 0);
  const day = (offset) => Array.from({ length: 96 }, (_, i) => offset + i);
  const series = { start: new Date(start).toISOString(), step: 15, values: [...day(0), ...day(1000)] };

  it('repeats the last 24 h slot for slot up to the target', () => {
    const target = start + 2 * 24 * HOUR + 30 * 60_000 + 1; // 2 days + 2 slots + a fraction
    const { series: out, addedSlots } = extendByRepeatingLastDay(series, target);
    expect(addedSlots).toBe(3);
    expect(out.values.slice(192)).toEqual([1000, 1001, 1002]);
    const long = extendByRepeatingLastDay(series, start + 4 * 24 * HOUR).series;
    expect(long.values.slice(192, 288)).toEqual(day(1000));
    expect(long.values.slice(288)).toEqual(day(1000));
    expect(series.values).toHaveLength(192); // the input is untouched
  });

  it('leaves a series that already reaches the target alone, and refuses one shorter than a day', () => {
    expect(extendByRepeatingLastDay(series, start + HOUR)).toEqual({ series, addedSlots: 0 });
    const short = { start: series.start, step: 15, values: day(0).slice(0, 47) };
    expect(() => extendByRepeatingLastDay(short, start + 3 * 24 * HOUR, 'load')).toThrow(/load covers 11\.75 h/);
  });

  it('extends load and PV of a data snapshot and labels it synthetic', () => {
    const data = { load: series, pv: { ...series, values: series.values.map(v => v * 2) }, importPrice: series };
    const { data: out, notes } = withSyntheticTail(data, start + 3 * 24 * HOUR);
    expect(out.load.values).toHaveLength(288);
    expect(out.pv.values[200]).toBe(2 * 1008);
    expect(out.importPrice).toBe(series);
    expect(notes).toEqual([expect.stringMatching(/^SYNTHETIC: load extended by 96 slots/), expect.stringMatching(/^SYNTHETIC: pv/)]);
    expect(withSyntheticTail(data, start).notes[0]).toMatch(/already reaches/);
  });
});

describe('rebalanceStartFromColumns', () => {
  it('returns the start_balance_k that is 1', () => {
    expect(rebalanceStartFromColumns({ start_balance_0: { Primal: 0 }, start_balance_7: { Primal: 0.9999999 }, soc_7: { Primal: 1 } })).toBe(7);
    expect(rebalanceStartFromColumns({ start_balance_0: { Primal: 0 }, start_balance_x: { Primal: 1 } })).toBeUndefined();
    expect(rebalanceStartFromColumns(undefined)).toBeUndefined();
  });
});

describe('local days and midnights', () => {
  it('lists the local midnights after the start up to and including the end', () => {
    const start = local(2026, 10, 13, 12, 15);
    expect(localMidnightsBetween(start, local(2026, 10, 15))).toEqual([local(2026, 10, 14), local(2026, 10, 15)]);
    expect(localMidnightsBetween(start, local(2026, 10, 14) - 1)).toEqual([]);
    expect(localMidnightsBetween(local(2026, 10, 13), local(2026, 10, 14))).toEqual([local(2026, 10, 14)]);
  });

  it('formats local days and labels', () => {
    expect(localDayKey(local(2026, 10, 14, 23, 45))).toBe('2026-10-14');
    expect(localLabel(local(2026, 10, 14, 7, 5))).toBe('Wed 14 Oct 07:05');
    expect(localLabel(local(2026, 10, 14, 7, 5), false)).toBe('Wed 14 Oct');
  });

  it('reads the SoC at the end of the slot that ends at a midnight', () => {
    const start = local(2026, 10, 13, 23, 30);
    const rows = [row(0, start, { soc_percent: 40 }), row(1, start, { soc_percent: 41 }), row(2, start, { soc_percent: 42 })];
    expect(socAt(rows, 15, local(2026, 10, 14))).toBe(41);
    expect(socAt(rows, 15, local(2026, 10, 15))).toBeNull();
  });

  it('sums grid→battery per local day of the slot start', () => {
    const start = local(2026, 10, 13, 23, 45);
    const byDay = gridToBatteryByDay([row(0, start, { g2b: 4000 }), row(1, start, { g2b: 2000 }), row(2, start, { g2b: 2000 })], 15);
    expect([...byDay]).toEqual([['2026-10-13', 1], ['2026-10-14', 1]]);
  });
});

describe('netCostEuros', () => {
  it('sums import cost minus export revenue over a slot range', () => {
    const rows = [row(0, 0, { importCost_cents: 100 }), row(1, 0, { exportCost_cents: 30 }), row(2, 0, { importCost_cents: 50 })];
    expect(netCostEuros(rows)).toBeCloseTo(1.2, 9);
    expect(netCostEuros(rows, 0, 2)).toBeCloseTo(0.7, 9);
    expect(netCostEuros(rows, 2)).toBeCloseTo(0.5, 9);
  });
});

describe('firstLpDifference', () => {
  it('is null for identical LPs and locates the first differing character otherwise', () => {
    expect(firstLpDifference('a\nb', 'a\nb')).toBeNull();
    const longA = `x ${'+ 1 v '.repeat(50)}+ 2 w`;
    const longB = `x ${'+ 1 v '.repeat(50)}+ 3 w`;
    const diff = firstLpDifference(`min\n${longA}\nend`, `min\n${longB}\nend`, 10);
    expect(diff).toMatchObject({ line: 2, column: 305, linesA: 3, linesB: 3 });
    expect(diff.a).toBe('…v + 1 v + 2 w');
    expect(diff.b).toBe('…v + 1 v + 3 w');
  });

  it('reports a missing line as the end of the LP', () => {
    expect(firstLpDifference('a\nb', 'a')).toMatchObject({ line: 2, column: 1, a: 'b', b: '<end of LP>', linesA: 2, linesB: 1 });
  });
});

describe('sideBySideLines', () => {
  const start = local(2026, 10, 13, 23, 30);
  const firm = [row(0, start, { imp: 1000.4, soc_percent: 10 }), row(1, start, { exp: 2000, soc_percent: 5 })];
  const ext = [
    row(0, start, { imp: 1000, soc_percent: 10 }), row(1, start, { soc_percent: 12.5 }),
    row(2, start, { imp: 500, soc_percent: 13, priceForecast: true }),
  ];

  it('prints both plans per slot with the SoC difference and marks forecast rows', () => {
    const lines = sideBySideLines(firm, ext, 48);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/slot time\s+firm imp\s+exp\s+soc%\s+ext imp\s+exp\s+soc%\s+Δsoc/);
    expect(lines[1]).toMatch(/Tue 13 Oct 23:30\s+1000\s+0\s+10\.0\s+1000\s+0\s+10\.0\s+0\.0$/);
    expect(lines[2]).toMatch(/Tue 13 Oct 23:45\s+0\s+2000\s+5\.0\s+0\s+0\s+12\.5\s+7\.5$/);
    expect(lines[3]).toMatch(/Wed 14 Oct 00:00\s+500\s+0\s+13\.0\s+f$/);
  });

  it('prints the firm plan alone when there is no extended plan, and stops at the count', () => {
    const lines = sideBySideLines(firm, null, 1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toMatch(/ext/);
    expect(lines[1]).toMatch(/Tue 13 Oct 23:30\s+1000\s+0\s+10\.0$/);
  });
});

describe('horizon-whatif.ts CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/horizon-whatif.ts', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NOW: START_ISO },
  });
  const START_MS = local(2026, 10, 13);
  const START_ISO = new Date(START_MS).toISOString();
  const market = (i) => 8 + 6 * Math.sin(i / 12) + (i % 96 < 40 ? 4 : 0);

  function writeSnapshot(dir) {
    const data = JSON.parse(readFileSync(path.join(root, 'api/defaults/default-data.json'), 'utf8'));
    delete data.evLoad;
    for (const key of ['load', 'pv', 'importPrice', 'exportPrice']) data[key].start = START_ISO;
    data.importPrice.values = data.importPrice.values.map((_, i) => Math.round((1.21 * market(i) + 14) * 1e4) / 1e4);
    data.exportPrice.values = [...data.importPrice.values];
    data.soc.timestamp = START_ISO;
    const forecast = {
      prices: Array.from({ length: 3 * 96 }, (_, i) => ({ startsAt: new Date(START_MS + i * 15 * 60_000).toISOString(), total: market(i) })),
      knownUntil: new Date(START_MS + 95 * 15 * 60_000).toISOString(),
    };
    writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(defaults));
    writeFileSync(path.join(dir, 'forecast.json'), JSON.stringify(forecast));
    return (...names) => names.map(n => path.join(dir, n));
  }

  it('solves the firm-only and the extended plan, and reports a skipped extension', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'horizon-cli-'));
    try {
      const files = writeSnapshot(dir);
      const ext = run(...files('data.json', 'settings.json'), '--forecast', path.join(dir, 'forecast.json'), '--extra-days', '1', '--synthetic-tail');
      expect(ext.status, ext.stderr).toBe(0);
      // The tail emulates the predictors' window (tomorrow 24:00 + 1 day); the
      // extension ends at the firm end's midnight + 1 day.
      expect(ext.stdout).toMatch(/firm part: 96 slots to Wed 14 Oct 00:00; extended end Thu 15 Oct 00:00, load\/PV window to Fri 16 Oct 00:00/);
      expect(ext.stdout).toMatch(/SYNTHETIC: load extended by 192 slots/);
      expect(ext.stdout).toMatch(/extension: 96 firm \+ 96 forecast = 192 slots .*ended by window, SYNTHETIC/);
      expect(ext.stdout).toMatch(/import fit: a 1\.210, b 14\.00 c/);
      expect(ext.stdout).toMatch(/^firm-only\s+Optimal\s+96 slots/m);
      expect(ext.stdout).toMatch(/^extended\s+Optimal\s+192 slots/m);
      expect(ext.stdout).toMatch(/first 48 slots/);

      const skipped = run(...files('data.json', 'settings.json'), '--forecast', path.join(dir, 'forecast.json'));
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(skipped.stdout).toMatch(/extension SKIPPED \(noForecastSlots, ended by load\)/);

      const bad = run(...files('data.json', 'settings.json'), '--extra-days', '9');
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/--extra-days must be/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
