// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';

function checkbox(checked = false) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  return input;
}

function input(value = '') {
  const element = document.createElement('input');
  element.value = value;
  return element;
}

function immediateDebounce(fn) {
  const debounced = vi.fn((...args) => fn(...args));
  debounced.cancel = vi.fn();
  return debounced;
}

function setupController() {
  const rows = [{ tIdx: 0, timestampMs: 1714586400000, soc_percent: 55 }];
  const rebalanceWindow = { startIdx: 0, endIdx: 0 };
  const summary = { netGridCost_cents: 12.5 };
  const els = {
    cap: input('9000'),
    evDepartureTime: input('2026-05-01T18:30'),
    evEnabled: checkbox(true),
    evTargetSoc: input('80'),
    flows: document.createElement('canvas'),
    flows15m: checkbox(false),
    loadpv: document.createElement('canvas'),
    prices: document.createElement('canvas'),
    pushToVictron: checkbox(false),
    run: document.createElement('button'),
    soc: document.createElement('canvas'),
    status: document.createElement('div'),
    step: input('30'),
    table: document.createElement('table'),
    tableDess: checkbox(false),
    tableKwh: checkbox(true),
    tableUnit: document.createElement('span'),
    updateDataBeforeRun: checkbox(true),
  };
  const services = {
    debounce: vi.fn((fn) => immediateDebounce(fn)),
    drawFlowsBarStackSigned: vi.fn(),
    drawLoadPvGrouped: vi.fn(),
    drawPricesStepLines: vi.fn(),
    drawSocChart: vi.fn(),
    renderTable: vi.fn(),
    requestRemoteSolve: vi.fn().mockResolvedValue({
      initialSoc_percent: 42,
      rebalanceWindow,
      rows,
      solverStatus: 'optimal',
      summary,
      tsStart: '2026-05-01T12:00:00.000Z',
    }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    snapshotUI: vi.fn(() => ({ tableShowKwh: els.tableKwh.checked })),
    updateEvPanel: vi.fn(),
    updatePlanMeta: vi.fn(),
    updateRebalanceNudgeUI: vi.fn(),
    updateSummaryUI: vi.fn(),
  };

  return {
    controller: createOptimizerController({ els, services }),
    els,
    rebalanceWindow,
    rows,
    services,
    summary,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('optimizer controller', () => {
  it('persists settings, solves remotely, and renders optimizer outputs', async () => {
    const { controller, els, rebalanceWindow, rows, services, summary } = setupController();

    await controller.onRun();

    expect(services.saveConfig).toHaveBeenCalledWith({ tableShowKwh: true });
    expect(services.requestRemoteSolve).toHaveBeenCalledWith({
      updateData: true,
      writeToVictron: false,
    });
    expect(services.updatePlanMeta).toHaveBeenCalledWith(
      els,
      42,
      '2026-05-01T12:00:00.000Z',
    );
    expect(services.updateSummaryUI).toHaveBeenCalledWith(els, summary);
    expect(services.updateRebalanceNudgeUI).toHaveBeenCalledWith(els, undefined);

    const tableArgs = services.renderTable.mock.calls[0][0];
    expect(tableArgs.rows).toBe(rows);
    expect(tableArgs.cfg).toEqual({ batteryCapacity_Wh: 9000, stepSize_m: 30 });
    expect(tableArgs.targets).toEqual({ table: els.table, tableUnit: els.tableUnit });
    expect(tableArgs.showKwh).toBe(true);
    expect(tableArgs.showDess).toBe(false);
    expect(tableArgs.rebalanceWindow).toBe(rebalanceWindow);
    expect(tableArgs.evSettings).toEqual({
      // Legacy absolute datetime resolves to its own instant (ms).
      departureTime: new Date('2026-05-01T18:30').getTime(),
      targetSoc_percent: 80,
    });

    expect(services.drawFlowsBarStackSigned).toHaveBeenCalledWith(
      els.flows,
      rows,
      30,
      rebalanceWindow,
      tableArgs.evSettings,
      60,
    );
    expect(services.drawSocChart).toHaveBeenCalledWith(els.soc, rows, 30, tableArgs.evSettings, null);
    expect(services.drawPricesStepLines).toHaveBeenCalledWith(els.prices, rows, 30);
    expect(services.drawLoadPvGrouped).toHaveBeenCalledWith(els.loadpv, rows, 30);
    expect(services.updateEvPanel).toHaveBeenCalledWith(els, rows, summary, 30, null);
    expect(els.status.textContent).toBe('Plan updated');
    expect(els.run.disabled).toBe(false);
    expect(els.run.classList.contains('loading')).toBe(false);
  });

  it('feeds the EV preview into the EV panel only, never the overview SoC chart', async () => {
    const { controller, els, rows, services, summary } = setupController();
    const previewRows = [{ timestampMs: 1, ev_soc_percent: 60, soc_percent: 50 }];
    const previewSummary = { evChargeTotal_kWh: 1, evChargeFromGrid_kWh: 1, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 };
    const evPreview = { rows: previewRows, summary: previewSummary, liveSoc_percent: 55, hasSchedule: true };
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 42, rows, solverStatus: 'optimal', summary,
      tsStart: '2026-05-01T12:00:00.000Z', evPreview,
    });

    await controller.onRun();

    // The overview SoC chart reflects only the real plan — the preview is NOT
    // overlaid (5th arg stays null); it only goes to the EV tab.
    expect(services.drawSocChart).toHaveBeenCalledWith(els.soc, rows, 30, expect.anything(), null);
    // EV panel renders the preview schedule + summary and receives the preview object.
    expect(services.updateEvPanel).toHaveBeenCalledWith(els, previewRows, previewSummary, 30, evPreview);
  });

  it('re-renders cached table rows when table display toggles change', async () => {
    const { controller, els, services } = setupController();
    await controller.onRun();
    services.renderTable.mockClear();
    services.saveConfig.mockClear();

    els.tableKwh.checked = false;
    controller.onTableDisplayChange({ currentTarget: els.tableKwh });
    await Promise.resolve();

    expect(services.renderTable).toHaveBeenCalledTimes(1);
    expect(services.renderTable.mock.calls[0][0].showKwh).toBe(false);
    expect(services.saveConfig).toHaveBeenCalledWith({ tableShowKwh: false });
  });

  it('passes aggregateMinutes=null when flows-15m is checked, 60 when unchecked', async () => {
    const { controller, els, rebalanceWindow, rows, services } = setupController();
    els.flows15m.checked = true;
    await controller.onRun();

    expect(services.drawFlowsBarStackSigned).toHaveBeenLastCalledWith(
      els.flows, rows, 30, rebalanceWindow, expect.any(Object), null,
    );

    services.drawFlowsBarStackSigned.mockClear();
    els.flows15m.checked = false;
    controller.onFlowsAggregationChange();

    expect(services.drawFlowsBarStackSigned).toHaveBeenCalledTimes(1);
    expect(services.drawFlowsBarStackSigned).toHaveBeenLastCalledWith(
      els.flows, rows, 30, rebalanceWindow, expect.any(Object), 60,
    );
  });

  it('onFlowsAggregationChange is a no-op before the first solve', () => {
    const { controller, services } = setupController();
    controller.onFlowsAggregationChange();
    expect(services.drawFlowsBarStackSigned).not.toHaveBeenCalled();
  });
});
