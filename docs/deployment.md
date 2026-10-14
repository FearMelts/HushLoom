# Hushloom Deployment and Configuration

Deliverable F. This document covers how to configure, run, test and deploy Hushloom from commit `c52f843`, where all seven build tracks are merged. Everything described here exists in that code unless it is marked **planned** or **not built**. **Unverified** means the code was written from a provider's public documentation and never run against the real service. This document contains no credentials.

| Area | State in this build | Goes live with |
| --- | --- | --- |
| Web app, worker, database, queue, credits, local storage | Operational, covered by tests | Hosting (§9) |
| AI generation | **Labeled demo** placeholders. The Replicate adapter is unverified. | An AI provider that permits adult content |
| Payments | **Labeled sandbox** that never charges. CCBill and Segpay are unverified. Stripe is off. | CCBill or Segpay |
| Age verification | **Labeled sandbox** that proves nothing. Yoti is unverified. | Yoti |
| Abuse scanning | **Labeled dev scanner** that matches only test hashes. PhotoDNA is unverified. | PhotoDNA approval |
| Push | Off until VAPID keys are set. Delivery is unverified. | VAPID keys |
| S3 storage, Docker, CI | Written. S3 never met a real bucket, Docker ran only `docker compose config`, CI never ran. | A bucket, a Docker host, GitHub Actions |

## 1 Requirements

| Need | Version | Notes |
| --- | --- | --- |
| Node.js and npm | 22 | `package.json` allows 20.18 or later. The images and CI use 22. |
| PostgreSQL | 16 | Local tests need a role that can create databases. |
| Redis | 7 | Queue and rate limits. Turn on append-only persistence and set `maxmemory-policy noeviction`, or BullMQ can lose jobs. |
| ffmpeg | Any build on the `PATH` | Both processes: demo clips, posters, upload metadata stripping, keyframe scans. Without it, video uploads get 503 `video_processing_unavailable`. |
| Storage | Local disk or an S3-compatible bucket | Local disk must sit at one absolute path that both processes reach. A bucket must be private. |
| Chromium | `npx playwright install chromium` | e2e only. |
| Docker Compose | 2.24 or later | Optional (§7). |

A deployment runs the web server and the worker, plus a one-shot migration. Alpine is untried.

## 2 Environment variables

`src/server/env.ts` is the source of truth: 62 variables, their defaults, and the startup checks. `.env.example` lists all of them as commented lines, plus 13 variables used only by the seed, compose and the tests. `tests/unit/env-template.test.ts` fails if the two drift apart.

`npm run dev`, `npm start` and compose read `.env`. The worker, migrations and tsx scripts do not, so export it first with `set -a; . ./.env; set +a`. An empty value is not the same as unset, so leave unused lines commented out.

### The APP_ENV rule

`NODE_ENV` says how the code was built. `APP_ENV` says what kind of site it is. A site is **live** when `APP_ENV=production`, or when `APP_ENV` is unset on a production build (`isLiveDeployment()`).

On a live site:

- The app refuses to start with `SCAN_PROVIDER=dev` while `SCAN_FAIL_CLOSED=true`, or with `AGE_VERIFICATION_PROVIDER=sandbox` while `AGE_VERIFICATION_ENFORCE=true`. When that happens, the worker exits 1 and the web app answers every request with an error, including its health check.
- The payment sandbox is disabled: checkout answers 503 `payments_unavailable`.

**Rule:** leave `APP_ENV` unset, or set it to `production`, on any site the public can reach. Use `staging` only for a private preview, because it lets the sandboxes run. `test` is for e2e.

`AGE_VERIFICATION_ENFORCE=false`, or `SCAN_PROVIDER=cloudflare` with `SCAN_FAIL_CLOSED=false`, also lets a live site start without a real provider. Neither belongs on a public site without legal sign-off. The demo AI provider is not covered by the rule: it keeps running, labeled, until `ENABLE_DEMO_PROVIDER=false`.

### Secrets

- **Storage.** Never commit secrets. `.gitignore` excludes `.env`, and `.dockerignore` keeps `.env*` out of images. Keep real values in the host's secret store.
- **Random values.** Generate `MEDIA_SIGNING_SECRET`, `CCBILL_WEBHOOK_TOKEN`, `SEGPAY_POSTBACK_SECRET`, `AGE_VERIFICATION_WEBHOOK_SECRET` and `SEED_PASSWORD` with `openssl rand -hex 32`. Generate `POSTGRES_PASSWORD` with `openssl rand -hex 24`.
- **VAPID keys.** Generate one pair per deployment with `npx web-push generate-vapid-keys`. Rotating the pair drops every push subscription.
- **Issued by providers:** the CCBill salt, Segpay ids, Yoti key and SDK id, PhotoDNA key and endpoint, Replicate token and S3 keys.

**Core**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` | Set by tooling | no | `next build` and the images set `production`. |
| `APP_ENV` | unset | See the rule | no | `development`, `test`, `staging` or `production`. |
| `APP_URL` | `http://localhost:3000` | Production: the public https origin | no | Allowed origin for API writes. Base for checkout and Yoti return links. |
| `DATABASE_URL` | `postgres://playbox@localhost:5432/playbox` | Beyond local development | yes | Postgres connection string. |
| `REDIS_URL` | `redis://localhost:6379` | Beyond local development | if it holds a password | Queue and rate limits. |
| `SESSION_TTL_DAYS` | `30` | optional | no | How long a sign-in lasts. |
| `MEDIA_SIGNING_SECRET` | dev fallback | `NODE_ENV=production`, 32+ characters | yes | Signs private media links. Production will not start without it. |
| `MEDIA_URL_TTL_S` | `300` | optional | no | Private link lifetime. Public media links last 3600 s. |

**Storage**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `STORAGE_DRIVER` | `local` | optional | no | `local` or `s3`. Both are served by `/api/media`, which re-checks every asset on each request; the bucket is never linked to. |
| `STORAGE_LOCAL_DIR` | `.storage` | Absolute in production | no | The same path for the web app and the worker. |
| `S3_BUCKET` | unset | `STORAGE_DRIVER=s3` | no | A private bucket. |
| `S3_REGION` | unset (`auto`) | optional | no | `auto` suits R2. |
| `S3_ENDPOINT` | unset | Non-AWS services | no | Only the web and worker processes reach it; browsers never do. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset | S3, unless the SDK's default credential chain applies | yes | Bucket keys. |

**AI generation and worker**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `ENABLE_DEMO_PROVIDER` | `true` | optional | no | Turns on the labeled demo models. Set it to `false` once a real provider is live. |
| `REPLICATE_API_TOKEN` | unset | Replicate | yes | Turns on `replicate-flux-schnell` (unverified). |
| `REPLICATE_WEBHOOK_SECRET` | unset | optional | yes | Verifies `/api/webhooks/replicate`. The adapter polls, so this route only logs. |
| `PROVIDER_TIMEOUT_S` | `600` | optional | no | Provider call timeout. Stuck jobs are reconciled 2 minutes after it. |
| `WORKER_CONCURRENCY` | `2` | optional | no | Jobs per worker process. |
| `WORKER_HEALTH_PORT` | unset (image: 3901) | For probes | no | Port for the worker's `GET /health`. |
| `USER_MAX_ACTIVE_JOBS` | `3` | optional | no | Active jobs per user. A plan's higher limit wins. |
| `SIGNUP_GRANT_CREDITS` | `0` | optional | no | Credits given to each new account. |

**Age gate and geolocation**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `AGE_ASSURANCE_STRICT_REGIONS` | empty | optional | no | Extra codes added to the verification list. |
| `GEO_COUNTRY_HEADER` | `x-country-code` | Match your edge | no | Country header, trusted as received. |
| `GEO_REGION_HEADER` | `x-region-code` | Match your edge | no | US state header (`TX` becomes `US-TX`), trusted as received. |

**Payments** (addendum §1)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `PAYMENT_PROVIDER` | `sandbox` | Live: `ccbill` or `segpay` | no | Picks `sandbox`, `ccbill`, `segpay` or `stripe`. |
| `CCBILL_ACCOUNT`, `CCBILL_SUBACCOUNT`, `CCBILL_FLEXFORM_ID` | unset | ccbill | no | Account, subaccount and checkout form. |
| `CCBILL_SALT` | unset | ccbill | yes | Signs checkout links and verifies sale digests. |
| `CCBILL_WEBHOOK_TOKEN` | unset | ccbill, in practice | yes | 16+ characters, sent as `?token=`. Without it, renewals, refunds and chargebacks are rejected. |
| `CCBILL_DATALINK_USER`, `CCBILL_DATALINK_PASSWORD` | unset | Not used | password: yes | Declared, but never called. |
| `SEGPAY_PACKAGE_ID`, `SEGPAY_PRICE_POINT_ID` | unset | segpay | no | Package, plus one price point or a map such as `pack_small=ID,plan_member=ID`. |
| `SEGPAY_POSTBACK_SECRET` | unset | segpay | yes | Every postback must present it, as `key=` or by Basic auth. |
| `SEGPAY_USER_ACCESS_KEY` | unset | optional | yes | Also accepted as the Basic-auth password. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | stripe only | yes | Keep Stripe off. It bans adult content. |

**Age verification** (addendum §2)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `AGE_VERIFICATION_PROVIDER` | `sandbox` | Live and enforcing: `yoti` | no | Picks `sandbox` or `yoti`. |
| `AGE_VERIFICATION_ENFORCE` | `true` | Keep `true` | no | In covered places, blocks creating, uploading and previews until the user is verified. |
| `AGE_VERIFICATION_REGIONS` | GB plus 25 US states | To override | no | Codes such as `GB,US-TX`. A bare `US` covers every state (`src/config/jurisdictions.ts`). |
| `AGE_VERIFICATION_FAIL_CLOSED` | `false` | Your decision | no | When no geo header arrives, `true` blocks creation. |
| `AGE_VERIFICATION_API_KEY` | unset | yoti | yes | Yoti API key. |
| `AGE_VERIFICATION_SDK_ID` | unset | yoti | no | Yoti SDK id. |
| `AGE_VERIFICATION_API_URL` | `https://age.yoti.com` | optional | no | Yoti base URL. |
| `AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY` | unset | yoti | no | PEM key. Without it, notifications are rejected. |
| `AGE_VERIFICATION_WEBHOOK_SECRET` | dev fallback | sandbox only | yes | Signs sandbox callbacks. |
| `AGE_VERIFICATION_VALID_DAYS` | `365` | optional | no | How long a verification stays valid. Changing it changes existing expiry dates. |

**Abuse scanning** (addendum §3, `docs/abuse-response.md`)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `SCAN_PROVIDER` | `dev` | Live: `photodna` | no | Picks `dev`, `photodna` or `cloudflare`. |
| `SCAN_FAIL_CLOSED` | `true` | Keep `true` | no | Unchecked content is never kept: uploads get 503, outputs retry and then refund. |
| `PHOTODNA_API_KEY` | unset | photodna | yes | Issued after Microsoft's approval. |
| `PHOTODNA_ENDPOINT` | unset | photodna | no | The Match URL as issued. There is no default. |
| `CLOUDFLARE_SCAN_WEBHOOK_SECRET` | unset | Not used | yes | Cloudflare notifies by email only. |
| `SCAN_TIMEOUT_S` | `30` | optional | no | Seconds before a scan counts as unavailable. |
| `SCAN_DEV_MATCH_HASHES`, `SCAN_DEV_SIMULATE_OUTAGE` | empty, `false` | dev only | no | Test hashes and outage drills. |

**Push and observability** (addendum §4)

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `VAPID_PUBLIC_KEY` | unset | Push | no | Browsers subscribe with it. |
| `VAPID_PRIVATE_KEY` | unset | Push | yes | Signs push requests. |
| `VAPID_SUBJECT` | unset | Push | no | A `mailto:` or `https:` contact (not localhost). Push stays off until all three are set. |
| `ERROR_WEBHOOK_URL` | unset | optional | if it holds a token | Receives each error as JSON, without bodies, query strings, prompts or media. 3 s timeout, 30 a minute per process. |

**Seed and compose only**

| Variable | Default | Required when | Secret | What it does |
| --- | --- | --- | --- | --- |
| `SEED_PASSWORD` | random, printed once | Compose seed | yes | Password for every seeded account. |
| `POSTGRES_PASSWORD` | none | Compose | yes | Password for the bundled Postgres. |
| `POSTGRES_USER`, `POSTGRES_DB` | `hushloom` | optional | no | Bundled user and database. |
| `WEB_PORT` | `3000` | optional | no | Host port for the web container. |
| `MINIO_IMAGE` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | optional | no | Image for the `s3` profile (§7). |

**Test variables** (none secret):

- vitest: `TEST_DATABASE_URL` (default `.../playbox_test`, tables emptied) and `TEST_REDIS_URL` (db 1).
- Playwright: `E2E_PORT` (3100), `E2E_DATABASE_URL` (`.../playbox_e2e`, recreated each run, name must end in `_e2e`), `E2E_REDIS_URL` (db 2, flushed), `E2E_MEDIA_SIGNING_SECRET` (random per run).
- `LOG_TESTS` prints info lines during vitest.

The web image sets `PORT`, `HOSTNAME=0.0.0.0` and `NEXT_TELEMETRY_DISABLED`. Compose fixes `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `STORAGE_LOCAL_DIR`, `APP_URL` and `MEDIA_SIGNING_SECRET` over `.env`. The local name `playbox` is a leftover internal name.

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

The defaults run the sandbox payments, the sandbox age check, the dev scanner and the demo models, each labeled in the interface.

**Seeded data.** The seed skips a database that already has templates, and stops if its media does not scan clean. It creates 9 categories, 24 sample templates on demo models, `admin@hushloom.local` (admin), `demo@hushloom.local` (member, 200 credits), and five creators: `lunavelour`, `atelier_noir`, `mx_ember`, `softfocus` and `nightcartographer`, each `@hushloom.local`. All share `SEED_PASSWORD`, or a random password printed once.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. The service worker does push only, with no caching. |
| `npm run worker` | `tsx src/worker/index.ts` |
| `npm run db:migrate` / `db:generate` / `db:seed` | Apply migrations / generate one from the schema / load sample data |
| `npx tsx scripts/scan-backfill.ts [--include-unavailable]` | Scans assets that have no verdict. Exits 1 if any are left. |
| `npx tsx scripts/s3-bucket.ts` | Creates the bucket if it is missing |
| `npx tsx scripts/make-icons.ts` | Re-renders the icons from `public/icons/mark.svg` |

## 4 Migrations

`npm run db:migrate` runs Drizzle's migrator over `drizzle/` (`scripts/migrate.ts`). Applied migrations are recorded in the database, so a re-run applies only new ones. The script reads `DATABASE_URL` from the environment only.

There are no down migrations. Back up first, and migrate before you start new web or worker code. Compose's one-shot `migrate` service does this for you.

| Migration | What it does |
| --- | --- |
| `0000_init` | Creates 12 enum types and 33 tables: users, sessions, consents, the ledger, jobs and outputs, media assets, templates, projects, presets, reports, audit logs, payment events, subscriptions and model configs. |
| `0001_output_posters` | Adds `generation_outputs.poster_asset_id`. |
| `0002_launch_readiness` | Adds `account_flags`, `age_verifications`, `push_subscriptions` and `takedown_requests`. Adds scan columns and `legal_hold` to `media_assets`, age-verification columns to `users`, refund, chargeback, hold and escalate enum values, and processor fields. **Existing media becomes `pending` and is not served until `npx tsx scripts/scan-backfill.ts` runs.** |
| `0003_integrity_fks_and_dob` | Makes `users.date_of_birth` nullable and erases it for deleted accounts. Clears dangling references and adds five `ON DELETE SET NULL` foreign keys. These changes cannot be undone. |

To change the schema, edit `src/server/db/schema.ts`, run `npm run db:generate`, review the SQL, and commit it with its `meta` snapshot.

**Legal hold and data rules**

- **Legal hold.** Never delete, purge or overwrite a held `media_assets` row (`legal_hold = true`) or its file. That includes manual cleanups and bucket lifecycle rules. Only "Clear as false positive" on `/admin/review` lifts a hold. When evidence may be released after a report is for counsel (`docs/abuse-response.md` §4, §6).
- **No hard deletes of users.** In-app deletion is a soft delete that erases the email and date of birth. Deleting a `users` row by hand would cascade to consent records, account flags, age-verification records and the ledger, and would detach held evidence.
- **Retention.** The worker purges files soft-deleted more than 30 days ago, every hour, skipping held assets. Consent withdrawal and NCII or likeness takedowns purge files immediately. Verification and consent records stay with the account.
- **Backups.** Back up the database and media together. Whether a restore may bring back data users deleted since is for legal review.
- **No test or seed scripts on real data.** The seed has no live-site guard outside compose. vitest empties its tables, and `e2e-prepare` drops any `_e2e` schema.

## 5 Testing commands

| Command | Runs | Needs |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | nothing else |
| `npm run lint` | `next lint --max-warnings 0` | nothing else |
| `npm test` | vitest: 14 unit and 9 integration files | Postgres (`createdb -O playbox playbox_test` once), Redis, ffmpeg |
| `npm run test:e2e` | Playwright on the standalone server | the above, Chromium, ports 3100 and 3901 |
| `npm run verify` | typecheck, lint, test, build, test:e2e | all of it |

vitest migrates `TEST_DATABASE_URL` first (`tests/global-setup.ts`) and runs files one at a time.

What `test:e2e` builds:

1. `scripts/e2e-prepare.ts` resets the `_e2e` database, Redis db and `.storage-e2e/`, migrates, seeds, and runs the scan backfill (any asset without a verdict fails the run).
2. `next build`, then copies `.next/static` and `public/` into the standalone folder.
3. Starts `node .next/standalone/server.js` with `NODE_ENV=production` and `APP_ENV=test`.
4. Starts the worker once `/api/health` answers.

`tests/e2e/journey.spec.ts` has 8 tests: sign-up to a demo creation, cross-user isolation, under-18 refusal, a blocked prompt, layout at three widths, and keyboard reachability. A longer launch journey is **planned**.

**Last recorded results** (`notes/progress.md`):

- typecheck and lint clean, vitest 258/258 at the infra merge `a432052`. `c52f843` changes only notes.
- e2e 8/8 at `0686f87`, before the fix tracks and infra merged. It has not been re-run on the merged head.

## 6 Production build and run

```sh
npm ci && npm run build
cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public
npm run db:migrate
PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js
node --import tsx src/worker/index.ts      # from the full checkout
```

- **Copy the static files.** The standalone output contains neither `.next/static` nor `public/`. Without them, styles, scripts, icons, the manifest and `sw.js` return 404.
- **Use `server.js`.** `npm start` runs `next start`, which warns that it does not work with standalone output.
- **No database at build time.** Every page is dynamic, so the build needs no database or secrets. Builds so far have always had one present.
- **Configuration.** Pass variables through the process environment. The web process needs ffmpeg. Local storage needs an absolute `STORAGE_LOCAL_DIR` shared with the worker.
- **Worker.** It runs from source with tsx, so it needs a full install. It exits 1 on invalid configuration. Otherwise it reconciles stuck jobs and expires drafts older than 24 hours (at start, then every 60 s), purges expired media hourly, and serves `GET /health` when `WORKER_HEALTH_PORT` is set. On SIGTERM it closes BullMQ, Redis and Postgres, then exits 0.
- **Health.** The web app's `GET /api/health` answers 200 with `database` and `redis` both `ok`, otherwise 503. The worker's `/health` answers 200 while its consumer runs.
- **Existing databases.** Run the scan backfill once after migration 0002.
- **Scaling.** `WORKER_CONCURRENCY` raises parallelism. Multiple instances are untested and, with local storage, need a shared disk.

## 7 Docker and compose

| Image | Contents |
| --- | --- |
| `Dockerfile` (web) | Builds, copies the static files, and runs `node server.js` as `node` on `node:22-bookworm-slim` with ffmpeg. Healthcheck: `/api/health`. |
| `Dockerfile.worker` | Same base, ffmpeg, full `npm ci`. Runs the worker as PID 1 (healthcheck on 3901), plus migrate, seed and s3-init. |

| Service | Role | Profile |
| --- | --- | --- |
| `postgres` | `postgres:16`, volume `pgdata`. Requires `POSTGRES_PASSWORD`. | default |
| `redis` | `redis:7`, append-only, `noeviction`, volume `redisdata` | default |
| `migrate` | One-shot migrations once Postgres is healthy | default |
| `web` | Port `${WEB_PORT:-3000}` on all interfaces. Waits for `migrate` and Redis. | default |
| `worker` | Same dependencies as `web` | default |
| `seed` | Refuses unless `SEED_PASSWORD` is set and `APP_ENV` is set and not `production` | `seed` |
| `minio` | On `127.0.0.1:9000` and `:9001`, volume `miniodata`. Its root login is the app's S3 keys. | `s3` |
| `s3-init` | Creates the private bucket before web and worker start | `s3` |

App containers read `.env`, run with `init: true`, and share the `storage` volume at `/data/storage`. Postgres and Redis publish no ports. A local trial without provider accounts needs `APP_ENV=staging`. Run the stack with:

```sh
docker compose up -d --build
docker compose --profile seed run --rm seed     # private previews only
docker compose --profile s3 up -d --build
```

**Validated:** only `docker compose config` (all three profiles, including the intended errors when required secrets are missing) and registry checks that the image tags exist. **Not validated:** `docker build`, because no Docker daemon was available, and `docker compose up` with its healthchecks, volume ownership and profiles. The worker and health endpoints ran outside Docker only.

**MinIO caveat.** MinIO's official images left Docker Hub: `minio/minio` and `minio/mc` returned 401 on 2026-10-14. The `s3` profile therefore defaults to `pgsty/minio`, a community build by Pigsty at a pinned tag. That third-party image is a supply-chain choice for the owner. It has never been pulled or run. Override it with `MINIO_IMAGE`.

Browsers never fetch from MinIO: media is served through the app's `/api/media`. In production, use a managed private bucket (AWS S3 or R2).

## 8 CI

`.github/workflows/ci.yml` runs on pushes and pull requests for every branch except `main`, so a pull request into `main` gets no CI. It has read-only permissions.

| Job | Steps |
| --- | --- |
| `checks` | Postgres 16 and Redis 7 services, Node 22, ffmpeg, `npm ci`, typecheck, lint, vitest, build |
| `e2e` | The same services, plus Chromium, then `npm run test:e2e`. Uploads the report on failure, kept 14 days. |

It has **never run on GitHub**. The action versions (`@v4`) were not checked, and the e2e job builds a second time.

## 9 Hosting and edge requirements

**Platform constraints**

- **Payments.** Stripe bans adult content, AI-generated included (https://stripe.com/legal/restricted-businesses). Use CCBill or Segpay.
- **Mobile.** Apple (guideline 1.1.4, https://developer.apple.com/app-store/review/guidelines/) and Google Play (https://support.google.com/googleplay/android-developer/answer/9878810) ban sexually explicit apps. Mobile is the installable web app, offered from Settings only.
- **Host policy.** Vercel's acceptable-use policy is unclear for adult content, so check it before deploying there. No host's or CDN's policy has been checked.
- **Process model.** The app needs a long-running worker with ffmpeg, a persistent Redis, Postgres, and a shared disk or bucket. Serverless platforms could at most run the web part with S3, and none has been tried.

**TLS and the reverse proxy.** No proxy is bundled. Terminate TLS at Caddy, nginx or a CDN. HTTPS is required, because:

- session cookies are `Secure` in production
- service workers and push need a secure context
- Yoti notifications are only requested for an https `APP_URL`

The proxy must:

- match `APP_URL` exactly, or browser API writes get 403 `bad_origin` (`src/middleware.ts`)
- set `X-Forwarded-For` to the client address and drop client copies, because rate limits on sign-up, sign-in and signed-out takedowns key on it
- allow request bodies of at least 100 MB on `POST /api/uploads`
- pass `Range` headers to `/api/media`
- keep webhook query strings (`?token=`, `key=`) and let the processors reach `/api/webhooks/payments/ccbill`, `/api/webhooks/payments/segpay` and `/api/webhooks/age-verification/yoti`
- add HSTS, which the app does not set (the app does set `X-Frame-Options`, `nosniff`, a referrer and permissions policy, and `X-Robots-Tag: noindex`)

**Geo headers.** Age rules depend on `GEO_COUNTRY_HEADER` and `GEO_REGION_HEADER`, and the app trusts them as received. The edge must strip any client-sent copy and set its own. Behind Cloudflare, `cf-ipcountry` can serve as the country header. Without these headers every visitor is "unknown", and `AGE_VERIFICATION_FAIL_CLOSED` decides what happens.

**Cache-Control.** Never cache HTML or `/api/*` at the edge. `/api/media` sends `private, max-age=<seconds until expiry>`, so Cloudflare's CSAM tool would scan nothing as shipped. `sw.js` sends `no-cache` and `Service-Worker-Allowed: /`; do not cache or rewrite it. `/_next/static/*` is content-hashed and safe to cache.

**Service worker scope.** `/sw.js` registers with scope `/`, and the manifest's `start_url` and `scope` are `/`, so serve the app at the root of its origin. The worker caches only the app shell: the manifest, icons, `/offline` and `/_next/static` files. It never touches `/api/*` or signed-in pages. Bump `VERSION` in `sw.js` to ship an update.

## 10 Going live checklist

**Accounts to open**

| Account | Variables and setup |
| --- | --- |
| **CCBill** or **Segpay** | CCBill: `PAYMENT_PROVIDER=ccbill`, the `CCBILL_*` ids, salt and token. Webhook: `https://<host>/api/webhooks/payments/ccbill?token=<token>`. Segpay: `PAYMENT_PROVIDER=segpay`, package, price points and postback secret. Postback: `.../api/webhooks/payments/segpay?key=<secret>`, with `hluser`, `hlitem` and `hlsig` echoed. Replace the placeholder prices in `src/config/pricing.ts`. |
| **Yoti**, for UK "highly effective age assurance" (Ofcom, https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance) and US state laws (https://www.freespeechcoalition.com/faq) | `AGE_VERIFICATION_PROVIDER=yoti`, plus the API key, SDK id and notification public key. Register `/api/webhooks/age-verification/yoti` and allow `/api/age-verification/return`. |
| **PhotoDNA** (free after approval) | `SCAN_PROVIDER=photodna`, `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT`, with fail-closed kept on. |
| **Cloudflare CSAM tool** (optional, free, https://blog.cloudflare.com/the-csam-scanning-tool/) | Dashboard only. It is a second layer, never a replacement. |
| **NCMEC CyberTipline**, IWF or an INHOPE hotline | Manual reporting of confirmed matches. |
| **An AI provider that permits adult content** | `REPLICATE_API_TOKEN`, then `ENABLE_DEMO_PROVIDER=false`. Per the addendum, fal.ai forbids explicit output unless it authorizes the account, and Replicate's terms are ambiguous, though callers can disable its safety checker. The adapter does not set that flag and supports only text-to-image. Other providers need a new adapter (**not built**). |
| **VAPID keys** (self-generated) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| **An error monitor** such as Sentry | `ERROR_WEBHOOK_URL`, through a relay that converts the events (there is no SDK). |
| **Hosting** | A container host, Postgres 16, persistent Redis 7, a private bucket, a TLS edge that sets the geo headers, and backups. |

**Configuration**

- `APP_ENV` unset, an https `APP_URL`, a generated `MEDIA_SIGNING_SECRET`, and S3 or a shared absolute `STORAGE_LOCAL_DIR`.
- `AGE_VERIFICATION_REGIONS` re-checked and `AGE_VERIFICATION_FAIL_CLOSED` decided.
- Migrations applied and the backfill run. No seed.
- Alerts on the `scan.unavailable` and `scan.matched` log lines, and named reviewers working `/admin/review` daily.

**Legal review**

- `docs/abuse-response.md` §4 and §6: reporting duties, the preservation period, original upload bytes, NCII timelines.
- The region list. The addendum cites 27 states with laws, but the default list holds 25, compiled on 2026-10-12. It is configuration, not legal advice.
- Yoti's age-estimation threshold of 25 and its privacy terms.
- Every public template counts as explicit.
- Whether the processor, host and AI provider accept AI-generated adult content, plus the terms, privacy policy and retention.

**Re-verify against the real services** (all written from public docs):

| Service | Confirm |
| --- | --- |
| CCBill | Pass-through spelling, the refund and chargeback transaction id, the webhook query string, date formats, the 30-day pack period |
| Segpay | The postback template with the extra values, and GET or POST (the route accepts POST only), price point ids, field spellings |
| Yoti | Session and result fields, the hosted URL, the RSA-PSS notification signature. Yoti's sandbox was not integrated. |
| PhotoDNA | Request shape, 4 MB and 2048 px limits, 5 requests a second, the success code 3000 (from memory) |
| Replicate, S3 | Live calls, output download, presigned links |
| Web Push | Delivery, iOS Home Screen push, installs on real devices |
| Docker, CI | `docker build`, `compose up`, a GitHub run |

## 11 External dependencies

| npm package | Version | Used for |
| --- | --- | --- |
| `next`, `react`, `react-dom` | 15.5.27, 19.2.0 | App Router, standalone server |
| `drizzle-orm`, `postgres` | 0.45.4, 3.4.9 | Database access and migrations |
| `bullmq`, `ioredis` | 5.81.5, 5.11.1 | Queue and rate limits |
| `sharp` | 0.35.5 | Re-encoding, posters, demo stills |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | 3.1150.0 | S3 driver |
| `web-push` | 3.6.7 | Encrypted, VAPID-signed push |
| `stripe` | 18.5.0 | Stripe adapter (off) |
| `zod`, `bcryptjs` | 3.25.76, 3.0.3 | Validation, password hashing |
| `@fontsource-variable/*` | 5.3.0 | Self-hosted Fraunces, Manrope, JetBrains Mono |
| `lucide-react`, `clsx` | 1.55.0, 2.1.1 | Icons, class names |

**Development dependencies:** `typescript` 5.9.3, `tsx` 4.23.15 (the worker also needs it at run time), `vitest` 3.2.7, `@playwright/test` 1.56.1, `drizzle-kit` 0.31.11, `eslint` 9.39.1, `tailwindcss` 4.3.3 (`postcss` pinned to 8.5.29).

**System dependencies:** ffmpeg, Postgres 16, Redis 7, Chromium (tests), and the images `node:22-bookworm-slim`, `postgres:16`, `redis:7` and `pgsty/minio`.

| Service | Endpoint | State |
| --- | --- | --- |
| CCBill | `api.ccbill.com` FlexForms, inbound webhooks | Unverified |
| Segpay | `secure2.segpay.com`, inbound postbacks | Unverified |
| Stripe | Stripe API | Off |
| Yoti | `age.yoti.com` | Unverified |
| PhotoDNA | Issued Match URL | Unverified |
| Cloudflare CSAM tool | Dashboard | Not exercised |
| Replicate | `api.replicate.com/v1` | Unverified |
| Web Push | FCM, Mozilla, Apple, Windows push hosts (the only ones accepted) | Delivery unverified |
| S3 storage | AWS S3, R2, MinIO | Unverified |
| Error monitor | `ERROR_WEBHOOK_URL` | Tested with a local listener |
| NCMEC, IWF | Manual reports | No integration |
| GitHub Actions, Docker Hub, npm | CI, images, packages | CI never run |
