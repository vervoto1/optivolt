# Home Assistant add-on Dockerfile for OptiVolt.
# The base image lives here (build.yaml is retired). ghcr.io/home-assistant/base
# is a multi-arch manifest, so BuildKit picks the variant for the target platform;
# BUILD_FROM stays overridable for local experiments.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
# The runtime Node comes from the official image (see stage 2), pinned to an
# exact release on the base's Alpine branch. Bump it by hand on each Node
# security release: Alpine's own nodejs package can lag one by weeks (v3.24
# still shipped 24.18.1 after the 2026-10-21 security release, fixed in 24.22.1).
ARG NODE_IMAGE=node:24.22.2-alpine3.24
#
# Stage 1: install npm deps on the native builder platform to avoid QEMU
# "Illegal instruction" crashes when cross-compiling for aarch64.
# --platform=$BUILDPLATFORM pins this stage to the build host (amd64 runner) so
# `npm ci` runs natively instead of under QEMU emulation. The runtime deps
# (express, highs/WASM, mqtt) are arch-independent and dev-only native binaries
# are stripped by `npm prune --omit=dev`, so the pruned node_modules copied into
# the target-arch stage 2 below is portable across architectures. Nothing
# arch-specific may be installed here (a global tsx used to bring a build-host
# esbuild binary into the aarch64 image).
FROM --platform=$BUILDPLATFORM $NODE_IMAGE AS deps
WORKDIR /opt/optivolt
COPY package.json package-lock.json* ./
RUN npm_config_ignore_scripts=true npm ci \
  && npm prune --omit=dev

# The same Node image for the target platform: stage 2 copies its node binary.
FROM $NODE_IMAGE AS node

# Stage 2: final image on the target HA base.
FROM $BUILD_FROM

# Minimal runtime env
ENV \
  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  NODE_ENV=production

# Node is the official musl build from the node stage, not Alpine's nodejs
# package, so a Node security release reaches the add-on as soon as NODE_IMAGE
# is bumped. It bundles its own OpenSSL, ICU and CA store and needs only
# libstdc++ and libgcc from Alpine; npm is not needed at runtime. It has
# TypeScript type stripping: the s6 service runs `node api/index.ts` directly.
# `apk upgrade` pulls the base image's own packages (OpenSSL, curl,
# ca-certificates) up to the current security fixes. The last step fails the
# build, rather than the add-on at runtime, if Node lacks type stripping.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ libgcc curl \
  && apk upgrade --no-cache
RUN node -e "process.exit(process.features.typescript ? 0 : 1)" \
  || { echo "Node.js $(node --version) lacks TypeScript type stripping" >&2; exit 1; }

# Workdir for the app
WORKDIR /opt/optivolt

# Copy the pre-built (pure-JS) node_modules from the native stage
COPY --from=deps /opt/optivolt/node_modules ./node_modules
COPY package.json ./

# Copy app source
COPY app ./app
COPY api ./api
COPY lib ./lib
COPY vendor/highs-build ./vendor/highs-build

# s6-overlay service + init hooks
COPY rootfs/ /

# Healthcheck for the Supervisor/watchdog
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://127.0.0.1:3000/health || exit 1

EXPOSE 3000

# Static image labels (formerly build.yaml). The io.hass.* labels and the
# version/created/source labels are added by the build workflow.
LABEL \
  org.opencontainers.image.title="Home Assistant Add-on: OptiVolt" \
  org.opencontainers.image.description="Plan and control Victron ESS with forecasts & dynamic tariffs" \
  org.opencontainers.image.licenses="MIT"
