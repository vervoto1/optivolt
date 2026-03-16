<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# lib

## Purpose

Pure unit tests for core logic modules in `lib/`. 8 test files covering prediction, optimization, parsing, and DESS mapping.

## Key Files

| File | Description |
|------|-------------|
| `predict-load.test.js` | Load prediction: getDayBucket, mean/median, predict, validate, generateAllConfigs (266 lines) |
| `predict-pv.test.js` | PV forecast: Bird clear sky model, capacity estimation, forecastPv. Mocks open-meteo-client (493 lines) |
| `build-lp.test.js` | LP structure validation: variables, SOC constraints, MILP rebalancing, terminal valuation (155 lines) |
| `time-series-utils.test.js` | getQuarterStart, extractWindow, buildForecastSeries (127 lines) |
| `parse-solution.test.js` | parseSolution column extraction and row assembly (42 lines) |
| `open-meteo.test.js` | URL building, irradiance parsing, 15-min resolution, hour shifting (312 lines) |
| `ha-postprocess.test.js` | Sensor merge (kWh to Wh), derived metrics, 15-min aggregation (136 lines) |
| `dess-mapper.test.js` | 52 tests: strategy detection, restrictions, feed-in, tipping points, SoC boosts (595 lines) |

## For AI Agents

### Working In This Directory

- These are pure unit tests with no I/O; mock only external API clients
- `predict-pv.test.js` mocks `open-meteo-client.ts` for weather data
- `dess-mapper.test.js` is the largest test file; uses `makeRow()` factory extensively

### Common Patterns

- `toBeCloseTo()` for energy calculations
- `toMatch(regex)` for LP text structure validation
- Factory functions for test rows and timeseries
- UTC timestamps throughout

## Dependencies

### Internal

- Tests import directly from `../../lib/*.ts`

### External

- `vitest`

<!-- MANUAL: -->
