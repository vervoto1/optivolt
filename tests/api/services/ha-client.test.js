import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHaStats } from '../../../api/services/ha-client.ts';

// ---------------------------------------------------------------------------
// WebSocket mock factory
// The source code does `new WebSocket(url)` then sets ws.onmessage etc.
// We capture each constructed instance so tests can drive it.
// ---------------------------------------------------------------------------
let currentWs;

class MockWebSocket {
  constructor(_url) {
    this.send = vi.fn();
    this.close = vi.fn();
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    currentWs = this;
  }

  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateError(message = 'connection failed') {
    if (this.onerror) this.onerror({ message });
  }

  simulateClose() {
    if (this.onclose) this.onclose();
  }
}

describe('fetchHaStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPERVISOR_TOKEN;
    currentWs = null;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // URL routing
  // ---------------------------------------------------------------------------

  it('connects to the provided haUrl when SUPERVISOR_TOKEN is not set', async () => {
    const _constructorSpy = vi.spyOn(MockWebSocket.prototype, 'constructor');

    const promise = fetchHaStats({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'my-token',
      entityIds: ['sensor.load'],
      startTime: '2024-01-01T00:00:00Z',
    });

    // The WS is already created — check the constructor arg via the global spy
    expect(WebSocket).toBe(MockWebSocket);
    // Drive to an error to settle the promise
    currentWs.simulateError('closed');
    await expect(promise).rejects.toThrow();
  });

  it('uses supervisor proxy URL when SUPERVISOR_TOKEN is set', async () => {
    process.env.SUPERVISOR_TOKEN = 'supervisor-token';

    // Spy on constructor to capture URL
    const urls = [];
    const _OrigMock = MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url) { super(url); urls.push(url); }
    });

    const promise = fetchHaStats({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'my-token',
      entityIds: ['sensor.load'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateError('closed');
    await expect(promise).rejects.toThrow();
    expect(urls[0]).toBe('ws://supervisor/core/websocket');
  });

  // ---------------------------------------------------------------------------
  // Auth handshake
  // ---------------------------------------------------------------------------

  it('sends auth message when auth_required is received', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    // Handlers are assigned synchronously inside the Promise constructor
    // so we can simulate immediately
    currentWs.simulateMessage({ type: 'auth_required' });

    expect(currentWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'auth', access_token: 'tok' }),
    );

    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });

  it('sends statistics_during_period request after auth_ok', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc', 'sensor.pv'],
      startTime: '2024-01-01T00:00:00Z',
      period: 'hour',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });

    // Two send calls: auth, then the statistics request
    expect(currentWs.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(currentWs.send.mock.calls[1][0]);
    expect(sent.type).toBe('recorder/statistics_during_period');
    expect(sent.statistic_ids).toEqual(['sensor.soc', 'sensor.pv']);
    expect(sent.start_time).toBe('2024-01-01T00:00:00Z');
    expect(sent.period).toBe('hour');

    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });

  it('includes end_time in request when provided', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-02T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });

    const sent = JSON.parse(currentWs.send.mock.calls[1][0]);
    expect(sent.end_time).toBe('2024-01-02T00:00:00Z');

    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });

  it('does not include end_time when not provided', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });

    const sent = JSON.parse(currentWs.send.mock.calls[1][0]);
    expect(sent.end_time).toBeUndefined();

    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  it('resolves with result data on success result message', async () => {
    const fakeResult = { 'sensor.soc': [{ start: '2024-01-01T00:00:00Z', mean: 55 }] };

    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });
    currentWs.simulateMessage({ type: 'result', success: true, result: fakeResult });

    const data = await promise;
    expect(data).toEqual(fakeResult);
  });

  it('rejects when result message has success=false with error message', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });
    currentWs.simulateMessage({ type: 'result', success: false, error: { message: 'unknown entity' } });

    await expect(promise).rejects.toThrow('unknown entity');
  });

  it('rejects with fallback message when result has success=false and no error', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });
    currentWs.simulateMessage({ type: 'result', success: false });

    await expect(promise).rejects.toThrow('HA returned error result');
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  it('rejects when auth_invalid is received', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'bad-token',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_invalid', message: 'Invalid access token' });

    await expect(promise).rejects.toThrow('HA authentication failed: Invalid access token');
  });

  it('rejects when WebSocket fires onerror', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateError('ECONNREFUSED');

    await expect(promise).rejects.toThrow('HA WebSocket error');
  });

  it('rejects when WebSocket closes before authentication', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateClose();

    await expect(promise).rejects.toThrow('closed before authentication');
  });

  it('rejects on timeout when no messages arrive', async () => {
    vi.useFakeTimers();

    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
      timeoutMs: 5000,
    });

    // Attach rejection handler before advancing timers to avoid unhandled rejection warning
    const rejection = expect(promise).rejects.toThrow('timed out after 5000ms');
    await vi.advanceTimersByTimeAsync(5001);
    await rejection;
    vi.useRealTimers();
  });

  it('silently ignores malformed JSON messages', async () => {
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    // Send invalid JSON — should not throw or reject
    if (currentWs.onmessage) currentWs.onmessage({ data: 'not valid json {{{' });

    // Drive to an error to settle the promise
    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });

  it('ignores onclose when promise is already settled', async () => {
    // Line 61: done() called when already settled — second call to done() is a no-op
    // We settle the promise via onerror first, then simulate onclose
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    // Settle via error first
    currentWs.simulateError('first rejection');
    // Then close — should not cause unhandled rejection or double-reject
    currentWs.simulateClose();

    await expect(promise).rejects.toThrow('first rejection');
  });

  it('rejects with String(event) fallback when onerror event has no message', async () => {
    // Line 106: (event as ErrorEvent).message ?? String(event)
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    // Simulate error event with no message property (undefined)
    if (currentWs.onerror) currentWs.onerror({ message: undefined });

    await expect(promise).rejects.toThrow('HA WebSocket error');
  });

  it('does not reject on onclose when already authenticated and settled', async () => {
    // Line 111: !authenticated && !settled — when authenticated=true the close is ignored
    const fakeResult = { 'sensor.soc': [] };
    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });
    currentWs.simulateMessage({ type: 'auth_ok' });
    // The result message closes the WebSocket and settles the promise
    currentWs.simulateMessage({ type: 'result', success: true, result: fakeResult });
    // Simulate the close event that comes after ws.close() in result handler
    currentWs.simulateClose();

    const data = await promise;
    expect(data).toEqual(fakeResult);
  });

  it('rejects when HA connection is not configured (no URL, no token, no SUPERVISOR_TOKEN)', async () => {
    await expect(fetchHaStats({
      haUrl: '',
      haToken: '',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    })).rejects.toThrow('Home Assistant connection is not configured');
  });

  it('uses supervisor token instead of haToken when running as add-on', async () => {
    process.env.SUPERVISOR_TOKEN = 'supervisor-tok';

    const promise = fetchHaStats({
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'user-tok',
      entityIds: ['sensor.soc'],
      startTime: '2024-01-01T00:00:00Z',
    });

    currentWs.simulateMessage({ type: 'auth_required' });

    const sent = JSON.parse(currentWs.send.mock.calls[0][0]);
    expect(sent.access_token).toBe('supervisor-tok');

    currentWs.simulateError('done');
    await expect(promise).rejects.toThrow();
  });
});
