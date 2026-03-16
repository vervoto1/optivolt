<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# addon

## Purpose

Packages OptiVolt as a Home Assistant add-on using s6-overlay for service management. Handles environment variable injection from HA config, persistent data directory setup, and ingress routing.

## Key Files

| File | Description |
|------|-------------|
| `rootfs/etc/services.d/optivolt/run` | s6-overlay service script: reads bashio config, exports VRM/MQTT env vars, launches `node api/index.ts` |
| `rootfs/etc/cont-init.d/10-perms.sh` | Container init: creates `/data` directory with correct permissions |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `rootfs/` | Container filesystem overlay (s6-overlay structure) |

## For AI Agents

### Working In This Directory

- The add-on manifest is at the repo root: `config.yaml` (not inside `addon/`)
- Service script reads HA options via `bashio::config` and exports as env vars
- Environment variables set: `VRM_INSTALLATION_ID`, `VRM_TOKEN`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `DATA_DIR=/data`
- Ingress enabled on port 3000; direct access mapped to 3070
- Supported architectures: aarch64, amd64

## Dependencies

### Internal

- `api/index.ts` — launched by the service script
- `config.yaml` — add-on manifest at repo root

### External

- s6-overlay — process supervisor
- bashio — Home Assistant config helper

<!-- MANUAL: -->
