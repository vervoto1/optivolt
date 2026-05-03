import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  getVictronSerial: vi.fn().mockResolvedValue('detected-serial'),
  writeVictronSetting: vi.fn().mockResolvedValue(undefined),
}));

import { getVictronSerial, writeVictronSetting } from '../../../api/services/mqtt-service.ts';
import {
  getPvCurtailmentStatus,
  startPvCurtailment,
  stopPvCurtailment,
  updatePvCurtailmentPlan,
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
  await Promise.resolve();
  await Promise.resolve();
}

describe('pv-curtailment service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopPvCurtailment();
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
    await Promise.resolve();
    updatePvCurtailmentPlan(plan([row(0), row(1)]));
    await Promise.resolve();
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
      expect.stringContaining('failed to restore PV on stop'),
      'mqtt offline',
    );
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
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopPvCurtailment();
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
