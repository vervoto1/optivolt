import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock mqtt-service and planner-service before importing
vi.mock('../../../api/services/mqtt-service.ts', () => ({
  writeVictronSetting: vi.fn().mockResolvedValue(undefined),
  isPriceRefreshWindowActive: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../api/services/planner-service.ts', () => ({
  planAndMaybeWrite: vi.fn().mockResolvedValue({ rows: [] }),
}));

const { startDessPriceRefresh, stopDessPriceRefresh, isPriceRefreshWindowActive } =
  await import('../../../api/services/dess-price-refresh.ts');
const { writeVictronSetting } = await import('../../../api/services/mqtt-service.ts');
const { planAndMaybeWrite } = await import('../../../api/services/planner-service.ts');

function makeSettings(overrides = {}) {
  return {
    dessPriceRefresh: {
      enabled: true,
      time: '13:00',
      durationMinutes: 15,
      ...overrides,
    },
  };
}

describe('dess-price-refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopDessPriceRefresh();
  });

  afterEach(() => {
    stopDessPriceRefresh();
    vi.useRealTimers();
  });

  it('does not start when disabled', () => {
    startDessPriceRefresh(makeSettings({ enabled: false }));
    expect(isPriceRefreshWindowActive()).toBe(false);
  });

  it('does not start when config is missing', () => {
    startDessPriceRefresh({});
    expect(isPriceRefreshWindowActive()).toBe(false);
  });

  it('sets Mode 1 when current time is inside the window', async () => {
    vi.setSystemTime(new Date('2026-03-19T13:05:00')); // inside 13:00–13:15

    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0); // let tick() resolve

    expect(isPriceRefreshWindowActive()).toBe(true);
    expect(writeVictronSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', 1
    );
  });

  it('does NOT set Mode 1 when current time is outside the window', async () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00')); // before 13:00

    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0);

    expect(isPriceRefreshWindowActive()).toBe(false);
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('restores Mode 4 and triggers recalc when window ends', async () => {
    // Start inside window
    vi.setSystemTime(new Date('2026-03-19T13:14:00'));
    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0);

    expect(isPriceRefreshWindowActive()).toBe(true);
    vi.clearAllMocks();

    // Advance past window end (13:15)
    vi.setSystemTime(new Date('2026-03-19T13:15:00'));
    await vi.advanceTimersByTimeAsync(60_000); // trigger next tick

    expect(isPriceRefreshWindowActive()).toBe(false);
    // Should restore Mode 4
    expect(writeVictronSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', 4
    );
    // Should trigger forced recalc with fresh prices
    expect(planAndMaybeWrite).toHaveBeenCalledWith({
      updateData: true,
      writeToVictron: true,
      forceWrite: true,
    });
  });

  it('does not trigger twice when staying inside window', async () => {
    vi.setSystemTime(new Date('2026-03-19T13:01:00'));
    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0);

    expect(writeVictronSetting).toHaveBeenCalledTimes(1); // Mode 1 on entry
    vi.clearAllMocks();

    // Advance 1 minute, still inside window
    vi.setSystemTime(new Date('2026-03-19T13:02:00'));
    await vi.advanceTimersByTimeAsync(60_000);

    // Should NOT write again
    expect(writeVictronSetting).not.toHaveBeenCalled();
  });

  it('stops cleanly and resets window state', async () => {
    vi.setSystemTime(new Date('2026-03-19T13:05:00'));
    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0);

    expect(isPriceRefreshWindowActive()).toBe(true);

    stopDessPriceRefresh();
    expect(isPriceRefreshWindowActive()).toBe(false);
  });

  it('handles custom time and duration', async () => {
    vi.setSystemTime(new Date('2026-03-19T02:10:00')); // inside 02:00–02:30

    startDessPriceRefresh(makeSettings({ time: '02:00', durationMinutes: 30 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(isPriceRefreshWindowActive()).toBe(true);
    expect(writeVictronSetting).toHaveBeenCalledWith(
      'settings/0/Settings/DynamicEss/Mode', 1
    );
  });

  it('is idempotent — restarting stops the previous timer', async () => {
    vi.setSystemTime(new Date('2026-03-19T13:05:00'));
    startDessPriceRefresh(makeSettings());
    await vi.advanceTimersByTimeAsync(0);

    // Restart with different config
    startDessPriceRefresh(makeSettings({ time: '14:00' }));
    await vi.advanceTimersByTimeAsync(0);

    // Should no longer be active (14:00 window, current time 13:05)
    expect(isPriceRefreshWindowActive()).toBe(false);
  });
});
