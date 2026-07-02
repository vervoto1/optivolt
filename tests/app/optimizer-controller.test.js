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

  it('surfaces solver errors in the status line and clears the summary', async () => {
    const { controller, els, services } = setupController();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    services.requestRemoteSolve.mockRejectedValue(new Error('solver exploded'));

    await controller.onRun();

    expect(els.status.textContent).toBe('Error: solver exploded');
    expect(els.status.className).toContain('text-red-600');
    // Summary cleared on failure.
    expect(services.updateSummaryUI).toHaveBeenLastCalledWith(els, null);
    // Run button restored even on the error path.
    expect(els.run.disabled).toBe(false);
    expect(els.run.classList.contains('loading')).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it('defaults rows to [] and solverStatus to "OK" when the result omits them', async () => {
    const { controller, els, services } = setupController();
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 10,
      tsStart: '2026-05-01T12:00:00.000Z',
      summary: {},
      // no rows array, no solverStatus string
      rows: undefined,
      solverStatus: 42,
    });

    await controller.onRun();

    // No rows -> the table render is skipped (returns false), charts still draw with [].
    expect(services.renderTable).not.toHaveBeenCalled();
    expect(services.drawSocChart).toHaveBeenCalledWith(els.soc, [], 30, expect.anything(), null);
    // A non-string solverStatus is coerced to the "OK" default, which is itself
    // non-"optimal" -> rendered as a (amber) plan-status notice.
    expect(els.status.textContent).toBe('Plan status: OK');
    expect(els.status.className).toContain('text-amber-600');
  });

  it('reports a non-optimal solver status with an amber label', async () => {
    const { controller, els, services } = setupController();
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 10, rows: [{ tIdx: 0 }], summary: {},
      tsStart: '2026-05-01T12:00:00.000Z', solverStatus: 'Infeasible',
    });

    await controller.onRun();

    expect(els.status.textContent).toBe('Plan status: Infeasible');
    expect(els.status.className).toContain('text-amber-600');
  });

  it('announces a Victron write on the success path', async () => {
    const { controller, els, services } = setupController();
    els.pushToVictron.checked = true;
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 10, rows: [{ tIdx: 0 }], summary: {},
      tsStart: '2026-05-01T12:00:00.000Z', solverStatus: 'optimal',
    });

    await controller.onRun();

    expect(services.requestRemoteSolve).toHaveBeenCalledWith({ updateData: true, writeToVictron: true });
    expect(els.status.textContent).toBe('Plan updated and sent to Victron');
    expect(els.status.className).toContain('text-emerald-600');
  });

  it('does nothing in updateRunStatus when there is no status element', async () => {
    const { controller, els, services } = setupController();
    els.status = null; // drop the status node
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 10, rows: [{ tIdx: 0 }], summary: {},
      tsStart: '2026-05-01T12:00:00.000Z', solverStatus: 'optimal',
    });
    // Should complete without throwing despite the missing status element.
    await expect(controller.onRun()).resolves.toBeUndefined();
  });

  it('reports a settings-persistence failure in the status line', async () => {
    const { controller, els, services } = setupController();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    services.saveConfig.mockRejectedValue(new Error('disk full'));

    await controller.persistConfig({ foo: 1 });

    expect(els.status.textContent).toBe('Settings error: disk full');
  });

  it('swallows a settings-persistence failure when there is no status element', async () => {
    const { controller, els, services } = setupController();
    els.status = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    services.saveConfig.mockRejectedValue(new Error('disk full'));
    await expect(controller.persistConfig({ foo: 1 })).resolves.toBeUndefined();
  });

  it('triggers a full solve when a table toggle changes before any plan exists', async () => {
    const { controller, els, services } = setupController();
    // No prior onRun -> lastTableRows empty -> renderScheduleTable returns false.
    controller.onTableDisplayChange({ currentTarget: els.tableDess });
    // The fallback recompute is fire-and-forget; let its async body settle.
    await Promise.resolve();
    await Promise.resolve();
    // Falls back to a full recompute.
    expect(services.requestRemoteSolve).toHaveBeenCalledTimes(1);
  });

  it('persists a snapshot only when the tableKwh toggle is the change source', async () => {
    const { controller, els, services } = setupController();
    await controller.onRun();
    services.saveConfig.mockClear();

    // A non-tableKwh target re-renders but does not queue a snapshot persist.
    controller.onTableDisplayChange({ currentTarget: els.tableDess });
    expect(services.saveConfig).not.toHaveBeenCalled();
  });

  it('runs without a run button and without a status element', async () => {
    const { controller, els, services } = setupController();
    els.run = null;     // no button to toggle loading / disabled
    els.status = null;  // no status line
    services.requestRemoteSolve.mockResolvedValue({
      initialSoc_percent: 10, rows: [{ tIdx: 0 }], summary: {},
      tsStart: '2026-05-01T12:00:00.000Z', solverStatus: 'optimal',
    });
    await expect(controller.onRun()).resolves.toBeUndefined();
    expect(services.requestRemoteSolve).toHaveBeenCalled();
  });

  it('handles an error with neither a status element nor a run button', async () => {
    const { controller, els, services } = setupController();
    els.run = null;
    els.status = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    services.requestRemoteSolve.mockRejectedValue(new Error('kaboom'));
    await expect(controller.onRun()).resolves.toBeUndefined();
    // Summary still cleared even with no status node.
    expect(services.updateSummaryUI).toHaveBeenLastCalledWith(els, null);
  });

  it('tolerates a debounce whose returned function has no cancel()', async () => {
    const rows = [{ tIdx: 0 }];
    const els = {
      cap: input('9000'), evEnabled: checkbox(false),
      flows: document.createElement('canvas'), flows15m: checkbox(false),
      loadpv: document.createElement('canvas'), prices: document.createElement('canvas'),
      pushToVictron: checkbox(false), run: document.createElement('button'),
      soc: document.createElement('canvas'), status: document.createElement('div'),
      step: input('30'), table: document.createElement('table'),
      tableDess: checkbox(false), tableKwh: checkbox(false),
      tableUnit: document.createElement('span'), updateDataBeforeRun: checkbox(false),
    };
    const services = {
      // Plain debounce: the returned function exposes no .cancel.
      debounce: (fn) => fn,
      drawFlowsBarStackSigned: vi.fn(), drawLoadPvGrouped: vi.fn(),
      drawPricesStepLines: vi.fn(), drawSocChart: vi.fn(), renderTable: vi.fn(),
      requestRemoteSolve: vi.fn().mockResolvedValue({
        initialSoc_percent: 10, rows, summary: {},
        tsStart: '2026-05-01T12:00:00.000Z', solverStatus: 'optimal',
      }),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      snapshotUI: vi.fn(() => ({})), updateEvPanel: vi.fn(),
      updatePlanMeta: vi.fn(), updateRebalanceNudgeUI: vi.fn(), updateSummaryUI: vi.fn(),
    };
    const controller = createOptimizerController({ els, services });
    await expect(controller.onRun()).resolves.toBeUndefined();
    expect(services.requestRemoteSolve).toHaveBeenCalled();
  });

  it('coerces an empty EV target SoC to null while the EV switch is on', async () => {
    const { controller, els, services } = setupController();
    els.evEnabled.checked = true;
    els.evTargetSoc = input(''); // parseFloat('') -> NaN -> || null
    await controller.onRun();
    const tableArgs = services.renderTable.mock.calls[0][0];
    expect(tableArgs.evSettings.targetSoc_percent).toBeNull();
  });

  it('returns null EV settings when the EV master switch is off', async () => {
    const { controller, els, services } = setupController();
    els.evEnabled.checked = false;
    await controller.onRun();

    const tableArgs = services.renderTable.mock.calls[0][0];
    expect(tableArgs.evSettings).toBeNull();
    // The flows chart also receives null EV settings.
    expect(services.drawFlowsBarStackSigned).toHaveBeenLastCalledWith(
      els.flows, expect.anything(), 30, expect.anything(), null, 60,
    );
  });
});
