<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# app

## Purpose

Frontend tests using jsdom for DOM simulation. Covers the fetch-based HTTP client and utility functions.

## Key Files

| File | Description |
|------|-------------|
| `api/client.test.js` | getJson/postJson: request formatting, error handling, fetch stubbing (59 lines) |
| `utils.test.js` | debounce: delay execution, timer reset, cancellation (48 lines) |

## For AI Agents

### Working In This Directory

- Uses jsdom environment (configured in vitest.config.js)
- Mock `fetch` via `vi.stubGlobal('fetch', mockFn)`
- Use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` for debounce tests

### Common Patterns

- Global fetch stubbing for browser API tests
- Timer advancement for async behavior testing
- Call count assertions on mock functions

## Dependencies

### Internal

- Tests import from `../../app/src/api/client.js` and `../../app/src/utils.js`

### External

- `vitest`, `jsdom`

<!-- MANUAL: -->
