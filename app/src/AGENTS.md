<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# src

## Purpose

Browser modules providing UI logic, state management, charting, predictions, and API integration. All modules are ES6 exports designed to run in the browser without a bundler.

## Key Files

| File | Description |
|------|-------------|
| `charts.js` | Chart.js rendering: power flows (stacked bar), SoC (line), prices (stepped), load/PV. Exports `SOLUTION_COLORS` |
| `state.js` | UI-state binding: `snapshotUI()` captures form to config; `hydrateUI()` populates form; summary panel updates |
| `table.js` | Schedule table with color-coded flows, DESS mappings, time formatting. Uses `SOLUTION_COLORS` |
| `predictions.js` | Predictions tab: load/PV forecasting, config management, accuracy charts |
| `predictions-validation.js` | Strategy validation: compares parameter combinations for accuracy |
| `ui-binding.js` | DOM element references via querySelector; event handler wiring; Ctrl+Enter shortcut |
| `config-store.js` | Load/save settings to API (`/settings` endpoint) |
| `theme.js` | Dark mode toggle: localStorage persistence, system preference detection |
| `utils.js` | Debounce helper for input throttling |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | Browser API client (see `api/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- No bundler: ES6 import/export runs directly in browser
- `charts.js` is foundational: exports color constants used by `state.js`, `table.js`, `predictions.js`
- Config object schema defined implicitly in `state.js::snapshotUI()`

### Testing Requirements

- Tests in `/opt/optivolt/tests/app/` use jsdom
- Mock `window.Chart` for chart tests; mock `fetch` for API tests

### Common Patterns

- Color references: destructure from `SOLUTION_COLORS`
- Debouncing: `debounce()` from `utils.js` for auto-save
- Time formatting: `fmtHHMM`, `fmtTickHourOrDate` in `charts.js`

## Dependencies

### Internal

- `api/` — fetch wrapper and endpoint functions

### External

- Chart.js 4 (global `Chart`)
- Patternomaly 1.3.2 (global `pattern`)

<!-- MANUAL: -->
