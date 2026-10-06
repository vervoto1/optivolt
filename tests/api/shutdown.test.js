import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createShutdown,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_MQTT_CLOSE_TIMEOUT_MS,
  SHUTDOWN_RESTORE_TIMEOUT_MS,
} from '../../api/shutdown.ts';

function makeDeps(overrides = {}) {
  const order = [];
  const deps = {
    stopTimers: vi.fn(() => { order.push('stopTimers'); }),
    restorePv: vi.fn(async () => { order.push('restorePv'); }),
    closeMqtt: vi.fn(async () => { order.push('closeMqtt'); }),
    exit: vi.fn((code) => { order.push(`exit:${code}`); }),
    ...overrides,
  };
  return { deps, order };
}

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the whole budget inside s6-overlay\'s 3 s grace time', () => {
    expect(SHUTDOWN_RESTORE_TIMEOUT_MS + SHUTDOWN_MQTT_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(3000);
  });

  it('stops timers, restores PV, then closes MQTT, and exits 0', async () => {
    const { deps, order } = makeDeps();
    await createShutdown(deps)('SIGTERM');

    expect(order).toEqual(['stopTimers', 'restorePv', 'closeMqtt', 'exit:0']);
    expect(deps.restorePv).toHaveBeenCalledWith(SHUTDOWN_RESTORE_TIMEOUT_MS);
    expect(deps.closeMqtt).toHaveBeenCalledWith(SHUTDOWN_MQTT_CLOSE_TIMEOUT_MS);
  });

  it('a second signal does not re-run the shutdown', async () => {
    let releaseRestore;
    const { deps } = makeDeps({
      restorePv: vi.fn(() => new Promise((resolve) => { releaseRestore = resolve; })),
    });
    const shutdown = createShutdown(deps);

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGTERM');
    const third = shutdown('SIGINT');
    expect(second).toBe(first);
    expect(third).toBe(first);

    releaseRestore();
    await first;
    expect(deps.stopTimers).toHaveBeenCalledTimes(1);
    expect(deps.restorePv).toHaveBeenCalledTimes(1);
    expect(deps.closeMqtt).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('still closes MQTT and exits when the PV restore or the timers throw', async () => {
    const { deps, order } = makeDeps({
      stopTimers: vi.fn(() => { throw new Error('timer boom'); }),
      restorePv: vi.fn(async () => { throw new Error('restore boom'); }),
    });
    await createShutdown(deps)('SIGTERM');
    expect(order).toEqual(['closeMqtt', 'exit:0']);
    expect(console.warn).toHaveBeenCalledWith('[shutdown] PV restore failed:', 'restore boom');
  });

  it('exits 0 even when the MQTT close rejects', async () => {
    const { deps } = makeDeps({ closeMqtt: vi.fn(async () => { throw new Error('close boom'); }) });
    await createShutdown(deps)('SIGTERM');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('the hard-stop timer exits 1 when a step hangs past the deadline', async () => {
    const { deps } = makeDeps({ closeMqtt: vi.fn(() => new Promise(() => {})) });
    void createShutdown(deps)('SIGTERM');

    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(deps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('clears the hard-stop timer after a clean exit', async () => {
    const { deps } = makeDeps();
    await createShutdown(deps)('SIGTERM');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS * 2);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
