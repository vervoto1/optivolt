# OptiVolt 🔋

[![Tests](https://github.com/vervoto1/optivolt/actions/workflows/test.yml/badge.svg)](https://github.com/vervoto1/optivolt/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/vervoto1/optivolt/graph/badge.svg)](https://codecov.io/gh/vervoto1/optivolt)

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant App** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Built-in load forecasting based on Home Assistant historical sensor data
- Server-side VRM integration for forecasts/prices and system limits
- Dynamic ESS schedule pushes over MQTT using Mode 4 (Custom/Node-RED) with all 48 schedule slots
- EV charging integration: LP-optimized schedule with departure deadline, target SoC, and per-slot charge mode classification
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory
- Native EV charging: OptiVolt plans (and optionally actuates) EV charging directly in the optimizer from the live SoC/plug state, co-optimised with the home battery and visible as an orange bar in charts. Optionally models the car's **learned charge-acceptance taper** near full SoC (forecast-only) so the plan stops assuming a flat rate to target
- Auto-calculate timer: built-in periodic calculation (configurable interval), replaces external HA automation triggers
- HA price sensor support: read electricity prices directly from Home Assistant sensors (e.g., GE Spot), supports hourly and 15-min price intervals
- Constant Voltage phase tuning: configurable SoC thresholds with reduced charge power limits for realistic battery modeling (planner-side)
- Battery charge-current limiter: real-time, voltage-based control of the Victron ESS max charge current with hysteresis and emergency stop (ports a Home Assistant safety automation)
- Cell-balancing tuner: per-BMS adaptive balance start/trigger voltages (top/bottom balancing) from live cell voltage and current
- Adaptive learning: compares planned vs actual battery SoC to auto-calibrate charge/discharge efficiency over time
- Shore current optimizer: optional real-time shore limit control during planned grid-to-battery charging

## Installation

### Home Assistant App (Recommended)

1. **Add the repository:**
   Go to **Settings → Add-ons → Add-on Store**, click the **⋮** menu (top right), select **Repositories**, and add:
   ```text
   https://github.com/vervoto1/optivolt
   ```
2. **Install the add-on:**
   Find **OptiVolt** in the store and click **Install**.
3. **Configure connection settings:**
   Open the OptiVolt add-on configuration panel and enter your Victron VRM credentials / installation ID, and the Victron IP address on your local network.
   *(Note: Make sure MQTT access is enabled on your local Venus OS device: open the remote console, then Settings → Services → toggle the MQTT access switch.)*
   *(Note: OptiVolt automatically connects to the internal HA WebSocket API using the supervisor token to fetch historical sensor data.)*
4. **Start and verify:**
   Start the OptiVolt add-on, open the UI, and verify that data (time series, prices, SoC, etc.) is being fetched correctly.

**Alternative: manual rsync deployment** — If you prefer to deploy from a local clone rather than using the GHCR image, expose the HA `/addons` directory via the Samba share add-on, mount it on your computer, and sync with:
```bash
rsync -av --delete --exclude 'node_modules' --exclude '.git' --exclude '.DS_Store' --exclude 'tests' --exclude 'vendor/highs-js' ~/Code/optivolt/ /Volumes/addons/optivolt/
```
Then reload local add-ons (**Settings → Apps → Install App**, click **Check for Updates**), find **Optivolt**, and install.

### Standalone / Local Development

```bash
npm install
npm run api       # or: npm run dev  (loads .env.local via dotenv-cli + nodemon)
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**
- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`); stores `settings.json`, `data.json`, and `prediction-config.json`
- `VRM_INSTALLATION_ID`, `VRM_TOKEN` (enable VRM refresh routes)
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` (optional; required to push Dynamic ESS schedules)
- `MQTT_TLS` (`true`/`1` to enable TLS; default port becomes 8883), `MQTT_TLS_INSECURE` (`true`/`1` to skip certificate verification)

Create a `.env.local` file in the project root to set these variables for local development.

## Home Assistant Integration

Optivolt is designed to be coordinated heavily via Home Assistant. Below are the steps and examples to automate its features.

### 1. Trigger the Optimizer Loop
> **Note:** This step is no longer needed if you enable the built-in auto-calculate timer in Settings. The rest_command below is kept as a manual alternative.

Optivolt relies on a periodic trigger to fetch new data, calculate a plan, and (optionally) push it to Victron. Create a REST command to call the `/calculate/` endpoint:
```yaml
rest_command:
  optivolt_calculate:
    url: "http://localhost:3070/calculate/"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "updateData": true,
        "writeToVictron": true
      }
```

Then create an automation to trigger it every 15 minutes, a few seconds after each quarter hour:
```yaml
automation:
  - alias: "Trigger Optivolt calculate every quarter hour"
    trigger:
      - platform: time_pattern
        minutes: "/15"
        seconds: 5
    action:
      - service: rest_command.optivolt_calculate
```

### 1a. Built-in Auto-Calculate Timer
OptiVolt can run calculations automatically on a configurable interval without any external automation. Enable it in **Settings → Auto-Calculate** and set the desired interval. When active, OptiVolt will periodically call the full pipeline (fetch VRM data → solve LP → optionally write to Victron) on its own. No HA automation or REST command trigger is required.

### 2. Victron DESS Mode 4 (Automatic)
OptiVolt automatically sets Dynamic ESS to **Mode 4** (Custom/Node-RED) via MQTT before writing schedules. This tells the VRM cloud to stop sending its own schedules, giving OptiVolt full local control of the inverter. Mode 4 does not persist across GX reboots, so OptiVolt checks and re-applies it on every schedule write.

OptiVolt writes both `Soc` and `TargetSoc` fields per schedule slot for compatibility with Venus OS >= 3.20, and fills all 48 schedule slots to eliminate gaps between writes.

**Price refresh:** There is a Victron API limitation where price data is not available when DESS is in Mode 4. OptiVolt has a built-in **DESS Price Refresh** feature (Settings → DESS Price Refresh) that temporarily switches to Auto/VRM mode at a configurable daily time so prices can update, then restores Mode 4 and triggers an immediate recalculation with fresh prices. No external HA automation needed.

### 2a. Shore Current Optimizer

OptiVolt can optionally adjust the Victron shore current limit while the current DESS slot is explicitly charging the battery from the grid. The loop observes battery power, the configured Multi RS MPPT operation mode, and the current shore limit over MQTT. When the MPPT reports `MPPT active`, it probes the shore limit upward by the configured step. When the MPPT reports `Voltage/current limited`, it backs off by the same step so PV is not curtailed.

The optimizer only runs when all gates pass:
- `shoreOptimizer.enabled` is true.
- Battery power is above `minChargingPowerW`.
- The current cached OptiVolt plan row has `g2b > 0`, unless `gateOnDessSchedule` is disabled.
- MQTT readings are fresh.
- The MPPT state is either active or voltage/current limited.

The default config is scoped to one controller path only: `multi/6/Pv/0/MppOperationMode` and `multi/6/Ac/In/1/CurrentLimit`. It does not aggregate across other MPPTs or write other Multi instances. `dryRun` defaults to true and logs would-be writes without publishing; disable dry run only after validating behavior. The current runtime state is available at `GET /shore-optimizer/status`.

### 2b. Battery Protection — Charge-current Limiter & Cell-balancing Tuner

Two voltage-driven runtime controllers protect the LiFePO4 pack, configured on the **Settings → Battery** sub-tab. Both read live cell data from the `essConfig` entities used by the ESS dashboard, both default to **disabled + dry-run**, and both write Home Assistant `number` entities via service calls (no MQTT). Status for both is exposed at `GET /battery`.

- **Charge-current limiter** (`batteryChargeControl`). Reacts to the live max cell voltage across all configured batteries and walks a discrete current ladder (default `400, 180, 50, 0` A): an emergency stop to 0 A above `emergencyVoltage` (3.65 V), a one-rung step **down** above `reduceVoltage` (3.5 V), and a dwell-gated one-rung step **up** below `restoreVoltage` (3.4 V). It writes `essConfig.system.maxChargeCurrentEntity`. It is boot-seeded from the observed register (no write on the first tick), idempotent, and fail-safe (holds on any read/write error or missing voltage). This replaces the Home Assistant "Battery Charge Current State Machine" automation. Unlike the planner-side CV-phase taper (which caps the charge power the optimizer *schedules*), this actuates the real register in real time.
- **Cell-balancing tuner** (`batteryBalanceControl`). For each BMS, reads max cell voltage + pack current and writes that BMS's `balanceStartVoltageEntity` and `balanceTriggerVoltageEntity`: a tight trigger with a high start near the top of charge, a looser trigger stepped down toward a bottom floor, and a high-current back-off. It writes only when the decided values differ from the BMS's current ones. This replaces the Home Assistant `periodic_balance_check` automation; the JK BMS still performs the actual balancing.

Single-owner contention is detected and logged if the matching HA automation is still running on the same register, so leaving dry-run on while you validate is safe. To go live: disable the HA automation, then clear `dryRun` and enable the OptiVolt controller.

### 3. Load Forecasting Periodic Trigger (Optional)
Call the endpoint `/predictions/forecast/now` periodically from Home Assistant (via a REST Command) to generate up-to-date load forecasts. Be sure to first configure the predictor on the optimizer page of the UI.
```yaml
rest_command:
  optivolt_predict:
    url: "http://localhost:3070/predictions/forecast/now"
    method: GET
```

### 4. Push Custom Pricing / Sensor Data (Optional)
> **Note:** OptiVolt can now read prices directly from Home Assistant sensors. Set `dataSources.prices` to `'ha'` in **Settings → HA Price Sensor** and configure the entity ID (e.g., a GE Spot sensor). Both hourly and 15-minute price intervals are supported. The manual push example below remains available as an alternative.

If you don't use VRM for pricing and instead manually push data (by setting data sources to "API" in the UI), you can use the `/data` endpoint.
```yaml
rest_command:
  optivolt_push_prices:
    url: "http://localhost:3070/data"
    method: POST
    content_type: "application/json"
    payload: >-
      {% set import_data = state_attr('sensor.ecopower_consumption_price', 'consumption_data') %}
      {% set export_data = state_attr('sensor.ecopower_injection_price', 'injection_data') %}
      {% set step = 15 %}

      {% set import_start_ts = as_timestamp(as_datetime(import_data[0].time)) | int %}
      {% set export_start_ts = as_timestamp(as_datetime(export_data[0].time)) | int %}

      {% set import_start_iso = import_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}
      {% set export_start_iso = export_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}

      {
        "importPrice": {
          "start": {{ import_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (import_data | map(attribute='price') | list) | tojson }}
        },
        "exportPrice": {
          "start": {{ export_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (export_data | map(attribute='price') | list) | tojson }}
        }
      }
```

### 5. EV Charging
OptiVolt plans EV charging **natively** in the optimizer (it is the EV charging authority — there is no separate HA scheduler), co-optimised with the home battery so the two never fight for the same cheap hours.

- Configure in **Settings → EV Charging**: enable the feature, set the SoC/plug sensor entities, charger current/phases, battery capacity, target SoC and the "ready by" deadline. "Ready by" is a wall-clock time + Today/Tomorrow selector resolved relative to now (leave the time empty to simply charge to target by the end of the plan); it can't go stale or point past tomorrow. The car is only folded into the home-battery co-optimisation when it is actually plugged in.
- When `evActuationEnabled` is on, OptiVolt drives the charger directly (switch + charge-current entities); otherwise it plans the EV demand and shows it as an orange bar in the energy-flow charts.
- **Charge taper (learned, forecast-only):** enable **Model charge taper (learned)** to forecast the car's charge-acceptance taper near full SoC. OptiVolt learns the acceptance curve from the car's own SoC history (the same adaptive-learning pipeline as the home battery) and caps the planned EV charge power per SoC band, so the plan stops assuming a flat rate up to target. It never *commands* a lower current — the car's BMS already tapers physically; this only makes the plan realistic. Requires adaptive learning in **auto** mode and accrues confidence over a few charging sessions before it applies.

### 5a. EV Charger Control via REST Sensor (Optional)

Poll the `/ev/current` endpoint every minute to get the current slot's EV charging decision. Add this to your HA `configuration.yaml`:

```yaml
rest:
  - resource: http://localhost:3070/ev/current
    scan_interval: 60
    sensor:
      - name: "OptiVolt EV Charge Mode"
        value_template: "{{ value_json.ev_charge_mode }}"
        unique_id: optivolt_ev_charge_mode

      - name: "OptiVolt EV Charge Current"
        value_template: "{{ value_json.ev_charge_A }}"
        unit_of_measurement: A
        device_class: current
        unique_id: optivolt_ev_charge_current_a
```

Use `sensor.optivolt_ev_charge_mode` and `sensor.optivolt_ev_charge_current_a` in automations to control your charger. The mode values are `off`, `fixed`, `solar_only`, `solar_grid`, and `max`; the current is the target charge rate in amps.

### 6. Adaptive Learning (Plan Accuracy)
OptiVolt can learn from actual battery behavior to improve future plans. When enabled, it samples the real battery SoC, load, and PV from MQTT/VRM at each calculation tick and compares them against the solver's predictions. Over time, it builds per-SoC efficiency curves (100 points, one per SoC%) that capture how charge and discharge efficiency varies across the battery's state of charge.

- **Enable in UI:** toggle "(Dis)Charge Adaptive Learning" in the Predictions tab sidebar.
- **Two modes:**
  - `suggest` (default): collects data and exposes accuracy metrics via the API and Predictions tab, but does not modify the solver's parameters.
  - `auto`: additionally applies the per-SoC efficiency curve to the LP solver so future plans automatically account for observed losses.
- **`minDataDays`:** minimum days of data before calibration produces results (default: 3).
- **Confound filtering:** slots where actual load or PV deviated >20% from prediction (e.g. unexpected appliance) are automatically excluded from calibration to avoid contaminating efficiency data with forecast errors.
- **Per-SoC curves:** unlike a single efficiency number, the 100-point curves capture how efficiency varies across SoC levels. This naturally models CV phase tapering at high SoC, different bulk-phase behavior, and DESS throttling patterns.
- **View in UI:** the Predictions tab shows predicted vs actual SoC charts, deviation diffs, an efficiency curve chart (charge + discharge by SoC%), and calibration metrics. A "Reset Calibration Data" button allows starting fresh (e.g. after battery replacement).
- **API endpoints:**
  - `GET /plan-accuracy` — latest plan's predicted vs actual deviations
  - `GET /plan-accuracy/calibration` — current calibration curves, aggregate rates, and confidence
  - `GET /plan-accuracy/history?days=7` — historical accuracy reports
  - `GET /plan-accuracy/soc-samples?days=1` — raw SoC/load/PV samples
  - `POST /plan-accuracy/calibration/reset` — clear all calibration data
  - `POST /plan-accuracy/reset-all` — clear all adaptive learning data (calibration, plan history, SoC samples)

## Architecture & HTTP API

```text
app/                 # Static web UI (index.html, main.js, app/src/**)
api/                 # Express TypeScript server (routes + services)
lib/                 # TypeScript core logic: LP builder, parser, DESS mapper, VRM + MQTT clients
optivolt/            # Home Assistant add-on (config, Dockerfile, rootfs, translations)
repository.yaml      # HA add-on repository metadata
```

Key services under `api/services/`:
- `planner-service.ts` — Orchestrates the full pipeline (VRM refresh → LP build → HiGHS solve → DESS map → MQTT write).
- `ha-ev-service.ts` — Reads EV charging schedule from Home Assistant REST API.
- `ha-price-service.ts` — Reads electricity prices from Home Assistant sensor (e.g., GE Spot).
- `auto-calculate.ts` — Internal timer that triggers calculations on a configurable interval.
- `plan-history-store.ts` — Persists plan snapshots (predicted SoC trajectories) for adaptive learning.
- `soc-tracker.ts` — Samples actual battery SoC from MQTT and stores in a ring buffer.
- `plan-accuracy-service.ts` — Compares predicted vs actual SoC to compute deviation metrics.
- `efficiency-calibrator.ts` — EMA-based calibration of effective charge/discharge rates from observed deviations.

The **UI** is static and calls the **Express API** on the same origin. Server-owned state lives in `DATA_DIR`:

- `settings.json` stores system, algorithm, Home Assistant, data-source, and EV settings.
- `data.json` stores time-series data, current SoC, EV load, rebalance state, and manual prediction adjustments.
- `prediction-config.json` stores load/PV prediction model configuration.

Data-source behavior is explicit: when a data source is set to `vrm`, VRM refreshes own that series in `data.json`; when set to `api`, pushed data or prediction endpoints may write that series. The solver always reads persisted settings and data server-side.

The **API** exposes:

- `GET /settings` — Reads persisted settings, or `api/defaults/default-settings.json` when missing.
- `POST /settings` — Merges the incoming settings object into `DATA_DIR/settings.json`.
- `GET /data` — Reads persisted time-series data.
- `POST /data` — Injects custom time-series data. The payload maps arrays of 15m values:
  ```json
  {
    "importPrice": {
      "start": "2024-01-01T00:00:00.000Z",
      "step": 15,
      "values": [10.5, 11.2, 12.0, 11.8]
    },
    "evLoad": {
      "start": "2024-01-01T00:00:00.000Z",
      "step": 15,
      "values": [0, 0, 7400, 7400]
    }
  }
  ```
- `POST /calculate` — Builds and solves the LP with **HiGHS** from persisted settings/data. Optional body flags: `updateData` refreshes VRM series before solving, and `writeToVictron` attempts an MQTT DESS schedule write.
- `POST /vrm/refresh-settings` — Fetches latest Dynamic ESS limits/settings from VRM and persists.
- `GET /predictions/config` — Reads prediction configuration plus `isAddon`.
- `POST /predictions/config` — Saves prediction configuration. Home Assistant URL/token are intentionally stored in `/settings`, not this file.
- `GET /predictions/adjustments` — Lists active manual forecast adjustments and prunes expired ones.
- `POST /predictions/adjustments` — Creates a manual forecast adjustment for `load` or `pv`.
- `PATCH /predictions/adjustments/:id` — Updates a manual forecast adjustment.
- `DELETE /predictions/adjustments/:id` — Deletes a manual forecast adjustment.
- `POST /predictions/validate` — Runs load-predictor validation against Home Assistant history.
- `POST /predictions/load/forecast` — Runs the active load forecast and returns adjusted forecast data with `rawForecast` when adjustments apply.
- `POST /predictions/pv/forecast` — Runs the PV forecast when PV configuration is complete.
- `POST /predictions/forecast` — Runs load and PV forecasts together, persists raw forecasts according to data-source settings, and returns adjusted forecasts.
- `GET /predictions/forecast/now` — Same combined forecast path with recent comparison disabled.
- `GET /plan-accuracy/*` — Plan accuracy and adaptive learning (`/plan-accuracy`, `/calibration`, `/history`, `/soc-samples`, `/snapshots`).
- `GET /ev/current` — Current time slot's EV charging decision (`ev_charge_mode`, `ev_charge_A`, source flows, EV SoC).
- `GET /ev/schedule` — Full per-slot EV charging schedule from the last computed plan.
- `GET /ha/entity/:entityId` — Fetch live entity state from Home Assistant (used to validate EV sensor configuration).
