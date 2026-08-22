/**
 * strategy-selector.ts
 *
 * Pure selection logic for the historical load predictor: given backtest
 * scores for every candidate strategy, decide whether any candidate beats the
 * incumbent by enough to justify switching. Incumbent-biased on purpose —
 * adjacent strategies typically differ by only a few percent, and a naive
 * per-run argmin flaps between them.
 */

import type { Aggregation, DayFilter } from './load-predictor-historical.ts';

export interface StrategyKey {
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
}

export interface StrategyScore extends StrategyKey {
  mae: number;
  rmse: number;
  mape: number;
  n: number;
  nSkipped: number;
}

export type SelectionMetric = 'mae' | 'rmse';

export interface SelectOptions {
  metric: SelectionMetric;
  /** Hysteresis: a candidate must beat the incumbent by at least this much (relative %). */
  minImprovement_percent: number;
  /** Eligibility floor: strategies that scored fewer validation points are ignored. */
  minSamples: number;
}

export type SelectionReason =
  | 'no-eligible'          // nothing scored enough samples (HA outage, brand-new sensor)
  | 'incumbent-unscored'   // incumbent ineligible while a candidate is → switch
  | 'incumbent-best'       // incumbent is rank 1 (ties included)
  | 'below-threshold'      // a candidate is better, but not by minImprovement
  | 'switch';              // a candidate clears the threshold

export interface SelectionResult {
  best: StrategyScore | null;
  incumbent: StrategyScore | null;
  shouldSwitch: boolean;
  /** (incumbent − best) / incumbent × 100 on the chosen metric; null when either side is unscored. */
  improvement_percent: number | null;
  reason: SelectionReason;
  /** Eligible scores only, ascending by metric (incumbent wins ties, then longer lookback). */
  ranking: StrategyScore[];
}

export function isSameStrategy(a: StrategyKey, b: StrategyKey): boolean {
  return a.lookbackWeeks === b.lookbackWeeks && a.dayFilter === b.dayFilter && a.aggregation === b.aggregation;
}

/** Compact "8w/all/median" label used in logs and the UI. */
export function formatStrategy(s: StrategyKey): string {
  return `${s.lookbackWeeks}w/${s.dayFilter}/${s.aggregation}`;
}

export function selectStrategy(
  scores: StrategyScore[],
  incumbent: StrategyKey,
  { metric, minImprovement_percent, minSamples }: SelectOptions,
): SelectionResult {
  const eligible = scores.filter(s => Number.isFinite(s[metric]) && s.n >= minSamples);

  const ranking = [...eligible].sort((a, b) => {
    if (a[metric] !== b[metric]) return a[metric] - b[metric];
    const aInc = isSameStrategy(a, incumbent) ? 1 : 0;
    const bInc = isSameStrategy(b, incumbent) ? 1 : 0;
    if (aInc !== bInc) return bInc - aInc;
    return b.lookbackWeeks - a.lookbackWeeks;
  });

  if (ranking.length === 0) {
    return { best: null, incumbent: null, shouldSwitch: false, improvement_percent: null, reason: 'no-eligible', ranking };
  }

  const best = ranking[0];
  const incumbentScore = ranking.find(s => isSameStrategy(s, incumbent)) ?? null;

  if (!incumbentScore) {
    return { best, incumbent: null, shouldSwitch: true, improvement_percent: null, reason: 'incumbent-unscored', ranking };
  }

  if (isSameStrategy(best, incumbent)) {
    return { best, incumbent: incumbentScore, shouldSwitch: false, improvement_percent: 0, reason: 'incumbent-best', ranking };
  }

  // best is strictly better than the incumbent here (ties sort the incumbent first),
  // so the incumbent's metric is > 0 and the division is safe.
  const improvement_percent = (incumbentScore[metric] - best[metric]) / incumbentScore[metric] * 100;
  const shouldSwitch = best[metric] <= incumbentScore[metric] * (1 - minImprovement_percent / 100);

  return {
    best,
    incumbent: incumbentScore,
    shouldSwitch,
    improvement_percent,
    reason: shouldSwitch ? 'switch' : 'below-threshold',
    ranking,
  };
}
