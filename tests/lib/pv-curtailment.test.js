import { describe, it, expect } from 'vitest';
import {
  annotatePvCurtailmentSlots,
  decidePvCurtailment,
} from '../../lib/pv-curtailment.ts';

const START = new Date('2026-05-01T12:00:00.000Z').getTime();

function row(index, overrides = {}) {
  return {
    tIdx: index,
    timestampMs: START + index * 15 * 60_000,
    load: 1000,
    pv: 500,
    evLoad: 0,
    ic: -10,
    ec: -10,
    g2l: 1000,
    g2b: 1000,
    pv2l: 0,
    pv2b: 0,
    pv2g: 0,
    pvCurtail: 0,
    b2l: 0,
    b2g: 0,
    imp: 2000,
    exp: 0,
    soc: 0,
    soc_percent: 0,
    g2ev: 0,
    pv2ev: 0,
    b2ev: 0,
    ev_charge: 0,
    ev_charge_A: 0,
    ev_charge_mode: 'off',
    ev_soc_percent: 0,
    ...overrides,
  };
}

const cfg = { stepSize_m: 15, maxGridImport_W: 3000 };
const policy = {
  enabled: true,
  negativePriceThreshold_cents_per_kWh: 0,
  minPvPowerW: 100,
  minGridHeadroomW: 100,
};

describe('pv curtailment decision', () => {
  it('does not disable when the policy is disabled', () => {
    const decision = decidePvCurtailment([row(0)], cfg, START, { ...policy, enabled: false });
    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('disabled');
  });

  it('does not disable outside negative prices', () => {
    const decision = decidePvCurtailment([row(0, { ic: 1, ec: 1 })], cfg, START, policy);
    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('price_not_negative');
  });

  it('disables on a negative export price only when the plan curtails nearly all PV', () => {
    // passThrough export tariff: market export below 0 while the all-in import stays positive.
    const rows = [
      row(0, { pv: 500, pvCurtail: 495, imp: 2000, ic: 5, ec: -2 }),
      row(1, { pv: 500, imp: 2000, ic: 5, ec: -1 }),
      row(2, { pv: 500, imp: 2000, ic: 5, ec: 0 }),
    ];

    const decision = decidePvCurtailment(rows, cfg, START, policy);

    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('planned_pv_curtailment');
    expect(decision.negativeBlockEndIndex).toBe(1);
  });

  it('does not switch PV off for a negative export price when the plan self-consumes PV', () => {
    // Turning PV off would buy the house load at 27 c to avoid a 0.5 c export fee on the surplus.
    const rows = [row(0, { pv: 2000, pvCurtail: 1000, imp: 0, ic: 27, ec: -0.5 })];

    const decision = decidePvCurtailment(rows, { ...cfg, maxGridImport_W: 17000 }, START, policy);

    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('negative_export_not_curtailed');
  });

  it('ignores a 0 c export price with a positive threshold', () => {
    // floorZero/fallback slots export at 0 c; only the import side is compared to the threshold.
    const rows = [0, 1, 2, 3].map(i => row(i, { pv: 3000, imp: 0, ic: 27, ec: 0 }));

    const decision = decidePvCurtailment(rows, { ...cfg, maxGridImport_W: 17000 }, START, {
      ...policy,
      negativePriceThreshold_cents_per_kWh: 0.5,
    });

    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('price_not_negative');
  });

  it('extends an import-negative block only over import-negative slots', () => {
    const rows = [
      row(0, { ic: -3, ec: -3 }),
      row(1, { ic: 5, ec: -3 }),
    ];

    const decision = decidePvCurtailment(rows, cfg, START, policy);

    expect(decision.reason).toBe('negative_price_grid_headroom');
    expect(decision.negativeBlockEndIndex).toBe(0);
  });

  it('still treats a negative import price as negative when export is floored at 0', () => {
    const decision = decidePvCurtailment([row(0, { ic: -3, ec: 0 })], cfg, START, policy);
    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('negative_price_grid_headroom');
  });

  it('disables when the plan already curtails essentially all current PV', () => {
    const decision = decidePvCurtailment([row(0, { pv: 600, pvCurtail: 590, imp: 3000 })], cfg, START, policy);
    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('planned_pv_curtailment');
  });

  it('disables when the remaining negative price block has enough grid headroom to replace PV', () => {
    const rows = [
      row(0, { pv: 500, imp: 2000 }),
      row(1, { pv: 500, imp: 2000 }),
      row(2, { pv: 500, imp: 2000 }),
      row(3, { pv: 500, imp: 2000, ic: 2, ec: 2 }),
    ];

    const decision = decidePvCurtailment(rows, cfg, START, policy);

    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('negative_price_grid_headroom');
    expect(decision.negativeBlockEndIndex).toBe(2);
    expect(decision.remainingPv_Wh).toBe(375);
    expect(decision.remainingGridHeadroom_Wh).toBe(750);
  });

  it('keeps PV on when current grid headroom cannot replace current PV', () => {
    const decision = decidePvCurtailment([row(0, { pv: 800, imp: 2500 })], cfg, START, policy);
    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('insufficient_current_grid_headroom');
  });

  it('only requires headroom for PV the plan would actually use', () => {
    const decision = decidePvCurtailment(
      [row(0, { pv: 1000, pvCurtail: 850, imp: 2800 })],
      cfg,
      START,
      policy,
    );

    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('negative_price_grid_headroom');
    expect(decision.remainingPv_Wh).toBeCloseTo(37.5);
  });

  it('keeps PV on when remaining grid headroom cannot replace remaining PV before prices turn positive', () => {
    const rows = [
      row(0, { pv: 500, imp: 2500 }),
      row(1, { pv: 2500, imp: 2500 }),
      row(2, { pv: 500, imp: 2500, ic: 5, ec: 5 }),
    ];

    const decision = decidePvCurtailment(rows, cfg, START, policy);

    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('insufficient_remaining_grid_headroom');
  });

  it('keeps PV on when a later negative-price slot would max the grid connection', () => {
    const rows = [
      row(0, { pv: 500, imp: 1500 }),
      row(1, { pv: 500, imp: 2800 }),
      row(2, { pv: 500, imp: 1500, ic: 5, ec: 5 }),
    ];

    const decision = decidePvCurtailment(rows, cfg, START, policy);

    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('insufficient_remaining_grid_headroom');
  });

  it('returns no_expected_pv when current PV is below the minimum threshold', () => {
    const decision = decidePvCurtailment([row(0, { pv: 50 })], cfg, START, policy);
    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('no_expected_pv');
  });

  it('coerces non-numeric pv/imp values to zero', () => {
    const decision = decidePvCurtailment(
      [row(0, { pv: 'abc', imp: undefined, ic: -10, ec: -10 })],
      cfg,
      START,
      policy,
    );
    expect(decision.shouldDisable).toBe(false);
    expect(decision.reason).toBe('no_expected_pv');
    expect(decision.currentPv_W).toBe(0);
    expect(decision.currentGridImport_W).toBe(0);
  });

  it('coerces non-numeric pv/imp inside the remaining-energy aggregation', () => {
    const rows = [
      row(0, { pv: 500, imp: 2000 }),
      row(1, { pv: 'NaN', imp: 'oops' }),
      row(2, { pv: 500, imp: 2000, ic: 5, ec: 5 }),
    ];
    const decision = decidePvCurtailment(rows, cfg, START, policy);
    expect(decision.shouldDisable).toBe(true);
    expect(decision.reason).toBe('negative_price_grid_headroom');
    expect(decision.remainingPv_Wh).toBe(125);
  });

  it('annotates every row with the decision from that row to the end of its negative price block', () => {
    const rows = [
      row(0, { pv: 500, imp: 2000 }),
      row(1, { pv: 500, imp: 2000 }),
      row(2, { pv: 500, imp: 2000, ic: 5, ec: 5 }),
    ];

    const annotations = annotatePvCurtailmentSlots(rows, cfg, policy);

    expect(annotations[0]).toMatchObject({ disable: true, reason: 'negative_price_grid_headroom' });
    expect(annotations[1]).toMatchObject({ disable: true, reason: 'negative_price_grid_headroom' });
    expect(annotations[2]).toMatchObject({ disable: false, reason: 'price_not_negative' });
  });
});

describe('pv curtailment — multi-day forecast rows', () => {
  it('treats a forecast row as no current slot', () => {
    const rows = [row(0), row(1, { priceForecast: true, pvCurtail: 500 })];
    const decision = decidePvCurtailment(rows, cfg, START + 15 * 60_000, policy);
    expect(decision).toMatchObject({ shouldDisable: false, reason: 'no_current_slot', currentIndex: null });
    expect(annotatePvCurtailmentSlots(rows, cfg, policy)[1]).toMatchObject({ disable: false, reason: 'no_current_slot' });
  });

  it('stops the negative-price run at the firm boundary', () => {
    const firm = [row(0, { pv: 500, imp: 0 }), row(1, { pv: 500, imp: 0 })];
    const decision = decidePvCurtailment([...firm, row(2, { pv: 5000, imp: 0, priceForecast: true })], cfg, START, policy);
    expect(decision.negativeBlockEndIndex).toBe(1);
    expect(decision).toEqual(decidePvCurtailment(firm, cfg, START, policy));
    expect(decision.shouldDisable).toBe(true);
  });
});
