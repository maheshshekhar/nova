# Nova Sentinel — the read-only early-detection companion.
# Small standalone image that runs the informer worker (lib/sentinel/run.ts).
# Build from the repo root:
#   docker build -f deploy/sentinel/Dockerfile -t ghcr.io/your-org/nova-sentinel:<tag> .
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 sentinel

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=sentinel:nodejs package.json tsconfig.json ./
COPY --chown=sentinel:nodejs lib ./lib

USER sentinel

# Runs the pure engine (tested) driven by the Kubernetes informer runtime.
CMD ["npx", "tsx", "lib/sentinel/run.ts"]
