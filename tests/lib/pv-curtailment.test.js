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
