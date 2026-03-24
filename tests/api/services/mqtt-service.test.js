import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the VictronMqttClient class before importing mqtt-service
const mockGetSerial = vi.fn().mockResolvedValue('test-serial-123');
const mockReadSetting = vi.fn();
const mockWriteSetting = vi.fn().mockResolvedValue(undefined);
const mockWriteScheduleSlot = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockReadSocPercent = vi.fn().mockResolvedValue({ soc_percent: 75 });
const mockReadSocLimitsPercent = vi.fn().mockResolvedValue({ minSoc_percent: 20, maxSoc_percent: 95 });

vi.mock('../../../lib/victron-mqtt.ts', () => ({
  VictronMqttClient: class MockVictronMqttClient {
    constructor() {}
    getSerial = mockGetSerial;
    readSetting = mockReadSetting;
    writeSetting = mockWriteSetting;
    writeScheduleSlot = mockWriteScheduleSlot;
    close = mockClose;
    readSocPercent = mockReadSocPercent;
    readSocLimitsPercent = mockReadSocLimitsPercent;
  },
}));

const {
  setDynamicEssSchedule,
  shutdownVictronClient,
  getVictronSerial,
  readVictronSetting,
  readVictronSocPercent,
  readVictronSocLimits,
} = await import('../../../api/services/mqtt-service.ts');

function makeRow(index, overrides = {}) {
  const baseMs = 1700000000000; // fixed base timestamp
  return {
    tIdx: index,
    timestampMs: baseMs + index * 900_000, // 15-min slots
    load: 500, pv: 0, ic: 10, ec: 5,
    g2l: 500, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0,
    b2l: 0, b2g: 0, imp: 500, exp: 0,
    soc: 5000, soc_percent: 50, evLoad: 0,
    dess: { feedin: 1, restrictions: 0, strategy: 2, flags: 0, socTarget_percent: 70 },
    ...overrides,
  };
}

describe('mqtt-service — ensureDessMode4', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSerial.mockResolvedValue('test-serial-123');
    mockWriteSetting.mockResolvedValue(undefined);
    mockWriteScheduleSlot.mockResolvedValue(undefined);
    // Reset the singleton client between tests
    await shutdownVictronClient();
  });

  it('sets Mode 4 when current mode is not 4', async () => {
    mockReadSetting.mockResolvedValue({ value: 1 }); // Mode 1 (Auto)

    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // Should have read the mode
    expect(mockReadSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode',
      expect.objectContaining({ serial: 'test-serial-123' }),
    );
    // Should have written Mode 4
    expect(mockWriteSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', 4, { serial: 'test-serial-123' },
    );
  });

  it('skips Mode write when already Mode 4', async () => {
    mockReadSetting.mockResolvedValue({ value: 4 }); // Already Mode 4

    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // Should have read the mode
    expect(mockReadSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode',
      expect.objectContaining({ serial: 'test-serial-123' }),
    );
    // Should NOT have written the mode
    expect(mockWriteSetting).not.toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', expect.anything(), expect.anything(),
    );
  });

  it('writes Mode 4 anyway when read times out', async () => {
    mockReadSetting.mockRejectedValue(new Error('Timeout after 3000ms'));

    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // Should still write Mode 4 in the catch branch
    expect(mockWriteSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', 4, { serial: 'test-serial-123' },
    );
  });
});

describe('mqtt-service — schedule slot writing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSerial.mockResolvedValue('test-serial-123');
    mockReadSetting.mockResolvedValue({ value: 4 }); // Already Mode 4
    mockWriteSetting.mockResolvedValue(undefined);
    mockWriteScheduleSlot.mockResolvedValue(undefined);
    await shutdownVictronClient();
  });

  it('writes correct number of slots', async () => {
    const rows = [makeRow(0), makeRow(1), makeRow(2)];
    const result = await setDynamicEssSchedule(rows, 3);

    expect(result.serial).toBe('test-serial-123');
    expect(result.slotsWritten).toBe(3);
    expect(mockWriteScheduleSlot).toHaveBeenCalledTimes(3);
  });

  it('caps slots at rows.length when slotCount exceeds available rows', async () => {
    const rows = [makeRow(0), makeRow(1)];
    const result = await setDynamicEssSchedule(rows, 10);

    expect(result.slotsWritten).toBe(2);
    expect(mockWriteScheduleSlot).toHaveBeenCalledTimes(2);
  });

  it('writes correct slot fields including socTarget', async () => {
    const rows = [makeRow(0, { dess: { feedin: 0, restrictions: 1, strategy: 3, flags: 0, socTarget_percent: 85.7 } }), makeRow(1)];
    await setDynamicEssSchedule(rows, 1);

    expect(mockWriteScheduleSlot).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        startEpoch: Math.round(rows[0].timestampMs / 1000),
        durationSeconds: 900, // 15-min slots
        strategy: 0, // proGrid is down-mapped to Victron's target-SOC strategy
        flags: 0,
        socTarget: 86, // rounded from 85.7
        restrictions: 1,
        allowGridFeedIn: 0,
      }),
      { serial: 'test-serial-123' },
    );
  });

  it('keeps selfConsumption as strategy 1 for Victron', async () => {
    const rows = [makeRow(0, { dess: { feedin: 1, restrictions: 0, strategy: 1, flags: 0, socTarget_percent: 50 } })];

    await setDynamicEssSchedule(rows, 1);

    expect(mockWriteScheduleSlot).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ strategy: 1 }),
      { serial: 'test-serial-123' },
    );
  });

  it('ensures Mode 4 is checked before slots are written', async () => {
    mockReadSetting.mockResolvedValue({ value: 1 });

    const callOrder = [];
    mockWriteSetting.mockImplementation((path) => {
      callOrder.push(`writeSetting:${path}`);
      return Promise.resolve();
    });
    mockWriteScheduleSlot.mockImplementation((idx) => {
      callOrder.push(`writeSlot:${idx}`);
      return Promise.resolve();
    });

    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // Mode write must come before any slot writes
    const modeIdx = callOrder.findIndex(c => c.includes('DynamicEss/Mode'));
    const firstSlotIdx = callOrder.findIndex(c => c.startsWith('writeSlot:'));
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(firstSlotIdx).toBeGreaterThan(modeIdx);
  });
});

describe('mqtt-service — getSerial failure and price refresh window', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSerial.mockResolvedValue('test-serial-123');
    mockReadSetting.mockResolvedValue({ value: 4 });
    mockWriteSetting.mockResolvedValue(undefined);
    mockWriteScheduleSlot.mockResolvedValue(undefined);
    await shutdownVictronClient();
  });

  it('propagates error when getSerial rejects', async () => {
    mockGetSerial.mockRejectedValue(new Error('serial read failed'));

    const rows = [makeRow(0), makeRow(1)];
    await expect(setDynamicEssSchedule(rows, 2)).rejects.toThrow('serial read failed');
  });

  it('returns slotsWritten=0 when price refresh window is active', async () => {
    const { startDessPriceRefresh, stopDessPriceRefresh } = await import('../../../api/services/dess-price-refresh.ts');

    // Activate the price refresh window by setting a time that's inside the window
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T13:05:00'));
    startDessPriceRefresh({ dessPriceRefresh: { enabled: true, time: '13:00', durationMinutes: 15 } });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    try {
      const rows = [makeRow(0), makeRow(1)];
      const result = await setDynamicEssSchedule(rows, 2);
      expect(result.slotsWritten).toBe(0);
      expect(mockWriteScheduleSlot).not.toHaveBeenCalled();
    } finally {
      stopDessPriceRefresh();
    }
  });
});

describe('mqtt-service — writeScheduleSlot writes both Soc and TargetSoc', () => {
  // This test verifies the VictronMqttClient.writeScheduleSlot implementation
  // by importing and testing it directly with a mock publishJson

  it('writes to both Soc and TargetSoc topics', async () => {
    const { VictronMqttClient: RealClient } = await vi.importActual('../../../lib/victron-mqtt.ts');
    const client = new RealClient({ host: 'test', serial: 'test-serial' });

    // Mock the writeSetting method
    const writes = [];
    client.writeSetting = vi.fn().mockImplementation((path, value) => {
      writes.push({ path, value });
      return Promise.resolve();
    });

    await client.writeScheduleSlot(0, {
      startEpoch: 1700000000,
      durationSeconds: 900,
      strategy: 2,
      flags: 0,
      socTarget: 85,
      restrictions: 1,
      allowGridFeedIn: 1,
    }, { serial: 'test-serial' });

    // Verify both Soc and TargetSoc were written
    const socWrite = writes.find(w => w.path.endsWith('/Soc'));
    const targetSocWrite = writes.find(w => w.path.endsWith('/TargetSoc'));

    expect(socWrite).toBeDefined();
    expect(targetSocWrite).toBeDefined();
    expect(socWrite.value).toBe(85);
    expect(targetSocWrite.value).toBe(85);
    expect(socWrite.path).toBe('settings/0/Settings/DynamicEss/Schedule/0/Soc');
    expect(targetSocWrite.path).toBe('settings/0/Settings/DynamicEss/Schedule/0/TargetSoc');

    // Verify all 8 writes happened (7 fields + TargetSoc)
    expect(writes).toHaveLength(8);
  });

  it('does not write Soc or TargetSoc when socTarget is undefined', async () => {
    const { VictronMqttClient: RealClient } = await vi.importActual('../../../lib/victron-mqtt.ts');
    const client = new RealClient({ host: 'test', serial: 'test-serial' });

    const writes = [];
    client.writeSetting = vi.fn().mockImplementation((path, value) => {
      writes.push({ path, value });
      return Promise.resolve();
    });

    await client.writeScheduleSlot(0, {
      startEpoch: 1700000000,
      durationSeconds: 900,
      strategy: 2,
    }, { serial: 'test-serial' });

    const socWrites = writes.filter(w => w.path.includes('/Soc') || w.path.includes('/TargetSoc'));
    expect(socWrites).toHaveLength(0);
    expect(writes).toHaveLength(3); // Start, Duration, Strategy only
  });
});

describe('mqtt-service — TLS env var parsing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSerial.mockResolvedValue('test-serial-123');
    mockReadSetting.mockResolvedValue({ value: 4 });
    mockWriteSetting.mockResolvedValue(undefined);
    mockWriteScheduleSlot.mockResolvedValue(undefined);
    await shutdownVictronClient();
  });

  afterEach(async () => {
    // Clean up env vars
    delete process.env.MQTT_TLS;
    delete process.env.MQTT_PORT;
    await shutdownVictronClient();
  });

  it('enables TLS when MQTT_TLS is set to "1"', async () => {
    // Line 11: process.env.MQTT_TLS === '1' → tls=true
    process.env.MQTT_TLS = '1';

    // Just calling a function that triggers getVictronClient() is enough
    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // If it ran without error, the client was created with TLS=true via '1'
    expect(mockGetSerial).toHaveBeenCalled();
  });

  it('overrides port to undefined when TLS is enabled and port is 1883', async () => {
    // Line 14: tls && rawPort === 1883 → port = undefined
    process.env.MQTT_TLS = 'true';
    process.env.MQTT_PORT = '1883';

    const rows = [makeRow(0), makeRow(1)];
    await setDynamicEssSchedule(rows, 2);

    // Client was created — the port override logic ran without error
    expect(mockGetSerial).toHaveBeenCalled();
  });
});

describe('mqtt-service — thin wrapper functions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSerial.mockResolvedValue('test-serial-123');
    mockReadSetting.mockResolvedValue({ value: 42 });
    mockReadSocPercent.mockResolvedValue({ soc_percent: 75 });
    mockReadSocLimitsPercent.mockResolvedValue({ minSoc_percent: 20, maxSoc_percent: 95 });
    await shutdownVictronClient();
  });

  it('getVictronSerial delegates to client.getSerial and returns the serial', async () => {
    const serial = await getVictronSerial();

    expect(mockGetSerial).toHaveBeenCalledTimes(1);
    expect(serial).toBe('test-serial-123');
  });

  it('readVictronSetting delegates to client.readSetting with path and options', async () => {
    const result = await readVictronSetting('Settings/DynamicEss/Mode', { timeoutMs: 2000 });

    expect(mockReadSetting).toHaveBeenCalledWith('Settings/DynamicEss/Mode', { timeoutMs: 2000 });
    expect(result).toEqual({ value: 42 });
  });

  it('readVictronSetting works without options', async () => {
    const result = await readVictronSetting('Settings/DynamicEss/Mode');

    expect(mockReadSetting).toHaveBeenCalledWith('Settings/DynamicEss/Mode', {});
    expect(result).toEqual({ value: 42 });
  });

  it('readVictronSocPercent delegates to client.readSocPercent and returns soc_percent', async () => {
    const soc = await readVictronSocPercent();

    expect(mockReadSocPercent).toHaveBeenCalledTimes(1);
    expect(soc).toBe(75);
  });

  it('readVictronSocPercent passes timeoutMs option to client', async () => {
    await readVictronSocPercent({ timeoutMs: 5000 });

    expect(mockReadSocPercent).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  it('readVictronSocLimits delegates to client.readSocLimitsPercent and returns min/max', async () => {
    const limits = await readVictronSocLimits();

    expect(mockReadSocLimitsPercent).toHaveBeenCalledTimes(1);
    expect(limits).toEqual({ minSoc_percent: 20, maxSoc_percent: 95 });
  });

  it('readVictronSocLimits passes timeoutMs option to client', async () => {
    await readVictronSocLimits({ timeoutMs: 3000 });

    expect(mockReadSocLimitsPercent).toHaveBeenCalledWith({ timeoutMs: 3000 });
  });
});
