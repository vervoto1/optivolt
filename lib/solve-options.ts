/**
 * solve-options.ts
 *
 * The HiGHS options the planner solves with, shared with the solver-refresh
 * gate (`scripts/compare-highs-builds.ts`) so the gate compares objectives
 * at the gap the planner actually uses instead of a hand-copied number.
 */

/** MIP gap for a plan with binaries: 0.5 % relative or 0.01 (cents) absolute, whichever is hit first. */
export const MIP_SOLVE_OPTIONS = { mip_rel_gap: 0.005, mip_abs_gap: 0.01 } as const;

/**
 * Options for the plan built from `cfg`. Every non-empty horizon is a MILP —
 * `buildLP` emits the battery-direction binaries for each slot — so the
 * `load_W.length > 0` test is the planner's binaries predicate, kept here so
 * both callers agree on it.
 */
export function solveOptionsFor(cfg: { load_W: readonly number[] }): Record<string, number> {
  return cfg.load_W.length > 0 ? { ...MIP_SOLVE_OPTIONS } : {};
}
