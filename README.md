# OptiVolt 🔋

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant add-on** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Built-in load forecasting based on Home Assistant historical sensor data
- Server-side VRM integration for forecasts/prices and system limits
- Optional Dynamic ESS schedule pushes over MQTT (first 4 slots)
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory
- EV charging integration: reads EV Smart Charging schedule from Home Assistant, adds EV load as separate demand in the optimizer, optional battery discharge constraint during charging, visible as orange bar in charts
- Auto-calculate timer: built-in periodic calculation (configurable interval), replaces external HA automation triggers
- HA price sensor support: read electricity prices directly from Home Assistant sensors (e.g., GE Spot), supports hourly and 15-min price intervals
- Constant Voltage phase tuning: configurable SoC thresholds with reduced charge power limits for realistic battery modeling

## Installation

### Home Assistant Add-on (Recommended)

1. **Add the repository:**
   Go to **Settings → Add-ons → Add-on Store**, click the **⋮** menu (top right), select **Repositories**, and add:
   ```text
   https://github.com/vervoto1/optivolt
   ```
2. **Install the add-on:**
   Find **OptiVolt** in the store and click **Install**.
3. **Configure connection settings:**
   Open the OptiVolt add-on configuration panel and enter your Victron VRM credentials / installation ID, and the Victron IP address on your local network.
   *(Note: OptiVolt automatically connects to the internal HA WebSocket API using the supervisor token to fetch historical sensor data.)*
4. **Start and verify:**
   Start the OptiVolt add-on, open the UI, and verify that data (time series, prices, SoC, etc.) is being fetched correctly.

### Standalone / Local Development

```bash
npm install
npm run api       # or: npm run dev  (loads .env.local via dotenv-cli + nodemon)
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**
- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`); stores `settings.json` and `data.json`
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

### 2. Victron DESS Node-RED Mode & Price API Bug
To prevent Victron DESS from overwriting Optivolt's settings, you should set DESS to **Node-RED** mode (e.g., using the HA Victron MQTT extension).

_Workaround:_ There is a bug in the Victron API where **price data is not available** when DESS is not in the default mode. Create a Home Assistant automation that temporarily sets DESS back to **default** mode between **13:00 and 14:00** every day to fetch prices, leaving it in Node-RED mode otherwise.

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
OptiVolt integrates with the **EV Smart Charging** integration in Home Assistant to account for EV charging demand in the optimizer.

- Configure in **Settings → EV Charging**: enable the feature, set the sensor entities (charging schedule, car connected state), and charger power.
- When enabled, OptiVolt reads the EV charging schedule from HA and adds EV load as a separate demand signal in the LP, shown as an orange bar in the energy flow charts.
- **Always apply schedule** toggle: plan for EV demand even when the car is not currently connected.
- Battery discharge during EV charging can be optionally disabled to avoid double-conversion losses (grid → battery → EV is less efficient than grid → EV directly).

## Architecture & HTTP API

```text
app/                 # Static web UI (index.html, main.js, app/src/**)
api/                 # Express server (routes + services)
lib/                 # Core logic: LP builder, parser, DESS mapper, VRM + MQTT clients
optivolt/            # Home Assistant add-on (config, Dockerfile, rootfs, translations)
repository.yaml      # HA add-on repository metadata
```

Key services under `api/services/`:
- `planner-service.ts` — Orchestrates the full pipeline (VRM refresh → LP build → HiGHS solve → DESS map → MQTT write).
- `ha-ev-service.ts` — Reads EV charging schedule from Home Assistant REST API.
- `ha-price-service.ts` — Reads electricity prices from Home Assistant sensor (e.g., GE Spot).
- `auto-calculate.ts` — Internal timer that triggers calculations on a configurable interval.

The **UI** is static and calls the **Express API** on the same origin. The **API** exposes:

- `POST /calculate` — Builds & solves the LP with **HiGHS** and returns per-slot flows, SoC, and DESS mappings. Fast execution.
- `GET/POST /settings` — Reads/writes persisted system + algorithm settings (defaulting to `api/defaults/default-settings.json`).
- `POST /data` — Endpoint to inject custom time-series data. The payload maps arrays of 15m values. Accepted keys include `importPrice`, `exportPrice`, `load`, `pv`, `soc`, and `evLoad`:
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
- `POST /vrm/refresh-settings` — Fetches latest Dynamic ESS limits/settings from VRM and persists.
- `GET/POST /predictions/*` — Load forecasting features (`/validate`, `/forecast`, `/forecast/now`).

*Note:* Data and settings are server-owned. VRM refreshes write to `DATA_DIR/data.json` and the solver always reads from this persisted snapshot.
