# Changelog

## 0.2.4

- Add EV charging as separate uncontrollable load input
- LP solver treats EV load as additional demand per slot (effectiveLoad = houseLoad + evLoad)
- Optional battery discharge constraint during EV charging to avoid double-conversion losses
- Home Assistant integration: read EV Smart Charging schedule via REST API
- New `/data` API endpoint support for posting evLoad TimeSeries
- EV load visualized as amber stacked bar in the load/PV chart
- EV Charging settings section in the UI (charger power, HA sensor config, discharge toggle)
- Plan summary includes EV load total (kWh)

## 0.2.3

- One-click Home Assistant add-on install via repository URL
- Automated CI/CD builder with multi-arch GHCR image publishing
- MQTT auto port selection: switches to 8883 when TLS is enabled
- Fix LP solver alternating battery charge/discharge flows when import/export prices are equal
- Update default sensors for Victron/Enphase/Tesla setup

## 0.2.0

- Add SSL/TLS support for MQTT connections
- Add load and PV forecasting via Home Assistant sensor history
- Dynamic ESS schedule writing via MQTT
- Web UI with Optimizer, Predictions, and Settings tabs

## 0.1.0

- Initial release
- Day-ahead cost minimization using HiGHS (WASM)
- VRM integration for forecasts, prices, and system limits
- Static web UI served by Express
