# syntax=docker/dockerfile:1.4
#
# Container image for the event automation webhook service.
#
#   DOCKER_BUILDKIT=1 docker build -t hou-event-automation -f apps/event-automation/Dockerfile .
#
# The service holds per-stack reporting state in memory between pstack events,
# so it is deployed as an always-on container rather than a scale-to-zero
# function.

ARG BASE_PRUNER=node:jod-bullseye-slim
ARG BUN_IMAGE=oven/bun:1.3.12-slim

FROM ${BASE_PRUNER} AS pruner
WORKDIR /app
ARG BASE_PRUNER=node:jod-bullseye-slim
RUN if [ "$BASE_PRUNER" = "node:jod-bullseye-slim" ]; then \
        npm install -g turbo@2.9.5; \
    else \
        echo "USING CACHED IMAGE"; \
    fi
COPY . .
RUN turbo prune @hou/event-automation --docker

FROM ${BUN_IMAGE} AS deps
ENV CI="true"
WORKDIR /app
COPY --from=pruner /app/out/json/ ./
COPY ./bunfig.toml ./
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --lockfile-only --ignore-scripts
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile --production
COPY --from=pruner /app/out/full/ ./

FROM ${BUN_IMAGE} AS runner
ENV NODE_ENV=production
ENV ENVIRONMENT=production
ENV CI="true"
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
COPY --from=deps /app ./
WORKDIR /app/apps/event-automation
USER bun
EXPOSE 8080
# Configuration is entirely via environment variables — see REQUIREMENTS.md.
CMD ["bun", "run", "src/index.ts"]
