# TODOS

## UI

### Verify Tailwind v4 rendering on the wall-panel browser

**What:** Load the dashboard on the actual wall-mounted tablet / older WebViews and confirm colors render.

**Why:** Tailwind v4 emits all palette colors exclusively as `oklch()` custom properties with no hex fallbacks. Browsers below Chrome/Edge 111, Safari 15.4, or Firefox 113 render the UI without colors — silently. HA dashboards are commonly viewed on old frozen Android WebViews.

**Context:** Introduced by the Tailwind 3→4 migration in v0.7.54. If an affected device turns up, options are a PostCSS fallback pass over `app/vendor/tailwind.css` or pinning that device's browser. A quick eyeball of shadows/focus rings/dark mode on a modern browser is also still outstanding (CSS-level parity was verified, pixels were not).

**Effort:** S
**Priority:** P2
**Depends on:** None

### Migrate the inline `<style>` block in index.html into `@layer components`

**What:** Move the ~200-line unlayered `<style>` block (`.card`, `.form-input`, `.toggle`, …) into a cascade layer below Tailwind's utilities.

**Why:** Since Tailwind v4 puts utilities in `@layer`, unlayered author CSS beats every utility regardless of specificity — future "add a utility to override `.form-input`" edits silently lose unless the `!` important-prefix is used.

**Context:** Flagged by the v0.7.54 adversarial review; current clashes are pre-handled with `!`-prefixed utilities (e.g. `!mt-0` in `ess-tab.js`) and a warning comment now sits at the top of the style block. Migrating means wrapping the block in `@layer components { … }` and re-testing visual parity.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Add busy states to the Strategy Selection buttons

**What:** Disable and relabel **Apply suggestion** while its save is in flight, and have **Run Selection** and **Run Comparison** disable each other for the duration of either run.

**Why:** `onApply` awaits a network save with no visual feedback, so a double-click fires duplicate `POST /predictions/config` calls. Run Selection and Run Comparison both trigger long HA reads but neither disables the other, which makes the service's 409 guard reachable from the UI and surfaces it as a raw `Error: Auto-select run already in progress` string.

**Context:** `app/src/predictions/auto-select.js` already has a `setBusy()` helper used by `onRunNow`; `onApply` just never calls it. The adaptive-learning card this was modelled on does disable during saves. A shared `setPredictionsBusy(bool)` would cover the cross-button case and remove the 409 as a reachable state.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Refresh the comparison badges after applying a suggestion

**What:** Re-run the comparison table's highlight pass after **Apply suggestion** saves.

**Why:** The table's own "Use" button calls `rerenderTable(deps)` after saving and a manual run re-renders via `onRunComplete`, but `onApply` only calls `renderRun(lastRun)`. Nothing re-reads `getHighlights()`, so the ACTIVE badge stays on the previous strategy until the next run or a sensor-tab click.

**Context:** `app/src/predictions/auto-select.js` `onApply`. Needs an `onApplied` dep threaded from `app/src/predictions/config-form.js`, mirroring the existing `onRunComplete` wiring.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Announce auto-select status changes to assistive tech

**What:** Add `role="status"` and `aria-live="polite"` to `#autosel-outcome` and `#pred-status`, and `aria-expanded` to the show-all toggle.

**Why:** `#autosel-outcome` is the only surface for the result of a multi-second run and for every error path. A screen-reader user presses Run Selection, hears the label change to "Running...", then gets no announcement when the result or a 500 lands seconds later. The show-all toggle reveals about 60 table rows with no expanded/collapsed semantics.

**Context:** `app/index.html` around the Strategy Selection summary panel and `#pred-show-all`. The toggle's label already carries the state visually, so only the ARIA is missing.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Fix the Gain tile's sign convention

**What:** Either relabel the tile to "MAE change" so the leading minus is coherent, or keep "Gain" and drop the minus. Render negative improvements instead of collapsing them to "0 %".

**Why:** A 12.3 % improvement currently renders as `-12.3 %` under a label reading "Gain", which reads as a regression. The same inversion reaches the outcome copy (`Switched to best (-12.3 %)`). Separately, `pct > 0 ? ... : '0 %'` hides the case where the best strategy scored worse than the incumbent.

**Context:** `app/src/predictions/auto-select.js` `renderRun`, and the tile label in `app/index.html`. The minus is the server's error-reduction convention, so whichever way this goes, the log copy in `api/services/prediction-auto-select.ts` should match.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Distinguish a failed auto-select status fetch from "no run yet"

**What:** Render a distinct state when `GET /predictions/auto-select` fails, instead of falling through to the null-run branch.

**Why:** `refreshAutoSelectStatus` swallows the error and paints "Last run: Never / No run yet", which is indistinguishable from a genuinely-never-run feature. The only signal is a `console.warn` inside a container.

**Context:** `app/src/predictions/auto-select.js`. The adaptive-learning card has the same habit, so this is consistent with precedent rather than new, but this panel's whole job is reporting run state.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Give `.form-checkbox` a real style or drop the class

**What:** Add a `.form-checkbox` rule to the inline style block, or remove the class from its call sites.

**Why:** The class resolves to nothing. It is a `@tailwindcss/forms` plugin class and that plugin is not in `tailwind.source.css`; the inline `<style>` block defines `.form-input`, `.form-select`, `.summary-panel`, `.stat-label` and `.stat-value` but not `.form-checkbox`. The checkbox renders as an unstyled native control.

**Context:** `app/index.html`, the auto-select enable checkbox and the adaptive-learning card, which does the same thing. Pre-existing pattern rather than a regression.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Use `.stat-value` consistently in the Strategy Selection panel

**What:** Apply `.stat-value` to the Current and Best cells, or drop it from the adjacent Gain cell.

**Why:** Within one three-column stat row, Current and Best use `text-xs font-semibold` while Gain uses `.stat-value` (JetBrains Mono, its own light and dark colors). The result is two sans-serif, brighter cells next to one mono, dimmer cell, and the mismatch is more pronounced in dark mode. Every other summary-panel stat grid in the file uses `.stat-value` uniformly.

**Context:** `app/index.html`, Strategy Selection summary panel. Mono may need a truncating wrapper since the strategy string is wide.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Solver

### Decide the vendored HiGHS WASM build's refresh story

**What:** Establish how `vendor/highs-build/` (the actual runtime LP solver) gets updated, now that the npm `highs` package is removed.

**Why:** The vendored build receives no updates from dependency refreshes; a stale solver is a silent-wrong-results vector long-term, and the Docker image ships it directly.

**Context:** v0.7.54 removed the unused npm `highs` dependency (imported nowhere; the vendored build differs from npm's — verified by hash). Upstream (`bmesuere/optivolt`) may import npm `highs` directly, so future ported commits may need the import path rewritten to the vendored build.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Predictions

### Range-check `HH:MM` settings and flag a zero improvement margin

**What:** Validate that `HH:MM` values are real clock times, and warn on (or floor) a `minImprovement_percent` of 0.

**Why:** `HH_MM` is `/^\d{2}:\d{2}$/` with no range check, so `"99:99"` and `"24:00"` persist happily. `isInFireWindow` then computes `startMinutes = 6039`, which the current minute-of-day can never reach: the feature reports `enabled: true`, arms a timer and never runs, and the only symptom is an ever-older "Last run". Separately, `minImprovement_percent: 0` is accepted unwarned, at which point the selector switches to anything strictly better every day, which is the flapping the hysteresis exists to prevent.

**Context:** `api/services/settings-schema.ts`. The same regex gap applies to `dessPriceRefresh.time`. Clamp rather than throw: `normalizeSettings` runs on *load*, so a stricter validator would hard-fail startup for anyone who already has a bad value stored. That makes this a migration, not a one-line regex change.

**Effort:** M
**Priority:** P1
**Depends on:** None

### Record failed auto-select runs

**What:** Append a run record with an error reason when a scheduled, catch-up or manual run throws, and render it on the card.

**Why:** `appendAutoSelectRun` is only reached on success or on a deliberate skip. An expired HA token, a WebSocket timeout or an unavailable recorder records nothing at all, so a permanently broken selector shows in the UI as the last *successful* outcome forever. The only signal is a console line inside a container.

**Context:** `api/services/prediction-auto-select.ts` `runScheduled`. Needs a `failed` member on `AutoSelectAction` plus rendering in `app/src/predictions/auto-select.js`, which already has a `warn`/`error` tone.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Make the daily run guards trigger- and outcome-aware

**What:** Gate the "already ran today" and 24-hour catch-up checks on `trigger !== 'manual'` and `action !== 'skipped'`, and stop consuming the day before the run actually succeeds.

**Why:** Three separate holes share one cause. A manual or dry run earlier in the day cancels that day's real scheduled run. Any run within 24 hours, including one that skipped because HA credentials were briefly absent, suppresses the boot catch-up. And `tick` sets `lastRunDayKey = dayKey` before awaiting anything, so a 409 collision with a manual run, or a thrown scoring error, loses the whole day with no retry.

**Context:** `api/services/prediction-auto-select.ts` `tick` and `catchUp`. The persisted record already carries both `trigger` and `action`, so the guards have everything they need. Also clear or re-check `lastRunDayKey` on the failure path; note `stopPredictionAutoSelect` currently resets it, so a settings save inside the fire window lets the next tick re-enter and the resulting 409 is logged misleadingly as "scheduled run failed".

**Effort:** M
**Priority:** P1
**Depends on:** None

### Make the daily fire window DST- and midnight-safe

**What:** Replace the wall-clock minute comparison with a wrap-aware check, or track a monotonic next-due timestamp. Share one helper with `dess-price-refresh.ts`.

**Why:** `isInFireWindow` compares local minutes-of-day against `[start, start + 5)` with no wrap. A configured time at or after 23:55 gets a silently truncated tolerance, and on the spring-forward day a time inside the skipped hour never fires at all: probed under `TZ=Europe/Amsterdam`, `time: '02:30'` on 2027-03-28 produced no run across four simulated hours while the identical schedule fired the day before. The 03:30 default dodges both; a user who picks another time does not.

**Context:** `api/services/prediction-auto-select.ts`. `dess-price-refresh.ts` has a near-identical `isInWindow` differing only in taking the duration as a parameter, so both copies need any fix applied in lockstep unless they are merged first.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Apply hysteresis to the `incumbent-unscored` switch

**What:** Require a margin (or an explicit opt-in) before auto mode applies a switch triggered by an unscoreable incumbent, and document the path.

**Why:** This is the one branch that bypasses the entire safety design: `minImprovement_percent` is never consulted, so a transient data condition that happens to hit only the current strategy triggers an unconditional live rewrite. A recorder gap exactly one lookback period before the window is enough, as is a malformed `historicalPredictor` whose `lookbackWeeks` yields `NaN`. The README describes auto mode as switching only when the margin is cleared, so this write path is undocumented.

**Context:** `lib/strategy-selector.ts`, the `!incumbentScore` branch. The UI half of this was already fixed: the card no longer claims "Switched to best (-0.0 %)" when `improvement_percent` is null.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Score candidates on a common sample set

**What:** Rank strategies over the intersection of timestamps every candidate could predict, or require `n` within a tight band of `max(n)` rather than a flat floor.

**Why:** Eligibility is `n >= 0.8 * 24 * windowDays`, a floor and not an equality, so a strategy scoring 538 of 672 points is ranked head-to-head against one scoring all 672 on means computed over different hour sets. `nSkipped` is computed and persisted but never used in the decision, and the card never surfaces `n`, so a suggestion can read as a clear win when it was measured on 80 % of the window.

**Context:** `lib/strategy-selector.ts` eligibility filter, and the `MIN_SAMPLES_SHARE` derivation in `api/services/prediction-auto-select.ts`. Worth pinning the derived floor in a test at the same time: the current tests use `n` values far from any plausible threshold, so a regression to `MIN_SAMPLES_SHARE * windowDays` would pass the suite.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Validate `historicalPredictor` on write

**What:** Schema-validate the prediction config on `POST /predictions/config` the way `normalizeSettings` validates the settings payload, with `lookbackWeeks` an integer in a sane range.

**Why:** The route does `{ ...prev, ...rest }` with no checks, and the value reaches date math and a synchronous loop. `lookbackWeeks: 20000` drives `new Date(...).toISOString()` past the representable range and returns a 500. `lookbackWeeks: 1e7` is worse: `predict` runs roughly 7e10 iterations with no yield, hanging the single-threaded process that is also driving MQTT setpoints. The UI's `min="1"` input has no `max`, so this is reachable without any adversary.

**Context:** `api/routes/predictions.ts`, `api/services/prediction-config-store.ts`. Pre-existing field, but the auto-select feature added a second unauthenticated path that consumes it and widened the target set.

**Effort:** M
**Priority:** P1
**Depends on:** None

### Close the server-side lost update on `prediction-config.json`

**What:** Re-read the config immediately before writing and apply only the three strategy fields, or hold a process-level mutex across load and save.

**Why:** `runAutoSelect` snapshots the whole config, then writes it back unchanged apart from the strategy after a 30-second-timeout HA fetch plus seconds of scoring. Any UI edit that lands inside that window, to the sensor, PV config, `activeType` or the sensor list, is silently reverted. Nothing logs it and the run record does not show it.

**Context:** `api/services/prediction-auto-select.ts`. The browser half of this was already fixed with a dirty-flag gate in `app/src/predictions/config-form.js`, so the form no longer clobbers server-applied strategies; this is the writer pointing the other way.

**Effort:** M
**Priority:** P1
**Depends on:** Make `writeJson` tear-proof

### Project run records to the declared `StrategyScore` shape

**What:** Map scores to the declared fields before persisting `incumbent`, `best` and `ranking`.

**Why:** Those fields are typed `StrategyScore`, but at runtime they are the `ValidationEntry` objects `scoreStrategies` returns, so every stored record and every API response carries an undeclared `sensor` and an always-empty `validationPredictions: []`. TypeScript's structural assignability hides it. This already caused one real bug: spreading `best` into the prediction form silently moved the active sensor.

**Context:** `api/services/prediction-auto-select.ts` record construction, `api/types.ts`. Beyond the type lie, flipping `includePredictions` on for the selector would balloon the ring buffer by 60 x 10 x 672 prediction points.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Abort an in-flight run when the selector is stopped

**What:** Re-check `configEnabled` after each await in `tick` and `catchUp`, or drop the guards and the `v8 ignore` comments that call them unreachable.

**Why:** Both guards run synchronously before any await, so they are dead code as written and the `v8 ignore` comments hide that rather than an untested branch. The race they look like they cover is real and untested: with a tick suspended on the history read, `stopPredictionAutoSelect()` followed by the read resolving still reaches `savePredictionConfig` in auto mode. Since `POST /settings` stops and starts every timer on each save, disabling the feature mid-run does not stop that run from writing.

**Context:** `api/services/prediction-auto-select.ts`. `dess-price-refresh.ts` has the same shape, so this is an established pattern rather than a new defect, but this service writes the predictor config rather than a Victron setpoint.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Align the backtest window with the local trigger day

**What:** Compute the validation window from the local day the run fires on, or document the UTC choice.

**Why:** `computeValidationWindow` ends at UTC midnight while the scheduler fires on local time. East of roughly UTC+11 a 03:30 local run lands on the previous UTC day, so the window excludes about 38 hours of the freshest history. It is consistent day to day, just staler than intended, and invisible from the card.

**Context:** `api/services/prediction-auto-select.ts`. `loadPredictionConfig` builds its 7-day window the same way, so any change should cover both.

**Effort:** S
**Priority:** P3
**Depends on:** Share one validation-window helper

### Fix the store test that never exercises its non-array guard

**What:** Seed the exact `HISTORY_PATH` key instead of deriving it from an already-emptied store.

**Why:** The "treats a non-array file as empty" test reads `Object.keys(_getStore())[0]`, which `beforeEach` has just cleared, so it is always `undefined` and the test falls through to a hardcoded path that duplicates the production constant. If that filename ever changes, the seeded key stops matching, `readJson` throws `ENOENT`, the function returns `[]` through the ENOENT branch instead, and the assertion still passes. The test silently stops covering the `Array.isArray` guard it is named after.

**Context:** `tests/api/services/prediction-auto-select-store.test.js`. Export `HISTORY_PATH` or assert `readJson` was called with the seeded path.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Storage

### Make `writeJson` tear-proof

**What:** Give the temp file a unique suffix instead of a fixed `${filePath}.tmp`.

**Why:** Every JSON store shares one temp path per target file. `rename` is atomic but the two `writeFile` calls are not mutually exclusive, so two concurrent writers can rename a file containing a mix of both payloads. `loadPredictionConfig` rethrows anything that is not `ENOENT`, so a torn config breaks every forecast until it is repaired by hand. The auto-select feature is what added a second concurrent writer to that file.

**Context:** `api/services/json-store.ts`, used by settings, data, prediction config, plan history and the auto-select ring buffer.

**Effort:** S
**Priority:** P1
**Depends on:** None

## API

### Stop shipping `validationPredictions` for every strategy

**What:** Return only the metric rows from `POST /predictions/validate` and fetch a single strategy's per-hour predictions on demand when a chart is opened.

**Why:** The response carries a full per-hour array for every scored strategy. The grid extension took that from 480 to 800 arrays, and the serialized payload from about 8.8 MB to 14.6 MB, sent uncompressed since no compression middleware is mounted. The client reads `row.validationPredictions` only inside `onShowChart(row)`, so 799 of the 800 arrays are dead weight on every run.

**Context:** `api/services/load-prediction-service.ts`, `app/src/predictions-validation.js`. This is a response-shape change to a documented endpoint, not a pure fix, so it needs a matching client change and a README update. The server already has the data path via `scoreStrategies` with an explicit strategy list.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Trim `GET /predictions/auto-select`

**What:** Stop returning the full ring buffer by default, and use `getLatestAutoSelectRun` rather than re-deriving "latest" in the route.

**Why:** The route ships all 60 run records, each with up to 10 ranking entries, on every page load and status refresh, while the only consumer reads `state.lastRun`. It also inlines the last-element logic the store already exposes, so two ways to compute "latest" now exist and can drift.

**Context:** `api/routes/predictions.ts`, `api/services/prediction-auto-select-store.ts`. Consider a `?history=1` opt-in for when a consumer needs the series.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Performance

### Hoist `predict()`'s per-strategy work

**What:** Resolve the past-entry chain once per sensor and target up to the longest lookback and let each strategy walk a prefix of it, and memoize the per-sensor history index alongside the existing target memoization.

**Why:** For a given sensor and target the sequence of past dates is identical across all 80 strategies, and each shorter lookback is a prefix of the longest, yet it is rebuilt every time: 182 `Date` allocations plus 182 ISO string formats per target per strategy, against only 182 distinct dates. Measured, the grid extension took day-iterations per target from 1344 to 5488 while only about 182 are distinct. Separately `predict` rebuilds the per-sensor slice and its `Map` index on all 80 calls, which at the new 27-week horizon is 36.3M filter predicate calls and 3.63M map insertions per validation run. Benchmarked fixes: caching the chain gives roughly 14.8x, keying the index on numeric time gives roughly 10.6x.

**Context:** `lib/load-predictor-historical.ts`, `api/services/load-prediction-service.ts` `scoreOnData`. The plan's Phase 3 already lists the inner-loop item, so this was known and deferred. The `setDate()` local-time behavior across DST boundaries is documented and load-bearing, so the chain-cache approach is preferred over re-keying the index, and the existing DST tests should be treated as the acceptance gate.

**Effort:** L
**Priority:** P2
**Depends on:** None

### Raise the HA fetch timeout for bulk backtests

**What:** Pass an explicit longer timeout for the backtest fetches, or chunk the request by entity id.

**Why:** The fetch horizon went from a hardcoded 9 weeks to 27 for the comparison button and 30 for the selector, taking a single buffered WebSocket message from roughly 1.3 MB to 4.0-4.5 MB while `fetchHaStats` kept its 30-second default. The recorder query producing those rows runs on the same host as OptiVolt, so the timeout margin shrank by about 3.3x with no compensating change.

**Context:** `api/services/load-prediction-service.ts` `fetchHistory`, `lib/ha-*` client. Verified that `postprocess` runs once per fetch rather than per strategy, so the larger dataset is not reprocessed.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Maintainability

### Share one validation-window helper

**What:** Move the UTC-midnight window construction into one place and have both callers use it.

**Why:** `computeValidationWindow` re-implements the construction already in `prediction-config-store.ts`; the doc comment openly says they are the same, so the duplication is acknowledged but not removed. Two copies can drift.

**Context:** `api/services/prediction-auto-select.ts`, `api/services/prediction-config-store.ts`.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Single-source the `predictionAutoSelect` defaults and bounds

**What:** Pick one source of truth for the defaults and for the 0-50 and 14-56 ranges, and derive the rest.

**Why:** The defaults are written out four times, in the server constant, the defaults JSON, the browser `DEFAULTS` object and the HTML `value=` attributes, plus a fifth prose copy in the README. The bounds are written twice, in the server clamp and the HTML `min`/`max`. All copies agree today and nothing pins them to each other, so changing one leaves a fresh install's UI showing a stale value while the runtime fallback uses a third.

**Context:** `api/services/prediction-auto-select.ts`, `api/defaults/default-settings.json`, `app/src/predictions/auto-select.js`, `app/index.html`. The HTML `value=` attributes can simply go, since the card populates its fields on init. A test asserting the JSON block equals the server constant would pin the rest.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Share one strategy formatter and equality helper

**What:** Export a single strategy-equality helper for the browser modules, and correct the docstrings that claim a parity the code does not have.

**Why:** Strategy equality is implemented three times, once in `lib/strategy-selector.ts` and twice in the browser, and the two browser copies live in the same bundle. Adding a fourth field to the strategy key currently needs three edits. `formatStrategy`'s docstring claims its label is used in "logs and the UI", but the UI defines its own with a different separator and a null case. `applyStrategyToForm`'s docstring says it applies a strategy "the same way the Use button does", but the two diverge on sensor handling and on whether `updatePredictorFieldVisibility` is called.

**Context:** `lib/strategy-selector.ts`, `app/src/predictions/auto-select.js`, `app/src/predictions-validation.js`, `app/src/predictions/config-form.js`. Browser code cannot import the `.ts` module, so the shared helper belongs in a new `app/src/predictions/strategy.js`.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Drop or mark the test-only `isAutoSelectRunning` export

**What:** Either document it as test-only the way `isAutoSelectScheduled` is, or remove it and assert the in-flight guard through the 409.

**Why:** It is exported with no production caller, and unlike its sibling it carries no "(for tests)" note, so it reads as part of the service's real API surface.

**Context:** `api/services/prediction-auto-select.ts`.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed
