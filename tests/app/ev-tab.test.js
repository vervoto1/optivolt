// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/src/charts.js', () => ({
  SOLUTION_COLORS: {
    g2ev: 'rgb(185, 38, 55)',
    b2ev: 'rgb(20, 78, 160)',
    pv2ev: 'rgb(142, 158, 22)',
    ev_charge: 'rgb(16, 185, 129)',
    soc: 'rgb(71, 144, 208)',
  },
  toRGBA: (rgb, a) => rgb.replace('rgb', 'rgba').replace(')', `, ${a})`),
  drawEvPowerChart: vi.fn(),
  drawEvSocChartTab: vi.fn(),
}));

vi.mock('../../app/src/state.js', () => ({
  formatKWh: (v) => `${(Number(v) || 0).toFixed(2)} kWh`,
  updateStackedBarContainer: vi.fn(),
}));

import { updateEvPanel } from '../../app/src/ev-tab.js';
import { drawEvPowerChart, drawEvSocChartTab } from '../../app/src/charts.js';
import { updateStackedBarContainer } from '../../app/src/state.js';

function makeEls() {
  return {
    evNoCharging: document.createElement('div'),
    evChargingSummary: document.createElement('div'),
    evSocValue: { dataset: { haState: null } },
    evTabCurrentSocRow: document.createElement('div'),
    evTabCurrentSoc: document.createElement('span'),
    evTabPlugValue: { dataset: { haState: null } },
    evTabPlugRow: document.createElement('div'),
    evTabPlugStatus: document.createElement('span'),
    evTargetSoc: { value: '' },
    evDepartureTime: { value: '' },
    evTabGridKwh: document.createElement('span'),
    evTabPvKwh: document.createElement('span'),
    evTabBattKwh: document.createElement('span'),
    evTabTotalKwh: document.createElement('span'),
    evTabSplitBar: document.createElement('div'),
    evTabTotalCost: document.createElement('span'),
    evTabEffectiveRate: document.createElement('span'),
    evTabFreeSolar: document.createElement('span'),
    evTabModeRows: document.createElement('div'),
    evPowerChart: document.createElement('canvas'),
    evSocChartTab: document.createElement('canvas'),
    evScheduleTable: document.createElement('table'),
  };
}

describe('ev-tab.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('updateEvPanel -- no EV', () => {
    it('hides charging summary and shows no-charging when evTotal <= 0', () => {
      const els = makeEls();
      updateEvPanel(els, [], {});
      expect(els.evChargingSummary.classList.contains('hidden')).toBe(true);
      expect(els.evNoCharging.classList.contains('hidden')).toBe(false);
    });

    it('does not set kwh values when no EV', () => {
      const els = makeEls();
      updateEvPanel(els, [], {});
      expect(els.evTabGridKwh.textContent).toBe('');
      expect(els.evTabTotalCost.textContent).toBe('');
    });
  });

  describe('updateEvPanel -- with EV', () => {
    const rows = [
      { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, g2ev: 1500, b2ev: 500, pv2ev: 1000, ev_charge_mode: 'solar_grid', ic: 12 },
      { timestampMs: Date.now() + 900000, ev_soc_percent: 40, ev_charge: 3000, g2ev: 0, b2ev: 2000, pv2ev: 1000, ev_charge_mode: 'solar_only', ic: 10 },
      { timestampMs: Date.now() + 1800000, ev_soc_percent: 50, ev_charge: 3000, g2ev: 3000, b2ev: 0, pv2ev: 0, ev_charge_mode: 'max', ic: 8 },
    ];
    const summary = {
      evChargeTotal_kWh: 12.5,
      evChargeFromGrid_kWh: 4.5,
      evChargeFromPv_kWh: 3.0,
      evChargeFromBattery_kWh: 5.0,
    };

    it('shows charging summary and hides no-charging', () => {
      const els = makeEls();
      updateEvPanel(els, rows, summary);
      expect(els.evChargingSummary.classList.contains('hidden')).toBe(false);
      expect(els.evNoCharging.classList.contains('hidden')).toBe(true);
    });

    it('sets kwh values from summary', () => {
      const els = makeEls();
      updateEvPanel(els, rows, summary);
      expect(els.evTabGridKwh.textContent).toBe('4.50 kWh');
      expect(els.evTabPvKwh.textContent).toBe('3.00 kWh');
      expect(els.evTabBattKwh.textContent).toBe('5.00 kWh');
      expect(els.evTabTotalKwh.textContent).toBe('12.50 kWh');
    });

    it('sets cost and effective rate', () => {
      const els = makeEls();
      updateEvPanel(els, rows, summary);
      // row0: 1500 * 0.25 / 1000 * 12 = 4.5 cents
      // row2: 3000 * 0.25 / 1000 * 8 = 6.0 cents
      expect(els.evTabTotalCost.textContent).toContain('10.5');
      expect(els.evTabEffectiveRate.textContent).toContain('0.8'); // 10.5/12.5 ~ 0.84
    });

    it('shows free solar badge when pv > 0', () => {
      const els = makeEls();
      updateEvPanel(els, rows, summary);
      expect(els.evTabFreeSolar.textContent).toContain('3.00 kWh free');
      expect(els.evTabFreeSolar.className).toContain('text-emerald-600');
    });

    it('hides free solar badge when pv === 0', () => {
      const els = makeEls();
      const zeroPvSummary = { ...summary, evChargeFromPv_kWh: 0 };
      updateEvPanel(els, rows, zeroPvSummary);
      expect(els.evTabFreeSolar.textContent).toContain('0.00 kWh free');
      expect(els.evTabFreeSolar.className).not.toContain('text-emerald-600');
    });

    it('renders stacked bar with updateStackedBarContainer', () => {
      const els = makeEls();
      updateEvPanel(els, rows, summary);
      expect(updateStackedBarContainer).toHaveBeenCalledWith(
        els.evTabSplitBar,
        12.5,
        expect.arrayContaining([
          expect.objectContaining({ value: 4.5 }),
          expect.objectContaining({ value: 5.0 }),
          expect.objectContaining({ value: 3.0 }),
        ])
      );
    });
  });

  describe('updateEvPanel -- EV settings', () => {
    it('reads targetSoc and departureTime from DOM inputs', () => {
      const els = makeEls();
      els.evTargetSoc = { value: '80' };
      els.evDepartureTime = { value: '2024-01-15T08:00:00Z' };
      updateEvPanel(els, [], {});
      expect(drawEvSocChartTab).toHaveBeenCalledWith(
        els.evSocChartTab,
        [],
        expect.objectContaining({ targetSoc_percent: 80, departureTime: '2024-01-15T08:00:00Z' })
      );
    });

    it('handles null targetSoc (empty string)', () => {
      const els = makeEls();
      els.evTargetSoc = { value: '' };
      els.evDepartureTime = { value: '' };
      updateEvPanel(els, [], {});
      expect(drawEvSocChartTab).toHaveBeenCalledWith(
        els.evSocChartTab,
        [],
        expect.objectContaining({ targetSoc_percent: null, departureTime: null })
      );
    });
  });

  describe('updateEvPanel -- SOC and Plug display', () => {
    it('shows current SOC when evSocValue has haState', () => {
      const els = makeEls();
      els.evSocValue = { dataset: { haState: '42' } };
      els.evTabCurrentSocRow = document.createElement('div');
      els.evTabCurrentSoc = document.createElement('span');
      updateEvPanel(els, [], {});
      expect(els.evTabCurrentSocRow.classList.contains('hidden')).toBe(false);
      expect(els.evTabCurrentSoc.textContent).toBe('42%');
    });

    it('hides current SOC row when no haState', () => {
      const els = makeEls();
      els.evSocValue = { dataset: { haState: null } };
      els.evTabCurrentSocRow = document.createElement('div');
      updateEvPanel(els, [], {});
      expect(els.evTabCurrentSocRow.classList.contains('hidden')).toBe(true);
    });

    it('shows plug status when evPlugValue has haState on', () => {
      const els = makeEls();
      els.evTabPlugRow = document.createElement('div');
      els.evTabPlugStatus = document.createElement('span');
      els.evPlugValue = { dataset: { haState: 'on' } };
      updateEvPanel(els, [], {});
      expect(els.evTabPlugRow.classList.contains('hidden')).toBe(false);
      expect(els.evTabPlugStatus.textContent).toBe('Connected');
      expect(els.evTabPlugStatus.className).toContain('text-emerald-600');
    });

    it('shows Disconnected when plug is off', () => {
      const els = makeEls();
      els.evTabPlugRow = document.createElement('div');
      els.evTabPlugStatus = document.createElement('span');
      els.evPlugValue = { dataset: { haState: 'off' } };
      updateEvPanel(els, [], {});
      expect(els.evTabPlugStatus.textContent).toBe('Disconnected');
      expect(els.evTabPlugStatus.className).toContain('text-slate-400');
    });

    it('shows Connected when plug is true', () => {
      const els = makeEls();
      els.evTabPlugRow = document.createElement('div');
      els.evTabPlugStatus = document.createElement('span');
      els.evPlugValue = { dataset: { haState: 'true' } };
      updateEvPanel(els, [], {});
      expect(els.evTabPlugStatus.textContent).toBe('Connected');
    });

    it('hides plug row when no haState', () => {
      const els = makeEls();
      els.evTabPlugRow = document.createElement('div');
      els.evTabPlugStatus = document.createElement('span');
      els.evPlugValue = { dataset: { haState: null } };
      updateEvPanel(els, [], {});
      expect(els.evTabPlugRow.classList.contains('hidden')).toBe(true);
    });
  });

  describe('updateEvPanel -- missing elements', () => {
    it('handles all null els gracefully', () => {
      expect(() => updateEvPanel({}, [], {})).not.toThrow();
    });
  });

  describe('renderModeRows (via updateEvPanel)', () => {
    it('renders mode rows with counts when EV charging present', () => {
      const els = makeEls();
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_only', g2ev: 0, b2ev: 0, pv2ev: 1000, ic: 0 },
        { timestampMs: Date.now() + 900000, ev_soc_percent: 40, ev_charge: 3000, ev_charge_mode: 'solar_only', g2ev: 0, b2ev: 0, pv2ev: 1000, ic: 0 },
        { timestampMs: Date.now() + 1800000, ev_soc_percent: 50, ev_charge: 3000, ev_charge_mode: 'max', g2ev: 3000, b2ev: 0, pv2ev: 0, ic: 0 },
      ];
      updateEvPanel(els, rows, { evChargeTotal_kWh: 10 });
      expect(els.evTabModeRows.innerHTML).toContain('solar only');
      expect(els.evTabModeRows.innerHTML).toContain('max');
      expect(els.evTabModeRows.innerHTML).toContain('2'); // solar only count
      expect(els.evTabModeRows.innerHTML).toContain('1'); // max count
    });

    it('does not render mode rows when no EV', () => {
      const els = makeEls();
      updateEvPanel(els, [], {});
      // evTabModeRows is never touched when hasEv is false
      expect(els.evTabModeRows.innerHTML).toBe('');
    });

    it('handles null evTabModeRows gracefully', () => {
      const els = makeEls();
      delete els.evTabModeRows;
      const rows = [{ timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'max', ic: 0 }];
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      // Should not throw
    });
  });

  describe('renderEvTable (via updateEvPanel)', () => {
    it('renders empty message when no rows', () => {
      const els = makeEls();
      updateEvPanel(els, [], {});
      expect(els.evScheduleTable.innerHTML).toContain('No EV charging in current plan.');
    });

    it('renders table with EV columns when rows have ev_charge > 0', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 12 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      const html = els.evScheduleTable.innerHTML;
      expect(html).toContain('<thead>');
      expect(html).toContain('<tbody>');
      expect(html).toContain('Grid');
      expect(html).toContain('Batt');
      expect(html).toContain('Solar');
    });

    it('shows ready badge at departure time', () => {
      const departure = new Date(Date.now() + 1800000);
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 12 },
        { timestampMs: departure.getTime(), ev_soc_percent: 60, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 12 },
      ];
      const els = makeEls();
      els.evTargetSoc = { value: '80' };
      els.evDepartureTime = { value: departure.toISOString() };
      updateEvPanel(els, rows, { evChargeTotal_kWh: 2 });
      expect(els.evScheduleTable.innerHTML).toContain('ready');
    });

    it('shows Target column when targetSoc_percent is set', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 12 },
      ];
      const els = makeEls();
      els.evTargetSoc = { value: '80' };
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).toContain('Target');
    });

    it('does not show Target column when targetSoc_percent is null', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 12 },
      ];
      const els = makeEls();
      els.evTargetSoc = { value: '' };
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).not.toContain('Target');
    });

    it('renders mode badges correctly', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'fixed', g2ev: 0, b2ev: 3000, pv2ev: 0, ic: 10 },
        { timestampMs: Date.now() + 900000, ev_soc_percent: 40, ev_charge: 3000, ev_charge_mode: 'solar_only', g2ev: 0, b2ev: 0, pv2ev: 3000, ic: 0 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).toContain('fixed');
      expect(els.evScheduleTable.innerHTML).toContain('solar only');
    });

    it('renders totals row with column totals', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 1500, b2ev: 500, pv2ev: 1000, ic: 10 },
        { timestampMs: Date.now() + 900000, ev_soc_percent: 40, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 2000, b2ev: 0, pv2ev: 1000, ic: 12 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 3 });
      expect(els.evScheduleTable.innerHTML).toContain('Σ');
    });

    it('handles null table element', () => {
      const els = { evScheduleTable: null };
      const rows = [{ timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'max', ic: 0 }];
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      // Should not throw
    });

    it('renders mode column with solar_grid badge', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'solar_grid', g2ev: 0, b2ev: 0, pv2ev: 3000, ic: 0 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).toContain('solar+grid');
    });

    it('renders EV SoC values', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 45.7, ev_charge: 3000, ev_charge_mode: 'max', g2ev: 3000, b2ev: 0, pv2ev: 0, ic: 10 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).toContain('45.7%');
    });

    it('renders amp values with 1 decimal', () => {
      const rows = [
        { timestampMs: Date.now(), ev_soc_percent: 30, ev_charge: 3000, ev_charge_mode: 'max', ev_charge_A: 13.5, g2ev: 0, b2ev: 3000, pv2ev: 0, ic: 10 },
      ];
      const els = makeEls();
      updateEvPanel(els, rows, { evChargeTotal_kWh: 1 });
      expect(els.evScheduleTable.innerHTML).toContain('13.5');
    });
  });
});
