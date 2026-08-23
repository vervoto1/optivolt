/**
 * strategy.js
 *
 * The one browser-side definition of what a load-predictor strategy is: the
 * (lookbackWeeks, dayFilter, aggregation) triple. The server has its own copy
 * in lib/strategy-selector.ts (browser modules cannot import the .ts files);
 * adding a field to the key means updating both.
 */

/** "8w / all / median" label used by the Strategy Selection card and the comparison status line. */
export function formatStrategy(s) {
  return s ? `${s.lookbackWeeks}w / ${s.dayFilter} / ${s.aggregation}` : '--';
}

/** Strategy equality on the three key fields only; false when either side is missing. */
export function isSameStrategy(a, b) {
  return !!a && !!b && a.lookbackWeeks === b.lookbackWeeks && a.dayFilter === b.dayFilter && a.aggregation === b.aggregation;
}
