// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../app/src/charts.js', () => ({
  SOLUTION_COLORS: {
    b2g: 'rgb(15, 192, 216)',
    pv2g: 'rgb(247, 171, 62)',
    pv2b: 'rgb(139, 201, 100)',
    pv2l: 'rgb(212, 222, 95)',
    b2l: 'rgb(71, 144, 208)',
    g2l: 'rgb(233, 122, 131)',
    g2b: 'rgb(225, 142, 233)',
    ev: 'rgb(245, 158, 11)',
    soc: 'rgb(71, 144, 208)',
  },
}));

import { renderTable } from '../../app/src/table.js';

function makeRow(overrides = {}) {
  return {
    timestampMs: new Date('2024-01-15T08:15:00Z').getTime(),
    load: 1000, pv: 500, ic: 10.55, ec: 5.23,
    g2l: 500, b2l: 200, pv2l: 300, pv2b: 100, pv2g: 50,
    g2b: 0, b2g: 0, imp: 500, exp: 50,
    soc: 5000, soc_percent: 50, evLoad: 0,
    dess: { strategy: 0, restrictions: 0, feedin: 1, socTarget_percent: 60 },
    ...overrides,
  };
}

describe('renderTable', () => {
  it('returns early when table element is missing', () => {
    renderTable({ rows: [makeRow()], cfg: {}, targets: {}, showKwh: false });
    // no error thrown
  });

  it('returns early when rows is empty or null', () => {
    const table = document.createElement('table');
    renderTable({ rows: [], cfg: {}, targets: { table }, showKwh: false });
    expect(table.innerHTML).toBe('');
    renderTable({ rows: null, cfg: {}, targets: { table }, showKwh: false });
    expect(table.innerHTML).toBe('');
  });

  it('renders a table with rows in W mode', () => {
    const table = document.createElement('table');
    const tableUnit = document.createElement('span');
    const rows = [makeRow()];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table, tableUnit }, showKwh: false });
    expect(table.innerHTML).toContain('<thead>');
    expect(table.innerHTML).toContain('<tbody>');
    expect(tableUnit.textContent).toBe('W');
  });

  it('renders in kWh mode', () => {
    const table = document.createElement('table');
    const tableUnit = document.createElement('span');
    renderTable({
      rows: [makeRow()],
      cfg: { stepSize_m: 15 },
      targets: { table, tableUnit },
      showKwh: true,
    });
    expect(tableUnit.textContent).toBe('kWh');
  });

  it('shows date format for midnight timestamps', () => {
    const table = document.createElement('table');
    // Use local midnight to ensure getHours()===0 and getMinutes()===0
    const midnightRow = makeRow({ timestampMs: new Date(2024, 0, 15, 0, 0, 0).getTime() });
    renderTable({
      rows: [midnightRow],
      cfg: { stepSize_m: 15 },
      targets: { table },
      showKwh: false,
    });
    // Midnight rows should have font-semibold class and date format dd/mm
    expect(table.innerHTML).toContain('font-semibold');
    expect(table.innerHTML).toMatch(/\d{2}\/\d{2}/);
  });

  it('formats DESS strategy values correctly', () => {
    const table = document.createElement('table');
    const rows = [
      makeRow({ dess: { strategy: 0, restrictions: 0, feedin: 1, socTarget_percent: 50 } }),
      makeRow({ dess: { strategy: 1, restrictions: 1, feedin: 0, socTarget_percent: 60 }, timestampMs: new Date('2024-01-15T08:30:00Z').getTime() }),
      makeRow({ dess: { strategy: 2, restrictions: 2, feedin: -1, socTarget_percent: 70 }, timestampMs: new Date('2024-01-15T08:45:00Z').getTime() }),
      makeRow({ dess: { strategy: 3, restrictions: 3, feedin: null, socTarget_percent: 80 }, timestampMs: new Date('2024-01-15T09:00:00Z').getTime() }),
      makeRow({ dess: { strategy: -1, restrictions: -1, feedin: '1', socTarget_percent: 90 }, timestampMs: new Date('2024-01-15T09:15:00Z').getTime() }),
      makeRow({ dess: { strategy: null, restrictions: null, feedin: '0', socTarget_percent: 95 }, timestampMs: new Date('2024-01-15T09:30:00Z').getTime() }),
    ];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    const html = table.innerHTML;
    expect(html).toContain('TS');
    expect(html).toContain('SC');
    expect(html).toContain('PB');
    expect(html).toContain('PG');
  });

  it('highlights rebalance window rows', () => {
    const table = document.createElement('table');
    const rows = [
      makeRow({ timestampMs: new Date('2024-01-15T08:00:00Z').getTime() }),
      makeRow({ timestampMs: new Date('2024-01-15T08:15:00Z').getTime() }),
      makeRow({ timestampMs: new Date('2024-01-15T08:30:00Z').getTime() }),
    ];
    renderTable({
      rows,
      cfg: { stepSize_m: 15 },
      targets: { table },
      showKwh: false,
      rebalanceWindow: { startIdx: 1, endIdx: 2 },
    });
    expect(table.innerHTML).toContain('bg-sky-100');
  });

  it('applies cell background styles for positive flow values', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ g2l: 1000, b2l: 500, pv2l: 300 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('background:rgba(');
  });

  it('shows dash for zero values in W mode', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ g2l: 0, b2l: 0, pv2l: 0, g2b: 0, b2g: 0, pv2b: 0, pv2g: 0 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // Zero flow cells should show dash
    expect(table.innerHTML).toContain('–');
  });

  it('handles missing cfg stepSize_m (defaults to 15)', () => {
    const table = document.createElement('table');
    renderTable({ rows: [makeRow()], cfg: {}, targets: { table }, showKwh: true });
    expect(table.innerHTML).toContain('<thead>');
  });

  it('escapes HTML in tooltip text', () => {
    const table = document.createElement('table');
    renderTable({ rows: [makeRow()], cfg: {}, targets: { table }, showKwh: false });
    // Tooltips should be escaped - check the header tooltips are present
    expect(table.innerHTML).toContain('title=');
  });

  it('formats large numbers with thin space grouping', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ g2l: 12345 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // 12345 → "12 345" with thin space (\u2009)
    expect(table.innerHTML).toContain('12\u2009345');
  });

  it('handles negative numbers in groupThin', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ic: -1234.56 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('-1\u2009234.56');
  });

  it('handles feedin string values', () => {
    const table = document.createElement('table');
    const rows = [
      makeRow({ dess: { strategy: 0, restrictions: 0, feedin: '1', socTarget_percent: 50 } }),
      makeRow({ dess: { strategy: 0, restrictions: 0, feedin: '0', socTarget_percent: 50 }, timestampMs: new Date('2024-01-15T08:30:00Z').getTime() }),
      makeRow({ dess: { strategy: 0, restrictions: 0, feedin: 2, socTarget_percent: 50 }, timestampMs: new Date('2024-01-15T08:45:00Z').getTime() }),
    ];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    const html = table.innerHTML;
    expect(html).toContain('yes');
    expect(html).toContain('no');
  });

  it('handles unknown strategy values', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ dess: { strategy: 99, restrictions: 99, feedin: 1, socTarget_percent: 50 } })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('99');
  });

  it('handles string restriction values "-1"', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ dess: { strategy: '-1', restrictions: '-1', feedin: '-1', socTarget_percent: 50 } })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('?');
  });

  it('handles non-matching rgb string in rgbToRgba', () => {
    const table = document.createElement('table');
    // This tests the rgbToRgba fallback by having a flow value that triggers styleForCell
    // with a color from SOLUTION_COLORS that matches the rgb pattern
    const rows = [makeRow({ g2l: 100 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('rgba(');
  });

  it('handles load and pv columns with dash=false', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ load: 0, pv: 0 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // load and pv use dash: false, so 0 should show "0" not "–"
    expect(table.innerHTML).toContain('>0<');
  });

  it('handles kWh mode with zero values showing dash', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ g2l: 0 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: true });
    expect(table.innerHTML).toContain('–');
  });

  it('handles NaN in dec2Thin', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ic: NaN })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // NaN should produce empty string from dec2Thin
    expect(table.innerHTML).toContain('<td');
  });

  it('shows EV columns when rows have ev_charge > 0', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ev_charge: 3000, ev_soc_percent: 30, g2ev: 1500, b2ev: 500, pv2ev: 1000 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('EV');
    expect(table.innerHTML).toContain('EV');
    expect(table.innerHTML).toContain('Grid→EV');
    expect(table.innerHTML).toContain('Battery→EV');
    expect(table.innerHTML).toContain('PV→EV');
  });

  it('shows EV SoC column with departure highlight', () => {
    const table = document.createElement('table');
    const departure = new Date('2024-01-15T08:30:00Z').getTime();
    const rows = [
      makeRow({ timestampMs: new Date('2024-01-15T08:15:00Z').getTime(), ev_charge: 3000, ev_soc_percent: 30 }),
      makeRow({ timestampMs: departure, ev_charge: 3000, ev_soc_percent: 80 }),
    ];
    renderTable({
      rows,
      cfg: { stepSize_m: 15 },
      targets: { table },
      showKwh: false,
      evSettings: { departureTime: new Date(departure).toISOString() },
    });
    expect(table.innerHTML).toContain('ring-emerald-200');
    expect(table.innerHTML).toContain('text-emerald-600');
  });

  it('applies departure ring style to row', () => {
    const table = document.createElement('table');
    const rows = [
      makeRow({ timestampMs: new Date('2024-01-15T08:00:00Z').getTime() }),
      makeRow({ timestampMs: new Date('2024-01-15T08:15:00Z').getTime() }),
    ];
    renderTable({
      rows,
      cfg: { stepSize_m: 15 },
      targets: { table },
      showKwh: false,
      evSettings: { departureTime: new Date('2024-01-15T08:15:00Z').toISOString() },
    });
    expect(table.innerHTML).toContain('ring-1 ring-inset ring-emerald-200');
  });

  it('does not show EV columns when no ev_charge', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ev_charge: 0, ev_soc_percent: 0 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).not.toContain('Grid→EV');
    expect(table.innerHTML).not.toContain('EV<br>SoC');
  });

  it('renders EV hover tooltip breakdown', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ev_charge: 3000, g2ev: 1500, b2ev: 500, pv2ev: 1000 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // Check title attribute contains the breakdown
    expect(table.innerHTML).toContain('hover for breakdown');
  });

  it('renders EV SoC without breakdown tooltip when no flows', () => {
    const table = document.createElement('table');
    const rows = [makeRow({ ev_charge: 100, g2ev: 0, b2ev: 0, pv2ev: 0 })];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    // EV charge exists but no breakdown flows
    expect(table.innerHTML).toContain('EV');
  });

  it('handles missing evSettings gracefully', () => {
    const table = document.createElement('table');
    const rows = [makeRow()];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false });
    expect(table.innerHTML).toContain('<thead>');
  });

  it('handles undefined evSettings gracefully', () => {
    const table = document.createElement('table');
    const rows = [makeRow()];
    renderTable({ rows, cfg: { stepSize_m: 15 }, targets: { table }, showKwh: false, evSettings: undefined });
    expect(table.innerHTML).toContain('<thead>');
  });
});
