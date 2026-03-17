# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

OptiVolt is a linear-programming optimizer for home energy systems (battery, PV, EV, heat pump, grid). It builds a day-ahead cost-minimization plan over 15-minute slots using the HiGHS solver (WASM). Primary target: Victron Energy ESS systems via the VRM API + MQTT Dynamic ESS schedule writing. Runs as a Home Assistant add-on or standalone Node.js server.

## Commands

- **Run server:** `npm run api` (or `npm run dev` for nodemon + `.env.local`)
- **Run all tests:** `npm test` (vitest, runs in watch mode)
- **Run tests once:** `npx vitest run`
- **Run a single test file:** `npx vitest run tests/lib/build-lp.test.js`
- **Lint:** `npm run lint`

## Architecture

The system has three layers, all ESM TypeScript (no build step; runs via Node 22+ type stripping or tsx):

### `lib/` — Core logic (pure, no I/O)
- **`build-lp.ts`** — Generates an LP problem string from time-series data and settings. The LP has per-slot flow variables (`grid_to_load`, `pv_to_battery`, `battery_to_grid`, etc.) and tracks `soc` (state of charge) evolution with charge/discharge efficiency. Effective load per slot is `load + evLoad` (EV demand added as a separate input). Supports CV (Constant Voltage) phase modeling via MILP binaries that reduce charge power limits at configurable high-SoC thresholds.
- **`parse-solution.ts`** — Parses HiGHS solver output back into per-slot row objects with flows, SoC percentages, import/export, and timestamps.
- **`dess-mapper.ts`** — Maps solved rows to Victron Dynamic ESS schedule parameters (strategy, restrictions, feed-in, target SoC). Produces per-slot DESS decisions and diagnostics. Applies EV discharge constraint (blocks battery→grid during EV charging slots) and caps CV-aware target SoC boosts to avoid overcharging.
- **`vrm-api.ts`** / **`victron-mqtt.ts`** — VRM REST client and MQTT client for writing schedules to Victron. MQTT supports TLS via `tls` and `rejectUnauthorized` config options.

### `api/` — Express server
- **`app.ts`** — Express app setup. Mounts routes at `/calculate`, `/settings`, `/vrm`, and serves the static UI from `app/`.
- **`index.ts`** — Server entry point (listens on `HOST`/`PORT`).
- **Routes** (`api/routes/`): `calculate.ts`, `settings.ts`, `vrm.ts`.
- **Services** (`api/services/`):
  - `planner-service.ts` — Orchestrates the full pipeline: refresh VRM data → load settings/data → build LP → solve with HiGHS → parse → map to DESS → optionally write via MQTT.
  - `settings-store.ts` / `data-store.ts` — JSON file persistence under `DATA_DIR` (defaults to `data/`).
  - `config-builder.ts` — Merges persisted settings + data into solver inputs.
  - `vrm-refresh.ts` — Fetches time-series from VRM and persists to `data.json`.
  - `mqtt-service.ts` — Writes Dynamic ESS schedule via MQTT. Reads `MQTT_TLS` and `MQTT_TLS_INSECURE` env vars for SSL/TLS support.
  - `ha-ev-service.ts` — Reads EV Smart Charging schedule from HA REST API (uses supervisor proxy when running as add-on).
  - `ha-price-service.ts` — Reads electricity prices from HA sensor (e.g., GE Spot). Supports hourly (repeat 4×) and 15-min price intervals.
  - `auto-calculate.ts` — Internal timer that calls `planAndMaybeWrite()` on a configurable interval. Concurrency guard skips tick when calculation is in progress.
- **Defaults** (`api/defaults/`): `default-settings.json` and `default-data.json` used when no persisted files exist.

### `optivolt/` — Home Assistant add-on
- **`config.yaml`** — Add-on manifest (options, schema, image reference for GHCR).
- **`Dockerfile`** — Alpine 3.21 base, Node.js 22, tsx for TypeScript execution.
- **`build.yaml`** — Base images per architecture for the HA builder.
- **`rootfs/`** — s6-overlay service scripts (run, finish, init).
- **`translations/en.yaml`** — HA configuration UI labels.
- **`repository.yaml`** (at repo root) — HA add-on repository metadata.

### `app/` — Static web UI (no build step)
- `index.html` + `main.js` — Entry points.
- `app/src/` — Browser modules: API client, config store, charts, table, utils.
- The UI calls the Express API on the same origin. Time-series data is display-only (comes from VRM, not editable).

### Data flow
Settings and time-series data are server-owned, persisted as JSON under `DATA_DIR`. The client reads/writes settings via `/settings` and triggers computation via `POST /calculate`. The LP is always built server-side from persisted state — the client never sends LP parameters directly. `evLoad` can be sourced from the HA EV Smart Charging integration (via `ha-ev-service.ts`) or injected manually via `POST /data`. Electricity prices can be sourced from VRM, pushed via `POST /data`, or read from an HA sensor (via `ha-price-service.ts`).

## Testing

Tests use vitest with supertest for API tests. Test files mirror the source structure under `tests/`. API tests mock external services (`settings-store`, `data-store`, `vrm-refresh`, `mqtt-service`). The `lib/` tests are pure unit tests. Browser-side tests (`tests/app/`) use jsdom.

## Code conventions

- ESM modules throughout (`"type": "module"` in package.json).
- Node.js >= 22 required.
- Express 5.
- Unused variables prefixed with `_` (eslint rule).
- ESLint also checks `.md` and `.css` files.
- Units are explicit in variable names: `_W` (watts), `_Wh` (watt-hours), `_percent`, `_m` (minutes), `_cents_per_kWh`.
- LP variable naming pattern: `{source}_to_{sink}_{slot_index}` (e.g., `grid_to_battery_3`).
