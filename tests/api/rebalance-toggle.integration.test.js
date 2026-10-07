import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { post } from './helpers/express-test-client.js';

// Disable mid-hold → re-enable → plan, through the real settings route, the
// real JSON stores and a real HiGHS solve. Only timers and external I/O are
// mocked.
vi.mock('../../api/services/auto-calculate.ts');
vi.mock('../../api/services/dess-price-refresh.ts');
vi.mock('../../api/services/shore-optimizer.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/mqtt-service.ts');
vi.mock('../../api/services/plan-history-store.ts');
vi.mock('../../api/services/ha-client.ts');

const NOW_MS = Date.parse('2024-01-01T00:00:00Z'); // default-data.json starts here
const HOLD_STARTED_MS = NOW_MS - 2 * 86_400_000;

describe('rebalance toggled off mid-hold and on again', () => {
  let tempDir;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-rebalance-toggle-'));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.DATA_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('starts a fresh hold cycle on the next plan instead of reporting the old one complete', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const defaults = JSON.parse(await fs.readFile(new URL('../../api/defaults/default-data.json', import.meta.url), 'utf8'));
    await fs.writeFile(path.join(tempDir, 'settings.json'), JSON.stringify({
      rebalanceEnabled: true,
      rebalanceHoldHours: 1,
      maxSoc_percent: 100,
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'api', evLoad: 'api' },
    }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'data.json'), JSON.stringify({
      ...defaults,
      soc: { timestamp: new Date(NOW_MS).toISOString(), value: 100 },
      rebalanceState: { startMs: HOLD_STARTED_MS },
    }), 'utf8');

    const settingsRouter = (await import('../../api/routes/settings.ts')).default;
    const { computePlan } = await import('../../api/services/planner-service.ts');
    const { savePlanSnapshot } = await import('../../api/services/plan-history-store.ts');
    savePlanSnapshot.mockResolvedValue();
    const readJson = async (name) => JSON.parse(await fs.readFile(path.join(tempDir, name), 'utf8'));

    // Switched off 30 minutes into the hold, back on two days later.
    vi.setSystemTime(HOLD_STARTED_MS + 30 * 60_000);
    expect((await post(settingsRouter, '/', { rebalanceEnabled: false })).status).toBe(200);
    vi.setSystemTime(NOW_MS);
    expect((await post(settingsRouter, '/', { rebalanceEnabled: true })).status).toBe(200);
    expect((await readJson('data.json')).rebalanceState).toEqual({ startMs: null });

    const plan = await computePlan();

    // A full fresh 1 h hold (4 slots) is planned, not a completed cycle.
    expect(plan.cfg.rebalanceRemainingSlots).toBe(4);
    expect(plan.rebalanceWindow.endIdx - plan.rebalanceWindow.startIdx).toBe(3);
    expect(plan.summary.rebalanceStatus).toBeOneOf(['scheduled', 'active']);
    expect((await readJson('settings.json')).rebalanceEnabled).toBe(true);
    // Either stamped now (held from slot 0) or pending since now; never the old start.
    const state = (await readJson('data.json')).rebalanceState;
    expect(state.startMs).toBeOneOf([null, NOW_MS]);
    if (state.startMs == null) expect(state.pendingSinceMs).toBe(NOW_MS);
  });
});
