import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VictronMqttClient class before importing mqtt-service
const mockGetSerial = vi.fn().mockResolvedValue('test-serial-123');
const mockReadSetting = vi.fn();
const mockWriteSetting = vi.fn().mockResolvedValue(undefined);
const mockWriteScheduleSlot = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/victron-mqtt.ts', () => ({
  VictronMqttClient: class MockVictronMqttClient {
    constructor() {}
    getSerial = mockGetSerial;
    readSetting = mockReadSetting;
    writeSetting = mockWriteSetting;
    writeScheduleSlot = mockWriteScheduleSlot;
    close = mockClose;
  },
}));

const { setDynamicEssSchedule, shutdownVictronClient } = await import('../../../api/services/mqtt-service.ts');

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
        strategy: 3,
        flags: 0,
        socTarget: 86, // rounded from 85.7
        restrictions: 1,
        allowGridFeedIn: 0,
      }),
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
