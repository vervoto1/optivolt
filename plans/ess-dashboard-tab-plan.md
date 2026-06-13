# ESS System Dashboard Tab — Implementation Plan

## Status

Planned. Not started. This document is a self-contained build brief: a fresh
Claude Code session can implement the feature from this file alone.

## Goal

Add an **ESS** tab to the OptiVolt web UI, positioned **between the EV tab and
the Predictions tab**, that visualizes the home battery system the way the
existing Home Assistant `ess_system` dashboard does — but rendered natively in
OptiVolt with its own look and feel (Chart.js, `card`/`sidebar-label` styling,
light/dark theme).

The system has **two batteries** plus a Victron system view, so the tab must
support **multiple batteries** generically (not hardcoded to two), driven by
configuration with sensible defaults seeded for the current hardware.

### Build-vs-link tradeoff (decided: build native)

HA already renders this view in the `ess_system` Lovelace dashboard. Rebuilding
it natively in OptiVolt is a deliberate choice, with a real cost worth stating so
it's a decision and not an accident:

- **Why native (the call):** unified OptiVolt look/feel, light/dark theme, and a
  single pane that sits next to the optimizer — no context switch to HA, no
  embedded iframes/cards that don't match the rest of the UI.
- **What it costs:** this duplicates a working dashboard, couples it to OptiVolt's
  release cycle, and exposes it to **entity-id drift** (the seeded defaults hold
  hardcoded ids — Victron device id `c0619ab6bd28`, JK BMS prefixes). A BMS
  firmware update or entity rename silently breaks the seeded mapping.
- **Mitigation (required):** on load, **validate** that each configured entity id
  resolves; render missing entities as an explicit "sensor not found" placeholder
  per tile/series rather than a blank chart, and never let one missing id blank
  the tab (this aligns with the per-entity failure tolerance in the backend).
  If link/iframe is ever preferred, that remains a fallback — but the native
  build is the chosen path.

### Source dashboard being reproduced

The Home Assistant dashboard (`.storage/lovelace.ess_system` in the
`vervoto1/homeassistant` repo) contains, per battery:

- **Cell voltage** charts (16 cells), one live snapshot and one 24h trend.
- **Overview / settings** entities list (capacity setting, capacity remaining,
  balancing on/off, balancing current, charging power, discharging power, total
  voltage, state of charge, min/max cell voltage, pack current, calibration
  numbers).
- **Temperature monitoring** (4 cell temperature sensors + 1 MOSFET temp).
- A combined **SoC development** chart across both batteries.

Plus a **Victron system** card: ESS max charge current, battery power, DC bus
current, DC bus voltage, system SoC.

### Current hardware entities (defaults to seed)

Two JK BMS units exposed through the `jk_bms` integration:

- Battery 0 — name `Basen Green`, entity prefix `sensor.jk_bms_jk_bms_bms0_`
- Battery 1 — name `Gobel Power`, entity prefix `sensor.jk_bms_jk_bms_bms1_`

Per-battery entity suffixes (append to the prefix):

- Cell voltage: `cell_voltage_1` … `cell_voltage_16`
- Temperatures: `temperature_sensor_1` … `temperature_sensor_4`, plus
  `temperature_sensor_5` labelled "MOS Temperature"
- `state_of_charge`, `current`, `total_voltage`
- `charging_power`, `discharging_power`
- `total_battery_capacity_setting`, `capacity_remaining`
- `min_cell_voltage`, `max_cell_voltage`
- `balancing_current`
- Binary: `binary_sensor.jk_bms_jk_bms_bms0_balancing`
- Calibration numbers: `number.jk_bms_jk_bms_bms0_current_calibration`,
  `number.jk_bms_jk_bms_bms0_voltage_calibration`

Victron system entities (device id `c0619ab6bd28`):

- `number.victron_mqtt_c0619ab6bd28_system_0_system_ess_max_charge_current`
- `sensor.victron_mqtt_c0619ab6bd28_battery_512_battery_power`
- `sensor.victron_mqtt_c0619ab6bd28_battery_512_battery_current`
- `sensor.victron_mqtt_c0619ab6bd28_battery_512_battery_voltage`
- `sensor.victron_mqtt_c0619ab6bd28_battery_512_battery_soc`

---

## Architecture context (what already exists in OptiVolt)

Read these before starting; the feature plugs into existing plumbing.

- **HA reading is already built.** `api/services/ha-client.ts` exposes:
  - `fetchHaEntityState({ haUrl, haToken, entityId })` — single live entity via
    the HA REST API. In add-on mode it transparently uses the supervisor proxy
    (`http://supervisor/core` + `SUPERVISOR_TOKEN`).
  - `fetchHaStats({ haUrl, haToken, entityIds, startTime, endTime, period })` —
    long-term/short-term statistics via the HA WebSocket
    `recorder/statistics_during_period` command. `period` accepts
    `5minute` / `hour` / `day` / `month`. This is exactly what the source
    dashboard's `statistics-graph` cards use.
  - `api/services/ha-config.ts` resolves add-on vs standalone credentials
    (`resolveHaHttpConfig`, `resolveHaWsConfig`). Reuse it; do not reinvent.
- **HA route pattern.** `api/routes/ha.ts` already proxies
  `GET /ha/entity/:entityId` to the browser. New ESS routes follow the same
  shape (load settings, resolve HA config, call the client, map errors via
  `toHttpError`).
- **Settings are server-owned.** `api/types.ts` defines `Settings`;
  `api/defaults/default-settings.json` holds defaults; `POST /settings`
  deep-merges and persists to `DATA_DIR/settings.json`. Add an `essConfig`
  object here.
- **Front end is build-free ESM.** `app/index.html` + `app/main.js`, browser
  modules under `app/src/`. Charts use the vendored Chart.js
  (`app/vendor/chart.umd.js`, global `Chart`) via `renderChart(canvas, config)`
  and `getBaseOptions(...)` in `app/src/charts/core.js`. The colour palette and
  helpers (`toRGBA`, `dim`, `getBuyPriceColor`) live in `app/src/charts/colors.js`.
- **Tabs.** Tab buttons live in the `<nav role="tablist">` in `app/index.html`;
  panels are `<div role="tabpanel" id="panel-...">`. `setupTabSwitcher()` in
  `app/main.js` builds a `tabs` array and crossfades panels.
  - **Correction (do not "mirror Predictions" for laziness).** Predictions is
    NOT lazy — `app/main.js:117` calls `await initPredictionsTab()` *eagerly* in
    `boot()`. There is **no** existing per-tab lazy-init hook. To keep startup
    free of ESS HA traffic (an acceptance criterion), you must **add** a per-tab
    "activated once" hook in `activateTab()` (or a one-shot guard on the `tab-ess`
    click handler) and call `initEssTab()` from there — do not init ESS in
    `boot()`.
  - **Tab vs panel ordering.** Visual order is set by the **nav button** DOM
    order (`tab-optimizer`, `tab-ev`, `tab-predictions`, `tab-settings` today),
    so insert the `tab-ess` button between `tab-ev` and `tab-predictions`. The
    **panel** elements are show/hidden by id and their DOM position is irrelevant
    (today `panel-ev` is actually the *last* panel in `index.html`). Place
    `panel-ess` anywhere sensible; do not try to slot it "between the EV and
    Predictions panels" — that ordering doesn't exist in the panel DOM. Also note
    the `tabs` array in `setupTabSwitcher()` is in a different order than the DOM
    (Optimizer, Predictions, EV, Settings); it pairs each tab with its own panel,
    so array position doesn't affect routing — just add the ESS `{tab, panel}`
    entry.

### UI style tokens to reuse (from `app/index.html`)

- Panel wrapper: `mx-auto w-full max-w-7xl px-4 py-8 grid gap-6 lg:grid-cols-3 panel-hidden`
- Card: `<section class="card">` / `<div class="card">`
- Card heading: `<h3 class="sidebar-label">…</h3>`
- Chart wrapper: `<div class="h-80 w-full chart-wrap"><canvas …></canvas><div class="chart-empty">…</div></div>`
- Stat tiles: `summary-panel`, `stat-label`, `stat-value`
- Toggle: `<label class="toggle"><input type="checkbox"><span class="toggle-knob"></span>…</label>`
- Inputs: `class="form-input"`
- Tab button: copy an existing `<button id="tab-…" role="tab" aria-controls="panel-…">`
  with the active/inactive class strings used by `setupTabSwitcher()`.

---

## Data model

### `essConfig` (add to `Settings` in `api/types.ts`)

```ts
export interface EssBatteryConfig {
  name: string;                       // display name, e.g. "Basen Green"
  // Cell voltages: either an explicit list, or a prefix + count that expands to
  // `${cellVoltagePrefix}${n}` for n in 1..cellCount.
  cellVoltagePrefix?: string;         // e.g. "sensor.jk_bms_jk_bms_bms0_cell_voltage_"
  cellCount?: number;                 // e.g. 16
  cellVoltageEntities?: string[];     // explicit override, wins over prefix+count
  // Temperatures: list of { entity, name }.
  temperatureEntities?: { entity: string; name: string }[];
  // Scalar entities (all optional; missing ones are simply not rendered).
  socEntity?: string;
  currentEntity?: string;
  totalVoltageEntity?: string;
  chargingPowerEntity?: string;
  dischargingPowerEntity?: string;
  capacitySettingEntity?: string;
  capacityRemainingEntity?: string;
  minCellVoltageEntity?: string;
  maxCellVoltageEntity?: string;
  balancingBinaryEntity?: string;
  balancingCurrentEntity?: string;
  extraEntities?: { entity: string; name?: string }[]; // e.g. calibration numbers
}

export interface EssSystemConfig {
  name?: string;                      // e.g. "Victron system"
  maxChargeCurrentEntity?: string;
  batteryPowerEntity?: string;
  batteryCurrentEntity?: string;
  batteryVoltageEntity?: string;
  socEntity?: string;
  extraEntities?: { entity: string; name?: string }[];
}

export interface EssConfig {
  enabled: boolean;
  batteries: EssBatteryConfig[];
  system?: EssSystemConfig;
  historyWindowHours: number;         // default 24
  historyPeriod: '5minute' | 'hour';  // default '5minute'
  refreshIntervalSeconds: number;     // live state poll cadence, default 30
}
```

Add `essConfig?: EssConfig;` to `Settings`.

### Defaults (`api/defaults/default-settings.json`)

Seed `essConfig` with the two batteries and the Victron system from the
hardware list above so the tab works out of the box, while remaining fully
editable. Use the `cellVoltagePrefix` + `cellCount: 16` form to keep it compact.
`temperature_sensor_5` carries the display name `MOS Temperature`.

### Validation (`api/services/settings-schema.ts`)

Add an `essConfig` validator consistent with the other optional config blocks:
`enabled` boolean; `batteries` an array of objects with a required string
`name`; numeric `historyWindowHours` / `refreshIntervalSeconds`; `historyPeriod`
one of the allowed enum values. Be permissive about entity-id strings (any
non-empty string), since they are user-specific.

---

## Backend

### New service: `api/services/ess-service.ts`

Two functions, both pure orchestration over `ha-client.ts`:

- `getEssState(settings)`:
  1. Resolve the enabled `essConfig`; throw `HttpError(422)` if HA is not
     configured (mirror `api/routes/ha.ts`).
  2. Expand each battery's cell-voltage entity list (prefix+count or explicit).
  3. Collect **all** scalar + cell + temperature entity ids across batteries and
     system into one set, then fetch their live states.

     > **Use the bulk states endpoint, not N per-entity GETs.** A naive
     > `Promise.allSettled` over `fetchHaEntityState` issues one HTTP GET *per
     > entity* — ~16 cells + 5 temps + ~12 scalars per battery × 2 batteries ≈
     > 60+ requests to the supervisor proxy on **every** refresh (default every
     > 30 s while the tab is open). HA exposes `GET /api/states` (all entity
     > states in **one** request — a Layer-1 built-in). Add a
     > `fetchHaEntityStates()` to `ha-client.ts` (one bulk call via
     > `resolveHaHttpConfig`), fetch once, and filter/index the result by the
     > entity ids you need. Keep per-entity tolerance: an id absent from the bulk
     > result yields a `null` value for that tile/series, so one missing sensor
     > never blanks the tab (and a renamed/dropped entity surfaces as "not found",
     > supporting the entity-drift mitigation in the Goal section).
  4. Shape into a structured response:

     ```ts
     interface EssStateResponse {
       batteries: {
         name: string;
         cells: { entity: string; value: number | null }[];
         temperatures: { entity: string; name: string; value: number | null }[];
         scalars: Record<string, { entity: string; value: number | null; unit?: string }>;
         extras: { entity: string; name: string; value: string | null; unit?: string }[];
       }[];
       system?: { name: string; scalars: Record<string, …>; extras: […] };
       fetchedAtMs: number;
     }
     ```

- `getEssHistory(settings, { hours, period })`:
  1. Build the entity-id list for trend charts: all cell-voltage entities, all
     temperature entities, and all per-battery SoC entities.
  2. Compute `startTime = new Date(Date.now() - hours*3600_000).toISOString()`.
  3. Call `fetchHaStats({ …, entityIds, startTime, period })`.
  4. Return the raw per-entity reading arrays keyed by entity id, plus the
     `hours`/`period` echoed back. (The client maps these into Chart.js series.)

  > **CRITICAL — statistics vs raw history (trend charts can come up empty).**
  > `fetchHaStats` calls `recorder/statistics_during_period`, which only returns
  > data for entities that have **long-term statistics** (a `state_class` of
  > `measurement`/`total` *and* the recorder configured to keep statistics for
  > them). Per-cell JK BMS voltages and cell-temperature sensors frequently have
  > **no `state_class`** or are excluded from the recorder, in which case
  > `statistics_during_period` returns an **empty array — not an error** — and the
  > trend charts silently render blank for exactly the data this tab is built
  > around. (The source Lovelace dashboard mixes `statistics-graph` cards with
  > `history-graph` cards; the latter read raw history, a different API.) Do this:
  >
  > 1. **Verify first.** Add a one-time/diagnostic check (a `GET /ess/history`
  >    self-test or a startup log) that reports, per configured entity, whether
  >    statistics exist. Surface "no statistics" entities in the response so the
  >    UI can label them instead of drawing an empty chart.
  > 2. **Add a raw-history fallback.** Add `fetchHaHistory()` to `ha-client.ts`
  >    using `history/history_during_period` (REST `GET /api/history/period/...`,
  >    or the WS `history/history_during_period` command) for entities that lack
  >    statistics. `getEssHistory` chooses per entity: statistics where available
  >    (cheap, pre-aggregated), raw history otherwise. Raw history is higher
  >    volume — clamp the window and/or downsample client-side.
  >
  > This is the headline risk for the tab: without it, the cell-voltage trends —
  > the main reason the dashboard exists — may ship blank.

### New route: `api/routes/ess.ts`

- `GET /ess/state` → `getEssState(loadSettings())`.
- `GET /ess/history?hours=24&period=5minute` → `getEssHistory(...)` with query
  parsing + clamping (`hours` 1..168, `period` whitelist).
- Optional, **phase 8** (deferred): `POST /ess/max-charge-current` to write the
  Victron ESS max charge current. This requires an HA service call
  (`number/set_value`). **Cross-plan dependency:** that write path is exactly the
  generic `callHaService()` the EV native-charging plan adds to `ha-client.ts`
  (its phase 8). Build `callHaService` once in the EV work and have this reuse it —
  do not duplicate. Sequence: EV phase 8 before ESS phase 8. Leave the field
  **read-only** until then.

Mount in `api/app.ts` next to the other routers: `app.use('/ess', essRouter)`.

### Browser API wrappers (`app/src/api/api.js`)

Add `getEssState()` and `getEssHistory({ hours, period })` using the existing
`getJson` helper from `app/src/api/client.js`.

---

## Front end

### `app/index.html`

1. **Tab button** — insert a new `<button id="tab-ess" role="tab"
   aria-controls="panel-ess">` in the `<nav>` **between `tab-ev` and
   `tab-predictions`**. Use the inactive class string (copy from `tab-ev`) and a
   battery icon SVG, e.g. a Heroicons/MDI battery glyph:

   ```html
   <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0"
        viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
     <path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/>
   </svg>
   <span class="hidden sm:inline">ESS</span>
   ```

2. **Panel** — add `<div id="panel-ess" role="tabpanel"
   aria-labelledby="tab-ess" class="mx-auto w-full max-w-7xl px-4 py-8 grid gap-6 lg:grid-cols-3 panel-hidden">`
   after the EV panel and before the Predictions panel. Inside, lay out (all
   using `card` / `sidebar-label` / `chart-wrap` / `summary-panel`):

   - **Per battery** (rendered dynamically by JS, but provide a container the JS
     clones a template into, or build entirely in JS):
     - Overview card: a definition-list of the scalar values (SoC, capacity
       remaining / setting, total voltage, pack current, charging power,
       discharging power, min/max cell voltage, balancing on/off + balancing
       current, plus any `extraEntities`). Use `summary-panel` + `stat-label` /
       `stat-value` tiles, or a simple two-column rows layout.
     - Cell-voltage **snapshot** chart: 16-bar bar chart of current cell
       voltages (one canvas).
     - Cell-voltage **trend** chart: line chart, 16 series, 24h of `5minute`
       stats (legend hidden, matching the source dashboard).
     - Temperature **trend** chart: line chart, 5 series (legend shown).
   - **Combined SoC development** card spanning full width
     (`lg:col-span-3`): line chart with one series per battery.
   - **Victron system** card: scalar tiles for battery power, DC bus
     current/voltage, system SoC, and ESS max charge current (read-only value
     in phase 1).
   - Each chart canvas wrapped with a `.chart-empty` placeholder (copy the SVG
     bars markup from the optimizer "Power flows" card) shown until data loads.

### `app/src/ess-tab.js` (new module)

- `export function initEssTab()`:
  - Lazy init guard (run once). Fetch `getEssState()` and `getEssHistory()` in
    parallel; render cards + charts. Render an error/empty state if HA is not
    configured (catch the 422 and show a friendly message in the panel, do not
    throw — match how EV settings tolerate missing HA).
  - Build per-battery card DOM dynamically from the state response so it scales
    to N batteries.
  - Start a refresh interval (`essConfig.refreshIntervalSeconds`) that re-fetches
    **state** (cheap) while the ESS tab is the active panel; pause when hidden.
    Re-fetch **history** on tab (re)activation, not every interval.
- Charts via `renderChart(canvas, { type, data, options })`:
  - Snapshot bars: `type: 'bar'`, x = `Cell 1..16`, single dataset, colour from
    palette (e.g. a battery-blue from `SOLUTION_COLORS.soc`).
  - Trend lines: build the time axis from the stats timestamps with
    `buildTimeAxisFromTimestamps(...)` and `getBaseOptions(...)` from
    `app/src/charts/core.js`. 16 thin lines, `pointRadius: 0`, legend hidden.
  - Temperature: same, legend shown, y-axis 0..60 to match the source.
  - SoC development: one line per battery, y `0..100`, unit `%`.
  - Use `toRGBA(...)` / `dim(...)` for fills; generate 16 distinguishable cell
    colours by rotating hue (a small helper) since the palette has no 16-colour
    ramp.

### `app/main.js`

- Import `initEssTab` from `./src/ess-tab.js`.
- Register the ESS tab in the `tabs` array inside `setupTabSwitcher()`:
  `{ tab: document.getElementById('tab-ess'), panel: document.getElementById('panel-ess') }`.
  (The `.filter(t => t.tab && t.panel)` guard already there means a missing
  element won't crash.)
- Wire lazy init: call `initEssTab()` the first time the ESS tab is activated
  (add a small per-tab "activated once" hook in `activateTab`, or call it from
  the `tab-ess` click handler). Do **not** init during `boot()` — keep startup
  free of ESS HA traffic.

### `app/src/state.js` element registry

If the project funnels DOM lookups through `getElements()` in
`app/src/ui-binding.js` / `state.js`, register the new ESS elements there for
consistency. The dynamically-built per-battery DOM can live entirely inside
`ess-tab.js` without registry entries.

---

## Phases

| Phase | Scope | Output |
|-------|-------|--------|
| 1 | `essConfig` type + defaults + schema validation | Settings round-trips `essConfig` |
| 2 | `ess-service.ts` + `/ess/state` route + browser wrapper | `GET /ess/state` returns live snapshot |
| 3 | `/ess/history` route + browser wrapper | `GET /ess/history` returns stats series |
| 4 | ESS tab button + panel + `main.js` wiring (renders state only) | Tab visible between EV and Predictions; overview cards + snapshot bars populate |
| 5 | Trend + temperature + SoC charts from history | All charts render and match the source dashboard intent |
| 6 | Refresh interval, empty/error states, dark-mode polish | Auto-refresh while visible; graceful when HA missing |
| 7 (optional) | ESS settings card in Settings tab (edit batteries/entities) | Multi-battery editable in UI |
| 8 (optional) | Writable ESS max charge current via HA `number/set_value` | Setpoint adjustable from OptiVolt |

Phases 1–6 deliver the feature as requested. 7–8 are enhancements.

---

## Testing

Follow `AGENTS.md` PR/testing notes. Run `npm run typecheck`, `npm run lint`
(it lints `.md`/`.css` too), and `npm run test:run`.

- **Service tests** (`tests/api/ess-service.test.js`): mock `ha-client.ts`
  (`fetchHaEntityStates` bulk reader, `fetchHaStats`, `fetchHaHistory`) and
  assert: cell-prefix expansion; **one** bulk states call (not N per-entity
  GETs); per-entity tolerance (an id absent from the bulk result → `null` value,
  others still populated); correct entity-id set passed to `fetchHaStats`;
  `startTime` derived from `hours`.
  - **Statistics-empty → history fallback.** When `fetchHaStats` returns an empty
    array for a cell entity (no `state_class`), `getEssHistory` falls back to
    `fetchHaHistory` for that entity and the series is populated. Guards the
    headline "blank trend charts" risk.
- **Route tests** (`tests/api/ess-routes.test.js`, supertest): 200 shape for
  `/ess/state` and `/ess/history`; 422 when HA unconfigured; query clamping on
  `hours`/`period`; `/ess/history` reports which entities lack statistics.
- **Browser tests** (`tests/app/ess-tab.test.js`, jsdom): given a mocked state
  response, `initEssTab()` builds N battery cards; given a 422 it shows the
  empty state without throwing; a missing/renamed entity renders a "not found"
  placeholder (not a blank chart); tab registers in the switcher; the `tab-ess`
  **button** sits between `tab-ev` and `tab-predictions` in the nav DOM;
  `initEssTab()` is **not** called during `boot()` (no ESS HA traffic until the
  tab is first activated).

No version bump is required unless `optivolt/` add-on files change (they do not
for this feature) — see the versioning rules in `CLAUDE.md`. If a release is
cut, bump `package.json`, `package-lock.json`, `optivolt/config.yaml`, and
`CHANGELOG.md` together.

---

## Acceptance criteria

- A new **ESS** tab appears in the nav, ordered Optimizer · EV · **ESS** ·
  Predictions · Settings.
- The tab shows **both** batteries (and scales to more from config) with cell
  voltages (snapshot + 24h trend), temperatures (24h trend), and an overview of
  SoC / power / voltage / current / balancing.
- A combined SoC-development chart and a Victron system card are present.
- Visuals use OptiVolt's `card` / `sidebar-label` / Chart.js styling and respect
  light/dark theme — not embedded HA cards or iframes.
- Battery/entity mapping is **configuration-driven** via `essConfig`, defaulting
  to the current `Basen Green` + `Gobel Power` + Victron hardware.
- When HA is unconfigured/unreachable, the tab degrades gracefully (empty state,
  no crash). Startup does no ESS HA traffic until the tab is first opened.
- `npm run typecheck`, `npm run lint`, and `npm run test:run` pass.
