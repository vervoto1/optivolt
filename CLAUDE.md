# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

This is the active development fork at `vervoto1/optivolt`. The upstream repo is `bmesuere/optivolt`. All CI/CD (tests, Docker image builds) runs on this fork. Docker images are published to `ghcr.io/vervoto1/`.

## Project overview

OptiVolt is a linear-programming optimizer for home energy systems (battery, PV, EV, heat pump, grid). It builds a day-ahead cost-minimization plan over 15-minute slots using the HiGHS solver (WASM). Primary target: Victron Energy ESS systems via the VRM API + MQTT Dynamic ESS schedule writing. Runs as a Home Assistant add-on or standalone Node.js server.

## Commands

- **Run server:** `npm run api` (or `npm run dev` for nodemon + `.env.local`)
- **Run tests in watch mode:** `npm test`
- **Run tests once:** `npm run test:run`
- **Run a single test file:** `npx vitest run tests/lib/build-lp.test.js`
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run lint`

## Architecture

The system has three layers. Server/core code is TypeScript ESM executed directly by Node 22; the browser UI is static ESM with no build step.

### `lib/` — Core logic (pure, no I/O unless noted)
- **`build-lp.ts`** — Generates an LP problem string from time-series data and settings. The LP has per-slot flow variables (`grid_to_load`, `pv_to_battery`, `battery_to_grid`, EV flows, etc.) and tracks `soc` evolution with charge/discharge efficiency. Supports CV phase modeling via MILP binaries.
- **`parse-solution.ts`** — Parses HiGHS solver output back into per-slot row objects with flows, SoC percentages, import/export, EV decisions, and timestamps.
- **`dess-mapper.ts`** — Maps solved rows to Victron Dynamic ESS schedule parameters (strategy, restrictions, feed-in, target SoC). Produces per-slot DESS decisions and diagnostics. Applies EV discharge constraints and CV-aware target SoC caps.
- **`vrm-api.ts`** / **`victron-mqtt.ts`** — VRM REST client and MQTT client for writing schedules to Victron. MQTT supports TLS settings.

### `api/` — Express server
- **`app.ts`** — Express app setup. Mounts routes at `/calculate`, `/settings`, `/data`, `/vrm`, `/predictions`, `/plan-accuracy`, `/ev`, `/ha`, and serves the static UI from `app/`.
- **`index.ts`** — Server entry point (listens on `HOST`/`PORT`).
- **Routes** (`api/routes/`): `calculate.ts`, `settings.ts`, `data.ts`, `vrm.ts`, `predictions.ts`, `plan-accuracy.ts`, `ev.ts`, `ha.ts`.
- **Services** (`api/services/`):
  - `planner-service.ts` — Orchestrates the full pipeline: refresh VRM data, load settings/data, build LP, solve with HiGHS, parse, map to DESS, optionally write via MQTT.
  - `settings-store.ts` / `data-store.ts` / `prediction-config-store.ts` — JSON file persistence under `DATA_DIR` (defaults to `data/`).
  - `config-builder.ts` — Merges persisted settings + data into solver inputs and applies adaptive-learning calibration in `auto` mode.
  - `vrm-refresh.ts` — Fetches time-series from VRM and persists to `data.json`.
  - `prediction-forecast-runner.ts` / `prediction-adjustment-store.ts` — Prediction orchestration, forecast persistence policy, and manual adjustment CRUD.
  - `mqtt-service.ts` — Writes Dynamic ESS schedule via MQTT, including Mode 4 management and `Soc`/`TargetSoc` compatibility.
  - `ha-ev-service.ts` / `ha-price-service.ts` — Home Assistant EV schedule and price sensor readers.
  - `auto-calculate.ts`, `plan-history-store.ts`, `soc-tracker.ts`, `plan-accuracy-service.ts`, `efficiency-calibrator.ts` — Auto-calculate and adaptive-learning support.
- **Defaults** (`api/defaults/`): `default-settings.json` and `default-data.json` used when no persisted files exist.

### `optivolt/` — Home Assistant add-on
- **`config.yaml`** — Add-on manifest (options, schema, image reference for GHCR).
- **`Dockerfile`** — Multi-stage build. Stage 1 runs `npm ci` and `tsx` install on native `node:22-alpine` to avoid QEMU "Illegal instruction" crashes during aarch64 cross-compilation. Stage 2 copies `node_modules` and tsx into the HA base image (Alpine 3.21, Node.js 22).
- **`build.yaml`** — Base images per architecture for the HA builder.
- **`rootfs/`** — s6-overlay service scripts (run, finish, init).
- **`translations/en.yaml`** — HA configuration UI labels.
- **`repository.yaml`** (at repo root) — HA add-on repository metadata.

### `app/` — Static web UI (no build step)
- `index.html` + `main.js` — Entry points.
- `app/src/` — Browser modules: API client, config store, chart barrels/modules, predictions modules, EV modules, table, utils.
- The UI calls the Express API on the same origin. Time-series data is display-only (comes from VRM, not editable).

### Data flow
Settings, prediction config, and time-series data are server-owned, persisted as JSON under `DATA_DIR`. The client reads/writes settings via `/settings`, prediction config via `/predictions/config`, and triggers computation via `POST /calculate`. The LP is always built server-side from persisted state — the client never sends LP parameters directly. `evLoad` can be sourced from Home Assistant or injected manually via `POST /data`; electricity prices can come from VRM, `POST /data`, or a Home Assistant sensor.

## Testing

Tests use vitest with supertest for API tests. Test files mirror the source structure under `tests/`. API tests mock external services (`settings-store`, `data-store`, `vrm-refresh`, `mqtt-service`). The `lib/` tests are pure unit tests. Browser-side tests (`tests/app/`) use jsdom.

## Code conventions

- ESM modules throughout (`"type": "module"` in package.json).
- TypeScript is used in `api/` and `lib/`; browser files under `app/` remain build-free JavaScript modules.
- Node.js >= 22 required.
- Express 5.
- Unused variables prefixed with `_` (eslint rule).
- ESLint also checks `.md` and `.css` files.
- Units are explicit in variable names: `_W` (watts), `_Wh` (watt-hours), `_percent`, `_m` (minutes), `_cents_per_kWh`.
- LP variable naming pattern: `{source}_to_{sink}_{slot_index}` (e.g., `grid_to_battery_3`).

## Versioning

The version must be updated in **3 locations** when bumping, plus the changelog:

1. `package.json` — `"version": "X.Y.Z"`
2. `package-lock.json` — run `npm install --package-lock-only` after updating package.json
3. `optivolt/config.yaml` — `version: "X.Y.Z"` (triggers HA add-on Docker image build)
4. `CHANGELOG.md` — add a new section at the top with the version, date, and changes

## Git remotes and CI

- **origin**: `vervoto1/optivolt` (fork) — CI runs here (Tests + Builder workflows).
- **upstream**: `bmesuere/optivolt` (original) — no CI for our pushes.
- The **Builder** workflow produces HA add-on Docker images (aarch64 + amd64) published to GHCR. It only triggers when files under `optivolt/` change (Dockerfile, config.yaml, build.yaml, rootfs). Bump `optivolt/config.yaml` version to trigger a new image build.
- The **Tests** workflow runs lint, typecheck, and vitest on every push to main.

## Victron control modes

The target system is a **3-phase Victron Multi RS Solar** with Cerbo GX running **Venus OS Large 3.71**. Two control modes exist:

### DESS (Dynamic ESS, Mode 4 / Node-RED)
- Writes 4 schedule slots via MQTT to `Settings/DynamicEss/Schedule/{0-3}/`.
- Each slot has `Start`, `Duration`, `Soc`, `Strategy`, `Restrictions`, `AllowGridFeedIn`.
- **Known limitation**: DESS computes its own internal `TargetSoc` that diverges from the slot `Soc` values. Charging power is often much lower than planned because the internal target is lower than the schedule target.
- Requires DESS Mode=4, Hub4Mode=3, SystemState=252 (External Control).

### ESS Direct (Mode 2, experimental)
- Writes `Settings/CGwacs/AcPowerSetPoint` (grid setpoint in watts).
- Positive = import from grid, negative = export to grid.
- Also writes `MaxChargePercentage` and `MaxDischargePercentage` (0 or 100) as on/off switches.
- **Not yet confirmed working** on the Multi RS 3-phase system. The setpoint is accepted via MQTT but the inverter does not act on it. Possible causes under investigation: DESS override, ESS mode conflicts, Multi RS architecture differences (`com.victronenergy.multi` service vs `com.victronenergy.vebus`).

### Multi RS architecture notes
- Uses `com.victronenergy.multi` D-Bus service (not `com.victronenergy.vebus` like MultiPlus II).
- Modbus TCP Unit ID 100 (not 227/246).
- Grid-code ramp rate limits (26-400 W/s) — large setpoint changes are not instant.
- HA Victron MQTT integration reads from Venus but `mqtt.publish` from HA goes to the HA broker, not Venus. OptiVolt writes directly to Venus MQTT (port 8883, TLS).
