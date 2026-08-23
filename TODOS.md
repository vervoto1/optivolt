# TODOS

No open items. Everything filed from the v0.7.54 and v0.7.55 reviews is closed below; new findings go in a new section above this line, using the same **What / Why / Context / Effort / Priority / Depends on** shape.

## Completed

All of the following were filed from the v0.7.54 and v0.7.55 reviews and closed in **v0.7.56** (see `CHANGELOG.md` for the user-facing description).

### Predictions / auto-select

- **Record failed auto-select runs** — `AutoSelectAction` gained `failed` (+ `error`); `runAutoSelect` records the failure before rethrowing, the card renders it.
- **Make the daily run guards trigger- and outcome-aware** — manual runs no longer consume the day; skipped/failed runs no longer satisfy the catch-up; the window is consumed only after a completed run, so failures and 409s retry on the next tick; a 409 is logged as "deferred".
- **Make the daily fire window DST- and midnight-safe** — new `api/services/daily-window.ts` (`findDailyWindowStart`), shared with `dess-price-refresh.ts`; the window start is a real instant, so `23:58` wraps and a spring-forward time fires after the jump.
- **Apply hysteresis to the `incumbent-unscored` switch** — `selectStrategy` returns `shouldSwitch: false` for it; the service records `suggested`, never `applied`.
- **Score candidates on a common sample set** — `scoreOnData` scores every strategy of a sensor on the intersection of the hours all of them predicted; `n` is shared, `nSkipped` stays per-strategy; `minSamplesFor()` pins the derived floor in a test.
- **Validate `historicalPredictor` on write** — new `api/services/prediction-config-schema.ts`; `POST /predictions/config` rejects out-of-range `lookbackWeeks` (1–52) and bad enums with 400; the UI input has `max="52"`.
- **Close the server-side lost update on `prediction-config.json`** — `updatePredictionConfig()` lock in the store; the selector re-reads and overlays only the three strategy fields, and drops the write when the predictor changed or (timer-triggered) the selector was disabled mid-run; the route uses the same lock.
- **Project run records to the declared `StrategyScore` shape** — `toStrategyScore()` strips `sensor`/`validationPredictions` from `incumbent`, `best`, `ranking`.
- **Abort an in-flight run when the selector is stopped** — a generation counter bumped by `stop()`; tick/catch-up re-check it after their awaits; the dead `configEnabled` guards and their `v8 ignore` comments are gone.
- **Align the backtest window with the local trigger day** — resolved by documenting the UTC-day choice on the shared `computeValidationWindow` (the history is keyed on UTC hours and a fixed boundary keeps the window identical whatever local time the run fires; the cost east of ~UTC+11 is staleness, not bias).
- **Range-check `HH:MM` settings and flag a zero improvement margin** — well-formed but out-of-range times clamp to the latest valid time (load-safe); `minImprovement_percent` floors at 1 % (`AUTO_SELECT_LIMITS`).
- **Fix the store test that never exercises its non-array guard** — seeds through `appendAutoSelectRun` and asserts `readJson` was called with the real path.

### Storage / API / performance

- **Make `writeJson` tear-proof** — unique `${file}.${pid}.${n}.tmp` per write; orphaned temp file unlinked when the rename fails.
- **Stop shipping `validationPredictions` for every strategy** — `/validate` is metrics-only; new `POST /predictions/validate/strategy` feeds the Chart button on demand.
- **Trim `GET /predictions/auto-select`** — last run only, `?history=1` for the ring buffer; uses `getLatestAutoSelectRun`.
- **Hoist `predict()`'s per-strategy work** — `buildPredictIndex()` shares the sensor index and past-date chain across the grid: 14.9× faster (2.16 s → 0.15 s, 80 strategies × 672 targets), identical output, DST tests gate the shared path.
- **Raise the HA fetch timeout for bulk backtests** — `BACKTEST_FETCH_TIMEOUT_MS = 120_000` on the backtest fetch path.

### UI

- **Migrate the inline `<style>` block into `@layer components`** — wrapped in `@layer components { … }` (the `<link>` to `vendor/tailwind.css` stays first so the `properties < theme < base < components < utilities` order is established before the block); the four `!`-prefixed workarounds (`!mt-0 !w-auto !rounded-*-none !border-r-0`, `!mt-0 !w-20` in `ess-tab.js`) are plain utilities again and the CSS was rebuilt. Visual pass done as a computed-style diff in headless Chrome (Playwright, Chrome 151): 20 190 element-states over every tab/sub-tab, light and dark, plus forced `hidden`/`loading`/`panel-exit`/`value-updating` states, old HTML + old CSS against new — zero unmatched elements, zero page errors. Every flip is a utility that was authored but lost to the unlayered block, and each was confirmed by screenshot: `#rebalance-status-row` now hides (it was permanently visible as an empty "Rebalancing" row), `pr-16`/`pr-10` on the Custom-price and forecast-adjustment inputs now apply, the seven `form-input font-mono text-xs` fields render at 12 px, the stale-data block gets its amber border; `border-slate-100`/`dark:border-white/5` on summary rows resolve to the same colours in `oklch` notation. No `.card`/`dark:bg-*` or `.stat-value`/`text-*` clashes exist in the markup. The wall panel (Chrome 124 WebView) supports `@layer` per the device check, so no second device pass was needed.
- **Verify Tailwind v4 rendering on the wall-panel browser** — verified 2026-08-23 on the actual panel: **Chrome 124 (Android WebView)**, PASS on a self-contained check page that inlines the compiled `tailwind.css` and reads back the painted colors of `bg-sky-600` / `bg-emerald-100` / `bg-amber-100` / `dark:bg-slate-800` / `dark:bg-sky-900/40`, plus feature probes for `oklch()`, `color-mix()`, `@property` and `@layer` (all present). Tailwind v4's floor is Chrome 111, so the panel has 13 major versions of headroom. The check page is kept at `/root/tw-device-check.html` on the dev box for re-runs after a WebView update; no fallback pass is needed.
- **Add busy states to the Strategy Selection buttons** — Apply locks during its save; Run Selection and Run Comparison lock each other (`app/src/predictions/run-buttons.js`). Note: the review's claim that Run Comparison could trigger the 409 was wrong — it hits a different endpoint — but the mutual lock is still right, since both start a full backtest on the single-threaded server.
- **Refresh the comparison badges after applying a suggestion** — `onApplied` dep re-renders the table.
- **Announce auto-select status changes to assistive tech** — `role="status"`/`aria-live="polite"` on `#autosel-outcome` and `#pred-status`; `aria-expanded` on the show-all toggle.
- **Fix the Gain tile's sign convention** — the tile shows the error reduction as a positive number; outcome copy reads "20.1 % lower MAE"; server log reads "(20.0 % better)". (A negative improvement cannot occur — `best` is rank 1 — so nothing was being hidden, but the collapse to "0 %" is gone too.)
- **Distinguish a failed auto-select status fetch from "no run yet"** — "Status unavailable: …" in the error tone, cells cleared.
- **Give `.form-checkbox` a real style** — 1rem native checkbox with the sky `accent-color`.
- **Use `.stat-value` consistently in the Strategy Selection panel** — the Gain cell now matches Current/Best (`text-xs font-semibold`); mono would not fit the strategy strings.

### Solver

- **Decide the vendored HiGHS WASM build's refresh story** — provenance established from the `vendor/highs-js` submodule pointer upstream added in the same commit as the binaries: `lovasoa/highs-js` @ `98c35cc` (v1.8.0 + 2, 2024-12-19) → HiGHS `fcfb534` = **1.8.0**; recorded with sha256 hashes in `vendor/highs-build/PROVENANCE.md` and pinned by `tests/vendor/highs-build-provenance.test.js`. Decision: refresh from the npm `highs` release artifacts (every release since v1.14 contains the stack-size fix the custom build existed for), gated by `scripts/compare-highs-builds.ts` (same LP through both builds → status/objective/row diff; fails on status or objective drift), checked at every dependency refresh, upgraded only in a dedicated PR. Dry-run on `highs@1.14.2`: 2689/2689 tests pass, default-dataset plan identical. The bump itself is deliberately not in v0.7.56. `vendor/AGENTS.md` corrected (it said 16.8 KB, 60 lines, "via the `highs` npm package").

### Maintainability

- **Share one validation-window helper** — `computeValidationWindow` lives in `prediction-config-store.ts` and serves both windows.
- **Single-source the `predictionAutoSelect` defaults and bounds** — HTML `value=` attributes removed (the card populates, also on fetch failure); a test pins `default-settings.json` to `DEFAULT_AUTO_SELECT_CONFIG`; bounds in `AUTO_SELECT_LIMITS`. The browser `DEFAULTS` copy remains (it cannot import the `.ts` constant) and is labelled as the mirror.
- **Share one strategy formatter and equality helper** — `app/src/predictions/strategy.js`; docstrings corrected (`lib` `formatStrategy` is for logs; `applyStrategyToForm` describes how it differs from Use).
- **Drop or mark the test-only `isAutoSelectRunning` export** — marked "(for tests)".
