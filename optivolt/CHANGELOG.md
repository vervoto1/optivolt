# Changelog

## 0.6.1 - 2026-03-23

- **Auto-calibrated power limits**: replace manual CV phase thresholds with auto-generated per-SoC charge/discharge power limits derived from calibration curves
- **Discharge power thresholds**: new MILP mechanism reduces discharge power when SoC drops below calibrated thresholds
- **Remove manual CV phase**: manual thresholds biased calibration measurements, preventing accurate learning
- **Rewired adaptive learning auto mode**: generates MILP power thresholds instead of multiplying efficiency
- **Conservative confidence scaling**: requires ~3-5 days of data before auto-calibration activates
- Fix DESS price refresh race: check time window directly, not just tick flag
- DESS mapper: SoC target cap uses first threshold above current SoC
- **Note**: clear calibration data after upgrading (`POST /plan-accuracy/calibration/reset`)

## 0.6.0

- **Fix predicted SoC alignment**: predicted SoC in plan snapshots now represents start-of-slot (before energy flows) instead of end-of-slot (after flows), matching actual SoC measurements taken at slot start — previously showed e.g. 31% predicted at 11:00 when charging hadn't started, which was the 11:15 end-of-slot value
- **Prediction accuracy charts**: parabolic SoC lifecycle curve (charge 0→100% on left, discharge 100→0% on right) with green/orange phase coloring, deviation diff overlay, merged timeline from historical plans
- **Reset-all endpoint**: `POST /plan-accuracy/reset-all` clears all adaptive learning data (calibration, plan history, SoC samples) in one call
- Fix SoC sample timestamps: align to quarter-hour boundaries to match plan slot timestamps exactly
- Fix SoC sample matching tolerance: increased to 15 minutes to avoid missed matches at slot boundaries
- Adaptive learning SoC sampling now awaits completion before proceeding (was fire-and-forget)
- **100% test coverage**: 762 tests covering all lines and functions across 39 source files (up from 563 at ~90%)
- Codecov integration with CI; coverage badge added to README
- **Note**: clear plan history after upgrading to flush stale snapshots with old end-of-slot semantics

## 0.5.10

- Rename "efficiency" to "prediction accuracy" throughout adaptive learning UI and API
- Add per-SoC-band sample counts to calibration data — chart only shows bands with ≥2 samples
- Add "Calibrate" button in Predictions tab sidebar for instant manual trigger
- Parabolic prediction accuracy curve with smooth interpolation and scatter points at data-backed bands
- Tooltip shows sample count per band on hover; weighted average only considers bands with data
- Fix adaptive learning calibrator never running: re-read settings live each tick instead of caching at startup
- Add `POST /plan-accuracy/calibrate` endpoint for manual calibration trigger
- Bump all dependencies to latest; resolve all Dependabot security alerts

## 0.5.9

- Add (dis)charge adaptive learning: compare planned vs actual battery SoC to calibrate charge/discharge efficiency over time
  - Plan History Store: persists predicted SoC trajectories after each solve (ring buffer, 2000 plans max)
  - SoC Tracker: samples actual battery SoC, load, and PV from MQTT/VRM at each auto-calculate tick
  - Plan Accuracy Service: compares predicted vs actual SoC per elapsed slot, computes deviation metrics
  - Efficiency Calibrator: per-SoC-band efficiency curves (100 points, one per SoC%) for charge and discharge, built via chronologically-sorted EMA
  - Confound filtering: skips slots where actual load or PV deviated >20% from predicted (e.g. unexpected heater) to avoid contaminating efficiency calibration with forecast errors
  - Two modes: `suggest` (data collection + UI visibility) or `auto` (also applies calibrated efficiency curve to the LP solver at the current SoC band)
  - New setting: `adaptiveLearning: { enabled, mode, minDataDays }` (defaults to disabled)
  - REST API: `GET /plan-accuracy`, `/plan-accuracy/history`, `/plan-accuracy/calibration`, `/plan-accuracy/soc-samples`, `/plan-accuracy/snapshots`, `POST /plan-accuracy/calibration/reset`
  - UI: "(Dis)Charge Adaptive Learning" controls in Predictions tab sidebar (enable/disable, mode, min days, reset button) with live calibration status
  - UI: predicted vs actual SoC chart, deviation diff chart, efficiency curve chart (charge + discharge by SoC%) in Predictions tab

## 0.5.6

- Add DESS Price Refresh: configurable daily window that temporarily switches DESS to Auto/VRM mode so Victron can update prices, then restores Mode 4 and triggers immediate recalculation with fresh prices
  - Toggle, time, and duration settings in the UI (Settings → DESS Price Refresh)
  - Guard in schedule writer skips MQTT writes during the refresh window
  - Explicit Mode 4 restore + forced recalc at window end (does not depend on auto-calculate)

## 0.5.5

- Fix Dynamic ESS schedules not being picked up by Multi RS Solar devices
  - Set DESS Mode 4 (Custom/Node-RED) via MQTT before writing schedules, so VRM cloud stops overriding local schedule slots
  - Mode 4 does not persist across GX reboots; checked and re-applied on every schedule write
  - Write both `Soc` and `TargetSoc` fields per schedule slot for Venus OS >= 3.20 compatibility (prevents stale `TargetSoc` from previous controllers silently overriding our values)
  - Fill all 48 schedule slots (up from 4) to eliminate gaps when slots expire between writes
- Fix DESS restrictions: align with strategy so GX can reach target SoC
  - proBattery slots: allow grid→battery (was blocking both directions)
  - proGrid/PV export slots: allow battery→grid (was blocking both)
  - selfConsumption default: no restrictions (was blocking both)
- Add comprehensive tests for DESS Mode 4, dual Soc/TargetSoc writes, 48-slot count, and restrictions
- Update README with DESS Mode 4 documentation

## 0.4.3

- Auto-manage Victron DESS mode: when pushing schedules to Victron is enabled, OptiVolt automatically sets DESS to Node-RED mode via the configured HA select entity (e.g., `select.victron_mqtt_..._dess_mode`) and reverts to Auto/VRM when stopped or shut down
- Fix CV phase: add reverse MILP constraint that prevents the solver from voluntarily activating charge throttling below the CV threshold, eliminating gaps in the charging schedule
- Cap DESS target SoC +5% boost at the first CV threshold to prevent target oscillation during CV phase charging

## 0.4.1

- Add EV charging as separate uncontrollable load input (closes #1)
  - LP solver treats EV load as additional demand per slot
  - Optional battery discharge constraint during EV charging
  - Read EV Smart Charging schedule from Home Assistant
  - "Always apply schedule" toggle (ignore connected switch)
  - EV charging shown as orange bar in power flows chart
  - DESS mapper blocks battery→grid during EV charging
  - EV load data source selector (API / Home Assistant) in UI
- Add auto-calculate timer and HA price sensor support (closes #2)
  - Configurable internal interval replaces external HA automation
  - Concurrency guard prevents overlapping calculations
  - Read electricity prices from HA sensor (e.g., GE Spot)
  - Supports hourly and 15-min price intervals
  - Import = Export price toggle for spot price markets
  - Clean server shutdown (SIGTERM/SIGINT)
- Add Constant Voltage phase tuning
  - Configurable SoC thresholds with reduced max charge power (MILP)
  - Tight big-M coefficient for numerical stability
- Fix LP solver tiebreaks
  - Prefer battery→load over grid→load when prices are equal
  - Prefer continuous battery charging over gaps within price blocks
- Fix DESS target SoC monotonicity during charging phases
- Fix HA API access from add-on: use supervisor proxy with SUPERVISOR_TOKEN
- Fix stale EV schedule persisting when car is disconnected
- Update add-on icon to house-with-battery design

## 0.2.3

- One-click Home Assistant add-on install via repository URL
- Automated CI/CD builder with multi-arch GHCR image publishing
- MQTT auto port selection: switches to 8883 when TLS is enabled
- Fix LP solver alternating battery charge/discharge flows when import/export prices are equal
- Update default sensors for Victron/Enphase/Tesla setup

## 0.2.0

- Add SSL/TLS support for MQTT connections
- Add load and PV forecasting via Home Assistant sensor history
- Dynamic ESS schedule writing via MQTT
- Web UI with Optimizer, Predictions, and Settings tabs

## 0.1.0

- Initial release
- Day-ahead cost minimization using HiGHS (WASM)
- VRM integration for forecasts, prices, and system limits
- Static web UI served by Express
