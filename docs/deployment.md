# Hushloom Deployment and Configuration

Deliverable F: configuring, running, testing and deploying Hushloom at `342afb4`, with all build tracks, the launch journey and review fixes merged (`notes/progress.md`). Everything here exists in that code unless marked **planned** or **not built**. **Unverified** means written from public documentation, never run against the real service. No credentials appear here.

| Area | State in this build |
| --- | --- |
| Web app, worker, database, queue, credits, local storage | Operational, covered by tests |
| AI generation | **Labeled demo**. Replicate adapter unverified. |
| Payments | **Labeled sandbox**, never charges. CCBill and Segpay unverified. Stripe off. |
| Age verification | **Labeled sandbox**, proves nothing. Yoti unverified. |
| Abuse scanning | **Labeled dev scanner**, test hashes only. PhotoDNA unverified. |
| Push | Off until VAPID keys are set. Delivery unverified. |
| S3 storage, Docker, CI | Written, not run: no real bucket, no `docker build`, no CI run. |

## 1 Requirements

| Need | Version | Notes |
| --- | --- | --- |
| Node.js and npm | 22 | `package.json` allows 20.18 or later. Images and CI use 22. |
| PostgreSQL | 16 | Local tests need a role that can create databases. |
| Redis | 7.0 or later | Use append-only persistence and `maxmemory-policy noeviction`, or BullMQ can lose jobs. The rate limiter needs `EXPIRE ... NX` (7.0). While Redis is down, rate-limited routes answer 503. |
| ffmpeg | Any, on the `PATH` | Both processes: demo clips, posters, metadata stripping, video scans. Without it, video uploads get 503. |
| Storage | Local disk or an S3-compatible bucket | Local disk: one absolute path both processes reach. A bucket must be private. |
| Chromium | `npx playwright install chromium` | e2e only. |
| Docker Compose | 2.24 or later | Optional (§7). |

A deployment runs the web server, the worker and a one-shot migration. Alpine is untried.

## 2 Environment variables

`src/server/env.ts` is the source of truth: 63 variables, defaults and startup checks. `.env.example` lists them all, commented, plus 16 for the seed, compose and tests; `tests/unit/env-template.test.ts` fails if `.env.example` misses a variable. `npm run dev`, `npm start` and compose read `.env`. The worker, migrations and tsx scripts do not: run `set -a; . ./.env; set +a` first. An empty value is not unset, so leave unused lines commented.

### The APP_ENV rule

`NODE_ENV` says how the code was built; `APP_ENV` says what kind of site it is. Each process judges from its own environment: it is **live** when `APP_ENV=production`, or `APP_ENV` is unset and its `NODE_ENV` is `production` (`isLiveDeployment()`). There, `SCAN_PROVIDER=dev` with `SCAN_FAIL_CLOSED=true`, or `AGE_VERIFICATION_PROVIDER=sandbox` with `AGE_VERIFICATION_ENFORCE=true`, stops the app: the worker exits 1 and every web request fails, health check included. Sandbox checkout answers 503, a sandbox age result reads as unverified, and the seed refuses to run.

**Rule:** leave `APP_ENV` unset, or `production`, on any site the public can reach. Use `staging` only for a private preview, because it lets the sandboxes run. `test` is for e2e.

`NODE_ENV` defaults to `development`. The standalone `server.js` and both images set `production`; `npm run worker` and tsx scripts do not. Outside the images, run the worker, seed and scan backfill with `NODE_ENV=production` or an explicit `APP_ENV=production`. Otherwise they count as not live: the worker skips the live-site checks, a dev scanner there clears every output, and the seed creates shared-password accounts in the live database. The migration reads only `DATABASE_URL`.

`AGE_VERIFICATION_ENFORCE=false`, or `SCAN_PROVIDER=cloudflare` with `SCAN_FAIL_CLOSED=false`, also starts a live site without a real provider; neither belongs there without legal sign-off.

### TRUSTED_PROXY_HOPS

Rate limits on sign-up (10 an hour), sign-in (30 per 15 minutes per address) and signed-out takedowns (10 an hour) key on the client address (`src/server/request.ts`). Set `TRUSTED_PROXY_HOPS` to the number of proxies in front that append to or set `X-Forwarded-For`; the app uses the n-th entry from the right.

- **No proxy** (local development): `0`, the default. All requests then share one key: the limits apply site-wide.
- **One proxy** (Caddy, nginx, a load balancer or a CDN): `1`.
- **Cloudflare in front of nginx**, both appending: `2`.

Count exactly: too high trusts a client-sent entry, too low makes visitors share a proxy's address. The app port must be reachable only through the proxy, or a client can name its own address.

### Secrets

- Never commit secrets: keep them in the host's secret store. `.gitignore` ignores every `.env*` except `.env.example`; `.dockerignore` keeps `**/.env` and `**/.env.*` out of images.
- Generate `MEDIA_SIGNING_SECRET`, `CCBILL_WEBHOOK_TOKEN`, `SEGPAY_POSTBACK_SECRET`, `AGE_VERIFICATION_WEBHOOK_SECRET` and `SEED_PASSWORD` with `openssl rand -hex 32`, and `POSTGRES_PASSWORD` with `openssl rand -hex 24`.
- Generate one VAPID pair per deployment with `npx web-push generate-vapid-keys`. Rotating it drops every push subscription.
- Providers issue the rest: CCBill salt, Segpay ids, Yoti key and SDK id, PhotoDNA key and endpoint, Replicate token, S3 keys.

**Core and storage**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` | Worker and scripts outside the images: `production` | no | `server.js` and the images set `production` (§2). |
| `APP_ENV` | unset | See the rule | no | `development`, `test`, `staging` or `production`. |
| `APP_URL` | `http://localhost:3000` | Production: the public https origin | no | Allowed origin for API writes. Base for checkout, Yoti and download links. |
| `DATABASE_URL` | `postgres://playbox@localhost:5432/playbox` | Beyond local development | yes | Postgres. |
| `REDIS_URL` | `redis://localhost:6379` | Beyond local development | if it holds a password | Queue and rate limits. |
| `SESSION_TTL_DAYS` | `30` | optional | no | Sign-in lifetime. |
| `TRUSTED_PROXY_HOPS` | `0` | Behind a proxy: 1 or more | no | Proxies that add to `X-Forwarded-For` (above). |
| `MEDIA_SIGNING_SECRET` | dev fallback | Production, 32+ characters | yes | Signs media links. Production will not start without it. |
| `MEDIA_URL_TTL_S` | `300` | optional | no | Private link lifetime. Links live up to 1.1x: 300 to 330 s, public template links 3600 to 3960 s. |
| `STORAGE_DRIVER` | `local` | optional | no | `local` or `s3`. Either way `/api/media` serves and re-checks every file; no presigned bucket URLs. |
| `STORAGE_LOCAL_DIR` | `.storage` | Absolute in production | no | Same path for web app and worker. |
| `S3_BUCKET`, `S3_REGION` | unset (region `auto`) | Bucket: `STORAGE_DRIVER=s3` | no | A private bucket. `auto` suits R2. |
| `S3_ENDPOINT` | unset | Non-AWS services | no | Reached by the app only, never by browsers (the presigned-link comment in `.env.example` is stale). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset | S3, unless the SDK credential chain applies | yes | Bucket keys. |

**AI generation and worker**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `ENABLE_DEMO_PROVIDER` | `true` | optional | no | Labeled demo models. Set `false` once a real provider is live. |
| `REPLICATE_API_TOKEN` | unset | Replicate | yes | Turns on `replicate-flux-schnell` (unverified). |
| `REPLICATE_WEBHOOK_SECRET` | unset | optional | yes | Verifies `/api/webhooks/replicate` (503 without it), which only logs. |
| `PROVIDER_TIMEOUT_S` | `600` | optional | no | Provider timeout. Stuck jobs fail 2 minutes later. |
| `WORKER_CONCURRENCY` | `2` | optional | no | Jobs per worker process. |
| `WORKER_HEALTH_PORT` | unset (image: 3901) | For probes | no | Worker `GET /health` port. |
| `USER_MAX_ACTIVE_JOBS` | `3` | optional | no | Active jobs per user. A plan's higher limit wins. |
| `SIGNUP_GRANT_CREDITS` | `0` | optional | no | Credits for each new account. |

**Payments** (addendum §1)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `PAYMENT_PROVIDER` | `sandbox` | Live: `ccbill` or `segpay` | no | `sandbox`, `ccbill`, `segpay` or `stripe`. |
| `CCBILL_ACCOUNT`, `CCBILL_SUBACCOUNT`, `CCBILL_FLEXFORM_ID` | unset | ccbill | no | Account, subaccount, checkout form. |
| `CCBILL_SALT`, `CCBILL_WEBHOOK_TOKEN` | unset | ccbill | yes | The salt signs checkout links and checks sale digests. The token, 16+ characters, comes as `?token=`; without it CCBill is unconfigured: no checkout, and its webhooks answer 503. |
| `CCBILL_DATALINK_USER`, `CCBILL_DATALINK_PASSWORD` | unset | Not used | password: yes | Declared, never called. |
| `SEGPAY_PACKAGE_ID`, `SEGPAY_PRICE_POINT_ID` | unset | segpay | no | The package, and one price point per item: `pack_small=ID,pack_medium=ID,pack_large=ID,plan_member=ID,plan_studio=ID`. A bare value is ignored; an unmapped item cannot be bought. |
| `SEGPAY_POSTBACK_SECRET`, `SEGPAY_USER_ACCESS_KEY` | unset | Secret: segpay | yes | Every postback presents the secret, as `key=` or Basic auth. The optional access key also works as that password. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | stripe only | yes | Keep Stripe off: it bans adult content. |

**Age gate, geolocation and verification** (addendum §2)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `AGE_ASSURANCE_STRICT_REGIONS` | empty | optional | no | Extra codes for the verification list. |
| `GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER` | `x-country-code`, `x-region-code` | Match your edge | no | Country and US state (`TX` becomes `US-TX`), trusted as received. |
| `AGE_VERIFICATION_PROVIDER` | `sandbox` | Live and enforcing: `yoti` | no | `sandbox` or `yoti`. |
| `AGE_VERIFICATION_ENFORCE` | `true` | Keep `true` | no | In covered places, unverified members cannot create; uploads, `/api/characters`, downloads and publishing answer 451; explicit media is withheld, their own creations included. |
| `AGE_VERIFICATION_REGIONS` | GB plus 25 US states | To override | no | Codes such as `GB,US-TX`. A bare `US` covers every state. |
| `AGE_VERIFICATION_FAIL_CLOSED` | `false` | Your decision | no | `true` treats an unknown location as covered: no geo header, `XX`, `T1`, `A1` or `A2`, or a bare `US` while states are configured. |
| `AGE_VERIFICATION_API_KEY`, `AGE_VERIFICATION_SDK_ID` | unset | yoti | key: yes | Yoti API key and SDK id. |
| `AGE_VERIFICATION_API_URL` | `https://age.yoti.com` | optional | no | Yoti base URL. |
| `AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY` | unset | yoti | no | PEM key. Without it, notifications are rejected. |
| `AGE_VERIFICATION_WEBHOOK_SECRET` | dev fallback | sandbox only | yes | Signs sandbox callbacks. |
| `AGE_VERIFICATION_VALID_DAYS` | `365` | optional | no | Validity. Changing it moves existing expiry dates. |

**Abuse scanning, push and observability** (addendum §3, §4; `docs/abuse-response.md`)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `SCAN_PROVIDER` | `dev` | Live: `photodna` | no | `dev`, `photodna` or `cloudflare`. |
| `SCAN_FAIL_CLOSED` | `true` | Keep `true` | no | Unchecked content is never kept: uploads get 503, outputs retry, then refund. |
| `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT` | unset | photodna | key: yes | Key and Match URL, issued after Microsoft's approval. |
| `CLOUDFLARE_SCAN_WEBHOOK_SECRET` | unset | Not used | yes | Cloudflare notifies by email only. |
| `SCAN_TIMEOUT_S` | `30` | optional | no | Seconds before a scan counts as unavailable. |
| `SCAN_DEV_MATCH_HASHES`, `SCAN_DEV_SIMULATE_OUTAGE` | empty, `false` | dev only | no | Test hashes, outage drills. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | unset | Push | private key: yes | The pair browsers subscribe with and pushes are signed by, and a `mailto:` or `https:` contact (not localhost). Push is off until all three are set. |
| `ERROR_WEBHOOK_URL` | unset | optional | if it holds a token | Gets each error as JSON, without bodies, query strings, prompts or media. Fire-and-forget, rate-capped. The web process installs it even when other configuration fails its check; the worker then exits 1 unreported. |

**Seed and compose only**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `SEED_PASSWORD` | random, printed once | Compose seed | yes | Password for every seeded account. |
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | none, `hushloom`, `hushloom` | Password: compose | password: yes | The bundled Postgres login and database. |
| `WEB_PORT`, `WEB_BIND` | `3000`, `127.0.0.1` | optional | no | The web container's host port and address. Use `0.0.0.0` only for an edge on another host, which alone may reach it: Docker's published ports bypass ufw. |
| `MINIO_IMAGE` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | optional | no | Image for the `s3` profile (§7). |

**Test variables** (none secret):

- vitest: `TEST_DATABASE_URL` (`.../playbox_test`, tables emptied), `TEST_REDIS_URL` (db 1), `LOG_TESTS` (prints info lines).
- Playwright: `E2E_PORT` (3100), `E2E_DATABASE_URL` (`.../playbox_e2e`, recreated each run, name must end in `_e2e`), `E2E_REDIS_URL` (db 2, flushed), `E2E_MEDIA_SIGNING_SECRET` (random per run), `E2E_SHOTS_DIR` (journey evidence, default `test-results/journey`).
- `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS`: `playwright.config.ts` sets 1 so service worker requests see emulated offline state.

The web image sets `PORT`, `HOSTNAME=0.0.0.0` and `NEXT_TELEMETRY_DISABLED`. Compose sets `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `STORAGE_LOCAL_DIR`, `APP_URL` and `MEDIA_SIGNING_SECRET` over `.env`. `playbox` is a leftover internal name.

## 3 Local setup and dev commands

```sh
createuser -s playbox && createdb -O playbox playbox
npm ci
cp .env.example .env                 # optional: every line is commented, so the defaults apply
npm run db:migrate
SEED_PASSWORD=<choose one> npm run db:seed
npm run dev                          # terminal 1: http://localhost:3000
npm run worker                       # terminal 2: the generation queue
```

The defaults run sandbox payments, the sandbox age check, the dev scanner and demo models, all labeled. Under `next dev` the service worker does push only, no caching.

**Seeded data.** The seed exits 1 when its own process counts as live (`scripts/seed.ts`); on a bare host that takes `NODE_ENV=production` or `APP_ENV=production` (§2). It skips a database that already has templates, and stops if its media does not scan clean. It creates 9 categories, 24 sample templates on demo models, `admin@hushloom.local` (admin), `demo@hushloom.local` (member, 200 credits), and five creators: `lunavelour`, `atelier_noir`, `mx_ember`, `softfocus` and `nightcartographer`, each `@hushloom.local`. All share `SEED_PASSWORD`, or a random password printed once.

Other commands:

- `npx tsx scripts/scan-backfill.ts [--include-unavailable]`: scans assets with no verdict. Exits 1 if any are left.
- `npx tsx scripts/s3-bucket.ts`: creates the bucket if missing.

## 4 Migrations

`npm run db:migrate` runs Drizzle's migrator over `drizzle/` (`scripts/migrate.ts`) with `DATABASE_URL` from the environment. A re-run applies only new migrations. There are no down migrations: back up first, and migrate before starting new code. Compose's `migrate` service does this.

| Migration | What it does |
| --- | --- |
| `0000_init` | The base schema: 12 enum types and 33 tables. |
| `0001_output_posters` | Adds `generation_outputs.poster_asset_id`. |
| `0002_launch_readiness` | Adds `account_flags`, `age_verifications`, `push_subscriptions`, `takedown_requests`, scan and `legal_hold` columns on `media_assets`, age columns on `users`, payment fields. **Existing media becomes `pending`, unserved until `npx tsx scripts/scan-backfill.ts` runs.** |
| `0003_integrity_fks_and_dob` | Makes `users.date_of_birth` nullable and erases it for deleted accounts. Clears dangling references and adds five `ON DELETE SET NULL` foreign keys. Cannot be undone. |
| `0004_taken_down_hashes` | Creates `taken_down_hashes` (`sha256` primary key, `takedown_id` with `ON DELETE SET NULL`, `created_at`) and the index `media_sha256_idx` on `media_assets(sha256)`. Publishing reads it. |

New migrations: edit `src/server/db/schema.ts`, run `npm run db:generate`, review the SQL, commit it with its `meta` snapshot.

**Legal hold and data rules**

- **Legal hold.** Never delete, purge or overwrite a held `media_assets` row (`legal_hold = true`) or its file, by hand or by bucket lifecycle rules. Only "Clear as false positive" on `/admin/review` lifts a hold, and not while another open or confirmed case covers the file. Release after a report is for counsel (`docs/abuse-response.md` §4, §6).
- **No hard deletes of users.** In-app deletion is soft and erases email and date of birth. Deleting a `users` row by hand cascades to consents, flags, age records and the ledger, and detaches held evidence.
- **Retention.** The worker hourly purges files soft-deleted over 30 days ago. Consent withdrawal and NCII or likeness takedowns purge at once. Both skip held files and files with no scan verdict (`scan_status = 'pending'`), which stay stored, never served, until `scripts/scan-backfill.ts` records one (`src/server/media.ts`).
- **Takedown hash block.** An actioned takedown records the SHA-256 of each file it removed, and publishing those bytes answers 409 `taken_down`. The block is permanent: it outlives the purged files, and no admin tool lifts it.
- **Backups.** Back up database and media together. Whether a restore may bring back data users deleted since is for legal review.
- **No test scripts on real data.** vitest empties its tables, and `e2e-prepare` drops the schema of any `_e2e` database.

## 5 Testing commands

| Command | Runs | Needs |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | nothing else |
| `npm run lint` | `next lint --max-warnings 0` | nothing else |
| `npm test` | vitest: 17 unit and 27 integration files | Postgres (`createdb -O playbox playbox_test` once), Redis, ffmpeg |
| `npm run test:e2e` | Playwright on the standalone server | the above, Chromium, ports 3100 and 3901 |
| `npm run verify` | typecheck, lint, test, build, test:e2e | all of it |

vitest uses `TEST_DATABASE_URL` and `TEST_REDIS_URL`, migrates first (`tests/global-setup.ts`) and runs files one at a time.

What `test:e2e` builds:

1. `scripts/e2e-prepare.ts` resets the `_e2e` database, Redis db and `.storage-e2e/`, migrates, seeds, and runs the scan backfill.
2. `next build`.
3. `scripts/e2e-serve.mjs` copies `.next/static` and `public/` next to `server.js` and starts it with `NODE_ENV=production` and `APP_ENV=test`.
4. The worker starts once `/api/health` answers, health port 3901.

`tests/e2e/journey.spec.ts` has 9 tests (core flows, isolation, under-18 refusal, layout, keyboard); `tests/e2e/launch.spec.ts` has 27 (age checks, sandbox payments, scanning, takedowns, the installable app, phone width).

**Last results** (`notes/progress.md`): typecheck and lint clean, vitest 503/503 in 44 files, e2e 36/36 on a fresh production build at `ce84bff` (`notes/evidence/e2e-ce84bff.log`). `342afb4` changes only notes.

## 6 Production build and run

```sh
npm ci && npm run build
cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public
npm run db:migrate
PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js
NODE_ENV=production node --import tsx src/worker/index.ts   # from the full checkout
```

- **Copy the static files.** Standalone output has neither `.next/static` nor `public/`. Without them, styles, scripts, icons, the manifest and `sw.js` return 404.
- **Use `server.js`.** `npm start` runs `next start`, which does not support standalone output.
- **No database at build time.** Every page is dynamic, so the build should need no database or secrets (untried).
- **Configuration.** Pass variables through the environment. The web process needs ffmpeg, and with S3 it streams all media.
- **Worker.** Runs from source with tsx (full install needed) and, outside the image, needs `NODE_ENV=production` (§2). It exits 1 on invalid configuration, reconciles stuck jobs and expires drafts older than 24 hours (at start, then every 60 s), purges media hourly, and serves `GET /health` when `WORKER_HEALTH_PORT` is set. On SIGTERM it closes its connections and exits 0.
- **Health.** `GET /api/health` answers 200 when `database` and `redis` are both `ok`, otherwise 503. The worker's `/health` answers 200 while its consumer runs.
- **Scaling.** `WORKER_CONCURRENCY` raises parallelism. Multiple instances are untested; with local storage they need a shared disk.

## 7 Docker and compose

`Dockerfile` (web) runs `node server.js` with the static files, as user `node`, on `node:22-bookworm-slim` with ffmpeg, healthcheck `/api/health`. `Dockerfile.worker` has the same base and ffmpeg plus the full `npm ci`. It runs the worker as PID 1 (healthcheck on 3901), plus migrate, seed and s3-init. Both set `NODE_ENV=production`.

| Service | Role | Profile |
| --- | --- | --- |
| `postgres` | `postgres:16`, volume `pgdata`. Requires `POSTGRES_PASSWORD`. | default |
| `redis` | `redis:7`, append-only, `noeviction`, volume `redisdata` | default |
| `migrate` | One-shot migrations once Postgres is healthy | default |
| `web` | Published on `${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}`: this machine only by default. Waits for `migrate` and Redis. | default |
| `worker` | Same dependencies as `web` | default |
| `seed` | Refuses unless `SEED_PASSWORD` is set and `APP_ENV` is set and not `production` | `seed` |
| `minio` | On `127.0.0.1:9000` and `:9001`, volume `miniodata`. Root login is the app's S3 keys. | `s3` |
| `s3-init` | Creates the private bucket before web and worker start | `s3` |

App containers read `.env`, run with `init: true`, and share the `storage` volume at `/data/storage`. Postgres and Redis publish no ports. Run the TLS proxy on the same host, or set `WEB_BIND=0.0.0.0` and firewall the port to the edge. A local trial without provider accounts needs `APP_ENV=staging`.

```sh
docker compose up -d --build
docker compose --profile seed run --rm seed     # private previews only
docker compose --profile s3 up -d --build
```

**Validated:** only `docker compose config` (all three profiles, with the intended errors for missing secrets) and registry checks that the tags exist. **Not validated:** `docker build` (no Docker daemon was available) and `docker compose up`.

**MinIO caveat.** MinIO's official images left Docker Hub (401 on 2026-10-14), so the `s3` profile defaults to `pgsty/minio`, Pigsty's community build at a pinned tag: a supply-chain choice for the owner, never pulled or run. Override it with `MINIO_IMAGE`. In production, use a managed private bucket (AWS S3 or R2).

**Open low items**, left by decision (`notes/progress.md`):

- **I09.** Compose Redis has no password, but is not published. A required `REDIS_PASSWORD` would break every existing `.env`, since compose interpolates inactive profiles too.
- **I10.** Base images are pinned by tag, not digest, which needs registry access and a build to verify.
- **I11.** The web image's server files are owned by the runtime user, so a compromised process could rewrite them. A fix is unverifiable without Docker.

## 8 CI

`.github/workflows/ci.yml` runs on pushes and pull requests for every branch except `main`, so a pull request into `main` gets no CI. Permissions are read-only, and checkouts set `persist-credentials: false`. Both jobs start Postgres 16 and Redis 7 services and install Node 22 and ffmpeg. `checks` runs `npm ci`, typecheck, lint, vitest and the build. `e2e` adds Chromium, runs `npm run test:e2e` (a second build), and uploads the report on failure, kept 14 days.

It has **never run on GitHub**. Open low item I07: actions are pinned to `@v4` tags, not commit SHAs.

## 9 Hosting and edge requirements

**Platform constraints**

- **Payments.** Stripe bans adult content, AI-generated included (https://stripe.com/legal/restricted-businesses). Use CCBill or Segpay.
- **Mobile.** Apple (guideline 1.1.4, https://developer.apple.com/app-store/review/guidelines/) and Google Play (https://support.google.com/googleplay/android-developer/answer/9878810) ban sexually explicit apps. Mobile is the installable web app, offered in Settings only.
- **Host policy.** Vercel's acceptable-use policy is unclear for adult content: check before deploying there. No host's or CDN's policy has been checked.
- **Process model.** A long-running worker with ffmpeg, persistent Redis, Postgres, and a shared disk or bucket. Serverless could host at most the web part (untried).

**TLS and the reverse proxy.** No proxy is bundled. Terminate TLS at Caddy, nginx or a CDN. HTTPS is required: cookies are `Secure` in production, service workers and push need a secure context, and Yoti notifications need an https `APP_URL`.

The proxy must:

- be the only way to reach the app port
- match `APP_URL` exactly, or browser API writes get 403 `bad_origin` (`src/server/origin.ts`)
- replace client-sent forwarding headers with its own; for `X-Forwarded-For`, replacing or appending both work, with `TRUSTED_PROXY_HOPS` set to match (§2)
- allow bodies of at least 101 MB on `POST /api/uploads` and 21 MB on `POST /api/characters` (100 MB and 20 MB files plus form overhead)
- pass `Range` headers to `/api/media`
- keep webhook query strings (`?token=`, `key=`) and let processors reach `/api/webhooks/payments/ccbill`, `/api/webhooks/payments/segpay` and `/api/webhooks/age-verification/yoti`
- add HSTS, which the app does not set (it sets `X-Frame-Options`, `nosniff`, referrer and permissions policies, and `X-Robots-Tag: noindex`)

**Geo headers.** The age rules trust `GEO_COUNTRY_HEADER` and `GEO_REGION_HEADER` as received, so the edge must strip client copies and set its own (`cf-ipcountry` behind Cloudflare). Without them every visitor is "unknown", and `AGE_VERIFICATION_FAIL_CLOSED` decides.

**Cache-Control.** Never cache HTML or `/api/*` at the edge. `/api/media` sends `private, max-age=<seconds until expiry>`, so Cloudflare's CSAM tool would scan nothing as shipped. `sw.js` sends `no-cache` and `Service-Worker-Allowed: /`; do not cache or rewrite it. `/_next/static/*` is content-hashed and safe to cache. `/_next/image` answers 404 by design (`next.config.ts`, `images.unoptimized`).

**Service worker scope.** `/sw.js` registers with scope `/`, as do the manifest's `start_url` and `scope`, so serve the app at the root of its origin. It serves `/_next/static` cache-first and public pages network-first, falling back to a precached `/offline`, never storing HTML. It never answers `/api/*`, signed-in pages, ranges or writes (`public/sw.js`). Bump `VERSION` to ship an update.

## 10 Going live checklist

**Accounts to open**

| Account | Variables and setup |
| --- | --- |
| **CCBill** or **Segpay** | CCBill: `PAYMENT_PROVIDER=ccbill`, ids, salt and webhook token, all required. Webhook: `https://<host>/api/webhooks/payments/ccbill?token=<token>`. Segpay: `PAYMENT_PROVIDER=segpay`, package, price point map, postback secret. Postback, as POST: `.../api/webhooks/payments/segpay?key=<secret>`. Its template must echo `hluser`, `hlitem` and `hlsig`; without them a sale is ignored, with no grant, flag or alert. Without `<eticketid>` or `<price>`, a sale is held for review (a `manual_review` flag on `/admin`) and grants nothing. Sales below the item's price or in another currency are held too. Replace the placeholder prices in `src/config/pricing.ts`. |
| **Yoti**, for UK "highly effective age assurance" (Ofcom, https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance) and US state laws (https://www.freespeechcoalition.com/faq) | `AGE_VERIFICATION_PROVIDER=yoti`, API key, SDK id, notification public key. Register `/api/webhooks/age-verification/yoti` and allow `/api/age-verification/return`. |
| **PhotoDNA** (free after approval) | `SCAN_PROVIDER=photodna`, `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT`, fail-closed kept on. |
| **Cloudflare CSAM tool** (optional, free, https://blog.cloudflare.com/the-csam-scanning-tool/) | Dashboard only. A second layer, never a replacement. |
| **NCMEC CyberTipline**, IWF or an INHOPE hotline | Manual reporting of confirmed matches. |
| **An AI provider that permits adult content** | `REPLICATE_API_TOKEN`, then `ENABLE_DEMO_PROVIDER=false`. Per the addendum, fal.ai forbids explicit output unless it authorizes the account, and Replicate's terms are ambiguous, though callers can disable its safety checker. The adapter does not set that flag and supports only text-to-image. Other providers need a new adapter (**not built**). |
| **VAPID keys** (self-generated) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| **An error monitor** such as Sentry | `ERROR_WEBHOOK_URL`, through a relay that converts the events (no SDK). |
| **Hosting** | Container host, Postgres 16, persistent Redis 7, private bucket, TLS edge setting geo and forwarding headers, backups. |

**Configuration**

- `APP_ENV` unset with `NODE_ENV=production` in every process (§2), an https `APP_URL`, a generated `MEDIA_SIGNING_SECRET`, and S3 or a shared absolute `STORAGE_LOCAL_DIR`.
- `TRUSTED_PROXY_HOPS` equal to the number of proxies, at least 1. Under compose, `WEB_BIND=127.0.0.1` unless the edge is on another host.
- Geo headers matching the edge, `AGE_VERIFICATION_REGIONS` re-checked, `AGE_VERIFICATION_FAIL_CLOSED` decided.
- Migrations applied through 0004 and the backfill run. No seed.
- Alerts on the log lines `scan.unavailable`, `scan.matched`, `scan.match_record_failed`, `scan.match_hold_failed`, `generation.match_record_failed` and `generation.match_hold_failed` (`src/server/safety/scan/index.ts`). After any `*.match_record_failed` or `*.match_hold_failed`, run `npx tsx scripts/scan-backfill.ts`: the file sits held and pending, and its case, flag and suspension appear only when the backfill rescans it.
- Named reviewers working `/admin/review` daily.

**Open questions for the processors** (`notes/progress.md`)

- Does CCBill echo pass-through values with their `X-` prefix? If not, sales grant nothing (fail closed).
- Is a CCBill Refund or Chargeback `transactionId` the original sale's or a new one?
- A timestamp freshness window and nonces in the pass-through signatures wait on the real CCBill and Segpay formats.
- Segpay still reads a missing `currencycode` as USD (postbacks are authenticated by the secret).

**Legal review**

- `docs/abuse-response.md` §4 and §6: reporting duties, preservation period, original upload bytes, NCII timelines.
- The region list: the addendum cites 27 states with laws, the default list holds 25 (compiled 2026-10-12). It is configuration, not legal advice.
- Yoti's age-estimation threshold of 25 and its privacy terms.
- Every public template counts as explicit.
- Takedowns reach byte-identical copies on every account, and the hash block is permanent: product calls for the owner.
- Whether processor, host and AI provider accept AI-generated adult content; terms, privacy, retention.

**Re-verify against the real services** (all written from public docs):

- **CCBill:** pass-through spelling, reversal transaction id, the webhook query string, date formats, the 30-day pack period.
- **Segpay:** the postback template and its values; GET or POST (the route accepts POST only); price point ids; `transtime` and `trantype` spellings.
- **Yoti:** session and result fields, the hosted URL, the RSA-PSS notification signature. Yoti's sandbox was not integrated.
- **PhotoDNA:** request shape, 4 MB and 2048 px limits, 5 requests a second, success code 3000 (from memory).
- **Replicate:** live calls and output download.
- **S3:** a real private bucket, streamed through `/api/media`.
- **Web Push:** delivery, iOS Home Screen push, installs on real devices.
- **Docker and CI:** `docker build`, `compose up`, a GitHub run.

## 11 External dependencies

**Runtime npm packages:**

- `next` 15.5.27, `react` and `react-dom` 19.2.0: App Router, standalone server.
- `drizzle-orm` 0.45.4, `postgres` 3.4.9: database access and migrations.
- `bullmq` 5.81.5, `ioredis` 5.11.1: queue and rate limits.
- `sharp` 0.35.5: re-encoding, posters, demo stills.
- `@aws-sdk/client-s3` 3.1150.0: the S3 driver (`s3-request-presigner` is listed, unused since R13).
- `web-push` 3.6.7: encrypted, VAPID-signed push.
- `stripe` 18.5.0: the Stripe adapter (off).
- `zod` 3.25.76, `bcryptjs` 3.0.3: validation, password hashing.
- `@fontsource-variable/*` 5.3.0, `lucide-react` 1.55.0, `clsx` 2.1.1: self-hosted fonts, icons, class names.

**Development dependencies:** `typescript`, `tsx` (the worker needs it at run time), `vitest`, `@playwright/test`, `drizzle-kit`, `eslint`, `tailwindcss` 4.

**System dependencies:** ffmpeg, Postgres 16, Redis 7, Chromium (tests) and the §7 images.

**External services:**

- Unverified: **CCBill** (`api.ccbill.com` FlexForms, inbound webhooks), **Segpay** (`secure2.segpay.com`, inbound postbacks), **Yoti** (`age.yoti.com`), **PhotoDNA** (issued Match URL), **Replicate** (`api.replicate.com/v1`).
- **Stripe** is off. The **Cloudflare CSAM tool** is dashboard only, not exercised.
- **Web Push**: FCM, Mozilla, Apple and Windows push hosts, the only ones accepted. Delivery unverified.
- **S3 storage**: AWS S3, R2 or MinIO. Unverified.
- **Error monitor**: whatever sits behind `ERROR_WEBHOOK_URL`. Tested with a local listener only.
- **NCMEC, IWF**: manual reports, no integration.
- **GitHub Actions, Docker Hub, npm**: CI (never run), images, packages.
