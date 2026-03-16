<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# routes

## Purpose

Express route handlers for the OptiVolt REST API. Each file exports a router mounted by `app.ts`. Routes handle HTTP concerns (request parsing, validation, response formatting) and delegate business logic to services.

## Key Files

| File | Description |
|------|-------------|
| `calculate.ts` | `POST /calculate` — Run optimizer; optional `updateData` (refresh VRM) and `writeToVictron` (push DESS via MQTT) |
| `settings.ts` | `GET /POST /settings` — Read/update system and algorithm configuration |
| `data.ts` | `GET /POST /data` — Read/update timeseries; key allowlist and DataSource gating (only `api` sources accept writes) |
| `vrm.ts` | `POST /vrm/refresh-settings` — Sync battery limits and settings from Victron VRM API |
| `predictions.ts` | `GET /POST /predictions/*` — Load/PV forecasting, validation, config management |

## For AI Agents

### Working In This Directory

- Each file exports an Express Router
- Use `HttpError` from `../http-errors.ts` for error responses (4xx/5xx)
- Routes should be thin: validate input, call service, format response
- `POST /data` enforces a key allowlist and requires `dataSources.<key> === 'api'`

### Testing Requirements

- Tests in `/opt/optivolt/tests/api/` using supertest against `app.ts`
- Mock services (planner-service, settings-store, etc.) via `vi.mock()`

### Common Patterns

- Async route handlers with try/catch wrapping
- Request body destructuring with defaults
- JSON response with consistent shape: `{ data, error?, message? }`

## Dependencies

### Internal

- `../services/*` — all business logic
- `../http-errors.ts` — error handling
- `../types.ts` — TypeScript interfaces

### External

- `express` (Router)

<!-- MANUAL: -->
