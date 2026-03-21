# Changelog

## [0.6.0] - 2026-03-21

### Added
- **Prediction accuracy charts**: parabolic SoC lifecycle curve showing predicted vs actual battery state of charge over time, with deviation diff overlay
- **Reset-all endpoint**: `POST /plan-accuracy/reset-all` clears all adaptive learning data (calibration, plan history, SoC samples) in one call
- **Codecov integration**: CI uploads coverage reports to Codecov; badge added to README
- **100% test coverage**: 762 tests covering all lines and functions across 39 source files (up from 563 tests at ~90% line coverage)

### Fixed
- **Predicted SoC alignment**: predicted SoC in plan snapshots now represents start-of-slot (before energy flows) instead of end-of-slot (after flows), matching actual SoC measurements taken at slot start. Previously showed e.g. 31% predicted at 11:00 when charging hadn't started yet — that was actually the 11:15 end-of-slot value
- **SoC sample timestamps**: align to quarter-hour boundaries so predicted vs actual comparisons match correctly
- **SoC sample matching tolerance**: increased from 10 to 15 minutes to avoid missed matches at slot boundaries
- **DESS price refresh race**: check time window instead of tick flag to prevent schedule writes during Mode 1 window
- **SoC accuracy charts regression**: keep parabolic prediction curve separate from merged accuracy timeline

### Changed
- Adaptive learning SoC sampling now awaits completion before proceeding (was fire-and-forget)
- Plan snapshot `predictedSoc_percent` semantics changed from end-of-slot to start-of-slot; clear plan history after upgrading to flush stale data

## [0.5.10] - 2026-03-18

### Added
- Per-SoC-band efficiency calibration (100-point curves for charge and discharge)
- Confound filtering: exclude slots where actual load/PV deviated >20% from prediction
- Coverage reporting to CI with Codecov upload

### Fixed
- Adaptive learning calibrator not running due to missing timer registration
- Renamed "efficiency" to "prediction accuracy" in UI for clarity

## [0.5.9] - 2026-03-17

### Added
- Adaptive learning: compares planned vs actual battery SoC to auto-calibrate charge/discharge efficiency over time
- Plan history store (ring buffer, max 2000 snapshots)
- SoC tracker: samples actual battery SoC from MQTT at each auto-calculate tick
- Plan accuracy service: computes deviation metrics between predicted and actual SoC
- Efficiency calibrator: EMA-based per-SoC-band calibration from observed deltas
