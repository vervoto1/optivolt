# Changelog

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
