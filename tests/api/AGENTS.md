<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# api

## Purpose

API integration tests using supertest against the Express app, plus service-level unit tests with mocked dependencies.

## Key Files

| File | Description |
|------|-------------|
| `api.test.js` | GET /health, GET /settings, POST /calculate endpoint tests (123 lines) |
| `custom-data.test.js` | GET/POST /data: key allowlist, DataSource gating, validation (135 lines) |
| `predictions.test.js` | /predictions/*: config, validate, forecast endpoints (196 lines) |
| `services/planner-service.test.js` | Rebalancing state machine: startMs lifecycle (105 lines) |
| `services/config-builder.test.js` | Solver config assembly, rebalance holdSlots calculation (95 lines) |
| `services/solver-timeline.test.js` | Solver horizon: slot boundary alignment, data shortage handling (77 lines) |
| `services/vrm-refresh.custom-data.test.js` | VRM selective fetch/preserve based on dataSources (126 lines) |

## For AI Agents

### Working In This Directory

- Route tests use supertest against `app.ts`; service tests mock stores and external clients
- Heavy use of `vi.mock()` for settings-store, data-store, vrm-refresh, mqtt-service
- `vi.useFakeTimers()` for rebalancing and timeline tests
- Hoisted mock factories for class-based clients (VRMClient)

### Common Patterns

- Mock service chain: settings-store → data-store → vrm-refresh → mqtt-service
- Status code assertions: 200, 400, 403, 502
- Graceful fallback testing: null results on HA connection errors

## Dependencies

### Internal

- Tests import from `../../api/app.ts` (supertest) and `../../api/services/*.ts`

### External

- `vitest`, `supertest`

<!-- MANUAL: -->
