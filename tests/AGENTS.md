<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# tests

## Purpose

Vitest test suite for OptiVolt. 17 test files with 192+ tests mirroring the source structure. Covers core solver logic, API routes, services, and frontend utilities.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `lib/` | Unit tests for core logic modules (see `lib/AGENTS.md`) |
| `api/` | API route and service integration tests (see `api/AGENTS.md`) |
| `app/` | Frontend utility and API client tests (see `app/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- **Run all:** `npm test` (watch) or `npx vitest run` (once)
- **Run single file:** `npx vitest run tests/lib/build-lp.test.js`
- **Run directory:** `npx vitest run tests/api/`
- Test files use `.test.js` extension (not `.test.ts`)
- Config in `/opt/optivolt/vitest.config.js`

### Common Patterns

- `vi.mock('module', factory)` for I/O isolation (file stores, APIs, MQTT)
- `vi.useFakeTimers()` + `vi.setSystemTime()` for deterministic time
- `toBeCloseTo(expected, digits)` for floating-point energy calculations
- Factory functions (`makeRow()`, `makeEntry()`) for test data
- `beforeEach`/`afterEach` for mock reset and timer cleanup

## Dependencies

### External

- `vitest` (v4.0.18) — test runner and assertion library
- `supertest` (v7.2.2) — HTTP integration testing
- `jsdom` (v28.0.0) — DOM simulation for frontend tests

<!-- MANUAL: -->
