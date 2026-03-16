<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# app

## Purpose

Static web UI for the OptiVolt optimizer. No build step required. Vanilla JavaScript + Tailwind CSS (CDN) + Chart.js provides a 3-tab interface: Optimizer (calculations), Predictions (forecasting), and Settings.

## Key Files

| File | Description |
|------|-------------|
| `index.html` | Complete UI markup (940 lines): 3-tab interface with Tailwind styling, form inputs, chart containers, result tables |
| `main.js` | Bootstrap: imports src/ modules, wires UI inputs/outputs, manages debounced state and calculations |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Browser modules: charts, state, predictions, API client (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- **No build step**: files served directly by Express; changes are live on reload
- Module structure: `main.js` imports from `./src/*`
- CDN dependencies: Tailwind CSS 4, Chart.js 4, Patternomaly 1.3.2, Google Fonts (Outfit, JetBrains Mono)
- Debounced auto-save: 600ms debounce on config changes

### Testing Requirements

- Tests in `/opt/optivolt/tests/app/` using jsdom environment
- Mock `fetch` globally for API tests

### Common Patterns

- State snapshot/hydrate: `snapshotUI()` / `hydrateUI()` in `src/state.js`
- Color constants: all chart colors defined in `src/charts.js::SOLUTION_COLORS`
- API calls: use `src/api/api.js` (high-level) wrapping `src/api/client.js` (low-level fetch)

## Dependencies

### Internal

- `src/` — all browser modules

### External

- Tailwind CSS 4 (CDN)
- Chart.js 4 (CDN)
- Patternomaly 1.3.2 (chart patterns)

<!-- MANUAL: -->
