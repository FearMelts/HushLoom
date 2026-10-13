# Hushloom spec audit: platform (spec Parts VI, VII, VIII, IX)

Repository: `/home/claude/hushloom`, branch `claude/playbox-2-foundation-q7fpbs`, HEAD `9acac2e` (working tree clean).
Spec: `/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx/spec.md`.
Method: read-only code reading. No commands that change state were run and no npm scripts were run.

Legend for each line: **[V]** = verified by reading the cited code; **[I]** = inference (not directly observed, or depends on results I did not reproduce).
Status values: met / partial / missing / demo-only.

Test results quoted below come from `notes/state.json` and `notes/plan.md` (typecheck, lint, vitest 79/79, build, e2e 8/8 at commit `0987b7c`). The three commits after that (`e363b98`, `a4752a9`, `9acac2e`) touch only notes, the lockfile name and `.gitignore` per their messages, so [I] those results should still hold at HEAD; I did not re-run them.

Standing rule applied: no AI provider credentials exist, so generation being a labeled demo is expected and is not counted as a gap. Anything that would present a demo or placeholder as real is counted as a defect.

---

## 1. Snapshot of what exists (verified)

- 42 API route files under `src/app/api/**`, 17 page routes under `src/app/**` (listed in §2.2). [V]
- Drizzle schema `src/server/db/schema.ts` (589 lines), two migrations `drizzle/0000_init.sql`, `drizzle/0001_output_posters.sql` (journal `drizzle/meta/_journal.json`). [V]
- Generation pipeline: `src/server/generation/service.ts` (draft/confirm/cancel/derive/delete), `processor.ts` (claim/execute/store/settle/reconcile), `queue.ts` (BullMQ), `src/worker/index.ts`. [V]
- Credits: `src/server/credits/ledger.ts` (single `applyMovement` writer, idempotency keys, FOR UPDATE row lock). [V]
- Payments: `src/server/payments/stripe.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/checkout/route.ts`. [V]
- Providers: `src/server/ai/registry.ts` (3 models), `src/server/ai/providers/{types,index,demo,replicate}.ts`. [V]
- Media: `src/server/storage/index.ts` (local + S3 drivers), `src/server/media.ts`, `src/app/api/media/route.ts`. [V]
- Trust: `src/server/safety/policy.ts`, `src/server/auth/{session,account}.ts`, `src/server/characters.ts`, `src/server/admin.ts`. [V]
- Tests: `tests/unit/{copilot,policy,registry,signatures}.test.ts`, `tests/integration/{generation,platform}.test.ts`, `tests/e2e/journey.spec.ts`. [V]
- Not present in the repo: `Dockerfile*`, `docker-compose*`, `.env*`, `README*`, `docs/` (checked with `ls`). [V]

---

## 2. Part VI: Architecture

### 2.1 Stack

| Requirement | Status | Evidence |
|---|---|---|
| Next.js App Router | met | `package.json` next 15.5.27; `src/app/**`; `next.config.ts:12` `output: "standalone"`. [V] |
| React | met | react 19.2.0. [V] |
| Strict TypeScript | met | `tsconfig.json:7-8` `strict: true`, `noUncheckedIndexedAccess: true`. [V] |
| Tailwind | met | tailwindcss 4.3.3, `@tailwindcss/postcss`. [V] |
| Accessible primitives | partial | Own primitives in `src/components/ui.tsx`; `Sheet` is built on native `<dialog>` (comment at `ui.tsx:129`). No Radix/Headless UI. Not audited further (Part IV is out of scope). [V] |
| Lucide | met | lucide-react 1.55.0, used across components. [V] |
| Motion library | partial | `motion` 12.43.0 is in `package.json` but is never imported anywhere in `src/` (grep for `"motion"`/`motion/react` finds only the unrelated "Motion intensity" label in `create-panel.tsx:562`). Animations are CSS (`globals.css` per plan.md). Dead dependency. [V] |
| Server API routes | met | 42 route files; uniform error envelope in `src/server/http.ts:46-73`. [V] |
| PostgreSQL + Drizzle | met | `src/server/db/index.ts:11-19`; `drizzle.config.ts`. [V] |
| Redis queues + background workers | met | BullMQ `src/server/generation/queue.ts:10-16`; worker `src/worker/index.ts:13-19` (`WORKER_CONCURRENCY`), reconcile sweep every 60 s (`:42`), purge hourly (`:43`), optional health port (`:47-53`). [V] |
| S3-compatible storage | partial | `S3Driver` in `src/server/storage/index.ts:70-107` (put/get/delete/presigned GET). Never exercised against a bucket (plan.md "Known defects"). [V]/[I] |
| Secure auth/sessions | met | Own `sessions` table; token hashed with SHA-256 (`session.ts:29-31`); cookie `hl_session` httpOnly, SameSite=Lax, Secure in production (`session.ts:40-48`); bcrypt cost 12 (`:21-23`); constant-time dummy compare on unknown email (`account.ts:104-106`); rate limits on signup (`signup/route.ts:8-9`, 10/h per IP) and login (`login/route.ts:10-12`, 30/15 min per IP, 10/15 min per email). [V] |
| Stripe with server-verified webhooks | met (untested live) | Signature verified before parsing (`webhooks/stripe/route.ts:6-11`, `stripe.ts:52-62`); tests sign locally with a fake secret (`vitest.config.ts`, `platform.test.ts:74-131`). No real Stripe run. [V] |
| Ledger credits | met | §5. [V] |
| Provider-adapter AI (image, video) | met | `ProviderAdapter` interface `providers/types.ts:45-51`; `ADAPTERS` map `providers/index.ts:9-12`; `registerAdapter` test hook `:15-17`. [V] |
| Prompt assistance adapter | partial | Rules-based `src/lib/copilot.ts` runs in the browser; it is not behind the provider abstraction. (Part III detail; noted for completeness.) [V] |
| Optional image quality analysis | partial | Structural checks only (`processor.ts:21-40`: min bytes, decodable, min 64 px, MP4 `ftyp`); low-resolution warning on upload (`media.ts:72`). No perceptual analysis. [V] |
| Capability registry | met | `registry.ts:45-71` `ModelSpec` (modes, aspect ratios, durations, qualities, supports.*, continuity, minInputShortSidePx, notes); `validateAgainstModel` `:136-178`. [V] |
| Containerized services | missing | No Dockerfile or compose file in the repo. Playwright config runs the standalone server "exactly as the Dockerfile runs it" (`playwright.config.ts:44`) but that Dockerfile does not exist. [V] |
| Env config | met | zod schema `src/server/env.ts:4-31`; production guards for `MEDIA_SIGNING_SECRET` (`:40-42`), absolute `STORAGE_LOCAL_DIR` (`:45-47`), `S3_BUCKET` (`:48-50`). No `.env.example`. [V] |
| Deployment scripts | missing | Only `scripts/{migrate,seed,e2e-prepare}.ts` and `wait-for.mjs`. No README. [V] |
| Structured logs | met | JSON lines to stdout/stderr `src/server/log.ts:12-25`. [V] |
| Error monitoring | missing | No Sentry/OTel/any sink; `log.ts:19` comment says "ship stdout to the ... error monitor of choice". [V] |
| Automated tests | met | 4 unit files, 2 integration files, 1 e2e file; `npm run verify` chains typecheck, lint, vitest, build, e2e (`package.json`). [V]; pass counts [I] from notes. |
| Not hardwired to one provider | met | Three models over two adapters; `providerKey` on jobs (`schema.ts:383`). [V] |

### 2.2 Routes

All routes the spec names exist as pages. [V]

| Spec route | File | Notes |
|---|---|---|
| `/` | `src/app/page.tsx` | home + For You / Continue exploring / Trending / Following / New |
| `/explore` | `src/app/explore/page.tsx` | search, category, media, sort (`trending|new|top_rated|most_favorited`) |
| `/templates/[id]` | `src/app/templates/[id]/page.tsx` | accepts id or slug (`templates/queries.ts:5,15`) |
| `/generate/image`, `/generate/video` | `src/app/generate/[kind]/page.tsx` | 404 for other kinds (`:67`) |
| `/collection`, `/collection/[id]` | `src/app/collection/page.tsx`, `[id]/page.tsx` | redirect to `/auth` when signed out; malformed id → 404 (`[id]/page.tsx:20`) |
| `/projects`, `/projects/[id]` | present | |
| `/train` | present | |
| `/studio` | present | |
| `/creators/[id]` | `src/app/creators/[id]/page.tsx` | `[id]` is the handle |
| `/favorites` | present | |
| `/pricing` | present | |
| `/settings` | present | |
| `/auth` | present | `next` param limited to same-origin paths (`auth/page.tsx:10`) |
| `/admin` | `src/app/admin/page.tsx` | non-admin gets 404 (`:32`), same for admin APIs (`http.ts:29-33`) |
| extra: `/policies` | present | reachable through the age gate (`layout.tsx:30`) |

Main nav is not crowded: rail shows Discover, Create, Library, Train, then Projects/Studio/Favorites (`shell.tsx:27-35`); mobile tab bar has 5 items (`shell.tsx:191-197`). [V]

### 2.3 Data model entities (spec list of 28)

All 28 named entities exist as tables in `src/server/db/schema.ts`. [V]

| Entity | Table (schema.ts line) | Notes |
|---|---|---|
| Users | `users` 70-86 | DOB + `age_assurance_method` + `age_assured_at` NOT NULL; unique lower(email) |
| User Profiles | `user_profiles` 88-99 | unique lower(handle); `avatar_asset_id` has no FK and no write path |
| Sessions | `sessions` 101-112 | token hash unique |
| Creator Profiles | `creator_profiles` 114-119 | `share_analytics` is never read |
| Templates | `templates` 189-224 | `remixed_from_id` has no FK (208) |
| Template Versions | `template_versions` 226-240 | unique (template, version) |
| Template Categories | `template_categories` 182-187 | |
| Favorites | `favorites` 253-262 | polymorphic `target_id` (no FK) |
| Followers | `follows` 264-272 | self-follow CHECK |
| Generation Jobs | `generation_jobs` 374-417 | unique (user, idempotency_key) 411; `parent_job_id` has no FK (389) |
| Generation Outputs | `generation_outputs` 419-434 | `poster_asset_id` (migration 0001) |
| Media Assets | `media_assets` 147-165 | `visibility` default private; unique storage_key |
| Uploads | `uploads` 167-178 | links to consent record |
| Collections | `folders`/`folder_items` 450-469 and `template_collections`/`_items` 274-294 | template collections have no create/update API; only `scripts/seed.ts:277-278` writes them and `src/server/creators.ts:18-22` reads them |
| Projects | `projects` 310-322 | |
| Project Scenes | `project_scenes` 332-343 | |
| Scene Versions | `scene_versions` 436-448 | `parent_version_id` has no FK (442) |
| Character References | `character_references` 345-357 | consent record NOT NULL |
| Model Configurations | `model_configs` 486-491 | |
| Saved Presets | `saved_presets` 471-484 | |
| Subscriptions | `subscriptions` 525-538 | unique provider id |
| Credit Accounts | `credit_accounts` 495-504 | CHECK available ≥ 0, reserved ≥ 0 |
| Credit Ledger Entries | `credit_ledger` 506-523 | unique idempotency_key; `payment_event_id` has no FK (517) |
| Payment Events | `payment_events` 540-555 | unique (provider, provider_event_id) |
| Moderation Events | `moderation_events` 559-575 | polymorphic text `subject_id` |
| Consent Records | `consent_records` 131-143 | kinds: terms, adult_attestation, upload_subject, likeness, training_data (training_data never written) |
| User Preferences | `user_preferences` 121-129 | |
| Discovery History | `discovery_events` 296-306 | |
| Audit Logs | `audit_logs` 577-589 | |

| Requirement | Status | Evidence |
|---|---|---|
| Referential integrity / FKs | partial | 51 FK/REFERENCES statements in `drizzle/0000_init.sql` [V]. Missing FKs on `generation_jobs.parent_job_id`, `templates.remixed_from_id`, `credit_ledger.payment_event_id`, `scene_versions.parent_version_id`, `user_profiles.avatar_asset_id` (all nullable uuid columns with no `.references()`). Polymorphic `favorites.target_id` and `moderation_events.subject_id` cannot have FKs by design. [V] |
| Indexes | met | Per-table indexes on owner/time/status (e.g. `jobs_user_created_idx`, `jobs_status_idx` 412-413; `ledger_user_idx` 522; `outputs_user_idx` 433). [V] |
| Ownership checks | met | Every owner-scoped query filters by `userId` and returns 404 for foreign ids (`http.ts:20-21` "Not found and not-yours look identical"); tested in `generation.test.ts:221-230`, `platform.test.ts:166-174, 198-203, 349-352`, e2e `journey.spec.ts:92-96`. [V] |
| Retention | met | Soft-deleted media purged after 30 days by the worker (`worker/index.ts:34`, `media.ts:93-101`); consent withdrawal purges immediately (`account.ts:149`). Stated on `/policies` (`policies/page.tsx:57-58`). [V] |
| Soft deletion where justified | met | `deleted_at` on users, media_assets, templates, projects, character_references, generation_jobs, generation_outputs. [V] |
| Transactional credits | met | §5. [V] |
| Version metadata | met | `template_versions` with changelog; prompt edits create a new version (`publish.ts:158-175`); jobs record `template_version` (`service.ts:251`). [V] |
| No secrets in public fields | met | `SessionUser` excludes the hash (`session.ts:50-68`); `/api/me` returns profile/prefs/consents only (`me.ts:29-60`); `profileByHandle` exposes handle/displayName/bio/role only (`social.ts:32-39`). [V] |

---

## 3. Part VII: Generation infrastructure

| Requirement | Status | Evidence |
|---|---|---|
| Modes via capability-aware abstraction | met | `generation_mode` enum of 8 (`schema.ts:29-38`); `MODE_INPUTS` (`registry.ts:34-43`); per-model `modes` (`registry.ts:85, 99, 116`). `video_to_video` has no model ("where available"). [V] |
| Pipeline: Input → Validation | met | zod `draftSchema` (`service.ts:59-73`) → 422 `invalid_input`; capability check → 422 `unsupported_settings` (`:166-167`). [V] |
| → Consent and Safety | met | `checkPrompt` → 422 `policy_blocked` + moderation event (`:169-182`); inputs must be own consented uploads or own outputs → 404 / 403 `consent_required` (`:104-133`); character reference consent → 403 `consent_withdrawn` (`:186-198`). [V] |
| → Model Selection | met | `listModelAvailability` (`providers/index.ts:26-44`): adapter present, `isConfigured()`, admin enable → 422 `unknown_model` / 503 `model_unavailable` (`service.ts:161-164`). [V] |
| → Credit Reservation | met | `confirmJob` reserves inside the same transaction that flips the job to `queued` (`service.ts:278-320`). [V] |
| → Queue | met | BullMQ job id `${jobId}-a${attempt}` (`queue.ts:22-24`), enqueued after commit (`service.ts:321`). [V] |
| → Provider Execution | met | `processJob` claims with FOR UPDATE only if `queued` (`processor.ts:71-86`), runs `adapter.execute` with AbortSignal (`:97-122`). [V] |
| → Status Updates | met | DB-backed transitions; UI polls `/api/generations?active=1` (`job-tray.tsx:38-62`). [V] |
| → Output Storage | met | `storage().put` + `media_assets` insert, private (`processor.ts:155-171`); video poster (`:172-184`). [V] |
| → Quality Checks | met (structural) | `qualityCheck` (`processor.ts:21-40`); failing output fails the job with refund (`:149-153`); report stored in `generation_outputs.quality_report` (`:213`). [V] |
| → Credit Settlement | met | `settleJob` in the same transaction as the `completed` write (`processor.ts:216-220`). [V] |
| → Collection | met | `/collection` lists via `listCreations` (`views.ts:40-62`). [V] |
| States: Draft, Awaiting Confirmation, Queued, Processing, Completed, Failed, Cancelled | met | Enum `schema.ts:39-47`. `draft` is defined but never written (drafts are inserted as `awaiting_confirmation`, `service.ts:245`); harmless. [V] |
| DB-backed transitions | met | All transitions are UPDATEs guarded by current status under FOR UPDATE (`service.ts:285, 334-352`; `processor.ts:73, 45, 192`). [V] |
| No false progress percentages | met | Job tray shows status label + elapsed seconds and an indeterminate bar (`job-tray.tsx:26-29, 91-93, 107-110`); Library skeleton shows status + elapsed (`library.tsx:69-78`); Studio monitor (`studio.tsx:55-57, 86-88`). No percentage anywhere. [V] |
| Track provider ids, retries, timestamps, failure reasons, output locations | met | `provider_job_id`, `attempts`/`max_attempts`, `queued_at`/`started_at`/`finished_at`, `failure_code`/`failure_message` (`schema.ts:397-405`); `media_assets.storage_key`. `onProviderJobId` persists the id as soon as it exists (`processor.ts:118-120`). [V] |
| Idempotent job creation | met | Unique (user, idempotency_key) + `onConflictDoNothing` + winner re-select (`service.ts:147-151, 240-272`); test `generation.test.ts:90-97`. [V] |
| Safe retries | met | Retryable `ProviderError` → back to `queued` with reservation held, exponential delay `5000 * 2^(attempt-1)`, bounded by `max_attempts` 3 (`processor.ts:130-139`); tests `:141-153, 167-178`. [V] |
| Concurrency limits | met | Per-user active jobs: `max(USER_MAX_ACTIVE_JOBS, plan.maxActiveJobs)` → 429 `too_many_active` (`service.ts:277, 289-295`); worker `WORKER_CONCURRENCY` (`worker/index.ts:11`). Test `generation.test.ts:210-218`. [V] |
| Timeouts | met | `PROVIDER_TIMEOUT_S` (default 600) via AbortController (`processor.ts:69, 97-98`). [V] |
| Failure recovery | met | `reconcile`: stale `queued` re-enqueued, stale `processing` failed + refunded (`processor.ts:242-257`), every 60 s (`worker/index.ts:42`). Test `generation.test.ts:180-191`. [V] |
| Provider error normalization | met | `ProviderError` codes (`types.ts:18-37`), user messages (`:53-62`), Replicate HTTP mapping (`replicate.ts:31-38`). [V] |
| Webhook signature verification | met | Stripe `constructEvent` (`stripe.ts:52-62`); Replicate Standard-Webhooks HMAC with ±300 s window (`replicate.ts:126-144`, unit test `signatures.test.ts:21-39`). [V] |
| Secure uploads | met | Consent required (`uploads/route.ts:15`), size caps 20 MB / 100 MB (`media.ts:26-27`), image decoded and re-encoded to WebP which strips EXIF (`:57-66`), MP4 sniffed by `ftyp` (`:51`), rate limit 40/h (`uploads/route.ts:11`). Videos are not re-encoded, so container metadata survives. [V] |
| Signed media URLs | met | Local: HMAC over `key\nexp\ndownload`, timing-safe compare, window-rounded expiry (`storage/index.ts:26-35, 57-65`); served only on valid signature (`api/media/route.ts:17-19` → 403), deleted → 404 (`:21`); S3: presigned GET (`storage/index.ts:96-106`). Private TTL `MEDIA_URL_TTL_S`=300 s, public 3600 s (`media.ts:16`). Tests `signatures.test.ts:6-19`, `platform.test.ts:295-323`, e2e `journey.spec.ts:98-100`. [V] |
| Reservation/settlement, no duplicate charging | met | `settle` and `release` share key `job:${jobId}:close` (`ledger.ts:82-107`), so a job is closed exactly once; test `generation.test.ts:63-88` (ledger kinds `["reserve","settle"]` after duplicate deliveries). [V] |
| Accurate cancellation | met | awaiting → cancelled; queued → release + cancelled; processing → `cancel_requested` flag polled every 2 s, provider aborted, release on exit (`service.ts:325-354`; `processor.ts:74-77, 99-102, 126-128, 197-205`). Tests `generation.test.ts:114-139`. [V] |
| Provider availability checks | met | `isConfigured()` per adapter (`demo.ts:109` = `ENABLE_DEMO_PROVIDER`, `replicate.ts:75` = `REPLICATE_API_TOKEN`); unconfigured at run time → fail + refund (`processor.ts:90-95`). [V] |
| Never represent a placeholder as a completed AI generation | met, with two labeling holes (D2, D9 below) | `is_demo` on jobs and outputs (`schema.ts:384, 428`); watermark `DEMO OUTPUT · NOT AI-GENERATED` burned into every demo still/clip (`demo.ts:16, 60`); model names "Demo Still (not AI)" / "Demo Motion (not AI)" (`registry.ts:82, 96`); Create panel badge + confirm-sheet note (`create-panel.tsx:671-675, 716-721`); Library badge (`library.tsx:89`); detail banner (`creation-detail.tsx:187-192, 198`); toast wording (`create-panel.tsx:231`); download filename gets `-demo` (`download/route.ts:21`); `/policies` demo section (`policies/page.tsx:75-84`); admin counts demo jobs separately (`admin.ts:65`). [V] |
| Providers declare capabilities, durations, pricing, quality, params explicitly | met | `registry.ts:78-123`; price via `estimateCost` + per-model multiplier (`:183-192`, `model_configs.price_multiplier_pct`). [V] |
| If credentials missing: interface, DB, adapters, labeled demos; never falsely report external generation as operational | met | Replicate adapter self-describes as unexercised (`replicate.ts:5-9`); availability reason "Needs credentials" (`providers/index.ts:40`) shown in the model picker (`create-panel.tsx:508-511`) and admin table (`admin.ts:145-158`); test asserts 503 for the Replicate model (`generation.test.ts:207`). Replicate webhook verifies and logs only, documented in its header (`webhooks/replicate/route.ts:10-14`). [V] |

---

## 4. Part VIII: Adult trust, consent, privacy

| Requirement | Status | Evidence |
|---|---|---|
| Enforceable adult-only eligibility | met | Signup requires DOB + two literal-true attestations (`account.ts:31-44`); server computes age and refuses < 18 with 403 `underage` before any insert (`:47-52`, `policy.ts:75-83`); tests `platform.test.ts:255-263`, e2e `journey.spec.ts:107-114`. Anonymous browsing behind `hl_age_ok` cookie (httpOnly, `age-gate/route.ts:8`; `layout.tsx:28-31`). [V] |
| Age assurance for supported jurisdictions | partial (disclosed) | `AGE_ASSURANCE_STRICT_REGIONS` + `GEO_COUNTRY_HEADER` → 451 `age_assurance_required` at draft creation for self-declared accounts (`service.ts:153-159`, `policy.ts:90-97`). No verification provider exists; stated on `/policies` (`policies/page.tsx:12-15`) and in the 451 message. Header is trusted as sent (`request.ts:5-7`); a missing header disables the check (`policy.ts:91`). [V] |
| Authorization for images, videos, likenesses, character references | met | Upload consent record per upload (`media.ts:78-81`, statement `uploads/route.ts:6-7`); likeness consent per character with two checkboxes (`characters/route.ts:19-21`, `characters.ts:8-9`); generation refuses assets without active consent (`service.ts:126-129`) or withdrawn likeness (`:194`); creations from personal media can never be published (`publish.ts:49-55`, 403 `personal_media`; test `platform.test.ts:191-196`). [V] |
| Prohibit minors / non-consent / unauthorized real people / exploitative / consent-bypass | met (baseline) | Regex rule set with leetspeak/spacing normalization (`policy.ts:23-73`), categories minors, non_consent, real_person, bestiality, incest, extreme_harm; runs on draft (`service.ts:169`), publish (`publish.ts:56`), template update (`:150`); blocked attempts logged as `moderation_events` (`service.ts:171-180`). Unit tests `tests/unit/policy.test.ts`; integration `generation.test.ts:193-200`. The policy header itself says a trained classifier should be added for production (`policy.ts:1-6`). Coverage hole D4: free-text params are not checked. [V] |
| Private-by-default generations | met | Every generated and uploaded asset is `visibility: "private"` (`processor.ts:169, 180`; `media.ts:84`); `assetUrl` returns null unless public or owner (`media.ts:13-18`). Test `platform.test.ts:178-189`. [V] |
| Clear sharing controls | met | Publishing is the only sharing path and copies the output to a new public asset, original stays private (`publish.ts:36-40, 69-77, 84-96`); the publish sheet states this (`creation-detail.tsx:473`) and requires an explicit checkbox (`:495-498`). Unpublish via PATCH status (`publish.ts:139, 184`). [V] |
| Explicit consent records | met | `consent_records` with statement text, subject label, granted/withdrawn timestamps; visible in Settings (`settings.tsx:165-198`). [V] |
| Secure storage | met (local) / partial (S3) | Local key validation prevents traversal (`storage/index.ts:37-42`); S3 unexercised. [V] |
| Easy account/content deletion | met | Account: password re-entry, sessions destroyed, email pseudonymized, media/outputs/jobs soft-deleted, templates removed, discovery history hard-deleted, consents withdrawn (`account.ts:153-172`; `me/route.ts:20-27`; test `platform.test.ts:265-281`). Creation: single and bulk delete (`service.ts:415-432`; `library.tsx:147-163`). [V] |
| Transparent retention | met | `/policies` privacy section (`policies/page.tsx:49-62`); delete dialogs say "erased from storage after 30 days" (`creation-detail.tsx:347`, `library.tsx:275`). [V] |
| Strict access control | met | Owner filters everywhere; admin 404 for non-admins; cross-user tests (see §2.3). [V] |
| Short-lived signed URLs | met | 300 s private (`env.ts:11`). Note D3: the policy text claims links are "tied to your session", which they are not. [V] |
| No public indexing of private content | met | `X-Robots-Tag: noindex, nofollow` on every path (`next.config.ts:9`), `robots` metadata (`layout.tsx:12`), `X-Robots-Tag: noindex` on media (`api/media/route.ts:28`). [V] |
| Clear training-data policies | partial | Train page says this build does not fine-tune and nothing is learned from the photo (`train.tsx:65-68`; `characters.ts:11-15`). `/policies` has no training-data section; `training_data` consent kind exists but is never written. [V] |
| Consent withdrawal and removal workflows | met | `withdrawConsent` soft-deletes uploads/references and every job that used them, then purges files immediately (`account.ts:111-150`); removing a character is a withdrawal (`characters.ts:56-63`); Settings and Train UIs explain the cascade (`settings.tsx:225-227`, `train.tsx:156-158`). Tests `platform.test.ts:134-164`. [V] |
| Server-side enforcement, not just UI | met | All of the above are in route handlers/services; e2e shows the under-18 refusal and blocked prompt come from the server (`journey.spec.ts:107-127`); CSRF origin check in `middleware.ts:10-16` (e2e `:103`). [V] |
| Users control personalization and can clear history (Part III.1, cited by VIII privacy) | met | Preferences toggles; turning history off deletes it (`me.ts:72-80`); clear-now endpoint (`me/history/route.ts`); For You falls back to trending (`discovery/templates.ts:212-214`; test `platform.test.ts:241-252`). [V] |

---

## 5. Part IX: Monetization

| Requirement | Status | Evidence |
|---|---|---|
| Credit balance | met | `credit_accounts.available/reserved`; shown in rail/header (`layout.tsx:26`), Create panel (`create-panel.tsx:656-670`), `/pricing` (`pricing/page.tsx:58-75`). [V] |
| Packages | met (placeholder prices) | `pricing.packs` (`config/pricing.ts:10-14`), Stripe one-time checkout (`stripe.ts:22-49`), grant on `checkout.session.completed` with `payment_status === "paid"` (`:100-109`). [V] |
| Subscriptions | partial | Stripe subscription checkout (`stripe.ts:28, 32, 40`); `subscriptions` row on completion (`:110-115`); monthly grant on `invoice.paid` keyed `stripe-invoice:${inv.id}` (`:121-139`); status sync on `customer.subscription.updated/deleted` (`:141-150`). No customer portal / cancel / plan change from the app; `current_period_end` stays null until an update event arrives, so the plan is treated as active indefinitely until Stripe says otherwise (`service.ts:82-95`). [V] |
| VIP entitlements | met | `hasVip` from active plan (`service.ts:97-99`); VIP template gated server-side → 403 `vip_required` (`:207-209`); UI lock banner (`create-panel.tsx:249-256`); VIP badges on cards/detail (`template-card.tsx:90`, `templates/[id]/page.tsx:50`). [V] |
| Cost estimates | met | `estimateCost` (`registry.ts:183-192`) used client-side for the live cost line and server-side for the job (`service.ts:238`); draft returns `cost_credits`. [V] |
| Quality/duration pricing | met | `imageBase`, `videoPerSecond`, `qualityMultiplier` (`config/pricing.ts:6-8`); unit test `registry.test.ts:9-18`. [V] |
| Concurrency limits | met | Plan `maxActiveJobs` vs `USER_MAX_ACTIVE_JOBS` (`service.ts:277`). [V] |
| Purchase history | partial | `/pricing` shows the last 40 ledger rows with kind labels and notes (`pricing/page.tsx:110-146`). `payment_events` (amount, currency, Stripe id) are not shown to the user. [V] |
| Ledger | met | Append-only `credit_ledger` with before/after balances per row (`ledger.ts:56-67`); every write goes through `applyMovement` under a row lock (`:29-34, 41-69`); CHECK constraints on the account (`schema.ts:503`). [V] |
| Failed-generation reimbursement rules | met | Release on failure, cancel, timeout, quality-check failure, reconcile (`processor.ts:42-59`); every user-facing failure message says credits were returned (`types.ts:53-62`); `/policies` credits section (`policies/page.tsx:63-74`). Tests across `generation.test.ts`. [V] |
| Server-side payment verification | met | Webhook signature verified; grant only on `paid`; unpaid ignored (test `platform.test.ts:106-111`); forged signature → 400 with no change (`:99-104`). [V] |
| Never trust client balances | met | Client sends only `expectedCost`; server compares with stored cost → 409 `cost_changed` (`service.ts:286-288`; test `generation.test.ts:108-113`) and reserves from the DB balance → 402 `insufficient_credits` (`http.ts:60-65`; test `:99-106`). [V] |
| Transactional ledger | met | Reserve/settle/release are inside the job's own transaction (`service.ts:296`, `processor.ts:47, 199, 216`). [V] |
| Visible cost before execution | met | Cost line + confirmation sheet with cost, balance after and model (`create-panel.tsx:699-733`); derived jobs (retry/variation/continue) confirm the same way (`creation-detail.tsx:326-343`); e2e asserts the cost (`journey.spec.ts:56-58`). [V] |
| Exactly-once webhooks | met | `payment_events` unique (provider, event id) with `onConflictDoNothing` → "duplicate" (`stripe.ts:81-86`); event row and effects commit together; failures roll back so Stripe retries (`:75-78, 130-133`); test `platform.test.ts:88-97, 113-130`. [V] |
| Configurable prices and limits, not invented Playbox policy | met | `config/pricing.ts:1-4` states the numbers are placeholders; `/pricing` says so when payments are unconfigured (`pricing/page.tsx:52-56`); per-model multiplier editable by admin (`admin.ts:160-170`). Pack/plan prices are code constants, not env/admin. [V] |
| Payments unconfigured behaviour | met | `/api/checkout` → 503 `payments_unavailable` (`checkout/route.ts:9`); Buy buttons disabled with a title (`pricing.tsx:19-20`). [V] |
| Refunds / disputes | missing | Only four Stripe event types handled (`stripe.ts:89-153`); `charge.refunded` and `charge.dispute.*` fall to `default: ignored`, so purchased credits are never clawed back. [V] |

---

## 6. Defects (things that are wrong or would misrepresent), ranked by user impact

**D1. `reference_guided` jobs never send the character reference to the provider; the Train page says they do.** (medium)
`processor.ts:106-111` builds provider inputs from `job.inputAssetIds` only; `job.characterReferenceId` is validated in `service.ts:186-198` and then never read again (grep for `characterReference` in `processor.ts` and `providers/*.ts` returns nothing; `ProviderInput` has no reference role, `types.ts:4`). `train.tsx:65-67` tells the user "The photo is sent to a model that accepts a reference image at generation time". The seeded template "Vampire Queen" uses this mode (`seed.ts:106`). A user picks a character, confirms and pays (demo: 4 credits) for a mode that ignores the character. With the demo provider the result is a placeholder anyway, but the statement is false and a real adapter wired later would inherit the same omission.
Fix (small): add `role?: "source" | "reference"` to `ProviderInput`; in `processJob`, when `job.characterReferenceId` is set, load `character_references` joined to `media_assets` (and check `consent_records.withdrawn_at is null`), append `{ role: "reference", ... }` to `inputs`; make the demo `renderStill` composite a reference the way it does image-to-image (`demo.ts:69-76`); change the Train copy to describe exactly that. Add an integration test asserting the fake adapter receives the reference bytes.

**D2. Seed fabricates template usage counts.** (low–medium, presentation)
`scripts/seed.ts:274` sets `generation_count = abs(hashtext(slug)) % 400` with no backing jobs or events. The number is displayed as "Made N times" (`templates/[id]/page.tsx:77`), as creator "Uses" totals (`creators/[id]/page.tsx:40`, `creators.ts:39`) and feeds the trending score (`discovery/templates.ts:42-45`). Spec Part XV: "no fabricated results". Favorites and ratings in the seed are real rows cast by seeded accounts, so those are not affected.
Fix (small): delete that assignment (counts start at 0 and grow through `processor.ts:221-226`), or seed `discovery_events` rows and derive the count from them.

**D3. `/policies` overstates how private media links work.** (low)
`policies/page.tsx:54`: "signed links tied to your session". `api/media/route.ts:17-19` checks only HMAC + expiry; anyone holding the URL can fetch it for up to 300 s (public assets 3600 s). Fix (small): change the sentence to "short-lived signed links (5 minutes)", or include the session id in the signed string in `storage/index.ts:26-28` and verify it in the route.

**D4. Free-text generation params bypass the content policy and can be published.** (low)
`paramsSchema` accepts arbitrary strings for `cameraMovement`, `pacing`, `atmosphere`, `lighting`, `framing` (`service.ts:50-54`); `checkPrompt` covers only prompt, negative prompt and atmosphere (`service.ts:169`). Publishing copies all params except seed into public `template_versions.defaults` (`publish.ts:123-124`) and the publish-time policy check covers title/description/tags/prompt only (`:56`). Today no adapter forwards these fields (demo uses only `prompt`, `demo.ts:68`; Replicate builder `replicate.ts:22-28`), so the practical impact is a policy-violating string in a public template's defaults and in the creation detail view. Fix (small): validate `cameraMovement`/`pacing`/`lighting`/`framing` against `CAMERA_MOVEMENTS`/`PACINGS`/`LIGHTINGS`/`FRAMINGS` (`registry.ts:73-76`) with `z.enum`, and pass every string param to `checkPrompt` in both places.

**D5. Failures after a successful provider call are not normalized.** (low)
`processor.ts:146-186` (quality check, `storage().put`, `media_assets` insert, poster) runs outside the try/catch that wraps `adapter.execute` (`:105-142`). An exception there propagates to BullMQ (`worker/index.ts:21` logs it) and the job stays `processing` until `reconcile` fails it after `PROVIDER_TIMEOUT_S*1000 + 120000` ms (~12 min by default, `:245`) with code `timeout` and the message "The model took too long to respond" (`types.ts:54`), which misdescribes a storage/DB fault. Credits are refunded, just late and with the wrong reason. Fix (small): wrap `:146-186` in try/catch → `finishFailed(job.id, new ProviderError("internal", ...))` and `purgeAssetsNow` for anything already stored.

**D6. Confirm can return 500 for a job that is actually queued.** (low)
`service.ts:321` enqueues after the transaction commits; if Redis is down the route throws, the client shows "Could not start" (`create-panel.tsx:234-235`) and clears the draft, while the job is `queued` with credits held; `reconcile` re-enqueues it within ~2 min. Fix (small): catch the enqueue error, log it, and still return the queued job (the reconciler is the backstop).

**D7. Soft-deleted drafts can still be confirmed.** (low)
`confirmJob` and `cancelJob` select by id + user only (`service.ts:279-284, 327-331`) without `isNull(deletedAt)`; `deleteJob` allows deleting an `awaiting_confirmation` job (`:417-419`). A client that still holds the draft id can confirm a deleted draft, reserve and settle credits for a creation the Library will never show. Fix (small): add `isNull(generationJobs.deletedAt)` to both selects.

**D8. Templates made from demo outputs carry no demo flag.** (low)
`templates` has no `is_demo`; `publishTemplate` does not record the source job's `is_demo` (`publish.ts:97-116`); cards show VIP/New/4K only (`template-card.tsx:89-93`). Mitigations: the cover is the watermarked demo image, and the template's `model_key` is the demo model so the Create panel shows "Demo model" (`create-panel.tsx:671-675`). Fix (small): in `toCards` (`discovery/templates.ts:78-117`) derive `isDemo` from the current version's `model_key` (or add a column) and render a Demo badge next to VIP.

**D9. Seeded covers are not labeled as illustrations.** (low)
`seed.ts:3, 122-147` generates abstract "loom" artwork as template covers; nothing on the card or template page says the cover is not an output of the recipe. They do not resemble photographs, so the risk is low. Fix (small): add one line on the template page when `creatorId` is a seeded creator, or put "Cover: illustration" in the seeded descriptions.

**D10. Stripe refunds and disputes are ignored.** (low now, medium once payments are live)
`stripe.ts:151-153`. A refunded pack leaves the credits in the account. Fix (medium): handle `charge.refunded` (map `payment_intent` → `payment_events` via a stored `payment_intent` id on the row, apply a negative `purchase` movement keyed `stripe-refund:${refund.id}`, and decide the policy when `available < refunded`; `applyMovement` currently throws on negative balance, `ledger.ts:52`).

**D11. Deleted accounts keep their date of birth.** (low)
`account.ts:157-162` pseudonymizes email and password but `date_of_birth` and `age_assured_at` remain (both NOT NULL, `schema.ts:78-80`). Fix (small): migration to make `date_of_birth` nullable and null it on deletion, or overwrite with `1900-01-01` and document.

**D12. Country header is trusted as sent.** (low, deployment-dependent)
`request.ts:5-7` reads `GEO_COUNTRY_HEADER` (default `x-country-code`) straight from the request; `policy.ts:91` returns "not blocked" when the header is absent. If the edge does not set and overwrite this header, a client in a strict region bypasses the 451 by omitting it. Fix (small): document that the proxy must set/strip it; optionally add `AGE_ASSURANCE_FAIL_CLOSED=true` to block when the header is missing and strict regions are configured.

**D13. `/api/media` buffers whole files in memory.** (low, performance)
`api/media/route.ts:23` `storage().get(key)` reads the full object even for a 206 Range response (`:32-43`); an upload can be 100 MB (`media.ts:27`). Fix (medium): add `getStream(key, range)` to `StorageDriver`, use `fs.createReadStream` with `start/end` locally and `Range` on S3 `GetObject`.

**D14. No Content-Security-Policy; origin check only when `Origin` is present.** (low)
`next.config.ts:3-9` sets nosniff/referrer/frame/permissions/robots headers but no CSP. `middleware.ts:14` skips the check when the `Origin` header is absent (non-browser clients); SameSite=Lax cookies remain the main CSRF defense. Fix (small): add a CSP (self + data: for the object-URL previews) and also reject when `Sec-Fetch-Site` is `cross-site`.

**D15. Dead `motion` dependency.** (low)
`package.json` lists `motion` 12.43.0; nothing imports it. Remove it or use it; either way the spec's "motion library" is currently satisfied by CSS only.

**D16. Unused enum values / columns (informational).**
`job_status.draft` (`schema.ts:40`) never written; `consent_kind.training_data` (`:62`) never written; `upload_purpose.avatar|template_media` (`:66`) never written; `user_profiles.avatar_asset_id` (`:95`) has no write path; `creator_profiles.share_analytics` (`:117`) never read. Not bugs; worth either wiring or trimming before the schema is documented.

---

## 7. Gaps against the spec (Parts VI–IX), ranked by user impact

| # | Requirement (spec) | Status | Evidence | Effort | Proposal |
|---|---|---|---|---|---|
| G1 | VI containerized services, deployment scripts; XIV-F env template | missing | No `Dockerfile`, `docker-compose*`, `.env.example`, `README` (ls). `playwright.config.ts:44` references a Dockerfile that does not exist. plan.md item 3. | medium | Two Dockerfiles (web: `node .next/standalone/server.js` with `.next/static` copied as the e2e command does; worker: `tsx src/worker/index.ts` on an image with `ffmpeg`), `docker-compose.yml` with postgres:16, redis:7, optional minio, a `migrate` one-shot; `.env.example` generated from the names in `env.ts:4-31` (no values); README with the commands already in plan.md. |
| G2 | VII reliability: character reference actually used (D1) | partial | `processor.ts:106-111` | small | See D1. |
| G3 | IX refunds/clawback (D10) | missing | `stripe.ts:151-153` | medium | See D10. |
| G4 | VIII age assurance for strict jurisdictions | partial (disclosed) | 451 only, `service.ts:153-159` | large | Define `AgeAssuranceProvider { start(userId) → url; verify(webhook) → method }`, store `age_assurance_method = "verified:<provider>"`, add a Settings call-to-action when the 451 is hit. Needs a vendor; out of reach without credentials. |
| G5 | IX subscriptions lifecycle (cancel, portal, period end) | partial | `stripe.ts:110-115, 141-150`; no portal route | small | `POST /api/billing/portal` → `stripe.billingPortal.sessions.create({ customer, return_url })`; store `stripe_customer_id` on `subscriptions` from the checkout session; set `current_period_end` from the subscription at checkout time (one `subscriptions.retrieve`). |
| G6 | IX purchase history | partial | Ledger only, `pricing/page.tsx:110-146` | small | Add a "Payments" table on `/pricing` from `payment_events where user_id = me` (type, amount_cents, currency, credits, created_at, provider_event_id). |
| G7 | VI referential integrity | partial | 5 FK-less uuid columns (§2.3) | small | Migration adding FKs with `ON DELETE SET NULL` for `parent_job_id`, `remixed_from_id`, `payment_event_id`, `parent_version_id`, `avatar_asset_id`. |
| G8 | VI error monitoring | missing | `log.ts` only | small | `instrumentation.ts` + optional `SENTRY_DSN` (or an OTel exporter); route `logger.error` through it; keep JSON stdout as the default. |
| G9 | VIII clear training-data policy | partial | `train.tsx:65-68`; no `/policies` section; `training_data` consent unused | small | Add a "Training" section to `policies/page.tsx` stating that uploads, references and outputs are not used to train any model in this build and that a separate consent (`training_data`) would be required if that ever changed. |
| G10 | VII secure uploads (video metadata) | partial | `media.ts:49-54` keeps MP4 metadata; images are stripped `:66` | small | On video upload run `ffmpeg -i in.mp4 -map_metadata -1 -c copy out.mp4` (ffmpeg is already a dependency of the demo path). |
| G11 | VI S3 storage exercised | partial | `storage/index.ts:70-107` unexercised (plan.md) | small | MinIO service in compose + one integration test that sets `STORAGE_DRIVER=s3` and round-trips put/get/signedUrl/delete. |
| G12 | VI data model: Collections write path | partial | `template_collections` seed-only (`seed.ts:277-278`, `creators.ts:18-22`) | small | `POST/PATCH/DELETE /api/collections` and `/api/collections/[id]/items` for the owner; "Add to collection" on the creator manage table. (Feature belongs to Part III.6; listed here because the entity exists without a write path.) |
| G13 | IX configurable prices | partial | Code constants `config/pricing.ts`; admin can edit only model multipliers `admin.ts:160-170` | small | Either document "edit `src/config/pricing.ts` and redeploy" as the operator path, or move packs/plans into a `pricing_items` table with an admin editor. |
| G14 | VII webhook-driven provider status (Replicate) | demo-only (disclosed) | `webhooks/replicate/route.ts:10-14` verifies and logs | small | Fine as-is while the worker polls. When a token exists: on `succeeded|failed|canceled` look up the job by `provider_job_id` and, if still `processing`, let the worker's poll loop finish it (no state change from the webhook, to keep single-writer semantics). |
| G15 | VII cancellation nuance | met | n/a | – | None. |
| G16 | VI/VIII policy text accuracy (D3) | partial | `policies/page.tsx:54` | small | See D3. |

Items from plan.md "Remaining work" that fall inside this scope and are confirmed still open: Dockerfiles/compose/.env.example/README (G1); poster backfill for pre-0001 clips (dev data only, not a spec gap).

---

## 8. What I did not verify

- I did not run typecheck, lint, vitest, build or Playwright (forbidden for this task). Pass counts are quoted from `notes/state.json` at `0987b7c`.
- I did not exercise Stripe, Replicate or S3; the code paths are read-verified only.
- `src/components/ui.tsx` (dialog focus handling), `src/lib/copilot.ts` and `globals.css` were not reviewed in depth; they belong to Parts III/IV.
- Line numbers refer to the files as read at HEAD `9acac2e`.
