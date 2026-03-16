<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# api

## Purpose

Express.js HTTP server providing the OptiVolt REST API. Handles settings persistence, solver orchestration, VRM/MQTT integration, and prediction pipelines. Entry point: `index.ts` starts Express on `PORT`/`HOST`.

## Key Files

| File | Description |
|------|-------------|
| `app.ts` | Express app setup: JSON middleware, route mounting, static file serving (`app/`), error handler |
| `index.ts` | Server entry point: reads `PORT`/`HOST` env vars, starts listening |
| `types.ts` | TypeScript interfaces: `Settings`, `Data`, `DataSources`, `PredictionConfig`, `PlanRowWithDess` |
| `http-errors.ts` | `HttpError` class, `toHttpError()`, `assertCondition()` for route error handling |
| `test.http` | Manual REST client examples for development |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `routes/` | HTTP endpoint handlers (see `routes/AGENTS.md`) |
| `services/` | Business logic and external integrations (see `services/AGENTS.md`) |
| `defaults/` | Default JSON configuration files (see `defaults/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Express 5 with ESM modules and TypeScript
- All routes return JSON; errors use `HttpError` with appropriate status codes
- Static UI served from `app/` directory at the root path
- Environment variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `VRM_INSTALLATION_ID`, `VRM_TOKEN`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`

### Testing Requirements

- Tests in `/opt/optivolt/tests/api/` using vitest + supertest
- Services are heavily mocked in tests (settings-store, data-store, vrm-refresh, mqtt-service)
- Run: `npx vitest run tests/api/`

### Common Patterns

- Routes delegate to services; routes handle HTTP concerns only
- Settings/data persisted as JSON under `DATA_DIR`
- `HttpError` with `expose` flag controls whether error details reach the client

## Dependencies

### Internal

- `lib/` — core solver logic (build-lp, parse-solution, dess-mapper, etc.)
- `app/` — static frontend served by Express

### External

- `express` (v5.2.1) — HTTP framework
- `highs` (v1.8.0) — LP/MIP solver
- `mqtt` (v5.15.0) — Victron MQTT client

<!-- MANUAL: -->
