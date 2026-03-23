# Changelog

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
