import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  getVictronSerial: vi.fn().mockResolvedValue('detected-serial'),
  writeVictronSetting: vi.fn().mockResolvedValue(undefined),
  readVictronSetting: vi.fn().mockResolvedValue({ value: 0 }),
}));

// In-memory stand-in for the write-ahead ownership record (DATA_DIR file in production).
const { stateFile } = vi.hoisted(() => ({ stateFile: { current: null } }));
vi.mock('../../../api/services/pv-curtailment-state-store.ts', () => ({
  loadPvCurtailmentState: vi.fn(async () => stateFile.current),
  savePvCurtailmentState: vi.fn(async (state) => { stateFile.current = { ...state }; }),
  clearPvCurtailmentState: vi.fn(async () => { stateFile.current = null; }),
}));

import { getVictronSerial, writeVictronSetting, readVictronSetting } from '../../../api/services/mqtt-service.ts';
import {
  loadPvCurtailmentState,
  savePvCurtailmentState,
  clearPvCurtailmentState,
} from '../../../api/services/pv-curtailment-state-store.ts';
import {
  getPvCurtailmentStatus,
  reconcilePvCurtailmentAtBoot,
  resetPvCurtailmentState,
  startPvCurtailment,
  stopPvCurtailment,
  updatePvCurtailmentPlan,
  MAX_RESTORE_ATTEMPTS,
  RESTORE_GIVE_UP_MS,
  RESTORE_RETRY_MS,
} from '../../../api/services/pv-curtailment.ts';

const START = new Date('2026-05-01T12:00:00.000Z').getTime();

function makeSettings(overrides = {}) {
  return {
    pvCurtailment: {
      enabled: true,
      dryRun: false,
      tickMs: 3000,
      minPvPowerW: 100,
      minGridHeadroomW: 100,
      negativePriceThreshold_cents_per_kWh: 0,
      portalId: 'c0619ab6bd28',
      acsystemInstance: 0,
      ...overrides,
    },
  };
}

function row(index, overrides = {}) {
  return {
    timestampMs: START + index * 15 * 60_000,
    pv: 500,
    pvCurtail: 0,
    ic: -10,
    ec: -10,
    imp: 2000,
    ...overrides,
  };
}

function plan(rows) {
  return {
    cfg: { stepSize_m: 15, maxGridImport_W: 3000 },
    rows,
  };
}

async function flushPromises() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function resetMocks() {
  vi.clearAllMocks();
  getVictronSerial.mockResolvedValue('detected-serial');
  writeVictronSetting.mockResolvedValue(undefined);
  readVictronSetting.mockResolvedValue({ value: 0 });
}

describe('pv-curtailment service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resetMocks();
  });

  afterEach(async () => {
    await stopPvCurtailment();
    resetPvCurtailmentState();
    stateFile.current = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes acsystem Pv/Disable=1 when the active plan says to disable PV', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).toHaveBeenCalledWith(
      'acsystem/0/Pv/Disable',
      1,
      { serial: 'c0619ab6bd28' },
    );
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);
  });

  it('restores Pv/Disable=0 when the plan leaves the negative price block', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    vi.clearAllMocks();

    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).toHaveBeenCalledWith(
      'acsystem/0/Pv/Disable',
      0,
      { serial: 'c0619ab6bd28' },
    );
    expect(getPvCurtailmentStatus().ownsDisable).toBe(false);
  });

  it('does not write in dry run mode but records the decision', async () => {
    startPvCurtailment(makeSettings({ dryRun: true }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getPvCurtailmentStatus().recentWrites.at(-1)).toMatchObject({
      disabled: true,
      dryRun: true,
      reason: 'negative_price_grid_headroom',
    });
  });

  it('does not disable when there is no current plan slot', async () => {
    startPvCurtailment(makeSettings());
    vi.setSystemTime(new Date(START + 60 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getPvCurtailmentStatus().lastDecision.reason).toBe('no_current_slot');
  });

  it('falls back to getVictronSerial when portalId is unset', async () => {
    startPvCurtailment(makeSettings({ portalId: undefined }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(getVictronSerial).toHaveBeenCalled();
    expect(writeVictronSetting).toHaveBeenCalledWith(
      'acsystem/0/Pv/Disable',
      1,
      { serial: 'detected-serial' },
    );
  });

  it('clears a prior interval when start is called twice', async () => {
    startPvCurtailment(makeSettings());
    startPvCurtailment(makeSettings());
    await flushPromises();
    expect(getPvCurtailmentStatus().enabled).toBe(true);
  });

  it('does nothing when start is called with curtailment disabled', () => {
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    expect(getPvCurtailmentStatus().enabled).toBe(false);
  });

  it('uses the config fallback when no active config has been set', async () => {
    await stopPvCurtailment();
    startPvCurtailment({});
    const status = getPvCurtailmentStatus({ enabled: false, dryRun: false });
    expect(status.enabled).toBe(false);
    expect(status.dryRun).toBe(false);
  });

  it('does not re-write Pv/Disable when curtailment is already in disable state', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    vi.clearAllMocks();

    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('skips overlapping ticks while one is still in flight', async () => {
    let resolveWrite;
    writeVictronSetting.mockImplementationOnce(() => new Promise(r => { resolveWrite = r; }));

    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledTimes(1);

    resolveWrite();
    await flushPromises();
  });

  it('logs an error when a plan-update tick rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVictronSetting.mockRejectedValueOnce(new Error('boom'));

    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('plan update tick failed'),
      'boom',
    );
  });

  it('runs ticks on the configured interval', async () => {
    startPvCurtailment(makeSettings({ tickMs: 1000 }));
    const initialTickAt = getPvCurtailmentStatus().lastTickAt;
    expect(initialTickAt).not.toBeNull();

    vi.advanceTimersByTime(2500);
    await flushPromises();
    const after = getPvCurtailmentStatus().lastTickAt;
    expect(after).not.toBe(initialTickAt);
  });

  it('logs gate-block decisions and dedupes within the throttle window', async () => {
    const debugSpy = vi.spyOn(console, 'debug');
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0, { ic: 1, ec: 1 })]));
    await flushPromises();
    const firstCount = debugSpy.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    updatePvCurtailmentPlan(plan([row(0, { ic: 1, ec: 1 })]));
    await flushPromises();
    expect(debugSpy.mock.calls.length).toBe(firstCount);
  });

  it('caps recentWrites at 50 entries by dropping oldest', async () => {
    startPvCurtailment(makeSettings({ dryRun: true }));
    const negative = plan([row(0), row(1)]);
    const positive = plan([row(0, { ic: 5, ec: 5 }), row(1, { ic: 5, ec: 5 })]);

    for (let i = 0; i < 60; i += 1) {
      vi.setSystemTime(new Date(START + i));
      updatePvCurtailmentPlan(i % 2 === 0 ? negative : positive);
      await flushPromises();
    }

    expect(getPvCurtailmentStatus().recentWrites.length).toBe(50);
  });

  it('uses the default tickMs when settings omit it', async () => {
    startPvCurtailment({ pvCurtailment: { enabled: true, dryRun: true } });
    await flushPromises();
    expect(getPvCurtailmentStatus().enabled).toBe(true);
  });

  it('falls back to enabled=false when status fallback is empty', async () => {
    await stopPvCurtailment();
    startPvCurtailment({});
    const status = getPvCurtailmentStatus({});
    expect(status.enabled).toBe(false);
    expect(status.dryRun).toBe(true);
  });

  it('logs an error when an interval-fired tick rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startPvCurtailment(makeSettings({ tickMs: 1000 }));
    // Prime: slot 0 positive (no disable), slot 1 negative (disable on next slot tick).
    updatePvCurtailmentPlan(plan([
      row(0, { ic: 5, ec: 5 }),
      row(1),
    ]));
    await flushPromises();
    await flushPromises();
    expect(getPvCurtailmentStatus().ownsDisable).toBe(false);

    errSpy.mockClear();
    writeVictronSetting.mockRejectedValueOnce(new Error('mqtt down'));

    // Advance the clock past 15 min so the interval-fired tick selects slot 1
    // (negative price) and triggers a write that rejects.
    await vi.advanceTimersByTimeAsync(16 * 60_000);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('tick failed'),
      'mqtt down',
    );
  });

  it('restores PV on stop when curtailment is currently disabling PV', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);

    vi.clearAllMocks();
    await stopPvCurtailment();

    expect(writeVictronSetting).toHaveBeenCalledWith(
      'acsystem/0/Pv/Disable',
      0,
      { serial: 'c0619ab6bd28' },
    );
    expect(getPvCurtailmentStatus().ownsDisable).toBe(false);
  });

  it('warns and continues when restore on stop fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    writeVictronSetting.mockRejectedValueOnce(new Error('mqtt offline'));

    await stopPvCurtailment();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to restore PV (Pv/Disable=0)'),
      'mqtt offline',
    );
    // Unconfirmed: the ownership record stays for the next start to reconcile.
    expect(stateFile.current).toMatchObject({ ownsDisable: true, acsystemInstance: 0 });
    expect(getPvCurtailmentStatus().restorePending).toBe(true);
  });
});

describe('pv-curtailment service — enphase switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetMocks();
  });

  afterEach(async () => {
    await stopPvCurtailment();
    resetPvCurtailmentState();
    stateFile.current = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function settingsWithEnphase(overrides = {}) {
    return {
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'test-token',
      pvCurtailment: {
        enabled: true,
        dryRun: false,
        tickMs: 3000,
        minPvPowerW: 100,
        minGridHeadroomW: 100,
        negativePriceThreshold_cents_per_kWh: 0,
        portalId: 'c0619ab6bd28',
        acsystemInstance: 0,
        enphaseSwitchEntity: 'switch.enphase_inverters',
        ...overrides,
      },
    };
  }

  it('logs the enphase entity in dry-run mode without making an HTTP call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const infoSpy = vi.spyOn(console, 'info');

    startPvCurtailment(settingsWithEnphase({ dryRun: true }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[pv-curtailment] dry-run Enphase switch toggle',
      { entity: 'switch.enphase_inverters', turnOn: false },
    );
  });

  it('calls HA switch.turn_off when disabling PV in non-dry-run mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    startPvCurtailment(settingsWithEnphase());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://homeassistant.local:8123/api/services/switch/turn_off');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ entity_id: 'switch.enphase_inverters' });
  });

  it('calls HA switch.turn_on when re-enabling PV', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    startPvCurtailment(settingsWithEnphase());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();
    fetchMock.mockClear();

    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://homeassistant.local:8123/api/services/switch/turn_on',
    );
  });

  it('warns but does not throw when the HA switch call fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn');

    startPvCurtailment(settingsWithEnphase());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Enphase switch toggle failed'),
      expect.stringContaining('500'),
    );
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);
  });

  it('throws inside callHaSwitch when HA credentials are not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn');

    const settings = settingsWithEnphase();
    settings.haToken = '';
    startPvCurtailment(settings);
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Enphase switch toggle failed'),
      'Home Assistant credentials not configured',
    );
  });
});

describe('pv-curtailment service — persisted ownership and boot reconciliation', () => {
  const persisted = (overrides = {}) => ({
    ownsDisable: true,
    sinceMs: START - 60_000,
    serial: 'persisted-serial',
    acsystemInstance: 2,
    enphaseSwitchEntity: '',
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetMocks();
  });

  afterEach(async () => {
    await stopPvCurtailment();
    resetPvCurtailmentState();
    stateFile.current = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('records ownership on disk before publishing a live Pv/Disable=1', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(savePvCurtailmentState).toHaveBeenCalledWith(expect.objectContaining({
      ownsDisable: true,
      serial: 'c0619ab6bd28',
      acsystemInstance: 0,
      sinceMs: START,
    }));
    const disableCall = writeVictronSetting.mock.calls.findIndex(([, value]) => value === 1);
    expect(savePvCurtailmentState.mock.invocationCallOrder[0])
      .toBeLessThan(writeVictronSetting.mock.invocationCallOrder[disableCall]);
    expect(stateFile.current).not.toBeNull();
  });

  it('does not disable PV when the ownership record cannot be written', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    savePvCurtailmentState.mockRejectedValueOnce(new Error('disk full'));
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getPvCurtailmentStatus().ownsDisable).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('plan update tick failed'), 'disk full');
  });

  it('never persists anything in dry-run mode', async () => {
    startPvCurtailment(makeSettings({ dryRun: true }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(savePvCurtailmentState).not.toHaveBeenCalled();
    expect(clearPvCurtailmentState).not.toHaveBeenCalled();
    expect(readVictronSetting).not.toHaveBeenCalled();
  });

  it('clears the record only after the read-back confirms Pv/Disable=0', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(writeVictronSetting).toHaveBeenLastCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(readVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', { serial: 'c0619ab6bd28', timeoutMs: 3000 });
    expect(clearPvCurtailmentState).not.toHaveBeenCalled();
    expect(stateFile.current).not.toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: true });

    // The next tick retries the restore and, once confirmed, drops the record.
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(clearPvCurtailmentState).toHaveBeenCalledTimes(1);
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('keeps the record when the Enphase switch could not be turned back on', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 502 });
    vi.stubGlobal('fetch', fetchMock);
    const settings = makeSettings({ enphaseSwitchEntity: 'switch.enphase' });
    settings.haUrl = 'ws://homeassistant.local:8123/api/websocket';
    settings.haToken = 'tok';
    startPvCurtailment(settings);
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stateFile.current).toMatchObject({ enphaseSwitchEntity: 'switch.enphase' });
    expect(getPvCurtailmentStatus().restorePending).toBe(true);

    // The retry only re-sends the switch call: Pv/Disable=0 was already confirmed.
    writeVictronSetting.mockClear();
    readVictronSetting.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: true });
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(readVictronSetting).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain('/api/services/switch/turn_on');
    expect(stateFile.current).toBeNull();
  });

  it('restores a persisted disable at boot with the persisted target even when the feature is now off', async () => {
    stateFile.current = persisted();
    startPvCurtailment({ pvCurtailment: { enabled: false, dryRun: false, portalId: 'other', acsystemInstance: 0 } });
    await reconcilePvCurtailmentAtBoot();

    expect(loadPvCurtailmentState).toHaveBeenCalled();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/2/Pv/Disable', 0, { serial: 'persisted-serial' });
    expect(readVictronSetting).toHaveBeenCalledWith('acsystem/2/Pv/Disable', { serial: 'persisted-serial', timeoutMs: 3000 });
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ restorePending: false, ownsDisable: false });
  });

  it('restores a persisted disable at boot for real even in dry-run mode', async () => {
    stateFile.current = persisted();
    startPvCurtailment(makeSettings({ dryRun: true }));
    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/2/Pv/Disable', 0, { serial: 'persisted-serial' });
    expect(stateFile.current).toBeNull();
  });

  it('restores at boot when the live loop does not want curtailment (no plan yet)', async () => {
    stateFile.current = persisted({ acsystemInstance: 0, serial: 'c0619ab6bd28' });
    startPvCurtailment(makeSettings());
    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(writeVictronSetting).not.toHaveBeenCalledWith('acsystem/0/Pv/Disable', 1, expect.anything());
    expect(stateFile.current).toBeNull();
  });

  // In production no plan exists yet when reconcile runs at boot, so it restores (the test
  // above) and the first plan re-disables if still wanted: the same off/on/off a clean
  // restart already does, since the shutdown path restores PV too. This covers the branch
  // where a plan is already present when the record is found.
  it('re-asserts the disable instead of restoring when a plan already says curtail', async () => {
    stateFile.current = persisted({ acsystemInstance: 0, serial: 'c0619ab6bd28' });
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    writeVictronSetting.mockClear();
    // Simulate the boot ordering: the record is found while the plan says "curtail".
    resetPvCurtailmentState();
    stateFile.current = persisted({ acsystemInstance: 0, serial: 'c0619ab6bd28' });

    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 1, { serial: 'c0619ab6bd28' });
    expect(writeVictronSetting).not.toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, expect.anything());
    expect(stateFile.current).toMatchObject({ ownsDisable: true });
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);
  });

  it('keeps retrying an unconfirmed boot restore while the feature is off', async () => {
    stateFile.current = persisted();
    readVictronSetting.mockRejectedValueOnce(new Error('Timeout after 3000ms'));
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();

    expect(stateFile.current).not.toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledTimes(2);
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);

    // Confirmed: the retry timer is gone.
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS * 2);
    expect(writeVictronSetting).toHaveBeenCalledTimes(2);
  });

  it('warns about a Pv/Disable=1 it does not own and leaves it alone', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    startPvCurtailment(makeSettings());
    await reconcilePvCurtailmentAtBoot();

    expect(readVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', { serial: 'c0619ab6bd28', timeoutMs: 3000 });
    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('holds no record of disabling it'));
    expect(getPvCurtailmentStatus()).toMatchObject({ externalDisable: true, ownsDisable: false });
  });

  it('does not probe Pv/Disable at boot when the feature is off and nothing is recorded', async () => {
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();
    expect(readVictronSetting).not.toHaveBeenCalled();
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('bounds the restore on stop and keeps the record when it times out', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    writeVictronSetting.mockImplementationOnce(() => new Promise(() => {}));

    const stopped = stopPvCurtailment({ restoreTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    await stopped;

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('did not finish within 50ms'));
    expect(stateFile.current).toMatchObject({ ownsDisable: true });
    // The hung write never settles; drop it so afterEach does not wait on it.
    resetPvCurtailmentState();
  });

  it('logs a failed boot reconcile tick (the next tick retries)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    resetPvCurtailmentState();
    stateFile.current = persisted({ acsystemInstance: 0, serial: 'c0619ab6bd28' });
    savePvCurtailmentState.mockRejectedValueOnce(new Error('read-only fs'));

    await reconcilePvCurtailmentAtBoot();
    expect(errSpy).toHaveBeenCalledWith('[pv-curtailment] boot reconcile tick failed:', 'read-only fs');
  });

  it('detects the serial for the boot probe when no portal id is configured', async () => {
    startPvCurtailment(makeSettings({ portalId: '' }));
    await reconcilePvCurtailmentAtBoot();
    expect(getVictronSerial).toHaveBeenCalled();
    expect(readVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', { serial: 'detected-serial', timeoutMs: 3000 });
    expect(getPvCurtailmentStatus().externalDisable).toBe(false);
  });

  it('does not flag an external disable when the loop took ownership during the boot probe', async () => {
    let answer;
    readVictronSetting.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    startPvCurtailment(makeSettings());
    const probe = reconcilePvCurtailmentAtBoot();
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);

    answer({ value: 1 });
    await probe;
    expect(getPvCurtailmentStatus().externalDisable).toBe(false);
  });

  it('warns when the boot probe cannot read Pv/Disable', async () => {
    readVictronSetting.mockRejectedValueOnce(new Error('Timeout after 3000ms'));
    startPvCurtailment(makeSettings());
    await reconcilePvCurtailmentAtBoot();
    expect(console.warn).toHaveBeenCalledWith('[pv-curtailment] could not read Pv/Disable at boot:', 'Timeout after 3000ms');
  });

  it('in dry-run, restores a persisted real disable before simulating a new one', async () => {
    startPvCurtailment(makeSettings({ dryRun: true }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    resetPvCurtailmentState();
    stateFile.current = persisted();

    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/2/Pv/Disable', 0, { serial: 'persisted-serial' });
    expect(writeVictronSetting).not.toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: true, dryRun: true, restorePending: false });
    expect(getPvCurtailmentStatus().recentWrites.at(-1)).toMatchObject({ disabled: true, dryRun: true });
  });

  it('does not disable when stopped while the ownership record was being written', async () => {
    let finishSave;
    savePvCurtailmentState.mockImplementationOnce(async (state) => {
      await new Promise((resolve) => { finishSave = resolve; });
      stateFile.current = { ...state };
    });
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    await stopPvCurtailment();
    finishSave();
    await flushPromises();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: true });
  });

  it('records nothing when stopped while the Victron serial was being detected', async () => {
    let finishSerial;
    getVictronSerial.mockImplementationOnce(() => new Promise((resolve) => { finishSerial = resolve; }));
    startPvCurtailment(makeSettings({ portalId: '' }));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    await stopPvCurtailment();
    finishSerial('detected-serial');
    await flushPromises();

    expect(savePvCurtailmentState).not.toHaveBeenCalled();
    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: false });
  });

  it('restores a record saved after a restart switched the feature off', async () => {
    // Settings saved with curtailment off while a disable's write-ahead record was being
    // written: the record lands after the new (disabled) service started, so the
    // standalone retry has to pick it up.
    let finishSave;
    savePvCurtailmentState.mockImplementationOnce(async (state) => {
      await new Promise((resolve) => { finishSave = resolve; });
      stateFile.current = { ...state };
    });
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    await stopPvCurtailment();
    startPvCurtailment(makeSettings({ enabled: false }));
    finishSave();
    await flushPromises();
    expect(stateFile.current).not.toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: true });

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(writeVictronSetting).not.toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('shares one restore between a tick and a concurrent stop', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    writeVictronSetting.mockClear();

    let finishWrite;
    writeVictronSetting.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    const stopped = stopPvCurtailment();
    await flushPromises();
    finishWrite();
    await stopped;

    expect(writeVictronSetting).toHaveBeenCalledTimes(1);
    expect(stateFile.current).toBeNull();
  });

  it('keeps the restore pending when the record cannot be deleted', async () => {
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    clearPvCurtailmentState.mockRejectedValueOnce(new Error('EACCES'));
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();

    expect(console.warn).toHaveBeenCalledWith('[pv-curtailment] failed to clear the persisted PV-disable record:', 'EACCES');
    expect(getPvCurtailmentStatus().restorePending).toBe(true);
  });

  it('stop detaches the config so a late plan cannot re-disable PV', async () => {
    startPvCurtailment(makeSettings());
    await stopPvCurtailment();
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('in dry-run, keeps retrying a failed real restore instead of parking on a simulated disable', async () => {
    stateFile.current = persisted();
    writeVictronSetting
      .mockRejectedValueOnce(new Error('Timeout after 10000ms waiting for publish'))
      .mockRejectedValueOnce(new Error('Timeout after 10000ms waiting for publish'));
    startPvCurtailment(makeSettings({ dryRun: true }));
    await reconcilePvCurtailmentAtBoot(); // first real restore fails

    // A negative-price plan arrives while Venus is still unreachable: the restore fails
    // again, and no simulated disable is taken over the real one.
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledTimes(2);
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: true });

    // Venus is back: the next tick (still "curtail") retries the real restore.
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledTimes(3);
    expect(writeVictronSetting).toHaveBeenLastCalledWith('acsystem/2/Pv/Disable', 0, { serial: 'persisted-serial' });
    expect(writeVictronSetting).not.toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: true, dryRun: true, restorePending: false });
  });

  it('in dry-run, retries a restore whose read-back did not confirm before simulating', async () => {
    stateFile.current = persisted();
    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    startPvCurtailment(makeSettings({ dryRun: true }));
    await reconcilePvCurtailmentAtBoot();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);

    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledTimes(2);
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: true, restorePending: false });
  });

  it('leaves the stop restore in charge when stopped while Pv/Disable=1 was being published', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const settings = makeSettings({ enphaseSwitchEntity: 'switch.enphase' });
    settings.haUrl = 'ws://homeassistant.local:8123/api/websocket';
    settings.haToken = 'tok';
    let finishDisable;
    writeVictronSetting.mockImplementationOnce(() => new Promise((resolve) => { finishDisable = resolve; }));
    startPvCurtailment(settings);
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 1, { serial: 'c0619ab6bd28' });

    const stopped = stopPvCurtailment();
    await flushPromises();
    finishDisable();
    await stopped;
    await flushPromises();

    // Only the restore's turn_on: the late disable did not switch the Enphase array off.
    expect(fetchMock.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['turn_on']);
    expect(writeVictronSetting).toHaveBeenLastCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: false });
    expect(stateFile.current).toBeNull();
  });

  it('clears externalDisable once Pv/Disable reads 0 again', async () => {
    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    startPvCurtailment(makeSettings());
    await reconcilePvCurtailmentAtBoot();
    expect(getPvCurtailmentStatus().externalDisable).toBe(true);

    // Still 1 on the next tick: stays flagged, warned only once.
    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().externalDisable).toBe(true);
    expect(console.warn.mock.calls.filter(([m]) => String(m).includes('holds no record'))).toHaveLength(1);

    // The user re-enabled PV on the GX.
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().externalDisable).toBe(false);
    expect(writeVictronSetting).not.toHaveBeenCalled();

    // Not flagged: later ticks do not read it again.
    readVictronSetting.mockClear();
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(readVictronSetting).not.toHaveBeenCalled();
  });

  it('keeps externalDisable when its re-check cannot read Pv/Disable', async () => {
    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    startPvCurtailment(makeSettings());
    await reconcilePvCurtailmentAtBoot();
    readVictronSetting.mockRejectedValueOnce(new Error('Timeout after 3000ms'));
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().externalDisable).toBe(true);
    expect(console.debug).toHaveBeenCalledWith('[pv-curtailment] external-disable re-check failed:', 'Timeout after 3000ms');
  });

  it('does not turn the Enphase switch on again while only the read-back is pending', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const settings = makeSettings({ enphaseSwitchEntity: 'switch.enphase' });
    settings.haUrl = 'ws://homeassistant.local:8123/api/websocket';
    settings.haToken = 'tok';
    startPvCurtailment(settings);
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    fetchMock.mockClear();

    readVictronSetting.mockResolvedValueOnce({ value: 1 });
    vi.setSystemTime(new Date(START + 30 * 60_000));
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);

    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(stateFile.current).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on an Enphase switch that keeps failing after MAX_RESTORE_ATTEMPTS', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    stateFile.current = persisted({ enphaseSwitchEntity: 'switch.renamed' });
    startPvCurtailment({
      haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'tok',
      pvCurtailment: { enabled: false },
    });
    await reconcilePvCurtailmentAtBoot();
    for (let i = 1; i < MAX_RESTORE_ATTEMPTS; i += 1) {
      expect(stateFile.current).not.toBeNull();
      await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
      await flushPromises();
    }

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS);
    // Pv/Disable=0 was confirmed on the first attempt and never rewritten.
    expect(writeVictronSetting).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('giving up turning switch.renamed back on'));
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS);
  });

  it('drops a record whose restore never reads back (stale target) after MAX_RESTORE_ATTEMPTS', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    readVictronSetting.mockRejectedValue(new Error('Timeout after 3000ms'));
    stateFile.current = persisted({ serial: 'old-cerbo' });
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();
    for (let i = 1; i < MAX_RESTORE_ATTEMPTS; i += 1) {
      expect(stateFile.current).not.toBeNull();
      await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
      await flushPromises();
    }

    expect(writeVictronSetting).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('never read back; dropping the record'));
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('counts a read-back without a value as unanswered, not as confirmed', async () => {
    readVictronSetting.mockResolvedValueOnce({ value: null });
    stateFile.current = persisted();
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();
    expect(stateFile.current).not.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('read back without a value'));
  });

  it('never gives up while the read-back still answers Pv/Disable=1', async () => {
    readVictronSetting.mockResolvedValue({ value: 1 });
    stateFile.current = persisted();
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS + 5; i += 1) {
      await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
      await flushPromises();
    }
    expect(writeVictronSetting).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS + 6);
    expect(stateFile.current).not.toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);
  });

  it('starts the unanswered read-back count over when a read-back answers Pv/Disable=1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Unanswered for MAX_RESTORE_ATTEMPTS - 1 attempts, then one answer of 1, then
    // unanswered again: the streak behind a give-up must not span the answer.
    let reads = 0;
    readVictronSetting.mockImplementation(async () => {
      reads += 1;
      if (reads === MAX_RESTORE_ATTEMPTS) return { value: 1 };
      throw new Error('Timeout after 3000ms');
    });
    stateFile.current = persisted();
    startPvCurtailment({ pvCurtailment: { enabled: false } });
    await reconcilePvCurtailmentAtBoot();
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
      await flushPromises();
    }

    expect(reads).toBe(MAX_RESTORE_ATTEMPTS + 3);
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('never read back'));
    expect(stateFile.current).not.toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);
  });

  it('measures the give-up span on a monotonic clock (a wall-clock jump does not give up early)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    stateFile.current = persisted({ serial: 'c0619ab6bd28', acsystemInstance: 0, enphaseSwitchEntity: 'switch.renamed' });
    startPvCurtailment({
      haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'tok',
      ...makeSettings({ tickMs: 1000, enphaseSwitchEntity: 'switch.renamed' }),
    });
    await reconcilePvCurtailmentAtBoot();
    // The RTC is corrected a day forward right after boot.
    vi.setSystemTime(new Date(Date.now() + 24 * 3_600_000));
    await vi.advanceTimersByTimeAsync(MAX_RESTORE_ATTEMPTS * 2 * 1000);
    await flushPromises();

    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('giving up'));
    expect(stateFile.current).not.toBeNull();
  });

  it('keeps retrying a failed stop restore after the feature is turned off in settings', async () => {
    // Settings save with pvCurtailment.enabled=false while Venus is unreachable: the stop
    // restore fails, so ownsDisable is still set when the disabled config starts.
    startPvCurtailment(makeSettings());
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await flushPromises();
    expect(getPvCurtailmentStatus().ownsDisable).toBe(true);
    writeVictronSetting.mockRejectedValueOnce(new Error('Timeout after 10000ms waiting for publish'));
    await stopPvCurtailment();
    startPvCurtailment(makeSettings({ enabled: false }));
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: true, restorePending: true });

    // Venus is back: the standalone retry restores within one retry period.
    writeVictronSetting.mockClear();
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus()).toMatchObject({ ownsDisable: false, restorePending: false });

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS * 2);
    expect(writeVictronSetting).toHaveBeenCalledTimes(1);
  });

  it('does not give up on the Enphase switch early when a short tickMs retries more often', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal('fetch', fetchMock);
    stateFile.current = persisted({ serial: 'c0619ab6bd28', acsystemInstance: 0, enphaseSwitchEntity: 'switch.envoy' });
    startPvCurtailment({
      haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'tok',
      ...makeSettings({ tickMs: 1000, enphaseSwitchEntity: 'switch.envoy' }),
    });
    await reconcilePvCurtailmentAtBoot();

    // HA restarting for a couple of minutes: far more than MAX_RESTORE_ATTEMPTS calls fail...
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(MAX_RESTORE_ATTEMPTS);
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('giving up'));
    expect(stateFile.current).not.toBeNull();

    // ...then HA answers again and the switch is turned back on.
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('gives up on a failing Enphase switch only once RESTORE_GIVE_UP_MS has passed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    stateFile.current = persisted({ serial: 'c0619ab6bd28', acsystemInstance: 0, enphaseSwitchEntity: 'switch.renamed' });
    startPvCurtailment({
      haUrl: 'ws://homeassistant.local:8123/api/websocket', haToken: 'tok',
      ...makeSettings({ tickMs: 1000, enphaseSwitchEntity: 'switch.renamed' }),
    });
    await reconcilePvCurtailmentAtBoot();
    await vi.advanceTimersByTimeAsync(RESTORE_GIVE_UP_MS - 2000);
    await flushPromises();
    expect(stateFile.current).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('giving up turning switch.renamed back on'));
    expect(stateFile.current).toBeNull();
  });

  it('restores with the current settings when the persisted record is unreadable', async () => {
    stateFile.current = 'unreadable';
    startPvCurtailment(makeSettings({ enabled: false, acsystemInstance: 1 }));
    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/1/Pv/Disable', 0, { serial: 'c0619ab6bd28' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('record is unreadable'));
    expect(clearPvCurtailmentState).toHaveBeenCalled();
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('detects the serial for an unreadable record when no portal id is configured', async () => {
    stateFile.current = 'unreadable';
    startPvCurtailment(makeSettings({ enabled: false, portalId: '' }));
    await reconcilePvCurtailmentAtBoot();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'detected-serial' });
    expect(stateFile.current).toBeNull();
  });

  it('keeps an unreadable record pending and retries when the serial cannot be detected at boot', async () => {
    stateFile.current = 'unreadable';
    getVictronSerial.mockRejectedValueOnce(new Error('serial timeout'));
    startPvCurtailment(makeSettings({ enabled: false, portalId: '' }));
    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not resolve the Victron serial'), 'serial timeout');
    expect(stateFile.current).toBe('unreadable');
    expect(getPvCurtailmentStatus().restorePending).toBe(true);

    // The GX answers on the next retry: the serial is detected and PV restored.
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'detected-serial' });
    expect(stateFile.current).toBeNull();
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });

  it('retries an unreadable record from the live loop when the serial cannot be detected at boot', async () => {
    stateFile.current = 'unreadable';
    getVictronSerial.mockRejectedValueOnce(new Error('serial timeout'));
    startPvCurtailment(makeSettings({ portalId: '' }));
    await reconcilePvCurtailmentAtBoot();
    expect(getPvCurtailmentStatus().restorePending).toBe(true);
    expect(stateFile.current).toBe('unreadable');

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(writeVictronSetting).toHaveBeenCalledWith('acsystem/0/Pv/Disable', 0, { serial: 'detected-serial' });
    expect(stateFile.current).toBeNull();
  });

  it('leaves an unreadable record for the next start without curtailment settings', async () => {
    stateFile.current = 'unreadable';
    startPvCurtailment({});
    await reconcilePvCurtailmentAtBoot();

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no PV curtailment settings'));
    expect(stateFile.current).toBe('unreadable');
    expect(getPvCurtailmentStatus().restorePending).toBe(false);
  });
});
