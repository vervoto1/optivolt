<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# lib

## Purpose

Core domain logic for OptiVolt's energy optimization pipeline. Twelve pure TypeScript modules implementing forecasting, load prediction, LP model generation, solution parsing, and Victron system integration. No I/O or framework dependencies except MQTT client and REST API utilities.

## Key Files

| File | Description |
|------|-------------|
| `types.ts` | Shared type definitions: `SolverConfig`, `PlanRow`, `DessSlot`, `PlanSummary`, `TimeSeries`, `TerminalSocValuation` |
| `time-series-utils.ts` | Time series utilities: `getQuarterStart()`, `extractWindow()`, `buildForecastSeries()`, `computeErrorMetrics()` (MAE/RMSE/MAPE) |
| `predict-pv.ts` | PV forecasting with Bird Clear Sky Model: `calculateClearSkyGHI()`, `estimateHourlyCapacity()`, `forecastPv()`, `validatePvForecast()` |
| `open-meteo.ts` | Open-Meteo API URL builders and response parsers: `buildForecastUrl()`, `parseIrradianceResponse()`, `parseMinutely15Response()` |
| `predict-load.ts` | Historical load prediction: `predict()`, `validate()`, `generateAllConfigs()`, day filtering, mean/median aggregation |
| `ha-postprocess.ts` | Home Assistant stats normalization: `postprocess()`, `aggregateTo15Min()`, sensor merging, derived sensors |
| `victron-mqtt.ts` | MQTT client for Victron: `VictronMqttClient` class with battery SoC, settings, Dynamic ESS schedule writes |
| `vrm-api.ts` | VRM REST client: `VRMClient` class for forecasts, prices, DESS settings, unit normalization (kW to W, EUR to cents) |
| `build-lp.ts` | LP/MIP model builder: `buildLP()` generates CPLEX LP format for HiGHS solver with rebalancing MILP |
| `parse-solution.ts` | HiGHS solver output parser: `parseSolution()` reconstructs energy flows and SoC from solver columns |
| `plan-summary.ts` | Plan KPI aggregation: `buildPlanSummary()` computes totals, tipping points, rebalance status |
| `dess-mapper.ts` | Dynamic ESS strategy mapper: `mapRowsToDess()` and `mapRowsToDessV2()` assign strategies per 15-minute slot |

## For AI Agents

### Working In This Directory

All modules are **pure functions** (except `victron-mqtt.ts` and `vrm-api.ts` which handle I/O):

- Input: TypeScript objects with explicit typing from `types.ts`
- Output: Typed objects or arrays; no side effects in core logic
- Unit conventions: Always explicit in variable names (`_W`, `_Wh`, `_percent`, `_m`, `_cents_per_kWh`)
- LP variable naming: `{source}_to_{sink}_{slot_index}` (e.g. `pv_to_battery_0`, `grid_to_load_15`)

### Testing Requirements

- Tests live in `/opt/optivolt/tests/lib/` and mirror this directory's structure
- Run: `npx vitest run tests/lib/<file>.test.js`
- Pure functions must be unit tested; I/O modules need integration tests with mocked MQTT/HTTP
- Use `toBeCloseTo()` for floating-point comparisons in energy calculations

### Common Patterns

- **Time alignment:** 15-minute slots indexed 0-95 per day; HA uses start-of-interval, Open-Meteo uses backward-average
- **Energy accounting:** All values in Wh/W at 15-minute boundaries; SoC tracked in Wh
- **Forecast building:** Missing data padded with 0; hourly forecasts expanded to 15-min via `buildForecastSeries()`
- **LP model:** CPLEX text format for HiGHS; variables split by flow direction to avoid negatives; efficiency losses per direction

## Dependencies

### Internal

- `types.ts` is the hub: every module imports shared types
- `time-series-utils.ts`: used by `predict-pv.ts`, `predict-load.ts`
- `open-meteo.ts`: types used by `predict-pv.ts`
- `ha-postprocess.ts`: types consumed by `predict-load.ts`
- `parse-solution.ts` output (`PlanRow[]`) feeds `plan-summary.ts` and `dess-mapper.ts`

### External

- `mqtt` (v5.15.0): used only in `victron-mqtt.ts`

<!-- MANUAL: -->
