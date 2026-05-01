import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/mqtt-service.ts', () => ({
  getVictronSerial: vi.fn().mockResolvedValue('detected-serial'),
  writeVictronSetting: vi.fn().mockResolvedValue(undefined),
}));

import { writeVictronSetting } from '../../../api/services/mqtt-service.ts';
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
});
