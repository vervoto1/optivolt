# OptiVolt

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline.

## How it works

OptiVolt builds a linear program over 15-minute slots to decide how your battery, PV, and the grid should interact to minimize cost. It targets Victron Energy ESS systems via the VRM API and MQTT Dynamic ESS schedule writing.

## Configuration

### VRM credentials

- **VRM Site ID**: Your Victron VRM installation ID (found in the VRM URL).
- **VRM API Token**: A Personal Access Token from VRM (Preferences > Integrations).

### MQTT settings

- **MQTT Host**: Hostname or IP of the Victron MQTT broker (default: `venus.local`).
- **MQTT Port**: Port number (default: `1883`, or `8883` with TLS).
- **MQTT Username / Password**: Credentials if required by your broker.
- **MQTT TLS**: Enable TLS/SSL for the MQTT connection.
- **MQTT TLS Insecure**: Skip certificate verification (for self-signed certificates).

## Usage

Once installed and configured:

1. Open the OptiVolt UI from the Home Assistant sidebar.
2. Configure your battery settings on the Settings tab.
3. Run the optimizer from the Optimizer tab, or set up an automation to trigger it periodically.

### Automating with Home Assistant

Create a REST command to trigger the optimizer every 15 minutes:

```yaml
rest_command:
  optivolt_calculate:
    url: "http://localhost:3070/calculate/"
    method: POST
    content_type: "application/json"
    payload: '{"updateData": true, "writeToVictron": true}'

automation:
  - alias: "Trigger Optivolt every quarter hour"
    trigger:
      - platform: time_pattern
        minutes: "/15"
        seconds: 5
    action:
      - service: rest_command.optivolt_calculate
```

## Support

For issues and feature requests, visit: <https://github.com/vervoto1/optivolt/issues>
