#############################
# syntax=docker/dockerfile:1.7-labs
# Sparkplug Explorer Image
#############################
# Goals:
#  - Reproducible multi-stage build
#  - Dev dependencies excluded from final image
#  - Fast layer caching & multi-arch (amd64 + arm64)
#  - Glibc base (DuckDB prebuilt binaries) -> debian slim
#  - Deterministic dependency install leveraging BuildKit cache mounts

ARG NODE_VERSION=23
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH

#############################
# Stage 1: build (full deps + compile)
#############################
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG TARGETARCH
WORKDIR /app

ENV CI=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dependency layer (cached unless package manifests change)
COPY package.json yarn.lock ./
# Use BuildKit cache for yarn downloads (speeds up iterative builds)
RUN --mount=type=cache,id=yarn-cache,target=/root/.cache/yarn \
  yarn install --frozen-lockfile

# Copy source (kept separate to maximize caching of deps layer)
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY README.md ./

# Build server (tsc) + UI (vite)
RUN yarn build

#############################
# Stage 2: prod-deps (only production dependencies)
#############################
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
ARG TARGETARCH
WORKDIR /app
ENV CI=1 NODE_ENV=production
COPY package.json yarn.lock ./
# Install only production deps for target arch with cache
RUN --mount=type=cache,id=yarn-prod-cache,target=/root/.cache/yarn \
  yarn install --production --frozen-lockfile && yarn cache clean || true

#############################
# Stage 3: runtime (slim final image)
#############################
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG TARGETPLATFORM
WORKDIR /app

LABEL org.opencontainers.image.title="Sparkplug Explorer" \
  org.opencontainers.image.description="Sparkplug B ingestion + DuckDB + Fastify API + React UI" \
  org.opencontainers.image.source="https://github.com/mapped/sparkplug-explorer" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.base.name="node:${NODE_VERSION}-bookworm-slim" \
  org.opencontainers.image.platform="${TARGETPLATFORM}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/app/config/config.json \
    DUCKDB_PATH=/app/data/db.duckdb \
    LOG_REQUESTS=0 \
    TRACE=0

# Copy production dependencies only
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json /app/yarn.lock ./

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/index.html ./index.html
COPY README.md ./

# Prepare mount points (config provided by user; data persists DuckDB file)
VOLUME ["/app/config", "/app/data"]

USER app
EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
