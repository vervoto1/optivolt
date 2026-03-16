<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# services

## Purpose

Business logic and external integration layer. Orchestrates the full pipeline: data persistence, VRM/MQTT communication, solver execution, and prediction pipelines.

## Key Files

| File | Description |
|------|-------------|
| `planner-service.ts` | Orchestrates: load config, build LP, solve HiGHS, parse, map to DESS, optional MQTT write. Exports `computePlan`, `planAndMaybeWrite` |
| `config-builder.ts` | Builds `SolverConfig` from Settings + Data + timing window. Exports `buildSolverConfigFromSettings`, `getSolverInputs` |
| `settings-store.ts` | Persist/load Settings JSON (`DATA_DIR/settings.json`). Merges with defaults on load |
| `data-store.ts` | Persist/load Data JSON (`DATA_DIR/data.json`). Validates timeseries structure |
| `prediction-config-store.ts` | Persist/load prediction config (`DATA_DIR/prediction-config.json`) |
| `json-store.ts` | Generic JSON file I/O helper used by all stores |
| `mqtt-service.ts` | Victron MQTT: read SoC/settings, write Dynamic ESS schedule. Uses env vars `MQTT_HOST`/`PORT`/`USERNAME`/`PASSWORD` |
| `vrm-refresh.ts` | VRM API integration: refresh settings and timeseries, selective fetch/preserve based on `dataSources` |
| `ha-client.ts` | Home Assistant WebSocket client for long-term statistics |
| `open-meteo-client.ts` | Open-Meteo HTTP client for irradiance data |
| `load-prediction-service.ts` | Load forecasting pipeline: HA data, postprocessing, prediction, validation |
| `pv-prediction-service.ts` | PV forecasting pipeline: HA history + Open-Meteo, capacity estimation, forecast |

## For AI Agents

### Working In This Directory

- Services are the primary unit of business logic; routes are thin wrappers
- Data persistence uses `json-store.ts` as a generic read/write helper
- `vrm-refresh.ts` selectively fetches based on `dataSources` config (vrm vs api per series)
- `mqtt-service.ts` creates a singleton `VictronMqttClient` from env vars
- Prediction services combine HA historical data with Open-Meteo weather data

### Testing Requirements

- Tests in `/opt/optivolt/tests/api/services/`
- Mock external I/O: file system (json-store), MQTT, VRM API, HA WebSocket, Open-Meteo HTTP
- Use `vi.useFakeTimers()` for time-dependent logic (rebalancing, solver timeline)

### Common Patterns

- Singleton pattern for MQTT client (`getVictronClient()`)
- Store pattern: `loadX()` reads JSON with defaults fallback; `saveX()` writes atomically
- Pipeline pattern in planner-service: refresh → load → build → solve → parse → map → write
- Selective refresh: `vrm-refresh.ts` skips series when `dataSources.<key> === 'api'`

## Dependencies

### Internal

- `../../lib/*` — core logic (build-lp, parse-solution, dess-mapper, predict-*, vrm-api, victron-mqtt)
- `../types.ts` — shared TypeScript interfaces
- `../defaults/` — fallback JSON configs

### External

- `highs` (v1.8.0) — LP/MIP solver
- `mqtt` (v5.15.0) — MQTT client (via lib/victron-mqtt.ts)
- `fs/promises` — file I/O for JSON stores

<!-- MANUAL: -->
