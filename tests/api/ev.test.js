import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../../api/app.ts';
import { get } from './helpers/express-test-client.js';

vi.mock('../../api/services/planner-service.ts');

import { getLastPlan, getLastEvPreview } from '../../api/services/planner-service.ts';

const START_MS = 1700000000000;

const makeRow = (timestampMs, charge) => ({
  timestampMs,
  ev_charge: charge,
  ev_charge_A: charge / 230,
  ev_charge_mode: charge > 0 ? 'fixed' : 'off',
  g2ev: charge,
  pv2ev: 0,
  b2ev: 0,
  ev_soc_percent: 55,
});

const mockPlan = {
  timing: { startMs: START_MS, stepMin: 15 },
  rows: [
    makeRow(START_MS,              1380),
    makeRow(START_MS + 900_000,    1380),
    makeRow(START_MS + 1_800_000,  0),
  ],
  summary: {
    evChargeTotal_kWh:       0.207,
    evChargeFromGrid_kWh:    0.207,
    evChargeFromPv_kWh:      0,
    evChargeFromBattery_kWh: 0,
  },
};

describe('GET /ev/schedule', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns 404 when no plan has been computed', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await get(app, '/ev/schedule');
    expect(res.status).toBe(404);
  });

  it('returns planStart, slots, and summary when a plan exists', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await get(app, '/ev/schedule');

    expect(res.status).toBe(200);
    expect(res.body.planStart).toBe(new Date(START_MS).toISOString());
    expect(res.body.slots).toHaveLength(3);
    expect(res.body.slots[0]).toMatchObject({
      timestampMs:    START_MS,
      ev_charge_W:    1380,
      ev_charge_mode: 'fixed',
      g2ev_W:         1380,
    });
    expect(res.body.summary.evChargeTotal_kWh).toBe(0.207);
    expect(res.body.summary.evChargeFromGrid_kWh).toBe(0.207);
  });

  it('includes ev_soc_percent in each slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await get(app, '/ev/schedule');
    expect(res.body.slots[0].ev_soc_percent).toBe(55);
  });

  it('serves the EV preview when the real plan has no EV (car disconnected)', async () => {
    // Real plan with no EV: flat zero SoC track, no charging.
    const emptyPlan = {
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [
        makeRow(START_MS, 0), makeRow(START_MS + 900_000, 0),
      ].map(r => ({ ...r, ev_soc_percent: 0 })),
      summary: { evChargeTotal_kWh: 0, evChargeFromGrid_kWh: 0, evChargeFromPv_kWh: 0, evChargeFromBattery_kWh: 0 },
    };
    getLastPlan.mockReturnValue(emptyPlan);
    getLastEvPreview.mockReturnValue({
      timing: { startMs: START_MS, stepMin: 15 },
      rows: [
        { ...makeRow(START_MS, 3680), ic: 12, ev_soc_percent: 60 },
        { ...makeRow(START_MS + 900_000, 0), ic: 12, ev_soc_percent: 80 },
      ],
      liveSoc_percent: 55,
      hasSchedule: true,
      summary: {
        evChargeTotal_kWh: 3680 * 0.25 / 1000,
        evChargeFromGrid_kWh: 3680 * 0.25 / 1000,
        evChargeFromPv_kWh: 0,
        evChargeFromBattery_kWh: 0,
      },
      computedAtMs: START_MS,
    });

    const res = await get(app, '/ev/schedule');

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.liveSoc_percent).toBe(55);
    expect(res.body.slots[0].ev_charge_W).toBe(3680);
    expect(res.body.slots[0].ev_soc_percent).toBe(60);
    expect(res.body.summary.evChargeTotal_kWh).toBeCloseTo(3680 * 0.25 / 1000, 5);
  });

  it('uses the real plan (not preview) when the car is connected', async () => {
    getLastPlan.mockReturnValue(mockPlan); // mockPlan has ev_soc_percent 55 > 0
    getLastEvPreview.mockReturnValue({ rows: [], timing: mockPlan.timing, liveSoc_percent: 99, hasSchedule: false, computedAtMs: START_MS });

    const res = await get(app, '/ev/schedule');

    expect(res.body.preview).toBe(false);
    expect(res.body.slots).toHaveLength(3);
    expect(res.body.summary.evChargeTotal_kWh).toBe(0.207);
  });
});

describe('GET /ev/schedule — multi-day forecast rows', () => {
  beforeEach(() => vi.resetAllMocks());

  it('marks forecast slots and passes their null EV SoC through', async () => {
    getLastPlan.mockReturnValue({
      ...mockPlan,
      rows: [
        ...mockPlan.rows,
        { ...makeRow(START_MS + 2_700_000, 0), ev_soc_percent: null, priceForecast: true },
      ],
    });

    const res = await get(app, '/ev/schedule');

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(false);
    expect(res.body.slots).toHaveLength(4);
    expect(res.body.slots.slice(0, 3).every(s => !('priceForecast' in s))).toBe(true);
    expect(res.body.slots[3]).toMatchObject({ priceForecast: true, ev_soc_percent: null, ev_charge_W: 0 });
  });
});

describe('GET /ev/current', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('returns 404 when no plan has been computed', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await get(app, '/ev/current');
    expect(res.status).toBe(404);
  });

  it('returns current slot data with is_charging flag', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 500_000); // within slot 0

    const res = await get(app, '/ev/current');

    expect(res.status).toBe(200);
    expect(res.body.timestampMs).toBe(START_MS);
    expect(res.body.ev_charge_W).toBe(1380);
    expect(res.body.is_charging).toBe(true);
  });

  it('selects the most recent past slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 1_900_000); // past slot 2

    const res = await get(app, '/ev/current');

    expect(res.body.timestampMs).toBe(START_MS + 1_800_000);
    expect(res.body.is_charging).toBe(false);
  });

  it('reads a forecast-priced row (multi-day horizon) as no current slot: null plan fields', async () => {
    getLastPlan.mockReturnValue({
      ...mockPlan,
      rows: [
        ...mockPlan.rows,
        { ...makeRow(START_MS + 2_700_000, 2000), ev_soc_percent: null, priceForecast: true },
      ],
    });
    vi.setSystemTime(START_MS + 2_800_000); // inside the forecast row (a stale plan)

    const res = await get(app, '/ev/current');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      timestampMs: null,
      planned_ev_charge_W: null,
      planned_ev_charge_mode: null,
      g2ev_W: null,
      pv2ev_W: null,
      b2ev_W: null,
      ev_soc_percent: null,
    });
    // The decision uses the same lookup: no plan-driven charging there.
    expect(res.body.ev_charge_W).not.toBe(2000);
  });

  it('answers with null plan fields for a plan without rows', async () => {
    getLastPlan.mockReturnValue({ ...mockPlan, rows: [] });
    vi.setSystemTime(START_MS);

    const res = await get(app, '/ev/current');

    expect(res.status).toBe(200);
    expect(res.body.timestampMs).toBeNull();
    expect(res.body.planned_ev_charge_W).toBeNull();
  });

  it('falls back to rows[0] when all timestamps are in the future', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS - 10_000); // before all slots

    const res = await get(app, '/ev/current');

    expect(res.body.timestampMs).toBe(START_MS);
  });
});

describe('GET /ev/status', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns a compact status object', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await get(app, '/ev/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mode');
    expect(res.body).toHaveProperty('is_charging');
    expect(res.body).toHaveProperty('targetSoc_percent');
  });

  it('does not 404 when no plan exists (status is plan-tolerant)', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await get(app, '/ev/status');
    expect(res.status).toBe(200);
  });
});

describe('GET /ev/actuation', () => {
  it('returns the last actuation record (never_run before any tick)', async () => {
    const res = await get(app, '/ev/actuation');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });
});
