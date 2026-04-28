import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist the mock mqtt client so it is available inside vi.mock() factory
// ---------------------------------------------------------------------------
const { mockMqttClient } = vi.hoisted(() => {
  const handlers = {};

  const client = {
    publishAsync: vi.fn().mockResolvedValue(undefined),
    subscribeAsync: vi.fn().mockResolvedValue(undefined),
    unsubscribeAsync: vi.fn().mockResolvedValue(undefined),
    endAsync: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event, handler) => {
      handlers[event] = handler;
    }),
    off: vi.fn().mockImplementation((event, _handler) => {
      delete handlers[event];
    }),
    emit: (event, ...args) => {
      if (handlers[event]) handlers[event](...args);
    },
  };

  return { mockMqttClient: client };
});

// Mock the mqtt module — factory runs at hoist time so mockMqttClient is defined
vi.mock('mqtt', () => ({
  default: {
    connectAsync: vi.fn().mockResolvedValue(mockMqttClient),
  },
}));

import mqtt from 'mqtt';
import { VictronMqttClient, withVictronMqtt } from '../../lib/victron-mqtt.ts';

// ---------------------------------------------------------------------------
// Helper: emit a simulated MQTT message after a microtask delay
// ---------------------------------------------------------------------------
function scheduleMessage(topic, payload, delayMs = 5) {
  setTimeout(() => {
    mockMqttClient.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  }, delayMs);
}

describe('VictronMqttClient — constructor defaults', () => {
  it('sets default host to venus.local', () => {
    const client = new VictronMqttClient();
    expect(client.host).toBe('venus.local');
  });

  it('defaults tls to false and port to 1883', () => {
    const client = new VictronMqttClient();
    expect(client.tls).toBe(false);
    expect(client.port).toBe(1883);
  });

  it('sets port 8883 and protocol mqtts when tls is true', () => {
    const client = new VictronMqttClient({ tls: true });
    expect(client.port).toBe(8883);
    expect(client.protocol).toBe('mqtts');
  });

  it('uses provided serial without detecting', () => {
    const client = new VictronMqttClient({ serial: 'abc123' });
    expect(client.serial).toBe('abc123');
  });

  it('defaults reconnectPeriod to 0', () => {
    const client = new VictronMqttClient();
    expect(client.reconnectPeriod).toBe(0);
  });

  it('uses explicit port over tls-derived default', () => {
    const client = new VictronMqttClient({ tls: true, port: 9999 });
    expect(client.port).toBe(9999);
  });

  it('defaults rejectUnauthorized to true', () => {
    const client = new VictronMqttClient();
    expect(client.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized to false when passed', () => {
    const client = new VictronMqttClient({ rejectUnauthorized: false });
    expect(client.rejectUnauthorized).toBe(false);
  });

  it('converts empty string username to undefined', () => {
    const client = new VictronMqttClient({ username: '' });
    expect(client.username).toBeUndefined();
  });

  it('preserves non-empty username', () => {
    const client = new VictronMqttClient({ username: 'user1' });
    expect(client.username).toBe('user1');
  });
});

describe('VictronMqttClient — getSerial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
    // Reset handlers
    Object.keys(mockMqttClient.on.mock).forEach(() => {});
  });

  it('returns cached serial without MQTT call when serial is set', async () => {
    const client = new VictronMqttClient({ serial: 'cached-serial' });
    const result = await client.getSerial();
    expect(result).toBe('cached-serial');
    expect(mqtt.connectAsync).not.toHaveBeenCalled();
  });

  it('detects serial via MQTT subscription when not cached', async () => {
    const client = new VictronMqttClient();
    // Schedule the serial message to arrive after subscribe
    scheduleMessage('N/myserial/system/0/Serial', { value: 'detected-serial' });

    const result = await client.getSerial({ timeoutMs: 500 });
    expect(result).toBe('detected-serial');
    expect(client.serial).toBe('detected-serial');
  });

  it('caches detected serial for subsequent calls', async () => {
    const client = new VictronMqttClient();
    scheduleMessage('N/myserial/system/0/Serial', { value: 'serial-xyz' });

    await client.getSerial({ timeoutMs: 500 });
    // Second call — no message scheduled, should use cache
    const result2 = await client.getSerial({ timeoutMs: 100 });
    expect(result2).toBe('serial-xyz');
  });

  it('rejects when no serial message arrives within timeout', async () => {
    const client = new VictronMqttClient();
    // No message scheduled
    await expect(client.getSerial({ timeoutMs: 30 })).rejects.toThrow('Timeout');
  });
});

describe('VictronMqttClient — readSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('publishes to R/<serial>/<path> to request value', async () => {
    const client = new VictronMqttClient({ serial: 'test-serial' });
    const path = 'system/0/Dc/Battery/Soc';

    // Schedule response on N/<serial>/<path>
    scheduleMessage(`N/test-serial/${path}`, { value: 75 });

    await client.readSetting(path, { serial: 'test-serial', timeoutMs: 500 });

    expect(mockMqttClient.publishAsync).toHaveBeenCalledWith(
      `R/test-serial/${path}`,
      '',
    );
  });

  it('subscribes to N/<serial>/<path> before requesting', async () => {
    const client = new VictronMqttClient({ serial: 'test-serial' });
    const path = 'settings/0/Settings/DynamicEss/Mode';

    scheduleMessage(`N/test-serial/${path}`, { value: 4 });

    await client.readSetting(path, { serial: 'test-serial', timeoutMs: 500 });

    expect(mockMqttClient.subscribeAsync).toHaveBeenCalledWith(
      `N/test-serial/${path}`,
    );
  });

  it('returns the JSON payload from the response', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'settings/0/Settings/DynamicEss/Mode';

    scheduleMessage(`N/ser1/${path}`, { value: 4 });

    const result = await client.readSetting(path, { serial: 'ser1', timeoutMs: 500 });
    expect(result).toEqual({ value: 4 });
  });

  it('rejects on timeout when no response arrives', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await expect(
      client.readSetting('some/path', { serial: 'ser1', timeoutMs: 20 }),
    ).rejects.toThrow('Timeout');
  });
});

describe('VictronMqttClient — writeSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('publishes to W/<serial>/<path> with {"value": X}', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeSetting('settings/0/Settings/DynamicEss/Mode', 4, { serial: 'ser1' });

    expect(mockMqttClient.publishAsync).toHaveBeenCalledWith(
      'W/ser1/settings/0/Settings/DynamicEss/Mode',
      JSON.stringify({ value: 4 }),
      { qos: 0, retain: false },
    );
  });

  it('writes string values correctly', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeSetting('some/path', 'hello', { serial: 'ser1' });

    expect(mockMqttClient.publishAsync).toHaveBeenCalledWith(
      'W/ser1/some/path',
      JSON.stringify({ value: 'hello' }),
      expect.any(Object),
    );
  });
});

describe('VictronMqttClient — requestSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('publishes an empty payload to R/<serial>/<path>', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.requestSetting('multi/6/Pv/0/MppOperationMode', { serial: 'ser1' });

    expect(mockMqttClient.publishAsync).toHaveBeenCalledWith(
      'R/ser1/multi/6/Pv/0/MppOperationMode',
      '',
      { qos: 0, retain: false },
    );
  });
});

describe('VictronMqttClient — subscribeJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('subscribes, requests an update, and forwards parsed payloads', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const handler = vi.fn();
    const unsubscribe = await client.subscribeJson(
      'N/ser1/multi/6/Ac/In/1/CurrentLimit',
      handler,
      { requestTopic: 'R/ser1/multi/6/Ac/In/1/CurrentLimit' },
    );

    mockMqttClient.emit(
      'message',
      'N/ser1/multi/6/Ac/In/1/CurrentLimit',
      Buffer.from(JSON.stringify({ value: 12.5 })),
    );

    expect(mockMqttClient.subscribeAsync).toHaveBeenCalledWith('N/ser1/multi/6/Ac/In/1/CurrentLimit');
    expect(mockMqttClient.publishAsync).toHaveBeenCalledWith('R/ser1/multi/6/Ac/In/1/CurrentLimit', '');
    expect(handler).toHaveBeenCalledWith('N/ser1/multi/6/Ac/In/1/CurrentLimit', { value: 12.5 });

    await unsubscribe();
    expect(mockMqttClient.unsubscribeAsync).toHaveBeenCalledWith('N/ser1/multi/6/Ac/In/1/CurrentLimit');
  });
});

describe('VictronMqttClient — _getClient error handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('registers an error event handler on the mqtt client', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    // Trigger client creation
    await client.writeSetting('some/path', 1, { serial: 'ser1' });

    const errorHandlerCall = mockMqttClient.on.mock.calls.find(c => c[0] === 'error');
    expect(errorHandlerCall).toBeDefined();
    // The error handler should not throw when called
    expect(() => errorHandlerCall[1](new Error('test error'))).not.toThrow();
  });
});

describe('VictronMqttClient — _waitForFirstMessage edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('ignores messages for a different topic (matchFn returns undefined)', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';

    // Send wrong topic first, then correct topic
    setTimeout(() => {
      mockMqttClient.emit('message', 'N/ser1/wrong/topic', Buffer.from(JSON.stringify({ value: 99 })));
    }, 5);
    setTimeout(() => {
      mockMqttClient.emit('message', `N/ser1/${path}`, Buffer.from(JSON.stringify({ value: 42 })));
    }, 15);

    const result = await client.readJsonOnce(`N/ser1/${path}`, { timeoutMs: 500 });
    expect(result).toEqual({ value: 42 });
  });

  it('ignores handler invocations after already settled (double resolve guard)', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';

    // Send correct topic twice — second should be silently ignored
    setTimeout(() => {
      mockMqttClient.emit('message', `N/ser1/${path}`, Buffer.from(JSON.stringify({ value: 55 })));
      mockMqttClient.emit('message', `N/ser1/${path}`, Buffer.from(JSON.stringify({ value: 99 })));
    }, 5);

    const result = await client.readJsonOnce(`N/ser1/${path}`, { timeoutMs: 500 });
    // Should resolve with the first value, not crash
    expect(result).toEqual({ value: 55 });
  });

  it('rejects when matchFn throws an error (malformed JSON in readJsonOnce)', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const topic = 'N/ser1/some/path';

    // Send malformed JSON — readJsonOnce matchFn calls JSON.parse which will throw
    setTimeout(() => {
      mockMqttClient.emit('message', topic, Buffer.from('not-valid-json{{{'));
    }, 5);

    await expect(client.readJsonOnce(topic, { timeoutMs: 500 })).rejects.toThrow();
  });
});

describe('VictronMqttClient — readSocPercent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('returns soc_percent when value is a valid number', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';
    scheduleMessage(`N/ser1/${path}`, { value: 65.5 });

    const result = await client.readSocPercent({ timeoutMs: 500 });
    expect(result.soc_percent).toBeCloseTo(65.5);
  });

  it('clamps soc_percent to [0, 100]', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';
    scheduleMessage(`N/ser1/${path}`, { value: 150 });

    const result = await client.readSocPercent({ timeoutMs: 500 });
    expect(result.soc_percent).toBe(100);
  });

  it('returns soc_percent null when value is an array', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';
    // Simulate Victron sending [] for missing SoC
    scheduleMessage(`N/ser1/${path}`, { value: [] });

    const result = await client.readSocPercent({ timeoutMs: 500 });
    expect(result.soc_percent).toBeNull();
  });

  it('returns soc_percent null when value is null', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';
    scheduleMessage(`N/ser1/${path}`, { value: null });

    const result = await client.readSocPercent({ timeoutMs: 500 });
    expect(result.soc_percent).toBeNull();
  });

  it('returns soc_percent null when value is non-finite (NaN)', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    const path = 'system/0/Dc/Battery/Soc';
    // JSON.stringify(NaN) produces "null", so send a string that Number() makes NaN
    scheduleMessage(`N/ser1/${path}`, { value: 'not-a-number' });

    const result = await client.readSocPercent({ timeoutMs: 500 });
    expect(result.soc_percent).toBeNull();
    expect(result.raw).toBeDefined();
  });
});

describe('VictronMqttClient — writeScheduleSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('writes both Soc and TargetSoc when socTarget is provided', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(2, {
      startEpoch: 1700000000,
      durationSeconds: 900,
      strategy: 2,
      flags: 0,
      socTarget: 80,
      restrictions: 0,
      allowGridFeedIn: 1,
    }, { serial: 'ser1' });

    const publishedTopics = mockMqttClient.publishAsync.mock.calls.map(c => c[0]);
    expect(publishedTopics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/2/Soc');
    expect(publishedTopics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/2/TargetSoc');
  });

  it('writes both Soc and TargetSoc with the same value', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(0, { socTarget: 70 }, { serial: 'ser1' });

    const socCall = mockMqttClient.publishAsync.mock.calls.find(c =>
      c[0] === 'W/ser1/settings/0/Settings/DynamicEss/Schedule/0/Soc',
    );
    const targetSocCall = mockMqttClient.publishAsync.mock.calls.find(c =>
      c[0] === 'W/ser1/settings/0/Settings/DynamicEss/Schedule/0/TargetSoc',
    );
    expect(JSON.parse(socCall[1])).toEqual({ value: 70 });
    expect(JSON.parse(targetSocCall[1])).toEqual({ value: 70 });
  });

  it('does not write Soc or TargetSoc when socTarget is undefined', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(0, { strategy: 2 }, { serial: 'ser1' });

    const publishedTopics = mockMqttClient.publishAsync.mock.calls.map(c => c[0]);
    expect(publishedTopics).not.toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/0/Soc');
    expect(publishedTopics).not.toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/0/TargetSoc');
  });

  it('writes Start, Duration, Strategy, Flags, Restrictions, AllowGridFeedIn fields', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(3, {
      startEpoch: 1700000000,
      durationSeconds: 900,
      strategy: 3,
      flags: 1,
      restrictions: 2,
      allowGridFeedIn: 0,
    }, { serial: 'ser1' });

    const topics = mockMqttClient.publishAsync.mock.calls.map(c => c[0]);
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/Start');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/Duration');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/Strategy');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/Flags');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/Restrictions');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/3/AllowGridFeedIn');
  });

  it('only writes fields that are defined in the slot', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(0, { strategy: 2 }, { serial: 'ser1' });

    // Only Strategy should be published
    expect(mockMqttClient.publishAsync).toHaveBeenCalledTimes(1);
  });

  it('writes all expected MQTT topics for a full schedule slot', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeScheduleSlot(1, {
      startEpoch: 1700000000,
      durationSeconds: 900,
      strategy: 2,
      flags: 0,
      socTarget: 75,
      restrictions: 1,
      allowGridFeedIn: 1,
    }, { serial: 'ser1' });

    const topics = mockMqttClient.publishAsync.mock.calls.map(c => c[0]);
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Start');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Duration');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Strategy');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Flags');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Soc');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/TargetSoc');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Restrictions');
    expect(topics).toContain('W/ser1/settings/0/Settings/DynamicEss/Schedule/1/AllowGridFeedIn');
    // Soc and TargetSoc both carry the same value
    const flagsCall = mockMqttClient.publishAsync.mock.calls.find(c =>
      c[0] === 'W/ser1/settings/0/Settings/DynamicEss/Schedule/1/Flags',
    );
    expect(JSON.parse(flagsCall[1])).toEqual({ value: 0 });
  });
});

describe('VictronMqttClient — close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('does nothing when client was never connected', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    // No _clientPromise set
    await client.close();
    expect(mockMqttClient.endAsync).not.toHaveBeenCalled();
  });

  it('calls endAsync on the underlying mqtt client', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    // Force client creation by writing a setting
    await client.writeSetting('some/path', 1, { serial: 'ser1' });
    await client.close();
    expect(mockMqttClient.endAsync).toHaveBeenCalled();
  });

  it('clears the client promise after close', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    await client.writeSetting('some/path', 1, { serial: 'ser1' });
    await client.close();
    // Calling close again should not call endAsync a second time
    await client.close();
    expect(mockMqttClient.endAsync).toHaveBeenCalledTimes(1);
  });
});

describe('VictronMqttClient — readSocLimitsPercent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  // readSocLimitsPercent calls readSetting in parallel for two topics.
  // The mock mqtt client only stores one 'message' handler at a time, so
  // concurrent readSetting calls interfere. We stub readSetting directly to
  // test the normalization logic in readSocLimitsPercent.

  it('returns minSoc_percent and maxSoc_percent from their MQTT topics', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    vi.spyOn(client, 'readSetting').mockImplementation(async (path) => {
      if (path.includes('MinimumSocLimit')) return { value: 20 };
      if (path.includes('MaxChargePercentage')) return { value: 95 };
      return null;
    });

    const result = await client.readSocLimitsPercent({ timeoutMs: 500 });
    expect(result.minSoc_percent).toBe(20);
    expect(result.maxSoc_percent).toBe(95);
  });

  it('returns null for minSoc_percent when value is null', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    vi.spyOn(client, 'readSetting').mockImplementation(async (path) => {
      if (path.includes('MinimumSocLimit')) return { value: null };
      if (path.includes('MaxChargePercentage')) return { value: 90 };
      return null;
    });

    const result = await client.readSocLimitsPercent({ timeoutMs: 500 });
    expect(result.minSoc_percent).toBeNull();
    expect(result.maxSoc_percent).toBe(90);
  });

  it('clamps values to [0, 100]', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    vi.spyOn(client, 'readSetting').mockImplementation(async (path) => {
      if (path.includes('MinimumSocLimit')) return { value: -5 };
      if (path.includes('MaxChargePercentage')) return { value: 150 };
      return null;
    });

    const result = await client.readSocLimitsPercent({ timeoutMs: 500 });
    expect(result.minSoc_percent).toBe(0);
    expect(result.maxSoc_percent).toBe(100);
  });

  it('includes raw payloads in the result', async () => {
    const client = new VictronMqttClient({ serial: 'ser1' });
    vi.spyOn(client, 'readSetting').mockImplementation(async (path) => {
      if (path.includes('MinimumSocLimit')) return { value: 10 };
      if (path.includes('MaxChargePercentage')) return { value: 85 };
      return null;
    });

    const result = await client.readSocLimitsPercent({ timeoutMs: 500 });
    expect(result.raw).toHaveProperty('min');
    expect(result.raw).toHaveProperty('max');
    expect(result.raw.min).toEqual({ value: 10 });
    expect(result.raw.max).toEqual({ value: 85 });
  });
});

describe('VictronMqttClient — getSerial concurrent calls (line 120,163)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('reuses in-flight _serialPromise when called concurrently (line 120)', async () => {
    const client = new VictronMqttClient();
    // Schedule message to arrive after both calls are in flight
    scheduleMessage('N/myserial/system/0/Serial', { value: 'concurrent-serial' }, 20);

    // Both calls start concurrently — second should reuse _serialPromise
    const [r1, r2] = await Promise.all([
      client.getSerial({ timeoutMs: 500 }),
      client.getSerial({ timeoutMs: 500 }),
    ]);
    expect(r1).toBe('concurrent-serial');
    expect(r2).toBe('concurrent-serial');
  });

  it('clears _serialPromise after timeout so a later call can retry (line 163)', async () => {
    const client = new VictronMqttClient();
    // First call times out — no message scheduled
    await expect(client.getSerial({ timeoutMs: 20 })).rejects.toThrow('Timeout');
    // _serialPromise should now be null, allowing a retry
    expect(client._serialPromise).toBeNull();
    // Second call should also timeout (no message) but not reuse the failed promise
    await expect(client.getSerial({ timeoutMs: 20 })).rejects.toThrow('Timeout');
  });
});

describe('withVictronMqtt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mqtt.connectAsync.mockResolvedValue(mockMqttClient);
  });

  it('calls the callback with a VictronMqttClient', async () => {
    let receivedClient;
    await withVictronMqtt({ serial: 'ser1' }, async (c) => {
      receivedClient = c;
      return 'done';
    });
    expect(receivedClient).toBeInstanceOf(VictronMqttClient);
  });

  it('returns the value from the callback', async () => {
    const result = await withVictronMqtt({ serial: 'ser1' }, async () => 42);
    expect(result).toBe(42);
  });

  it('calls close after the callback resolves', async () => {
    const closeSpy = vi.spyOn(VictronMqttClient.prototype, 'close');
    await withVictronMqtt({ serial: 'ser1' }, async () => 'ok');
    expect(closeSpy).toHaveBeenCalledOnce();
    closeSpy.mockRestore();
  });

  it('calls close even when callback throws', async () => {
    const closeSpy = vi.spyOn(VictronMqttClient.prototype, 'close');
    await expect(
      withVictronMqtt({ serial: 'ser1' }, async () => { throw new Error('fail'); }),
    ).rejects.toThrow('fail');
    expect(closeSpy).toHaveBeenCalledOnce();
    closeSpy.mockRestore();
  });
});
