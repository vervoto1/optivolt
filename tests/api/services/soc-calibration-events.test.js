import { describe, it, expect, vi, beforeEach } from 'vitest';

let store = null;

vi.mock('../../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/tmp/test-data',
  readJson: vi.fn(async () => {
    if (store === null) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return store;
  }),
  writeJson: vi.fn(async (_path, data) => { store = data; }),
}));

import {
  loadSocCalibrationEvents,
  recordSocCalibrationEvent,
  calibrationEventInRange,
} from '../../../api/services/soc-calibration-events.ts';
import { readJson } from '../../../api/services/json-store.ts';

const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  store = null;
  vi.clearAllMocks();
});

describe('loadSocCalibrationEvents', () => {
  it('returns [] when the file does not exist', async () => {
    await expect(loadSocCalibrationEvents()).resolves.toEqual([]);
  });

  it('propagates a non-ENOENT read error', async () => {
    readJson.mockRejectedValueOnce(new Error('EACCES'));
    await expect(loadSocCalibrationEvents()).rejects.toThrow('EACCES');
  });
});

describe('recordSocCalibrationEvent', () => {
  it('appends an event to the store', async () => {
    const ev = { timestampMs: 1_000, batteryIndex: 0, entity: 'number.bms0_soc_calibration', value: 80 };
    await recordSocCalibrationEvent(ev);
    await expect(loadSocCalibrationEvents()).resolves.toEqual([ev]);
  });

  it('prunes events older than the 30-day retention window on write', async () => {
    const now = 100 * DAY;
    store = [
      { timestampMs: now - 40 * DAY, batteryIndex: 0, entity: 'e', value: 50 }, // stale → pruned
      { timestampMs: now - 10 * DAY, batteryIndex: 0, entity: 'e', value: 60 }, // kept
    ];
    const fresh = { timestampMs: now, batteryIndex: 1, entity: 'e', value: 70 };
    await recordSocCalibrationEvent(fresh);
    const kept = await loadSocCalibrationEvents();
    expect(kept.map(e => e.value)).toEqual([60, 70]);
  });
});

describe('calibrationEventInRange', () => {
  const events = [{ timestampMs: 500, batteryIndex: 0, entity: 'e', value: 80 }];

  it('is true when an event falls strictly after afterMs and at/before atOrBeforeMs', () => {
    expect(calibrationEventInRange(events, 400, 600)).toBe(true);
    expect(calibrationEventInRange(events, 400, 500)).toBe(true); // inclusive upper bound
  });

  it('is false at the exclusive lower bound and outside the range', () => {
    expect(calibrationEventInRange(events, 500, 600)).toBe(false); // exclusive lower bound
    expect(calibrationEventInRange(events, 600, 700)).toBe(false);
    expect(calibrationEventInRange([], 0, 1_000)).toBe(false);
  });
});
