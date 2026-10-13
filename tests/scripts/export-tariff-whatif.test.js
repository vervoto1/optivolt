import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  marketSeriesFromEntity,
  settingsForMode,
  summarizeFlows,
  withInjectedMarketSource,
  WHATIF_MODES,
} from '../../scripts/export-tariff-whatif-config.ts';
import { EXPORT_TARIFF_DEFAULTS } from '../../api/services/settings-schema.ts';

const root = path.resolve(import.meta.dirname, '../..');
const defaults = JSON.parse(readFileSync(path.join(root, 'api/defaults/default-settings.json'), 'utf8'));
const START = '2026-12-31T12:00:00.000Z';
const START_MS = Date.parse(START);

/** GE-Spot-shaped hourly entity: `hours` points from START, value in EUR/kWh. */
function makeEntity(hours, value = (h) => 0.05 + h / 1000) {
  const points = Array.from({ length: hours }, (_, h) => ({
    time: new Date(START_MS + h * 3_600_000).toISOString().replace('.000Z', '+00:00'),
    value: value(h),
  }));
  return {
    entity_id: 'sensor.gespot_hourly_market_average_price_nl',
    state: '0.05',
    attributes: { today_hourly_prices: points.slice(0, 12), tomorrow_hourly_prices: points.slice(12), vat: '21.0%' },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('settingsForMode', () => {
  it('removes the block for "absent" and forces the mode otherwise, keeping the stored fields', () => {
    const stored = { ...defaults, exportTariff: { ...EXPORT_TARIFF_DEFAULTS, fee_cents_per_kWh: 1.5, terminalTail_h: 8 } };
    expect(WHATIF_MODES).toEqual(['absent', 'netMetering', 'marketPrice']);
    expect(settingsForMode(stored, 'absent')).not.toHaveProperty('exportTariff');
    expect(settingsForMode(stored, 'marketPrice').exportTariff)
      .toEqual({ ...EXPORT_TARIFF_DEFAULTS, mode: 'marketPrice', fee_cents_per_kWh: 1.5, terminalTail_h: 8 });
    expect(stored.exportTariff.mode).toBe('auto'); // the snapshot itself is untouched
  });

  it('fills the defaults into a snapshot taken before the block existed', () => {
    const { exportTariff: _omit, ...old } = defaults;
    expect(settingsForMode(old, 'netMetering').exportTariff).toEqual({ ...EXPORT_TARIFF_DEFAULTS, mode: 'netMetering' });
  });
});

describe('withInjectedMarketSource', () => {
  it('makes an injected series count as the market source, as API prices do', () => {
    const vrm = { ...defaults, dataSources: { ...defaults.dataSources, prices: 'vrm' } };
    const injected = withInjectedMarketSource(vrm);
    expect(injected.dataSources).toEqual({ ...vrm.dataSources, prices: 'api' });
    expect(vrm.dataSources.prices).toBe('vrm'); // the snapshot itself is untouched
  });
});

describe('marketSeriesFromEntity', () => {
  it('reads today + tomorrow with the haPriceConfig settings into a 15-minute c/kWh series', () => {
    const series = marketSeriesFromEntity(makeEntity(24), defaults, START_MS);
    expect(series.start).toBe(START);
    expect(series.step).toBe(15);
    expect(series.values).toHaveLength(96);
    expect(series.values.slice(0, 4)).toEqual([5, 5, 5, 5]);
    expect(series.values[4]).toBeCloseTo(5.1, 9);
  });

  it('accepts the bare attributes object and custom attribute names', () => {
    const { today_hourly_prices, tomorrow_hourly_prices } = makeEntity(24).attributes;
    const settings = { ...defaults, haPriceConfig: { ...defaults.haPriceConfig, todayAttribute: 'today', tomorrowAttribute: 'tomorrow', valueMultiplier: 1 } };
    const series = marketSeriesFromEntity({ today: today_hourly_prices, tomorrow: tomorrow_hourly_prices }, settings, START_MS);
    expect(series.values[0]).toBe(0.05);
  });

  it('falls back to the HA price defaults when the snapshot has no haPriceConfig', () => {
    const { haPriceConfig: _omit, ...settings } = defaults;
    expect(marketSeriesFromEntity(makeEntity(24), settings, START_MS).values).toHaveLength(96);
  });

  it('rejects a non-entity, an entity without points, and a feed that does not cover the plan start', () => {
    expect(() => marketSeriesFromEntity([], defaults, START_MS, 'm.json')).toThrow(/m\.json: not a Home Assistant entity/);
    expect(() => marketSeriesFromEntity({ attributes: {} }, defaults, START_MS)).toThrow(/no price points/);
    expect(() => marketSeriesFromEntity(makeEntity(24), defaults, START_MS + 2 * 86_400_000)).toThrow(/covers the plan start/);
  });
});

describe('summarizeFlows', () => {
  const row = (over) => ({ load: 0, pv: 0, evLoad: 0, g2l: 0, b2l: 0, pv2l: 0, g2b: 0, b2g: 0, pv2g: 0, pv2b: 0, imp: 0, exp: 0, ic: 0, ec: 0, soc_percent: 50, ...over });

  it('sums the compared flows in kWh and reports the final SoC and net grid cost', () => {
    const rows = [
      row({ g2b: 2000, imp: 2000, ic: 30, importCost_cents: 15 }),
      row({ pv2b: 1000, pv2g: 400, exp: 400, ec: 10, exportCost_cents: 1 }),
      row({ b2g: 4000, exp: 4000, ec: 20, exportCost_cents: 20, soc_percent: 42 }),
    ];
    expect(summarizeFlows(rows, 15)).toEqual({
      batteryToGrid_kWh: 1,
      pvToGrid_kWh: 0.1,
      pvToBattery_kWh: 0.25,
      gridToBattery_kWh: 0.5,
      finalSoc_percent: 42,
      netGridCost_cents: -6,
    });
  });

  it('reports an empty plan as zero flows and no final SoC', () => {
    expect(summarizeFlows([], 15)).toMatchObject({ batteryToGrid_kWh: 0, pvToBattery_kWh: 0, finalSoc_percent: NaN });
  });
});

describe('export-tariff-whatif.ts CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/export-tariff-whatif.ts', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' },
  });

  it('compares the three modes, and refuses a market run with fallback slots unless allowed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatif-cli-'));
    try {
      const data = JSON.parse(readFileSync(path.join(root, 'api/defaults/default-data.json'), 'utf8'));
      for (const key of ['load', 'pv', 'importPrice', 'exportPrice', 'evLoad']) data[key].start = START;
      data.soc.timestamp = START;
      writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(defaults));
      writeFileSync(path.join(dir, 'market.json'), JSON.stringify(makeEntity(24)));
      writeFileSync(path.join(dir, 'market-short.json'), JSON.stringify(makeEntity(12)));
      const files = (...names) => names.map(n => path.join(dir, n));

      const full = run(...files('data.json', 'settings.json'), '--market', path.join(dir, 'market.json'));
      expect(full.status, full.stderr).toBe(0);
      expect(full.stdout).toMatch(/netMetering LP is identical/);
      expect(full.stdout).toMatch(/96 market-priced slots, fallbackSlots 0 of 96/);
      for (const mode of WHATIF_MODES) expect(full.stdout).toMatch(new RegExp(`^${mode}\\s+Optimal`, 'm'));

      const short = run(...files('data.json', 'settings.json'), '--market', path.join(dir, 'market-short.json'));
      expect(short.status).toBe(1);
      expect(short.stderr).toMatch(/REFUSED/);

      const allowed = run(...files('data.json', 'settings.json'), '--market', path.join(dir, 'market-short.json'), '--allow-fallback');
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toMatch(/fallbackSlots 48 of 96/);

      // A series left in data.json under VRM prices is ignored, as the planner does.
      writeFileSync(path.join(dir, 'data-stale.json'), JSON.stringify({ ...data, marketPrice: { start: START, step: 15, values: [5] } }));
      const stale = run(...files('data-stale.json', 'settings.json'), '--allow-fallback');
      expect(stale.status, stale.stderr).toBe(0);
      expect(stale.stdout).toMatch(/market prices: data\.json marketPrice ignored \(no market source with vrm prices\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with the usage on a bad invocation', () => {
    expect(run().status).toBe(2);
    const unknown = run('a.json', 'b.json', '--bogus');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/usage:/);
  });
});
