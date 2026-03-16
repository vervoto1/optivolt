# Home Assistant add-on Dockerfile for OptiVolt.
# BUILD_FROM is passed automatically by the HA builder.
ARG BUILD_FROM
FROM $BUILD_FROM

# Minimal runtime env
ENV \
  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  NODE_ENV=production

# Alpine 3.21 ships Node.js 22 which supports native TypeScript execution.
RUN apk add --no-cache nodejs npm curl

# Workdir for the app
WORKDIR /opt/optivolt

# Copy only what we need (smaller image, faster build)
COPY package.json package-lock.json* ./
COPY app ./app
COPY api ./api
COPY lib ./lib
COPY vendor/highs-build ./vendor/highs-build

# Install deps, then prune dev deps.
# Install tsx globally: Alpine's Node 22 is compiled without TypeScript support
# (--without-amaro), so we use tsx as the TypeScript runtime instead.
RUN npm ci \
  && npm prune --omit=dev \
  && npm install -g tsx

# s6-overlay service + init hooks
COPY rootfs/ /

# Healthcheck for the Supervisor/watchdog
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://127.0.0.1:3000/health || exit 1

EXPOSE 3000
