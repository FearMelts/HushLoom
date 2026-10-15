# Hushloom Engineering Documentation

This document describes the code at commit `09a436e` (2026-10-14). Every build track, the phase 2 launch journey, every phase 3 review fix and the phase 4 visual review fixes are merged in that commit. Later commits change only documents and notes. Every behavior described here exists in that snapshot, unless it is labeled **planned** or **not built**. File and route references are relative to the repository root. Hushloom is an adults-only web app for creating images and short videos. Playbox informed its structure and interaction patterns only. Nothing here describes Playbox's visuals.

## Status labels used in this document

| Label | Meaning |
|---|---|
| Operational | Built, runs in this snapshot, and is exercised by the test suites. |
| Demo | Built and runs, but produces placeholder output. AI generation is a labeled demo until a real provider key is set. |
| Sandbox / dev | Built and runs against an in-app stand-in that proves nothing. Payments, age verification and abuse scanning run this way until the owner opens provider accounts. |
| Needs keys | Built and switched off until configured. Push needs VAPID keys. |
| Unverified | Written from the provider's public documentation and tested only against local fakes. Never run against the real service. |
| Planned / not built | Not in the code. |

Unverified at `09a436e`: Replicate, CCBill, Segpay, Stripe, Yoti, PhotoDNA, the Cloudflare CSAM tool and the S3 storage driver. Both Docker images and the compose stack have never been built or run (no Docker daemon was available). The CI workflow has run on GitHub Actions (Deployment files, below).

## 1. System architecture

### Components

| Component | Technology | Role |
|---|---|---|
| Web app | Next.js 15 App Router (standalone output), React 19, strict TypeScript, Tailwind 4 | Pages, 56 API route files, the Origin check in `src/middleware.ts`, signed media serving at `/api/media`. |
| Worker | Separate Node process, `src/worker/index.ts` run with tsx | Runs generation jobs from the BullMQ queue, reconciles stuck jobs, purges deleted files, sends push notifications. |
| Postgres 16 | Drizzle ORM on postgres-js, pool max 10 | System of record: 38 tables, 16 enums. |
| Redis 7 | ioredis, BullMQ | The `generation` queue and fixed-window rate-limit counters (`rl:*` keys). BullMQ keeps its own connection with no retry cap. Rate limits and `/api/health` use a separate request client (one retry, 2 s command timeout), so a Redis outage answers quickly instead of hanging. |
| Storage | `local` driver (disk) or `s3` driver (S3-compatible) | Uploads, outputs, posters and public template copies. |
| Media tools | sharp, ffmpeg, ffprobe | Image re-encoding, demo video rendering, posters, video metadata stripping, frame sampling for scanning. |
| External adapters | One adapter interface per domain | AI generation, payments, age verification, abuse scanning, web push, error webhook. |

### Diagram

```text
                 Browser tab or installed web app
                 (manifest, service worker /sw.js)
                               |
                               |  HTTPS. A reverse proxy is expected to add
                               |  x-forwarded-for (TRUSTED_PROXY_HOPS says how
                               |  many proxies to believe) and set the geo
                               |  headers. No proxy is bundled.
                               v
+-------------------------------------------------------------------+
| Web app (Next.js standalone, port 3000)                           |
|   middleware: Origin check on /api writes (webhooks exempt)       |
|   pages, /api routes, /api/media signed file serving              |
+-------------------------------------------------------------------+
      |                     |                        |
      | Drizzle (pool 10)   | ioredis                | StorageDriver
      v                     v                        v
+-------------+   +---------------------+   +------------------------+
| Postgres 16 |   | Redis 7             |   | local disk  or  S3     |
| 38 tables   |   | BullMQ "generation" |   | uploads/  outputs/     |
|             |   | rate-limit keys     |   | templates/             |
+-------------+   +---------------------+   +------------------------+
      ^                     |                        ^
      |                     v                        |
+-------------------------------------------------------------------+
| Worker (src/worker/index.ts, optional health port)                |
|   BullMQ Worker, concurrency WORKER_CONCURRENCY (default 2)       |
|   reconcile at start and every 60 s, purge every hour             |
+-------------------------------------------------------------------+

External adapters (each declares whether it is a demo or sandbox):
  AI generation   demo | replicate                 (worker)
  Abuse scanning  dev | photodna | cloudflare      (web: uploads; worker: outputs)
  Payments        sandbox | ccbill | segpay | stripe  (web: checkout, webhooks)
  Age checks      sandbox | yoti                   (web: start, return, webhook)
  Web push        browser push services, VAPID     (web: subscribe; worker: send)
  Error webhook   ERROR_WEBHOOK_URL                (web and worker)
```

### Configuration

All configuration is read through `env()` in `src/server/env.ts`. It parses 63 variables with zod on its first call and caches the result. A deployment counts as **live** when `APP_ENV` (or, if `APP_ENV` is unset, `NODE_ENV`) equals `production` (`isLiveDeployment()`).

`env()` is lazy. It checks the rules below when it is first called, and it throws when one fails (`env.ts:130-155`). It never caches a failed result, so every later call throws the same error. Some rules are part of the zod schema and throw a `ZodError`; the others are checked after parsing and throw a plain `Error`. The schema runs first.

| Rule checked by `env()` | Fails when | Thrown as |
|---|---|---|
| `MEDIA_SIGNING_SECRET` required in production (`env.ts:133-135`) | `NODE_ENV=production` and the secret is missing. | `Error` |
| `MEDIA_SIGNING_SECRET` length (`env.ts:28`) | It is set but shorter than 32 characters, in any environment. | `ZodError` |
| Absolute local storage path | `NODE_ENV=production`, `STORAGE_DRIVER=local` and `STORAGE_LOCAL_DIR` is not absolute. | `Error` |
| S3 bucket | `STORAGE_DRIVER=s3` without `S3_BUCKET`. | `Error` |
| No dev scanner on a live site | Live site with `SCAN_PROVIDER=dev` and `SCAN_FAIL_CLOSED=true`. | `Error` |
| No sandbox age checks on a live site | Live site with `AGE_VERIFICATION_PROVIDER=sandbox` and `AGE_VERIFICATION_ENFORCE=true`. | `Error` |
| `TRUSTED_PROXY_HOPS` | Not a whole number of 0 or more. Default 0 (section 10). | `ZodError` |
| `CCBILL_WEBHOOK_TOKEN` length | It is set but shorter than 16 characters. | `ZodError` |
| Any other variable | Set to a value of the wrong type or outside its allowed values. Every variable has a default or is optional, so none fails by being missing. | `ZodError` |

What a failed check does depends on the process:

| Process | Effect of a failed check |
|---|---|
| Worker | Exits at load. It calls `env()` at module top level (`src/worker/index.ts:12`), before it installs the error webhook, so the error shows only in the worker's own output and exit code. |
| Web app | Boots anyway. Its `register()` in `src/instrumentation.ts` only installs the error webhook, and `installErrorWebhook` catches the failed check (`src/server/observability.ts:148-158`). Every request that reads the configuration then fails. In API routes wrapped in `route()` (all but `/api/health` and `/api/media`), a plain `Error` becomes 500 `internal` and is logged as `unhandled route error`. A `ZodError` becomes 422 `invalid_input` with the flattened field errors in `details`, which name the failing variables, and nothing is logged (`route()` in `src/server/http.ts`). A page, or `/api/media`, that reads the configuration fails through Next.js, whose `onRequestError` hook logs it. `/api/health` answers 503 with both checks `down`, because its database and Redis clients read the configuration, so the web image's `HEALTHCHECK` reports the container unhealthy. |

Outside production, `mediaSigningSecret()` falls back to a fixed development secret. The payments sandbox, age-verification sandbox and dev scanner each also refuse to work at runtime on a live site (sections 6 to 8). `ERROR_WEBHOOK_URL` is read on its own (`errorWebhookUrlAlone()`), so the web app's error webhook is installed even when the rest of the configuration fails its check. It then reports every failure that is logged at error level: `route()` routes failing with a plain `Error`, pages and `/api/media`. `route()` routes failing with a `ZodError` are not logged, so they do not reach it.

### Deployment files

| File | What it defines | Run status |
|---|---|---|
| `Dockerfile` | Web image: node 22 bookworm slim, standalone output, ffmpeg, non-root user, `/data/storage`, port 3000, `HEALTHCHECK` on `/api/health`. | implemented but not verified: never built. |
| `Dockerfile.worker` | Worker image: ffmpeg, full `npm ci`, `node --import tsx src/worker/index.ts`, health on port 3901. | implemented but not verified: never built. |
| `docker-compose.yml` | `postgres:16`, `redis:7` (append-only, `noeviction`), `migrate`, `web`, `worker`; `seed` under the `seed` profile; MinIO and a bucket-init job under the `s3` profile. Web is published on `${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}`, so only this machine reaches it unless `WEB_BIND` says otherwise. MinIO ports bind to 127.0.0.1. | implemented but not verified: `docker compose config` is valid; the stack never ran. |
| `.github/workflows/ci.yml` | A checks job (typecheck, lint, vitest, production build) and a Playwright job on the production build. It runs on pushes to any branch but `main` and on pull requests into any branch but `main`. A newer push cancels a run in progress on the same ref. Both check out with `persist-credentials: false`. | verified: run 16 at `574ccaf` (code as at `09a436e`) passed both jobs. One failure in 22 runs: run 9 at `ce84bff`, a `socket hang up` on an API request in `journey.spec.ts:90`, not reproduced on the same code (run 11) or later (`notes/evidence/github-ci.md`). |
| `.gitignore`, `.dockerignore` | Git ignores every `.env*` file except `.env.example`. The Docker build context excludes `**/.env` and `**/.env.*` at any depth. | verified by `tests/unit/deploy-config.test.ts`. |

### Web client

Every page except `/offline` renders inside one shell (`src/components/shell.tsx`, from `src/app/layout.tsx`): a top bar, a side rail from 1024 px up, a tab bar below that, the job tray for signed-in users, and toasts. Shared controls live in `src/components/ui.tsx`. The phase 4 visual review set these rules (section 16):

| Rule | How it is built |
|---|---|
| 40 px tap targets on phones | `Button` size `sm` is 32 px tall on wider screens and at least 40 x 40 below 640 px (`max-sm:h-10 max-sm:min-w-10`), so small icon-only buttons qualify too. The `Sheet` close button is `size-10`. `BackLink` (a page's "← Library" link) and `SectionLink` (a section heading's "See all") keep 13 px text on a 40 px target, with negative margins so the line does not grow. The toast action is a 40 px target the same way. |
| Room at the page bottom | `main` pads its bottom by 7rem, the safe-area inset, `--tray-h` and `--dock-h` (3rem plus `--tray-h` from 1024 px up). The job tray (`src/components/job-tray.tsx`) and the template page's docked Make bar (`src/components/template-detail.tsx`) publish their heights on `:root` with a `ResizeObserver`, so the last controls on a page can scroll clear of them. Toasts stack above both the same way. |
| Horizontal scrollers | `.edge-fade` (`src/app/globals.css`) fades the right edge of a scroller while more content waits past it. It is a scroll-driven animation (`animation-timeline: scroll(self inline)`): the fade goes at the end of the scroll and never shows on a row that fits. Browsers without scroll-driven animations show no fade. It is on the Library filter row, the scene timeline, the admin audit log, the payments and credit history tables, and the creator's template table. |
| Grids that shrink | The Studio and project workspace grids use `minmax(0, 1fr)` tracks, so a long unbroken prompt truncates instead of widening the page. |
| Hydration | The shell hands the page to React through `PageSlot`, a passthrough component that works around a React 19.2 hydration bug (section 14). |

## 2. Database schema

Source: `src/server/db/schema.ts`. Conventions: every `id` is a random UUID primary key; timestamps are `timestamptz`; `created_at` and `updated_at` default to `now()`. Users, media, jobs, outputs, projects, characters and templates are soft-deleted through `deleted_at`. No code path hard-deletes a user, a media asset, a generation job or a template. Rows deleted outright: sessions, push subscriptions, discovery events, folders, saved presets, project scenes, favorites, follows, and the upload row and consent record of an upload that could not be scanned.

### Enums (16)

| Enum | Values |
|---|---|
| `user_role` | member, creator, admin |
| `user_status` | active, suspended, deleted |
| `media_kind` | image, video |
| `visibility` | private, public |
| `template_status` | draft, published, unpublished, removed |
| `generation_mode` | text_to_image, image_to_image, text_to_video, image_to_video, video_to_video, video_extension, scene_continuation, reference_guided |
| `job_status` | draft, awaiting_confirmation, queued, processing, completed, failed, cancelled |
| `ledger_kind` | signup_grant, purchase, subscription_grant, reserve, release, settle, admin_adjust, refund, chargeback |
| `age_verification_status` | unverified, pending, verified, failed, expired |
| `scan_status` | pending, clean, matched, unavailable |
| `account_flag_kind` | chargeback, csam_match, manual_review, credit_debt |
| `takedown_status` | open, actioned, dismissed |
| `consent_kind` | terms, adult_attestation, upload_subject, likeness, training_data |
| `moderation_action` | report, auto_block, approve, remove, dismiss, hold, escalate |
| `moderation_status` | open, resolved |
| `upload_purpose` | source, reference, avatar, template_media |

Values that are declared but never written by code: job status `draft` (it is only the column default; jobs are inserted as `awaiting_confirmation`), age status `expired` (expiry is computed when read), consent kind `training_data`, and upload purposes `avatar` and `template_media`.

### Identity and consent

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `users` | Accounts | `email`, `password_hash`, `role`, `status`, `date_of_birth` (nullable since 0003), `age_assurance_method`, `age_assured_at`, `age_verification_status` (default unverified), `age_verified_at`, `age_verification_provider`, `jurisdiction`, `deleted_at` | Unique index on `lower(email)` |
| `user_profiles` | Public identity | PK `user_id` (cascade), `handle`, `display_name`, `bio`, `avatar_asset_id` | Unique index on `lower(handle)` (`user_profiles_handle_uq`); avatar FK set null (0003) |
| `sessions` | Sign-in sessions | `token_hash`, `expires_at`, `user_agent` | Unique `token_hash`; index on `user_id`; cascade on user |
| `creator_profiles` | Creator extras | PK `user_id`, `headline`, `share_analytics` | Cascade on user |
| `user_preferences` | Settings | `personalization_enabled`, `history_enabled`, `autoplay_previews`, `copilot_enabled`, `interests text[]`, `notify_on_finish` (default false) | PK `user_id` |
| `consent_records` | Every consent given | `kind`, `statement`, `subject_label`, `granted_at`, `withdrawn_at` | Index on (`user_id`, `kind`) |

### Media and uploads

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `media_assets` | Every stored file | `owner_id` (set null), `kind`, `storage_key`, `mime`, `bytes`, `width`, `height`, `duration_ms`, `sha256`, `visibility` (default private), `scan_status` (default pending), `scan_provider`, `scan_ref`, `scanned_at`, `legal_hold` (default false), `deleted_at` | Unique `storage_key`; indexes on `owner_id`, `scan_status` (`media_scan_idx`) and `sha256` (`media_sha256_idx`, 0004) |
| `uploads` | A user's uploaded file and the consent it was given under | `asset_id` (cascade), `purpose`, `consent_record_id` | Index on `user_id` |
| `character_references` | Likeness photos for reference-guided generation | `asset_id`, `consent_record_id` (both required), `deleted_at` | Index on `user_id` (`charrefs_user_idx`); asset and consent FKs with no delete action |

### Templates and social

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `template_categories` | Browse categories | `slug` | Unique `slug` |
| `templates` | Published recipes | `slug`, `creator_id`, `category_id`, `title`, `description`, `media_type`, `mode`, `tags[]`, `status` (default draft), `is_vip`, `quality` (default hd), `duration_s`, `poster_asset_id`, `preview_asset_id`, `current_version`, `remixed_from_id`, `favorite_count`, `generation_count`, `rating_sum`, `rating_count`, `published_at`, `deleted_at` | Unique `slug`; indexes on (`status`, `published_at`), `creator_id`, `category_id`; `remixed_from_id` self FK set null (0003) |
| `template_versions` | Prompt history per template | `version`, `prompt`, `negative_prompt`, `model_key`, `defaults jsonb`, `changelog` | Unique (`template_id`, `version`) |
| `template_ratings` | One rating per user per template | `score` | PK (`user_id`, `template_id`); check score between 1 and 5 |
| `favorites` | Saved templates and creations | `target_type` (`template` or `creation`), `target_id` | PK (`user_id`, `target_type`, `target_id`); index on target |
| `follows` | Creator follows | follower, creator | PK; check `no_self_follow`; index on creator |
| `template_collections`, `template_collection_items` | Creator collections (`is_public`, item `position`) | | Index on collection `creator_id` (`template_collections_creator_idx`); items PK (`collection_id`, `template_id`) |
| `discovery_events` | View and generate signals for For You | `event` (`view` or `generate`) | Index on (`user_id`, `created_at`) |

### Projects and generation

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `projects` | Multi-scene work | `user_id`, `title`, `description`, `deleted_at` | Index on `user_id` (`projects_user_idx`) |
| `project_scenes` | Ordered scenes | `position`, `continuity jsonb` (lighting, framing, palette, characterReferenceId, notes) | Index on (`project_id`, `position`) |
| `generation_jobs` | One generation request | `user_id`, `idempotency_key`, `status`, `mode`, `model_key`, `provider_key`, `is_demo`, `template_id`, `template_version` (the template's current version when the draft was made), `project_id`, `scene_id`, `parent_job_id`, `relation` (retry, variation, remix, continuation, extension), `prompt`, `negative_prompt`, `params jsonb`, `input_asset_ids uuid[]`, `character_reference_id`, `cost_credits`, `provider_job_id`, `attempts` (default 0), `max_attempts` (default 3), `cancel_requested`, `failure_code`, `failure_message`, `queued_at`, `started_at`, `finished_at`, `deleted_at` | Unique (`user_id`, `idempotency_key`); check `cost_credits >= 0`; indexes on (`user_id`, `created_at`), `status`, `scene_id`; template, project and scene FKs set null; `parent_job_id` self FK set null (0003) |
| `generation_outputs` | Files a job produced | `job_id`, `user_id`, `asset_id`, `poster_asset_id` (0001), `is_demo`, `quality_report`, `deleted_at` | Indexes on (`user_id`, `created_at`) (`outputs_user_idx`) and `job_id` (`outputs_job_idx`); cascade on job |
| `scene_versions` | Takes of a scene, with branches | `job_id`, `parent_version_id`, `branch_label` (default main), `is_selected` | Unique `job_id`; index on scene; parent self FK set null (0003) |
| `folders`, `folder_items` | Library folders | `name`; item points at an output | Folder index on `user_id`; items PK (`folder_id`, `output_id`) |
| `saved_presets` | Saved settings | `mode`, `model_key`, `params`, `prompt` | Index on `user_id` |
| `model_configs` | Admin overrides per model | PK `model_key`, `enabled`, `price_multiplier_pct` (default 100) | |

`params` holds `GenerationParams`: aspectRatio, durationS, quality, motionIntensity, cameraMovement, pacing, atmosphere, lighting, framing, seed.

### Money

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `credit_accounts` | Current balance | PK `user_id`, `available`, `reserved` | Checks `available >= 0` and `reserved >= 0` |
| `credit_ledger` | Every balance movement | `kind`, `available_delta`, `reserved_delta`, `available_after`, `reserved_after`, `job_id` (set null), `payment_event_id` (set null, 0003), `idempotency_key`, `note` | Unique `idempotency_key`; index on (`user_id`, `created_at`) |
| `subscriptions` | Passes | `plan_key`, `status` (text), `provider` (default stripe), `provider_customer_id`, `provider_subscription_id`, `current_period_end` | Unique `provider_subscription_id`; index on `user_id` (`subscriptions_user_idx`) |
| `payment_events` | Every accepted provider event | `provider`, `provider_event_id`, `type`, `user_id` (set null), `amount_cents`, `currency`, `credits`, `transaction_ref`, `metadata`, `processed_at` | Unique (`provider`, `provider_event_id`); index on (`provider`, `transaction_ref`) |

`subscriptions.status` is free text. The code writes `active`, `non_renewing` (rebilling stopped, still paid until the period end) and `canceled`. Stripe's own statuses (`trialing`, `past_due` and others) are stored as Stripe sends them.

`payment_events.metadata` carries the provider's raw fields plus these keys, which the code reads back:

| Key | Meaning |
|---|---|
| `pending` | `true` on a reversal or cancellation that arrived before the payment or pass it refers to. Set to `false` once applied. |
| `reason` | `needs_review` (held for an operator), `original_not_found` (a pending reversal), `applied_after_purchase` (a pending reversal applied later), `unknown_subscription` (a cancellation for a pass not seen yet), and a few `unknown_*` values for ignored items. |
| `review`, `itemKey` | The problem text and item of a held payment. |
| `subscriptionRef` | The processor's subscription or purchase id. Used to match reversals, renewals of held passes and pending cancellations. |
| `reversesEventId`, `creditsReversed`, `shortfall` | On a reversal: the credited event it reverses, what it took back and what it could not. |
| `pendingAmountCents`, `cumulative` | On a pending reversal: the amount to apply later and whether the amount is a running total (Stripe). |
| `currencyCode` | CCBill's numeric currency code as received. |

### Trust, safety and devices

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `moderation_events` | Reports, automatic blocks, scanner escalations and review actions | `subject_type` (template, prompt, upload, user, output), `subject_id` (text), `action`, `status`, `reporter_id`, `actor_id`, `reason`, `details` | Index on (`status`, `created_at`) |
| `audit_logs` | Who did what | `actor_id` (set null), `action`, `target_type`, `target_id`, `metadata` | Indexes on (`target_type`, `target_id`) and `created_at` |
| `age_verifications` | One row per verification attempt | `provider`, `status` (default pending), `provider_ref`, `method`, `jurisdiction`, `failure_reason`, `started_at`, `completed_at`, `expires_at` | Unique (`provider`, `provider_ref`); index on (`user_id`, `created_at`) (`age_verifications_user_idx`). No ID images or biometrics are stored. |
| `account_flags` | Holds on an account | `kind`, `reason`, `details`, `created_by`, `cleared_at`, `cleared_by` | Index on (`user_id`, `cleared_at`) |
| `takedown_requests` | Public removal requests | `requester_id`, `requester_email`, `target_type` (output, template, asset, url), `target_ref`, `category` (ncii, csam, likeness, copyright, other), `details`, `status`, `resolution_note`, `resolved_by`, `resolved_at` | Index on (`status`, `created_at`) |
| `taken_down_hashes` | SHA-256 of every file an actioned takedown removed, kept after the files are purged | PK `sha256` (text), `takedown_id`, `created_at` | `takedown_id` FK to `takedown_requests`, set null (0004) |
| `push_subscriptions` | One row per signed-in device that opted in | `user_id` (cascade), `session_id` (cascade), `endpoint`, `p256dh`, `auth`, `user_agent`, `last_used_at`, `failed_at` | Unique `endpoint`; index on `user_id` (`push_subscriptions_user_idx`) |

Foreign keys with no delete action (deletes of the target are refused): template creator, category, poster and preview; `uploads.consent_record_id`; character reference asset and consent; `generation_jobs.character_reference_id`; output asset and poster. Most of those targets are only ever soft-deleted. The exception is a consent record: when an upload cannot be scanned under fail-closed scanning, `discardUnscannedUpload` deletes the `uploads` row and then its consent record, in that order and in one transaction (`src/server/media.ts:205-206`). That runs inside the upload request, before a character reference can point at the record, so nothing still references it when it goes.

### Migration history

Migrations live in `drizzle/` and run with `npm run db:migrate` (`scripts/migrate.ts`, Drizzle migrator).

| Migration | Changes |
|---|---|
| `0000_init` | 12 enums, 33 tables, their indexes and foreign keys. |
| `0001_output_posters` | Adds `generation_outputs.poster_asset_id` with its FK. |
| `0002_launch_readiness` | New enums `account_flag_kind`, `age_verification_status`, `scan_status`, `takedown_status`. Adds `refund` and `chargeback` to `ledger_kind`, and `hold` and `escalate` to `moderation_action`. New tables `account_flags`, `age_verifications`, `push_subscriptions`, `takedown_requests`. Adds scan columns and `legal_hold` to `media_assets`; `transaction_ref` and `metadata` to `payment_events`; `provider` and `provider_customer_id` to `subscriptions`; `notify_on_finish` to `user_preferences`; age-verification columns and `jurisdiction` to `users`. New indexes including `media_scan_idx` and `payment_events_txn_idx`. |
| `0003_integrity_fks_and_dob` | Drops NOT NULL on `users.date_of_birth` and nulls it for deleted accounts. Nulls dangling references, then adds five `ON DELETE SET NULL` FKs: `credit_ledger.payment_event_id`, `generation_jobs.parent_job_id`, `scene_versions.parent_version_id`, `templates.remixed_from_id`, `user_profiles.avatar_asset_id`. |
| `0004_taken_down_hashes` | Creates `taken_down_hashes` and the `media_sha256_idx` index on `media_assets(sha256)`. |

A database created before 0002 must run `npx tsx scripts/scan-backfill.ts` once. Until then its assets stay `pending` and are never served. The script only touches pending rows (add `--include-unavailable` to rescan `unavailable` ones) and exits 1 if any asset with a file is left without a verdict.

## 3. API contracts

### Conventions (`src/server/http.ts`, `src/middleware.ts`)

Every route except `/api/health` and `/api/media` is wrapped in `route()`. Errors use one envelope:

```json
{ "error": { "code": "string", "message": "Plain sentence for people.", "details": {} } }
```

| Status | Code | When |
|---|---|---|
| 400 | `invalid_json` | Body is not JSON (`parseJson`). |
| 400 | `invalid_form` | Upload routes only: the body is not a complete form ("Send the file as a form upload."). |
| 401 | `unauthorized` | No valid session ("Sign in to continue."). |
| 402 | `insufficient_credits` | Ledger refused a movement; `details: { needed, available }`. |
| 403 | `bad_origin` | Middleware (or the upload routes themselves): a write to `/api/*` (not `/api/webhooks/*`) carries an `Origin` that matches neither the request origin nor `APP_URL`. |
| 404 | `not_found` | Missing, deleted, or not yours. The two cases look identical by design. A malformed UUID also returns 404: `route()` looks for Postgres `22P02` on the error and on up to two causes below it. |
| 413 | `too_large` | Upload routes only: the declared `Content-Length` or the streamed body passed the limit. |
| 422 | `invalid_input` | A zod schema failed; `details` is `err.flatten()`. Message: "Some fields need attention." Also returned, with no details, when a value holds a NUL character (Postgres `22021`), and with the variable names in `details` when the server's own configuration fails its schema (section 1). |
| 429 | `rate_limited` | A fixed-window limit in Redis was hit (section 10). |
| 451 | `age_verification_required` | The age gate refused the request (section 7). `details: {verifyPath, status, jurisdiction}`. |
| 500 | `internal` | Anything unexpected. It is logged as `unhandled route error` with the path (no query string) and the redacted error, never the body (`src/server/http.ts:113`). Message: "Something went wrong on our side." |
| 503 | `unavailable` | Any rate-limited route while Redis cannot answer ("We can't take this right now. Try again in a minute."). Limits fail closed. |

Auth column values below: **Public** (no session needed), **User** (401 when signed out), **Admin** (401 when signed out, **404** for a signed-in non-admin, so admin endpoints do not reveal themselves), **Signed** (provider signature or secret, no session). Success bodies are JSON unless noted. Routes marked 429 can also return 503 `unavailable`.

### Auth and account

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/auth/signup` | Public | `email`, `password` (10 to 200), `handle` (3 to 24, `[a-zA-Z0-9_]`), `displayName` (1 to 40), `dateOfBirth` (YYYY-MM-DD, a real calendar date), `acceptTerms: true`, `confirmAdult: true` | 201 `{ok}`, sets `hl_session` | 429 (10 per hour per client address), 403 `underage`, 422 (including "Enter a real date of birth."), 409 `email_taken` / `handle_taken` |
| POST | `/api/auth/login` | Public | `email`, `password` (max 200 each) | 200 `{ok}`, sets `hl_session`, refreshes stored jurisdiction | 429 (30 per 15 min per client address; 10 per 15 min per account), 401 `bad_credentials` |
| POST | `/api/auth/logout` | Public | none | `{ok}`; removes this session's push subscriptions, deletes the session, clears the cookie | none |
| POST | `/api/age-gate` | Public | `{confirm: true}` | `{ok}`, sets `hl_age_ok` cookie (httpOnly, Lax, 30 days) | 422 |
| GET | `/api/me` | User | none | Settings view: age verification state, profile, preferences, `pushEnabled`, consents, active session count, popular tags | |
| PATCH | `/api/me` | User | `displayName`, `handle`, `bio` (max 280) | `{ok}` | 409 `handle_taken` (also when the unique index rejects a race) |
| DELETE | `/api/me` | User | `{password}` | `{ok}`, clears cookie (account deletion, section 13) | 429 (shares the account's password budget with login), 403 `bad_password` |
| DELETE | `/api/me/sessions` | User | none | `{ok}`, signs out every device | |
| PATCH | `/api/me/preferences` | User | Optional `personalizationEnabled`, `historyEnabled`, `autoplayPreviews`, `copilotEnabled`, `interests` (max 12, each max 24), `notifyOnFinish` | `{ok}` | |
| DELETE | `/api/me/history` | User | none | `{removed}` | |
| DELETE | `/api/me/consents/[id]` | User | none | `{ok}` | 404, 422 `use_account_deletion` for terms or adult attestation |

### Age verification

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/age-verification/start` | User | none | 201 `{url, provider, sandbox, verificationId}` | 429 (10 per hour), 503 `age_verification_unavailable`, 409 `already_verified`, 502 when the provider call fails |
| GET | `/api/age-verification/return` | User (signed out: 307 to `/auth?next=` with the Settings path) | `?sessionId=` (Yoti) or `?ref=` | Always 307 to `${APP_URL}/settings#age-verification`, after trying to sync the result (`NextResponse.redirect` with no status, which Next.js 15 sends as 307). A provider error is logged with its code and error name only and leaves the check pending. | none |
| POST | `/api/webhooks/age-verification/[provider]` | Signed | Provider callback body | `{received, outcome}` | 404 unknown or inactive provider, 400 `callback_<reason>`, 503 `callback_unconfigured`, 404 `unknown_reference`, 409 `callback_replayed` |

### Generation

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/generations` | User | Query: `active=1`, `media`, `status`, `favorites=1`, `projectId`, `templateId`, `modelKey`, `folderId`, `sort` (newest, oldest), `offset` (0 to 10000) | `{items}` (creation list items; output URLs withheld while an age check is required) | 422 |
| POST | `/api/generations` | User | `idempotencyKey` (8 to 100), `mode`, `modelKey`, `prompt` (1 to 2000), `negativePrompt` (max 1000), `params`, `inputAssetIds` (max 2), optional `templateId`, `characterReferenceId`, `projectId`, `sceneId`, `parentJobId`, `relation` | 201 `{job}` in `awaiting_confirmation` with its `costCredits` | 429 (30 per minute), 451 `age_verification_required`, 422 `unknown_model`, 503 `model_unavailable`, 422 `invalid_input`, 422 `unsupported_settings`, 422 `policy_blocked`, 403 `consent_required`, 422 `input_required` / `input_unexpected`, 403 `consent_withdrawn`, 403 `vip_required`, 404 |
| GET | `/api/generations/[id]` | User | none | `{job}` (output URLs withheld while an age check is required) | 404 (also for a non-UUID id) |
| DELETE | `/api/generations/[id]` | User | none | `{ok}` | 409 `job_active` while queued or processing |
| POST | `/api/generations/[id]/confirm` | User | `{expectedCost}` | `{job}` (queued, credits reserved) | 451 (checked before the body is read), 409 `draft_closed`, 409 `cost_changed` (`details.cost`), 429 `too_many_active`, 402 `insufficient_credits` |
| POST | `/api/generations/[id]/cancel` | User | none | `{job}` | 404 |
| POST | `/api/generations/[id]/derive` | User | `{relation: retry / variation / continuation / extension, idempotencyKey}` | 201 `{job}` (a new draft) | Same as POST `/api/generations` except that derive has no draft rate limit; 422 `unsupported` when continuing without a finished video |
| GET | `/api/generations/[id]/download` | User | none | 302 to a signed download URL on `APP_URL`, named `hushloom-<8 chars>[-demo].mp4` or `.webp` | 451, 404 |

### Uploads, media, characters and presets

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/uploads` | User | Multipart: `file`, `consent="true"`, optional `subject` (cut to 80 characters) | 201 `{assetId, kind, width, height, warnings}` | 403 `bad_origin`, 451 (before the rate limit), 429 (40 per hour), 400 `invalid_form`, 413 `too_large`, 422 `invalid_input` / `consent_required`, 415 `unsupported_type`, 422 `too_long` (video over 60 s), 403 `upload_rejected`, 410 `upload_removed`, 503 `scan_unavailable`, 503 `video_processing_unavailable` |
| GET | `/api/media` | Signature in the URL | `?k=<key>&e=<expiry>&s=<sig>[&d=<name>]` | File bytes, or 206 for a range | 403 "Link expired or invalid.", 404, 416 (section 12) |
| GET | `/api/characters` | User | none | `{characters}`; `imageUrl` is null and `mediaWithheld` is true while an age check is required | |
| POST | `/api/characters` | User | Multipart: `file`, `name` (trimmed, then cut to 40 characters; required), `consentAdult`, `consentLikeness` | 201 `{id, warnings}` | 403 `bad_origin`, 451 (before the rate limit), 429 (10 per hour), 400 `invalid_form`, 413 `too_large`, 422 `invalid_input` / `consent_required`, 415, 422 `limit_reached` (20), 403 `upload_rejected`, 410 `upload_removed`, 503 `scan_unavailable` |
| DELETE | `/api/characters/[id]` | User | none | `{ok}`; withdraws the likeness consent | 404 |
| GET | `/api/presets` | User | none | Preset list | |
| POST | `/api/presets` | User | `{name, fromJobId}` or `{name, mode, modelKey, prompt, params}`; the seed is never stored | 201 `{preset}` | 422 `limit_reached` (100), 422 `unknown_model` |
| DELETE | `/api/presets/[id]` | User | none | `{ok}` | 404 |

### Library, social and projects

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET / POST | `/api/folders` | User | POST `{name}` (1 to 40) | `{folders}` / 201 `{folder}` | |
| DELETE | `/api/folders/[id]` | User | none | `{ok}` | 404 |
| POST | `/api/folders/[id]/items` | User | `{jobIds}` (1 to 100 UUIDs) | `{added}` | 404 |
| POST / DELETE | `/api/favorites` | User | `{targetType, targetId}` | `{ok}` | 404 |
| POST / DELETE | `/api/follows` | User | `{creatorId}` | `{ok}` | 422 `self_follow` |
| GET / POST | `/api/projects` | User | POST `{title (1 to 80), description (max 500)}` | `{projects}`, each with `scenes`, `clips` (finished takes) and `cover` (the newest finished creation, with `isDemo`; URLs withheld while an age check is required, `isDemo` still sent) / 201 `{project}` | |
| GET / PATCH / DELETE | `/api/projects/[id]` | User | PATCH: title, description | Detail (media withheld the same way) / `{project}` / `{ok}` | 404 |
| POST | `/api/projects/[id]/scenes` | User | `{title, continuity}`; continuity is strict: lighting (40), framing (40), palette (80), characterReferenceId, notes (400) | 201 `{scene}` | 422 `limit_reached` (50 scenes) |
| PUT | `/api/projects/[id]/scenes` | User | `{order}` (every scene id exactly once, max 50) | `{ok}` | 422 `invalid_order` |
| PATCH / DELETE | `/api/scenes/[id]` | User | PATCH: title, continuity | `{scene}` / `{ok}` | 404 |
| POST | `/api/scenes/[id]/select` | User | `{versionId}` | `{ok}` | 409 `not_ready` unless the take completed |

`listProjects` (`src/server/projects.ts`) counts each project's scenes, and its completed, undeleted jobs as `clips`, with correlated subqueries. Inside a select field Drizzle renders `${projects.id}` as a bare `"id"`, which Postgres resolves to the subquery's own table, so both counts were always 0 until the visual review (V-B-1). The outer column is now written qualified (`${projects}."id"`), and `tests/integration/composing.test.ts` checks the counts on two projects.

### Templates

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/templates` | Public | Query: `q` (max 100), `category`, `media`, `sort` (trending, new, top_rated, most_favorited), `creatorId`, `vipOnly`, `offset` (max 10000), `limit` (1 to 60) | `{items, hasMore}`; poster and preview URLs are withheld (`mediaWithheld: true`) for viewers who need an age check, and for anonymous visitors without `hl_age_ok` | 422 |
| POST | `/api/templates` | User | `jobId`, `title` (2 to 60), `description` (max 500), `categorySlug`, `tags` (max 8), `isVip` | 201 `{template}` | 451, 404, 409 `not_ready`, 403 `personal_media`, 422 `policy_blocked`, 409 `no_output`, 409 `not_cleared`, 409 `taken_down`, 403 `creator_suspended` |
| PATCH | `/api/templates/[id]` | User (creator) or Admin | `title`, `description`, `tags`, `categorySlug`, `isVip`, `status` (published or unpublished), `prompt`, `changelog` | `{template}`; only the fields sent are written; a changed prompt adds a version | 404, 403 `removed`, 422 `policy_blocked`, 403 `creator_suspended` (when publishing for a suspended account) |
| POST | `/api/templates/[id]/rate` | User | `{score}` (1 to 5) | `{ok}` | 404 |
| POST | `/api/templates/[id]/report` | User | `{reason: minor / non_consent / real_person / illegal / spam / other, note (max 1000)}` | 201 `{ok}`; opens a `report` moderation event | 429 (20 per hour), 404 |

### Takedowns and push

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/takedowns` | Public or User | `category`, `target` (3 to 500), `email` (required when signed out), `name`, `details`, `goodFaith: true` | 201 `{ok, id}` | 429 (10 per hour per user, or per client address when signed out), 422 `email_required` |
| GET | `/api/push/public-key` | Public | none | `{enabled, reason, publicKey}` | |
| POST | `/api/push/subscriptions` | User | Browser `PushSubscription` JSON | `{ok, id, created}` | 503 `push_disabled`, 429 (60 per hour), 422 `invalid_input` for a foreign endpoint or malformed keys |
| DELETE | `/api/push/subscriptions` | User | `{endpoint}` | `{ok, removed}` (only your own) | |

### Payments

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/checkout` | User | `{itemKey}` | `{url, provider, isSandbox}` | 503 `payments_unavailable`, 429 (10 per 10 min), 403 `account_flagged`, 422 `unknown_item` / `unsupported_item` |
| POST | `/api/pricing/sandbox` | User | `action` (complete, fail, refund, chargeback, renew, cancel) with `token`, `transactionRef` or `subscriptionRef` | `{outcome, transactionRef, next}` | 503 when the sandbox is not the active provider, 403 `bad_token`, 422, 404 |
| POST | `/api/webhooks/payments/[provider]` | Signed | Provider body | 200 `{received: true, outcome}`; Segpay gets plain-text `OK` with an `x-payment-outcome` header | 404 unknown provider, 503 `payments_unavailable` when not configured, 400 `unsigned` / `bad_signature` / `replayed` / `malformed`, 500 for an event that must be retried |
| POST | `/api/webhooks/stripe` | Signed | Stripe event | Delegates to the generic handler for `stripe` | As above |
| POST | `/api/webhooks/replicate` | Signed | Replicate prediction | `{received: true}`; verifies and logs only, never changes state | 503 `webhook_unconfigured`, 400 `bad_signature` / `invalid_json` |

### Health and admin

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/health` | Public | none | `{ok, checks: {database, redis}}`, 200 when both are `ok` | 503 when either is down (not wrapped in `route()`) |
| POST | `/api/admin/credits` | Admin | `account` (email or `@handle`), `amount` (non-zero, within plus or minus 100000), `reason` (3 to 200), `idempotencyKey` (8 to 100) | `{handle, applied, available, reserved}` | 404, 402 |
| GET | `/api/admin/flags` | Admin | `?all=1` includes cleared flags | `{flags}` | |
| POST | `/api/admin/flags` | Admin | `{action: "clear", flagId, note (max 300)}` | `{ok, flag: {id, kind, clearedAt}}` | 404 `not_found` (no open flag with that id), 409 `use_review_queue` for `csam_match` |
| PATCH | `/api/admin/models/[key]` | Admin | `enabled`, `priceMultiplierPct` (10 to 1000) | `{ok}` | 404 unknown model |
| POST | `/api/admin/reports/[id]` | Admin | `{action: remove / dismiss, note}` | `{ok}` | 409 `already_resolved`, 409 `use_review_queue` for escalations, 422 `unsupported` |
| GET | `/api/admin/review` | Admin | none | `{scanner, escalations, takedowns, takedownsOpen}`; `takedowns` is the first page of open requests and `takedownsOpen` their total | |
| POST | `/api/admin/review/[id]` | Admin | `{action: "confirm", reportRef (3 to 120), reportedTo (ncmec_cybertipline, iwf, other_authority), note}` or `{action: "clear", note (3 to 500)}` | `{ok}` | 409 `already_resolved` |
| GET | `/api/admin/takedowns` | Admin | `?status=closed` (default open), `?offset` (0 to 1000000; anything else reads as 0) | `{takedowns, total, offset, limit}`; pages of 100, urgent categories first | |
| POST | `/api/admin/takedowns/[id]` | Admin | `{action: action / dismiss, note (max 500)}` | `{ok}` | 422 `note_required`, 422 `target_not_found`, 409 `already_resolved` |
| POST | `/api/admin/users/[id]/suspend` | Admin | `{reason}` (3 to 200) | `{ok: true}` | 404 for a missing or deleted user, or one already under an admin suspension |

Rate limits, their keys and how the client address is read are in section 10.

## 4. Worker architecture

Source: `src/worker/index.ts`, `src/server/generation/processor.ts`, `src/server/generation/queue.ts`.

### Queue

| Setting | Value |
|---|---|
| Queue name | `generation` |
| Entry id | `${jobId}-a${attempt}`. Re-adding the same attempt is a no-op, so duplicate enqueues collapse. |
| Default options | `attempts: 1` (BullMQ never retries; the app does), `removeOnComplete: 1000`, `removeOnFail: 5000` |
| Concurrency | `WORKER_CONCURRENCY`, default 2 |
| Timers | `reconcile()` at start and every 60 s; `purgeDeletedMedia(30)` every hour |
| Health | Optional HTTP server on `WORKER_HEALTH_PORT`: `GET /health` returns 200 `{ok}` while the BullMQ worker runs, else 503 |
| Shutdown | SIGINT or SIGTERM clears timers, closes the worker, Redis and the database pool, then exits 0 |
| Crash logging | BullMQ `failed` events are logged as `queue job crashed`; the error webhook is installed with source `worker` |

### Job lifecycle

The database row is the source of truth. A queue entry only says "look at this job now". Confirm, cancel, delete, the claim, `finishFailed` and the final transaction lock the job row (`SELECT ... FOR UPDATE`) and re-check its status. Sending a job back for a retry and the draft-expiry sweep use a conditional `UPDATE` instead, which only matches a row still in the expected status (`processor.ts:72-76`).

```text
 (insert) --> awaiting_confirmation --confirm, reserve--> queued --claim--> processing
                   |          |                            |   ^               |
                   |          +--cancel--> cancelled <-----+   |               +--> completed (settle)
                   |                          ^   cancel       |               |
                   +--24 h unconfirmed--------+   (release)    +--retryable----+
                      (cancelled, hidden)                         (reservation   |
                                                                   held)         +--> failed (release)
                                                                                 +--> cancelled (release)
```

| From | To | Trigger | Credits | Push |
|---|---|---|---|---|
| (none) | awaiting_confirmation | `createDraft` (POST `/api/generations` or derive) | none | no |
| awaiting_confirmation | queued | `confirmJob`: locks the job, checks the cost (409 `cost_changed`), locks the user's credit account and only then counts active jobs against the cap (429 `too_many_active`), so parallel confirms cannot pass the cap. Sets `queued_at`; writes a scene version when the job belongs to a scene and a `generate` discovery event when it came from a template | reserve | no |
| awaiting_confirmation or draft | cancelled | `cancelJob` | none | no |
| awaiting_confirmation | cancelled (with `deleted_at`, `failure_code = draft_expired`) | `reconcile()` when `created_at` is older than 24 h | none | no |
| queued | cancelled | `cancelJob` (sets `cancel_requested`, `failure_code = cancelled`) | release | no |
| queued | cancelled | Claim finds `cancel_requested` or `deleted_at` already set (account deletion and consent withdrawal set both) | release | no |
| queued | processing | Claim: sets `started_at`, `attempts + 1` | none | no |
| processing | queued | Retryable error and `attempts < max_attempts`; `failure_code` set, re-enqueued after `5000 x 2^(attempts - 1)` ms | reservation held | no |
| processing | completed | Outputs stored, scanned clean, quality-checked; inserted in one transaction with settle and `generation_count + 1` on the template | settle | yes |
| processing | failed | Non-retryable error, retries exhausted, scanner match (`content_blocked`), stored-output fault (`internal`), adapter missing (`provider_unavailable`), invalid inputs | release | yes |
| processing | cancelled | `cancel_requested` or `deleted_at` seen while running: the provider call is aborted and `finishFailed` records `cancelled` | release | yes |
| processing | cancelled | `cancel_requested` or `deleted_at` seen in the final transaction: outputs discarded | release | no |
| processing | failed (`timeout`) | `reconcile()` when `started_at` is older than `PROVIDER_TIMEOUT_S + 120` s (worker lost the job) | release | yes |

A job in any other state is left alone by `processJob`, so duplicate deliveries do nothing. `cancelJob` on a processing job only sets `cancel_requested`; the worker checks `cancel_requested` and `deleted_at` every 2 s and aborts. `DELETE /api/generations/[id]` soft-deletes only finished or unstarted jobs, checked under the row lock (409 `job_active` otherwise). If the enqueue fails after confirm, `confirmJob` still commits and logs `generation.enqueue_failed` (see reconcile below).

### One attempt, step by step

1. Claim in a transaction (above).
2. Look up the adapter. Missing or unconfigured means `provider_unavailable`, not retried.
3. Load inputs. Every input asset must be clean and not deleted. A character reference must be undeleted, its likeness consent not withdrawn, and its photo clean. Otherwise the job fails with `invalid_input` and is refunded, without calling the model.
4. Call `adapter.execute` with an `AbortController` that fires after `PROVIDER_TIMEOUT_S` (default 600 s) or on cancel. The provider's job id is saved as soon as it is known.
5. Check each output's quality (at least 1024 bytes; images must decode under the same decoder limits as uploads and be at least 64 by 64; MP4 must contain `ftyp`; a failure is `internal`), store it under `outputs/<userId>/<uuid>.<ext>` as a private asset, and scan it (section 8). A match is recorded with retries; if recording keeps failing, the file is put on legal hold instead. Either way the job fails with `content_blocked` and is refunded, and the matched file is never deleted.
6. For video, extract a poster frame at 0.5 s with ffmpeg, convert it to WebP, and give it the output's verdict (`recordDerivedScan`). If ffmpeg or the frame decode fails, `videoPoster` returns null and the output is kept without a poster (`poster.ts:23`, `poster.ts:27-28`). A storage or database fault while saving the poster is a store fault (step 8) and fails the job.
7. Final transaction: if the job is no longer `processing`, discard the files; if `cancel_requested` or `deleted_at` is set, release and cancel; otherwise insert outputs, settle, mark completed and add 1 to the template's `generation_count`.
8. Any fault while storing removes the rows and files this attempt wrote (`discardAfterFault`), then fails the job with `internal` and refunds. Held files are never touched.

### Reconcile sweeps

`reconcile()` returns `{requeued, failed, expiredDrafts}`:

| Sweep | Condition | Action |
|---|---|---|
| Draft expiry | `awaiting_confirmation` and `created_at` older than 24 h | Conditional update: cancelled, `failure_code = draft_expired`, `deleted_at` set. These never held credits. |
| Lost queue entries | `queued` and `updated_at` older than 120 s | Re-enqueued as attempt `attempts + 1`. The entry id makes this a no-op if the entry still exists. |
| Dead worker | `processing` and `started_at` older than `PROVIDER_TIMEOUT_S + 120` s | `finishFailed` with non-retryable `timeout`; credits released. |

This is also how a failed enqueue recovers: the confirmed job sits in `queued` with its reservation, and the next sweep enqueues it.

### Scanner-outage requeue

When the scanner returns `unavailable` for an output and `SCAN_FAIL_CLOSED=true` (the default), every file the attempt stored is discarded and the attempt ends with the retryable error `scan_unavailable`. The job returns to `queued` with its reservation held and is retried with backoff. After `max_attempts` (3) it fails and is refunded. Nothing unscanned is ever shown.

### Notifications

`notifyJobFinished` (`src/server/push/notify.ts`) is called fire-and-forget on completion and from `finishFailed`. It never throws into the processor. The cases marked "no" in the table above (cancel through the API while queued, cancel or deletion found at claim, cancel or deletion during storing, draft expiry) send nothing. A cancel while processing does send "A creation was cancelled".

## 5. AI provider adapters

Sources: `src/server/ai/registry.ts`, `src/server/ai/providers/*`.

### Registry and capability declaration

Every model is a `ModelSpec`: `key`, `providerKey`, `displayName`, `providerModel`, `output` (image or video), `modes`, `aspectRatios`, `durationsS`, `qualities`, `supports` (`negativePrompt`, `seed`, `cameraMovement`, `motionIntensity`, `cancel`), `continuity` (`none` for every model today), `minInputShortSidePx`, `notes`.

| Model key | Provider | Output | Modes | Aspect ratios | Durations | Qualities | Supports |
|---|---|---|---|---|---|---|---|
| `demo-still` | demo | image | text_to_image, image_to_image, reference_guided | 1:1, 4:5, 3:4, 2:3, 9:16, 16:9 | n/a | hd, 4k | negative prompt, seed |
| `demo-motion` | demo | video | text_to_video, image_to_video, video_extension, scene_continuation | 9:16, 1:1, 16:9 | 3, 5, 8 s | hd | seed, camera movement, motion intensity |
| `replicate-flux-schnell` | replicate (`black-forest-labs/flux-schnell`) | image | text_to_image | 1:1, 4:5, 3:4, 2:3, 9:16, 16:9 | n/a | hd | seed |

Closed lists for settings: camera movements (static, slow push in, pull back, pan left, pan right, orbit, handheld, tilt up, tilt down), pacings (slow, natural, brisk), lightings (soft window, golden hour, neon, candlelit, low key, high key, backlit), framings (close-up, medium, wide, over the shoulder, low angle, high angle). `MODE_INPUTS` fixes how many image, video and character-reference inputs each mode takes; `reference_guided` requires one character reference.

Validation runs twice: the strict `paramsSchema` rejects any value not on a list (422 `invalid_input` naming the field), then `validateAgainstModel` rejects anything the chosen model does not declare (422 `unsupported_settings`).

### Cost

`estimateCost`: an image costs 4 credits; a video costs 3 credits per second of its duration (default: the model's first listed duration, else 5). The result is multiplied by the quality factor (hd 1, 4k 2) and by `price_multiplier_pct / 100` from `model_configs`, rounded up, minimum 1. Confirm must send the same number (`expectedCost`), so a price change between draft and confirm returns 409 `cost_changed`.

### Availability

`listModelAvailability` merges `model_configs`. A model is available only when its adapter exists, reports `isConfigured()`, and is not disabled by an admin. The reasons shown are "No adapter", "Needs credentials" and "Disabled by an admin". A draft for an unavailable model gets 503 `model_unavailable`.

### Adapter contract

```ts
interface ProviderAdapter {
  key: string;
  isDemo: boolean;
  isConfigured(): boolean;
  execute(req, { signal, onProviderJobId }): Promise<outputs>;
}
```

Inputs carry a `role` of `source` or `reference`. Failures are `ProviderError(code, message, retryable)` with codes `timeout`, `rate_limited`, `provider_unavailable`, `invalid_input`, `content_rejected`, `unsupported`, `cancelled`, `internal`, `content_blocked`, `scan_unavailable`. Users never see the provider's message. They see a fixed sentence from `USER_FACING_ERRORS`, and every one of those says the credits were returned.

### Demo provider (Demo)

On when `ENABLE_DEMO_PROVIDER=true` (the default). It makes no AI call. It renders a seeded SVG card carrying the prompt as a caption and the watermark "DEMO OUTPUT · NOT AI-GENERATED" (`demoSvg`). The caption wraps at spaces into at most two lines sized to the frame's width, ends with an ellipsis when the prompt is longer (`captionLines`), and starts below the top 16% of the frame, where the app draws its Demo badge and favorite heart. The watermark's type is sized to fit 90% of the width, so it stays inside a 9:16 frame. Images are WebP with a long side of 1280 px (2048 for 4k). Videos are rendered by ffmpeg as a 24 fps H.264 zoom-and-pan that follows the chosen camera movement. A source image or character reference is composited under the overlay. That is not a likeness match. Demo outputs are stored with `is_demo = true` and labeled in the interface (including project covers, scene tiles and compared takes), in download file names (`-demo`) and in templates.

### Replicate adapter (Unverified)

No `REPLICATE_API_TOKEN` exists, so this adapter has never run against Replicate.

| Step | Behavior |
|---|---|
| Create | `POST /v1/models/{model}/predictions` |
| Poll | `GET /v1/predictions/{id}` with backoff from 1 s up to 8 s |
| Cancel | Cancels the prediction on abort or error |
| Inputs | Only `flux-schnell` has an input builder: prompt, `aspect_ratio`, `num_outputs: 1`, WebP, seed. Lighting, framing, atmosphere (and pacing, for video) reach the model as words appended to the prompt (`promptWithSettings`). A character reference on a model with no reference field fails with `unsupported` instead of being dropped. |
| HTTP errors | 401 or 403 to `provider_unavailable`; 404 to `unsupported`; 422 to `invalid_input`; 429 to `rate_limited` (retryable); 5xx to `provider_unavailable` (retryable); any other status to `internal`. The 422 and the other-status messages include up to 300 characters of the response body. Network errors are retryable; abort maps to `timeout`. |
| Failed prediction | A message mentioning nsfw, safety or content maps to `content_rejected`; anything else to `internal` |
| Webhook | `verifyReplicateWebhook` checks Standard Webhooks signatures (HMAC over `id.timestamp.body`, base64 secret after `whsec_`, 300 s window). The route only verifies and logs. Results come from polling. |

### Provider terms (from the addendum research)

fal.ai forbids explicit output unless it authorizes the account. Replicate's terms are ambiguous for adult output and its safety checker can be disabled. No fal.ai adapter is built. No real video model adapter is built. Both are **planned / not built**.

### Not AI

The composing copilot (`src/lib/copilot.ts`) is a set of deterministic rules: it analyzes the prompt and settings and suggests edits. It calls no model and is not a demo.

## 6. Payments

Sources: `src/server/payments/*`, `src/config/pricing.ts`.

### Adapter contract

```ts
interface PaymentProvider {
  key; label; isSandbox;
  capabilities: { packs, subscriptions, refunds, adultContentAllowed };
  isConfigured(); webhookConfigured(); configurationProblem();
  createCheckout({ user, item, successUrl, cancelUrl });
  verifyWebhook({ rawBody, headers, url }): PaymentEvent;   // throws WebhookRejected
  cancelSubscription?();
}
```

`WebhookRejected` reasons: `unsigned`, `bad_signature`, `replayed`, `malformed`. Every provider maps its events to one normalized `PaymentEvent`: `purchase_completed`, `subscription_started` (with `grantsFirstPeriod`), `subscription_renewed`, `subscription_updated`, `subscription_cancelled` (with `atPeriodEnd`), `refund` (with `subscriptionRef` and `cumulative`), `chargeback`, or `ignored`. A sale or pass start may also carry `review`, a reason the provider adapter already found to hold it.

### Catalog (placeholder prices, USD)

| Key | Name | Credits | Price | Extra |
|---|---|---|---|---|
| `pack_small` | Spark | 100 | $9.99 | |
| `pack_medium` | Flicker | 550 | $44.99 | |
| `pack_large` | Blaze | 1200 | $89.99 | |
| `plan_member` | Night Pass | 400 per period | $19.99 | 3 active jobs, VIP templates |
| `plan_studio` | Studio Pass | 1500 per period | $59.99 | 6 active jobs, VIP templates |

A pass counts while its status is `active`, `trialing` or `non_renewing` and its period end is empty or in the future (`activePlan`). A processor's "stop rebilling" notice sets `non_renewing`, so the paid period is kept. An immediate end (CCBill `Expiration`, Segpay `Disable`, Stripe `customer.subscription.deleted`, sandbox cancel) sets `canceled`, which stops counting at once.

### Providers

| Provider | Status | Checkout | Webhook verification |
|---|---|---|---|
| `sandbox` (default) | Sandbox. Refuses to work on a live site. | A 30-minute HMAC token over user, item and a nonce, sent to `/pricing/sandbox?t=`. That page's buttons post to `/api/pricing/sandbox`, which builds and signs a webhook body (sale, failure, renewal, cancel, refund, chargeback) and runs it through the real handler. The sale's event id is `sbx_checkout_<nonce>`, so one link settles once. | Header `x-sandbox-signature: t=<s>,v1=<HMAC(t.body)>` with a constant development secret; outside a 5-minute window is `replayed`. Sandbox reversals carry no `subscriptionRef`, and sandbox cancel is immediate. |
| `ccbill` | Unverified (no merchant account) | FlexForms URL `https://api.ccbill.com/wap-frontflex/flexforms/{flexId}` with `formDigest`: packs `md5(price + 30 + 840 + salt)`, passes `md5(price + 30 + price + 30 + 99 + 840 + salt)`. Pass-through `X-hlUser`, `X-hlItem` and `X-hlSig = HMAC-SHA256(salt, "ccbill:user:item")`. | `CCBILL_WEBHOOK_TOKEN` is required: without it CCBill counts as unconfigured and every CCBill webhook gets 503. Every event must carry `token` equal to it (missing is `unsigned`, wrong is `bad_signature`). A `clientAccnum` that is sent must match. `NewSaleSuccess` must also carry `dynamicPricingValidationDigest = md5(subscriptionId + "1" or "0" + salt)`, and the pass-through signature must verify. |
| `segpay` | Unverified (no merchant account) | `https://secure2.segpay.com/billing/poset.cgi?x-eticketid=<package>:<pricepoint>` with `x-billemail`, `x-auth-link`, `x-decl-link` and pass-through `hluser`, `hlitem`, `hlsig` (HMAC). Checkout refuses an item with no price point in `SEGPAY_PRICE_POINT_ID`; there is no shared fallback. The refusal is a plain error, so `route()` returns 500 `internal`. | Segpay signs nothing. A postback must carry `?key=` or `postbackkey=` equal to `SEGPAY_POSTBACK_SECRET`, or HTTP Basic auth whose password is that secret or `SEGPAY_USER_ACCESS_KEY`. The `hlsig` pass-through must verify. |
| `stripe` | Unverified; off unless `PAYMENT_PROVIDER=stripe` and both keys are set | Stripe Checkout | `stripe.webhooks.constructEvent` with the `stripe-signature` header. |

Stripe declares `adultContentAllowed: false`. Stripe lists adult content among restricted businesses (https://stripe.com/legal/restricted-businesses), so it is kept only as an option for non-explicit use. CCBill and Segpay are the adult-capable paths. The CCBill file header lists five points to confirm in CCBill's sandbox before launch: pass-through key spelling, whether refund transaction ids are new or original, whether the webhook URL keeps its query string, timestamp formats, and the pack period. The Segpay header lists four: the postback URL template for pass-through values, GET versus POST delivery, price point ids per item, and `transtime` and `trantype` spellings.

### What the processor charged decides

The pass-through values name a user and an item, but they are not tied to the price. So the amount and item the processor actually charged decide what is granted.

| Check | Where | Result when it fails |
|---|---|---|
| CCBill: the billed price (`billedInitialPrice`, else `accountingInitialPrice`, else `initialPrice`) equals the item's price exactly, in the item's currency. A pass also needs recurring terms (`nextRenewalDate`). | `ccbill.ts:158-168` | The sale carries `review` and is held. |
| CCBill: pass-through values are read only as `X-hlUser`, `X-hlItem`, `X-hlSig`. | `ccbill.ts` | Missing values: the sale is recorded as `ignored`. |
| CCBill: a currency code it does not know, or none, is recorded as `xxx` (ISO 4217 "no currency"). | `ccbill.ts` | Fails the price check, so it is held. The numeric code is kept in `metadata.currencyCode`. |
| Segpay: the price point in `eticketid` maps to exactly one item in `SEGPAY_PRICE_POINT_ID`. | `segpay.ts:164-176` | An `eticketid` for another package: `ignored`. Mapped to exactly one item that differs from `hlitem`: 400 `bad_signature`. No `eticketid`, or a price point mapped to no item or to several: held. |
| Stripe: a checkout session without `amount_total` or currency is recorded as 0 and `xxx`. | `stripe.ts` | Held. |
| Every sale and pass start: `notPaidInFull`. The currency must match, ignoring case, and the amount must be at least the price. | `service.ts:209` | Held. |
| Every sale and pass start: `cannotBuy`. The account must not be deleted and must have no open `chargeback` flag. | `service.ts:219-228` | Held. A checkout link stays payable after it was issued, so these checks are made again when the money lands. |

`holdForReview` (`service.ts:231-253`) grants nothing. It records a `manual_review` flag whose details hold `paymentEventId`, `provider`, `itemKey`, `amountCents`, `currency`, `transactionRef`, `problem` (and `subscriptionRef` for a pass start). The event's outcome is `ignored` with `reason: needs_review`. An operator checks it with the processor, then grants or refunds by hand.

Segpay reads a missing `currencycode` as USD. That is an open go-live question (section 15).

### Event mapping

| Normalized event | sandbox | CCBill | Segpay | Stripe |
|---|---|---|---|---|
| purchase_completed / subscription_started | sale | `NewSaleSuccess` | `Enable`, or `Sale` with stage `Initial` or empty (`approved=No` is ignored) | `checkout.session.completed`, `checkout.session.async_payment_succeeded`: a pack only when `payment_status` is `paid`; a pass session maps to subscription_started with no paid check and `grantsFirstPeriod: false`, and its credits come from `invoice.paid` (`stripe.ts:68-96`) |
| subscription_renewed | renewal | `RenewalSuccess` | `Sale` at any other stage | `invoice.paid` |
| subscription_updated | | | | `customer.subscription.updated` (Stripe's status is stored as sent) |
| subscription_cancelled, at period end | | `Cancellation` | `Cancel`, `Cancellation` | |
| subscription_cancelled, immediate | cancel | `Expiration` | `Disable` | `customer.subscription.deleted` |
| refund | refund | `Refund`, `Void`, `Return` (with `subscriptionRef` = subscriptionId) | `Credit`, `Void` | `charge.refunded` (cumulative amount) |
| chargeback | chargeback | `Chargeback` | `Charge` | `charge.dispute.created` |
| ignored | failure | anything else | anything else | anything else |

Event ids:

| Provider | Event id |
|---|---|
| CCBill | A sale is `${eventType}:${subscriptionId}`, the one field its digest signs, so a signed sale re-posted with another timestamp is a duplicate. Other events are `${eventType}:${transactionId or subscriptionId}:${timestamp}`. |
| Segpay | `sale:<id>`, `declined:<id>`, `rebill:<tranid>`, `credit:<tranid>`, `void:<tranid>`, `chargeback:<tranid>`, or `<action>:<purchaseid>`. |
| Stripe | The event id. |
| Sandbox | `sbx_checkout_<nonce>` for a sale; generated ids for the other buttons. |

Matching references: Stripe records `invoice.paid` under the invoice's payment intent (or the paid entry in `inv.payments`, else the invoice id), so a later refund or dispute on that charge finds it. A Segpay reversal with `relatedtranid` matches only that charge and waits for it if it has not landed. Without it, the reversal falls back to its `tranid` and then the purchase id.

### Webhook handling and the exactly-once rule

`handlePaymentWebhook` (`src/server/payments/webhook.ts`):

1. Unknown provider: 404. The lookup uses `Object.hasOwn`, so names such as `constructor` are unknown too.
2. The provider is accepted when it is the active provider with its webhook configured, or a non-sandbox provider with its own webhook secrets present, so refunds and chargebacks for an earlier processor still land. Otherwise 503.
3. `verifyWebhook` failures return 400 with the reason as the code.
4. `processPaymentEvent` (`service.ts`) runs in one transaction:
   1. **Advisory locks** (`lockRefs`, `service.ts:65-91`). For each reference the event can be matched by, sorted, it takes `pg_advisory_xact_lock(hashtextextended('payment:<provider>:<ref>', 0))`. A sale locks its transaction ref and its `subscriptionRef`; a pass start or renewal locks its transaction ref and subscription id; a refund or chargeback locks its transaction ref and `subscriptionRef`; an update or cancellation locks the subscription id only. So a reversal and its payment, or a cancellation and its pass start, never run side by side and miss each other.
   2. Insert into `payment_events` with `ON CONFLICT DO NOTHING` on (`provider`, `provider_event_id`). A duplicate returns outcome `duplicate` and changes nothing.
   3. Apply the event (table below).
   4. Set `processed_at` and audit `payment.<type>` with a null actor.
   5. If the event granted credits, apply any reversals kept pending for it (`applyPendingReversals`).
5. A renewal for a pass the database has never seen is held with 200 when its pass start was held for review (`heldPassStart`, `service.ts:146-153`). Only a renewal with no start at all throws: the transaction rolls back, the route returns 500, and the provider retries later.

Credit grants use ledger keys `<provider>:<providerEventId>`, so even a replayed event that slipped past step 4.2 cannot grant twice.

| Event | Effect |
|---|---|
| purchase_completed | Held if `review`, `notPaidInFull` or `cannotBuy` finds a problem. Otherwise grants the pack's credits (`purchase`). |
| subscription_started | Held on the same checks. Otherwise upserts the pass as `active`, applies a cancellation kept pending for it (`applyPendingCancellation`, `service.ts:430-449`), and grants the first period when `grantsFirstPeriod` (`subscription_grant`). |
| subscription_renewed | No pass row: held if its start was held, else 500 (above). Owner deleted: held ("cancel it at the processor and refund this charge"). `notPaidInFull`: held. Otherwise grants the period, sets `active` and refreshes `current_period_end`. |
| subscription_updated | Stores Stripe's status. |
| subscription_cancelled | Sets `non_renewing` when `atPeriodEnd`, else `canceled`. A late `non_renewing` never reopens a pass already `canceled`. With no pass row yet, it is recorded as `ignored` with `reason: unknown_subscription` and `pending: true`, and applied when the pass starts. |
| refund / chargeback | Clawback (below). |

### Refunds and chargebacks

1. Find the original grant by provider and `transaction_ref` with credits above 0, else by `metadata.subscriptionRef` (`findCreditedEvent`).
2. **Pending reversal** (`service.ts:299-317`): if none is found, the event is recorded as `ignored` with `reason: original_not_found`, `pending: true`, the amount in `pendingAmountCents` and the `cumulative` flag. When the payment is credited later, `applyPendingReversals` (`service.ts:397-427`) runs it through the clawback in the same transaction, marks it `applied_after_purchase` and audits it. Each still moves credits exactly once.
3. Lock the original payment row `FOR UPDATE`, so concurrent reversals of one payment run one at a time.
4. Sum what earlier reversals of the same original took back (by `metadata.reversesEventId`).
5. Target reversal is pro rata: `min(granted, ceil(granted x totalReversed / paid))` when both amounts are above 0, else the full grant. Stripe refunds carry a running total, so `totalReversed` is that total.
6. Owed is the target minus what earlier reversals took back.
7. Reverse `min(available, owed)` with ledger kind `refund` or `chargeback` (keys `refund:<provider>:<eventId>`, `chargeback:<provider>:<eventId>`).
8. A shortfall adds a `credit_debt` flag. Its details hold `shortfall`, `reversed`, `reversal`, `originalEventId`, and the part of the shortfall held by creations in progress: `held = min(shortfall, reserved)`, `heldJobIds` (the user's queued and processing jobs), `outstanding = held` and `collected = 0`. Those held credits are taken back when the jobs are released (section 11).
9. A chargeback always adds a `chargeback` flag.

### Flags

| Flag | Written by | Read by |
|---|---|---|
| `chargeback` | Chargeback | `checkoutBlock` (403 `account_flagged` at checkout) and `cannotBuy` (a sale that lands later is held). |
| `credit_debt` | Reversal shortfall | `releaseJob` (`ledger.ts`) collects the held part. |
| `manual_review` | Held payments, account deletion with a live pass, admin suspension, and an abuse-category scan match (no current scanner returns one) | Operators. An admin suspension flag (`details.source = admin_suspension`) is read by `suspensionCauses` (section 10). |
| `csam_match` | Scanner match, CSAM takedown | `suspensionCauses`; cleared only through the review queue. |

Admins clear flags through `/api/admin/flags` (audit `flag.clear`). A `csam_match` flag cannot be cleared there (409 `use_review_queue`).

## 7. Age verification

Sources: `src/server/age/*`, `src/config/jurisdictions.ts`.

### Three layers

| Layer | What it does | Where |
|---|---|---|
| Self-declaration | Signup requires a real date of birth showing age 18 or over, `confirmAdult: true` and `acceptTerms: true`. Under 18 returns 403 `underage` and stores nothing. Two consent records (`terms`, `adult_attestation`) are written. | Everywhere |
| Age gate page | An interstitial asking visitors to confirm they are adults; `/api/age-gate` sets `hl_age_ok` for 30 days. It renders only when there is no session, no `hl_age_ok` cookie, and the path is outside `/policies`. It never renders on `/offline`: the root layout returns a bare page for that path before it reads the session or the cookie (`src/app/layout.tsx`). Without the cookie, an anonymous visitor's pages and API responses also carry no media URLs (`viewerAccess`). | Everywhere |
| Provider check | A real age check with a provider before creating, uploading, publishing, downloading or seeing explicit media. | Required jurisdictions only |

### Rules

| Setting | Default | Meaning |
|---|---|---|
| `AGE_VERIFICATION_ENFORCE` | true | Turns the provider check on. |
| `AGE_VERIFICATION_REGIONS` | GB plus 25 US states: AL, AR, AZ, FL, GA, ID, IN, KS, KY, LA, MO, MS, MT, NC, ND, NE, OH, OK, SC, SD, TN, TX, UT, VA, WY | Codes are `GB` or `US-TX`. A bare `US` covers every state. `AGE_ASSURANCE_STRICT_REGIONS` is added to the list. |
| `AGE_VERIFICATION_FAIL_CLOSED` | false | What to do when the location is unknown. False means allowed. Unknown means no country header, the edge markers `XX`, `T1`, `A1` or `A2`, or a bare `US` while rules are per state. |
| `AGE_VERIFICATION_VALID_DAYS` | 365 | A verification older than this reads as `expired` and blocks again. |
| `GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER` | `x-country-code`, `x-region-code` | Headers the edge must set. They are trusted as received. |

The UK list follows Ofcom's highly effective age assurance duty, in force from 25 July 2025 (https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance). The US list draws on the Free Speech Coalition's tracker, which counts 27 states (https://www.freespeechcoalition.com/faq). The default list has 25 states and is not legal advice; counsel must confirm it.

`requirementFor` (`service.ts:70-80`) checks both the account's stored `jurisdiction` and the request's geo headers. Verification is required if either one requires it, so a stored uncovered place never unlocks a request from a covered one. With no location on the request, the stored value decides alone. The stored value is written at signup and refreshed at each login. An unknown location (above) is never stored, and a login without the header keeps the old value. `satisfied` means "not required" or "verified and not expired".

A `verified` status from the sandbox reads as `unverified` on a live site, so a preview database that goes live keeps no sandbox verifications. Expiry is computed on every read.

### Providers

| Provider | Status | Start | Result |
|---|---|---|---|
| `sandbox` (default) | Sandbox, labeled "Sandbox check (proves nothing)". Refuses to work on a live site. | Sends the user to `/verify/sandbox?ref=`. That page returns 404 on a live site, when another provider is active, without a `ref`, or when the `ref` names no sandbox check of the signed-in user. A signed-out visitor is sent to `/auth`, and an owner whose check is no longer pending is sent to `/settings#age-verification` (`src/app/verify/sandbox/page.tsx`). | A callback signed with `x-hushloom-sandbox-signature` (HMAC-SHA256 hex with `AGE_VERIFICATION_WEBHOOK_SECRET`, or a development fallback). |
| `yoti` | Unverified (no account) | `POST {AGE_VERIFICATION_API_URL}/api/v1/sessions` with Bearer key and `Yoti-SDK-Id`. Session type `OVER`, TTL 1800 s, `reference_id`, callback `/api/age-verification/return`. Methods: age estimation with threshold 25, document scan 18, digital ID 18; credit card and mobile off. `notification_url` is sent only for HTTPS. The user goes to the hosted page with `sessionId` and `sdkId`. | `GET /api/v1/sessions/{id}/result`: `COMPLETE` becomes verified; `FAIL`, `ERROR`, `CANCELLED`, `EXPIRED` become failed with a reason; anything else stays pending. Notifications are verified with RSA-PSS SHA-256 against the pasted PEM key. |

### Status lifecycle

| Step | Effect | Audit |
|---|---|---|
| Start | 503 `age_verification_unavailable` if unconfigured; 409 `already_verified` if verified. Inserts a pending `age_verifications` row and calls the provider (a failure records a failed row and returns 502). Sets the user `pending` only if the user is still not verified, or `age_verified_at` is unchanged since it was read, so a verification that lands in between is never overwritten. | `age_verification.pending` (actor: user) |
| Callback or return | Unknown reference 404 `unknown_reference`; a row no longer pending 409 `callback_replayed`; a pending outcome changes nothing. Only the active provider is accepted. The return route always ends in Settings, even when the provider's result API fails. | |
| Verified | Row and user set to verified with `expires_at`. | `age_verification.verified` (actor null) |
| Failed | Reason recorded. A failed result never downgrades a user who is already verified. | `age_verification.failed` (actor null) |
| Expired | Computed when read from `age_verified_at` and `VALID_DAYS`. Not stored. | |

### Gating as built

`assertAgeVerified` answers 451 `age_verification_required` with `details: {verifyPath: "/settings#age-verification", status, jurisdiction}`. Every call passes the request's country and region.

In the browser, `api()` (`src/lib/api.ts`) turns a 451 into an `ApiError` whose `verifyPath` points at the check. The create panel shows the server's message with a "Verify your age" button. The error toasts for derive and confirm on a creation's page and for Library retry carry a "Verify your age" action (`apiErrorAction`). Every other caller shows the message alone, which `api()` ends with "Open Settings › Age verification to do it."

| Surface | Gate |
|---|---|
| POST `/api/generations` and POST `/api/generations/[id]/derive` | `assertAgeVerified` in `createDraft`. |
| POST `/api/generations/[id]/confirm` | `assertAgeVerified` before the body is read. A draft priced elsewhere, or made before a verification lapsed, starts nothing. |
| GET `/api/generations/[id]/download` | `assertAgeVerified`. |
| POST `/api/uploads` and POST `/api/characters` | `assertAgeVerified`, before the rate limit (`route.ts:20` for characters). |
| POST `/api/templates` | `assertAgeVerified`. Publishing shares explicit media. |
| Discovery cards, template pages, creator pages, rails, favorites page, GET `/api/templates` | `viewerAccess()` (cached per request) decides `explicitAllowed`. When false, poster and preview URLs are null and `mediaWithheld` is true. An anonymous visitor without `hl_age_ok` set to `1` always gets false (`access.ts:20-24`). Every public template is treated as explicit. |
| The user's own library: GET `/api/generations`, `/api/generations/[id]`, `/api/projects`, `/api/projects/[id]`, GET `/api/characters`, and the matching pages | `viewerAccessFor` in the API routes, `viewerAccess()` in the pages. Output, poster, cover and character image URLs are withheld while a check is required and not satisfied. |

## 8. Abuse scanning

Sources: `src/server/safety/scan/*`, `src/server/safety/review.ts`, `src/server/safety/takedowns.ts`, `src/server/safety/suspend.ts`, `src/server/templates/publish.ts`, `src/server/media.ts`. The operating procedure is in [docs/abuse-response.md](abuse-response.md) (pipeline, verdicts, a match, evidence preservation, the review queue, reporting for legal review, takedowns, fail-closed rules, what production needs, what is unverified, known gaps).

### Pipeline

Every file is scanned before anyone can see it. Only assets with `scan_status = clean` are ever served, published or sent to a model.

| Origin | When scanned | Outcome on `matched` | Outcome on `unavailable` (fail-closed) | Outcome on `unavailable` (fail-open) |
|---|---|---|---|---|
| Upload (`/api/uploads`, `/api/characters`) | After re-encoding, before the response | 403 `upload_rejected` | Upload row and its consent record deleted, asset soft-deleted, bytes purged; 503 `scan_unavailable` | Stored with warning `scan_pending`; never served while `unavailable` |
| Generation output | After storing, before the job completes | Other outputs discarded; job fails `content_blocked`; refunded | All outputs discarded; retried, then failed and refunded (section 4) | Job completes and is charged, but the output stays `unavailable` and is never served |
| Video poster | After extraction | Takes the output's verdict through `recordDerivedScan` (`scan_ref = derived:<parentId>`) | | |
| Published copy | Copied at publish | Carries the source's clean verdict; publish refuses anything not clean or on hold (409 `not_cleared`) or taken down (409 `taken_down`) | | |

After an upload's verdict, `acceptUpload` purges it at once if it was soft-deleted while it was being checked (for example by a consent withdrawal), and answers 410 `upload_removed`.

`runScan` never throws. Each `provider.scan` call is bounded by `SCAN_TIMEOUT_S` (default 30). `scripts/scan-backfill.ts --include-unavailable` rescans assets left `unavailable`.

### Video sampling (whole clip)

Uploads over 60 s or over 4096 px on a side are refused before the scan (section 12). The scan covers the whole clip:

| Step | Rule |
|---|---|
| Probe | `probeVideo` (ffprobe). A clip over `MAX_SCANNED_VIDEO_S` (60) or over `MAX_VIDEO_SIDE` (4096 px) gives `unavailable`. |
| First pass | One ffmpeg pass writes one frame per second as PNG, scaled to fit 1024 px (`FRAME_SIDE`). The same pass streams every frame at 128 x 128 (`CHANGE_SIDE`, yuv420p) to `pickChanges`. |
| Change picks | `pickChanges` picks the first frame, then any frame that differs from the last picked frame by more than 10% mean absolute difference (`CHANGE_MAFD`). It also picks the peak of a change over 5% (`APEX_MAFD`) that then fades back or moves away, so a short flash is seen at its strongest. |
| Caps | At most 61 per-second frames (`PERIODIC_MAX`) and at most `max(60, ceil(3 x duration))` change frames (`CHANGES_MAX`, `CHANGES_PER_S`). Going over either cap throws, so the verdict is `unavailable`, never clean. |
| Second pass | ffmpeg extracts the picked frames at up to 1024 px. |
| Resources | ffmpeg runs with `-threads 2` and `-filter_complex_threads 1`, with a timeout of 2 x `SCAN_TIMEOUT_S`. |
| Whole file | A scanner that declares `capabilities.video` gets the whole file first; any non-clean answer stands. |
| Clean result | `scan_ref = keyframes:<N>;<first provider ref>`. |

### Scanners

| Provider | Status | Capabilities | Notes |
|---|---|---|---|
| `dev` (default) | Dev, labeled "Development scanner (matches test hashes only)" | hash match, pre-storage, video (gets the whole video file first) | Matches SHA-256 values: the drill fixture `tests/fixtures/scan-drill-match.png` and any listed in `SCAN_DEV_MATCH_HASHES`. `SCAN_DEV_SIMULATE_OUTAGE` forces `unavailable`. On a live site it always returns `unavailable`. |
| `photodna` | Unverified | hash match, pre-storage, no video file | Sends a JPEG of at most 4 MB (resized to 2048, 1600 or 1200 px as needed), 220 ms throttle, `Ocp-Apim-Subscription-Key`. Reads `IsMatch` and `TrackingId`; success code 3000 was written from memory. Anything unexpected is `unavailable`. PhotoDNA is free after Microsoft approves the applicant. |
| `cloudflare` | Unverified | edge only, no pre-storage | Cloudflare's CSAM tool scans cached content at the edge (https://blog.cloudflare.com/the-csam-scanning-tool/). Hushloom serves media with `Cache-Control: private`, so the edge never sees it. Fail-closed returns `unavailable`; fail-open returns `clean` with `scan_ref = edge-only:not-pre-scanned`. |

Thorn Safer is a paid contract and has no adapter (**not built**).

### Verdicts

| Verdict | Meaning | Served |
|---|---|---|
| `pending` | Not scanned yet (default) | No |
| `clean` | Scanner found no match | Yes |
| `matched` | Scanner matched a known hash | No, ever |
| `unavailable` | Scanner could not answer | No |

A match is never overwritten. A later non-match verdict for the same asset updates only rows not already `matched` (`scan/index.ts:378`), and the caller is told `matched`, so nothing treats held evidence as unscanned. `recordDerivedScan` does the same for a poster (`scan/index.ts:456`): it returns `pending` while the parent is pending or matched, and `matched` if the poster itself is matched. Only the review queue changes a `matched` verdict.

### On a match (`recordVerdict`, once per asset)

1. Lock the owner's `users` row (`FOR NO KEY UPDATE`), then the asset (`FOR UPDATE`). This is the same order account deletion uses, so the two wait instead of deadlocking. If the asset is already `matched`, stop: one escalation and one flag per asset.
2. `scan_status = matched`, `legal_hold = true`.
3. Templates using the asset publicly are set to `removed`.
4. A moderation event `escalate` (open) with reason `csam_match` (or `abuse_match` for an abuse category), and details: asset id, sha256, source sha256, provider, ref, category, origin, owner id, job id, storage key.
5. Audit `scan.block`.
6. Account flag `csam_match` (or `manual_review` for the abuse category, which no current scanner returns).
7. For CSAM: `suspendForAbuse` (section 10). It suspends the account if it is active and unpublishes all its published templates. Only when this call is the one that suspends the account does it audit `user.suspend` and delete the account's push subscriptions and sessions (`src/server/safety/suspend.ts:41-44`). An account that is already suspended or deleted had them removed by the step that changed its status, and a session of an account that is not active signs no one in (section 10).

### Match recording retries

A failure to record a match must never leave the matched bytes deletable. Outside a caller's transaction, a match goes through `recordMatch` (`scan/index.ts:348-366`):

| Step | Behavior |
|---|---|
| Attempts | `recordVerdict` up to 3 times, waiting 200 ms x attempt between them. Each failure logs `<event>.match_record_failed`. |
| Fallback | If all attempts fail, set `legal_hold = true` on the asset and leave it `pending`. It is never served or purged, and `scripts/scan-backfill.ts` rescans it and opens the case. A failure here logs `<event>.match_hold_failed`. |
| Result | Always `matched`. The caller rejects the upload or fails the job. |

The worker logs these as `generation.*`; uploads, the backfill and the seed log them as `scan.*`.

### Legal hold

A held asset's file is never purged. Consent withdrawal, account deletion, unscanned-upload discards and attempt discards also leave its row alone. Deleting a creation marks a held asset deleted, but the purge still keeps its file. Both purges also skip any asset still `pending`, because its scan may be about to hold it, and they re-read each row under a row lock before deleting (section 12). Only the review queue lifts a hold.

### Review queue (`/admin/review`)

| Action | Input | Effect | Audit |
|---|---|---|---|
| Confirm | `reportRef` (3 to 120), `reportedTo` (`ncmec_cybertipline`, `iwf`, `other_authority`), `note` | Hold stays; event resolved; a `hold` event is written; `reportRef` is merged into the related flags | `scan.match_confirmed` |
| Clear (false positive) | `note` (at least 3) | If no other open escalation or confirmed case covers the same asset: asset set clean with `scan_ref = review-cleared:<id>` and hold lifted. Otherwise the asset keeps its verdict and hold. Either way an `approve` event is written and the flags tied to this escalation are cleared. The owner is reinstated only if no suspension cause remains: no open `csam_match` flag and no open admin suspension. | `scan.false_positive_cleared` (with `holdKeptFor` when the hold stayed), `user.reinstate` |

Removed templates are not restored on clear. A resolved item returns 409. The ordinary reports endpoint refuses escalations (409 `use_review_queue`). Filing the report with NCMEC or IWF happens outside the app; the app records the reference.

### Takedowns

Anyone can file at `/api/takedowns`. Signed-out requesters must give an email. `resolveTarget` accepts a UUID (output, template or asset) or a Hushloom link (`/templates/`, `/collection/`, `/api/media?k=`). Anything else, such as a malformed link or an id that matches nothing, is still filed. It is kept as a plain link (a `url` target) for a human (`resolveTarget`, `takedowns.ts:33-66`). A `url` target is resolved again only when an admin actions the request, and actioning it gives 422 `target_not_found` if it still points at nothing. The admin list puts urgent categories (csam, ncii, likeness) first, then oldest first, in pages of 100 with a total count.

| Admin action | Effect | Audit |
|---|---|---|
| Action | Removes the target: an output soft-deletes its outputs and job; a template is set `removed` with `deleted_at`; an asset removes its templates and soft-deletes its outputs. Then every byte-identical copy is taken down too (below). The SHA-256 of every removed file is added to `taken_down_hashes`. `csam`: every file gets `deleted_at` and `legal_hold` and its own `escalate` event (`csam_report`, provider `takedown`). Then, for each held file that has an owner, one `csam_match` flag tied to that file's escalation (`created_by` the admin) and one `suspendForAbuse` call (reason `takedown_csam`, the admin as actor), inside the per-file loop (`takedowns.ts:236-245`). An owner with several held copies gets several flags, one per escalation; the first call suspends the account and later calls find it already suspended. The account is reinstated only when every one of those cases is cleared in the review queue and no admin suspension remains (`suspensionCauses`, section 10). Other categories: unheld files are soft-deleted, and `ncii` and `likeness` files are purged at once. | `takedown.action` |
| Dismiss | Requires a note (422 `note_required`) | `takedown.dismiss` |

Actioning a target that resolves to nothing returns 422 `target_not_found` and changes nothing. The message asks the admin to remove the content by hand, then dismiss the request with a note.

**Copies** (`takeDownCopies`, `takedowns.ts:268-294`; `lockContent`, `takedowns.ts:302-304`). Publishing copies an output's bytes into new public assets, so the named file is rarely the only copy. The action takes a per-file lock (`lockContent`: a sorted `pg_advisory_xact_lock` per SHA-256), then finds every asset with the same SHA-256 on any account. Their outputs and jobs are soft-deleted and their templates set `removed` with `deleted_at`.

**Hash block** (`taken_down_hashes` insert at `takedowns.ts:218-219`; `isTakenDownOrHeld` at `takedowns.ts:311-321`, called by `publish.ts:76` and again inside the publish transaction at `publish.ts:179`). `isTakenDownOrHeld` is true when a file's SHA-256 is in `taken_down_hashes`, or any asset with that SHA-256 is on legal hold. A later publish of such a file gets 409 `taken_down`. The first check also writes an `auto_block` moderation event with reason `taken_down`; the re-check in the transaction only refuses.

### Reported templates

`/api/admin/reports/[id]` with `remove`:

| Report on | Effect |
|---|---|
| Template | Set `removed`; its poster and preview copies are soft-deleted. For reason `minor`, they are also put on `legal_hold`, and each gets a `csam_report` escalation (provider `report`) in the review queue. No flag is added. |
| Output | The output and its asset are soft-deleted. |

A remove also resolves every other open report on the same subject. A dismiss resolves only the one report. Both add a resolved moderation event and audit `moderation.remove` or `moderation.dismiss` (`admin.ts:116-166`).

### Publishing checks

`publishTemplate` checks before copying: 404, 409 `not_ready`, 403 `personal_media`, 422 `policy_blocked`, 409 `no_output`, 409 `not_cleared`, 409 `taken_down`. The public copies are written outside the transaction. Inside it, it takes `lockContent` on the files and re-checks them (`stillPublishable`: 404, `not_cleared`, `taken_down`), so a takedown and a publish of the same bytes never interleave. It inserts the rows, then reads the account `FOR NO KEY UPDATE`; a suspended account gets 403 `creator_suspended` ("This account is suspended, so it can't publish templates."). On any failure the copies are deleted.

`updateTemplate` locks the template row (`FOR UPDATE`) and writes only the fields sent, so a concurrent edit cannot undo a removal. Errors in order: 404, 403 `removed`, 422 `policy_blocked`. Setting `published` reads the account last (`FOR SHARE` when the template is not live) and refuses a suspended account with 403 `creator_suspended`.

### Prompt policy

`checkPrompt` (`src/server/safety/policy.ts`) runs regex categories (minors, non_consent, real_person, bestiality, incest, extreme_harm) over the text it is given, after normalizing leetspeak, separated letters and repeated characters. It runs at three points, and each block returns 422 `policy_blocked`:

| Where | What is checked | Moderation event |
|---|---|---|
| Draft, including derived drafts (`createDraft`, `src/server/generation/service.ts:196-208`) | Prompt, negative prompt, free-text settings | An `auto_block` event (subject `prompt`, the user's id), holding only the category and matched words. The 422 carries `details.category`. |
| Publish (`publishTemplate`, `src/server/templates/publish.ts:58-61`) | Title, description, tags, and the job's prompt, negative prompt and free-text settings | An `auto_block` event (subject `template`, the job's id), holding only the category and matched words. |
| Template update (`updateTemplate`, `src/server/templates/publish.ts:204-205`) | The title, description, tags and prompt sent | None. The request is refused and nothing is recorded. |

Saved presets are not checked. The composing copilot runs the same check on the prompt and negative prompt in the browser and shows a block as a hint (`src/lib/copilot.ts`); only the server checks refuse.

## 9. Installable web app and push

Hushloom ships as an installable web app rather than store apps. Apple's guideline 1.1.4 rejects overtly sexual or pornographic material (https://developer.apple.com/app-store/review/guidelines/), and Google Play prohibits sexual content and pornography (https://support.google.com/googleplay/android-developer/answer/9878810).

### Manifest (`public/manifest.webmanifest`)

| Field | Value |
|---|---|
| `id`, `start_url`, `scope` | `/` |
| `name`, `short_name` | Hushloom |
| `display`, `orientation` | standalone, any |
| `background_color`, `theme_color` | `#0f0a0d` |
| `categories` | entertainment, photo |
| Icons | 192 and 512 (any), 512 maskable, SVG |
| Shortcuts | "Make an image" (`/generate/image`), "Library" (`/collection`) |

The browser's own install prompt is suppressed (`beforeinstallprompt` is prevented). The install offer lives only in Settings under "On this device".

### Service worker (`public/sw.js`, version `v1`)

| Request | Rule |
|---|---|
| `/_next/static/*`, `/icons/*` | Cache first (`hushloom-static-v1`, at most 250 entries) |
| Navigation to a public page | Network first. Page HTML is never cached, so on failure it serves the cached `/offline` page, or an inline 503 page if that is missing |
| `/manifest.webmanifest` | Network first (`hushloom-shell-v1`); the cached copy on failure |
| Navigation under `/collection`, `/projects`, `/studio`, `/train`, `/settings`, `/admin`, `/favorites`, `/pricing`, `/auth`, `/verify` | Network only; never cached |
| `/api/*`, other origins, non-GET, `Range` requests | Not handled; the browser goes to the network |

`shouldCache` refuses non-200, opaque, redirected, `private` or `no-store` responses and anything under `/api`, and stores only `/_next/static/*`, `/icons/*` and the shell files (the manifest and icons) (`sw.js:62-68`). The install step precaches the manifest, icons and `/offline` (fetched without credentials, with its headers stripped) plus the static files `/offline` needs. The install step ends with `skipWaiting` (`sw.js:170`), so a new worker does not wait for old tabs to close. Activation deletes older `hushloom-` caches and calls `clients.claim` (`sw.js:175-185`). In development the worker is registered as `/sw.js?mode=dev` and caches nothing. `next.config.ts` serves `sw.js` with `no-cache`, `Service-Worker-Allowed: /` and a script CSP of `default-src 'self'; script-src 'self'`.

### Offline guard

`OfflineGuard` (`src/components/offline.tsx`) wraps actions that need the network in a `fieldset` that is disabled while offline: Make and the cost sheet's Confirm on the create panel, Retry and its Confirm in the Library, Branch, Continue and the cost sheet's Confirm on a project, and Buy on pricing. On a creation's page it covers only the Confirm in the cost sheet. Retry, Variation, Continue and Extend there use `disabled={!online}` instead, and the other buttons (Save, Folder, Preset, Publish, Delete, and Cancel while running) stay enabled offline (`src/components/creation-detail.tsx`). The job tray pauses polling while offline. Background sync is **not built**.

### Push (Needs keys)

Push is on only when `VAPID_PUBLIC_KEY` (65 bytes), `VAPID_PRIVATE_KEY` (32 bytes) and `VAPID_SUBJECT` (`mailto:` or `https:`) are valid. Otherwise `/api/push/public-key` reports the reason: `not_configured`, `incomplete`, `invalid_keys` or `invalid_subject`.

Payload policy: the payload is built from the outcome and job id only. It never carries a prompt, a title, an image or a user name.

```json
{ "title": "Hushloom", "body": "Your creation is ready", "url": "/collection/<jobId>", "tag": "job-<jobId>" }
```

The other bodies are "A creation didn't finish" and "A creation was cancelled". The service worker shows only whitelisted fields and opens only same-origin URLs. Sends use TTL 12 h, normal urgency, `aes128gcm` and a 10 s timeout.

### Subscription lifecycle

| Event | Effect |
|---|---|
| Subscribe | Endpoint must be HTTPS on a known push service (`fcm.googleapis.com`, `android.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`), with no port or credentials; `p256dh` must be 65 bytes and `auth` 16 bytes. Upserted by endpoint and tied to the current session. Audit `push.subscribe` on insert only. |
| Delivery | Only when the user's `notify_on_finish` preference is on and the subscription's session is still live. |
| Push service says 404 or 410 | Subscription deleted. |
| Other failure | `failed_at` set; kept for the next attempt. |
| Success | `last_used_at` set. |
| Unsubscribe | `DELETE /api/push/subscriptions` removes only your own endpoint. Audit `push.unsubscribe`. |
| Logout | That session's subscriptions are removed. |
| Sign out everywhere, account deletion, admin suspension | All of the user's subscriptions are removed (`destroyAllSessions`). |
| Automatic suspension | `suspendForAbuse` deletes the user's push subscriptions and sessions itself, only when it is the call that suspends the account (`suspend.ts:41-44`). |
| Session row deleted | Cascades to its subscriptions. |
| Browser rotates the subscription | `pushsubscriptionchange` re-subscribes; the client also re-binds once per tab session. |

## 10. Authentication and authorization model

### Sessions and cookies

| Item | Rule |
|---|---|
| Password hashing | bcrypt, cost 12. Login compares against a dummy hash when the account does not exist, so timing does not reveal accounts. |
| Login eligibility | Status `active` and `deleted_at` null. Suspended and deleted accounts cannot sign in. |
| Session token | 32 random bytes, base64url, sent in the `hl_session` cookie. Only its SHA-256 hash is stored. |
| Cookie | `httpOnly`, `SameSite=Lax`, `Secure` in production, path `/`, expires with the session |
| Lifetime | `SESSION_TTL_DAYS` (default 30) from sign-in. There is no sliding renewal. Expired rows are ignored but never deleted. |
| Lookup | Each request joins session, user and profile, requiring an unexpired session and an active, undeleted user; the result is cached per request. |
| Age gate cookie | `hl_age_ok`, httpOnly, Lax, 30 days. It hides the adults-only interstitial. Without it set to `1`, an anonymous visitor gets no media URLs from any page or API (`access.ts:20-24`). It does not replace a provider check. |
| Return path | `/auth?next=` is resolved against the site; anything that leaves the origin or starts with `//` becomes `/`. |

### CSRF and Origin

Session cookies are `SameSite=Lax`, so other sites cannot send them on cross-site POSTs. The middleware also refuses writes (POST, PUT, PATCH, DELETE) to `/api/*` whose `Origin` header differs from both the request origin and `APP_URL` (403 `bad_origin`, `isCrossSiteWrite` in `src/server/origin.ts`). Requests without an `Origin` header are allowed. Webhooks are exempt because they authenticate with signatures.

The middleware does not run on `POST /api/uploads` and `POST /api/characters`: Next.js hands a route only the first 10 MB of a body that middleware has seen, which would cut off any larger upload. Those two routes make the same Origin check themselves (`assertSameOrigin`) and read the form through `readForm`, which answers 413 `too_large` as soon as the declared or streamed size passes the limit (the file limit plus 1 MB: 101 MB for uploads, 21 MB for characters) and 400 `invalid_form` for a body that is not a complete form.

### Rate limits and client address

Source: `src/server/redis.ts`, `src/server/request.ts`. Every limit is a fixed window in Redis. `rateLimit` runs `INCR` and `EXPIRE key window NX` in one `MULTI` transaction (Redis 7.0 or later), so a counter can never be left without an expiry. It uses the request Redis client (one retry, 2 s command timeout).

| Bucket | Limit | Window | Used by |
|---|---|---|---|
| `signup:<address>` | 10 | 1 h | Signup |
| `login:ip:<address>` | 30 | 15 min | Login |
| `login:email:<trimmed, lowercased email>` | 10 | 15 min | Login and `DELETE /api/me` (`passwordAttemptAllowed`) |
| `takedown:user:<id>` or `takedown:ip:<address>` | 10 | 1 h | Takedown requests |
| `age-verify:<id>` | 10 | 1 h | Age verification start |
| `character:<id>` | 10 | 1 h | Character photos |
| `report:<id>` | 20 | 1 h | Template reports |
| `upload:<id>` | 40 | 1 h | Uploads |
| `draft:<id>` | 30 | 1 min | POST `/api/generations` (derive has no draft limit) |
| `checkout:<id>` | 10 | 10 min | Checkout |
| `push:subscribe:<id>` | 60 | 1 h | Push subscribe |

**Fail closed.** If Redis cannot answer, `rateLimit` logs `rate limiter unavailable` and throws 503 `unavailable` ("We can't take this right now. Try again in a minute."). Nothing is let through unlimited. The log line never includes the bucket, because a bucket can hold an email address.

**Shared password budget.** `login:email` is the per-account budget for password guesses. `DELETE /api/me` checks it after the body parses and before bcrypt runs, and answers 429 "Too many attempts. Wait 15 minutes and try again." when it is spent. The email is trimmed and lowercased first, so padding it does not open a new bucket.

**Client address** (`clientIp`). `TRUSTED_PROXY_HOPS` (default 0) says how many reverse proxies in front of the app append to `X-Forwarded-For`.

| Case | Key |
|---|---|
| `TRUSTED_PROXY_HOPS=0` (no proxy) | `local` for every request. Next.js writes the connection's address into the header only when the request has none, so a client that reaches the app directly could name its own. Each per-address limit then holds for the whole site. |
| No `X-Forwarded-For` header | `local`. |
| Otherwise | The entry added by the outermost trusted proxy: `chain[max(length - hops, 0)]`, the n-th entry from the right. Entries to its left are whatever the client sent and are ignored. |

`addressKey` normalizes the chosen entry: it drops a port (`[v6]:port`, `v4:port`), keys an IPv4-mapped IPv6 address as IPv4, keys any other IPv6 address by its `/64` (`xxxx:xxxx:xxxx:xxxx::/64`), and cuts anything that is not an address to 64 characters. The compose file publishes web on 127.0.0.1 by default (section 1), and no proxy is bundled. An operator who puts the app behind a proxy must set `TRUSTED_PROXY_HOPS` to match.

### Roles

| Role | How it is set | Permissions |
|---|---|---|
| member | Signup | Everything a signed-in user can do on their own data. |
| creator | Set automatically on first publish | A label only. It grants no extra permission. |
| admin | Set in the database (the seed creates one) | Admin pages and APIs; can edit any template. Non-admins get 404 from admin APIs and pages. |

Service functions filter by owner. Data that is not yours returns 404, the same as data that does not exist. The end-to-end journey checks this for creation pages, GET, derive and DELETE. VIP templates need an active pass (403 `vip_required`), and a viewer without a pass gets a VIP template's model key but not its prompt, negative prompt or settings (`src/app/templates/[id]/page.tsx`). Age gates are in section 7.

### Suspension

Two paths suspend an account. Both leave it unable to sign in or publish.

| Path | Trigger | Effect |
|---|---|---|
| Admin (`suspendUser`, `src/server/admin.ts`) | `POST /api/admin/users/[id]/suspend` | Sets `status = suspended` if it is not already. Records a `manual_review` flag ("Suspended by an admin: <reason>") with `details.source = admin_suspension`. Unpublishes the account's published templates and audits `user.suspend` with the count. Then `destroyAllSessions` deletes every session and push subscription. Returns 404 for a missing or deleted user, or one already under an admin suspension. An account suspended only by a CSAM match can still get an admin suspension, so clearing that match later does not reinstate it. |
| Automatic (`suspendForAbuse`, `src/server/safety/suspend.ts`) | A CSAM scanner match, or an actioned CSAM takedown | Sets `status = suspended` where it is active. Unpublishes all the account's published templates. If it suspended the account, it audits `user.suspend` with `unpublishedTemplates`, then deletes its push subscriptions and sessions. |

`suspensionCauses` lists the open reasons for a suspension: open `csam_match` flags and open flags with `details.source = admin_suspension`. Only the review queue reinstates an account, and only when that list is empty after a false-positive clear (audit `user.reinstate`). No route reverses an admin suspension (**not built**).

## 11. Credit ledger rules

Source: `src/server/credits/ledger.ts`.

`applyMovement(tx, {userId, kind, availableDelta, reservedDelta, idempotencyKey, jobId?, paymentEventId?, note?})` is the only code that changes a balance. It runs inside the caller's transaction:

1. Upsert the `credit_accounts` row and lock it `FOR UPDATE`.
2. If a ledger row with the same `idempotency_key` exists, return `{applied: false}` and change nothing.
3. Compute the new balances. `available < 0` throws `InsufficientCreditsError` (402). `reserved < 0` throws an invariant error (500).
4. Update the `credit_accounts` row, then insert the ledger row with both deltas and both resulting balances, in the same transaction (`ledger.ts:56-68`).

### Movement kinds and keys

| Kind | available | reserved | Idempotency key | Written by |
|---|---|---|---|---|
| `signup_grant` | + | 0 | `signup:<userId>` | Signup, when `SIGNUP_GRANT_CREDITS` > 0 (default 0) |
| `purchase` | + | 0 | `<provider>:<providerEventId>` | Pack payment |
| `subscription_grant` | + | 0 | `<provider>:<providerEventId>` | Pass start (if it grants) and each renewal |
| `reserve` | minus cost | plus cost | `job:<jobId>:reserve` | Confirm |
| `settle` | 0 | minus cost | `job:<jobId>:close` | Job completed |
| `release` | plus cost | minus cost | `job:<jobId>:close` | Job failed or cancelled |
| `admin_adjust` | plus or minus | 0 | `admin:<adminId>:<clientKey>` | `/api/admin/credits` |
| `refund` | minus reversed | 0 | `refund:<provider>:<eventId>` | Provider refund |
| `chargeback` | minus reversed | 0 | `chargeback:<provider>:<eventId>` | Provider chargeback |
| `refund` or `chargeback` (debt collection) | minus taken | 0 | `debt:<flagId>:job:<jobId>` | `releaseJob`, for a job named on an open `credit_debt` flag |

The seed script also grants demo credits with keys `seed:<memberId>`.

Settle and release share one key, so a reservation can close exactly once: whichever runs first wins, and the other is a no-op. Retries keep the reservation in place; credits move only when a job reaches a terminal state.

### Collecting held debt (`ledger.ts:98-170`)

When a refund or chargeback finds the credits it should take back held by creations in progress, the `credit_debt` flag records them (section 6). `releaseJob` then collects:

1. Read the open `credit_debt` flags whose `heldJobIds` include this job and whose `outstanding` is above 0. Lock the original payments those flags name (`originalEventId`, in id order; the same rows a clawback locks), then the flags themselves.
2. Apply the release.
3. For each flag, take `min(released credits left, outstanding)` back with kind `refund` or `chargeback`, key `debt:<flagId>:job:<jobId>`, and the note "Held by a creation when the payment was reversed; taken back when it was released".
4. Update the flag's `outstanding` and `collected`, and record the amount on the reversal row: its `credits` (stored as a negative number) drops by it, `metadata.creditsReversed` grows by it and its `shortfall` shrinks by it, so a later reversal of the same payment owes only the rest.

A job that completes settles its reservation normally; that part of the debt stays on the flag for an operator.

### Locks

| Lock | Taken by | Purpose |
|---|---|---|
| `credit_accounts` row `FOR UPDATE` | Every `applyMovement`; `confirmJob` before it counts active jobs | One balance change at a time per user; the active-job cap holds under parallel confirms. |
| Advisory lock per payment reference | `processPaymentEvent` | A payment and its reversal or cancellation never run side by side. |
| Original `payment_events` row `FOR UPDATE` | Clawback, debt collection | Concurrent reversals of one payment cannot each take back the full grant. |

### Invariants

| Invariant | Enforced by |
|---|---|
| `available >= 0` and `reserved >= 0` | Check constraints and the `applyMovement` checks |
| Each ledger row is applied at most once | Unique `idempotency_key` (global) |
| Ledger rows explain every balance | `available_after` and `reserved_after` on every row, written under the row lock |
| A job holds credits only while queued or processing | Reserve at confirm, settle or release at the terminal state |
| A refund never takes more than was granted | Pro rata target capped at the grant, minus earlier reversals |
| A refund never makes `available` negative | Reverses `min(available, owed)`; the shortfall becomes a `credit_debt` flag |
| Credits held when a payment was reversed are not handed back | Collected on release under `debt:<flagId>:job:<jobId>` |

## 12. File storage

Source: `src/server/storage/index.ts`, `src/server/media.ts`.

### Drivers

| Driver | Status | Behavior |
|---|---|---|
| `local` (default) | Operational | Files under `STORAGE_LOCAL_DIR` (default `.storage`; absolute path required in production). `safeLocalPath` checks the key against a pattern and confirms the resolved path stays inside the directory. |
| `s3` | Unverified (never run, including against the bundled MinIO; the tests use an in-memory stand-in for the client) | AWS SDK v3; region default `auto`; path-style addressing when an endpoint is set. `size` uses `HeadObject` and `read` uses a ranged `GetObject`. The bucket stays private and is never linked to: its files are served through `/api/media` like local ones, so the serve-time checks apply to both drivers. |

Interface: `put`, `get`, `size`, `read` (a stream of a byte range), `delete`, `signedUrl`.

### Keys

`<scope>/<ownerId>/<uuid>.<ext>`. Scopes in use: `uploads`, `outputs`, `templates` (public copies). The `avatars` scope is declared but unused. Purged assets keep their row with `storage_key = purged/<id>` and `bytes = 0`.

### Signed URLs

`assetUrl` returns no URL for an asset that is deleted or not `clean`. A private asset gets a URL only for its owner.

| Asset | TTL |
|---|---|
| Public (template copies) | 3600 s |
| Private | `MEDIA_URL_TTL_S`, default 300 s |

URLs (both drivers) are `/api/media?k=<key>&e=<expiry>&s=<sig>[&d=<name>]`, where the signature is HMAC-SHA256 over `key\nexpiry\ndownload` with `MEDIA_SIGNING_SECRET`. The expiry is rounded up to the next boundary of a tenth of the TTL (`ceil((now + ttl) / w) x w`, `w = max(1, floor(ttl / 10))`) so URLs stay stable for browser caching within that window. A link therefore lives between one TTL and 1.1 TTL (300 to 330 s private, 3600 to 3960 s public). Links are bearer links: anyone holding one can open it until it expires, as the Policies page says; they are not tied to a viewer.

`/api/media` checks the signature and expiry (403 "Link expired or invalid."), then re-reads the asset row and refuses anything deleted or not clean (404). A public asset is served only while a published, undeleted template uses it as poster or preview; otherwise only to its owner (read from the session cookie), so a removed, unpublished or suspended creator's template stops serving through links issued earlier. If the driver cannot report the file's size, the answer is 404. It answers with `Cache-Control: private, max-age=<seconds left>`, `X-Robots-Tag: noindex`, a `Content-Disposition` when a download name is set, and supports `Range` (206, or 416 when unsatisfiable). It reads only the requested bytes (a file stream from an offset, or an S3 ranged `GetObject`), never the whole file for a range. The same route serves S3 media, so a removed, held or matched asset stops being served at the next request through any driver, including through links issued earlier. The cost is that S3 media traffic passes through the web process. Next's image optimizer is off (`images.unoptimized` in `next.config.ts`, so `/_next/image` answers 404): it would fetch a `/api/media` link once and keep its own copy for at least a minute in `.next/cache/images`, outside these checks.

### Uploads

| Type | Limits | Processing |
|---|---|---|
| Image | 20 MB and 40 megapixels (413 `too_large`, read from the header before anything is decoded); JPEG, PNG or WebP, told apart by the file's first bytes before any decoder runs (anything else, SVG included, is 415 `unsupported_type` without being parsed, since an SVG's cost is in its document, not its pixels); only the first frame of an animated or multi-page file | Re-encoded to WebP quality 92 with EXIF rotation applied, which strips EXIF and GPS, flattened onto black (so an alpha channel cannot hide content from the scan), and downscaled to fit 4096 px. A short side under 512 px adds the warning `low_resolution`. Every decode of outside bytes (uploads, the PhotoDNA copy, provider outputs, poster frames) uses the same limits (`untrustedImage` in `src/server/images.ts`). |
| Video | 100 MB; must contain an `ftyp` box (else 415); at most 60 s (422 `too_long`) and 4096 px on a side (413 `too_large`), the most the abuse scan covers | Metadata and chapters stripped with `ffmpeg -map_metadata -1 -map_chapters -1 -c copy -movflags +faststart`, then probed with ffprobe. Unreadable files get 415; a missing ffmpeg or ffprobe gets 503 `video_processing_unavailable`. |

Stored under `uploads/<userId>/<uuid>.(webp|mp4)` with a consent record (`upload_subject`, or `likeness` for a character reference). After the scan, the upload is purged at once if it was deleted meanwhile (410 `upload_removed`). Discarding an unscanned upload skips held assets.

### Posters

For every video output the worker extracts a frame at 0.5 s and stores it as WebP quality 82. Publishing copies the output (and poster) bytes into new public assets under `templates/`; the user's original stays private.

### Purge

Both purge paths select only assets that are soft-deleted, not yet purged, not on legal hold, and not `pending` (`media.ts:229`, `media.ts:253`). A file with no verdict yet may still be about to be held as evidence; `acceptUpload` purges an upload removed mid-scan once its verdict is in, and the scan backfill rescans anything else left pending.

| Path | When | Rule |
|---|---|---|
| `purgeDeletedMedia(30)` | Worker, hourly | Up to 500 assets per run that were soft-deleted more than 30 days ago. |
| `purgeAssetsNow` | Immediately | Consent withdrawal, `ncii` and `likeness` takedowns, uploads that could not be scanned (fail-closed), uploads removed mid-scan, files from a failed attempt, discarded outputs. |

Each row is purged in its own transaction (`purgeRows`, `media.ts:263-284`). It re-selects the row `FOR UPDATE`, requiring that it is still deleted, still has the same key and is still not held. Only then does it delete the file and set `storage_key = purged/<id>` and `bytes = 0`. A hold placed after the batch was chosen wins, and a hold placed during the delete waits for it. A failure is logged as a warning and the row is left for the next run.

## 13. Privacy and consent architecture

### Consents

| Kind | Recorded when | Withdrawable |
|---|---|---|
| `terms`, `adult_attestation` | Signup | Only by deleting the account (422 `use_account_deletion`) |
| `upload_subject` | Each upload (`consent="true"` required; the `subject` label is optional and stored as null when none is sent, `src/app/api/uploads/route.ts:23`) | Yes |
| `likeness` | Each character reference (`consentAdult` and `consentLikeness`) | Yes; deleting the character withdraws it |
| `training_data` | Never (declared, not used) | n/a |

Withdrawing an upload or likeness consent (`withdrawConsent`) soft-deletes the character references under it, every job and output that used those uploads or references (setting `cancel_requested` on every affected job, whatever its state, `src/server/auth/account.ts:162`), and the media itself (except legal hold). It audits `consent.withdraw` and purges the files at once. A running job also re-checks the likeness consent before sending the reference to a model.

### Likeness

A character reference requires a likeness consent stating the person is an adult who agreed. Templates can never be published from a creation that used an upload or a character (403 `personal_media`). The demo provider composites a reference into its placeholder; it does not produce a likeness.

### Account deletion

`DELETE /api/me` with the password, inside the shared password budget (section 10):

| Data | What happens |
|---|---|
| `users` | Status `deleted`, `deleted_at` set, email replaced with `deleted-<uuid>@invalid`, password hash replaced with `!`, `date_of_birth` set to null. `age_assured_at` and `age_assurance_method` are kept as the record that age was checked. |
| Profile | Handle set to `deleted_<full user id>`, display name "Deleted account", bio cleared. The full id cannot be claimed first, because chosen handles are at most 24 characters. |
| Media | Soft-deleted (except legal hold); files purged by the worker after 30 days |
| Jobs and outputs | Soft-deleted; jobs also get `cancel_requested`, so the worker stops any that are running |
| Templates | Set to `removed` with `deleted_at` |
| Discovery events | Deleted |
| Consents | Marked withdrawn |
| Passes | Every pass not already `canceled` is set to `canceled`. This build has no processor cancel call, so for each pass that would rebill (not sandbox, not already `non_renewing`) a `manual_review` flag asks an operator to cancel it at the processor and refund any later charge. Details: `reason: account_deleted`, `provider`, `subscriptionRef`, `planKey`, `status`. A renewal that still arrives is held, not granted (section 6). |
| Sessions and push subscriptions | Deleted (`destroyAllSessions`) |
| Audit | `account.delete` with `passesEnded` |

Migration 0003 nulled the date of birth of accounts deleted before it existed.

### History and personalization

Turning history off clears the user's discovery history. `DELETE /api/me/history` clears it on demand (audit `history.clear`). With personalization off, For You falls back to trending.

### What logs may contain

| Rule | How |
|---|---|
| No prompts, media or secrets in logs | Log lines carry ids, codes and counts. Push logs carry job id, outcome and counts, never endpoints. |
| No emails in logs | The rate-limit failure log never includes the bucket, which can hold an email (`redis.ts:50`). Signup dates are checked before insert, so an impossible date no longer fails in the database and logs the row. |
| Query parameters redacted | `redactQueryParams` replaces everything from Drizzle's `params:` line to the end with `[redacted]`, in messages and stacks. The serializer also redacts string fields. |
| Driver detail redacted | `scrubQueryParams` walks the whole cause chain (with a loop guard). It sets the Postgres driver's `detail` to `[redacted]`, because it can repeat a row's values, and redacts each `message`, `stack` and `params`. |
| Rejected values redacted | For SQLSTATE class 22 errors (data exceptions), the quoted value in the message becomes `[redacted]` (`withoutRejectedValue`). |
| Next.js prints scrubbed | `DrizzleQueryError` is patched to scrub itself whenever it is inspected (`scrubWhenInspected` in `src/server/db/index.ts`), so Next.js's own error printer prints the redacted form. `onRequestError` logs "request error" with the path without its query, then scrubs the error. |
| Blocked prompts | Only the category and matched words are kept, in `moderation_events`. |
| Route errors | Logged with the path (no query string) and the redacted error: its name, message, stack and direct cause, as the serializer writes them (section 14). Never the body. |
| Age return route | Logs only the error code and the error's name. |

Known exceptions in this snapshot: a Replicate 422 or other unmapped 4xx response body (up to 300 characters, which can echo the prompt) is part of the provider error message that `generation.provider_error` logs; Yoti error bodies (up to 300 characters) are logged in the warning `yoti request failed`.

### Error webhook redaction

The error webhook (section 14) never sends request bodies. Each event carries only `source`, `time`, `message`, `error` (name, message, stack, digest, cause), `route`, `path`, `method`, and context limited to `jobId`, `verificationId`, `provider`, `outcome` and `routeType`. Messages and stacks go through `redactedMessage` and `redactStack` (the same redaction as the log), the error's message (and its cause's) is clipped to 1000 characters and its stack to 8000. The log message, paths and context values are clipped to 200, and the method to 16.

## 14. Error handling and observability

### Error handling

| Layer | Behavior |
|---|---|
| API routes | `route()` maps errors to the envelope in section 3. Unknown errors become 500 `internal` and are logged with the path and the redacted error. |
| Generation | Provider errors are classified as retryable or not; users see fixed sentences that say credits were returned. Every failure path releases the reservation. |
| Worker | Never relies on BullMQ retries. Crashes are logged; `reconcile()` recovers stuck jobs. |
| Rate limits | Fail closed with 503 `unavailable` while Redis cannot answer; logged at error level, so the error webhook fires. |
| Notifications | Never throw; failures are logged and swallowed. |
| Pages | App Router `error.tsx`, `global-error.tsx` and `not-found.tsx` at the root. `loading.tsx` exists only on list pages: `(home)`, `collection/(list)`, `projects/(list)`, `explore` and `favorites`. Item pages have none, so a missing or private item page answers a real 404. |

### Hydration (`src/components/shell.tsx`)

Next.js 15.5.27 bundles a React 19.2 canary with a hydration replay bug. On a cold load, the page's part of the RSC payload can still be resolving when React hydrates the shell, so the element that holds it suspends. React 19.2 replays a suspended host element without rewinding its hydration cursor. It then finds the element's own first child where the element should be and throws error #418 (a hydration mismatch). React throws away the server HTML and renders the whole document again on the client.

The workaround: the shell passes the page through `PageSlot`, a component that only returns its children. The element that suspends is then a component, and replaying a component leaves the cursor alone. The markup does not change. In the visual review (V-B-23 in `notes/analysis/visual/visual-review.json`), 1 in 130 cold loads threw with the browser cache off. Under Playwright request interception, which turns the cache off, 7 in 100 loads of ten main routes threw before the workaround and 0 in 100 after. React 19.3 fixes the replay itself. Upgrading Next.js to a release that bundles React 19.3 or later would remove the cause; that is a separate dependency decision, open in `notes/progress.md`.

A separate cause was fixed earlier, in the launch journey (`11ad512`): clock and locale text that differed between server and browser broke hydration. An end-to-end test now checks that pages with relative times and dates hydrate with the device clock 10 minutes ahead (section 16).

### Logging (`src/server/log.ts`)

One JSON line per entry: `{t, level, msg, ...fields}`. `warn` and `error` go to stderr, the rest to stdout. Errors in fields are serialized with name, redacted message, redacted stack and cause; string fields are redacted too (section 13). Under test only errors print unless `LOG_TESTS` is set.

### Error webhook (`src/server/observability.ts`)

When `ERROR_WEBHOOK_URL` is set, every `error`-level entry is posted as one JSON event. The web app installs it in `src/instrumentation.ts` (source `web`) and the worker at startup (source `worker`). In the web app the URL is read on its own when the rest of the configuration fails its check (`errorWebhookUrlAlone()`), so the webhook is still installed and reports the failing requests that are logged (section 1, Configuration, says which are). The worker reads its configuration before it installs the webhook, so a worker that fails the check exits without posting anything. Delivery is fire-and-forget with a 3 s timeout and at most 30 events per minute; dropped events are counted. Delivery failures produce warnings that never include the URL. Next's `onRequestError` hook logs the failing path without its query string (Node runtime only).

### Health

| Check | Endpoint | Meaning |
|---|---|---|
| Web | `GET /api/health` | 200 when Postgres answers `select 1` and Redis answers `PING` (request client, 2 s timeout); 503 otherwise. Used by the web image's `HEALTHCHECK`. |
| Worker | `GET /health` on `WORKER_HEALTH_PORT` (3901 in the images and e2e) | 200 while the BullMQ worker is running. |

### Audit log

Every privileged or sensitive change writes `audit_logs`: `account.create`, `account.delete`, `age_verification.pending`, `age_verification.verified`, `age_verification.failed`, `consent.withdraw`, `creation.delete`, `credits.adjust`, `flag.clear`, `history.clear`, `model.configure`, `moderation.remove`, `moderation.dismiss`, `payment.<type>`, `profile.update`, `push.subscribe`, `push.unsubscribe`, `scan.block`, `scan.false_positive_cleared`, `scan.match_confirmed`, `sessions.revoke_all`, `takedown.action`, `takedown.create`, `takedown.dismiss`, `template.publish`, `template.update`, `user.reinstate`, `user.suspend`.

Metrics, tracing and dashboards are **not built**. The error webhook is the only alerting path.

## 15. Security

### Threat model summary

| Threat | Controls in the code | Gaps observed in the code |
|---|---|---|
| Minors using the service | Real date of birth at signup (under 18 refused, nothing stored), adult attestation, adults-only interstitial that also withholds media from anonymous visitors, provider age check in required jurisdictions on every create, upload, confirm, download and publish path, explicit media withheld until checked, sandbox results ignored on a live site | Geo headers are trusted as sent. An unknown location is allowed by default (`AGE_VERIFICATION_FAIL_CLOSED=false`, kept by decision). Sandbox and Yoti are the only providers and Yoti is unverified. Every public template is treated as explicit. |
| Sexual content involving minors | Prompt policy, hash scanning of every upload and output before display, whole-clip video sampling, fail-closed scanning, match recording with retries and a hold fallback, legal hold, automatic suspension, review queue with report reference, takedowns that reach every byte-identical copy and block the hash | Dev scanner only matches test hashes; PhotoDNA is unverified; the Cloudflare tool sees nothing pre-storage. Near-duplicates are not matched. A taken-down file can still be made again privately; only publishing checks the hash. A scanner match on a public copy does not reach other copies. |
| Non-consensual and real-person content | Prompt policy categories, likeness consent, consent withdrawal that deletes derived work, `personal_media` publish block, takedowns with immediate purge for NCII and likeness | Policy is keyword-based. |
| Account takeover | bcrypt cost 12, constant-time miss, login limits per client address and per account, shared password budget for account deletion, hashed session tokens, httpOnly cookies, sign out everywhere, same-origin `next` redirects | No multi-factor authentication or password reset flow (**not built**). Ten wrong guesses from anyone lock an account's sign-in and deletion for 15 minutes (R05-H6). Signup reveals that an email exists (409 `email_taken`, R05-H7). |
| Cross-site request forgery | SameSite=Lax cookies; Origin check on API writes | Missing `Origin` is allowed. |
| Insecure direct object reference | Owner filter in every query; 404 for not-yours; admin routes 404 for non-admins | |
| Media leakage | Private by default, HMAC-signed links that live at most 1.1 x TTL, serve-time scan, deletion and template-status re-check on every request for both drivers (S3 goes through `/api/media`), `Cache-Control: private`, `noindex`, EXIF/GPS and video metadata stripped, image optimizer off | Links are bearer links until they expire. S3 traffic passes through the web process. |
| Payment fraud and replay | Signature or secret checks per provider, required CCBill token, exact-price and price-point checks, holds for review, 5-minute window on the sandbox, unique event ids, advisory locks, ledger idempotency keys, chargeback flag checked at checkout and again when a sale lands | CCBill and Segpay checks follow public docs and are unverified. Four go-live questions remain (below). |
| Credit abuse | Row-locked ledger, non-negative checks, cost confirmation, active-job cap checked under the account lock, draft rate limit, held credits collected after a reversal | |
| Service worker caching private data | Private prefixes network-only, `/api` never cached, `shouldCache` refuses private and no-store responses | |
| Secret and data leakage in logs | Redacted query parameters through the whole cause chain, driver `detail` and rejected values redacted, scrubbed Next.js prints, no buckets or emails, whitelisted webhook context, no bodies | Replicate 422 and other unmapped 4xx bodies and Yoti error bodies reach logs. |
| Abuse of resources | Decoder limits on every untrusted image, video length and size limits, bounded frame sampling with two ffmpeg threads, ranged media reads, upload size checked while streaming, Redis calls time out | |
| Clickjacking and sniffing | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera, microphone and geolocation, `X-Robots-Tag: noindex, nofollow`, `poweredByHeader: false` | No page Content-Security-Policy and no HSTS header (**not built**). |
| Misconfigured live deployment | The configuration check rejects the dev scanner and sandbox age checks on a live site while enforcement is on: the worker exits at load, and the web app boots but fails every request that reads the configuration (section 1); sandboxes refuse to run live; signing secret required in production; the seed exits 1 on a live site (`seed.ts:42-44`); compose publishes web on 127.0.0.1 by default; `.env` files kept out of git and images; CI checkout keeps no credentials | A web app that fails the check still boots; only its 503 health check and its failing requests show it. No reverse proxy is bundled, and `TRUSTED_PROXY_HOPS` must be set to match one. Compose Redis has no password (not published). Images are pinned by tag, not digest. Web image server files are owned by the runtime user. First-party GitHub actions are pinned to tags, not SHAs. |

### Other observations from the code

- No route reverses an admin suspension.
- Under fail-open scanning, a generation output can be charged but never served.
- `CCBILL_DATALINK_USER`, `CCBILL_DATALINK_PASSWORD` and `CLOUDFLARE_SCAN_WEBHOOK_SECRET` are declared but unused.
- Every public template is treated as explicit for age gating.
- A cancel while processing still sends a push notification.
- The MinIO image under the `s3` profile is a third-party fork (`pgsty/minio`).
- Deleting an account while an edit to one of its templates is being published can deadlock. Postgres aborts one of the two transactions.
- When the configuration fails its zod schema, the web app's API routes answer 422 `invalid_input` with the failing variable names in `details` and log nothing (section 1). The review noted this under I05 and left it unfixed (`notes/analysis/review/fix-results.json`).

### Adversarial review

**Method.** Seven finders worked on a frozen snapshot at `f8d5ef3` and returned 62 raw findings (`notes/analysis/review/raw-findings.json`). The triage agent's output was withheld by the platform, so the main session triaged by hand. After merging duplicates, 49 findings remained (`triage.json`).

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 12 |
| Medium | 22 |
| Low | 14 |
| **Total** | **49** |

By area: payments 12, scan 11, age 8, auth 7, moderation 7, generation 4.

One fix agent took each area. Each finding got a test that failed on the old code and passes now, with one commit per finding. The infra fixer's own pass found 12 more (I01 to I12: 2 high, 2 medium, 8 low). It fixed I01 to I08, left I09, I10 and I11 by decision, and refuted I12 (MinIO ports bind to 127.0.0.1, and the bucket-init job exits without keys).

| ID | Severity | Found at `f8d5ef3` | Where the current behavior is described |
|---|---|---|---|
| R01 | Critical | CCBill: paying for the cheapest item credited any pack or pass | Section 6, what the processor charged decides |
| R02 | High | Segpay price-point check failed open | Section 6 |
| R03 | High | The stored jurisdiction overrode the request's location | Section 7, `requirementFor` |
| R04 | High | `/api/characters` skipped the age gate | Section 7, gating |
| R05 | High | Brute-force limits bypassed by email padding and spoofed `X-Forwarded-For` | Section 10, rate limits |
| R06 | High | Video scan covered only the first 30 s | Section 8, video sampling |
| R07 | High | An alpha channel hid content from the scan | Section 12, uploads (flattened onto black) |
| R08 | High | Takedowns removed only public copies | Section 8, takedowns |
| R09 | High | Image decompression bomb | Section 12, uploads (decoder limits) |
| R10 | High | A refund that arrived before its purchase was dropped | Section 6, pending reversals |
| R11 | High | `updateTemplate` wrote back a stale status | Section 8, publishing checks |
| R12 | High | A failed match record deleted the matched bytes | Section 8, match recording retries |
| R13 | High | S3 links skipped serve-time checks | Section 12, signed URLs |
| R14 | Medium | A US location without a state failed open; derive dropped the state | Section 7 (unknown locations, derive passes the region) |
| R15 | Medium | The user's own back catalogue was not gated | Section 7, gating |
| R16 | Medium | A sandbox `verified` was honored on a live site | Section 7 |
| R17 | Medium | Credits held by creations were not clawed back | Section 11, collecting held debt |
| R18 | Medium | Concurrent reversals each clawed back the full grant | Section 6, clawback step 3 |
| R19 | Medium | CCBill replay key used unsigned fields | Section 6, event ids |
| R20 | Medium | CCBill without a token silently dropped reversals | Section 6, providers |
| R21 | Medium | Clearing a false positive lifted an admin suspension | Section 10, suspension |
| R22 | Medium | Handle squatting blocked account deletion | Section 13, account deletion |
| R23 | Medium | Open redirect through `/auth?next` | Section 10, return path |
| R24 | Medium | Auto-suspension left the account's other templates live | Section 10, suspension |
| R25 | Medium | Keyframe resolution was unbounded | Section 8, video sampling |
| R26 | Medium | Takedown limit used `X-Forwarded-For`; the queue was sorted after the page limit | Sections 8 and 10 |
| R27 | Medium | Uploads over 10 MB failed with 500 | Section 10, CSRF and Origin |
| R28 | Medium | Logs contained SQL parameters | Section 13, logs |
| R29 | Medium | `/api/media` read the whole file for every request | Section 12, signed URLs |
| R30 | Medium | A Redis outage made rate-limited routes hang | Section 10, fail closed |
| R31 | Medium | The active-job cap could be raced | Section 4, confirm |
| R32 | Medium | A cancellation ended a paid pass at once | Section 6, catalog |
| R33 | Medium | Account deletion left the processor billing | Section 13, account deletion |
| R34 | Medium | Removed templates' links were still served | Section 12, signed URLs |
| R35 | Medium | A VIP recipe was sent to viewers without a pass | Section 10, roles |
| R36 | Low | The age gate cookie was only enforced by the layout | Section 7, three layers |
| R37 | Low | Links lived about 2 x TTL | Section 12, signed URLs |
| R38 | Low | The chargeback block applied only at checkout | Section 6, `cannotBuy` |
| R39 | Low | Stripe pass refunds never matched their charge | Section 6, matching references |
| R40 | Low | Provider lookup used `in` | Section 6, webhook handling |
| R41 | Low | Impossible dates gave 500 | Section 3, signup |
| R42 | Low | Verdict and purge guards were missing | Sections 8 and 12 |
| R43 | Low | Malformed input gave 500s | Section 3, conventions |
| R44 | Low | The download redirect used the bind origin | Section 3, download |
| R45 | Low | The age return route gave 500 or 422 | Section 7, status lifecycle |
| R46 | Low | Favorite and rating counters drifted under concurrency | Fixed; `tests/integration/generation-hardening.test.ts` |
| R47 | Low | The worker ignored `deleted_at` | Section 4, job lifecycle |
| R48 | Low | `startVerification` overwrote a verified status | Section 7, status lifecycle |
| R49 | Low | "Remix of" showed removed sources | Fixed: only a published, undeleted source is shown |

| Infra ID | Severity | Finding | Now |
|---|---|---|---|
| I01 | High | Log redaction stopped at a frame-like line | Everything after `params:` is redacted, through the whole cause chain |
| I02 | High | Next.js printed raw reported errors | `DrizzleQueryError` scrubs itself when printed |
| I03 | Medium | Compose published web on every interface | Published on 127.0.0.1 unless `WEB_BIND` says otherwise |
| I04 | Medium | The seed ran on a live site outside compose | The seed exits 1 on a live site |
| I05 | Low | The error webhook was not installed when config failed | `errorWebhookUrlAlone()` |
| I06 | Low | Some `.env` files were not git-ignored | `.env*` ignored except `.env.example` |
| I07 | Low | CI checkout kept credentials | `persist-credentials: false` (tag pinning left by decision) |
| I08 | Low | `.env` files could enter the Docker build context | `**/.env` and `**/.env.*` excluded |

**Attack round.** After the fixes, one attacker per area tried to break each fix. Every hole was patched with a test, except two in auth that were left for a decision.

| Area | Attempts | Held | Holes | Patched |
|---|---|---|---|---|
| payments | 16 | 9 | 7 | 7 |
| age | 15 | 12 | 3 | 3 |
| scan | 7 | 3 | 4 | 4 |
| auth | 12 | 5 | 7 | 5 (2 left for decision) |
| moderation | 15 | 7 | 8 | 8 |
| generation | 11 | 7 | 4 | 4 |
| infra | 14 | 8 | 6 | 6 |
| **Total** | **90** | **51** | **39** | **37 (2 left)** |

What the attack-round patches changed:

| Area | Patches |
|---|---|
| payments | CCBill pass-through read only with the `X-` spelling; renewals of a held pass start held; an unknown CCBill currency recorded as `xxx`; a Stripe session without an amount held; a reversal naming its charge waits for that charge; a reversal and its payment take the same lock; a cancellation and its pass start take the same lock |
| age | The confirm route runs the age gate; a lapsed or sandbox verification cannot confirm; stored likeness photos follow the viewer's decision |
| scan | `recordDerivedScan` never overwrites a match; only JPEG, PNG and WebP reach the decoder; frames picked by change from the last pick; Next.js image optimizer off |
| auth | IPv6 keyed by /64; ports dropped; `DELETE /api/me` shares the password budget; `INCR` and `EXPIRE NX` in one transaction; zero hops keys every request as `local` |
| moderation | Hash block (migration 0004); a retry cannot republish; copies on every account; publish re-checks under the per-file lock; a publishing edit reads the account last under a share lock; `publishTemplate` refuses a suspended account |
| generation | `FOR NO KEY UPDATE` on the owner row; upload match retry with a hold fallback; a file with no verdict is never purged (immediate and retention purge) |
| infra | Whole cause chain scrubbed; driver `detail` redacted; string fields redacted; `DrizzleQueryError` scrubs itself when printed |

**Branch suites and merges.** Each area branch passed its full vitest suite at its head: payments 296, age 286, scan 321, auth 292, moderation 290, generation 281, infra 285. The branches were merged one at a time, with vitest after each merge:

| Merge | vitest passing |
|---|---|
| `f1e5f8e` | 296 |
| `abded82` | 324 |
| `09dc2a1` | 387 |
| `aa7fba0` | 421 |
| `16a67db` | 453 |
| `0a01221` | 476 |
| `ce84bff` | 503 of 503 in 44 files |

Playwright then passed 36 of 36 on a fresh production build at `ce84bff` in 5.4 minutes (`notes/evidence/e2e-ce84bff.log`).

**Product calls made by the fix agents** (recorded in the decisions log):

| Finding | Call |
|---|---|
| R35 | A VIP template's prompt, negative prompt and settings are not sent to viewers without a pass. The model key is still sent. |
| R08 | Takedowns reach byte-identical copies on other accounts. |
| R16 | A sandbox verification reads as unverified on a live site. |
| R14 | `AGE_VERIFICATION_FAIL_CLOSED` stays `false` by default. |

**Open by decision** (`notes/progress.md`):

| Item | Severity | State |
|---|---|---|
| R05-H6 | Medium | Ten wrong guesses from anyone lock the account's sign-in, and its deletion, for 15 minutes. Options: CAPTCHA, a delay, a trusted-device cookie, or per-(email, address) buckets. Pinned by an `it.fails` test. |
| R05-H7 | Medium | Signup reveals that an email exists (409 `email_taken`). A fix needs email verification, which needs an email adapter that does not exist. Pinned by an `it.fails` test. |
| R14 default | Medium | `AGE_VERIFICATION_FAIL_CLOSED` defaults to `false`, so a request from an unknown country or US state is allowed without a check. |
| I07 remainder | Low | First-party GitHub actions are pinned to tags, not SHAs. |
| I09 | Low | Compose Redis has no password, but it is not published. |
| I10 | Low | Base images are pinned by tag, not digest. Needs registry access. |
| I11 | Low | The web image's server files are owned by the runtime user. Unverifiable without Docker. |

**Known residuals:**

- A taken-down file can still be regenerated privately. Only publishing checks the hash.
- Near-duplicates are not matched; the hash block and copy takedown are byte-identical only.
- A scanner match on a public copy does not reach other copies.
- Deleting an account while publishing an edit can deadlock; Postgres aborts one of them.

**Go-live questions** (need the processors' real accounts):

- Does CCBill echo pass-through values with the `X-` prefix? If not, every CCBill sale is ignored until the code changes.
- Is a CCBill refund's `transactionId` the original charge's or a new one?
- Timestamp windows and nonces for CCBill and Segpay wait on the processors' real formats.
- Segpay reads a missing `currencycode` as USD.

Other open items: geo headers are trusted as sent; every public template is treated as explicit; the US state list is configuration, not legal advice; CCBill, Segpay and Yoti are unverified; the scanning questions for counsel are in [docs/abuse-response.md](abuse-response.md); no reverse proxy is bundled.

## 16. Testing

### Layout

| Path | Kind | Runner |
|---|---|---|
| `tests/unit/*.test.ts` (18 files) | Pure logic, no database | vitest |
| `tests/integration/*.test.ts` (27 files) | Real Postgres (`playbox_test`, migrated by `tests/global-setup.ts`) and Redis db 1 | vitest |
| `tests/e2e/journey.spec.ts` | Core journey against a production build (serial) | Playwright |
| `tests/e2e/launch.spec.ts` | Launch journey: age, payments, scanning, installable app | Playwright |
| `tests/e2e/layout.spec.ts` | Layout guard, always on: the main routes fit 390 and 820 px, with 40 px primary targets at 390 | Playwright |
| `tests/e2e/visual.spec.ts` | Visual review capture: every page and state at 390, 820 and 1440 px with automated checks. Skipped unless `VISUAL_REVIEW=1` | Playwright |
| `tests/e2e/evidence.ts` | Fixture that writes screenshots and a JSON log per test to `E2E_SHOTS_DIR` (default `test-results/journey`). A test fails on any console error, page error or 5xx response it did not declare. | |
| `tests/helpers.ts` | `resetDb` (truncates), `makeUser`, `key()` | |
| `tests/fixtures/scan-drill-match.png` | The dev scanner's drill image | |

vitest runs with `NODE_ENV=test`, database `playbox_test`, Redis db 1, fake CCBill, Segpay and Stripe secrets, files in sequence (`fileParallelism: false`) and 30 s timeouts.

### How to run

| Command | What it does |
|---|---|
| `npm test` | vitest unit and integration suites (needs Postgres and Redis) |
| `npm run test:e2e` | Playwright: the journeys and the layout guard; the visual capture is skipped |
| `VISUAL_REVIEW=1 VISUAL_SHOTS_DIR=<dir> npx playwright test tests/e2e/visual.spec.ts` | The visual capture: one PNG per page and state plus `manifest.json` in `<dir>` (default `test-results/visual`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `next lint --max-warnings 0` |
| `npm run verify` | typecheck, lint, test, build, e2e |

Playwright (`playwright.config.ts`) uses port 3100 with `NODE_ENV=production` and `APP_ENV=test`, database `playbox_e2e`, Redis db 2, one worker, and a random `MEDIA_SIGNING_SECRET` per run. It sets `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS` so tests can see service-worker traffic. Its first web server step runs `scripts/e2e-prepare.ts` (drops and recreates the schema, migrates, seeds, runs the scan backfill), then `next build`, then `scripts/e2e-serve.mjs`, which copies static and public files and starts the standalone server. A second step waits for `/api/health` and starts the worker (health on 3901).

### Results at `09a436e`

The code was checked on 2026-10-14 in a fresh worktree (`notes/evidence/clean-verify-09a436e.log`), then end to end (`notes/evidence/e2e-09a436e.log`).

| Check | Status | Result |
|---|---|---|
| Clean install | verified | `npm ci`: 462 packages, exit 0 |
| Typecheck | verified | Clean |
| Lint | verified | Clean, 0 warnings |
| vitest | verified | 507 tests in 45 files, all passing (302 s) |
| Production build | verified | `next build` exit 0 |
| Playwright | verified | 72 tests: 40 passed, 32 skipped, 0 failed (5.6 min), on a fresh production build. The 40 are `journey.spec.ts` (9), `launch.spec.ts` (27) and `layout.spec.ts` (4). The 32 skipped are `visual.spec.ts`, which runs only with `VISUAL_REVIEW=1`. |
| CI on GitHub Actions | verified | Run 16 at `574ccaf` (code as at `09a436e`): both jobs passed (`notes/evidence/github-ci.md`) |
| Visual review | verified | 223 screenshots at 390, 820 and 1440 px, 43 defects found and fixed, confirmed by a second full capture (below) |
| Journey evidence | verified | `/mnt/project-files/playbox-2/evidence/journey/`: 109 files, 73 PNG screenshots and 36 JSON logs, one per test, from the launch journey's run at `fe21509` (36 passed, `notes/evidence/e2e-fe21509.log`) |

### Unit tests (18 files, 144 tests)

| File | Tests | Covers |
|---|---|---|
| `age` | 7 | Jurisdiction codes; unknown locations (R14); sandbox callback signing; Yoti notification signatures and status mapping |
| `client-ip` | 6 | `clientIp` and `addressKey`: hops, ports, IPv4-mapped, IPv6 /64 (R05) |
| `contrast` | 5 | Design token contrast at WCAG AA |
| `copilot` | 12 | Copilot rules: policy blocks, contradictions, nearest aspect ratio, low-resolution input |
| `demo-caption` | 3 | The demo placeholder's caption wraps into two lines and starts below the top 16%; the watermark fits a 9:16 frame (V-B-18) |
| `deploy-config` | 7 | Compose bind, `.gitignore`, CI credentials, `.dockerignore` (I03, I06, I07, I08) |
| `draft-key` | 5 | Client idempotency key reuse and renewal |
| `env-template` | 5 | `.env.example` lists every variable, sets nothing, holds no secrets |
| `env` | 5 | Live-deployment guard and sandbox refusals |
| `manifest` | 7 | Manifest fields, icons, precache files exist, `sw.js` headers |
| `observability` | 15 | Error webhook content, redaction, timeouts, rate cap; I01, I02, I05 |
| `policy` | 29 | Policy categories (19 block and 6 allow cases), normalization, age arithmetic |
| `provider-input` | 5 | `promptWithSettings`, Replicate input mapping, reference refusal |
| `push-payload` | 4 | Payload carries nothing but the outcome and job id |
| `registry` | 3 | Cost and capability checks |
| `seed-guard` | 2 | The seed refuses a live site and still runs on a private preview (I04) |
| `signatures` | 4 | Local media signatures and link life (R37), Replicate webhook signatures |
| `sw-rules` | 20 | Service worker routing and storage rules |

### Integration tests (27 files, 363 tests)

| File | Tests | Covers |
|---|---|---|
| `age` | 26 | Configuration, 451 gate, sandbox flow, replays, expiry, media withholding, settings; R03, R04, R14, R15, R16, R36, R45, R48 |
| `attack-age` | 16 | Attack round on the age fixes |
| `attack-auth` | 15 | Attack round on R05; includes 2 `it.fails` tests that pin the open R05-H6 lockout and R05-H7 email probe |
| `attack-generation` | 13 | Attack round on R12 |
| `attack-infra` | 15 | Attack round on I01 and I02 |
| `attack-moderation` | 18 | Attack round on R08 and R11 |
| `attack-payments` | 22 | Attack round on R01, R02 and R10 |
| `attack-scan` | 22 | Attack round on R06, R09, R13, R25, R29, R34, R42 |
| `auth` | 11 | R05, R22, R23, R28, R41, R43 |
| `composing` | 9 | Remix and reuse, presets, publish policy, video metadata stripping, project list counts and demo covers (V-B-1, V-B-2) |
| `enqueue-failure` | 1 | Confirm succeeds and holds credits when the enqueue fails |
| `generation-hardening` | 10 | R12, R31, R46, R47 |
| `generation` | 28 | Full lifecycle, charge once, idempotency, cancel, retries, timeouts, dead worker, policy, capabilities, concurrency cap, cross-user isolation, demo video through ffmpeg, character references, storage faults, draft expiry |
| `integrity` | 5 | Migration 0003 FKs and DOB nulling, deletion, suspension |
| `media-range` | 2 | Ranged reads (R29) |
| `media-removal` | 4 | Removed templates stop serving (R34) |
| `media-s3` | 4 | S3 through `/api/media` and ranged `GetObject` (R13, R29) |
| `moderation` | 14 | R08, R11, R21, R24, R26, R35, R49 |
| `payments` | 37 | Sandbox, the webhook route (R40), Stripe (R39), CCBill (R01, R19, R20, R10, R32, R33), Segpay (R02, R32): grant once, rejections, refunds, pro rata, chargebacks, debt flags, passes |
| `platform` | 23 | Stripe webhook, consent withdrawal, publishing, posters, discovery privacy, accounts, media route, projects, presets, browse, library filters |
| `push` | 17 | VAPID configuration, endpoint allowlist, subscription lifecycle, notification sends and pruning |
| `redis-outage` | 2 | Rate limits and health fail fast while Redis is down (R30) |
| `scan-coverage` | 9 | Whole-clip video sampling and frame caps (R06, R25) |
| `scan` | 20 | Dev scanner, upload and output verdicts, fail-closed and fail-open, legal hold, review queue, takedowns, PhotoDNA, download origin (R44) |
| `upload-body` | 11 | Uploads over 10 MB, size limits while streaming, Origin and form checks on both upload routes (R27) |
| `uploads` | 7 | Alpha flattening (R07), decoder limits (R09) |
| `verdict-guards` | 2 | A match is never overwritten; purge guards (R42) |

`it.each` rows and loops expand the counts: `policy` has 25 table rows, `attack-scan` 4, `upload-body` 5 tests run against 2 routes, and `auth` and `uploads` each run one test twice.

### End-to-end: `tests/e2e/journey.spec.ts` (9 tests, serial)

1. Sign up, receive a 40-credit admin grant through the API, open the Velvet Hour template, see cost 4, make a demo placeholder, find it Ready in the Library with a Demo badge, load its image through `/api/media`, and see a balance of 36.
2. Another member gets 404 on the creation page ("A loose thread"), on API GET, derive and DELETE; a forged media signature gets 403; a cross-site POST gets 403.
3. Missing and private pages answer 404, including `/admin` for a member. Signed-out private pages answer 307 to `/auth?next=`. List pages still answer 200 (`journey.spec.ts:144`).
4. An under-18 signup is refused.
5. A prohibited prompt is blocked before anything is charged.
6. to 8. Layout holds at 390 x 844, 820 x 1180 and 1440 x 960 across `/`, `/explore`, `/templates/velvet-hour` and `/pricing`.
9. Keyboard users can skip to content and reach navigation.

### End-to-end: `tests/e2e/launch.spec.ts` (27 tests)

| Group | Tests | What they check |
|---|---|---|
| GB age rules | 5 | An anonymous visitor is withheld media on cards, the template page and a creator page. A new member is withheld media, cannot make or upload, and is charged nothing. Settings shows the check as required and labeled sandbox; a failed attempt, then a verified one. After verification previews load and a demo is made and charged. With no geo header, nothing is required and no install prompt appears. |
| US states | 1 | TX is withheld, CA is not. |
| Sandbox payments | 9 | The sandbox label is shown. Buying the smallest pack grants exactly its credits. The browser cannot grant itself credits. A simulated failure leaves the balance unchanged. A refund claws back. A chargeback flags the account and pauses checkout until an admin clears it. A second reversal takes nothing. Replays are refused. A refund after spending records the debt. |
| Abuse scanning and takedowns | 4 | A match gets a generic rejection, then suspension and sign-out. Another member's clean upload works. The admin sees the escalation and the file is never served. A signed-out takedown request, dismissed by an admin with a note. |
| Installable web app | 6 | The manifest is installable. `sw.js` is served fresh with the whole-origin scope. Manifest link and iOS icon are present; Chrome's installability check reports no errors. Offline: the offline page shows; private pages and the API are never cached. Settings shows the install card and push as "not configured". At 390 x 844 offline, the banner shows and Make is disabled. |
| Core flows at 390 x 844 | 1 | The main flows work at phone width. |
| Clock skew | 1 | With the device clock 10 minutes ahead, pages with relative times hydrate without errors. |

### End-to-end: `tests/e2e/layout.spec.ts` (4 tests, always on)

One test per width and role: 390 x 844 (mobile, touch) and 820 x 1180, each as a visitor who passed the age gate and as the seeded member. Each test opens `/`, `/explore`, `/templates/velvet-hour`, `/collection`, `/projects`, `/pricing`, `/settings` and `/auth`, waits until the page stops moving, and checks:

- **No sideways scroll.** `document.documentElement.scrollWidth` is at most the configured width. The configured width is used, not `innerWidth`, because a mobile Chromium widens its layout viewport to fit overflowing content. A failure names up to five offending elements.
- **40 px primary targets at 390 px.** Every visible header and tab-bar control, and every filled (ember or bone) button and link, is at least 40 x 40. Switches, whose whole row is the target, and screen-reader-only elements are skipped.

### Visual capture: `tests/e2e/visual.spec.ts` (32 tests, skipped by default)

One setup test (accounts, a creation, a project, a takedown, a report and a scanner escalation), ten groups at each of three viewports (390 x 844 mobile, 820 x 1180, 1440 x 900), and one test that records the states it cannot reach. The groups are admin, creator, member, fresh member (empty states), anonymous in GB, GB member not age verified, anonymous, the create flow (create panel, cost sheet, job tray, upload consent, sandbox checkout), loading skeletons and offline. Each capture is a PNG plus an entry in `manifest.json` with these automated checks:

| Check | Rule |
|---|---|
| Overflow | `scrollWidth` above the configured width, with up to five offending elements |
| Small targets | Visible interactive elements under 40 x 40 at 390 px, or under 24 x 24 at any width. Elements that fail by design (an inline text link, a checkbox whose label is the target) are listed with the reason. |
| Clipped text | An element with overflow hidden or clip whose text is wider than its box and has no ellipsis |
| Contrast | axe-core's `color-contrast` rule |

With a sheet open, the target, clipped-text and contrast checks look inside the open dialog only. The spec turns animations off, so the scroll-driven `.edge-fade` shows no fade in any capture.

**Phase 4 visual review** (`notes/analysis/visual/visual-review.json`, which records each defect's what, fix and before and after). The first capture took 223 screenshots. Two reviewers found 43 defects: 3 high, 27 medium, 13 low. All 43 were fixed on branch `visual-review` (commits `7149139..a802cc4`, merged at `91d270c`) and confirmed by a second full capture, which found no new defect.

| Measure | Before | After |
|---|---|---|
| Sideways overflow | Studio for a member at 390 px laid out 583 px wide. A reviewer found it; the check then compared against `innerWidth` and missed it. | None: every capture's `scrollWidth` equals its configured width |
| axe contrast violations | 9: the "· sandbox" tag on the ember Buy button (4.32:1), for three accounts at each width | 0 |
| Flagged small targets at 390 px | 1916 | 369 |
| Clipped text | 0 | 0 |

The 369 that remain were all flagged before, with equal or higher counts, and none was among the 43 defects. They are 351 card title links (about 21 px tall) that repeat the card's media link and are out of the tab order, and 18 switches (40 x 24) inside full-row labels. Inline links in sentences and native checkboxes inside labels are recorded as by design (30 at 390 px), so they are not part of the 369. Screenshots and manifests: `/mnt/project-files/playbox-2/evidence/visual/before/` and `after/`. Not captured: the route error boundary, because no page throws on demand in a production build. Open (low): the brief "Weaving a demo placeholder" toast covers Make it on phones while it shows.

Integrations marked Unverified in this document are tested only against locally built requests and responses. None of these tests proves behavior against the real provider.
