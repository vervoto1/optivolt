// @vitest-environment jsdom
// Settings saves send the keys the user edited in this tab, and only those.
// A tab left open while the server changes a setting on its own (rebalancing
// switched off after a hold cycle, a VRM refresh, an edit in another tab)
// must not push its stale form value back, and a value the user does set
// must always be sent, even when it equals one the tab saw before.
// These tests use the real snapshotUI/hydrateUI and real DOM events, so the
// payload is exactly what the page would POST to /settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';
import { hydrateUI, snapshotUI } from '../../app/src/state.js';
import {
  mergeSettings,
  normalizeSettings,
  sanitizeSettingsResponse,
  validateSettingsPatch,
} from '../../api/services/settings-schema.ts';
import defaultSettings from '../../api/defaults/default-settings.json';

function checkbox() {
  const el = document.createElement('input');
  el.type = 'checkbox';
  return el;
}

function input() {
  return document.createElement('input');
}

// What the user does: change a control and let it fire its event.
function type(el, value) {
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el) {
  el.checked = !el.checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function plan(rebalanceStatus) {
  return {
    initialSoc_percent: 99,
    rows: [{ tIdx: 0, timestampMs: 1714586400000, soc_percent: 99 }],
    solverStatus: 'Optimal',
    summary: { rebalanceStatus },
    tsStart: '2026-10-07T12:00:00.000Z',
  };
}

// POST /settings built from the server's own schema code (validate the
// patch, merge, normalise with the save-time checks, reply with the
// sanitised stored settings), so a change in its rules or 400 messages
// breaks these tests. A rejection carries its HTTP status like client.js.
function fakeServer(initial) {
  const server = { settings: normalizeSettings({ ...defaultSettings, ...initial }) };
  server.save = vi.fn(async (patch) => {
    try {
      validateSettingsPatch(patch);
      const previous = server.settings;
      server.settings = normalizeSettings(mergeSettings(previous, patch), { savingPatch: patch, previous });
    } catch (error) {
      throw Object.assign(new Error(error.message), { status: error.statusCode ?? 500 });
    }
    return { message: 'Settings saved successfully.', settings: sanitizeSettingsResponse(server.settings) };
  });
  return server;
}

const PAGE_LOAD_SETTINGS = {
  rebalanceEnabled: true,
  rebalanceHoldHours: 3,
  evTargetSoc_percent: 80,
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  maxDischargePower_W: 4000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  inverterEfficiency_percent: 97,
  autoCalculate: { enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: true },
};

// The tab as hydrated at page load, with edit tracking wired like main.js.
function setupTab({ serverSettings = PAGE_LOAD_SETTINGS, services: extraServices = {} } = {}) {
  const els = {
    rebalanceEnabled: checkbox(),
    rebalanceHoldHours: input(),
    evTargetSoc: input(),
    step: input(),
    cap: input(),
    pdis: input(),
    minsoc: input(),
    maxsoc: input(),
    evMinChargeCurrent: input(),
    evMaxChargeCurrent: input(),
    etaC: input(),
    etaD: input(),
    etaInv: input(),
    autoCalcEnabled: checkbox(),
    autoCalcInterval: input(),
    autoCalcUpdateData: checkbox(),
    autoCalcWriteVictron: checkbox(),
    haToken: input(),
    status: document.createElement('div'),
  };
  const form = document.createElement('form');
  for (const [name, el] of Object.entries(els)) {
    if (name !== 'status') form.appendChild(el);
  }
  document.body.appendChild(form);
  hydrateUI(els, serverSettings);

  const server = fakeServer(serverSettings);
  const persistDebounces = [];
  const services = {
    debounce: vi.fn((fn) => {
      let pending = false;
      const d = vi.fn(() => { pending = true; });
      d.cancel = vi.fn(() => { pending = false; });
      d.flush = () => { if (pending) { pending = false; fn(); } };
      persistDebounces.push(d);
      return d;
    }),
    drawFlowsBarStackSigned: vi.fn(),
    drawLoadPvGrouped: vi.fn(),
    drawPricesStepLines: vi.fn(),
    drawSocChart: vi.fn(),
    fetchLastPlan: vi.fn(),
    renderTable: vi.fn(),
    requestRemoteSolve: vi.fn().mockResolvedValue(plan('scheduled')),
    saveConfig: server.save,
    updateEvPanel: vi.fn(),
    updatePlanMeta: vi.fn(),
    updateRebalanceNudgeUI: vi.fn(),
    updateSummaryUI: vi.fn(),
    onSettingsRehydrated: vi.fn(),
    ...extraServices,
  };
  const controller = createOptimizerController({ els, services });
  controller.trackSettingsEdits(document);
  // createOptimizerController creates debounceRun first, then the persist debounce.
  const [runDebounce, persistDebounce] = persistDebounces;
  // What wireGlobalInputs does for a solving settings control.
  const wireLikeMain = (...controls) => {
    for (const control of controls) {
      for (const type of ['input', 'change']) {
        control.addEventListener(type, () => {
          controller.queuePersistSnapshot();
          controller.debounceRun();
        });
      }
    }
  };
  return { controller, els, server, services, persistDebounce, runDebounce, wireLikeMain };
}

function sentPatches(server) {
  return server.save.mock.calls.map(([payload]) => payload);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('settings saves send only the keys edited in this tab', () => {
  it('a stale tab never sends rebalanceEnabled:true when another field is edited', async () => {
    const { controller, els, server } = setupTab();
    // The server finished the hold cycle and switched rebalancing off; this
    // tab still shows the box checked.
    server.settings.rebalanceEnabled = false;
    expect(els.rebalanceEnabled.checked).toBe(true);

    type(els.evTargetSoc, 90);
    await controller.persistConfig();
    type(els.rebalanceHoldHours, 4);
    await controller.onRun();

    expect(sentPatches(server)).toEqual([{ evTargetSoc_percent: 90 }, { rebalanceHoldHours: 4 }]);
    expect(server.settings.rebalanceEnabled).toBe(false);
  });

  it('sends a deliberate toggle of the rebalance checkbox, each way', async () => {
    const { controller, els, server } = setupTab();

    click(els.rebalanceEnabled);
    await controller.persistConfig();
    click(els.rebalanceEnabled);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ rebalanceEnabled: false }, { rebalanceEnabled: true }]);
  });

  it('re-enabling rebalancing after a server auto-disable is sent', async () => {
    const { controller, els, server, services } = setupTab();
    server.settings.rebalanceEnabled = false;
    services.requestRemoteSolve.mockResolvedValue(plan('disabled'));
    await controller.onRun(); // the plan unchecks the stale box

    click(els.rebalanceEnabled);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ rebalanceEnabled: true }]);
    expect(server.settings.rebalanceEnabled).toBe(true);
  });

  it('after a VRM refresh, typing the old value back is sent', async () => {
    const { controller, els, server } = setupTab();
    // "Refresh from VRM": the server stores 15000 and the form is hydrated
    // from its reply (main.js onRefreshVrmSettings).
    server.settings = { ...server.settings, maxDischargePower_W: 15000 };
    hydrateUI(els, server.settings);
    await controller.persistConfig();
    expect(server.save).not.toHaveBeenCalled(); // the hydrate itself marks nothing

    type(els.pdis, 4000);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ maxDischargePower_W: 4000 }]);
    expect(server.settings.maxDischargePower_W).toBe(4000);
  });

  it('setting a value the tab saw before is sent after another tab changed it', async () => {
    const { controller, els, server } = setupTab();
    server.settings.minSoc_percent = 20; // changed in another tab

    type(els.minsoc, 12);
    type(els.minsoc, 10);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ minSoc_percent: 10 }]);
    expect(server.settings.minSoc_percent).toBe(10);
  });

  it('does not send a stepSize_m the server changed after page load', async () => {
    const { controller, els, server } = setupTab();
    server.settings.stepSize_m = 60;

    type(els.cap, 21000);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ batteryCapacity_Wh: 21000 }]);
    expect(server.settings.stepSize_m).toBe(60);
  });

  it('sends nothing when nothing was edited, or the edit was already saved', async () => {
    const { controller, els, server } = setupTab();
    await controller.onRun();
    expect(server.save).not.toHaveBeenCalled();

    type(els.evTargetSoc, 90);
    await controller.persistConfig();
    await controller.persistConfig();
    expect(server.save).toHaveBeenCalledTimes(1);
  });

  it('a cleared HA token is not sent (the server keeps the stored one)', async () => {
    const { controller, els, server } = setupTab();
    type(els.haToken, 'secret');
    await controller.persistConfig();
    type(els.haToken, '');
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ haToken: 'secret' }]);
  });

  it('rehydrates a saved field from the stored, normalised value', async () => {
    const { controller, els } = setupTab();

    type(els.pdis, '4000.6');
    await controller.persistConfig();

    expect(els.pdis.value).toBe('4001');
  });

  it('a min SoC typed above the max is rejected and stays edited; the max is untouched', async () => {
    const { controller, els, server } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 10, maxSoc_percent: 90 },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.minsoc, 95);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ minSoc_percent: 95 }]);
    expect(els.status.textContent).toBe('Settings error: minSoc_percent (95) must not be above maxSoc_percent (90)');
    expect(server.settings.minSoc_percent).toBe(10);
    expect(els.minsoc.value).toBe('95');
    expect(els.maxsoc.value).toBe('90');

    type(els.minsoc, 15);
    await controller.persistConfig();
    expect(sentPatches(server).at(-1)).toEqual({ minSoc_percent: 15 });
    expect(server.settings.minSoc_percent).toBe(15);
  });

  it('an EV min current typed above the max is rejected; the max is untouched', async () => {
    const { controller, els, server } = setupTab();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.evMinChargeCurrent, 20);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ evMinChargeCurrent_A: 20 }]);
    expect(els.status.textContent).toBe(
      'Settings error: evMinChargeCurrent_A (20) must not be above evMaxChargeCurrent_A (16)',
    );
    expect(server.settings.evMinChargeCurrent_A).toBe(6);
    expect(els.evMaxChargeCurrent.value).toBe('16');
  });

  it('does not refill the field the user is typing in', async () => {
    const { controller, els, server } = setupTab();

    els.pdis.focus();
    type(els.pdis, '4000.6');
    await controller.persistConfig();

    expect(server.settings.maxDischargePower_W).toBe(4001);
    expect(els.pdis.value).toBe('4000.6'); // left as typed while focused
    els.pdis.blur();
  });

  it('a VRM refresh leaves fields with an unsaved edit alone', async () => {
    const { controller, els, server } = setupTab();
    type(els.pdis, 5000); // not saved yet

    controller.hydrateServerSettings({ ...server.settings, maxDischargePower_W: 15000, batteryCapacity_Wh: 30000 });

    expect(els.pdis.value).toBe('5000');
    expect(els.cap.value).toBe('30000');
    await controller.persistConfig();
    expect(sentPatches(server)).toEqual([{ maxDischargePower_W: 5000 }]);
  });

  it('a save that throws is reported, and the next edit still saves', async () => {
    const flakySnapshot = vi.fn(snapshotUI).mockImplementationOnce(() => { throw new Error('boom'); });
    const { controller, els, server } = setupTab({ services: { snapshotUI: flakySnapshot } });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.evTargetSoc, 90);
    await controller.persistConfig();
    expect(els.status.textContent).toBe('Settings error: boom');
    expect(server.save).not.toHaveBeenCalled();

    type(els.cap, 21000);
    await controller.persistConfig();
    expect(sentPatches(server)).toEqual([{ evTargetSoc_percent: 90, batteryCapacity_Wh: 21000 }]);
  });

  it('does not clobber a field edited again while its save was in flight', async () => {
    const { controller, els, server } = setupTab();
    const firstSave = deferred();
    const realSave = server.save.getMockImplementation();
    server.save.mockImplementationOnce(async (patch) => {
      await firstSave.promise;
      return realSave(patch);
    });

    type(els.pdis, '4000.6');
    const saving = controller.persistConfig();
    await vi.waitFor(() => expect(server.save).toHaveBeenCalledTimes(1));
    type(els.pdis, 5000); // typed while the first save runs
    firstSave.resolve();
    await saving;

    expect(els.pdis.value).toBe('5000'); // not the stored 4001
    await controller.persistConfig();
    expect(sentPatches(server)).toEqual([{ maxDischargePower_W: 4000.6 }, { maxDischargePower_W: 5000 }]);
    expect(els.pdis.value).toBe('5000');
  });

  it('a rejected save keeps the key edited and its error on screen', async () => {
    const { controller, els, server } = setupTab();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.rebalanceHoldHours, 99);
    await controller.persistConfig();
    expect(els.status.textContent).toMatch(/^Settings error: rebalanceHoldHours must be a number between \d+ and \d+$/);
    expect(els.rebalanceHoldHours.value).toBe('99'); // not rehydrated
    expect(server.settings.rebalanceHoldHours).toBe(3);

    type(els.evTargetSoc, 90);
    await controller.persistConfig();

    // The rejected key is set aside and the rest of the save goes through.
    expect(sentPatches(server)).toEqual([
      { rebalanceHoldHours: 99 },
      { rebalanceHoldHours: 99, evTargetSoc_percent: 90 },
      { evTargetSoc_percent: 90 },
    ]);
    expect(server.settings.evTargetSoc_percent).toBe(90);
  });

  it('runs two quick saves one after the other, in order', async () => {
    const { controller, els, server } = setupTab();
    const firstSave = deferred();
    const realSave = server.save.getMockImplementation();
    const finished = [];
    server.save.mockImplementationOnce(async (patch) => {
      await firstSave.promise;
      finished.push('first');
      return realSave(patch);
    });

    type(els.pdis, 4000);
    const first = controller.persistConfig();
    await vi.waitFor(() => expect(server.save).toHaveBeenCalledTimes(1));
    type(els.evTargetSoc, 90);
    const second = controller.persistConfig().then(() => finished.push('second'));

    // The second save waits for the first instead of racing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.save).toHaveBeenCalledTimes(1);

    firstSave.resolve();
    await Promise.all([first, second]);
    expect(finished).toEqual(['first', 'second']);
    expect(sentPatches(server)).toEqual([{ maxDischargePower_W: 4000 }, { evTargetSoc_percent: 90 }]);
  });

  it('a debounced save reads the form when it fires', async () => {
    const { controller, els, server, persistDebounce } = setupTab();

    type(els.evTargetSoc, 85);
    controller.queuePersistSnapshot();
    type(els.evTargetSoc, 90);
    persistDebounce.flush();

    await vi.waitFor(() => expect(server.save).toHaveBeenCalledTimes(1));
    expect(sentPatches(server)).toEqual([{ evTargetSoc_percent: 90 }]);
  });
});

describe('min/max fields while typing', () => {
  it.each([
    ['SoC', 'minsoc', 'maxsoc', 'minSoc_percent', 'maxSoc_percent', { minSoc_percent: 20, maxSoc_percent: 90 }],
    ['EV current', 'evMinChargeCurrent', 'evMaxChargeCurrent', 'evMinChargeCurrent_A', 'evMaxChargeCurrent_A',
      { evMinChargeCurrent_A: 20, evMaxChargeCurrent_A: 90 }],
  ])('a pause while typing 85 into max %s never stores an inverted pair', async (_label, minEl, maxEl, minKey, maxKey, start) => {
    const { els, server, services, persistDebounce, runDebounce, wireLikeMain } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, ...start },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wireLikeMain(els[minEl], els[maxEl]);

    els[maxEl].focus();
    type(els[maxEl], 8);
    // The pause: the queued solve and save fire while the field still reads 8.
    runDebounce.flush();
    await vi.waitFor(() => expect(services.requestRemoteSolve).toHaveBeenCalledTimes(1));
    persistDebounce.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentPatches(server)).toEqual([{ [maxKey]: 8 }]); // rejected by the server
    expect(server.settings[minKey]).toBe(20);
    expect(server.settings[maxKey]).toBe(90);
    expect(els[minEl].value).toBe('20');
    expect(els.status.textContent).toMatch(new RegExp(`${maxKey} \\(8\\) must not be below ${minKey} \\(20\\)`));

    type(els[maxEl], 85);
    runDebounce.flush();
    await vi.waitFor(() => expect(services.requestRemoteSolve).toHaveBeenCalledTimes(2));
    els[maxEl].dispatchEvent(new Event('change', { bubbles: true }));
    els[maxEl].blur();
    runDebounce.flush();
    await vi.waitFor(() => expect(services.requestRemoteSolve).toHaveBeenCalledTimes(3));

    expect(server.settings[minKey]).toBe(20);
    expect(server.settings[maxKey]).toBe(85);
    expect(els[minEl].value).toBe('20');
    expect(els[maxEl].value).toBe('85');
    expect(els.status.textContent).toBe('Plan updated');
    for (const patch of sentPatches(server)) expect(patch).not.toHaveProperty(minKey);
  });

  it('Tab from min to max without editing max: the min is saved and the plan solved', async () => {
    const { els, server, services, runDebounce, wireLikeMain } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 20, maxSoc_percent: 90 },
    });
    wireLikeMain(els.minsoc, els.maxsoc);

    els.minsoc.focus();
    type(els.minsoc, 15);
    els.minsoc.dispatchEvent(new Event('change', { bubbles: true }));
    els.maxsoc.focus(); // Tab
    runDebounce.flush();

    await vi.waitFor(() => expect(services.requestRemoteSolve).toHaveBeenCalledTimes(1));
    expect(sentPatches(server)).toEqual([{ minSoc_percent: 15 }]);
    expect(server.settings.minSoc_percent).toBe(15);
  });

  it('Enter in a number field (a "change" while it keeps focus) saves and solves', async () => {
    const { els, server, services, runDebounce, wireLikeMain } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 20, maxSoc_percent: 90 },
    });
    wireLikeMain(els.maxsoc);

    els.maxsoc.focus();
    type(els.maxsoc, 85);
    els.maxsoc.dispatchEvent(new Event('change', { bubbles: true }));
    runDebounce.flush();

    await vi.waitFor(() => expect(services.requestRemoteSolve).toHaveBeenCalledTimes(1));
    expect(sentPatches(server)).toEqual([{ maxSoc_percent: 85 }]);
    expect(document.activeElement).toBe(els.maxsoc);
  });

  it('moving the whole window: a max below the stored min waits for the new min, then both save', async () => {
    const { controller, els, server } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 50, maxSoc_percent: 90 },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.maxsoc, 30);
    await controller.persistConfig();
    expect(els.status.textContent).toBe('Settings error: maxSoc_percent (30) must not be below minSoc_percent (50)');
    expect(server.settings.maxSoc_percent).toBe(90);

    type(els.minsoc, 10);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([
      { maxSoc_percent: 30 },
      { maxSoc_percent: 30, minSoc_percent: 10 },
    ]);
    expect(server.settings.minSoc_percent).toBe(10);
    expect(server.settings.maxSoc_percent).toBe(30);
    expect(els.minsoc.value).toBe('10');
    expect(els.maxsoc.value).toBe('30');
  });

  it('editing max in an old tab does not send its stale min', async () => {
    const { controller, els, server } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 20, maxSoc_percent: 90 },
    });
    server.settings.minSoc_percent = 30; // a VRM refresh in another tab

    type(els.maxsoc, 85);
    await controller.persistConfig();

    expect(sentPatches(server)).toEqual([{ maxSoc_percent: 85 }]);
    expect(server.settings.minSoc_percent).toBe(30);
    expect(server.settings.maxSoc_percent).toBe(85);
  });

  it('a server value held back while a field had focus is shown when the user leaves it', async () => {
    const { controller, els } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, minSoc_percent: 20, maxSoc_percent: 90 },
    });

    els.maxsoc.focus();
    controller.hydrateServerSettings({ minSoc_percent: 15, maxSoc_percent: 95 }); // e.g. Refresh from VRM
    expect(els.minsoc.value).toBe('15');
    expect(els.maxsoc.value).toBe('90');

    els.maxsoc.blur(); // no edit: no "change"
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(els.maxsoc.value).toBe('95');
  });
});

describe('a rejected field does not block the rest of the save', () => {
  it('saves "Write to Victron" off although a cleared efficiency is rejected', async () => {
    const { controller, els, server } = setupTab();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    type(els.etaD, ''); // num('') -> 0: the server rejects it
    click(els.autoCalcWriteVictron);
    await controller.persistConfig();

    const autoCalculate = { enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: false };
    expect(sentPatches(server)).toEqual([
      { dischargeEfficiency_percent: 0, autoCalculate },
      { autoCalculate },
    ]);
    expect(server.settings.autoCalculate.writeToVictron).toBe(false);
    expect(els.status.textContent).toBe('Settings error: dischargeEfficiency_percent must be a number between 1 and 100');

    // The bad field stays edited and is sent again (alone) with the next save.
    server.save.mockClear();
    await controller.persistConfig();
    expect(sentPatches(server)).toEqual([{ dischargeEfficiency_percent: 0 }]);
  });

  it('sends each setting on its own when a 400 names none of them', async () => {
    const { controller, els, server } = setupTab();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const realSave = server.save.getMockImplementation();
    server.save.mockImplementation(async (patch) => {
      if (patch.evTargetSoc_percent === 999) throw Object.assign(new Error('invalid payload'), { status: 400 });
      return realSave(patch);
    });

    type(els.evTargetSoc, 999);
    click(els.autoCalcWriteVictron);
    await controller.persistConfig();

    expect(server.settings.autoCalculate.writeToVictron).toBe(false);
    expect(server.settings.evTargetSoc_percent).toBe(80);
    expect(els.status.textContent).toBe('Settings error: invalid payload');
    const autoCalculate = { enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: false };
    expect(sentPatches(server)).toEqual([
      { evTargetSoc_percent: 999, autoCalculate },
      { evTargetSoc_percent: 999 },
      { autoCalculate },
    ]);
  });

  it('keeps everything for the next save when the request itself fails', async () => {
    const { controller, els, server } = setupTab();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server.save.mockRejectedValueOnce(new Error('Failed to fetch'));

    type(els.evTargetSoc, 90);
    click(els.autoCalcWriteVictron);
    await controller.persistConfig();
    expect(server.save).toHaveBeenCalledTimes(1);

    await controller.persistConfig();
    expect(server.settings.evTargetSoc_percent).toBe(90);
    expect(server.settings.autoCalculate.writeToVictron).toBe(false);
  });
});

describe('the rebalance checkbox follows a freshly solved plan', () => {
  it('unchecks the box when the plan reports rebalancing disabled, before the notice renders', async () => {
    const { controller, els, services } = setupTab();
    services.requestRemoteSolve.mockResolvedValue(plan('disabled'));
    let checkedWhenNoticeRendered = null;
    services.updateRebalanceNudgeUI.mockImplementation(() => {
      checkedWhenNoticeRendered = els.rebalanceEnabled.checked;
    });

    await controller.onRun();

    expect(els.rebalanceEnabled.checked).toBe(false);
    expect(checkedWhenNoticeRendered).toBe(false);
  });

  it('checks the box when the plan reports rebalancing on, without saving anything', async () => {
    const { controller, els, server, services } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, rebalanceEnabled: false },
    });
    services.requestRemoteSolve.mockResolvedValue(plan('active'));

    await controller.onRun();

    expect(els.rebalanceEnabled.checked).toBe(true);
    expect(server.save).not.toHaveBeenCalled();
  });

  it('keeps an unsaved toggle when the plan disagrees', async () => {
    const { controller, els, server, services } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, rebalanceEnabled: false },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server.save.mockRejectedValueOnce(new Error('network down'));
    services.requestRemoteSolve.mockResolvedValue(plan('disabled'));

    click(els.rebalanceEnabled);
    await controller.onRun();

    // The save failed, so the plan reflects the old setting; the user's choice stays.
    expect(els.rebalanceEnabled.checked).toBe(true);
    await controller.persistConfig();
    expect(sentPatches(server)).toEqual([{ rebalanceEnabled: true }, { rebalanceEnabled: true }]);
  });

  it('keeps a toggle saved while the solve ran (the plan predates it)', async () => {
    const { controller, els, server, services } = setupTab({
      serverSettings: { ...PAGE_LOAD_SETTINGS, rebalanceEnabled: false },
    });
    services.requestRemoteSolve.mockImplementation(async () => {
      click(els.rebalanceEnabled);
      await controller.persistConfig();
      return plan('disabled');
    });

    await controller.onRun();

    expect(els.rebalanceEnabled.checked).toBe(true);
    expect(sentPatches(server)).toEqual([{ rebalanceEnabled: true }]);
  });

  it('does not sync the box from a cached plan, which can predate the settings', async () => {
    const { controller, els, services } = setupTab();
    services.fetchLastPlan.mockResolvedValue({ ...plan('disabled'), computedAtMs: Date.now() });

    await controller.hydrateFromCachedPlan();

    expect(els.rebalanceEnabled.checked).toBe(true);
  });
});
