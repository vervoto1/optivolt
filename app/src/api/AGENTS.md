<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# api

## Purpose

Browser API client layer. Low-level fetch wrapper (`client.js`) and high-level convenience functions (`api.js`) for communicating with the OptiVolt backend.

## Key Files

| File | Description |
|------|-------------|
| `client.js` | Low-level fetch: `getJson()` and `postJson()` with error handling, JSON parsing |
| `api.js` | High-level endpoint wrappers: settings, `/calculate`, VRM refresh, predictions |

## For AI Agents

### Working In This Directory

- Import from `api.js` (not `client.js`) for endpoint calls
- Base URL is relative (same origin); no hardcoded host
- `postJson()` throws on non-2xx responses with error message from body

### Testing Requirements

- Tests in `/opt/optivolt/tests/app/api/` using jsdom + mocked `fetch`
- Test error cases: non-200 status, network failure

### Common Patterns

- Settings: `fetchStoredSettings()` / `saveStoredSettings(config)`
- Solver: `requestRemoteSolve(body)` posts config, returns solution
- Predictions: `fetchPredictionConfig()`, `runValidation()`, `runLoadForecast()`, `runPvForecast()`

## Dependencies

### Internal

None (standalone browser module).

### External

- Browser `fetch` API

<!-- MANUAL: -->
