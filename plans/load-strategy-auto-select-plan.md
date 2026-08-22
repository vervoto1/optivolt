# Load Predictor Auto-Selection — Implementation Plan

## Status

Phases 1 and 2 implemented in v0.7.55 (`lib/strategy-selector.ts`,
`api/services/prediction-auto-select.ts`, `api/services/prediction-auto-select-store.ts`,
`scoreStrategies` in `api/services/load-prediction-service.ts`, the
`predictionAutoSelect` settings block, `GET/POST /predictions/auto-select`, and
the Strategy Selection card on the Predictions tab). Phase 3 items remain
open. The rest of this document is the build brief the implementation followed.

## Goal

Replace the manual loop "Run Comparison → read the rows → click Use" with a
daily backtest that scores every historical-predictor strategy for the active
load sensor and then either:

- **suggest mode** — records the winner so the UI can show "best strategy is X,
  −7 % MAE vs current" with an Apply button, or
- **auto mode** — rewrites `historicalPredictor` when the winner beats the
  incumbent by a configurable margin over a long enough window.

The comparison button stays for manual deep-dives; the selector just runs the
same backtest on a timer and acts on the result.

## What exists today (read first)

- `lib/load-predictor-historical.ts` — pure `predict`, `validate`, and
  `generateAllConfigs`. The default grid is hardcoded: lookbacks
  `1, 2, 3, 4, 6, 8` weeks × 4 day filters × 2 aggregations = 48 strategies
  per sensor. The 8-week cap has no constraint behind it (see the baseline
  below); `runValidation` just mirrors it as `MAX_LOOKBACK_WEEKS = 8` to size
  the HA fetch. The manual Lookback input in the UI has `min="1"` and no max.
- `predict(data, cfg, targets?)` scores every history entry unless `targets`
  is given. `runValidation` does not pass targets, so it predicts all 9 weeks
  of history for every strategy and then keeps only the 7-day window.
- `api/services/load-prediction-service.ts::runValidation` — fetches 9 weeks
  of HA long-term statistics for every configured sensor, `postprocess`es, runs
  all 48 strategies for each of the 10 sensor names (480 results) and returns
  metrics plus the per-hour `validationPredictions` for charting. The
  validation window is the previous 7 full UTC days, recomputed on every
  `loadPredictionConfig()` call.
- `POST /predictions/validate` → `executePredictionValidation` (HA-connection
  and sensor guards, HA error mapping to 502).
- UI: `app/src/predictions-validation.js` — "Run Comparison" button, one tab
  per sensor, table sorted by MAE, a "Use" button that pushes the row into the
  form and saves it through `POST /predictions/config`.
- The active predictor is consumed on **every auto-calculate tick**:
  `api/services/vrm-refresh.ts` calls `loadPredictionConfig()` fresh and runs
  `runForecast(runConfig)` when `dataSources.load === 'api'`. A change to
  `prediction-config.json` is therefore live within one tick (≤ 5 min on this
  install). No extra plumbing is needed for a switch to take effect.
- Daily-timer precedent: `api/services/dess-price-refresh.ts` (60 s tick
  against a local `HH:MM`, idempotent `start`/`stop`), booted from
  `api/index.ts` and restarted from `POST /settings` in
  `api/routes/settings.ts`.
- Suggest/auto precedent: the `adaptiveLearning` settings block, normalized in
  `api/services/settings-schema.ts`, with its UI in
  `app/src/predictions/adaptive-learning.js` (reads/writes settings with the
  600 ms debounce pattern).
- State-store precedent: `api/services/plan-history-store.ts` (ring-buffered
  JSON under `DATA_DIR` via `json-store.ts`).

### Measured baseline (2026-08-22, live add-on, sensor "Load without EV")

**Cost.** A full `POST /predictions/validate` takes ~28 s. That is CPU time in
`predict()`, not I/O: a 27-week × 9-sensor `fetchHaStats` took 0.2 s on this
install, while scoring 48 strategies over all 9 weeks of history takes ~3.5 s
per sensor (× 10 sensors ≈ 35 s). Restricting `predict()` to the window's
entries via `targets` cuts that 2.3× at 9 weeks and 6.7× at 27 weeks (42 s →
6 s per sensor for 80 strategies and a 28-day window). With a longer grid the
button becomes unusable without this change (~7 min for all sensors).

**Data.** HA hourly statistics for all nine sensors start on 2026-02-14
(189 days), so lookbacks up to ~26 weeks are available today.

**Last 7 days, current 48-strategy grid** (168 hourly points, 0 skipped for
every strategy):

```text
rank  lookback  dayFilter        agg     MAE Wh/h  RMSE  MAPE %
   1     8w     all              median     328     473    34
   2     8w     weekday-weekend  median     336     486    35
   3     8w     weekday-sat-sun  median     346     502    36
   4     6w     all              median     355     505    38
   7     8w     all              mean       369     485    42
  48     2w     same             median     661     933    76
```

**Lookback sweep 1–26 weeks** (80 strategies) over windows of different
lengths, all ending 2026-08-22:

```text
window        best strategy                 MAE   current 8w/all/median  rank of current
last 7 days   12w weekday-sat-sun median    311   328  (best is −5 %)     10 / 88
14 days       26w all median                398   405  (best is −2 %)     11 / 88
28 days       26w all median                457   483  (best is −5 %)     22 / 88
56 days        1w all median                510   515  (best is −1 %)      2 / 88
```

Weekly winners over the last eight 7-day windows, newest first: 12w, 2w, 1w,
26w, 1w, 4w, 8w, 4w. The `1w all mean` strategy was rank 86 of 88 one week and
rank 1 two weeks later. Over the 56-day window the best MAE per lookback spans
only 510–538 across all eleven lookbacks (±3 %).

What this tells the design:

- **The 8-week cap is arbitrary.** It is not a data limit and not a fetch-cost
  limit. Extend the grid in Phase 1 — it is cheap insurance, but not a big
  win: judged over 8 weeks the whole grid sits within ±3 %.
- **A 7-day selection window chases noise.** The weekly winner jumps between
  1 and 26 weeks; single outlier hours (postprocess dropped implausible
  battery samples on 08-14 and 08-15, inside the current window) swing a
  7-day MAE. Default `windowDays` to 28, allow 14–56.
- **Hysteresis must be wide.** Differences under ~10 % over 28 days are
  inside the noise band. Default `minImprovement_percent` to 10.
- MAPE is inflated by low night-time loads in the denominator, so **MAE is the
  selection metric** (RMSE as an opt-in alternative that penalizes big misses).
- The active 8w / all / median is a sound incumbent: rank 2 of 88 over
  56 days. The feature's job is **maintenance** over time, not a one-off fix.
- The strategy *family* is the limiting factor, not its parameters: mid-July
  windows had MAE 720–800 for every strategy versus ~330 in calm weeks. A
  different predictor (recent-level × long-term-shape blend, weather-aware
  days) is where the next real gain is — out of scope here, listed under
  Phase 3.

## Design

### Principles

1. **Single owner, narrow write.** The selector only ever writes
   `historicalPredictor.lookbackWeeks`, `.dayFilter`, and `.aggregation`. It
   never changes `.sensor` (moving between "Load without EV" and "Total Load" is
   a semantic decision, not an accuracy one) and never touches `activeType`,
   `fixedPredictor`, or `pvConfig`.
2. **Incumbent bias.** Switch only on a material, sustained improvement. Ties
   and noise keep the current strategy.
3. **Always score the incumbent explicitly**, even when it is off-grid (for
   example `lookbackWeeks: 5`), so the comparison is like for like.
4. **Same backtest as the button.** Reuse `predict`/`validate` and the same
   rolling one-day-ahead semantics, factored so the comparison table and the
   selector can never disagree about a number.
5. **Suggest before auto.** Default mode is `suggest`; `auto` is opt-in after
   the suggestions have been watched for a while.
6. **Cheap and quiet.** One run per day, one sensor, scoring restricted to the
   window, scheduled away from the 23:01 DESS price-refresh window, guarded
   against concurrent runs, and never throwing out of the timer.

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
  minImprovement_percent: number;   // hysteresis, default 10
  minSamples: number;               // eligibility floor, default 0.8 × 24 × windowDays
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

### Strategy grid

Change the `generateAllConfigs` default lookbacks to
`1, 2, 3, 4, 6, 8, 12, 16, 20, 26` (80 strategies per sensor). Keep the day
filters and aggregations. Derive every fetch horizon from the grid instead of
a hardcoded constant: `max(lookbackWeeks) + ceil(windowDays / 7)` weeks —
27 weeks for the button's 7-day window, 30 weeks for the selector's default
28-day window. A sensor with less history simply scores fewer samples and the
`minSamples` guard handles it.

### Scoring (refactor in `api/services/load-prediction-service.ts`)

Split `runValidation` into a shared core so both callers use one code path:

```ts
// Fetch + postprocess once; score a list of strategies for one sensor,
// predicting only the entries inside the validation window.
export async function scoreStrategies(
  config: PredictionRunConfig,
  sensorName: string,
  strategies: PredictConfig[],
  validationWindow: { start: string; end: string },
  opts?: { includePredictions?: boolean },
): Promise<ValidationEntry[]>
```

- **Pass `targets`.** Build the target list as the sensor's entries inside
  the window and hand it to `predict(data, cfg, targets)`. This is the single
  most important performance change: it keeps the button at roughly today's
  speed despite the larger grid (~1.6 s per sensor for 80 strategies over
  7 days) and keeps the selector's daily run around 6 s.
- `runValidation` (button) becomes: all sensors × `generateAllConfigs`, with
  `includePredictions: true`, unchanged response shape.
- The selector calls it with `[sensorName]`, `generateAllConfigs([sensor])`
  **plus the incumbent** (deduplicated), `includePredictions: false` — the
  per-hour arrays are the bulk of the payload and are not needed for selection.
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
     `[auto-select] switched 8w/all/median → 26w/all/median
     (MAE 483 → 430, −11 %)`. Sensor is copied from the incumbent, never from
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
  "windowDays": 28,
  "metric": "mae",
  "mode": "suggest",
  "incumbent": { "lookbackWeeks": 8, "dayFilter": "all", "aggregation": "median", "mae": 483.0, "rmse": 720.1, "n": 672 },
  "best":      { "lookbackWeeks": 26, "dayFilter": "all", "aggregation": "median", "mae": 457.0, "rmse": 692.3, "n": 672 },
  "improvement_percent": 5.4,
  "reason": "below-threshold",
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
  "minImprovement_percent": 10,
  "windowDays": 28
}
```

- `mode`: `suggest` | `auto`. `metric`: `mae` | `rmse`. `time`: local `HH:MM`
  (reuse the `HH_MM` regex). `minImprovement_percent`: 0–50.
  `windowDays`: 14–56.
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
  (Suggest / Auto), Min improvement %, Window days, Daily time, Metric
  (MAE / RMSE).
- Buttons: **Run Comparison** (unchanged, manual deep-dive with charts) and
  **Run selection now** (`POST /predictions/auto-select/run`).
- Status `summary-panel` (same markup family as the adaptive-learning status):
  Last run (relative time), Current strategy with its metric, Best strategy
  with its metric, Δ %, and an outcome chip: `Kept current`, `Suggested`,
  `Switched`, or `Skipped: <reason>`. In suggest mode with a pending
  suggestion, show an **Apply suggestion** button that reuses `onUseConfig`.
- Comparison table: badge the active row ("active") and the last run's best
  row ("best") so the two views line up at a glance. The table now has 80 rows
  per sensor; keep the MAE sort and consider collapsing rows past the top 20
  behind a "show all" toggle.
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
- `tests/lib/load-predictor-historical.test.js` — `generateAllConfigs` default
  grid includes 12–26 weeks; predictions with `targets` equal the
  window-filtered predictions without `targets` for the same strategy.
- `tests/api/services/load-prediction-service.test.js` — `scoreStrategies`
  fetches `maxLookback + ceil(windowDays/7)` weeks, passes only in-window
  targets to `predict`, includes the off-grid incumbent exactly once, omits
  `validationPredictions` when asked; contract test that `runValidation` and
  `scoreStrategies` return identical metrics for the same sensor and strategy.
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
  cases for `predictionAutoSelect` (bad `HH:MM`, out-of-range percent or
  window, bad enum).
- `tests/app/predictions-auto-select.test.js` (jsdom) — status rendering for
  each `action`, Apply button visible only for a pending suggestion, settings
  saved on change.

## Phases

**Phase 1 — backend (one PR, v0.7.55).** Extended grid + derived fetch
horizon, `scoreStrategies` refactor with `targets`, selector lib, run-record
store, scheduler service, settings block + schema, routes, boot/restart wiring
in `api/index.ts` and `api/routes/settings.ts`, tests, README + CHANGELOG.
Fully operable without UI via `POST /settings` and the two new endpoints. The
existing button gets faster and wider as a side effect.

**Phase 2 — UI (one PR, v0.7.56).** Strategy Selection card, status panel,
table badges and show-all toggle, jsdom tests, CSS rebuild if needed.

**Phase 3 — optional refinements, each its own PR, only if Phase 1–2 data asks
for it.**

- Confirmation debounce: a `confirmRuns` setting requiring the same candidate
  to clear the threshold on N consecutive runs before auto mode applies it.
  Adds a second anti-flap mechanism if the 10 % margin alone proves twitchy.
- `predict()` inner-loop speed: it builds a `Date` and an ISO string per
  (entry × lookback day). Keying the lookup by local (day, hour) integers
  would cut scoring several-fold again. Must preserve the documented local-time
  DST behaviour; the existing tests cover it.
- Price-weighted metric: weight each hour's absolute error by that hour's
  import price so evening-peak misses (which cost the LP most) dominate the
  score. Needs the price series joined to the backtest; worth it only if the
  MAE winner is visibly wrong in the peak.
- A new predictor family. Every strategy in the grid lands within a few
  percent of the others over long windows, and all of them miss regime weeks
  (mid-July MAE 720–800 versus ~330 in calm weeks). A blend of last-week level
  with long-term hourly shape, or a weather-aware day classifier, would move
  the number; the selector described here would then pick between families
  the same way it picks between parameters.
- PV model auto-selection over `pvModel × pvMode` using `validatePvForecast` in
  `pv-prediction-service.ts`. Same `selectStrategy` helper, different scoring
  path; explicitly out of scope for this plan.

## Rollout on this install

1. Deploy ≥ 0.7.55, then
   `POST /settings {"predictionAutoSelect":{"enabled":true,"mode":"suggest","time":"03:30"}}`.
   03:30 local is clear of the 23:01–23:31 DESS price-refresh window and of
   the HA recorder maintenance around 04:30.
2. Watch `GET /predictions/auto-select` for about two weeks. Expected steady
   state on the August data: `below-threshold` most days (26w / all / median
   about 5 % ahead of the incumbent over 28 days, inside the noise band), with
   the top of the ranking stable.
3. If the suggestions look sane, flip `mode` to `auto`. Manual "Use" clicks
   remain possible in auto mode: they simply become the new incumbent and are
   kept unless something beats them by more than the margin.

## Acceptance criteria

- Replaying the 2026-08-22 data with the defaults (28 days, 10 %): best is
  26w / all / median at about −5 % → `below-threshold`, nothing written. The
  same data with `minImprovement_percent: 5` → `switch`.
- A synthetic ranking where a candidate is 9 % better → `below-threshold`,
  nothing written. 11 % better → suggest mode records `suggested` and leaves
  `prediction-config.json` untouched; auto mode records `applied`, updates only
  the three strategy fields, and the next `vrm-refresh` tick forecasts with
  the new strategy.
- `POST /predictions/validate` with the 80-strategy grid completes in well
  under 30 s for all ten sensors on this install (targets restricted to the
  window).
- `activeType: fixed` → `skipped` record, no HA fetch.
- HA unreachable → `no-eligible` (or `skipped` on the connection guard),
  logged once, timer keeps running.
- `npm run lint`, `npm run typecheck`, and `npm run test:run` are green; this
  plan passes the markdown lint.

## Versioning

Phase 1 ships as 0.7.55, Phase 2 as 0.7.56. Bump `package.json`,
`package-lock.json` (`npm install --package-lock-only`), `optivolt/config.yaml`,
and add the CHANGELOG section at the top.
