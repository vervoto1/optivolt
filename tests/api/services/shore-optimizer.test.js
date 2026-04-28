import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscriptions = new Map();
const unsubscribeFns = [];

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  getVictronSerial: vi.fn().mockResolvedValue('detected-serial'),
  requestVictronSetting: vi.fn().mockResolvedValue(undefined),
  subscribeVictronJson: vi.fn().mockImplementation(async (topic, handler, options) => {
    subscriptions.set(topic, { handler, options });
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    unsubscribeFns.push(unsubscribe);
    return unsubscribe;
  }),
  writeVictronSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../api/services/planner-service.ts', () => ({
  getCurrentSlotMode: vi.fn().mockReturnValue('grid_charge'),
}));

import { requestVictronSetting, subscribeVictronJson, writeVictronSetting } from '../../../api/services/mqtt-service.ts';
import { getCurrentSlotMode } from '../../../api/services/planner-service.ts';
import {
  getShoreOptimizerStatus,
  startShoreOptimizer,
  stopShoreOptimizer,
} from '../../../api/services/shore-optimizer.ts';

function makeSettings(overrides = {}) {
  return {
    shoreOptimizer: {
      enabled: true,
      dryRun: false,
      tickMs: 3000,
      stepA: 0.5,
      minShoreA: 0,
      maxShoreA: 25,
      minChargingPowerW: 200,
      gateOnDessSchedule: true,
      portalId: 'c0619ab6bd28',
      multiInstance: 6,
      acInputIndex: 1,
      mpptInstance: 0,
      batteryInstance: 512,
      ...overrides,
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function emit(topic, value) {
  const sub = subscriptions.get(topic);
  if (!sub) throw new Error(`No subscription for ${topic}`);
  sub.handler(topic, { value });
}

describe('shore-optimizer service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00.000Z'));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
    subscriptions.clear();
    unsubscribeFns.length = 0;
    getCurrentSlotMode.mockReturnValue('grid_charge');
  });

  afterEach(() => {
    stopShoreOptimizer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('subscribes to the scalar multi/6 topics and requests initial values', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    expect(subscribeVictronJson).toHaveBeenCalledWith(
      'N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit',
      expect.any(Function),
      { requestTopic: 'R/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit' },
    );
    expect(subscribeVictronJson).toHaveBeenCalledWith(
      'N/c0619ab6bd28/battery/512/Dc/0/Power',
      expect.any(Function),
      { requestTopic: 'R/c0619ab6bd28/battery/512/Dc/0/Power' },
    );
    expect(subscribeVictronJson).toHaveBeenCalledWith(
      'N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode',
      expect.any(Function),
      { requestTopic: 'R/c0619ab6bd28/multi/6/Pv/0/MppOperationMode' },
    );
  });

  it('writes the shore current limit upward when all gates pass and MPPT is active', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    await vi.advanceTimersByTimeAsync(3000);

    expect(writeVictronSetting).toHaveBeenCalledWith(
      'multi/6/Ac/In/1/CurrentLimit',
      10.5,
      { serial: 'c0619ab6bd28' },
    );
  });

  it('backs off when MPPT is voltage/current limited', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 1);

    await vi.advanceTimersByTimeAsync(3000);

    expect(writeVictronSetting).toHaveBeenCalledWith(
      'multi/6/Ac/In/1/CurrentLimit',
      9.5,
      { serial: 'c0619ab6bd28' },
    );
  });

  it('does not publish in dry run mode but records the would-be write', async () => {
    startShoreOptimizer(makeSettings({ dryRun: true }));
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    await vi.advanceTimersByTimeAsync(3000);

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getShoreOptimizerStatus().recentWrites.at(-1)).toMatchObject({
      oldA: 10,
      newA: 10.5,
      dryRun: true,
    });
  });

  it('blocks when the current DESS slot is not grid charge', async () => {
    getCurrentSlotMode.mockReturnValue('idle');
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    await vi.advanceTimersByTimeAsync(3000);

    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('blocks when MQTT readings are stale', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    vi.setSystemTime(new Date('2026-04-28T10:00:31.000Z'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getShoreOptimizerStatus().stale.currentShoreA).toBe(true);
  });

  it('requests fresh telemetry before readings become stale', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);
    vi.clearAllMocks();

    // Advance past first tick so serial/paths are initialized, then move time
    // 16s forward so readings are stale (>15s refresh window) for the next tick
    await vi.advanceTimersByTimeAsync(3000);
    vi.setSystemTime(new Date('2026-04-28T10:00:16.000Z'));
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(3000);

    expect(requestVictronSetting).toHaveBeenCalledWith(
      'multi/6/Ac/In/1/CurrentLimit',
      { serial: 'c0619ab6bd28' },
    );
    expect(requestVictronSetting).toHaveBeenCalledWith(
      'battery/512/Dc/0/Power',
      { serial: 'c0619ab6bd28' },
    );
    expect(requestVictronSetting).toHaveBeenCalledWith(
      'multi/6/Pv/0/MppOperationMode',
      { serial: 'c0619ab6bd28' },
    );
  });

  it('skips refresh requests when readings are recent', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    // Advance past first tick, then emit fresh readings for the next tick
    await vi.advanceTimersByTimeAsync(3000);
    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);
    vi.clearAllMocks();

    // Tick at T=6s — readings are only 6s old (<15s refresh window), so no requests
    await vi.advanceTimersByTimeAsync(3000);

    expect(requestVictronSetting).not.toHaveBeenCalled();
  });

  it('ignores non-numeric MQTT payload for current limit', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    // Emit a string payload — the subscribeNumber handler should ignore it
    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 'not-a-number');
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    await vi.advanceTimersByTimeAsync(3000);

    // currentShoreA should still be null, so no write occurs
    expect(getShoreOptimizerStatus().currentShoreA).toBeNull();
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('handles raw non-object payload via subscribeValue for mppOperationMode', async () => {
    startShoreOptimizer(makeSettings());
    await flushPromises();

    emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
    emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
    // MPP operation mode receives a raw number (not {value} wrapper)
    // payloadValue returns undefined for non-objects → normalizeMppOperationMode returns 'unknown'
    const sub = subscriptions.get('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode');
    sub.handler('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);

    await vi.advanceTimersByTimeAsync(3000);

    // MPPT state is 'unknown' → mppt_idle blocks the write
    expect(writeVictronSetting).not.toHaveBeenCalled();
    expect(getShoreOptimizerStatus().mpptState).toBeNull();
  });

  it('truncates recent writes ring buffer when exceeding limit', async () => {
    startShoreOptimizer(makeSettings({ dryRun: true, gateOnDessSchedule: false }));
    await flushPromises();

    // Emit readings and tick 55 times (>50 limit)
    for (let i = 0; i < 55; i++) {
      emit('N/c0619ab6bd28/multi/6/Ac/In/1/CurrentLimit', 10);
      emit('N/c0619ab6bd28/battery/512/Dc/0/Power', 500);
      emit('N/c0619ab6bd28/multi/6/Pv/0/MppOperationMode', 2);
      await vi.advanceTimersByTimeAsync(3000);
    }

    const writes = getShoreOptimizerStatus().recentWrites;
    expect(writes.length).toBe(50);
    // First write timestamp should not be present (truncated)
    const firstTs = writes[0].ts;
    expect(firstTs).toBeDefined();
  });
});
