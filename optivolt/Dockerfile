# Home Assistant add-on Dockerfile for OptiVolt.
# BUILD_FROM is passed automatically by the HA builder.
ARG BUILD_FROM
#
# Stage 1: install npm deps on the native builder platform to avoid QEMU
# "Illegal instruction" crashes when cross-compiling for aarch64.
# --platform=$BUILDPLATFORM pins this stage to the build host (amd64 runner) so
# `npm ci` runs natively instead of under QEMU emulation. The runtime deps
# (express, highs/WASM, mqtt) are arch-independent and dev-only native binaries
# are stripped by `npm prune --omit=dev`, so the pruned node_modules copied into
# the target-arch stage 2 below is portable across architectures.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /opt/optivolt
COPY package.json package-lock.json* ./
RUN npm_config_ignore_scripts=true npm ci \
  && npm prune --omit=dev \
  && npm_config_ignore_scripts=true npm install -g tsx

# Stage 2: final image on the target HA base.
FROM $BUILD_FROM

# Minimal runtime env
ENV \
  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  NODE_ENV=production

# Alpine 3.22 ships Node.js 22 which supports native TypeScript execution.
RUN apk add --no-cache nodejs npm curl

# Workdir for the app
WORKDIR /opt/optivolt

# Copy pre-built node_modules and global tsx from native stage
COPY --from=deps /opt/optivolt/node_modules ./node_modules
COPY --from=deps /usr/local/lib/node_modules/tsx /usr/local/lib/node_modules/tsx
RUN ln -s ../lib/node_modules/tsx/dist/cli.mjs /usr/local/bin/tsx
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
