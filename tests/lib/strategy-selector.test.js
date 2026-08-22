import { describe, it, expect } from 'vitest';
import { selectStrategy, isSameStrategy, formatStrategy } from '../../lib/strategy-selector.ts';

const score = (lookbackWeeks, dayFilter, aggregation, mae, extra = {}) => ({
  lookbackWeeks,
  dayFilter,
  aggregation,
  mae,
  rmse: mae * 1.4,
  mape: 30,
  n: 672,
  nSkipped: 0,
  ...extra,
});

const INCUMBENT = { lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median' };
const OPTS = { metric: 'mae', minImprovement_percent: 10, minSamples: 538 };

describe('strategy-selector helpers', () => {
  it('isSameStrategy compares the three strategy fields only', () => {
    expect(isSameStrategy(INCUMBENT, { ...INCUMBENT, mae: 1, n: 5 })).toBe(true);
    expect(isSameStrategy(INCUMBENT, { ...INCUMBENT, lookbackWeeks: 12 })).toBe(false);
    expect(isSameStrategy(INCUMBENT, { ...INCUMBENT, dayFilter: 'same' })).toBe(false);
    expect(isSameStrategy(INCUMBENT, { ...INCUMBENT, aggregation: 'mean' })).toBe(false);
  });

  it('formatStrategy renders the compact label', () => {
    expect(formatStrategy(INCUMBENT)).toBe('8w/all/median');
  });
});

describe('selectStrategy', () => {
  it('picks the lowest metric and returns an ascending ranking', () => {
    const scores = [
      score(8, 'all', 'median', 483),
      score(26, 'all', 'median', 400),
      score(2, 'all', 'mean', 501),
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.best).toMatchObject({ lookbackWeeks: 26 });
    expect(result.ranking.map(r => r.mae)).toEqual([400, 483, 501]);
    expect(result.reason).toBe('switch');
    expect(result.shouldSwitch).toBe(true);
    expect(result.improvement_percent).toBeCloseTo((483 - 400) / 483 * 100, 6);
  });

  it('keeps the incumbent on an exact tie (incumbent sorts first)', () => {
    const scores = [
      score(12, 'all', 'median', 300),
      score(8, 'all', 'median', 300),
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.best).toMatchObject(INCUMBENT);
    expect(result.incumbent).toMatchObject(INCUMBENT);
    expect(result.reason).toBe('incumbent-best');
    expect(result.shouldSwitch).toBe(false);
    expect(result.improvement_percent).toBe(0);
    expect(result.ranking[0]).toMatchObject(INCUMBENT);
  });

  it('breaks ties between non-incumbents by longer lookback', () => {
    const scores = [
      score(4, 'all', 'median', 300),
      score(16, 'all', 'median', 300),
      score(8, 'all', 'median', 350),
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.ranking.map(r => r.lookbackWeeks)).toEqual([16, 4, 8]);
    expect(result.best.lookbackWeeks).toBe(16);
  });

  it('keeps the incumbent when the improvement is below the threshold', () => {
    const scores = [
      score(8, 'all', 'median', 483),
      score(26, 'all', 'median', 457), // −5.4 %
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.best.lookbackWeeks).toBe(26);
    expect(result.reason).toBe('below-threshold');
    expect(result.shouldSwitch).toBe(false);
    expect(result.improvement_percent).toBeCloseTo(5.383, 2);
  });

  it('switches when the improvement is exactly at the threshold', () => {
    const scores = [
      score(8, 'all', 'median', 500),
      score(26, 'all', 'median', 450), // exactly −10 %
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.reason).toBe('switch');
    expect(result.shouldSwitch).toBe(true);
    expect(result.improvement_percent).toBeCloseTo(10, 6);
  });

  it('honours the rmse metric', () => {
    const scores = [
      score(8, 'all', 'median', 400, { rmse: 700 }),
      score(1, 'all', 'mean', 420, { rmse: 500 }),
    ];
    const byMae = selectStrategy(scores, INCUMBENT, OPTS);
    expect(byMae.reason).toBe('incumbent-best');

    const byRmse = selectStrategy(scores, INCUMBENT, { ...OPTS, metric: 'rmse' });
    expect(byRmse.best.lookbackWeeks).toBe(1);
    expect(byRmse.reason).toBe('switch');
    expect(byRmse.improvement_percent).toBeCloseTo((700 - 500) / 700 * 100, 6);
  });

  it('excludes NaN metrics and low-sample strategies from the ranking', () => {
    const scores = [
      score(8, 'all', 'median', 483),
      score(26, 'all', 'median', NaN),
      score(20, 'all', 'median', 100, { n: 10 }),
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.ranking).toHaveLength(1);
    expect(result.reason).toBe('incumbent-best');
  });

  it('scores an off-grid incumbent and keeps it when it is best', () => {
    const offGrid = { lookbackWeeks: 5, dayFilter: 'same', aggregation: 'mean' };
    const scores = [
      score(5, 'same', 'mean', 300),
      score(8, 'all', 'median', 320),
    ];
    const result = selectStrategy(scores, offGrid, OPTS);
    expect(result.reason).toBe('incumbent-best');
    expect(result.incumbent).toMatchObject(offGrid);
  });

  it('switches when the incumbent is ineligible but a candidate is', () => {
    const scores = [
      score(8, 'all', 'median', 300, { n: 20 }),
      score(4, 'all', 'median', 350),
    ];
    const result = selectStrategy(scores, INCUMBENT, OPTS);
    expect(result.reason).toBe('incumbent-unscored');
    expect(result.shouldSwitch).toBe(true);
    expect(result.incumbent).toBeNull();
    expect(result.improvement_percent).toBeNull();
    expect(result.best.lookbackWeeks).toBe(4);
  });

  it('returns no-eligible on empty or fully ineligible input', () => {
    const empty = selectStrategy([], INCUMBENT, OPTS);
    expect(empty).toEqual({ best: null, incumbent: null, shouldSwitch: false, improvement_percent: null, reason: 'no-eligible', ranking: [] });

    const allBad = selectStrategy([score(8, 'all', 'median', NaN), score(1, 'all', 'mean', 400, { n: 0 })], INCUMBENT, OPTS);
    expect(allBad.reason).toBe('no-eligible');
    expect(allBad.shouldSwitch).toBe(false);
  });

  it('with a 0 % margin any strictly better candidate switches but a tie does not', () => {
    const zero = { ...OPTS, minImprovement_percent: 0 };
    const better = selectStrategy([score(8, 'all', 'median', 400), score(12, 'all', 'median', 399)], INCUMBENT, zero);
    expect(better.reason).toBe('switch');

    const tie = selectStrategy([score(8, 'all', 'median', 400), score(12, 'all', 'median', 400)], INCUMBENT, zero);
    expect(tie.reason).toBe('incumbent-best');
  });
});
