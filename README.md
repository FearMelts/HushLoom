# Hushloom

Hushloom is an adults-only web app for making images and short videos from templates. You browse a
gallery of creator templates, make something from one with its defaults or your own settings, and
keep the results in a private library with projects, scenes, presets and versions. Behind it sit a
generation queue with a database-backed state machine, an idempotent credit ledger, server-side age
and consent checks, abuse scanning on every upload and output, and private media served only through
short-lived signed links. It is a Next.js 15 app (React 19, strict TypeScript, Tailwind 4) with
Postgres (Drizzle), Redis (BullMQ) and a separate worker process.

## What is a demo or a sandbox in this build

Nothing below pretends to be live. Each mode is labeled in the interface with the "demo" tone and
refuses to run on a live site (see [APP_ENV](#app_env-and-live-sites)).

| Area | In this build | Goes live with |
| --- | --- | --- |
| AI generation | Labeled demo models: ffmpeg and sharp render a placeholder locally, and every result says it is a demo output, not made by an AI model. No AI provider key exists. A Replicate adapter is written but has never run against Replicate. | A provider account and its key (`REPLICATE_API_TOKEN`), and `ENABLE_DEMO_PROVIDER=false` |
| Payments | Labeled sandbox checkout that never charges anyone. CCBill and Segpay adapters are written from their public documentation and have never run against either. Stripe stays off: it bans adult content. | A CCBill or Segpay merchant account (`PAYMENT_PROVIDER` and its keys) |
| Age verification | Labeled sandbox check that proves nothing. The Yoti adapter is written from the public docs and unexercised. | A Yoti account (`AGE_VERIFICATION_PROVIDER=yoti` and its keys) |
| Abuse scanning | Labeled development scanner that matches only listed test hashes. | PhotoDNA approval (`SCAN_PROVIDER=photodna`); see [docs/abuse-response.md](docs/abuse-response.md) |
| Push notifications | Off until VAPID keys are set, and says so. | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| S3 storage | Driver written against the AWS SDK, never run against a real bucket. Local disk is the default. | `STORAGE_DRIVER=s3` and the `S3_*` variables |

## Prerequisites

- Node.js 22 (20.18 or later works) and npm
- PostgreSQL 16
- Redis 7 (with persistence and `maxmemory-policy noeviction` for BullMQ)
- ffmpeg on the `PATH` (demo clips, poster frames, video upload checks)
- For the browser tests: Playwright's Chromium (`npx playwright install chromium`)

Or only Docker with Compose v2.24 or later, for the [Docker quick start](#docker-quick-start).

## Quick start (local)

The defaults in `src/server/env.ts` point at a Postgres role `playbox` without a password on
localhost, Redis on localhost, and a `.storage/` folder for media.

```sh
# 1. Database (as a Postgres superuser), or set DATABASE_URL in .env instead
createuser -s playbox
createdb -O playbox playbox

# 2. Install
npm ci

# 3. Configuration: optional for local development, the defaults work
cp .env.example .env            # every line is commented out; uncomment what you change

# 4. Schema and sample data
npm run db:migrate
SEED_PASSWORD=choose-a-password npm run db:seed

# 5. Run the app and the worker, in two terminals
npm run dev                     # http://localhost:3000
npm run worker                  # processes the generation queue
```

`npm run dev` reads `.env` on its own. The worker, the migrations and the seed are plain scripts and
do not: if you changed `.env`, export it in that shell first with `set -a; . ./.env; set +a`.

### Seed accounts

The seed does nothing on a database that already has templates. It creates:

- `admin@hushloom.local` (admin)
- `demo@hushloom.local` (member, with 200 credits)
- five creators: `lunavelour@hushloom.local`, `atelier_noir@hushloom.local`, `mx_ember@hushloom.local`,
  `softfocus@hushloom.local`, `nightcartographer@hushloom.local`

Every account uses the password in `SEED_PASSWORD`. Without it the seed makes a random password
and prints it once. Seeded templates are samples with abstract cover art and demo models.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run worker` | The generation worker (`tsx src/worker/index.ts`) |
| `npm run db:migrate` | Applies the SQL migrations in `drizzle/` |
| `npm run db:seed` | Sample categories, templates and accounts (development and private previews only) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint through `next lint`, zero warnings allowed |
| `npm test` | vitest, unit and integration (needs Postgres and Redis) |
| `npm run build` | Production build (`next build`, standalone output) |
| `npm start` | Runs the production build with `next start` |
| `npm run test:e2e` | Playwright journey on the production standalone server |
| `npm run verify` | typecheck, lint, test, build and test:e2e in that order |

### Tests

```sh
createdb -O playbox playbox_test   # once; the test setup migrates it
npm test
```

vitest uses `TEST_DATABASE_URL` (default `postgres://playbox@localhost:5432/playbox_test`) and Redis
db 1 (`TEST_REDIS_URL`). Its tables are emptied between tests, so never point it at real data.

```sh
npx playwright install chromium    # once
npm run test:e2e
```

The e2e run drops and recreates `playbox_e2e` (`E2E_DATABASE_URL`; the name must end in `_e2e`),
flushes Redis db 2 (`E2E_REDIS_URL`), builds the app, copies `.next/static` and `public/` into the
standalone output, and starts `node .next/standalone/server.js` on port 3100 plus the worker on
health port 3901: the same server layout as the web image. It sets `APP_ENV=test` so the sandboxes may
run on that production build.

## Docker quick start

```sh
cp .env.example .env
```

Uncomment and set at least:

```sh
POSTGRES_PASSWORD=...        # openssl rand -hex 24
MEDIA_SIGNING_SECRET=...     # openssl rand -hex 32
```

The images are production builds, so without provider accounts the app refuses to run as a live
site. For a private preview on your own machine, also set `APP_ENV=staging` (never on a public site).

```sh
docker compose up -d --build
docker compose ps            # web and worker turn "healthy"
```

Then open http://localhost:3000 (`WEB_PORT` changes the host port). The port is published on
127.0.0.1 only, for a reverse proxy on the same machine; `WEB_BIND=0.0.0.0` publishes it on every
interface, which Docker opens past host firewalls such as ufw, so then only the edge may reach it.

What runs:

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `postgres:16` | Database, volume `pgdata`, healthcheck `pg_isready` |
| `redis` | `redis:7` | Queue and rate limits, append-only, no eviction, volume `redisdata` |
| `migrate` | `Dockerfile.worker` | One-shot `npm run db:migrate`; web and worker wait for it |
| `web` | `Dockerfile` | Next.js standalone server on port 3000, healthcheck `GET /api/health` |
| `worker` | `Dockerfile.worker` | `node --import tsx src/worker/index.ts`, healthcheck on port 3901 |
| `seed` | `Dockerfile.worker` | Optional, profile `seed` |
| `minio`, `s3-init` | community MinIO build, `Dockerfile.worker` | Optional, profile `s3` |

`web` and `worker` share the `storage` volume at `/data/storage`, the same absolute path in both, as
local storage requires. Both images run as the unprivileged `node` user and include ffmpeg: the web
process re-muxes video uploads without their metadata and scans their keyframes before storing them.

Sample data, private previews only (it needs `SEED_PASSWORD` in `.env` and refuses to run unless
`APP_ENV` names a non-live site):

```sh
docker compose --profile seed run --rm seed
```

S3-compatible storage with MinIO, for trying the S3 driver locally. Set in `.env`:
`STORAGE_DRIVER=s3`, `S3_BUCKET=hushloom-media`, `S3_ENDPOINT=http://minio:9000`,
`S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (these also become MinIO's root
user and password; the password needs 8 or more characters). Then:

```sh
docker compose --profile s3 up -d --build
```

`s3-init` creates the private bucket before web and worker start. Browsers fetch media straight from
the presigned links, which point at `S3_ENDPOINT`, so for a local trial add `127.0.0.1 minio` to
your hosts file. MinIO's own images are no longer on Docker Hub (`minio/minio` is not found there as
of October 2026), so the default is Pigsty's community build `pgsty/minio`; set `MINIO_IMAGE` to use
another build. In production use a managed bucket (AWS S3, Cloudflare R2) instead.

Build the images on their own:

```sh
docker build -t hushloom-web .
docker build -f Dockerfile.worker -t hushloom-worker .
```

## Configuration

Every variable is listed, commented, in [.env.example](.env.example), grouped by area;
`src/server/env.ts` is the source of truth for types, defaults and the production checks. Never commit
`.env` or put a real key in the template. Generate secrets with `openssl rand -hex 32`.

### APP_ENV and live sites

`NODE_ENV` says how the code was built; `APP_ENV` says what kind of site this is. Leave `APP_ENV`
unset (or `production`) on a live site: a production build without it is treated as live. On a live
site the configuration check rejects the development scanner (while `SCAN_FAIL_CLOSED=true`) and the
sandbox age check (while `AGE_VERIFICATION_ENFORCE=true`): the worker exits at start, and the web app
answers every page and API request, its health check included, with an error. The sandbox checkout is disabled
there too. `staging` is for a private preview only; `test` is what the e2e suite uses.

Before a public launch, at minimum:

- a real payment processor, age-verification provider and scanner, with their keys
- `MEDIA_SIGNING_SECRET` (32+ characters) and an absolute `STORAGE_LOCAL_DIR`, or S3
- HTTPS in front of the web container, and `APP_URL` set to the public https origin
- the edge sets the geo headers (`GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER`) and strips any copy the
  client sends: the app trusts them as received, and age-verification rules depend on them
- backups of the `pgdata` and `storage` volumes (or the bucket)

### Error monitoring

Every error is a JSON line on stdout. Set `ERROR_WEBHOOK_URL` and each error is also POSTed there,
fire-and-forget with a 3-second timeout and at most 30 events a minute per process:

```json
{
  "source": "web",
  "time": "2026-10-14T01:31:40.442Z",
  "message": "request error",
  "error": { "name": "Error", "message": "...", "stack": "...", "digest": "266712064", "cause": { "name": "Error", "message": "connect ECONNREFUSED ..." } },
  "route": "/explore",
  "path": "/explore",
  "method": "GET",
  "context": { "routeType": "render" }
}
```

Events never carry request bodies, query strings, headers, cookies, prompts or media, and database
query parameters are redacted. Errors that `route()` turns into a 500, render and server-action
errors (through `src/instrumentation.ts`) and worker errors all arrive. To use Sentry or a similar
service, point the URL at a small relay that converts this event to the service's format; the hook
lives in `src/server/observability.ts`.

## Documentation

- [docs/vision.md](docs/vision.md): product vision
- [docs/design-system.md](docs/design-system.md): tokens, type, components, motion, accessibility
- [docs/information-architecture.md](docs/information-architecture.md): sitemap and routes
- [docs/engineering.md](docs/engineering.md): architecture, schema, APIs, worker, adapters, security
- [docs/deployment.md](docs/deployment.md): deployment and configuration in depth
- [docs/verification-report.md](docs/verification-report.md): what was tested, what is demo or sandbox, what blocks launch
- [docs/abuse-response.md](docs/abuse-response.md): CSAM and abuse scanning, review and reporting

## Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests for every branch except `main`: one job
for typecheck, lint, vitest and the production build, one for the Playwright journey (its report is
uploaded when it fails). Both use Postgres 16 and Redis 7 service containers and install ffmpeg.
