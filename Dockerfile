# Home Assistant add-on Dockerfile for OptiVolt.
# Home Assistant passes BUILD_FROM automatically; default to amd64 for local builds.
ARG BUILD_ARCH=amd64
ARG BUILD_FROM=ghcr.io/home-assistant/${BUILD_ARCH}-base:3.21

# Install npm deps on the native builder platform to avoid cross-arch npm issues
# when the final image is built for Home Assistant add-on targets.
FROM node:22-alpine AS deps
WORKDIR /opt/optivolt
COPY package.json package-lock.json* ./
RUN npm_config_ignore_scripts=true npm ci \
  && npm prune --omit=dev \
  && npm_config_ignore_scripts=true npm install -g tsx

FROM $BUILD_FROM

# Minimal runtime env
ENV \
  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  NODE_ENV=production

# Alpine 3.21 ships Node.js 22 for the TypeScript API runtime.
RUN apk add --no-cache nodejs npm curl

# Workdir for the app
WORKDIR /opt/optivolt

# Copy runtime deps and the tsx launcher required by the s6 service.
COPY --from=deps /opt/optivolt/node_modules ./node_modules
COPY --from=deps /usr/local/lib/node_modules/tsx /usr/local/lib/node_modules/tsx
RUN ln -s ../lib/node_modules/tsx/dist/cli.mjs /usr/local/bin/tsx
COPY package.json ./

COPY app ./app
COPY api ./api
COPY lib ./lib
COPY vendor/highs-build ./vendor/highs-build

# s6-overlay service + init hooks
COPY optivolt/rootfs/ /

# Healthcheck for the Supervisor/watchdog
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://127.0.0.1:3000/health || exit 1

EXPOSE 3000
