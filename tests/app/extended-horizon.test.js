// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENDED_HORIZON_DEFAULTS,
  describeExtendedHorizonStatus,
  formatHorizonDay,
  formatHorizonInstant,
  updateExtendedHorizonUI,
} from '../../app/src/extended-horizon.js';
import { setDisplayTimeZone } from '../../app/src/time-zone.js';
import { getElements, wireGlobalInputs } from '../../app/src/ui-binding.js';
import { hydrateSettingsKeys, hydrateUI, snapshotUI, updateSummaryUI } from '../../app/src/state.js';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';

// Thu 15 Oct 2026 00:00 and Sun 18 Oct 2026 00:00, Europe/Amsterdam (CEST).
const FIRM_END_MS = Date.parse('2026-10-14T22:00:00Z');
const END_MS = Date.parse('2026-10-17T22:00:00Z');

const HORIZON = {
  mode: 'off',
  extraDays: 3,
  forecastUrl: 'https://epexpredictor.batzill.com',
  region: 'NL',
  importVat_percent: 21,
  riskMargin_cents_per_kWh: 1,
  refreshMinutes: 60,
};

const EXTENDED_INFO = {
  mode: 'on',
  firmEndMs: FIRM_END_MS,
  endMs: END_MS,
  extendedSlots: 288,
  fit: { a: 1.2149, b: 14.27, source: 'fresh' },
  status: 'extended',
};

const FIRM_ONLY_INFO = {
  mode: 'on',
  firmEndMs: FIRM_END_MS,
  endMs: FIRM_END_MS,
  extendedSlots: 0,
  status: 'firmOnly',
  reason: 'the price forecast is missing',
};

function loadPage() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  return getElements();
}

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

beforeEach(() => {
  setDisplayTimeZone('Europe/Amsterdam');
  updateExtendedHorizonUI(null, null); // forget the last plan's info
});

afterEach(() => {
  setDisplayTimeZone(undefined);
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('formatting', () => {
  it('names the day and the instant in the server zone', () => {
    expect(formatHorizonDay(END_MS - 1)).toBe('Sat 17 Oct');
    expect(formatHorizonInstant(FIRM_END_MS)).toBe('Thu 00:00');
  });
});

describe('describeExtendedHorizonStatus', () => {
  it('off and collect say what they do, whatever the last plan reported', () => {
    expect(describeExtendedHorizonStatus({ mode: 'off', info: EXTENDED_INFO })).toEqual({
      tone: 'neutral', text: 'Off: plans end where the published prices end',
    });
    expect(describeExtendedHorizonStatus({ mode: 'collect', info: EXTENDED_INFO })).toEqual({
      tone: 'neutral', text: 'Collecting forecasts only: plans are unchanged',
    });
    expect(describeExtendedHorizonStatus({ mode: undefined, info: null }).text).toMatch(/^Off/);
  });

  it('on without a plan status waits for the next plan', () => {
    expect(describeExtendedHorizonStatus({ mode: 'on', info: null })).toEqual({
      tone: 'neutral', text: 'On: the next plan shows how far it reaches',
    });
    expect(describeExtendedHorizonStatus({ mode: 'on', info: { mode: 'collect' } }).text).toMatch(/^On: the next plan/);
  });

  it('an extended plan names its end, the firm boundary and the fit', () => {
    expect(describeExtendedHorizonStatus({ mode: 'on', info: EXTENDED_INFO })).toEqual({
      tone: 'ok', text: 'Planning through Sat 17 Oct (forecast prices after Thu 00:00; fit a 1.21, b 14.3 c)',
    });
    const stored = { ...EXTENDED_INFO, fit: { a: 1.1, b: 12, source: 'stored' } };
    expect(describeExtendedHorizonStatus({ mode: 'on', info: stored }).text)
      .toBe('Planning through Sat 17 Oct (forecast prices after Thu 00:00; stored fit a 1.10, b 12.0 c)');
  });

  it('leaves out a missing or unusable fit', () => {
    const expected = 'Planning through Sat 17 Oct (forecast prices after Thu 00:00)';
    for (const fit of [undefined, null, { a: 1.2 }, { a: null, b: 1 }, { a: 'x', b: 1 }, { a: 1, b: Infinity }]) {
      expect(describeExtendedHorizonStatus({ mode: 'on', info: { ...EXTENDED_INFO, fit } }).text).toBe(expected);
    }
  });

  it('a firm-only plan warns with the reason', () => {
    expect(describeExtendedHorizonStatus({ mode: 'on', info: FIRM_ONLY_INFO })).toEqual({
      tone: 'warn', text: 'Published prices only: the price forecast is missing',
    });
    expect(describeExtendedHorizonStatus({ mode: 'on', info: { ...FIRM_ONLY_INFO, reason: '  ' } }).text)
      .toBe('Published prices only');
    expect(describeExtendedHorizonStatus({ mode: 'on', info: { ...FIRM_ONLY_INFO, reason: 42 } }).text)
      .toBe('Published prices only');
  });

  it('an "extended" status without a usable span is treated as firm-only', () => {
    for (const span of [
      { endMs: FIRM_END_MS },
      { endMs: FIRM_END_MS - 1 },
      { endMs: 'later' },
      { firmEndMs: undefined },
    ]) {
      expect(describeExtendedHorizonStatus({ mode: 'on', info: { ...EXTENDED_INFO, ...span } }).tone).toBe('warn');
    }
  });
});

describe('updateExtendedHorizonUI', () => {
  function makeEls() {
    const els = {
      extendedHorizonMode: document.createElement('select'),
      extendedHorizonStatus: document.createElement('p'),
    };
    for (const value of ['off', 'collect', 'on']) els.extendedHorizonMode.add(new Option(value, value));
    return els;
  }

  it('writes the status with its tone and keeps the last plan info for form changes', () => {
    const els = makeEls();
    els.extendedHorizonMode.value = 'on';
    updateExtendedHorizonUI(els, EXTENDED_INFO);
    expect(els.extendedHorizonStatus.textContent).toMatch(/^Planning through Sat 17 Oct/);
    expect(els.extendedHorizonStatus.className).toBe('text-xs font-medium text-emerald-600 dark:text-emerald-400');

    els.extendedHorizonMode.value = 'collect';
    updateExtendedHorizonUI(els);
    expect(els.extendedHorizonStatus.textContent).toBe('Collecting forecasts only: plans are unchanged');
    expect(els.extendedHorizonStatus.className).toBe('text-xs font-medium text-slate-600 dark:text-slate-400');

    els.extendedHorizonMode.value = 'on';
    updateExtendedHorizonUI(els);
    expect(els.extendedHorizonStatus.textContent).toMatch(/^Planning through/);

    updateExtendedHorizonUI(els, FIRM_ONLY_INFO);
    expect(els.extendedHorizonStatus.className).toContain('text-amber-600');

    updateExtendedHorizonUI(els, 'not an object');
    expect(els.extendedHorizonStatus.textContent).toBe('On: the next plan shows how far it reaches');
  });

  it('defaults to off without a mode control and does nothing without a status line', () => {
    const status = document.createElement('p');
    updateExtendedHorizonUI({ extendedHorizonStatus: status });
    expect(status.textContent).toMatch(/^Off/);
    expect(() => updateExtendedHorizonUI({}, EXTENDED_INFO)).not.toThrow();
    expect(() => updateExtendedHorizonUI(undefined)).not.toThrow();
  });
});

describe('multi-day horizon settings on the real page', () => {
  it('has the card controls, every one saving through data-settings-input', () => {
    const els = loadPage();
    for (const name of [
      'extendedHorizonMode', 'extendedHorizonExtraDays', 'extendedHorizonForecastUrl', 'extendedHorizonRegion',
      'extendedHorizonVat', 'extendedHorizonRiskMargin', 'extendedHorizonRefresh',
    ]) {
      expect(els[name], name).toBeTruthy();
      expect(els[name].hasAttribute('data-settings-input'), name).toBe(true);
    }
    expect(els.extendedHorizonStatus).toBeTruthy();
    expect([...els.extendedHorizonMode.options].map((o) => o.value)).toEqual(['off', 'collect', 'on']);
    // PRICE_FORECAST_REGIONS in lib/price-forecast.ts
    expect([...els.extendedHorizonRegion.options].map((o) => o.value)).toEqual([
      'DE', 'AT', 'BE', 'FR', 'NL', 'SE1', 'SE2', 'SE3', 'SE4', 'DK1', 'DK2', 'ES', 'PT',
    ]);
    // Fetch-only fields save without a re-solve; the rest change the plan.
    expect(els.extendedHorizonForecastUrl.hasAttribute('data-no-autosolve')).toBe(true);
    expect(els.extendedHorizonRegion.hasAttribute('data-no-autosolve')).toBe(true);
    expect(els.extendedHorizonRefresh.hasAttribute('data-no-autosolve')).toBe(true);
    expect(els.extendedHorizonMode.hasAttribute('data-no-autosolve')).toBe(false);
  });

  it('page defaults snapshot as the default block', () => {
    const els = loadPage();
    expect(snapshotUI(els).extendedHorizon).toEqual(HORIZON);
    expect(EXTENDED_HORIZON_DEFAULTS).toEqual(HORIZON);
  });

  it('hydrates the inputs and the status line from stored settings', () => {
    const els = loadPage();
    const stored = {
      mode: 'collect',
      extraDays: 2,
      forecastUrl: 'https://forecast.example',
      region: 'DE',
      importVat_percent: 19,
      riskMargin_cents_per_kWh: 0.5,
      refreshMinutes: 120,
    };
    hydrateUI(els, { extendedHorizon: stored });
    expect(snapshotUI(els).extendedHorizon).toEqual(stored);
    expect(els.extendedHorizonStatus.textContent).toBe('Collecting forecasts only: plans are unchanged');
  });

  it('a settings object without the block (or with part of it) shows the defaults', () => {
    const els = loadPage();
    els.extendedHorizonMode.value = 'on';
    els.extendedHorizonExtraDays.value = '4';
    els.extendedHorizonForecastUrl.value = 'https://old.example';
    hydrateUI(els, {});
    expect(snapshotUI(els).extendedHorizon).toEqual(HORIZON);

    hydrateUI(els, { extendedHorizon: { mode: 'on' } });
    expect(snapshotUI(els).extendedHorizon).toEqual({ ...HORIZON, mode: 'on' });
  });

  it('editing one field saves the complete block and re-solves', async () => {
    const els = loadPage();
    hydrateUI(els, { extendedHorizon: HORIZON });
    const { controller, saveConfig } = controllerFor(els);
    const onInput = vi.fn(() => controller.queuePersistSnapshot());
    wireGlobalInputs(els, { onInput, onRun: vi.fn(), updateTerminalCustomUI: () => {} });

    els.extendedHorizonRiskMargin.value = '2.5';
    els.extendedHorizonRiskMargin.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0]).toEqual({ extendedHorizon: { ...HORIZON, riskMargin_cents_per_kWh: 2.5 } });
    expect(onInput).toHaveBeenCalled();
  });

  it('editing the region saves the complete block without a re-solve, the URL trimmed', async () => {
    const els = loadPage();
    hydrateUI(els, { extendedHorizon: HORIZON });
    const { controller, saveConfig } = controllerFor(els);
    const onInput = vi.fn();
    wireGlobalInputs(els, { onInput, onSave: controller.queuePersistSnapshot, onRun: vi.fn(), updateTerminalCustomUI: () => {} });

    els.extendedHorizonForecastUrl.value = ' https://forecast.example ';
    els.extendedHorizonRegion.value = 'BE';
    els.extendedHorizonRegion.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0]).toEqual({
      extendedHorizon: { ...HORIZON, region: 'BE', forecastUrl: 'https://forecast.example' },
    });
    expect(onInput).not.toHaveBeenCalled();
  });

  it('the status follows the mode control and the plan summary', () => {
    const els = loadPage();
    hydrateUI(els, { extendedHorizon: { ...HORIZON, mode: 'on' } });
    wireGlobalInputs(els, {
      onInput: vi.fn(),
      onRun: vi.fn(),
      updateTerminalCustomUI: () => {},
      updateExtendedHorizonUI: () => updateExtendedHorizonUI(els),
    });
    expect(els.extendedHorizonStatus.textContent).toBe('On: the next plan shows how far it reaches');

    updateSummaryUI(els, { extendedHorizon: EXTENDED_INFO });
    expect(els.extendedHorizonStatus.textContent)
      .toBe('Planning through Sat 17 Oct (forecast prices after Thu 00:00; fit a 1.21, b 14.3 c)');

    els.extendedHorizonMode.value = 'collect';
    els.extendedHorizonMode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(els.extendedHorizonStatus.textContent).toBe('Collecting forecasts only: plans are unchanged');

    els.extendedHorizonMode.value = 'on';
    els.extendedHorizonMode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(els.extendedHorizonStatus.textContent).toMatch(/^Planning through/);

    // A summary without the block (a firm-only server, or mode off when solved).
    updateSummaryUI(els, {});
    expect(els.extendedHorizonStatus.textContent).toBe('On: the next plan shows how far it reaches');

    updateSummaryUI(els, { extendedHorizon: FIRM_ONLY_INFO });
    expect(els.extendedHorizonStatus.textContent).toBe('Published prices only: the price forecast is missing');

    // A failed run clears it.
    updateSummaryUI(els, null);
    expect(els.extendedHorizonStatus.textContent).toBe('On: the next plan shows how far it reaches');
  });

  it('rehydrating the block from a save response refreshes the status', () => {
    const els = loadPage();
    updateSummaryUI(els, { extendedHorizon: EXTENDED_INFO });
    expect(els.extendedHorizonStatus.textContent).toMatch(/^Off/);
    hydrateSettingsKeys(els, { extendedHorizon: { ...HORIZON, mode: 'on' } }, ['extendedHorizon']);
    expect(els.extendedHorizonMode.value).toBe('on');
    expect(els.extendedHorizonStatus.textContent).toMatch(/^Planning through Sat 17 Oct/);
  });

  it('wiring skips a missing mode control', () => {
    const update = vi.fn();
    wireGlobalInputs({}, { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: () => {}, updateExtendedHorizonUI: update });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
