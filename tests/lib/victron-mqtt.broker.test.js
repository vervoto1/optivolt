// Socket-level tests: the real mqtt.js against a fake broker on 127.0.0.1.
// mqtt >= 5.16 stops auto-reconnecting after a refused CONNACK unless
// `reconnectOnConnackError` is set, and while the client is offline every
// publish/subscribe sits in its queue unsettled. These scenarios pin down that
// the cached client recovers on its own and that no call can hang or leave an
// orphaned rejection behind (vitest fails the run on an unhandled rejection).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VictronMqttClient } from '../../lib/victron-mqtt.ts';
import { startFakeBroker, SERIAL } from './helpers/fake-mqtt-broker.js';

const RECONNECT_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met');
    await sleep(10);
  }
}

describe('VictronMqttClient against a broker that refuses CONNACK', () => {
  let broker;
  let client;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    broker = await startFakeBroker();
  });

  afterEach(async () => {
    client?.forceClose();
    client = undefined;
    await broker.close();
    vi.restoreAllMocks();
  });

  function makeClient(overrides = {}) {
    client = new VictronMqttClient({
      host: '127.0.0.1',
      port: broker.port,
      reconnectPeriod: RECONNECT_MS,
      opTimeoutMs: 600,
      ...overrides,
    });
    return client;
  }

  it('recovers by itself after a refused reconnect once the broker accepts again', async () => {
    const vc = makeClient();
    await expect(vc.readSocPercent({ timeoutMs: 1000 })).resolves.toMatchObject({ soc_percent: 57 });

    broker.dropAll();
    await waitFor(() => broker.state.refused >= 1);
    broker.state.acceptAll = true;
    await waitFor(() => broker.state.accepted >= 2);

    await expect(vc.readSocPercent({ timeoutMs: 1000 })).resolves.toMatchObject({ soc_percent: 57 });
    await vc.writeSetting('settings/0/Settings/DynamicEss/Schedule/0/Soc', 80, { serial: SERIAL });
    await waitFor(() => broker.state.publishesReceived.some(p => p.topic === `W/${SERIAL}/settings/0/Settings/DynamicEss/Schedule/0/Soc`));
  });

  it('keeps retrying while refused, and every call settles in bounded time', async () => {
    const vc = makeClient();
    await vc.getSerial({ timeoutMs: 1000 });

    broker.dropAll();
    // Reconnects are not suppressed by the refusal: the same client keeps trying.
    await waitFor(() => broker.state.refused >= 3);

    const readStarted = Date.now();
    await expect(vc.readSocPercent({ timeoutMs: 500 })).rejects.toThrow();
    expect(Date.now() - readStarted).toBeLessThan(1500);

    const writeStarted = Date.now();
    await expect(vc.writeSetting('settings/0/Settings/DynamicEss/Mode', 4, { serial: SERIAL })).rejects.toThrow();
    expect(Date.now() - writeStarted).toBeLessThan(1500);

    // The stalled client was evicted; the next call connects afresh (and is refused).
    const connectsBefore = broker.state.connects;
    await expect(vc.subscribeJson(`N/${SERIAL}/x`, () => {})).rejects.toThrow(/Not authorized|refused/i);
    expect(broker.state.connects).toBeGreaterThan(connectsBefore);

    // Once the broker accepts again a fresh connection works.
    broker.state.acceptAll = true;
    await expect(vc.readSocPercent({ timeoutMs: 1000 })).resolves.toMatchObject({ soc_percent: 57 });
  });

  it('keeps a subscribeJson subscription alive across an eviction', async () => {
    const vc = makeClient();
    const seen = [];
    const topic = `N/${SERIAL}/system/0/Dc/Battery/Soc`;
    await vc.subscribeJson(topic, (_t, payload) => seen.push(payload), { requestTopic: `R/${SERIAL}/system/0/Dc/Battery/Soc` });
    await waitFor(() => seen.length === 1);

    broker.dropAll();
    await waitFor(() => broker.state.refused >= 1);
    // A write while refused stalls past the op deadline and evicts the client.
    await expect(vc.writeSetting('settings/0/Settings/DynamicEss/Mode', 4, { serial: SERIAL })).rejects.toThrow();

    broker.state.acceptAll = true;
    await vc.requestSetting('system/0/Dc/Battery/Soc', { serial: SERIAL });
    // The re-attached subscription answers both its own re-request and ours.
    await waitFor(() => seen.length >= 2);
    expect(seen.at(-1)).toEqual({ value: 57 });
  });

  it('rejects when the very first CONNECT is refused and leaves no zombie client retrying', async () => {
    broker.state.acceptNext = 0;
    const vc = makeClient();
    await expect(vc.getSerial({ timeoutMs: 1000 })).rejects.toThrow(/Not authorized|refused/i);

    const connectsAfterFailure = broker.state.connects;
    await sleep(3 * RECONNECT_MS + 100);
    expect(broker.state.connects).toBe(connectsAfterFailure);

    broker.state.acceptAll = true;
    await expect(vc.getSerial({ timeoutMs: 1000 })).resolves.toBe(SERIAL);
  });

  it('rejects a SoC read during a plain TCP outage instead of crashing', async () => {
    const vc = makeClient();
    await vc.readSocPercent({ timeoutMs: 1000 });

    await broker.close();
    await expect(vc.readSocPercent({ timeoutMs: 500 })).rejects.toThrow();
    await expect(vc.writeSetting('settings/0/Settings/DynamicEss/Mode', 4, { serial: SERIAL })).rejects.toThrow();
    // Give any stray timers a chance to fire an orphaned rejection.
    await sleep(700);
  });

  it('forceClose cuts short a graceful close the broker never completes', async () => {
    broker.state.acceptAll = true;
    const vc = makeClient();
    await vc.writeSetting('settings/0/Settings/DynamicEss/Mode', 4, { serial: SERIAL });

    broker.state.ignoreDisconnect = true;
    let closed = false;
    const closing = vc.close().then(() => { closed = true; });
    await sleep(200);
    expect(closed).toBe(false);

    vc.forceClose();
    await closing;
    expect(closed).toBe(true);
    // The QoS-0 write before the close still went out.
    expect(broker.state.publishesReceived.some(p => p.topic === `W/${SERIAL}/settings/0/Settings/DynamicEss/Mode`)).toBe(true);
  });
});
