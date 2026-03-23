<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# optivolt (HA add-on)

## Purpose

Home Assistant add-on packaging for OptiVolt. Contains the Dockerfile, add-on manifest, s6-overlay service configuration, translations, and documentation needed for HA to discover, build, and run OptiVolt as an add-on.

## Key Files

| File | Description |
|------|-------------|
| `config.yaml` | HA add-on manifest: name, version, arch, ingress, ports, options schema, image reference |
| `Dockerfile` | Alpine-based image: installs Node.js, copies source, runs npm ci, sets up s6 services |
| `build.yaml` | Base images per architecture and OCI labels for the HA builder |
| `CHANGELOG.md` | Release notes shown in the HA add-on store |
| `DOCS.md` | User-facing documentation displayed in HA |
| `icon.png` | 256x256 add-on icon for the HA store |
| `logo.png` | Add-on logo for the HA store |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `rootfs/` | s6-overlay filesystem: init scripts and service run/finish scripts |
| `translations/` | i18n strings for HA add-on configuration UI |

## For AI Agents

### Working In This Directory

- The `image` field in `config.yaml` must match the GHCR image built by `.github/workflows/builder.yaml`
- The Dockerfile expects source code (api/, app/, lib/, vendor/, package.json) to be copied into this directory by the builder workflow before Docker build
- `rootfs/etc/services.d/optivolt/run` reads HA config via `bashio::config` and exports as env vars
- Release version bumps must update all 3 version files plus the changelog:
  - `../package.json`
  - `../package-lock.json`
  - `config.yaml`
  - `../CHANGELOG.md`

### Testing Requirements

- After modifying the Dockerfile or rootfs, verify the image builds: the builder workflow runs on PR
- Source code tests (`npm test`, `npm run typecheck`) are independent of the addon packaging

### Common Patterns

- s6-overlay manages process lifecycle (run script starts Node, finish script triggers restart)
- HA ingress proxies port 3000; direct access on port 3070
- Persistent data stored in `/data` (mapped by HA)

## Dependencies

### Internal

- `../api/` — Express server (launched by rootfs run script)
- `../app/` — Static UI (served by Express)
- `../lib/` — Core logic
- `../vendor/highs-build/` — HiGHS WASM solver
- `../.github/workflows/builder.yaml` — CI/CD that builds and publishes the Docker image

### External

- `ghcr.io/home-assistant/{arch}-base:3.15` — HA base image (Alpine + s6-overlay)
- `home-assistant/builder` — GitHub Action for multi-arch builds
- bashio — HA config helper in run scripts

<!-- MANUAL: -->
