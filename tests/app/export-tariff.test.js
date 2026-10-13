// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_TARIFF_DEFAULT_EFFECTIVE_FROM,
  describeExportTariffStatus,
  formatTariffInstant,
  parseEffectiveFromInput,
  updateExportTariffUI,
} from '../../app/src/export-tariff.js';
import { serverNowMs, syncServerClock } from '../../app/src/server-clock.js';
import { setDisplayTimeZone } from '../../app/src/time-zone.js';
import { getElements, wireGlobalInputs } from '../../app/src/ui-binding.js';
import { hydrateSettingsKeys, hydrateUI, snapshotUI } from '../../app/src/state.js';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';

const SWITCH_MS = Date.parse('2026-12-31T23:00:00Z'); // 2027-01-01 00:00 CET
const DAY_MS = 24 * 60 * 60 * 1000;

const TARIFF = {
  mode: 'auto',
  effectiveFrom: '2027-01-01T00:00:00+01:00',
  fee_cents_per_kWh: 0,
  negativePrice: 'floorZero',
  terminalSocValuation: 'tailMin',
  terminalTail_h: 6,
};

const HA_PRICE_CONFIG = {
  sensor: 'sensor.gespot_hourly_average_price_nl',
  todayAttribute: 'today_hourly_prices',
  tomorrowAttribute: 'tomorrow_hourly_prices',
  timeKey: 'time',
  valueKey: 'value',
  valueMultiplier: 100,
  importEqualsExport: true,
  priceInterval: 60,
  exportSensor: 'sensor.gespot_hourly_market_average_price_nl',
};

function loadPage() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  return getElements();
}

beforeEach(() => {
  setDisplayTimeZone('Europe/Amsterdam');
  syncServerClock(undefined);
});

afterEach(() => {
  setDisplayTimeZone(undefined);
  syncServerClock(undefined);
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('parseEffectiveFromInput', () => {
  it('accepts an ISO instant with Z or a ±hh:mm offset', () => {
    expect(parseEffectiveFromInput('2027-01-01T00:00:00+01:00')).toEqual({ ok: true, ms: SWITCH_MS });
    expect(parseEffectiveFromInput(' 2026-12-31T23:00Z ')).toEqual({ ok: true, ms: SWITCH_MS });
    expect(parseEffectiveFromInput('2026-12-31T18:00:00.000-05:00')).toEqual({ ok: true, ms: SWITCH_MS });
  });

  it('rejects a value without an offset, or no value', () => {
    expect(parseEffectiveFromInput('2027-01-01T00:00:00')).toEqual({ ok: false, error: expect.stringMatching(/explicit offset/) });
    expect(parseEffectiveFromInput(undefined)).toEqual({ ok: false, error: expect.stringMatching(/explicit offset/) });
  });

  it('rejects a date that does not exist', () => {
    expect(parseEffectiveFromInput('2027-02-30T00:00:00+01:00')).toEqual({ ok: false, error: 'is not a valid date-time' });
    expect(parseEffectiveFromInput('2027-13-01T00:00:00Z')).toEqual({ ok: false, error: 'is not a valid date-time' });
  });

  it('rejects an instant off the 15-minute grid in UTC', () => {
    expect(parseEffectiveFromInput('2027-01-01T00:10:00+01:00')).toEqual({
      ok: false, error: 'must fall on a 15-minute boundary in UTC',
    });
  });
});

describe('formatTariffInstant', () => {
  it('formats in the display (server) zone', () => {
    expect(formatTariffInstant(SWITCH_MS)).toBe('1 Jan 2027, 00:00');
    setDisplayTimeZone('UTC');
    expect(formatTariffInstant(SWITCH_MS)).toBe('31 Dec 2026, 23:00');
  });
});

describe('describeExportTariffStatus', () => {
  const base = {
    mode: 'auto',
    effectiveFrom: TARIFF.effectiveFrom,
    pricesSource: 'ha',
    exportSensor: 'sensor.market',
    nowMs: SWITCH_MS - DAY_MS,
  };

  it('auto with a market sensor: net metering until the switch, market price from then on', () => {
    expect(describeExportTariffStatus(base)).toEqual({ tone: 'neutral', text: 'Net metering active until 1 Jan 2027, 00:00' });
    expect(describeExportTariffStatus({ ...base, nowMs: SWITCH_MS })).toEqual({
      tone: 'ok', text: 'Market-price export active since 1 Jan 2027, 00:00',
    });
  });

  it('auto without a market sensor stays on net metering, warning from a week before the switch', () => {
    const noSensor = { ...base, exportSensor: '  ' };
    expect(describeExportTariffStatus({ ...noSensor, nowMs: SWITCH_MS - 8 * DAY_MS })).toEqual({
      tone: 'neutral', text: 'Net metering (no market-price sensor configured)',
    });
    expect(describeExportTariffStatus({ ...noSensor, nowMs: SWITCH_MS - 7 * DAY_MS })).toEqual({
      tone: 'warn', text: 'Net metering (no market-price sensor configured)',
    });
    expect(describeExportTariffStatus({ ...noSensor, exportSensor: undefined, effectiveFrom: 'bad' }).tone).toBe('neutral');
  });

  it('auto with VRM prices has no market-price source', () => {
    expect(describeExportTariffStatus({ ...base, pricesSource: 'vrm' })).toEqual({
      tone: 'warn', text: 'Net metering (no market-price source configured)',
    });
  });

  it('auto with API prices depends on a marketPrice series posted to /data, never claiming it is active', () => {
    expect(describeExportTariffStatus({ ...base, pricesSource: 'api' })).toEqual({
      tone: 'neutral', text: 'Net metering switches to market-price export at 1 Jan 2027, 00:00 only if marketPrice is posted to /data',
    });
    // Past the switch the server keeps net metering when nothing was posted, so no green "active".
    expect(describeExportTariffStatus({ ...base, pricesSource: 'api', nowMs: SWITCH_MS })).toEqual({
      tone: 'neutral', text: 'Net metering switched to market-price export at 1 Jan 2027, 00:00 only if marketPrice is posted to /data',
    });
  });

  it('auto with an invalid end time reports it', () => {
    expect(describeExportTariffStatus({ ...base, effectiveFrom: '2027-01-01' })).toEqual({
      tone: 'error', text: expect.stringMatching(/^End time must be an ISO date-time/),
    });
  });

  it('net metering mode ignores the date and the source', () => {
    expect(describeExportTariffStatus({ ...base, mode: 'netMetering', nowMs: SWITCH_MS + DAY_MS })).toEqual({
      tone: 'neutral', text: 'Net metering: export valued at the import price',
    });
  });

  it('market price mode applies now, and warns without a source', () => {
    expect(describeExportTariffStatus({ ...base, mode: 'marketPrice' })).toEqual({ tone: 'ok', text: 'Market-price export active' });
    expect(describeExportTariffStatus({ ...base, mode: 'marketPrice', pricesSource: 'api' })).toEqual({
      tone: 'neutral', text: 'Market-price export from the marketPrice posted to /data (export valued at 0 without one)',
    });
    // VRM cannot supply market prices, even with a series left in data.json.
    expect(describeExportTariffStatus({ ...base, mode: 'marketPrice', pricesSource: 'vrm' }).tone).toBe('warn');
    expect(describeExportTariffStatus({ ...base, mode: 'marketPrice', exportSensor: '' })).toEqual({
      tone: 'warn', text: 'Market-price export, but no market-price source is configured: export valued at 0',
    });
  });
});

describe('updateExportTariffUI', () => {
  function makeEls() {
    const el = (tag) => document.createElement(tag);
    const els = {
      exportTariffMode: el('select'),
      exportTariffEffectiveFrom: el('input'),
      exportTariffEffectiveFromHint: el('span'),
      exportTariffTerminal: el('select'),
      exportTariffTail: el('input'),
      exportTariffStatus: el('p'),
      sourcePrices: el('select'),
      haPriceExportSensor: el('input'),
    };
    for (const [select, values] of [
      [els.exportTariffMode, ['auto', 'netMetering', 'marketPrice']],
      [els.exportTariffTerminal, ['tailMin', 'zero', 'custom']],
      [els.sourcePrices, ['vrm', 'api', 'ha']],
    ]) {
      for (const value of values) select.add(new Option(value, value));
    }
    els.exportTariffEffectiveFrom.value = TARIFF.effectiveFrom;
    els.sourcePrices.value = 'ha';
    els.haPriceExportSensor.value = 'sensor.market';
    return els;
  }

  it('shows the switch instant in the server zone and the status at the given time', () => {
    const els = makeEls();
    updateExportTariffUI(els, SWITCH_MS - DAY_MS);
    expect(els.exportTariffEffectiveFromHint.textContent).toBe('1 Jan 2027, 00:00 (Europe/Amsterdam)');
    expect(els.exportTariffEffectiveFromHint.className).toContain('text-slate-600');
    expect(els.exportTariffStatus.textContent).toBe('Net metering active until 1 Jan 2027, 00:00');
    expect(els.exportTariffStatus.className).toBe('text-xs font-medium text-slate-600 dark:text-slate-400');
    expect(els.exportTariffTail.disabled).toBe(false);
  });

  it('uses the server clock by default', () => {
    const els = makeEls();
    syncServerClock(new Date(SWITCH_MS + DAY_MS).toUTCString(), Date.now());
    updateExportTariffUI(els);
    expect(els.exportTariffStatus.textContent).toBe('Market-price export active since 1 Jan 2027, 00:00');
    expect(els.exportTariffStatus.className).toContain('text-emerald-600');
  });

  it('flags an invalid end time and disables tail hours for other valuations', () => {
    const els = makeEls();
    els.exportTariffEffectiveFrom.value = '2027-01-01T00:00';
    els.exportTariffTerminal.value = 'custom';
    updateExportTariffUI(els, SWITCH_MS);
    expect(els.exportTariffEffectiveFromHint.textContent).toMatch(/^End time must be an ISO date-time/);
    expect(els.exportTariffEffectiveFromHint.className).toContain('text-red-600');
    expect(els.exportTariffStatus.className).toContain('text-red-600');
    expect(els.exportTariffTail.disabled).toBe(true);
  });

  it('labels the zone as browser time when the server zone is unknown', () => {
    setDisplayTimeZone(undefined);
    const els = makeEls();
    updateExportTariffUI(els, SWITCH_MS);
    expect(els.exportTariffEffectiveFromHint.textContent).toMatch(/\(browser time\)$/);
  });

  it('falls back to the defaults for missing controls', () => {
    expect(() => updateExportTariffUI({})).not.toThrow();
    const status = document.createElement('p');
    const tail = document.createElement('input');
    updateExportTariffUI({ exportTariffStatus: status, exportTariffTail: tail }, SWITCH_MS - DAY_MS);
    // No price source control: there is no market-price source.
    expect(status.textContent).toBe('Net metering (no market-price source configured)');
    expect(tail.disabled).toBe(false);
  });
});

describe('server clock', () => {
  it('takes the offset from a Date header, using the middle of its second', () => {
    const received = Date.parse('2026-10-13T10:00:00.000Z');
    expect(syncServerClock('Tue, 13 Oct 2026 10:01:00 GMT', received)).toBe(60_500);
    expect(serverNowMs(received)).toBe(received + 60_500);
    expect(serverNowMs()).toBeGreaterThan(Date.now());
  });

  it('falls back to the browser clock without a usable header', () => {
    syncServerClock('Tue, 13 Oct 2026 10:01:00 GMT', 0);
    expect(syncServerClock('not a date')).toBe(0);
    syncServerClock('Tue, 13 Oct 2026 10:01:00 GMT', 0);
    expect(syncServerClock(null)).toBe(0);
    expect(serverNowMs(1234)).toBe(1234);
  });
});

describe('export tariff settings on the real page', () => {
  function controllerFor(els) {
    const saveConfig = vi.fn(async (patch) => ({ settings: patch }));
    const controller = createOptimizerController({
      els,
      services: {
        debounce: (fn) => Object.assign((...args) => fn(...args), { cancel() {} }),
        saveConfig,
        requestRemoteSolve: vi.fn().mockResolvedValue({ rows: [], summary: {} }),
      },
    });
    controller.trackSettingsEdits(document);
    return { controller, saveConfig };
  }

  it('has the card controls and the export sensor input', () => {
    const els = loadPage();
    for (const name of [
      'haPriceExportSensor', 'exportTariffMode', 'exportTariffEffectiveFrom', 'exportTariffEffectiveFromHint',
      'exportTariffFee', 'exportTariffNegativePrice', 'exportTariffTerminal', 'exportTariffTail', 'exportTariffStatus',
    ]) {
      expect(els[name], name).toBeTruthy();
    }
    expect([...els.exportTariffTerminal.options].map((o) => o.value)).toEqual(['tailMin', 'zero', 'min', 'avg', 'max', 'custom']);
  });

  it('page defaults snapshot as the default block', () => {
    const els = loadPage();
    expect(snapshotUI(els).exportTariff).toEqual(TARIFF);
    expect(snapshotUI(els).haPriceConfig.exportSensor).toBe('');
  });

  it('hydrates the inputs and the status line from stored settings', () => {
    const els = loadPage();
    hydrateUI(els, {
      dataSources: { prices: 'ha', load: 'vrm', pv: 'vrm', soc: 'mqtt' },
      haPriceConfig: HA_PRICE_CONFIG,
      exportTariff: {
        mode: 'marketPrice',
        effectiveFrom: '2026-12-01T00:00:00Z',
        fee_cents_per_kWh: 1.5,
        negativePrice: 'passThrough',
        terminalSocValuation: 'avg',
        terminalTail_h: 4,
      },
    });
    expect(els.haPriceExportSensor.value).toBe('sensor.gespot_hourly_market_average_price_nl');
    expect(els.exportTariffMode.value).toBe('marketPrice');
    expect(els.exportTariffEffectiveFrom.value).toBe('2026-12-01T00:00:00Z');
    expect(els.exportTariffFee.value).toBe('1.5');
    expect(els.exportTariffNegativePrice.value).toBe('passThrough');
    expect(els.exportTariffTerminal.value).toBe('avg');
    expect(els.exportTariffTail.value).toBe('4');
    expect(els.exportTariffTail.disabled).toBe(true);
    expect(els.exportTariffEffectiveFromHint.textContent).toBe('1 Dec 2026, 01:00 (Europe/Amsterdam)');
    expect(els.exportTariffStatus.textContent).toBe('Market-price export active');
  });

  it('a settings object without the block shows the defaults', () => {
    const els = loadPage();
    els.exportTariffMode.value = 'netMetering';
    els.exportTariffEffectiveFrom.value = 'x';
    els.exportTariffTail.value = '9';
    els.haPriceExportSensor.value = 'sensor.old';
    hydrateUI(els, { haPriceConfig: { sensor: 'sensor.price' } });
    expect(snapshotUI(els).exportTariff).toEqual(TARIFF);
    expect(els.haPriceExportSensor.value).toBe('');
    expect(els.exportTariffEffectiveFrom.value).toBe(EXPORT_TARIFF_DEFAULT_EFFECTIVE_FROM);
  });

  it('editing one tariff field saves the complete block and re-solves', async () => {
    const els = loadPage();
    hydrateUI(els, { exportTariff: TARIFF });
    const { controller, saveConfig } = controllerFor(els);
    const onInput = vi.fn(() => controller.queuePersistSnapshot());
    wireGlobalInputs(els, { onInput, onRun: vi.fn(), updateTerminalCustomUI: () => {} });

    els.exportTariffFee.value = '0.75';
    els.exportTariffFee.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0]).toEqual({ exportTariff: { ...TARIFF, fee_cents_per_kWh: 0.75 } });
    expect(onInput).toHaveBeenCalled(); // tariff fields change the plan
  });

  it('the effective-from value is sent trimmed', async () => {
    const els = loadPage();
    const { controller, saveConfig } = controllerFor(els);
    wireGlobalInputs(els, { onInput: controller.queuePersistSnapshot, onRun: vi.fn(), updateTerminalCustomUI: () => {} });

    els.exportTariffEffectiveFrom.value = ' 2026-12-15T00:00:00+01:00 ';
    els.exportTariffEffectiveFrom.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0].exportTariff.effectiveFrom).toBe('2026-12-15T00:00:00+01:00');
  });

  it('editing the export sensor saves the complete haPriceConfig without a re-solve', async () => {
    const els = loadPage();
    hydrateUI(els, { haPriceConfig: { ...HA_PRICE_CONFIG, exportSensor: '' } });
    const { controller, saveConfig } = controllerFor(els);
    const onInput = vi.fn();
    wireGlobalInputs(els, { onInput, onSave: controller.queuePersistSnapshot, onRun: vi.fn(), updateTerminalCustomUI: () => {} });

    els.haPriceExportSensor.value = 'sensor.market';
    els.haPriceExportSensor.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0]).toEqual({ haPriceConfig: { ...HA_PRICE_CONFIG, exportSensor: 'sensor.market' } });
    expect(onInput).not.toHaveBeenCalled(); // data-no-autosolve
  });

  it('the status follows the controls it depends on', () => {
    const els = loadPage();
    hydrateUI(els, {
      dataSources: { prices: 'ha', load: 'vrm', pv: 'vrm', soc: 'mqtt' },
      haPriceConfig: { ...HA_PRICE_CONFIG, exportSensor: '' },
      exportTariff: TARIFF,
    });
    wireGlobalInputs(els, {
      onInput: vi.fn(),
      onRun: vi.fn(),
      updateTerminalCustomUI: () => {},
      updateExportTariffUI: () => updateExportTariffUI(els, SWITCH_MS - DAY_MS),
    });
    expect(els.exportTariffStatus.textContent).toBe('Net metering (no market-price sensor configured)');

    els.haPriceExportSensor.value = 'sensor.market';
    els.haPriceExportSensor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(els.exportTariffStatus.textContent).toBe('Net metering active until 1 Jan 2027, 00:00');

    els.exportTariffMode.value = 'netMetering';
    els.exportTariffMode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(els.exportTariffStatus.textContent).toBe('Net metering: export valued at the import price');

    els.exportTariffTerminal.value = 'zero';
    els.exportTariffTerminal.dispatchEvent(new Event('change', { bubbles: true }));
    expect(els.exportTariffTail.disabled).toBe(true);

    els.sourcePrices.value = 'vrm';
    els.exportTariffMode.value = 'auto';
    els.sourcePrices.dispatchEvent(new Event('change', { bubbles: true }));
    expect(els.exportTariffStatus.textContent).toBe('Net metering (no market-price source configured)');

    els.exportTariffEffectiveFrom.value = 'soon';
    els.exportTariffEffectiveFrom.dispatchEvent(new Event('input', { bubbles: true }));
    expect(els.exportTariffEffectiveFromHint.textContent).toMatch(/^End time must be/);
  });

  it('wiring skips tariff controls that are not on the page', () => {
    const update = vi.fn();
    const sourcePrices = document.createElement('select');
    wireGlobalInputs({ sourcePrices }, { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: () => {}, updateExportTariffUI: update });
    expect(update).toHaveBeenCalledTimes(1);
    sourcePrices.dispatchEvent(new Event('change'));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('a partial rehydrate refreshes the status against the whole form', () => {
    const els = loadPage();
    hydrateUI(els, {
      dataSources: { prices: 'ha', load: 'vrm', pv: 'vrm', soc: 'mqtt' },
      haPriceConfig: { ...HA_PRICE_CONFIG, exportSensor: '' },
      exportTariff: TARIFF,
    });
    expect(els.exportTariffStatus.textContent).toBe('Net metering (no market-price sensor configured)');
    hydrateSettingsKeys(els, { haPriceConfig: HA_PRICE_CONFIG }, ['haPriceConfig']);
    expect(els.haPriceExportSensor.value).toBe(HA_PRICE_CONFIG.exportSensor);
    expect(els.exportTariffStatus.textContent).not.toMatch(/no market-price/);
  });
});
