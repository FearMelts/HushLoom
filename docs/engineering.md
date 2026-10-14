# Hushloom Engineering Documentation

This document describes the merged build at commit `c52f843` (all seven build tracks merged). Every behavior described here exists in that snapshot, unless it is labeled **planned** or **not built**. File and route references are relative to the repository root. Hushloom is an adults-only web app for creating images and short videos. Playbox informed its structure and interaction patterns only. Nothing here describes Playbox's visuals.

## Status labels used in this document

| Label | Meaning |
|---|---|
| Operational | Built, runs in this snapshot, and is exercised by the test suites. |
| Demo | Built and runs, but produces placeholder output. AI generation is a labeled demo until a real provider key is set. |
| Sandbox / dev | Built and runs against an in-app stand-in that proves nothing. Payments, age verification and abuse scanning run this way until the owner opens provider accounts. |
| Needs keys | Built and switched off until configured. Push needs VAPID keys. |
| Unverified | Written from the provider's public documentation and tested only against local fakes. Never run against the real service. |
| Planned / not built | Not in the code. |

Unverified at `c52f843`: Replicate, CCBill, Segpay, Stripe, Yoti, PhotoDNA, the Cloudflare CSAM tool, the S3 storage driver, both Docker images, the compose stack and the CI workflow (it has never run on GitHub).

## 1. System architecture

### Components

| Component | Technology | Role |
|---|---|---|
| Web app | Next.js 15 App Router (standalone output), React 19, strict TypeScript, Tailwind 4 | Pages, 56 API route files, the Origin check in `src/middleware.ts`, signed media serving at `/api/media`. |
| Worker | Separate Node process, `src/worker/index.ts` run with tsx | Runs generation jobs from the BullMQ queue, reconciles stuck jobs, purges deleted files, sends push notifications. |
| Postgres 16 | Drizzle ORM on postgres-js, pool max 10 | System of record: 37 tables, 16 enums. |
| Redis 7 | ioredis, BullMQ | The `generation` queue and fixed-window rate-limit counters (`rl:*` keys). |
| Storage | `local` driver (disk) or `s3` driver (S3-compatible) | Uploads, outputs, posters and public template copies. |
| Media tools | sharp, ffmpeg | Image re-encoding, demo video rendering, posters, video metadata stripping, keyframes for scanning. |
| External adapters | One adapter interface per domain | AI generation, payments, age verification, abuse scanning, web push, error webhook. |

### Diagram

```text
                 Browser tab or installed web app
                 (manifest, service worker /sw.js)
                               |
                               |  HTTPS. A reverse proxy is expected to set
                               |  x-forwarded-for and the geo headers.
                               |  No proxy is bundled.
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
| 37 tables   |   | BullMQ "generation" |   | uploads/  outputs/     |
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

All configuration is read through `env()` in `src/server/env.ts`. It parses 62 variables with zod once and caches the result. A deployment counts as **live** when `APP_ENV` (or, if `APP_ENV` is unset, `NODE_ENV`) equals `production` (`isLiveDeployment()`).

| Rule at startup | Effect |
|---|---|
| `NODE_ENV=production` and `MEDIA_SIGNING_SECRET` missing or shorter than 32 characters | Refuses to start. |
| `NODE_ENV=production` and `STORAGE_LOCAL_DIR` not absolute | Refuses to start. |
| `STORAGE_DRIVER=s3` without `S3_BUCKET` | Refuses to start. |
| Live site with `SCAN_PROVIDER=dev` and `SCAN_FAIL_CLOSED=true` | Refuses to start. |
| Live site with `AGE_VERIFICATION_PROVIDER=sandbox` and `AGE_VERIFICATION_ENFORCE=true` | Refuses to start. |

Outside production, `mediaSigningSecret()` falls back to a fixed development secret. The payments sandbox, age-verification sandbox and dev scanner each also refuse to work at runtime on a live site (sections 6 to 8).

### Deployment files

| File | What it defines | Run status |
|---|---|---|
| `Dockerfile` | Web image: node 22 bookworm slim, standalone output, ffmpeg, non-root user, `/data/storage`, port 3000, `HEALTHCHECK` on `/api/health`. | Never built. |
| `Dockerfile.worker` | Worker image: ffmpeg, full `npm ci`, `node --import tsx src/worker/index.ts`, health on port 3901. | Never built. |
| `docker-compose.yml` | `postgres:16`, `redis:7` (append-only, `noeviction`), `migrate`, `web`, `worker`; `seed` under the `seed` profile; MinIO and a bucket-init job under the `s3` profile. | Never run. |
| `.github/workflows/ci.yml` | A checks job and an end-to-end job on branches other than `main`. | Never run on GitHub. |

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
| `user_profiles` | Public identity | PK `user_id` (cascade), `handle`, `display_name`, `bio`, `avatar_asset_id` | Unique index on `lower(handle)`; avatar FK set null (0003) |
| `sessions` | Sign-in sessions | `token_hash`, `expires_at`, `user_agent` | Unique `token_hash`; index on `user_id`; cascade on user |
| `creator_profiles` | Creator extras | PK `user_id`, `headline`, `share_analytics` | Cascade on user |
| `user_preferences` | Settings | `personalization_enabled`, `history_enabled`, `autoplay_previews`, `copilot_enabled`, `interests text[]`, `notify_on_finish` (default false) | PK `user_id` |
| `consent_records` | Every consent given | `kind`, `statement`, `subject_label`, `granted_at`, `withdrawn_at` | Index on (`user_id`, `kind`) |

### Media and uploads

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `media_assets` | Every stored file | `owner_id` (set null), `kind`, `storage_key`, `mime`, `bytes`, `width`, `height`, `duration_ms`, `sha256`, `visibility` (default private), `scan_status` (default pending), `scan_provider`, `scan_ref`, `scanned_at`, `legal_hold` (default false), `deleted_at` | Unique `storage_key`; indexes on `owner_id` and `scan_status` |
| `uploads` | A user's uploaded file and the consent it was given under | `asset_id` (cascade), `purpose`, `consent_record_id` | Index on `user_id` |
| `character_references` | Likeness photos for reference-guided generation | `asset_id`, `consent_record_id` (both required), `deleted_at` | FKs with no delete action |

### Templates and social

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `template_categories` | Browse categories | `slug` | Unique `slug` |
| `templates` | Published recipes | `slug`, `creator_id`, `category_id`, `title`, `description`, `media_type`, `mode`, `tags[]`, `status` (default draft), `is_vip`, `quality` (default hd), `duration_s`, `poster_asset_id`, `preview_asset_id`, `current_version`, `remixed_from_id`, `favorite_count`, `generation_count`, `rating_sum`, `rating_count`, `published_at`, `deleted_at` | Unique `slug`; indexes on (`status`, `published_at`), `creator_id`, `category_id`; `remixed_from_id` self FK set null (0003) |
| `template_versions` | Prompt history per template | `version`, `prompt`, `negative_prompt`, `model_key`, `defaults jsonb`, `changelog` | Unique (`template_id`, `version`) |
| `template_ratings` | One rating per user per template | `score` | PK (`user_id`, `template_id`); check score between 1 and 5 |
| `favorites` | Saved templates and creations | `target_type` (`template` or `creation`), `target_id` | PK (`user_id`, `target_type`, `target_id`); index on target |
| `follows` | Creator follows | follower, creator | PK; check `no_self_follow`; index on creator |
| `template_collections`, `template_collection_items` | Creator collections (`is_public`, item `position`) | | PK (`collection_id`, `template_id`) |
| `discovery_events` | View and generate signals for For You | `event` (`view` or `generate`) | Index on (`user_id`, `created_at`) |

### Projects and generation

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `projects` | Multi-scene work | `title`, `description`, `deleted_at` | |
| `project_scenes` | Ordered scenes | `position`, `continuity jsonb` (lighting, framing, palette, characterReferenceId, notes) | Index on (`project_id`, `position`) |
| `generation_jobs` | One generation request | `user_id`, `idempotency_key`, `status`, `mode`, `model_key`, `provider_key`, `is_demo`, `template_id`, `project_id`, `scene_id`, `parent_job_id`, `relation` (retry, variation, remix, continuation, extension), `prompt`, `negative_prompt`, `params jsonb`, `input_asset_ids uuid[]`, `character_reference_id`, `cost_credits`, `provider_job_id`, `attempts` (default 0), `max_attempts` (default 3), `cancel_requested`, `failure_code`, `failure_message`, `queued_at`, `started_at`, `finished_at`, `deleted_at` | Unique (`user_id`, `idempotency_key`); check `cost_credits >= 0`; indexes on (`user_id`, `created_at`), `status`, `scene_id`; template, project and scene FKs set null; `parent_job_id` self FK set null (0003) |
| `generation_outputs` | Files a job produced | `asset_id`, `poster_asset_id` (0001), `is_demo`, `quality_report`, `deleted_at` | Cascade on job |
| `scene_versions` | Takes of a scene, with branches | `job_id`, `parent_version_id`, `branch_label` (default main), `is_selected` | Unique `job_id`; index on scene; parent self FK set null (0003) |
| `folders`, `folder_items` | Library folders | `name`; item points at an output | PK (`folder_id`, `output_id`) |
| `saved_presets` | Saved settings | `mode`, `model_key`, `params`, `prompt` | Index on `user_id` |
| `model_configs` | Admin overrides per model | PK `model_key`, `enabled`, `price_multiplier_pct` (default 100) | |

`params` holds `GenerationParams`: aspectRatio, durationS, quality, motionIntensity, cameraMovement, pacing, atmosphere, lighting, framing, seed.

### Money

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `credit_accounts` | Current balance | PK `user_id`, `available`, `reserved` | Checks `available >= 0` and `reserved >= 0` |
| `credit_ledger` | Every balance movement | `kind`, `available_delta`, `reserved_delta`, `available_after`, `reserved_after`, `job_id` (set null), `payment_event_id` (set null, 0003), `idempotency_key`, `note` | Unique `idempotency_key`; index on (`user_id`, `created_at`) |
| `subscriptions` | Passes | `plan_key`, `status` (text), `provider` (default stripe), `provider_customer_id`, `provider_subscription_id`, `current_period_end` | Unique `provider_subscription_id` |
| `payment_events` | Every accepted provider event | `provider`, `provider_event_id`, `type`, `user_id` (set null), `amount_cents`, `currency`, `credits`, `transaction_ref`, `metadata`, `processed_at` | Unique (`provider`, `provider_event_id`); index on (`provider`, `transaction_ref`) |

### Trust, safety and devices

| Table | Purpose | Key columns | Constraints and indexes |
|---|---|---|---|
| `moderation_events` | Reports, automatic blocks, scanner escalations and review actions | `subject_type` (template, prompt, upload, user, output), `subject_id` (text), `action`, `status`, `reporter_id`, `actor_id`, `reason`, `details` | Index on (`status`, `created_at`) |
| `audit_logs` | Who did what | `actor_id` (set null), `action`, `target_type`, `target_id`, `metadata` | Indexes on (`target_type`, `target_id`) and `created_at` |
| `age_verifications` | One row per verification attempt | `provider`, `status` (default pending), `provider_ref`, `method`, `jurisdiction`, `failure_reason`, `started_at`, `completed_at`, `expires_at` | Unique (`provider`, `provider_ref`). No ID images or biometrics are stored. |
| `account_flags` | Holds on an account | `kind`, `reason`, `details`, `created_by`, `cleared_at`, `cleared_by` | Index on (`user_id`, `cleared_at`) |
| `takedown_requests` | Public removal requests | `requester_id`, `requester_email`, `target_type` (output, template, asset, url), `target_ref`, `category` (ncii, csam, likeness, copyright, other), `details`, `status`, `resolution_note`, `resolved_by`, `resolved_at` | Index on (`status`, `created_at`) |
| `push_subscriptions` | One row per signed-in device that opted in | `session_id` (cascade), `endpoint`, `p256dh`, `auth`, `user_agent`, `last_used_at`, `failed_at` | Unique `endpoint` |

Foreign keys with no delete action (deletes of the target are refused): template creator, category, poster and preview; `uploads.consent_record_id`; character reference asset and consent; `generation_jobs.character_reference_id`; output asset and poster. This is safe because those targets are only ever soft-deleted.

### Migration history

Migrations live in `drizzle/` and run with `npm run db:migrate` (`scripts/migrate.ts`, Drizzle migrator).

| Migration | Changes |
|---|---|
| `0000_init` | 12 enums, 33 tables, their indexes and foreign keys. |
| `0001_output_posters` | Adds `generation_outputs.poster_asset_id` with its FK. |
| `0002_launch_readiness` | New enums `account_flag_kind`, `age_verification_status`, `scan_status`, `takedown_status`. Adds `refund` and `chargeback` to `ledger_kind`, and `hold` and `escalate` to `moderation_action`. New tables `account_flags`, `age_verifications`, `push_subscriptions`, `takedown_requests`. Adds scan columns and `legal_hold` to `media_assets`; `transaction_ref` and `metadata` to `payment_events`; `provider` and `provider_customer_id` to `subscriptions`; `notify_on_finish` to `user_preferences`; age-verification columns and `jurisdiction` to `users`. New indexes including `media_scan_idx` and `payment_events_txn_idx`. |
| `0003_integrity_fks_and_dob` | Drops NOT NULL on `users.date_of_birth` and nulls it for deleted accounts. Nulls dangling references, then adds five `ON DELETE SET NULL` FKs: `credit_ledger.payment_event_id`, `generation_jobs.parent_job_id`, `scene_versions.parent_version_id`, `templates.remixed_from_id`, `user_profiles.avatar_asset_id`. |

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
| 401 | `unauthorized` | No valid session ("Sign in to continue."). |
| 402 | `insufficient_credits` | Ledger refused a movement; `details: { needed, available }`. |
| 403 | `bad_origin` | Middleware: a write to `/api/*` (not `/api/webhooks/*`) carries an `Origin` that matches neither the request origin nor `APP_URL`. |
| 404 | `not_found` | Missing, deleted, or not yours. The two cases look identical by design. A malformed UUID (Postgres `22P02` anywhere in the error's cause chain) also returns 404. |
| 422 | `invalid_input` | A zod schema failed; `details` is `err.flatten()`. Message: "Some fields need attention." |
| 429 | `rate_limited` | A fixed-window limit in Redis was hit. |
| 500 | `internal` | Anything unexpected. It is logged as `unhandled route error` with the path only. Message: "Something went wrong on our side." |

Auth column values below: **Public** (no session needed), **User** (401 when signed out), **Admin** (401 when signed out, **404** for a signed-in non-admin, so admin endpoints do not reveal themselves), **Signed** (provider signature or secret, no session). Success bodies are JSON unless noted.

### Auth and account

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/auth/signup` | Public | `email`, `password` (10 to 200), `handle` (3 to 24, `[a-zA-Z0-9_]`), `displayName` (1 to 40), `dateOfBirth` (YYYY-MM-DD), `acceptTerms: true`, `confirmAdult: true` | 201 `{ok}`, sets `hl_session` | 429 (10 per hour per IP), 403 `underage`, 422, 409 `email_taken` / `handle_taken` |
| POST | `/api/auth/login` | Public | `email`, `password` (max 200 each) | 200 `{ok}`, sets `hl_session`, refreshes stored jurisdiction | 429 (30 per 15 min per IP, 10 per 15 min per email), 401 `bad_credentials` |
| POST | `/api/auth/logout` | Public | none | `{ok}`; removes this session's push subscriptions, deletes the session, clears the cookie | none |
| POST | `/api/age-gate` | Public | `{confirm: true}` | `{ok}`, sets `hl_age_ok` cookie (httpOnly, Lax, 30 days) | 422 |
| GET | `/api/me` | User | none | Settings view: age verification state, profile, preferences, `pushEnabled`, consents, active session count, popular tags | |
| PATCH | `/api/me` | User | `displayName`, `handle`, `bio` (max 280) | `{ok}` | 409 `handle_taken` |
| DELETE | `/api/me` | User | `{password}` | `{ok}`, clears cookie (account deletion, section 13) | 403 `bad_password` |
| DELETE | `/api/me/sessions` | User | none | `{ok}`, signs out every device | |
| PATCH | `/api/me/preferences` | User | Optional `personalizationEnabled`, `historyEnabled`, `autoplayPreviews`, `copilotEnabled`, `interests` (max 12, each max 24), `notifyOnFinish` | `{ok}` | |
| DELETE | `/api/me/history` | User | none | `{removed}` | |
| DELETE | `/api/me/consents/[id]` | User | none | `{ok}` | 404, 422 `use_account_deletion` for terms or adult attestation |

### Age verification

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/age-verification/start` | User | none | 201 `{url, provider, sandbox, verificationId}` | 429 (10 per hour), 503 `age_verification_unavailable`, 409 `already_verified`, 502 when the provider call fails |
| GET | `/api/age-verification/return` | User (redirects to `/auth?next=` when signed out) | `?sessionId=` (Yoti) or `?ref=` | 302 to `/settings#age-verification` after syncing the result | |
| POST | `/api/webhooks/age-verification/[provider]` | Signed | Provider callback body | `{received, outcome}` | 404 unknown or inactive provider, 400 `callback_<reason>`, 503 unconfigured, 404 `unknown_reference`, 409 `callback_replayed` |

### Generation

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/generations` | User | Query: `active=1`, `media`, `status`, `favorites=1`, `projectId`, `templateId`, `modelKey`, `folderId`, `sort` (newest, oldest), `offset` | `{items}` (creation list items with signed output URLs) | 422 |
| POST | `/api/generations` | User | `idempotencyKey` (8 to 100), `mode`, `modelKey`, `prompt` (1 to 2000), `negativePrompt` (max 1000), `params`, `inputAssetIds` (max 2), optional `templateId`, `characterReferenceId`, `projectId`, `sceneId`, `parentJobId`, `relation` | 201 `{job}` in `awaiting_confirmation` with its `costCredits` | 429 (30 per minute), 451 `age_verification_required`, 422 `unknown_model`, 503 `model_unavailable`, 422 `invalid_input`, 422 `unsupported_settings`, 422 `policy_blocked`, 403 `consent_required`, 422 `input_required` / `input_unexpected`, 403 `consent_withdrawn`, 403 `vip_required`, 404 |
| GET | `/api/generations/[id]` | User | none | `{job}` | 404 (also for a non-UUID id) |
| DELETE | `/api/generations/[id]` | User | none | `{ok}` | 409 `job_active` while queued or processing |
| POST | `/api/generations/[id]/confirm` | User | `{expectedCost}` | `{job}` (queued, credits reserved) | 409 `draft_closed`, 409 `cost_changed` (`details.cost`), 429 `too_many_active`, 402 `insufficient_credits` |
| POST | `/api/generations/[id]/cancel` | User | none | `{job}` | 404 |
| POST | `/api/generations/[id]/derive` | User | `{relation: retry / variation / continuation / extension, idempotencyKey}` | 201 `{job}` (a new draft) | Same as POST `/api/generations`; 422 `unsupported` when continuing without a finished video |
| GET | `/api/generations/[id]/download` | User | none | 302 to a signed download URL named `hushloom-<8 chars>[-demo].mp4` or `.webp` | 404 |

### Uploads, media, characters and presets

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/uploads` | User | Multipart: `file`, `consent="true"`, `subject` | 201 `{assetId, kind, width, height, warnings}` | 451 (age gate, checked before the rate limit), 429 (40 per hour), 422 `invalid_input` / `consent_required`, 413 `too_large`, 415 `unsupported_type`, 403 `upload_rejected`, 503 `scan_unavailable`, 503 `video_processing_unavailable` |
| GET | `/api/media` | Signature in the URL | `?k=<key>&e=<expiry>&s=<sig>[&d=<name>]` | File bytes, or 206 for a range | 403 "Link expired or invalid.", 404, 416 (section 12) |
| GET | `/api/characters` | User | none | `{characters}` | |
| POST | `/api/characters` | User | Multipart: `file`, `name` (max 40), `consentAdult`, `consentLikeness` | 201 `{id, warnings}` | 429 (10 per hour), 422 `consent_required`, 415, 422 `limit_reached` (20) |
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
| GET / POST | `/api/projects` | User | POST `{title (1 to 80), description (max 500)}` | `{projects}` / 201 `{project}` | |
| GET / PATCH / DELETE | `/api/projects/[id]` | User | PATCH: title, description | Detail / `{project}` / `{ok}` | 404 |
| POST | `/api/projects/[id]/scenes` | User | `{title, continuity}`; continuity is strict: lighting (40), framing (40), palette (80), characterReferenceId, notes (400) | 201 `{scene}` | 422 `limit_reached` (50 scenes) |
| PUT | `/api/projects/[id]/scenes` | User | `{order}` (every scene id exactly once, max 50) | `{ok}` | 422 `invalid_order` |
| PATCH / DELETE | `/api/scenes/[id]` | User | PATCH: title, continuity | `{scene}` / `{ok}` | 404 |
| POST | `/api/scenes/[id]/select` | User | `{versionId}` | `{ok}` | 409 `not_ready` unless the take completed |

### Templates

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/templates` | Public | Query: `q` (max 100), `category`, `media`, `sort` (trending, new, top_rated, most_favorited), `creatorId`, `vipOnly`, `offset` (max 10000), `limit` (1 to 60) | `{items, hasMore}`; poster and preview URLs are withheld (`mediaWithheld: true`) for viewers who need an age check | 422 |
| POST | `/api/templates` | User | `jobId`, `title` (2 to 60), `description` (max 500), `categorySlug`, `tags` (max 8), `isVip` | 201 `{template}` | 409 `not_ready`, 403 `personal_media`, 422 `policy_blocked`, 409 `no_output`, 409 `not_cleared` |
| PATCH | `/api/templates/[id]` | User (creator) or Admin | `title`, `description`, `tags`, `categorySlug`, `isVip`, `status` (published or unpublished), `prompt`, `changelog` | `{template}`; a changed prompt adds a version | 404, 403 `removed`, 422 `policy_blocked` |
| POST | `/api/templates/[id]/rate` | User | `{score}` (1 to 5) | `{ok}` | 404 |
| POST | `/api/templates/[id]/report` | User | `{reason: minor / non_consent / real_person / illegal / spam / other, note (max 1000)}` | 201 `{ok}`; opens a `report` moderation event | 429 (20 per hour), 404 |

### Takedowns and push

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/takedowns` | Public or User | `category`, `target` (3 to 500), `email` (required when signed out), `name`, `details`, `goodFaith: true` | 201 `{ok, id}` | 429 (10 per hour per user, or per IP when signed out), 422 `email_required` |
| GET | `/api/push/public-key` | Public | none | `{enabled, reason, publicKey}` | |
| POST | `/api/push/subscriptions` | User | Browser `PushSubscription` JSON | `{ok, id, created}` | 503 `push_disabled`, 429 (60 per hour), 422 `invalid_input` for a foreign endpoint or malformed keys |
| DELETE | `/api/push/subscriptions` | User | `{endpoint}` | `{ok, removed}` (only your own) | |

### Payments

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/checkout` | User | `{itemKey}` | `{url, provider, isSandbox}` | 503 `payments_unavailable`, 429 (10 per 10 min), 403 `account_flagged`, 422 `unknown_item` / `unsupported_item` |
| POST | `/api/pricing/sandbox` | User | `action` (complete, fail, refund, chargeback, renew, cancel) with `token`, `transactionRef` or `subscriptionRef` | `{outcome, transactionRef, next}` | 503 when the sandbox is not the active provider, 403 `bad_token`, 422, 404 |
| POST | `/api/webhooks/payments/[provider]` | Signed | Provider body | 200 `{received: true, outcome}`; Segpay gets plain-text `OK` with an `x-payment-outcome` header | 404 unknown provider, 503 not configured, 400 `unsigned` / `bad_signature` / `replayed` / `malformed`, 500 for an event that must be retried |
| POST | `/api/webhooks/stripe` | Signed | Stripe event | Delegates to the generic handler for `stripe` | As above |
| POST | `/api/webhooks/replicate` | Signed | Replicate prediction | `{received: true}`; verifies and logs only, never changes state | 503 `webhook_unconfigured`, 400 `bad_signature` / `invalid_json` |

### Health and admin

| Method | Path | Auth | Input | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/health` | Public | none | `{ok, checks: {database, redis}}`, 200 when both are `ok` | 503 when either is down (not wrapped in `route()`) |
| POST | `/api/admin/credits` | Admin | `account` (email or `@handle`), `amount` (non-zero, within plus or minus 100000), `reason` (3 to 200), `idempotencyKey` (8 to 100) | `{handle, applied, available, reserved}` | 404, 402 |
| GET | `/api/admin/flags` | Admin | `?all=1` includes cleared flags | `{flags}` | |
| POST | `/api/admin/flags` | Admin | `{action: "clear", flagId, note (max 300)}` | `{ok, flag: {id, kind, clearedAt}}` | 409 `use_review_queue` for `csam_match` |
| PATCH | `/api/admin/models/[key]` | Admin | `enabled`, `priceMultiplierPct` (10 to 1000) | `{ok}` | 404 unknown model |
| POST | `/api/admin/reports/[id]` | Admin | `{action: remove / dismiss, note}` | `{ok}` | 409 `already_resolved`, 409 `use_review_queue` for escalations, 422 `unsupported` |
| GET | `/api/admin/review` | Admin | none | `{scanner, escalations, takedowns}` | |
| POST | `/api/admin/review/[id]` | Admin | `{action: "confirm", reportRef (3 to 120), reportedTo (ncmec_cybertipline, iwf, other_authority), note}` or `{action: "clear", note (3 to 500)}` | `{ok}` | 409 `already_resolved` |
| GET | `/api/admin/takedowns` | Admin | `?status=closed` (default open) | `{takedowns}` | |
| POST | `/api/admin/takedowns/[id]` | Admin | `{action: action / dismiss, note (max 500)}` | `{ok}` | 422 `note_required`, 422 `target_not_found`, 409 `already_resolved` |
| POST | `/api/admin/users/[id]/suspend` | Admin | `{reason}` (3 to 200) | `{ok: true}` | 404 when the user is not active |

Rate limits are fixed windows in Redis (`src/server/redis.ts`). There is no fallback that skips a limit when Redis is unreachable. The IP for signup, login and signed-out takedowns is the first entry of `x-forwarded-for`, trusted as sent, or the literal `local` when the header is missing.

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

The database row is the source of truth. A queue entry only says "look at this job now". Every state change takes a row lock (`SELECT ... FOR UPDATE`) and re-checks the status.

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
| awaiting_confirmation | queued | `confirmJob` with matching cost and room under the active-job cap; sets `queued_at`; writes a scene version when the job belongs to a scene and a `generate` discovery event when it came from a template | reserve | no |
| awaiting_confirmation or draft | cancelled | `cancelJob` | none | no |
| awaiting_confirmation | cancelled (with `deleted_at`, `failure_code = draft_expired`) | `reconcile()` when `created_at` is older than 24 h | none | no |
| queued | cancelled | `cancelJob` (sets `cancel_requested`, `failure_code = cancelled`) | release | no |
| queued | cancelled | Claim finds `cancel_requested` already set | release | no |
| queued | processing | Claim: sets `started_at`, `attempts + 1` | none | no |
| processing | queued | Retryable error and `attempts < max_attempts`; `failure_code` set, re-enqueued after `5000 x 2^(attempts - 1)` ms | reservation held | no |
| processing | completed | Outputs stored, scanned clean, quality-checked; inserted in one transaction with settle and `generation_count + 1` on the template | settle | yes |
| processing | failed | Non-retryable error, retries exhausted, scanner match (`content_blocked`), stored-output fault (`internal`), adapter missing (`provider_unavailable`), invalid inputs | release | yes |
| processing | cancelled | Cancel requested while running: the provider call is aborted and `finishFailed` records `cancelled` | release | yes |
| processing | cancelled | Cancel requested while outputs were being stored: outputs discarded in the final transaction | release | no |
| processing | failed (`timeout`) | `reconcile()` when `started_at` is older than `PROVIDER_TIMEOUT_S + 120` s (worker lost the job) | release | yes |

A job in any other state is left alone by `processJob`, so duplicate deliveries do nothing. `cancelJob` on a processing job only sets `cancel_requested`; the worker polls that flag every 2 s and aborts. `DELETE /api/generations/[id]` soft-deletes only finished or unstarted jobs (409 `job_active` otherwise).

### One attempt, step by step

1. Claim in a transaction (above).
2. Look up the adapter. Missing or unconfigured means `provider_unavailable`, not retried.
3. Load inputs. Every input asset must be clean and not deleted. A character reference must be undeleted, its likeness consent not withdrawn, and its photo clean. Otherwise the job fails with `invalid_input` and is refunded, without calling the model.
4. Call `adapter.execute` with an `AbortController` that fires after `PROVIDER_TIMEOUT_S` (default 600 s) or on cancel. The provider's job id is saved as soon as it is known.
5. Check each output's quality (at least 1024 bytes; images must decode and be at least 64 by 64; MP4 must contain `ftyp`; a failure is `internal`), store it under `outputs/<userId>/<uuid>.<ext>` as a private asset, and scan it (section 8).
6. For video, extract a poster frame at 0.5 s with ffmpeg, convert it to WebP, and give it the output's verdict (`recordDerivedScan`). A poster failure does not fail the job.
7. Final transaction: if the job is no longer `processing`, discard the files; if `cancel_requested`, release and cancel; otherwise insert outputs, settle, mark completed.
8. Any fault while storing removes the rows and files this attempt wrote (`discardAfterFault`), then fails the job with `internal` and refunds.

### Reconcile sweeps

`reconcile()` returns `{requeued, failed, expiredDrafts}`:

| Sweep | Condition | Action |
|---|---|---|
| Draft expiry | `awaiting_confirmation` and `created_at` older than 24 h | Cancelled, `failure_code = draft_expired`, `deleted_at` set. These never held credits. |
| Lost queue entries | `queued` and `updated_at` older than 120 s | Re-enqueued as attempt `attempts + 1`. The entry id makes this a no-op if the entry still exists. |
| Dead worker | `processing` and `started_at` older than `PROVIDER_TIMEOUT_S + 120` s | `finishFailed` with non-retryable `timeout`; credits released. |

This is also how a failed enqueue recovers: if the enqueue call fails after a job is confirmed, `confirmJob` still commits the queued job with its reservation, logs `generation.enqueue_failed`, and the next sweep enqueues it.

### Scanner-outage requeue

When the scanner returns `unavailable` for an output and `SCAN_FAIL_CLOSED=true` (the default), every file the attempt stored is discarded and the attempt ends with the retryable error `scan_unavailable`. The job returns to `queued` with its reservation held and is retried with backoff. After `max_attempts` (3) it fails and is refunded. Nothing unscanned is ever shown.

### Notifications

`notifyJobFinished` (`src/server/push/notify.ts`) is called fire-and-forget on completion and from `finishFailed`. It never throws into the processor. The cases marked "no" in the table above (cancel through the API while queued, cancel found at claim, cancel during storing, draft expiry) send nothing.

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

On when `ENABLE_DEMO_PROVIDER=true` (the default). It makes no AI call. It renders a seeded SVG card carrying the caption of the prompt and the watermark "DEMO OUTPUT · NOT AI-GENERATED". Images are WebP with a long side of 1280 px (2048 for 4k). Videos are rendered by ffmpeg as a 24 fps H.264 zoom-and-pan that follows the chosen camera movement. A source image or character reference is composited under the overlay. That is not a likeness match. Demo outputs are stored with `is_demo = true` and labeled in the interface, in download file names (`-demo`) and in templates.

### Replicate adapter (Unverified)

No `REPLICATE_API_TOKEN` exists, so this adapter has never run against Replicate.

| Step | Behavior |
|---|---|
| Create | `POST /v1/models/{model}/predictions` |
| Poll | `GET /v1/predictions/{id}` with backoff from 1 s up to 8 s |
| Cancel | Cancels the prediction on abort or error |
| Inputs | Only `flux-schnell` has an input builder: prompt, `aspect_ratio`, `num_outputs: 1`, WebP, seed. Lighting, framing, atmosphere (and pacing, for video) reach the model as words appended to the prompt (`promptWithSettings`). A character reference on a model with no reference field fails with `unsupported` instead of being dropped. |
| HTTP errors | 401 or 403 to `provider_unavailable`; 404 to `unsupported`; 422 to `invalid_input` (message includes up to 300 characters of the body); 429 to `rate_limited` (retryable); 5xx to `provider_unavailable` (retryable); network errors retryable; abort to `timeout` |
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

`WebhookRejected` reasons: `unsigned`, `bad_signature`, `replayed`, `malformed`. Every provider maps its events to one normalized `PaymentEvent`: `purchase_completed`, `subscription_started` (with `grantsFirstPeriod`), `subscription_renewed`, `subscription_updated`, `subscription_cancelled`, `refund` (with `subscriptionRef` and `cumulative`), `chargeback`, or `ignored`.

### Catalog (placeholder prices, USD)

| Key | Name | Credits | Price | Extra |
|---|---|---|---|---|
| `pack_small` | Spark | 100 | $9.99 | |
| `pack_medium` | Flicker | 550 | $44.99 | |
| `pack_large` | Blaze | 1200 | $89.99 | |
| `plan_member` | Night Pass | 400 per period | $19.99 | 3 active jobs, VIP templates |
| `plan_studio` | Studio Pass | 1500 per period | $59.99 | 6 active jobs, VIP templates |

A pass counts while its status is `active` or `trialing` and its period end is empty or in the future. A cancelled pass (`canceled`) stops counting immediately, not at the end of the paid period.

### Providers

| Provider | Status | Checkout | Webhook verification |
|---|---|---|---|
| `sandbox` (default) | Sandbox. Refuses to work on a live site. | A 30-minute HMAC token over user and item, sent to `/pricing/sandbox?t=`. That page's buttons post to `/api/pricing/sandbox`, which builds and signs a webhook body (sale, failure, renewal, cancel, refund, chargeback) and runs it through the real handler. | Header `x-sandbox-signature: t=<s>,v1=<HMAC(t.body)>` with a constant development secret; outside a 5-minute window is `replayed`. |
| `ccbill` | Unverified (no merchant account) | FlexForms URL `https://api.ccbill.com/wap-frontflex/flexforms/{flexId}` with `formDigest`: packs `md5(price + 30 + 840 + salt)`, passes `md5(price + 30 + price + 30 + 99 + 840 + salt)`. Pass-through `X-hlUser`, `X-hlItem` and `X-hlSig = HMAC-SHA256(salt, "ccbill:user:item")`. | `clientAccnum` must match. If `CCBILL_WEBHOOK_TOKEN` is set, `?token=` must match. `NewSaleSuccess` must carry `dynamicPricingValidationDigest = md5(subscriptionId + "1" or "0" + salt)`. Lifecycle events carry no digest, so they need the token. The pass-through signature must verify. |
| `segpay` | Unverified (no merchant account) | `https://secure2.segpay.com/billing/poset.cgi?x-eticketid=<package>:<pricepoint>` with `x-billemail`, `x-auth-link`, `x-decl-link` and pass-through `hluser`, `hlitem`, `hlsig` (HMAC). | Segpay signs nothing. A postback must carry `?key=` or `postbackkey=` equal to `SEGPAY_POSTBACK_SECRET`, or HTTP Basic auth whose password is that secret or `SEGPAY_USER_ACCESS_KEY`. The `hlsig` pass-through must verify. Package and price point must match. |
| `stripe` | Unverified; off unless `PAYMENT_PROVIDER=stripe` and both keys are set | Stripe Checkout | `stripe.webhooks.constructEvent` with the `stripe-signature` header. |

Stripe declares `adultContentAllowed: false`. Stripe lists adult content among restricted businesses (https://stripe.com/legal/restricted-businesses), so it is kept only as an option for non-explicit use. CCBill and Segpay are the adult-capable paths. The CCBill file header lists five points to confirm in CCBill's sandbox before launch: pass-through key spelling, whether refund transaction ids are new or original, whether the webhook URL keeps its query string, timestamp formats, and the pack period. The Segpay header lists four: the postback URL template for pass-through values, GET versus POST delivery, price point ids per item, and `transtime` and `trantype` spellings.

### Event mapping

| Normalized event | sandbox | CCBill | Segpay | Stripe |
|---|---|---|---|---|
| purchase_completed / subscription_started | sale | `NewSaleSuccess` | `Enable`, or `Sale` with stage `Initial` (`approved=No` is ignored) | `checkout.session.completed`, `checkout.session.async_payment_succeeded` when paid (`grantsFirstPeriod: false` for passes) |
| subscription_renewed | renewal | `RenewalSuccess` | `Sale` at any other stage | `invoice.paid` |
| subscription_updated | | | | `customer.subscription.updated` |
| subscription_cancelled | cancel | `Cancellation`, `Expiration` | `Disable`, `Cancel`, `Cancellation` | `customer.subscription.deleted` |
| refund | refund | `Refund`, `Void`, `Return` | `Credit`, `Void` (by `relatedtranid`) | `charge.refunded` (cumulative amount) |
| chargeback | chargeback | `Chargeback` | `Charge` | `charge.dispute.created` |
| ignored | failure | anything else | anything else | anything else |

Event ids: CCBill `${eventType}:${transactionId or subscriptionId}:${timestamp}`; Segpay `sale:`, `rebill:`, `credit:`, `void:`, `chargeback:` or `<action>:` plus the transaction id; Stripe the event id.

### Webhook handling and the exactly-once rule

`handlePaymentWebhook` (`src/server/payments/webhook.ts`):

1. Unknown provider: 404.
2. The provider is accepted when it is the active provider with its webhook configured, or a non-sandbox provider with its own webhook secrets present, so refunds and chargebacks for an earlier processor still land. Otherwise 503.
3. `verifyWebhook` failures return 400 with the reason as the code.
4. `processPaymentEvent` runs in one transaction: insert into `payment_events` with `ON CONFLICT DO NOTHING` on (`provider`, `provider_event_id`). A duplicate returns outcome `duplicate` and changes nothing. Otherwise the event is applied, `processed_at` is set, and `payment.<type>` is audited with a null actor.
5. A renewal for a subscription the database has never seen throws. The transaction rolls back, the route returns 500, and the provider retries later.

Credit grants use ledger keys `<provider>:<providerEventId>`, so even a replayed event that slipped past step 4 cannot grant twice.

| Event | Effect |
|---|---|
| purchase_completed | Grants the pack's credits (`purchase`). |
| subscription_started | Upserts the subscription; grants the first period when `grantsFirstPeriod` (`subscription_grant`). |
| subscription_renewed | Grants the period and refreshes `current_period_end`. |
| subscription_updated / cancelled | Sets the status; cancelled becomes `canceled`. |

### Refunds and chargebacks

1. Find the original grant by provider and `transaction_ref` with credits above 0, else by `metadata.subscriptionRef`. If none is found, the event is recorded as `ignored` with `original_not_found`.
2. Target reversal is pro rata: `min(granted, ceil(granted x totalReversed / paid))`, or the full grant when amounts are zero.
3. Owed is the target minus what earlier reversals of the same original already took back (summed by `metadata.reversesEventId`). This makes partial and cumulative refunds safe.
4. Reverse `min(available, owed)` with ledger kind `refund` or `chargeback` (keys `refund:<provider>:<eventId>`, `chargeback:<provider>:<eventId>`). Credits already spent are not taken from reservations.
5. A shortfall adds a `credit_debt` flag. A chargeback always adds a `chargeback` flag.

### Flags

An open `chargeback` flag blocks checkout (403 `account_flagged`). Admins clear flags through `/api/admin/flags` (audit `flag.clear`). A `csam_match` flag cannot be cleared there (409 `use_review_queue`). `credit_debt` and `manual_review` flags are informational; nothing else reads them.

## 7. Age verification

Sources: `src/server/age/*`, `src/config/jurisdictions.ts`.

### Two layers

| Layer | What it does | Where |
|---|---|---|
| Self-declaration | Signup requires a date of birth showing age 18 or over, `confirmAdult: true` and `acceptTerms: true`. Under 18 returns 403 `underage` and stores nothing. Two consent records (`terms`, `adult_attestation`) are written. | Everywhere |
| Age gate page | An interstitial asking visitors to confirm they are adults; `/api/age-gate` sets `hl_age_ok` for 30 days. It renders only when there is no session, no `hl_age_ok` cookie, and the path is outside `/policies`. | Everywhere |
| Provider check | A real age check with a provider before creating, uploading or seeing explicit media. | Required jurisdictions only |

### Rules

| Setting | Default | Meaning |
|---|---|---|
| `AGE_VERIFICATION_ENFORCE` | true | Turns the provider check on. |
| `AGE_VERIFICATION_REGIONS` | GB plus 25 US states: AL, AR, AZ, FL, GA, ID, IN, KS, KY, LA, MO, MS, MT, NC, ND, NE, OH, OK, SC, SD, TN, TX, UT, VA, WY | Codes are `GB` or `US-TX`. A bare `US` covers every state. `AGE_ASSURANCE_STRICT_REGIONS` is added to the list. |
| `AGE_VERIFICATION_FAIL_CLOSED` | false | What to do when the jurisdiction is unknown. False means allowed. |
| `AGE_VERIFICATION_VALID_DAYS` | 365 | A verification older than this reads as `expired` and blocks again. |
| `GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER` | `x-country-code`, `x-region-code` | Headers the edge must set. They are trusted as received. |

The UK list follows Ofcom's highly effective age assurance duty, in force from 25 July 2025 (https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance). The US list draws on the Free Speech Coalition's tracker, which counts 27 states (https://www.freespeechcoalition.com/faq). The default list has 25 states and is not legal advice; counsel must confirm it.

`requirementFor` uses the account's stored `jurisdiction` first, then the request's geo headers. The stored value is written at signup and refreshed at each login; a login without the header keeps the old value. `satisfied` means "not required" or "verified and not expired".

### Providers

| Provider | Status | Start | Result |
|---|---|---|---|
| `sandbox` (default) | Sandbox, labeled "Sandbox check (proves nothing)". Refuses to work on a live site. | Sends the user to `/verify/sandbox?ref=`. That page returns 404 on a live site, when another provider is active, or for anyone but the pending owner. | A callback signed with `x-hushloom-sandbox-signature` (HMAC-SHA256 hex with `AGE_VERIFICATION_WEBHOOK_SECRET`, or a development fallback). |
| `yoti` | Unverified (no account) | `POST {AGE_VERIFICATION_API_URL}/api/v1/sessions` with Bearer key and `Yoti-SDK-Id`. Session type `OVER`, TTL 1800 s, `reference_id`, callback `/api/age-verification/return`. Methods: age estimation with threshold 25, document scan 18, digital ID 18; credit card and mobile off. `notification_url` is sent only for HTTPS. The user goes to the hosted page with `sessionId` and `sdkId`. | `GET /api/v1/sessions/{id}/result`: `COMPLETE` becomes verified; `FAIL`, `ERROR`, `CANCELLED`, `EXPIRED` become failed with a reason; anything else stays pending. Notifications are verified with RSA-PSS SHA-256 against the pasted PEM key. |

### Status lifecycle

| Step | Effect | Audit |
|---|---|---|
| Start | 503 `age_verification_unavailable` if unconfigured; 409 `already_verified` if verified. Inserts a pending `age_verifications` row, calls the provider (a failure records a failed row and returns 502), sets the user `pending`. | `age_verification.pending` (actor: user) |
| Callback or return | Unknown reference 404 `unknown_reference`; a row no longer pending 409 `callback_replayed`; a pending outcome changes nothing. Only the active provider is accepted. | |
| Verified | Row and user set to verified with `expires_at`. | `age_verification.verified` (actor null) |
| Failed | Reason recorded. A failed result never downgrades a user who is already verified. | `age_verification.failed` (actor null) |
| Expired | Computed when read from `age_verified_at` and `VALID_DAYS`. Not stored. | |

### Gating as built

| Surface | Gate |
|---|---|
| POST `/api/generations` | `assertAgeVerified` with country and region: 451 `age_verification_required`, `details: {verifyPath: "/settings#age-verification", status, jurisdiction}` |
| POST `/api/generations/[id]/derive` | Same check, but the route passes the country only, not the region. |
| POST `/api/uploads` | Same check, before the rate limit. |
| POST `/api/characters` | **Not gated.** |
| Discovery cards, template pages, creator pages, rails, favorites page, GET `/api/templates` | `viewerAccess()` (cached per request) decides `explicitAllowed`. When false, poster and preview URLs are null and `mediaWithheld` is true. Every public template is treated as explicit. |
| The user's own library | Not gated. |

## 8. Abuse scanning

Sources: `src/server/safety/scan/*`, `src/server/safety/review.ts`, `src/server/safety/takedowns.ts`, `src/server/media.ts`. The operating procedure is in [docs/abuse-response.md](abuse-response.md) (pipeline, verdicts, a match, evidence preservation, the review queue, reporting for legal review, takedowns, fail-closed rules, what production needs, what is unverified, known gaps).

### Pipeline

Every file is scanned before anyone can see it. Only assets with `scan_status = clean` are ever served, published or sent to a model.

| Origin | When scanned | Outcome on `matched` | Outcome on `unavailable` (fail-closed) | Outcome on `unavailable` (fail-open) |
|---|---|---|---|---|
| Upload (`/api/uploads`, `/api/characters`) | After re-encoding, before the response | 403 `upload_rejected` | Upload row and its consent record deleted, asset soft-deleted, bytes purged; 503 `scan_unavailable` | Stored with warning `scan_pending`; never served while `unavailable` |
| Generation output | After storing, before the job completes | Other outputs discarded; job fails `content_blocked`; refunded | All outputs discarded; retried, then failed and refunded (section 4) | Job completes and is charged, but the output stays `unavailable` and is never served |
| Video poster | After extraction | Takes the output's verdict through `recordDerivedScan` (`scan_ref = derived:<parentId>`) | | |
| Published copy | Copied at publish | Carries the source's clean verdict; publish refuses anything not clean or on hold (409 `not_cleared`) | | |

`runScan` never throws. It is bounded by `SCAN_TIMEOUT_S` (default 30). Videos are scanned as keyframes (ffmpeg at 1 frame per second, at most 30 frames); a scanner that declares the `video` capability also gets the whole file. `scripts/scan-backfill.ts --include-unavailable` rescans assets left `unavailable`.

### Scanners

| Provider | Status | Capabilities | Notes |
|---|---|---|---|
| `dev` (default) | Dev, labeled "Development scanner (matches test hashes only)" | hash match, pre-storage | Matches SHA-256 values: the drill fixture `tests/fixtures/scan-drill-match.png` and any listed in `SCAN_DEV_MATCH_HASHES`. `SCAN_DEV_SIMULATE_OUTAGE` forces `unavailable`. On a live site it always returns `unavailable`. |
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

### On a match (`recordVerdict`, once per asset)

1. `scan_status = matched`, `legal_hold = true`.
2. Templates using the asset publicly are set to `removed`.
3. A moderation event `escalate` (open) with reason `csam_match` (or `abuse_match` for an abuse category), and details: sha256, source sha256, provider, ref, origin, owner id, job id, storage key.
4. Audit `scan.block`.
5. Account flag `csam_match` (or `manual_review` for the abuse category, which no current scanner returns).
6. For CSAM: the account is suspended if active (audit `user.suspend`) and all its sessions are deleted.

### Legal hold

A held asset's file is never purged. Consent withdrawal, account deletion, unscanned-upload discards and attempt discards also leave its row alone. Deleting a creation marks a held asset deleted, but the purge still keeps its file. Only the review queue lifts a hold.

### Review queue (`/admin/review`)

| Action | Input | Effect | Audit |
|---|---|---|---|
| Confirm | `reportRef` (3 to 120), `reportedTo` (`ncmec_cybertipline`, `iwf`, `other_authority`), `note` | Hold stays; event resolved; a `hold` event is written | `scan.match_confirmed` |
| Clear (false positive) | `note` (at least 3) | Asset set clean with `scan_ref = review-cleared:<id>`; hold lifted; an `approve` event; the related flags cleared; the owner reinstated if no other open `csam_match` flag remains | `scan.false_positive_cleared`, `user.reinstate` |

Removed templates are not restored on clear. A resolved item returns 409. The ordinary reports endpoint refuses escalations (409 `use_review_queue`). Filing the report with NCMEC or IWF happens outside the app; the app records the reference.

### Takedowns

Anyone can file at `/api/takedowns`. Signed-out requesters must give an email. `resolveTarget` accepts a UUID (output, template or asset) or a Hushloom link (`/templates/`, `/collection/`, `/api/media?k=`). The admin list puts urgent categories (csam, ncii, likeness) first.

| Admin action | Effect | Audit |
|---|---|---|
| Action | Soft-deletes the target. `ncii` and `likeness` targets are purged from storage at once. `csam` targets are put on legal hold with an `escalate` event (`csam_report`) instead. | `takedown.action` |
| Dismiss | Requires a note (422 `note_required`) | `takedown.dismiss` |

An unresolvable target returns 422 `target_not_found`.

### Prompt policy

`checkPrompt` (`src/server/safety/policy.ts`) runs regex categories (minors, non_consent, real_person, bestiality, incest, extreme_harm) over the prompt, negative prompt and free-text settings, after normalizing leetspeak, separated letters and repeated characters. It runs at draft (including derived drafts), at publish and at template update. Saved presets are not checked. A block returns 422 `policy_blocked` and writes an `auto_block` moderation event holding only the category and matched words.

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
| Navigation to a public page | Network first; on failure the cached copy, then the cached `/offline` page, then an inline 503 page |
| Navigation under `/collection`, `/projects`, `/studio`, `/train`, `/settings`, `/admin`, `/favorites`, `/pricing`, `/auth`, `/verify` | Network only; never cached |
| `/api/*`, other origins, non-GET, `Range` requests | Not handled; the browser goes to the network |

`shouldCache` refuses non-200, opaque, redirected, `private` or `no-store` responses and anything under `/api`. The install step precaches the manifest, icons and `/offline` (fetched without credentials, with its headers stripped) plus the static files `/offline` needs. Activation calls `skipWaiting` and `clients.claim` and deletes older `hushloom-` caches. In development the worker is registered as `/sw.js?mode=dev` and caches nothing. `next.config.ts` serves `sw.js` with `no-cache`, `Service-Worker-Allowed: /` and a script CSP of `default-src 'self'; script-src 'self'`.

### Offline guard

`OfflineGuard` wraps actions that need the network in a disabled `fieldset` while offline: Make and Confirm on the create panel, the creation detail actions, Library retry, Branch and Continue on projects, and Buy on pricing. The job tray pauses polling while offline. Background sync is **not built**.

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
| Sign out everywhere, account deletion, suspension | All of the user's subscriptions are removed (`destroyAllSessions`). |
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
| Age gate cookie | `hl_age_ok`, httpOnly, Lax, 30 days. It only hides the adults-only interstitial; it grants nothing. |

### CSRF and Origin

Session cookies are `SameSite=Lax`, so other sites cannot send them on cross-site POSTs. The middleware also refuses writes (POST, PUT, PATCH, DELETE) to `/api/*` whose `Origin` header names a different origin (403 `bad_origin`). Requests without an `Origin` header are allowed. Webhooks are exempt because they authenticate with signatures.

### Roles

| Role | How it is set | Permissions |
|---|---|---|
| member | Signup | Everything a signed-in user can do on their own data. |
| creator | Set automatically on first publish | A label only. It grants no extra permission. |
| admin | Set in the database (the seed creates one) | Admin pages and APIs; can edit any template. Non-admins get 404 from admin APIs and pages. |

Service functions filter by owner. Data that is not yours returns 404, the same as data that does not exist. The end-to-end journey checks this for creation pages, GET, derive and DELETE. VIP templates need an active pass (403 `vip_required`).

### Suspension

An admin suspension sets `status = suspended`, unpublishes the account's live templates (the count is audited as `user.suspend`), and deletes every session and push subscription. An automatic suspension on a CSAM match sets the status and deletes sessions; it removes only the templates that used the matched asset. The account can no longer sign in. Reinstatement happens only through the review queue when a false-positive CSAM match is cleared. No route reverses a manual suspension (**not built**).

## 11. Credit ledger rules

Source: `src/server/credits/ledger.ts`.

`applyMovement(tx, {userId, kind, availableDelta, reservedDelta, idempotencyKey, jobId?, paymentEventId?, note?})` is the only code that changes a balance. It runs inside the caller's transaction:

1. Upsert the `credit_accounts` row and lock it `FOR UPDATE`.
2. If a ledger row with the same `idempotency_key` exists, return `{applied: false}` and change nothing.
3. Compute the new balances. `available < 0` throws `InsufficientCreditsError` (402). `reserved < 0` throws an invariant error (500).
4. Write the ledger row with both deltas and both resulting balances, then update the account.

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

The seed script also grants demo credits with keys `seed:<memberId>`.

Settle and release share one key, so a reservation can close exactly once: whichever runs first wins, and the other is a no-op. Retries keep the reservation in place; credits move only when a job reaches a terminal state.

### Invariants

| Invariant | Enforced by |
|---|---|
| `available >= 0` and `reserved >= 0` | Check constraints and the `applyMovement` checks |
| Each ledger row is applied at most once | Unique `idempotency_key` (global) |
| Ledger rows explain every balance | `available_after` and `reserved_after` on every row, written under the row lock |
| A job holds credits only while queued or processing | Reserve at confirm, settle or release at the terminal state |
| A refund never takes more than was granted | Pro rata target capped at the grant, minus earlier reversals |
| A refund never makes `available` negative | Reverses `min(available, owed)`; the shortfall becomes a `credit_debt` flag |

## 12. File storage

Source: `src/server/storage/index.ts`, `src/server/media.ts`.

### Drivers

| Driver | Status | Behavior |
|---|---|---|
| `local` (default) | Operational | Files under `STORAGE_LOCAL_DIR` (default `.storage`; absolute path required in production). `safeLocalPath` checks the key against a pattern and confirms the resolved path stays inside the directory. |
| `s3` | Unverified (never run, including against the bundled MinIO; the tests use an in-memory stand-in for the client) | AWS SDK v3; region default `auto`; path-style addressing when an endpoint is set. The bucket stays private and is never linked to: its files are served through `/api/media` like local ones, so the serve-time checks apply to both drivers. |

Interface: `put`, `get`, `delete`, `signedUrl`.

### Keys

`<scope>/<ownerId>/<uuid>.<ext>`. Scopes in use: `uploads`, `outputs`, `templates` (public copies). The `avatars` scope is declared but unused. Purged assets keep their row with `storage_key = purged/<id>` and `bytes = 0`.

### Signed URLs

`assetUrl` returns no URL for an asset that is deleted or not `clean`. A private asset gets a URL only for its owner.

| Asset | TTL |
|---|---|
| Public (template copies) | 3600 s |
| Private | `MEDIA_URL_TTL_S`, default 300 s |

URLs (both drivers) are `/api/media?k=<key>&e=<expiry>&s=<sig>[&d=<name>]`, where the signature is HMAC-SHA256 over `key\nexpiry\ndownload` with `MEDIA_SIGNING_SECRET`. The expiry is rounded up to the next TTL boundary (`ceil((now + ttl) / ttl) x ttl`) so URLs stay stable for browser caching. A link therefore lives between one TTL and just under two.

`/api/media` checks the signature and expiry (403 "Link expired or invalid."), then re-reads the asset row and refuses anything deleted or not clean (404). It answers with `Cache-Control: private, max-age=<seconds left>`, `X-Robots-Tag: noindex`, a `Content-Disposition` when a download name is set, and supports `Range` (206, or 416 when unsatisfiable). The same route serves S3 media, reading the object from the bucket, so a removed, held or matched asset stops being served at the next request through any driver, including through links issued earlier. The cost is that S3 media traffic passes through the web process.

### Uploads

| Type | Limits | Processing |
|---|---|---|
| Image | 20 MB and 40 megapixels (413 `too_large`, read from the header before anything is decoded); JPEG, PNG or WebP; only the first frame of an animated or multi-page file | Re-encoded to WebP quality 92 with EXIF rotation applied, which strips EXIF and GPS, flattened onto black, and downscaled to fit 4096 px. A short side under 512 px adds the warning `low_resolution`. Every decode of outside bytes (uploads, the PhotoDNA copy, provider outputs, poster frames) uses the same limits (`src/server/images.ts`). |
| Video | 100 MB; must contain an `ftyp` box (else 415) | Metadata and chapters stripped with `ffmpeg -map_metadata -1 -map_chapters -1 -c copy`. Unreadable files get 415; a missing ffmpeg gets 503 `video_processing_unavailable`. |

Stored under `uploads/<userId>/<uuid>.(webp|mp4)` with a consent record (`upload_subject`, or `likeness` for a character reference).

### Posters

For every video output the worker extracts a frame at 0.5 s and stores it as WebP quality 82. Publishing copies the output (and poster) bytes into new public assets under `templates/`; the user's original stays private.

### Purge

| Path | When | Rule |
|---|---|---|
| `purgeDeletedMedia(30)` | Worker, hourly | Up to 500 assets per run that were soft-deleted more than 30 days ago and are not on legal hold. Deletes the file and marks the row purged. |
| `purgeAssetsNow` | Immediately | Consent withdrawal, `ncii` and `likeness` takedowns, uploads that could not be scanned (fail-closed), files from a failed attempt, discarded outputs. Held assets are skipped. |

## 13. Privacy and consent architecture

### Consents

| Kind | Recorded when | Withdrawable |
|---|---|---|
| `terms`, `adult_attestation` | Signup | Only by deleting the account (422 `use_account_deletion`) |
| `upload_subject` | Each upload (`consent="true"` and a subject) | Yes |
| `likeness` | Each character reference (`consentAdult` and `consentLikeness`) | Yes; deleting the character withdraws it |
| `training_data` | Never (declared, not used) | n/a |

Withdrawing an upload or likeness consent (`withdrawConsent`) soft-deletes the character references under it, every job and output that used those uploads or references (setting `cancel_requested` on running ones), and the media itself (except legal hold). It audits `consent.withdraw` and purges the files at once. A running job also re-checks the likeness consent before sending the reference to a model.

### Likeness

A character reference requires a likeness consent stating the person is an adult who agreed. Templates can never be published from a creation that used an upload or a character (403 `personal_media`). The demo provider composites a reference into its placeholder; it does not produce a likeness.

### Account deletion

`DELETE /api/me` with the password:

| Data | What happens |
|---|---|
| `users` | Status `deleted`, email replaced with `deleted-<uuid>@invalid`, password hash replaced with `!`, `date_of_birth` set to null. `age_assured_at` and `age_assurance_method` are kept as the record that age was checked. |
| Profile | Anonymized |
| Media | Soft-deleted (except legal hold); files purged by the worker after 30 days |
| Jobs and outputs | Soft-deleted, with `cancel_requested` set |
| Templates | Set to `removed` |
| Discovery events | Deleted |
| Consents | Marked withdrawn |
| Sessions and push subscriptions | Deleted |
| Audit | `account.delete` |

Migration 0003 nulled the date of birth of accounts deleted before it existed.

### History and personalization

Turning history off clears the user's discovery history. `DELETE /api/me/history` clears it on demand (audit `history.clear`). With personalization off, For You falls back to trending.

### What logs may contain

| Rule | How |
|---|---|
| No prompts, media or secrets in logs | Log lines carry ids, codes and counts. Push logs carry job id, outcome and counts, never endpoints. |
| Query parameters redacted | `redactQueryParams` replaces Drizzle's `params:` block with `[redacted]` in messages and stacks. |
| Blocked prompts | Only the category and matched words are kept, in `moderation_events`. |
| Route errors | Logged with the path only, never the query string or body. |

Known exceptions in this snapshot: a Replicate 422 response body (up to 300 characters, which can echo the prompt) is part of the provider error message that `generation.provider_error` logs; Yoti error bodies (up to 300 characters) are logged; Next.js's own error printer can print Drizzle parameters to stdout outside the app logger.

### Error webhook redaction

The error webhook (section 14) never sends request bodies. Each event carries only `source`, `time`, `message`, `error` (name, message, stack, digest, cause), `route`, `path`, `method`, and context limited to `jobId`, `verificationId`, `provider`, `outcome` and `routeType`. Query parameters are redacted, the message is clipped to 1000 characters, the stack to 8000 and other fields to 200.

## 14. Error handling and observability

### Error handling

| Layer | Behavior |
|---|---|
| API routes | `route()` maps errors to the envelope in section 3. Unknown errors become 500 `internal` and are logged with the path. |
| Generation | Provider errors are classified as retryable or not; users see fixed sentences that say credits were returned. Every failure path releases the reservation. |
| Worker | Never relies on BullMQ retries. Crashes are logged; `reconcile()` recovers stuck jobs. |
| Notifications | Never throw; failures are logged and swallowed. |
| Pages | App Router `error.tsx`, `global-error.tsx`, `not-found.tsx` and `loading.tsx`. |

### Logging (`src/server/log.ts`)

One JSON line per entry: `{t, level, msg, ...fields}`. `warn` and `error` go to stderr, the rest to stdout. Errors in fields are serialized with name, redacted message, redacted stack and cause. Under test only errors print unless `LOG_TESTS` is set.

### Error webhook (`src/server/observability.ts`)

When `ERROR_WEBHOOK_URL` is set, every `error`-level entry is posted as one JSON event. The web app installs it in `src/instrumentation.ts` (source `web`) and the worker at startup (source `worker`). Delivery is fire-and-forget with a 3 s timeout and at most 30 events per minute; dropped events are counted. Delivery failures produce warnings that never include the URL. Next's `onRequestError` hook logs the failing path without its query string (Node runtime only).

### Health

| Check | Endpoint | Meaning |
|---|---|---|
| Web | `GET /api/health` | 200 when Postgres answers `select 1` and Redis answers `PING`; 503 otherwise. Used by the web image's `HEALTHCHECK`. |
| Worker | `GET /health` on `WORKER_HEALTH_PORT` (3901 in the images and e2e) | 200 while the BullMQ worker is running. |

### Audit log

Every privileged or sensitive change writes `audit_logs`: `account.create`, `account.delete`, `age_verification.pending`, `age_verification.verified`, `age_verification.failed`, `consent.withdraw`, `creation.delete`, `credits.adjust`, `flag.clear`, `history.clear`, `model.configure`, `moderation.remove`, `moderation.dismiss`, `payment.<type>`, `profile.update`, `push.subscribe`, `push.unsubscribe`, `scan.block`, `scan.false_positive_cleared`, `scan.match_confirmed`, `sessions.revoke_all`, `takedown.action`, `takedown.create`, `takedown.dismiss`, `template.publish`, `template.update`, `user.reinstate`, `user.suspend`.

Metrics, tracing and dashboards are **not built**. The error webhook is the only alerting path.

## 15. Security

### Threat model summary

| Threat | Controls in the code | Gaps observed in the code |
|---|---|---|
| Minors using the service | Date of birth at signup (under 18 refused, nothing stored), adult attestation, adults-only interstitial, provider age check in required jurisdictions, explicit media withheld until checked | Geo headers are trusted as sent. Unknown jurisdiction is allowed by default (`AGE_VERIFICATION_FAIL_CLOSED=false`). Derive passes country only. `POST /api/characters` is not gated. Sandbox and Yoti are the only providers and Yoti is unverified. |
| Sexual content involving minors | Prompt policy, hash scanning of every upload and output before display, fail-closed scanning, legal hold, automatic suspension, review queue with report reference | Dev scanner only matches test hashes; PhotoDNA is unverified; the Cloudflare tool sees nothing pre-storage. |
| Non-consensual and real-person content | Prompt policy categories, likeness consent, consent withdrawal that deletes derived work, `personal_media` publish block, takedowns with immediate purge for NCII and likeness | Policy is keyword-based. |
| Account takeover | bcrypt cost 12, constant-time miss, login rate limits per IP and per email, hashed session tokens, httpOnly cookies, sign out everywhere | No multi-factor authentication or password reset flow (**not built**). `x-forwarded-for` is trusted as sent. |
| Cross-site request forgery | SameSite=Lax cookies; Origin check on API writes | Missing `Origin` is allowed. |
| Insecure direct object reference | Owner filter in every query; 404 for not-yours; admin routes 404 for non-admins | |
| Media leakage | Private by default, HMAC-signed short-lived URLs, serve-time scan and deletion re-check, `Cache-Control: private`, `noindex`, EXIF/GPS and video metadata stripped | Local links can live up to just under two TTLs. S3 links skip the serve-time re-check. |
| Payment fraud and replay | Signature or secret checks per provider, 5-minute window on the sandbox, unique event ids, ledger idempotency keys, chargeback flag blocks checkout | CCBill and Segpay checks follow public docs and are unverified. |
| Credit abuse | Row-locked ledger, non-negative checks, cost confirmation, active-job cap, draft rate limit | |
| Service worker caching private data | Private prefixes network-only, `/api` never cached, `shouldCache` refuses private and no-store responses | |
| Secret and data leakage in logs | Redacted query parameters, whitelisted webhook context, no bodies | Replicate 422 body and Yoti error bodies reach logs; Next's error printer can print parameters. |
| Clickjacking and sniffing | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera, microphone and geolocation, `X-Robots-Tag: noindex, nofollow`, `poweredByHeader: false` | No page Content-Security-Policy and no HSTS header (**not built**). |
| Misconfigured live deployment | Startup refuses dev scanner and sandbox age checks on a live site while enforcement is on; sandboxes refuse to run live; signing secret required in production | The seed script has no live-site guard outside compose. No reverse proxy is bundled. |

### Other observations from the code

- A manual suspension cannot be reversed through any route.
- Under fail-open scanning, a generation output can be charged but never served.
- `CCBILL_DATALINK_USER`, `CCBILL_DATALINK_PASSWORD` and `CLOUDFLARE_SCAN_WEBHOOK_SECRET` are declared but unused.
- Every public template is treated as explicit for age gating.

Adversarial review results: see verification report

## 16. Testing

### Layout

| Path | Kind | Runner |
|---|---|---|
| `tests/unit/*.test.ts` | Pure logic, no database | vitest |
| `tests/integration/*.test.ts` | Real Postgres (`playbox_test`, migrated by `tests/global-setup.ts`) and Redis db 1 | vitest |
| `tests/e2e/journey.spec.ts` | Full browser journey against a production build | Playwright |
| `tests/helpers.ts` | `resetDb` (truncates), `makeUser`, `key()` | |
| `tests/fixtures/scan-drill-match.png` | The dev scanner's drill image | |

vitest runs with `NODE_ENV=test`, fake CCBill, Segpay and Stripe secrets, files in sequence (`fileParallelism: false`) and 30 s timeouts.

### How to run

| Command | What it does |
|---|---|
| `npm test` | vitest unit and integration suites (needs Postgres and Redis) |
| `npm run test:e2e` | Playwright |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `next lint --max-warnings 0` |
| `npm run verify` | typecheck, lint, test, build, e2e |

Playwright (`playwright.config.ts`) uses port 3100 with `NODE_ENV=production` and `APP_ENV=test`, database `playbox_e2e` and Redis db 2. Its web server step runs `scripts/e2e-prepare.ts` (drops and recreates the schema, migrates, seeds, runs the scan backfill), builds Next.js, copies static and public files, and starts the standalone server plus the worker (health on 3901).

### Counts at `c52f843`

vitest: **258 tests in 23 files** (14 unit, 9 integration; `it.each` cases expand the count). Playwright: **8 journey tests**. A launch journey (`tests/e2e/launch.spec.ts`) is being added and is not in this snapshot.

Last recorded results: typecheck 0 errors, lint 0 errors, vitest 258 of 258 at merge `a432052`; Playwright 8 of 8 last run at `0686f87`.

### What the suites cover

| File | Tests | Covers |
|---|---|---|
| unit/age | 4 | Jurisdiction codes, sandbox callback signing, Yoti notification signatures, Yoti status mapping |
| unit/contrast | 5 | Design token contrast at WCAG AA |
| unit/copilot | 12 | Copilot rules: policy blocks, contradictions, nearest aspect ratio, low-resolution input |
| unit/draft-key | 5 | Client idempotency key reuse and renewal |
| unit/env-template | 5 | `.env.example` lists every variable, sets nothing, holds no secrets |
| unit/env | 5 | Live-deployment guard and sandbox refusals |
| unit/manifest | 7 | Manifest fields, icons, precache files exist, `sw.js` headers |
| unit/observability | 12 | Error webhook content, redaction, timeouts, rate cap |
| unit/policy | 4 plus 2 `it.each` | Policy categories, normalization, age arithmetic |
| unit/provider-input | 5 | `promptWithSettings`, Replicate input mapping, reference refusal |
| unit/push-payload | 4 | Payload carries nothing but the outcome and job id |
| unit/registry | 3 | Cost and capability checks |
| unit/signatures | 3 | Local media signatures, Replicate webhook signatures |
| unit/sw-rules | 20 | Service worker routing and storage rules |
| integration/age | 17 | Configuration, 451 gate, sandbox flow, replays, expiry, media withholding, settings |
| integration/composing | 8 | Remix and reuse, presets, publish policy, video metadata stripping |
| integration/enqueue-failure | 1 | Confirm succeeds and holds credits when Redis is unreachable |
| integration/generation | 28 | Full lifecycle, charge once, idempotency, cancel, retries, timeouts, dead worker, policy, capabilities, concurrency cap, cross-user isolation, demo video through ffmpeg, character references, storage faults, draft expiry |
| integration/integrity | 5 | Migration 0003 FKs and DOB nulling, deletion, suspension |
| integration/payments | 21 | Sandbox, Stripe, CCBill and Segpay (locally built events): grant once, rejections, refunds, pro rata, chargebacks, debt flags, passes |
| integration/platform | 23 | Stripe webhook, consent withdrawal, publishing, posters, discovery privacy, accounts, media route, projects, presets, browse, library filters |
| integration/push | 17 | VAPID configuration, endpoint allowlist, subscription lifecycle, notification sends and pruning |
| integration/scan | 19 | Dev scanner, upload and output verdicts, fail-closed and fail-open, legal hold, review queue, takedowns |

### End-to-end journey (`tests/e2e/journey.spec.ts`, serial)

1. Sign up, receive a 40-credit admin grant, open the Velvet Hour template, see cost 4, make a demo placeholder, find it Ready in the Library with a Demo badge, load its image through `/api/media`, and see a balance of 36.
2. Another user gets 404 on the creation page, GET, derive and DELETE; a forged media signature gets 403; a cross-origin POST gets 403.
3. An under-18 signup is refused.
4. A blocked prompt disables the Make button.
5. to 7. Layout at 390, 820 and 1440 px across `/`, `/explore`, `/templates/velvet-hour` and `/pricing` with no horizontal scroll.
8. Keyboard skip link and labeled controls.

Integrations marked Unverified in this document are tested only against locally built requests and responses. None of these tests proves behavior against the real provider.
