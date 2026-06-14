# Changelog

## 0.7.35 - 2026-06-14

- **Feature: EV "if connected" preview when the car is disconnected.** When the car is unplugged the real plan correctly excludes the EV (so the Victron/DESS schedule stays unaffected), but that left the EV charts flat at 0% — hiding when you actually need to plug in. `computePlan` now additionally solves a separate, display-only EV preview seeded from the live SoC (as if plugged in now), exposed via `getLastEvPreview()`, on `GET /ev/schedule` (`preview:true`), and on the `/calculate` result (`evPreview`). It is **never** written to Victron and never drives actuation. The EV tab renders it behind a "Preview" banner, and the main solution SoC chart overlays the preview EV-SoC line while keeping real battery/grid data on every other series. When the car is connected, the real plan is shown as before.
- **Chore: bump the Home Assistant add-on base image from Alpine 3.21 to 3.22.** Picks up the newer Alpine base (OS-level security and package updates) for both `aarch64` and `amd64` builds. Node.js is unchanged — Alpine 3.22 ships the same Node 22.22.x as 3.21, so the runtime is identical and this is a base-OS refresh only. Also aligned the dev/CI toolchain to Node 22 (`.nvmrc`, Tests workflow) to match the shipped runtime, and bumped the Tests workflow GitHub Actions (`checkout@v6`, `setup-node@v6`) plus eslint to 10.5.0.

## 0.7.34 - 2026-06-14

- **Fix: native EV was dropped from every plan when the SoC source is Victron MQTT.** `getSolverInputs()` builds the solver config *with* the EV (from the live HA SoC/plug read), but the `dataSources.soc === 'mqtt'` path then **rebuilt the config without passing `evState`**, so the rebuilt config silently excluded the EV — the solver ran with `ev: null` every cycle, the schedule planned no EV charging, and the EV SoC chart read 0% even with the car connected at a known SoC. `getSolverInputs()` now returns `evState`, and both config rebuilds in `planner-service` (the MQTT-SoC refresh and the rebalance-reset paths) pass it through. Added a planner regression test that fails if either rebuild drops the EV. This is the real cause of the "EV SoC shows 0%" report; the 0.7.33 "Ready by" default was a separate, valid improvement.

## 0.7.33 - 2026-06-14

- **Fix: plan EV charging when no "Ready by" deadline is set.** Native EV planning only runs when there is a valid charge window. With "Ready by" left empty, the window collapsed to zero slots and the EV was dropped from the plan entirely — so the schedule showed no EV charging and the EV SoC chart read 0% even with the car connected at a known SoC. An unset "Ready by" now defaults to the **end of the known price horizon** (reach target by the last slot we have prices for, charging in the cheapest hours along the way). The plug gate is unchanged: the EV is still only folded into the home-battery co-optimization when it is actually connected, so the home-battery plan never prepares for an EV draw that won't happen.

## 0.7.32 - 2026-06-14

- **Remove the legacy HA-schedule EV mode and reorganize EV settings.** With native EV planning now the way OptiVolt charges (0.7.31), the alternate "EV Smart Charging schedule reader" mode it replaced is removed, and the EV-related settings move out of the day-to-day EV tab.
  - **Legacy mode removed.** Deleted the `haSchedule` EV source and everything wired to it: the `evSource` selector, the `evConfig` settings block, the `ha-ev-service` schedule reader (`fetchEvLoadFromHA`), and the HA-schedule `evLoad` injection in `planner-service`/`vrm-refresh`. `resolveEvMode()` is now `off | native`, driven solely by the master `evEnabled` switch. The "Home Assistant" EV-load **data source** used the same reader, so it is gone too; a stale `dataSources.evLoad: "ha"` self-heals to `"api"` on save. Native EV charging is unaffected.
  - **Dead LP plumbing removed.** `disableDischargeWhileEvCharging` lost its only writer when `evConfig` went away, so the now-unreachable "block battery discharge while EV charging" branch is removed from `build-lp` and `dess-mapper`. Behavior-preserving — the flag was never set in production, so the constraint never fired.
  - **Settings split into sub-tabs.** The Settings tab now has **Power settings** and **EV charging** sub-tabs. The set-and-forget Smart Charging and Actuation cards (plus the charger/vehicle hardware config) move from the EV tab into the EV-charging sub-tab; the EV tab keeps only the daily-use card (enable, ready-by, target SoC, plan summary).
  - **Live entity-value readouts.** Every Home Assistant entity input in the EV-charging settings (charger switch, charge-current, SoC, plug) now shows its current value below the field on blur — the same recognition aid the SoC/plug inputs already had — so it is easy to confirm the right entity is configured.

## 0.7.31 - 2026-06-14

- **Feature: EV native charge planning, reactive overrides, and charger actuation** (the remainder of the `plans/ev-native-charging-plan.md` build brief). OptiVolt can now plan EV charging with the full feature set of the Home Assistant **EV Smart Charging** integration, react live, and (optionally) drive the charger itself — so that integration's planning *and* actuation can be retired.
  - **Foundations.** One authoritative EV mode (`evSource: 'native' | 'haSchedule'`, gated by the master `evEnabled`) resolved through a single `resolveEvMode()` helper. The duplicate `id="ev-enabled"` checkbox is gone; native LP charge and the legacy HA-schedule `evLoad` injection can no longer both fire, fixing the **double-counted EV load**. Native EV gating is applied at every site (`config-builder`, `planner-service`, `vrm-refresh`).
  - **Planning (LP).** Earliest-start window + price-limit **masks**; a **soft target SoC** (`ev_target_shortfall` + a price-derived `BIG_PENALTY`) replacing the old hard target and the cardinality bound that could go infeasible under a mask; the target clamp is now **capacity-only** (no more silent "met" while below the requested SoC); a **minimum-SoC floor** that is soft, mask-exempt, fully sourced (`grid/pv/battery_to_ev_floor`, counted in the grid-import cap and source balances), and budget-capped so it reaches the floor without bypassing the price mask to hit the target; **opportunistic** top-up bands (×2) that fill beyond target only from cheap surplus; and an optional **continuous-charging** contiguity bias. `parse-solution` now emits `ev_plan_mode`, `ev_target_met`, and `ev_target_shortfall_Wh` (separate from the hardware `ev_charge_mode`).
  - **Reactive overrides.** A new `ev-decision-service` overlays **low-SoC**, **low-price**, **min-SoC**, and **keep-on** on the day-ahead plan from live SoC/price/plug, priority `low_soc > low_price > min_soc > planned > keep_on > idle`, without re-solving. Surfaced on `GET /ev/current`, the new `GET /ev/status`, and as advisory annotations on `GET /ev/schedule`.
  - **Actuation.** A generic `callHaService()` write path (the first OptiVolt → HA write) plus an `ev-actuator-service` fast control loop that drives the charger idempotently and **fail-safe**: no write on any uncertainty (HA error, no/stale plan, uncertain plug), a no-blip boot seed, single-owner contention detection, and an opt-in `evFailSafeMode: 'stop'`. An override that deviates from the planned EV draw triggers a debounced re-plan + Victron re-write so the DESS schedule stays consistent (override↔DESS reconciliation). Reported on `GET /ev/actuation`. All actuation is behind `evActuationEnabled` (default off); a plan-only HA-automation fallback and the legacy `haSchedule` reader remain supported.
  - **UI.** The EV tab gains the Smart Charging controls (earliest start, min SoC, price limit, opportunistic ×2, low-price/low-SoC/keep-on, continuous), an Actuation card, an EV-source selector, a derived charging-speed (%/h) hint, and a live mode badge + target-met indicator.

## 0.7.30 - 2026-06-13

- **Fix:** ESS dashboard config (`essConfig`) is now sourced authoritatively from `default-settings.json`; a persisted `essConfig` in `settings.json` is ignored. `saveSettings` persists the whole settings object, so the seeded `essConfig` got written to `settings.json` the first time any setting was saved on 0.7.28 — and that stale copy then overrode later default changes (e.g. the 0.7.29 removal of the write-only current/voltage **calibration** tiles and the 30 s → 5 s refresh interval kept showing the old values). Since there is no UI to edit `essConfig` yet, defaults are the single source of truth; this will become a real merge again when an `essConfig` editor is added.

## 0.7.29 - 2026-06-13

- **ESS dashboard polish:**
  - Cell-voltage **trend** chart y-axis is now pinned to the LiFePO4 operating window (2.8–3.8 V) instead of auto-scaling from 0 V, so normal per-cell variation is visible rather than flattened.
  - Temperature **trend** chart y-axis changed from 0–60 °C to **20–80 °C** to match the real operating band.
  - Removed the seeded **current/voltage calibration** tiles. Those are write-only `number` setpoints (not sensors), so they read back as `unknown`; calibration isn't done through this dashboard. The `essConfig.batteries[].extraEntities` field remains available for genuine read-only extras.
  - Default live-state **refresh interval** lowered from 30 s to **5 s** (`essConfig.refreshIntervalSeconds`). Trend charts still refetch only on tab (re)activation.

## 0.7.28 - 2026-06-13

- **Feature:** ESS system dashboard tab. A new **ESS** tab (between EV and Predictions) visualises the home battery system natively in OptiVolt — Chart.js with the existing `card`/`sidebar-label` styling and light/dark theme, no Home Assistant iframe. It is multi-battery and fully config-driven via a new `essConfig` block, seeded out of the box for the current hardware (the two JK BMS units "Basen Green" + "Gobel Power" and the Victron system). Per battery it shows an overview (SoC, capacity, voltage, current, charge/discharge power, min/max cell, balancing), a 16-cell voltage snapshot, cell-voltage and temperature trends, plus a combined SoC-development chart and a Victron system card. New `GET /ess/state` (one bulk `/api/states` read, per-entity tolerant — a renamed/dropped sensor renders a placeholder instead of blanking the tab) and `GET /ess/history` (long-term statistics with a raw-history fallback for sensors that have no statistics, e.g. per-cell BMS voltages, plus server-side downsampling). The tab is lazy-initialised on first activation (no HA traffic at startup) and stops polling on deactivation. `essConfig` is deep-merged on save so editing one field never drops the battery list. When HA is unconfigured the tab degrades to a friendly empty state.

## 0.7.27 - 2026-06-13

- **Fix:** Model three-phase EV charge power. The amps↔watts conversion was hardcoded single-phase (`current_A × 230`) in `config-builder.ts` and `parse-solution.ts`, so a three-phase charger (e.g. an 11 kW Tesla Wall Connector at 16 A) was planned and read back at ~3.7 kW — about a third of real power — causing the LP to under-schedule EV charging and report a wrong `ev_charge_A`. Added an `evChargePhases` setting (1 or 3) threaded through `EvConfig`, with a single source of truth `AC_PHASE_VOLTAGE_V` (230 V) so the amps→watts (config-builder) and watts→amps (parse-solution) sites always agree: `watts = amps × 230 × phases`. Exposed as a "Charger phases" selector in the EV Charging settings card. **Default is three-phase** (the target hardware); single-phase deployments must set `evChargePhases = 1`, and callers that omit the field fall back to single-phase.
- **Chore:** Bump `vitest` and `@vitest/coverage-v8` to 4.1.8 (test tooling only).

## 0.7.26 - 2026-06-05

- **Fix:** Drop implausible energy-counter spikes from Home Assistant statistics before they reach the load/PV predictor. A meter reset on 2026-05-30 (coinciding with a Venus MQTT update) recorded one period as ~4296 kWh; under `mean` aggregation this averaged into a ~538 kWh forecast load for a single slot, which exceeded the grid import cap and made the LP **infeasible** — producing an empty schedule. `postprocess()` now discards any per-period reading whose magnitude exceeds `MAX_PLAUSIBLE_SLOT_ENERGY_WH` (25 kWh, overridable via the new `{ maxSlotEnergyWh }` option) and logs a `[ha-postprocess]` warning naming the sensor, timestamp, and value. The dropped sample becomes a gap, which the historical predictor already skips, so it no longer poisons the mean/median or the auto-tuner's validation metrics.

## 0.7.25 - 2026-06-05

- **Fix:** Victron MQTT portal-id auto-detection now derives the id from the `N/<portal-id>/system/0/Serial` topic instead of trusting the JSON payload. On the target broker, live MQTT returned SoC on `N/c0619ab6bd28/battery/512/Soc` and `N/c0619ab6bd28/system/0/Dc/Battery/Soc`, while the failed calculate path had been waiting on `N/2/...`; using the topic id prevents calculate-time SoC refreshes from addressing the wrong MQTT namespace.

## 0.7.24 - 2026-05-28

- **Chore:** Dependency refresh, no runtime logic changes.
  - **Security:** Patched three moderate-severity advisories surfaced by `npm audit` (all transitive): `qs` 6.15.1 → 6.15.2 (`stringify` DoS on null/undefined entries in comma-format arrays — the same bump upstream's Dependabot proposed in `qs-6.15.2`), `brace-expansion` (large-numeric-range DoS defeating the documented `max` guard), and `ws` (uninitialized memory disclosure). `npm audit` now reports 0 vulnerabilities.
  - **Tooling:** `eslint` 10.3.0 → 10.4.0, `@eslint/css` 1.2.0 → 1.3.0, `@eslint/markdown` 8.0.1 → 8.0.2, `vitest` + `@vitest/coverage-v8` 4.1.6 → 4.1.7 (range bumped to `^4.1.7` because the meta-package held the pair in lockstep).
  - **Solver dep:** `highs` 1.8.0 → 1.14.2 in `package.json`. **No effect on solver behavior** — the runtime and all tests import the vendored WASM build at `vendor/highs-build/highs.js`, never the npm package, so this is dead-dependency hygiene only. Taking the actual HiGHS 1.8 → 1.14 solver improvements would require re-vendoring `vendor/highs-build/`, which this release does **not** do.
  - All 1434 tests pass; typecheck and lint clean.

## 0.7.23 - 2026-05-14

- **Fix:** Three sites in `dess-mapper.ts` still fell back to `inverterEfficiency_percent = 100%` when callers omitted the field, while `buildLP` and (post-0.7.21) `parseSolution` default to 95%. Same bug class as 0.7.21 — the AC↔DC saturation checks in `findHighestGridUsageCost`, `findLowestPvExportPrice`, and `mapRowsToDessV2` were left behind. A slot at the DC discharge cap (e.g. 4000 W DC = 3800 W AC at η=0.95) was therefore mis-classified as unconstrained: the proGrid `-5%` socTarget pull never fired and the high-price grid-usage tipping point counted slots that were actually saturated. Extracted `DEFAULT_INVERTER_EFFICIENCY_PERCENT = 95` as a shared constant in `lib/build-lp.ts` with a docstring forcing future devs to keep the three modules in sync, and wired all three dess-mapper sites + parseSolution to it. Added a regression test that fails on `?? 100` and passes on `?? DEFAULT_INVERTER_EFFICIENCY_PERCENT`.

## 0.7.22 - 2026-05-14

- **Fix:** Edits to the PV Curtailment, DESS Price Refresh, Grid & Solar Power Optimizer, and HA Price Sensor cards were silently dropped on reload unless the user happened to hit Recompute afterwards. The auto-save wiring in `app/src/ui-binding.js` only attaches `input`/`change` listeners to elements tagged `data-settings-input`, and none of these 33 inputs carried the attribute — so `<input id="pv-curtail-enphase-switch">` and friends went straight to the DOM and never reached `POST /settings`. Added `data-settings-input data-no-autosolve` to all 33 inputs across the four cards (no-autosolve because none of them feed the LP — worker config and price-source pointers shouldn't trigger a recompute on every keystroke).
- **Chore:** Bump `vitest` and `@vitest/coverage-v8` 4.1.5 → 4.1.6 (patch).

## 0.7.21 - 2026-05-07

- **Fix:** Auto-split migration silently skipped for pre-v0.7.20 settings files. `loadSettings()` spreads `default-settings.json` (which now includes `inverterEfficiency_percent: 95`) before merging the user's stored settings, so the migration's "already migrated" check fired for every legacy file and the auto-split never ran. Result was effective grid→battery efficiency of 0.9025 (η_inv·η_bc) for users with legacy 95/95 instead of the intended ~0.95. Now `loadSettings` detects whether the user's raw `settings.json` had the field before the merge and strips it from defaults if not, forcing the migration to back-derive sensible values.
- **Fix:** `parseSolution` defaulted to η_inv=100% when the field was missing, but `buildLP` defaults to 95%. Callers passing partial configs got the LP built with 5% inverter loss while the AC-side reporting (export, load served) ran lossless — over-stating exports and revenue by ~5%. `parseSolution` now defaults to 95 to match. Existing `parse-solution.test.js` fixtures opt into the legacy lossless path explicitly with `inverterEfficiency_percent: 100`.
- **Fix:** `findHighestGridUsageCost` (DESS tipping-point helper) compared AC-reported `b2l + b2ev` against the DC `maxDischargePower_W` cap. A slot at the DC discharge limit (e.g. 4000 W DC = 3800 W AC at η_inv=95%) was mis-classified as unconstrained, so its high import price could falsely set `gridBatteryTp`, causing the DESS V2 mapper to choose grid-for-load too broadly. Now converts AC back to DC for the comparison.
- **UI:** Renamed "Charge efficiency (%)" → "Battery Charge efficiency (%)" and "Discharge efficiency (%)" → "Battery Discharge efficiency (%)" to match the v0.7.20 semantic shift (these now represent battery-only losses; inverter conversion lives in its own field above).
- 2 new tests covering the legacy-file migration path. All 1432 tests pass.

## 0.7.20 - 2026-05-07

- Split inverter conversion losses out of the lumped charge/discharge efficiency. The LP previously applied `chargeEfficiency_percent` identically to `pv_to_battery` (DC→DC, no inverter) and `grid_to_battery` (AC→DC→battery), and applied **no** loss factor to `pv_to_grid` (DC→AC export). With prices like 26 c€ export now / 25.8 c€ import later, that math booked a tiny arbitrage profit for round-tripping solar through the grid — physically a loss because each AC↔DC crossing eats ~5%. New model:
  - New setting `inverterEfficiency_percent` (default 95) applied to every AC↔DC crossing: `pv_to_grid`, `pv_to_load`, `pv_to_ev`, `battery_to_load`, `battery_to_grid`, `battery_to_ev` (all DC→AC) and `grid_to_battery` (AC→DC).
  - `chargeEfficiency_percent` and `dischargeEfficiency_percent` now mean **battery only** (DC→stored and stored→DC bus).
  - LP flow variables now carry their natural source unit: `pv_to_*` are DC W from the PV bus, `grid_to_*` are AC W from grid, `battery_to_*` are DC W on the battery bus. AC↔DC factors are explicit in every constraint. ASCII diagram at the top of `lib/build-lp.ts` documents the conventions.
  - `parse-solution.ts` applies η_inv at the LP→PlanRow boundary so downstream consumers (UI, plan summary, DESS mapper, plan accuracy) keep reading AC-meter-equivalent values.
  - `dess-mapper.ts` saturation checks now compare DC battery flows against the DC `maxChargePower_W` / `maxDischargePower_W` correctly (previously mixed AC and DC).
  - Auto-split migration: existing `settings.json` files lacking `inverterEfficiency_percent` get a one-time migration. The legacy single combined value is split as `inverter = sqrt(max(legacy))`, with battery factors rescaled so the combined grid→battery / battery-export round-trip approximately matches old behavior. Default 95/95 → 97/97/97.
  - New setting appears in the UI immediately above charge/discharge efficiency on the System tab; also available in optimizer quick settings.
  - Added regression test for the user's exact scenario (PV at 26 c€, import at 25.8 c€): solver now correctly prefers `pv→battery` direct over the round trip when the spread is below the new ~10% physical round-trip loss threshold.
  - 15 new unit tests covering the η_inv physics on every flow path. All 1430 tests pass.

## 0.7.19 - 2026-05-06

- Restore the optimizer Power Flows 15m/1h toggle (`#flows-15m`). The upstream merge in 0.7.18 silently dropped the change listener and the underlying `aggregateRows` helper, leaving the checkbox in the UI but inert. The toggle now re-renders the flows chart in place: unchecked = hourly aggregation (default), checked = native 15-min slots. Tooltip and price-strip overlays receive the aggregated rows so indices line up with the bars.

## 0.7.18 - 2026-05-06

- Vendor browser dependencies locally so the UI works behind reverse proxies that inject a strict `Content-Security-Policy`. Tailwind Play CDN, Chart.js v4 UMD, and patternomaly v1.3.2 now ship from `app/vendor/`; Outfit and JetBrains Mono are self-hosted under `app/vendor/fonts/` (latin + latin-ext subsets) with a generated `fonts.css`. Removes runtime dependency on `cdn.tailwindcss.com`, `cdn.jsdelivr.net`, `fonts.googleapis.com`, and `fonts.gstatic.com` — the add-on is now fully offline-capable.
- Add manual prediction adjustment feature so users can override forecast values from the UI; when multiple adjustments overlap, the baseline is picked by latest `updatedAt` instead of array order
- Add robust linear PV model using direct + diffuse radiation, with radiation feature guard and CV consistency
- Add optimizer quick-settings panel for fast tuning without opening the full settings tab
- Add net grid cost display and DESS detail toggle in the optimizer summary
- Add configurable block feed-in on negative export prices, with negative-price grid injection highlighted on the flows chart and the zero line emphasised in the price chart
- Add rebalance nudge: track last full-SoC timestamp and prompt rebalancing after 10 days without a full charge
- Add buy-price color strip to the flows chart, refresh charts on theme changes, and clean up optimizer cost-table labels
- Use new MQTT topic for `targetsoc` to match the current Venus OS Dynamic ESS schema
- Decompose monolithic frontend modules and extract dedicated prediction services
- Fix race condition in `runCombinedPredictionForecast` and in combined forecast persistence (two concurrent writes are now collapsed into one, with best-effort persistence and an early short-circuit)
- Fix buy-price strip border not updating on theme toggle and restore the canvas fallback scan in `getRenderedCharts`
- Update npm dependencies

## 0.7.17 - 2026-05-04

- Reach 100% coverage across statements, branches, functions, and lines (Codecov verified). Adds focused tests for PV-curtailment service (Enphase HA switch path, restore-on-stop, recentWrites overflow, dedup logging, overlapping-tick guard, interval-fired tick rejection), Victron MQTT SoC multi-path fallback + rethrow, soc-tracker / vrm-refresh battery-instance plumbing, lib/pv-curtailment defensive coercion, and small UI branch coverage in ev-tab and theme. Annotates remaining unreachable defensive guards with `v8 ignore` comments and collapses an unreachable `else if` in `theme.js`. Excludes `*.http` fixtures from coverage parsing.

## 0.7.16 - 2026-05-04

- Style the Prediction Accuracy Curve (by SoC%) chart to match the other line charts in the predictions tab — drop the heavy dot markers, use the standard line weight and tension, and let low-sample SoC bands show as actual gaps

## 0.7.15 - 2026-05-04

- Fix hourly aggregation in the power flows chart: EV flow stacks (Solar/Battery/Grid → EV), prices, and EV SoC were being dropped during 1-hour bucketing, and the tooltip was indexed against the original 15-min rows instead of the aggregated buckets
- Align the Charge/Discharge Prediction Accuracy metric tiles and "Prediction Accuracy Curve (by SoC%)" sub-heading with the rest of the predictions tab styling (summary-panel + stat-label/stat-value, sidebar-label)

## 0.7.14 - 2026-05-01

- Toggle an optional Enphase Envoy production switch via Home Assistant alongside the Victron `Pv/Disable` write whenever PV curtailment engages
- Surface the controlled targets (Victron portal ID, AC system instance, Enphase HA entity) directly on the PV Curtailment card instead of hiding them under "Advanced"

## 0.7.13 - 2026-05-01

- Block shore optimizer while PV curtailment owns an active PV disable
- Add UI descriptions for PV Curtailment and Grid & Solar Power Optimizer cards

## 0.7.12 - 2026-05-01

- Add planner-driven Victron PV curtailment control for negative-price periods, disabling PV only when the plan has enough grid headroom through the remaining negative-price block
- Write Victron `acsystem/<instance>/Pv/Disable` with dry-run support, ownership-aware restore, and settings controls
- Surface per-slot PV control decisions in the optimizer table

## 0.7.11 - 2026-04-30

- Fix SoC parsing: exclude `soc_shortfall` slack variables from SoC reconstruction, resolving jumpy/incorrect SoC display and false simultaneous charge/discharge in plans

## 0.7.10 - 2026-04-30

- Refresh live Victron MQTT battery SoC before every MQTT-sourced solve, preferring the configured battery instance topic before falling back to system SoC
- Fail calculations when Victron MQTT SoC cannot be read instead of silently planning from old SoC data
- Surface Victron schedule write failures to the API/UI instead of reporting a false successful send

## 0.7.9 - 2026-04-30

- Add PV curtailment and battery direction constraints so negative-price plans better match Victron DESS capabilities
- Prefer DC-coupled PV charging paths when the battery is charging, while still allowing curtailment when prices make PV harmful
- Surface curtailed PV in plan rows, summaries, charts, and schedule tables

## 0.7.8 - 2026-04-28

- Bump version

## 0.7.7 - 2026-04-28

- Add optional shore current optimizer that adjusts the Victron shore current limit during planned grid-to-battery charging to avoid MPPT current/voltage limiting

## 0.7.6 - 2026-04-21

- Fix Pro Grid strategy mapping during forced solar exports so Dynamic ESS uses the correct behavior in those periods
- Fix local Home Assistant add-on builds by providing a default `BUILD_FROM`
- Align declared Node.js support with the ESLint toolchain requirement (`^22.13.0 || >=24`)

## 0.7.5 - 2026-04-21

- Bump typescript to 6.0.3 (major) — no type regressions, all 1140 tests pass
- Bump eslint to 10.2.1 and @eslint/markdown to 8.0.1 — minor version bumps with vulnerability fixes

## 0.7.4 - 2026-04-19

- Add retry-with-backoff (3 attempts, 500ms → 1500ms → 4500ms) for transient VRM, HA, and Open-Meteo fetch failures — prevents a brief outage from leaving stale forecasts in place for a whole auto-calc interval
- Add stale-data detection: compares each persisted time-series (load / PV / import / export prices) against the expected horizon and emits a warning when any is >2h short
- Add amber "Stale data detected" banner in the Plan summary panel listing each short series and by how many hours
- Log to `console.error` (instead of `warn`) when forecast retries exhaust, and on every solve that still uses stale data, so the issue is visible in add-on logs
- Parallelize load + PV forecast refresh (was sequential; worst-case double-failure delay is now 6s instead of 12s)

## 0.7.3 - 2026-04-15

- Bump safe npm dependencies: `mqtt`, `@eslint/css`, `eslint`, `globals`, `jsdom`, `vitest`, and `@vitest/coverage-v8`

## 0.7.2 - 2026-04-10

- Fix auto-calculate failing indefinitely with "Insufficient future data" at end of day — now auto-retries with a data refresh when the time window expires
- Fix `refreshSeriesFromVrmAndPersist` not handling `api` data sources (load/PV prediction pipeline was never called during scheduled refresh)
- Fix npm audit vulnerabilities (path-to-regexp, picomatch); regenerate lockfile with cross-platform optional deps

## 0.7.1 - 2026-04-02

- Sync fork with 69 upstream commits from bmesuere/optivolt
- Add LP-optimized EV charging with MILP solver (departure deadline, target SoC, per-slot charge mode classification)
- Add pluggable load predictors (historical + fixed) with predictor type selector in UI
- Add EV REST endpoints (`/ev/current`, `/ev/schedule`) for HA charger control automation
- Add HA entity state endpoint (`/ha/entity/:entityId`) for EV sensor validation
- Fix DST handling in historical load predictor
- Add day dividers and net error overlays to prediction accuracy charts

## 0.7.0 - 2026-03-31

- Fix adaptive learning calibration never producing results when `minDataDays` matched the snapshot fetch window size (boundary race condition)
- Prevent JSON data file corruption from interrupted writes during add-on restarts by using atomic write-then-rename

## 0.6.9 - 2026-03-25

- Add totals row (Σ) to schedule table showing per-column energy totals in kWh with color-tinted chips
- Move power flows chart to full-width layout above sidebar for better day-view readability
- Cherry-picked from upstream PR #83, adapted to preserve 15m bars toggle

## 0.6.8 - 2026-03-24

- Fix charge/discharge prediction accuracy data collection after the boundary-aligned scheduler change by accepting slight post-boundary SoC samples for slot comparisons while still preferring valid prior samples
- Restore adaptive-learning calibration updates for quarter-boundary ticks by applying the same near-boundary SoC matching rule during ratio collection
- Clean up plan snapshot code in the planner by simplifying the predicted SoC mapping and consolidating the duplicated time-series import

## 0.6.7 - 2026-03-24

- Fix Dynamic ESS target SoC spiking introduced in `0.6.4` by restoring live steering to the current slot boundary while keeping plan-history snapshots aligned to the next full slot for reporting
- Revert the `0.6.6` MQTT strategy remap that flattened Dynamic ESS behavior and prevented expected discharge periods from executing
- Keep the single-slot DESS schedule duration fallback so isolated slot writes still use the default 15-minute duration safely

## 0.6.6 - 2026-03-24

- Fix Dynamic ESS target SoC writes by publishing Victron-compatible strategy codes in MQTT schedule slots, so non-zero `TargetSoc` values are honored again and charging/discharging follows the planned target
- Fix single-slot DESS schedule writes by falling back to the default 15-minute duration when only one row is available

## 0.6.5 - 2026-03-24

- Align auto-calculate to real wall-clock boundaries so 15-minute runs happen on `:00`, `:15`, `:30`, and `:45` instead of drifting from startup time
- Preserve actual SoC measurement timestamps and only match plan-accuracy/calibration slots to samples at or before the slot boundary, preventing later readings from being attributed to earlier timestamps

## 0.6.4 - 2026-03-23

- Fix live plan timing alignment: plans created mid-slot now start at the next quarter-hour boundary instead of the already-partially-elapsed slot, preventing predicted SoC from appearing 15 minutes early during discharge accuracy comparisons

## 0.6.3 - 2026-03-23

- Restore manual CV phase thresholds across settings, solver config, and UI while keeping adaptive threshold generation
- Redact `haToken` from `GET /settings`, treat token updates as write-only, and preserve existing tokens when the UI submits a blank field
- Add centralized settings normalization/validation and shared Home Assistant URL/token resolution helpers
- Strengthen route and state coverage with temp-backed integration tests for settings, predictions, and custom data plus frontend state/config-store tests
- Refactor API route tests away from socket-bound `supertest` usage to router-level integration coverage that works in constrained environments

## 0.6.1 - 2026-03-23

- **Auto-calibrated power limits**: replace manual CV phase thresholds with auto-generated per-SoC charge/discharge power limits derived from calibration curves — the LP now plans for realistic charge/discharge speeds at each SoC level
- **Discharge power thresholds**: new MILP mechanism mirrors existing charge phase — reduces discharge power when SoC drops below calibrated thresholds (e.g. battery discharges slower at low SoC)
- **Remove manual CV phase**: manual CV tuning removed from settings, UI, and defaults — manual thresholds biased calibration measurements, preventing the system from learning true battery behavior
- **Rewired adaptive learning auto mode**: `applyCalibration` now generates MILP power thresholds instead of multiplying efficiency percentages (efficiency settings are correct and should not be adjusted by calibration)
- **Conservative confidence scaling**: confidence denominator changed from /100 to /500, requiring ~3-5 days of data before auto-calibration activates
- Fix DESS price refresh race: `isPriceRefreshWindowActive()` now checks configured time window directly, closing ~60s gap where auto-calculate could restore Mode 4 before tick fired
- DESS mapper: SoC target cap now uses first threshold above current SoC instead of always using lowest threshold
- 795 tests across 41 test files
- **Note**: clear calibration data after upgrading (`POST /plan-accuracy/calibration/reset`) — old calibration was built against manual CV thresholds and will produce incorrect power limits

## 0.6.0 - 2026-03-21

- **Fix predicted SoC alignment**: predicted SoC in plan snapshots now represents start-of-slot (before energy flows) instead of end-of-slot (after flows), matching actual SoC measurements taken at slot start — previously showed e.g. 31% predicted at 11:00 when charging hadn't started, which was the 11:15 end-of-slot value
- **Prediction accuracy charts**: parabolic SoC lifecycle curve (charge 0→100% on left, discharge 100→0% on right) with green/orange phase coloring, deviation diff overlay, merged timeline from historical plans
- **Reset-all endpoint**: `POST /plan-accuracy/reset-all` clears all adaptive learning data (calibration, plan history, SoC samples) in one call
- Fix SoC sample timestamps: align to quarter-hour boundaries to match plan slot timestamps exactly
- Fix SoC sample matching tolerance: increased to 15 minutes to avoid missed matches at slot boundaries
- Adaptive learning SoC sampling now awaits completion before proceeding (was fire-and-forget)
- **100% test coverage**: 762 tests covering all lines and functions across 39 source files (up from 563 at ~90%)
- Codecov integration with CI; coverage badge added to README
- **Note**: clear plan history after upgrading to flush stale snapshots with old end-of-slot semantics

## 0.5.10 - 2026-03-18

- Rename "efficiency" to "prediction accuracy" throughout adaptive learning UI and API
- Add per-SoC-band sample counts to calibration data — chart only shows bands with ≥2 samples
- Add "Calibrate" button in Predictions tab sidebar for instant manual trigger
- Parabolic prediction accuracy curve with smooth interpolation and scatter points at data-backed bands
- Tooltip shows sample count per band on hover; weighted average only considers bands with data
- Fix adaptive learning calibrator never running: re-read settings live each tick instead of caching at startup
- Add `POST /plan-accuracy/calibrate` endpoint for manual calibration trigger
- Bump all dependencies to latest; resolve all Dependabot security alerts

## 0.5.9 - 2026-03-17

- Add (dis)charge adaptive learning: compare planned vs actual battery SoC to calibrate charge/discharge efficiency over time
  - Plan History Store: persists predicted SoC trajectories after each solve (ring buffer, 2000 plans max)
  - SoC Tracker: samples actual battery SoC, load, and PV from MQTT/VRM at each auto-calculate tick
  - Plan Accuracy Service: compares predicted vs actual SoC per elapsed slot, computes deviation metrics
  - Efficiency Calibrator: per-SoC-band efficiency curves (100 points, one per SoC%) for charge and discharge, built via chronologically-sorted EMA
  - Confound filtering: skips slots where actual load or PV deviated >20% from predicted
  - Two modes: `suggest` (data collection + UI visibility) or `auto` (also applies calibrated efficiency curve to the LP solver)
  - REST API: `GET /plan-accuracy`, `/plan-accuracy/history`, `/plan-accuracy/calibration`, `/plan-accuracy/soc-samples`, `/plan-accuracy/snapshots`, `POST /plan-accuracy/calibration/reset`
  - UI: predicted vs actual SoC chart, deviation diff chart, efficiency curve chart in Predictions tab
