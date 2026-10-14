# syntax=docker/dockerfile:1
#
# Hushloom web app: the Next.js standalone server (output: "standalone" in next.config.ts), laid out
# exactly as playwright.config.ts runs it in the e2e suite.
#
#   docker build -t hushloom-web .
#
# It needs Postgres, Redis and the variables in .env.example at run time; docker-compose.yml wires
# all of it. Nothing secret is baked in: .dockerignore keeps every .env file out of the context.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. deps: exact install from the lockfile (dev dependencies too: next build needs them) ──
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── 2. build ──
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Every page is dynamic (the root layout reads cookies), so the build needs no database or secrets.
RUN npm run build
# The standalone output copies neither .next/static nor public/ (sw.js, the manifest, icons).
# Without them every stylesheet, script, icon and the service worker would 404.
RUN cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public

# ── 3. runtime ──
FROM ${NODE_IMAGE} AS runtime
# ffmpeg runs in this process too: video uploads are re-muxed without their metadata
# (src/server/media.ts) and their keyframes scanned (src/server/safety/scan) before storage.
# sharp brings its own libvips for glibc (@img/sharp-libvips-linux-*), traced into the standalone output.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# NODE_ENV=production is a production build, which on its own makes this a live site: sandbox
# payments, the sandbox age check and the development scanner refuse to run. APP_ENV is left unset
# on purpose; see .env.example before changing it.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_LOCAL_DIR=/data/storage
COPY --from=build --chown=node:node /app/.next/standalone ./
# Local media lives on a volume shared with the worker at the same absolute path.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
VOLUME ["/data/storage"]
EXPOSE 3000
# /api/health answers 200 when Postgres and Redis both answer, 503 otherwise.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
