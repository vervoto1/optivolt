// @vitest-environment jsdom
// The schedule table on a multi-day plan: forecast-priced rows show no DESS
// or PV-curtailment decision, the Σ row adds up the firm rows with forecast
// totals on a second line, and labels name the weekday past 24 hours.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderTable } from '../../app/src/table.js';
import { setDisplayTimeZone } from '../../app/src/time-zone.js';

const HOUR = 3_600_000;
// Tue 13 Oct 2026 22:00 CEST.
const T0 = Date.parse('2026-10-13T20:00:00Z');

function makeRow(i, overrides = {}) {
  return {
    timestampMs: T0 + i * HOUR,
    load: 1000, pv: 0, ic: 20, ec: 10,
    g2l: 1000, b2l: 0, pv2l: 0, pv2b: 0, pv2g: 0, pvCurtail: 0,
    g2b: 0, b2g: 0, imp: 1000, exp: 0,
    importCost_cents: 20, exportCost_cents: 0,
    soc: 5000, soc_percent: 50,
    dess: { strategy: 1, restrictions: 0, feedin: 1, socTarget_percent: 60 },
    pvControl: { disable: false, reason: 'ok' },
    ...overrides,
  };
}

const FORECAST = {
  priceForecast: true,
  ic: 30,
  importCost_cents: 30,
  ev_soc_percent: null,
  dess: { strategy: 'unknown', restrictions: 'unknown', feedin: -1, socTarget_percent: 0 },
  pvControl: null,
};

function render(rows, opts = {}) {
  const table = document.createElement('table');
  renderTable({ rows, cfg: { stepSize_m: 60 }, targets: { table }, showKwh: true, showDess: true, ...opts });
  return table;
}

function cellsByHeader(table, rowEl) {
  const headers = [...table.querySelectorAll('thead tr:first-child th')].map((th) => th.textContent);
  const cells = [...rowEl.querySelectorAll('td')];
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
}

beforeEach(() => setDisplayTimeZone('Europe/Amsterdam'));
afterEach(() => setDisplayTimeZone(undefined));

describe('renderTable with forecast-priced rows', () => {
  const rows = [
    makeRow(0),
    makeRow(1),
    makeRow(2, FORECAST),
    makeRow(3, FORECAST),
  ];

  it('shows an em dash in the DESS and PV-control columns of forecast rows only', () => {
    const table = render(rows);
    const body = [...table.querySelectorAll('tbody tr')];
    const firm = cellsByHeader(table, body[0]);
    expect(firm.DESSstrategy.textContent).toBe('SC');
    expect(firm['Restr.'].textContent).toBe('—'); // restriction 0 is "none", not a dash for forecast
    expect(firm['Feed-in'].textContent).toBe('yes');
    expect(firm['Soc→'].textContent).toBe('60%');
    expect(firm.PVctrl.textContent).toBe('on');

    const forecast = cellsByHeader(table, body[2]);
    for (const header of ['DESSstrategy', 'Restr.', 'Feed-in', 'Soc→', 'PVctrl']) {
      expect(forecast[header].textContent, header).toBe('—');
    }
    expect(forecast.DESSstrategy.getAttribute('title')).toBe('Forecast price: not sent to Victron');
    expect(forecast.PVctrl.getAttribute('title')).toBe('Forecast price: not sent to Victron');
  });

  it('marks forecast rows, with a dashed edge on the first one only', () => {
    const table = render(rows);
    const body = [...table.querySelectorAll('tbody tr')];
    expect(body.map((tr) => tr.hasAttribute('data-forecast'))).toEqual([false, false, true, true]);
    expect(body[2].className).toContain('border-dashed');
    expect(body[2].className).toContain('text-slate-500');
    expect(body[3].className).not.toContain('border-dashed');
    expect(body[0].className).not.toContain('text-slate-500');
  });

  it('the Σ row adds up the firm rows and a second Σ line the forecast rows', () => {
    const table = render(rows);
    const headRows = table.querySelectorAll('thead tr');
    expect(headRows).toHaveLength(3);
    const firmTotals = cellsByHeader(table, { querySelectorAll: () => headRows[1].querySelectorAll('th') });
    const forecastTotals = cellsByHeader(table, { querySelectorAll: () => headRows[2].querySelectorAll('th') });
    expect(firmTotals['Importcost'].textContent).toBe('40.00');
    expect(forecastTotals['Importcost'].textContent).toBe('60.00');
    expect(firmTotals['Exp.load'].textContent).toBe('2.00');
    expect(forecastTotals['Exp.load'].textContent).toBe('2.00');
    expect(headRows[1].querySelector('span[title]').getAttribute('title')).toBe('Column totals, published prices');
    expect(headRows[2].hasAttribute('data-forecast-totals')).toBe(true);
    expect(headRows[2].querySelector('span[title]').getAttribute('title')).toBe('Column totals, forecast prices');
  });

  it('a plan without forecast rows keeps the single Σ row over every row', () => {
    const table = render([makeRow(0), makeRow(1)]);
    const headRows = table.querySelectorAll('thead tr');
    expect(headRows).toHaveLength(2);
    expect(headRows[1].querySelector('span[title]').getAttribute('title')).toBe('Column totals');
    expect(table.querySelector('[data-forecast]')).toBeNull();
  });

  it('a null EV SoC on forecast rows shows a dash, not 0%', () => {
    const evRows = [
      makeRow(0, { ev_charge: 3000, ev_soc_percent: 40 }),
      makeRow(1, { ev_charge: 0, ev_soc_percent: 50 }),
      makeRow(2, { ...FORECAST, ev_charge: null }),
    ];
    const table = render(evRows);
    const body = [...table.querySelectorAll('tbody tr')];
    expect(cellsByHeader(table, body[1]).EVSoC.textContent).toBe('50%');
    expect(cellsByHeader(table, body[2]).EVSoC.textContent).toBe('–');
    expect(cellsByHeader(table, body[2]).EV.textContent).toBe('–');
  });
});

describe('renderTable time labels', () => {
  it('names the weekday on midnight rows and in every time tooltip past 24 hours', () => {
    const rows = Array.from({ length: 30 }, (_, i) => makeRow(i, i >= 26 ? FORECAST : {}));
    const table = render(rows);
    const timeCells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td'));
    expect(timeCells[0].textContent).toBe('22:00');
    expect(timeCells[0].getAttribute('title')).toBe('Tue 13/10 22:00');
    expect(timeCells[2].textContent).toBe('Wed 14/10');
    expect(timeCells[2].className).toContain('font-semibold');
    expect(timeCells[26].textContent).toBe('Thu 15/10');
    expect(timeCells[27].getAttribute('title')).toBe('Thu 15/10 01:00 · forecast price, not sent to Victron');
  });

  it('keeps plain labels and no tooltip within 24 hours, except to flag forecast rows', () => {
    const rows = Array.from({ length: 6 }, (_, i) => makeRow(i, i >= 5 ? FORECAST : {}));
    const table = render(rows);
    const timeCells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td'));
    expect(timeCells[2].textContent).toBe('14/10');
    expect(timeCells[2].className).toContain('font-semibold');
    expect(timeCells[0].hasAttribute('title')).toBe(false);
    expect(timeCells[5].getAttribute('title')).toBe('forecast price, not sent to Victron');
  });
});
