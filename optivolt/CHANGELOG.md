# Changelog

## 0.5.4

- Remove ESS Direct control mode (`ess-direct`): AcPowerSetPoint never worked on Multi RS Solar, superseded by DESS Mode 4
- Remove `victronControlMode` setting, type, UI dropdown, and default
- Update README with DESS Mode 4 documentation
- Clean up all ESS Direct references from codebase and docs

## 0.5.3

- Add comprehensive tests for DESS Mode 4, dual Soc/TargetSoc writes, 48-slot count, and restrictions alignment

## 0.5.2

- Fix DESS restrictions for Mode 4: align restrictions with strategy so GX can reach target SoC
  - proBattery slots: allow grid→battery (was blocking both directions)
  - proGrid/PV export slots: allow battery→grid (was blocking both)
  - selfConsumption default: no restrictions (was blocking both)

## 0.5.1

- Version bump for DESS restriction fix deployment

## 0.5.0

- Fix Dynamic ESS schedules not being picked up by Multi RS Solar devices
  - Set DESS Mode 4 (Custom/Node-RED) via MQTT before writing schedules, so VRM cloud stops overriding local schedule slots
  - Mode 4 does not persist across GX reboots; checked and re-applied on every schedule write
  - Write both `Soc` and `TargetSoc` fields per schedule slot for Venus OS >= 3.20 compatibility (prevents stale `TargetSoc` from previous controllers silently overriding our values)
  - Fill all 48 schedule slots (up from 4) to eliminate gaps when slots expire between writes

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
