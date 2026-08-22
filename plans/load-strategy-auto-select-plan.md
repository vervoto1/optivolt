# Load Predictor Auto-Selection — Implementation Plan

## Status

Planned. Not started. This document is a self-contained build brief: a fresh
Claude Code session can implement the feature from this file alone.

## Goal

Replace the manual loop "Run Comparison → read 48 rows → click Use" with a
daily backtest that scores every historical-predictor strategy for the active
load sensor and then either:

- **suggest mode** — records the winner so the UI can show "best strategy is X,
  −7 % MAE vs current" with an Apply button, or
- **auto mode** — rewrites `historicalPredictor` when the winner beats the
  incumbent by a configurable margin.

The comparison button stays for manual deep-dives; the selector just runs the
same backtest on a timer and acts on the result.

## What exists today (read first)

- `lib/load-predictor-historical.ts` — pure `predict`, `validate`, and
  `generateAllConfigs` (6 lookbacks × 4 day filters × 2 aggregations = 48
  strategies per sensor).
- `api/services/load-prediction-service.ts::runValidation` — fetches 9 weeks of
  HA long-term statistics for every configured sensor, `postprocess`es, then runs
  all 48 strategies for each of the 10 sensor names (480 results) and returns
  metrics plus the per-hour `validationPredictions` for charting. The validation
  window is the previous 7 full UTC days, recomputed on every
  `loadPredictionConfig()` call.
- `POST /predictions/validate` → `executePredictionValidation` (HA-connection and
  sensor guards, HA error mapping to 502).
- UI: `app/src/predictions-validation.js` — "Run Comparison" button, one tab per
  sensor, table sorted by MAE, a "Use" button that pushes the row into the form
  and saves it through `POST /predictions/config`.
- The active predictor is consumed on **every auto-calculate tick**:
  `api/services/vrm-refresh.ts` calls `loadPredictionConfig()` fresh and runs
  `runForecast(runConfig)` when `dataSources.load === 'api'`. A change to
  `prediction-config.json` is therefore live within one tick (≤ 5 min on this
  install). No extra plumbing is needed for a switch to take effect.
- Daily-timer precedent: `api/services/dess-price-refresh.ts` (60 s tick against
  a local `HH:MM`, idempotent `start`/`stop`), booted from `api/index.ts` and
  restarted from `POST /settings` in `api/routes/settings.ts`.
- Suggest/auto precedent: the `adaptiveLearning` settings block, normalized in
  `api/services/settings-schema.ts`, with its UI in
  `app/src/predictions/adaptive-learning.js` (reads/writes settings with the
  600 ms debounce pattern).
- State-store precedent: `api/services/plan-history-store.ts` (ring-buffered
  JSON under `DATA_DIR` via `json-store.ts`).

### Measured baseline (2026-08-22, live add-on)

A full `POST /predictions/validate` takes ~28 s wall-clock, almost all of it the
HA websocket statistics fetch; scoring 480 strategies is negligible. For the
active sensor "Load without EV" over the 7-day window every strategy scored
all 168 hourly points with 0 skipped:

```text
rank  lookback  dayFilter        agg     MAE Wh/h  RMSE  MAPE %
   1     8w     all              median     328     473    34
   2     8w     weekday-weekend  median     336     486    35
   3     8w     weekday-sat-sun  median     346     502    36
   4     6w     all              median     355     505    38
   7     8w     all              mean       369     485    42
  14     4w     all              median     428     594    48
  48     2w     same             median     661     933    76
```

What this tells the design:

- The active config (8w / all / median) is already rank 1, so the feature's job
  is **maintenance** over time, not a one-off fix.
- Adjacent ranks differ by only 2–5 %. A naive "take the minimum every day"
  would flap between the top two. **Hysteresis is mandatory.**
- MAPE is inflated by low night-time loads in the denominator, so **MAE is the
  selection metric** (RMSE as an opt-in alternative that penalizes big misses).
- All top-3 strategies sit at the grid's 8-week cap, which suggests longer
  lookbacks may do better still. Extending the grid is Phase 3, not Phase 1.

## Design

### Principles

1. **Single owner, narrow write.** The selector only ever writes
   `historicalPredictor.lookbackWeeks`, `.dayFilter`, and `.aggregation`. It
   never changes `.sensor` (moving between "Load without EV" and "Total Load" is
   a semantic decision, not an accuracy one) and never touches `activeType`,
   `fixedPredictor`, or `pvConfig`.
2. **Incumbent bias.** Switch only on a material, measured improvement. Ties and
   noise keep the current strategy.
3. **Always score the incumbent explicitly**, even when it is off-grid (for
   example `lookbackWeeks: 5`), so the comparison is like for like.
4. **Same backtest as the button.** Reuse `predict`/`validate` and the same
   rolling one-day-ahead semantics, factored so the comparison table and the
   selector can never disagree about a number.
5. **Suggest before auto.** Default mode is `suggest`; `auto` is opt-in after
   the suggestions have been watched for a while.
6. **Cheap and quiet.** One run per day (one ~30 s HA fetch), scheduled away from
   the 23:01 DESS price-refresh window, guarded against concurrent runs, and
   never throwing out of the timer.

### Selection algorithm (pure, `lib/strategy-selector.ts`)

```ts
export interface StrategyScore {
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
  mae: number;
  rmse: number;
  mape: number;
  n: number;
  nSkipped: number;
}

export interface SelectOptions {
  metric: 'mae' | 'rmse';
  minImprovement_percent: number;   // hysteresis, default 5
  minSamples: number;               // eligibility floor, default 0.8 × expected points
}

export type SelectionReason =
  | 'no-eligible'          // nothing scored enough samples (HA outage, new sensor)
  | 'incumbent-unscored'   // incumbent ineligible but a candidate is → switch
  | 'incumbent-best'       // incumbent is rank 1 (ties included)
  | 'below-threshold'      // a candidate is better but not by minImprovement
  | 'switch';              // candidate clears the threshold

export interface SelectionResult {
  best: StrategyScore | null;
  incumbent: StrategyScore | null;
  shouldSwitch: boolean;
  improvement_percent: number | null;  // (incumbent − best) / incumbent × 100
  reason: SelectionReason;
  ranking: StrategyScore[];            // eligible only, ascending by metric
}

export function selectStrategy(
  scores: StrategyScore[],
  incumbent: Pick<StrategyScore, 'lookbackWeeks' | 'dayFilter' | 'aggregation'>,
  opts: SelectOptions,
): SelectionResult
```

Rules:

- Eligible = finite metric and `n >= minSamples`.
- Sort eligible ascending by `opts.metric`. Tie-break: incumbent first, then
  longer `lookbackWeeks` (more samples per target, more stable).
- `shouldSwitch` is true only when `best` is not the incumbent **and**
  `best[metric] <= incumbent[metric] × (1 − minImprovement_percent / 100)`.
- Incumbent absent from the eligible set while a candidate is eligible →
  `incumbent-unscored`, `shouldSwitch = true` (the current strategy is
  demonstrably unusable on this data). If nothing is eligible at all →
  `no-eligible`, no switch (that is an HA/data problem, not a strategy problem).

### Scoring (refactor in `api/services/load-prediction-service.ts`)

Split `runValidation` into a shared core so both callers use one code path:

```ts
// Fetch + postprocess once; score a list of strategies for one sensor.
export async function scoreStrategies(
  config: PredictionRunConfig,
  sensorName: string,
  strategies: PredictConfig[],
  validationWindow: { start: string; end: string },
  opts?: { includePredictions?: boolean },
): Promise<ValidationEntry[]>
```

- `runValidation` (button) becomes: all sensors × `generateAllConfigs`, with
  `includePredictions: true`, unchanged response shape.
- The selector calls it with `[sensorName]`, `generateAllConfigs([sensor])`
  **plus the incumbent** (deduplicated), `includePredictions: false` — the
  per-hour arrays are the bulk of the payload and are not needed for selection.
- The HA fetch horizon becomes `maxLookbackWeeks(strategies) + ceil(windowDays / 7)`
  weeks instead of the hardcoded `8 + 1`, so an off-grid incumbent or a 14-day
  window is fetched correctly.
- Validation window for the selector: the previous `windowDays` full UTC days,
  computed the same way `loadPredictionConfig()` computes the 7-day one.

### Scheduler service (`api/services/prediction-auto-select.ts`)

Copy the shape of `dess-price-refresh.ts`:

- `startPredictionAutoSelect(settings)` / `stopPredictionAutoSelect()` —
  idempotent; 60 s tick; fires when local time enters the configured `HH:MM`
  minute and `lastRunDate !== today`. Boot catch-up: if the last recorded run
  is older than 24 h (or there is none), run 2 minutes after start so a restart
  never silently skips a day.
- `runAutoSelect({ apply = true }): Promise<AutoSelectRun>` — the unit both
  the timer and the route call:
  1. Load settings and prediction config. Return a `skipped` record with a
     reason when disabled, `activeType !== 'historical'`, no
     `historicalPredictor`, or no HA connection (same check as
     `assertHaConnection`).
  2. `scoreStrategies(...)` for the incumbent's sensor.
  3. `selectStrategy(...)`.
  4. Persist the run record (below).
  5. If `mode === 'auto'` and `shouldSwitch` and `apply`: save
     `historicalPredictor` with the three strategy fields replaced and log
     `[auto-select] switched 8w/all/median → 8w/weekday-weekend/median
     (MAE 328 → 300, −8.5 %)`. Sensor is copied from the incumbent, never from
     the score.
- Concurrency guard (`running` flag, like `auto-calculate.ts`). A manual run
  while one is in flight gets a 409.
- Every failure is caught and logged with the `[auto-select]` prefix; the timer
  must never reject.
- Optional, not in v1: regenerate the load forecast immediately after a switch.
  The next auto-calculate tick does it anyway within 5 minutes and avoiding a
  second HA fetch keeps the service simple.

### Run record store (`api/services/prediction-auto-select-store.ts`)

`DATA_DIR/prediction-auto-select.json`, ring buffer of the last 60 runs, same
load/append/latest helpers as `plan-history-store.ts`:

```json
{
  "at": "2026-08-23T01:30:04.120Z",
  "sensor": "Load without EV",
  "windowDays": 7,
  "metric": "mae",
  "mode": "suggest",
  "incumbent": { "lookbackWeeks": 8, "dayFilter": "all", "aggregation": "median", "mae": 328.0, "rmse": 473.4, "n": 168 },
  "best":      { "lookbackWeeks": 8, "dayFilter": "all", "aggregation": "median", "mae": 328.0, "rmse": 473.4, "n": 168 },
  "improvement_percent": 0,
  "reason": "incumbent-best",
  "action": "kept",
  "ranking": []
}
```

`action` is one of `kept`, `suggested`, `applied`, `skipped`. `ranking` holds
the top 10 eligible scores (enough for the UI badge and a sanity check, small
enough to keep the file trivial). `skipped` records carry a `skipReason`
string.

### Settings (`settings.json`, validated in `settings-schema.ts`)

```json
"predictionAutoSelect": {
  "enabled": false,
  "mode": "suggest",
  "time": "03:30",
  "metric": "mae",
  "minImprovement_percent": 5,
  "windowDays": 7
}
```

- `mode`: `suggest` | `auto`. `metric`: `mae` | `rmse`. `time`: local `HH:MM`
  (reuse the `HH_MM` regex). `minImprovement_percent`: 0–50.
  `windowDays`: 7–14.
- Lives in `settings.json` rather than `prediction-config.json` because it is a
  timer like `dessPriceRefresh` and `adaptiveLearning`: it gets schema
  validation, the `mergeSettings` deep merge, the boot start in `api/index.ts`,
  and the restart in `POST /settings` for free. The selector's **output** (the
  chosen strategy) stays where it has always lived, in `prediction-config.json`.
- Add to `api/types.ts` (`PredictionAutoSelectConfig`, optional on `Settings`),
  `api/defaults/default-settings.json`, `SettingsPatch`, `mergeSettings`, and a
  `normalizePredictionAutoSelect` in the schema.
- Default `enabled: false` keeps the add-on upstream-friendly. This install
  enables it in suggest mode first (see Rollout).

### API (`api/routes/predictions.ts`)

- `GET /predictions/auto-select` → `{ config, lastRun, history }` where
  `config` is the settings block, `lastRun` the latest record (or `null`), and
  `history` the stored ring buffer.
- `POST /predictions/auto-select/run` with body `{ "apply": boolean }`
  (default `true`) → runs now and returns the record. `apply: false` forces a
  dry run regardless of mode. 409 when a run is already in flight, 400 when the
  feature is disabled or the predictor is not historical (mirrors the existing
  `assertCondition` style).
- No separate "apply suggestion" endpoint: the UI applies a suggestion exactly
  the way the "Use" button already does (push the strategy into the form and
  `POST /predictions/config`), which also makes the user's click the new
  incumbent for the next run.
- Document both endpoints in the README API list next to
  `POST /predictions/validate`.

### UI (Predictions tab)

Rename the "Compare Strategies" card to **Strategy Selection** and keep the
existing button inside it.

- Controls (saved with the `adaptive-learning.js` debounce pattern through
  `saveStoredSettings({ predictionAutoSelect })`): Enable checkbox, Mode select
  (Suggest / Auto), Min improvement %, Daily time, Metric (MAE / RMSE).
- Buttons: **Run Comparison** (unchanged, manual deep-dive with charts) and
  **Run selection now** (`POST /predictions/auto-select/run`).
- Status `summary-panel` (same markup family as the adaptive-learning status):
  Last run (relative time), Current strategy with its metric, Best strategy
  with its metric, Δ %, and an outcome chip: `Kept current`, `Suggested`,
  `Switched`, or `Skipped: <reason>`. In suggest mode with a pending
  suggestion, show an **Apply suggestion** button that reuses `onUseConfig`.
- Comparison table: badge the active row ("active") and the last run's best
  row ("best") so the two views line up at a glance.
- New module `app/src/predictions/auto-select.js`, initialized from
  `initPredictionsTab()` next to `initAdaptiveLearning()`. Client helpers in
  `app/src/api/api.js`: `fetchAutoSelect`, `runAutoSelect`.
- Run `npm run build:css` and commit `app/vendor/tailwind.css` if any new
  utility class is introduced (CI fails on a stale build).

### Tests

- `tests/lib/strategy-selector.test.js` — lowest metric wins; exact tie keeps
  the incumbent; improvement below threshold keeps the incumbent; improvement
  at/above threshold switches; `rmse` metric honoured; NaN and low-`n` entries
  excluded; off-grid incumbent scored and kept when best; incumbent ineligible
  with an eligible candidate → `incumbent-unscored`; empty input →
  `no-eligible`; ranking sorted and eligible-only.
- `tests/api/services/load-prediction-service.test.js` — `scoreStrategies`
  fetches `maxLookback + ceil(windowDays/7)` weeks, includes the off-grid
  incumbent exactly once, omits `validationPredictions` when asked; contract
  test that `runValidation` and `scoreStrategies` return identical metrics for
  the same sensor and strategy.
- `tests/api/services/prediction-auto-select.test.js` (fake timers, modelled
  on `dess-price-refresh.test.js`) — fires once at the configured minute and
  not again that day; boot catch-up when the last run is stale; no run when
  disabled, `activeType: fixed`, or no HA connection (and no HA fetch in those
  cases); suggest mode records without writing the prediction config; auto
  mode writes only the three strategy fields and leaves `sensor` untouched;
  concurrent run rejected; thrown errors are logged, not propagated.
- `tests/api/api.test.js` — the two routes with the service mocked (200, 400,
  409 paths).
- `tests/api/services/settings-schema.test.js` — normalization and rejection
  cases for `predictionAutoSelect` (bad `HH:MM`, out-of-range percent, bad
  enum).
- `tests/app/predictions-auto-select.test.js` (jsdom) — status rendering for
  each `action`, Apply button visible only for a pending suggestion, settings
  saved on change.

## Phases

**Phase 1 — backend (one PR, v0.7.55).** Selector lib, `scoreStrategies`
refactor, run-record store, scheduler service, settings block + schema,
routes, boot/restart wiring in `api/index.ts` and `api/routes/settings.ts`,
tests, README + CHANGELOG. Fully operable without UI via `POST /settings` and
the two new endpoints.

**Phase 2 — UI (one PR, v0.7.56).** Strategy Selection card, status panel,
table badges, jsdom tests, CSS rebuild if needed.

**Phase 3 — optional refinements, each its own PR, only if Phase 1–2 data asks
for it.**

- Extend `generateAllConfigs` lookbacks to `1, 2, 3, 4, 6, 8, 12` (fetch
  horizon grows to 13 weeks). Motivated by all top-3 strategies sitting at the
  8-week cap. The `minSamples` guard already handles sensors with less
  history.
- Confirmation debounce: a `confirmRuns` setting requiring the same candidate
  to clear the threshold on N consecutive runs before auto mode applies it.
  Adds a second anti-flap mechanism if the 5 % margin alone proves twitchy.
- Price-weighted metric: weight each hour's absolute error by that hour's
  import price so evening-peak misses (which cost the LP most) dominate the
  score. Needs the price series joined to the backtest; worth it only if the
  MAE winner is visibly wrong in the peak.
- PV model auto-selection over `pvModel × pvMode` using `validatePvForecast` in
  `pv-prediction-service.ts`. Same `selectStrategy` helper, different scoring
  path; explicitly out of scope for this plan.

## Rollout on this install

1. Deploy ≥ 0.7.55, then
   `POST /settings {"predictionAutoSelect":{"enabled":true,"mode":"suggest","time":"03:30"}}`.
   03:30 local is clear of the 23:01–23:31 DESS price-refresh window and of
   the HA recorder maintenance around 04:30.
2. Watch `GET /predictions/auto-select` for about a week. Expected steady
   state with the current data: `incumbent-best` or `below-threshold` on most
   days, with the ranking stable at the top.
3. If the suggestions look sane, flip `mode` to `auto`. Manual "Use" clicks
   remain possible in auto mode: they simply become the new incumbent and are
   kept unless something beats them by more than the margin.

## Acceptance criteria

- With the 2026-08-22 data a run returns `incumbent-best` and writes nothing.
- A synthetic ranking where a candidate is 4 % better → `below-threshold`,
  nothing written. 6 % better → suggest mode records `suggested` and leaves
  `prediction-config.json` untouched; auto mode records `applied`, updates only
  the three strategy fields, and the next `vrm-refresh` tick forecasts with
  the new strategy.
- `activeType: fixed` → `skipped` record, no HA fetch.
- HA unreachable → `no-eligible` (or `skipped` on the connection guard),
  logged once, timer keeps running.
- `npm run lint`, `npm run typecheck`, and `npm run test:run` are green; this
  plan passes the markdown lint.

## Versioning

Phase 1 ships as 0.7.55, Phase 2 as 0.7.56. Bump `package.json`,
`package-lock.json` (`npm install --package-lock-only`), `optivolt/config.yaml`,
and add the CHANGELOG section at the top.
