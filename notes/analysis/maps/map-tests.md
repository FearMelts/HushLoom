# Hushloom test inventory and spec Part XI coverage map

Read-only survey of `/home/claude/hushloom` at commit `a4752a9` (branch `claude/playbox-2-foundation-q7fpbs`). Everything under "Verified" was read from the files cited. Everything under "Inferred" is a judgement that was not executed or traced further. Nothing was run; nothing was modified.

## 1. Harness and configuration

### 1.1 `vitest.config.ts` (23 lines) — verified
- `include`: `tests/unit/**/*.test.ts`, `tests/integration/**/*.test.ts` (line 7).
- `globalSetup`: `tests/global-setup.ts` (line 8).
- Env injected for every test (lines 9–18): `NODE_ENV=test`, `DATABASE_URL` = `TEST_DATABASE_URL` or `postgres://playbox@localhost:5432/playbox_test`, `REDIS_URL` = `TEST_REDIS_URL` or `redis://localhost:6379/1`, `STORAGE_LOCAL_DIR=.storage-test` (relative), `ENABLE_DEMO_PROVIDER=true`, `STRIPE_SECRET_KEY=sk_test_local_placeholder`, `STRIPE_WEBHOOK_SECRET=whsec_local_test_secret` (fake; webhook tests sign locally).
- `fileParallelism: false` (line 19), `testTimeout` and `hookTimeout` 30 s (lines 20–21). Alias `@` → `src` (line 5).
- Consequence: unit and integration files run sequentially in one process; every integration file truncates all tables in `beforeEach`.

### 1.2 `tests/global-setup.ts` (6 lines) — verified
- Runs `npx tsx scripts/migrate.ts` once with `DATABASE_URL` forced to the test DB (line 5). It does **not** create the `playbox_test` database; the database must already exist (plan.md line 35 says it was created by hand).

### 1.3 `tests/helpers.ts` (40 lines) — verified
- `resetDb()` (lines 10–17): `truncate` every table in `public` except `__drizzle_migrations`, `restart identity cascade`, then `redis().flushdb()`.
- `makeUser({credits, role, handle})` (lines 19–37): inserts into `users` (`passwordHash: "x"`, `dateOfBirth: "1990-01-01"`, `ageAssuranceMethod: "self_declaration"`) and `user_profiles`; optional credit grant through `applyMovement(... kind: "admin_adjust", idempotencyKey: test-grant:<id>)`. Returns a `SessionUser` shape without going through login.
- `key()` returns a random idempotency key.

### 1.4 `playwright.config.ts` (49 lines) — verified
- `testDir: tests/e2e`, `workers: 1`, `fullyParallel: false`, per-test `timeout` 90 s, expect timeout 15 s, chromium only (`Desktop Chrome`), trace/screenshot on failure (lines 23–30).
- Env (lines 9–19): `NODE_ENV=production`, `APP_URL=http://localhost:3100` (`E2E_PORT` overrides), `DATABASE_URL` = `E2E_DATABASE_URL` or `postgres://playbox@localhost:5432/playbox_e2e`, `REDIS_URL` = `E2E_REDIS_URL` or `redis://localhost:6379/2`, `STORAGE_LOCAL_DIR` = absolute `.storage-e2e`, `MEDIA_SIGNING_SECRET` = `E2E_MEDIA_SIGNING_SECRET` or 32 random bytes hex, `SEED_PASSWORD=e2e-password-123`, `ENABLE_DEMO_PROVIDER=true`, `WORKER_HEALTH_PORT=3901`.
- Two `webServer` entries (lines 31–47):
  1. `npx tsx scripts/e2e-prepare.ts && npx next build && cp -r .next/static .next/standalone/.next/static && PORT=3100 node .next/standalone/server.js`, readiness `GET /api/health`, 600 s timeout.
  2. `node scripts/wait-for.mjs http://localhost:3100/api/health && npx tsx src/worker/index.ts`, readiness `http://localhost:3901/health`, 660 s timeout.
- So the e2e suite runs against the production standalone build with a real BullMQ worker, Postgres and Redis.

### 1.5 `scripts/e2e-prepare.ts` (30 lines) — verified
- Refuses any `DATABASE_URL` whose db name does not end in `_e2e` (line 12).
- Creates the database if missing (lines 14–17), then `drop schema public cascade; drop schema drizzle cascade; create schema public` (line 20), `FLUSHDB` on the e2e Redis db (lines 23–25), `rmSync(STORAGE_LOCAL_DIR)` (line 27), then `scripts/migrate.ts` and `scripts/seed.ts` via `execSync` with inherited env (lines 29–30). The seed uses `SEED_PASSWORD=e2e-password-123`, which `journey.spec.ts` line 4 hardcodes.

### 1.6 npm scripts (package.json) — verified
`test` = `vitest run`; `test:e2e` = `playwright test`; `verify` = typecheck, lint, test, build, test:e2e in that order.

## 2. Test files, case by case

Counts below add to 44 unit + 35 integration = 79 vitest cases and 8 Playwright cases, matching plan.md lines 63 and 65.

### 2.1 `tests/unit/copilot.test.ts` (66 lines, 9 cases) — verified
Imports `analyze`, `interpret` from `src/lib/copilot` and `getModel` from `src/server/ai/registry`. Pure functions, no DB.

| Line | Case | Proves |
| --- | --- | --- |
| 10 | analyze › blocks a policy violation before anything is spent | prompt "a teen at the beach" yields suggestion `id: "policy"` with `severity: "block"` |
| 15 | analyze › offers detail for a short prompt and the patch keeps the original words | `short-prompt` suggestion's `patch.prompt` starts with the original text |
| 21 | analyze › flags contradictions | a static shot + camera pan prompt produces an id starting `conflict-` |
| 26 | analyze › suggests the nearest supported aspect ratio | 4:5 on `demo-motion` → `aspect-unsupported` patch to `1:1` |
| 31 | analyze › warns about low-resolution input and crop | 400x300 input at 9:16 → ids `low-res` and `aspect-crop` |
| 44 | analyze › says when a negative prompt will be ignored | negative prompt on `replicate-flux-schnell` → `neg-unsupported` |
| 51 | interpret › maps plain words to supported settings | "vertical, slow push in, golden hour, 8 seconds, gentle" → `{aspectRatio:"9:16", cameraMovement, lighting, durationS:8, motionIntensity:3}` |
| 56 | interpret › snaps to the nearest offered duration and says so | "6 seconds" → `durationS: 5`, change reason matches `/isn't offered/` |
| 62 | interpret › lists what the model cannot do instead of pretending | camera/duration on `demo-still` → listed in `unsupported` |

### 2.2 `tests/unit/policy.test.ts` (70 lines, 29 cases) — verified
Imports `ageAssuranceBlocksRegion`, `ageOn`, `checkPrompt`, `normalizeForPolicy` from `src/server/safety/policy`.

| Line | Case | Proves |
| --- | --- | --- |
| 10–30 | content policy › blocks %s (19 `it.each` rows) | each prompt is refused with the expected category: `minors` (10 rows incl. spaced/dotted/elongated/leet evasions, "school uniform"), `non_consent` (3), `real_person` (2), `incest`, `bestiality`, `extreme_harm` |
| 34–43 | content policy › allows %s (6 rows) | adult phrasings, "18-year-old adult", "married 5 years", "10 years of experience", camera direction are `{allowed: true}` (false-positive guard) |
| 45 | checks every field it is given, including the negative prompt | `checkPrompt("adult couple", "", "teen").allowed === false` |
| 49 | normalizes common evasions | `T.E.E.N` → `teen`, `sl33py` contains `sl`, spaced letters collapse |
| 57 | age › computes age with the birthday boundary | `ageOn` at the exact birthday is 18, one day short is 17 |
| 62 | age › blocks self-declared accounts only in strict regions | `ageAssuranceBlocksRegion` is case-insensitive on country and list, false for `verified_provider` and null country |

### 2.3 `tests/unit/registry.test.ts` (29 lines, 3 cases) — verified
Imports `estimateCost`, `getModel`, `validateAgainstModel` from `src/server/ai/registry`, `pricing` from `src/config/pricing`.

| Line | Case | Proves |
| --- | --- | --- |
| 10 | cost › prices stills, clips per second, 4K and admin multipliers | `imageBase`, 4k doubles, video = `videoPerSecond * durationS` (default 3 s), 150% multiplier ceils, 10% floors to 1 |
| 22 | capabilities › accepts what the model declares | valid `demo-motion` params return `[]` |
| 25 | capabilities › refuses what it does not | flux rejects `mode`, `aspectRatio`, `quality`, `durationS`, `cameraMovement`, `negativePrompt`; `demo-motion` rejects `durationS: 7` |

### 2.4 `tests/unit/signatures.test.ts` (39 lines, 3 cases) — verified
Imports `verifyReplicateWebhook` from `src/server/ai/providers/replicate`, `storage`, `verifyLocalSignature` from `src/server/storage`.

| Line | Case | Proves |
| --- | --- | --- |
| 7 | local media signatures › accepts its own URL and rejects tampering and expiry | a `signedUrl` verifies; changed key, changed `e`, changed download name `d`, or a `now` past expiry all fail |
| 27 | replicate webhook signature › accepts a valid signature | HMAC `v1,<base64>` over `id.timestamp.body` verifies |
| 31 | rejects a wrong secret, a changed body, a stale timestamp and missing headers | each of the four returns false (stale = 600 s) |

### 2.5 `tests/integration/generation.test.ts` (258 lines, 16 cases) — verified
Real Postgres + Redis. Registers a controllable `fake` provider adapter and a `fake-model` spec by mutating `MODELS` (lines 16–38). Calls service functions directly (`createDraft`, `confirmJob`, `cancelJob`, `deriveDraft`, `deleteJob` from `src/server/generation/service`; `processJob`, `reconcile` from `src/server/generation/processor`). It does not go through HTTP routes or the BullMQ worker loop.

| Line | Case | Proves |
| --- | --- | --- |
| 63 | runs draft → confirm → process → completed and charges exactly once | states `awaiting_confirmation` → `queued` → `completed`; balance `{available:46, reserved:4}` after confirm and `{46, 0}` after completion; a second `processJob` and a repeat `confirmJob` change nothing; ledger for the job is exactly `["reserve","settle"]`; demo output `isDemo: true` |
| 90 | returns the same job for a repeated idempotency key | two concurrent `createDraft` with the same key yield one id; two concurrent confirms reserve once |
| 99 | refuses to confirm without enough credits and leaves the job unqueued | error `/needs 4 credits/`, status stays `awaiting_confirmation`, balance unchanged |
| 108 | rejects a confirm whose cost does not match the estimate | `expectedCost: 1` → `code: "cost_changed"` |
| 114 | refunds a cancelled queued job and makes the cancel stick | cancel → `cancelled`; a later `processJob` leaves it `cancelled`; balance `{50,0}` |
| 126 | aborts a processing job when cancel is requested, and refunds | hanging provider + `cancelPollMs: 50`; `cancelRequested: true`, final `cancelled`, refund |
| 141 | retries retryable provider errors, then fails and refunds once attempts run out | 3 `processJob` calls → 3 provider calls, `failed`, `failureCode: "rate_limited"`, message mentions credits returned, balance `{50,0}` |
| 155 | fails fast on a non-retryable error and refunds | one call → `failed`, `content_rejected`, refund |
| 167 | times out a hung provider | `timeoutMs: 50` x3 → `failed`, `failureCode: "timeout"`, refund |
| 180 | fails and refunds jobs a dead worker left in processing | job forced to `processing` with `startedAt` 1 h ago; `reconcile({staleProcessingMs: 60_000})` reports `failed: 1` and refunds |
| 193 | blocks prohibited prompts server-side and records a moderation event | three evasive prompts → `code: "policy_blocked"`; `moderation_events.reason` = `minors, minors, non_consent` |
| 202 | validates settings against model capabilities | `unsupported_settings` (21:9; durationS on a still), `input_required` (image_to_image with no input), `model_unavailable` (flux without token) |
| 210 | enforces the per-user concurrency limit | fourth confirm with three active → `code: "too_many_active"` |
| 220 | never lets one user see, confirm, cancel or derive from another user's job | confirm/cancel/derive/delete/`parentJobId` by another user → `status: 404` |
| 231 | makes variations with a new seed and records lineage | `deriveDraft(..., "variation")` sets `parentJobId`, `relation`, a different `seed`, same prompt |
| 243 | produces a real demo video clip through ffmpeg | `demo-motion` 3 s costs 9, completes, `qualityReport.container === "mp4"` |

### 2.6 `tests/integration/platform.test.ts` (365 lines, 19 cases) — verified
Real Postgres + Redis. Invokes two route handlers directly with `NextRequest` (`POST` of `src/app/api/webhooks/stripe/route`, `GET` of `src/app/api/media/route`); everything else is service-level. `makeCreation()` (lines 41–63) is a full draft → confirm → `processJob` helper.

| Line | Case | Proves |
| --- | --- | --- |
| 88 | stripe webhook › grants a pack exactly once even when Stripe delivers the event twice | first `checkout.session.completed` → 200 `{outcome:"processed"}`, repeat → `{outcome:"duplicate"}`, balance 100, one `purchase` ledger row |
| 99 | rejects a forged signature and changes nothing | header `t=1,v1=deadbeef` → 400, balance 0 |
| 106 | ignores unpaid checkouts | `payment_status: "unpaid"` → `{outcome:"ignored"}` |
| 113 | asks Stripe to retry an invoice that arrives before its subscription, then grants once | `invoice.paid` before subscription → **500** (deliberate, so Stripe retries); after the subscription checkout the retry is `processed`; a third delivery is a no-op; balance 400; `subscriptions.status === "active"` |
| 134 | consent › withdrawing an upload consent deletes the upload, every creation made from it, and the stored files | `withdrawConsent` soft-deletes the job and both assets, rewrites `storageKey` to `purged/...`, `storage().get` throws, reuse of the upload → 404 |
| 154 | removing a character deletes its reference and its creations | `removeCharacter` soft-deletes `character_references` row and dependent job; reuse → 404 |
| 166 | one user cannot use another user's character or upload | cross-user `characterReferenceId` / `inputAssetIds` / `removeCharacter` → 404 |
| 178 | publishing › copies the output to a new public asset and leaves the original private | `publishTemplate` creates a distinct `public` poster asset; `assetUrl(original, otherUser)` and `assetUrl(original, null)` are null |
| 191 | refuses to publish anything made from an upload or a character | → `status: 403, code: "personal_media"` |
| 198 | refuses to publish someone else's creation | → 404 |
| 205 | removing a reported template takes it down and closes every report on it | `resolveReport(... "remove")` → template `removed`, zero open `moderation_events`; re-resolving → 409 |
| 222 | video posters › stores a poster frame for clips, uses it as the published cover, and deletes it with the creation | `posterAssetId` set, poster is `image/webp` private 720x1280; publish makes a separate cover; `deleteJob` soft-deletes the poster |
| 242 | discovery privacy › For You falls back to trending when personalization is off | `forYou().personalized` true with a favorite, false after `user_preferences.personalizationEnabled=false` |
| 255 | accounts › refuses under-18 signups without storing anything | `registerUser` 17-year-old → `403 underage`; no `users` row |
| 265 | deleting an account ends sessions, removes templates and hides creations | wrong password → 403; correct → `userForToken` null, template `removed`, job soft-deleted, `discovery_events` purged |
| 283 | admin credit adjustments apply once per key | same key twice → `applied: false`, balance 30; overdraft (-31) throws |
| 296 | media route › serves only valid, unexpired, undeleted links, and supports ranges | 200 `image/webp`; `bytes=0-9` → 206 with correct slice; `bytes=-4` suffix; tampered `s` → 403; missing `s` → 403; deleted asset → 404 |
| 326 | projects › keeps scene order, copies continuity forward, and selects only finished takes | continuity copied into a new scene; partial reorder → 422; full reorder persisted; a creation attached to a scene appears as a version; `selectVersion`; cross-user detail/select/create → 404 |
| 357 | presets › saves a creation's settings without its seed, and only for the owner | preset params `{aspectRatio, quality}` with no `seed`; other user → 404 |

Note: `tests/integration/platform.test.ts` line 261 (`getDb().execute(\`select 1 ...\` as never)`) passes a raw string cast to `never`; plan.md reports the suite green, so drizzle's `execute` evidently accepts it at runtime, but it is a type-unsafe pattern.

### 2.7 `tests/e2e/journey.spec.ts` (167 lines, 8 cases, serial) — verified
Runs against the standalone production build with the real worker. Shared mutable `creationId` / `mediaUrl` (lines 36–37) couple test 2 to test 1. Helpers: `enterAgeGate` (age gate heading "Adults only", button "I am 18 or older, enter"), `signUp` (fills `/auth` form including DOB and two consent checkboxes), `apiAs` (`POST /api/auth/login` with `Origin` header, expects 200).

| Line | Case | Proves |
| --- | --- | --- |
| 39 | an adult signs up, makes a demo image from a template, and finds it in the Library | signup lands on `/`, balance shows 0; admin login + `POST /api/admin/credits` (account, amount 40, idempotencyKey) → 200; `/explore?q=velvet` lists "Velvet Hour"; template page shows `cost-line` "4"; "Make it" opens a confirm with `confirm-cost` "4 credits" and the demo disclosure text; `confirm-make` → "Weaving a demo placeholder."; `/collection` polls by reload until the first `article` link has `aria-label` starting `Ready:` (60 s); "Demo" badge; detail URL `/collection/<uuid>`; `<img alt="Your creation">` loads with `naturalWidth > 0` and `src` contains `/api/media?`; balance 36 |
| 84 | another member cannot see that creation or its media | second signed-up user: `GET /collection/<id>` → 404, `GET /api/generations/<id>` → 404, `POST .../derive` → 404, `DELETE /api/generations/<id>` → 404; media URL with `s=forged` → 403; `POST /api/folders` with `Origin: https://evil.example` → 403 |
| 109 | an under-18 date of birth is refused | DOB 16 years ago → alert "Hushloom is for adults only.", stays on `/auth` |
| 118 | the assistant blocks a prohibited prompt before anything is charged | sign in as `demo@hushloom.local`; `/generate/image` prompt "a teen at the beach" → text "This can't be created" and "Make it" disabled |
| 136–150 | layout holds on mobile / tablet / desktop (3 cases: 390x844, 820x1180, 1440x960) | anonymous (after age gate) pages `/`, `/explore`, `/templates/velvet-hour`, `/pricing` have `scrollWidth - innerWidth <= 0`; screenshots saved |
| 152 | keyboard users can skip to content and reach navigation | first Tab focuses "Skip to content" link; Enter → URL ends `#main`; no visible `a`/`button` on `/explore` lacks an accessible name (aria-label or text) |

## 3. Coverage against spec Part XI

Spec text (spec.md line 60): "Test: auth, browsing, search, filters, favorites, template opening, generation forms, validation, uploads, job creation, queue, completion/failure, credits, webhooks, collection, download, deletion, publishing, private access, responsive layouts, keyboard a11y, consent. Unit + integration + e2e; failure cases; cross-user URL manipulation blocked; retries never double-charge; cancelled/failed reach consistent terminal states; mobile/tablet/desktop checks."

Legend: **Covered** = at least one test exercises the behavior end to end or at the owning service/route; **Partial** = only a slice or only one layer; **Not covered** = no test touches it (the feature itself may exist).

| Spec item | Status | Evidence (tests) | What is missing |
| --- | --- | --- | --- |
| auth | Partial | e2e:39 signup via UI, e2e:118 sign-in via UI, e2e `apiAs` `POST /api/auth/login` 200; platform:255 underage `registerUser` 403; platform:265 `createSession`/`userForToken`, deleteAccount wrong password 403, sessions ended on delete | No test for wrong-password login (`/api/auth/login` 401 path), logout, session expiry (`SESSION_TTL_DAYS`), `/api/me/sessions`, signup duplicate email/handle, suspend route (`/api/admin/users/[id]/suspend`), login rate limit |
| browsing | Partial | e2e:136 loads `/`, `/explore`, `/templates/velvet-hour`, `/pricing` anonymously; platform:242 `forYou` personalization toggle | No assertions on gallery content, pagination, VIP gating, creator profiles, `/api/templates` list route |
| search | Partial | e2e:39 navigates to `/explore?q=velvet` and finds the "Velvet Hour" link | No negative search, no service-level test of `src/server/discovery/templates.ts` `ilike` matching (title/description/handle/tags) |
| filters | Not covered | — | No test passes a category/tag/VIP/mode filter to `/explore` or the discovery service |
| favorites | Partial | platform:242 inserts a `favorites` row directly to drive personalization | `POST /api/favorites` route, toggle/untoggle, favorites listing and cross-user ownership untested |
| template opening | Covered | e2e:39 opens the template page from Explore, checks heading, `cost-line`, "Make it" → confirm dialog | Only the demo template; no VIP-locked template test |
| generation forms | Partial | e2e:39 template → make flow; e2e:118 `/generate/image` prompt field + disabled "Make it"; copilot unit tests for suggestion logic | No UI test for video form, image-to-image/upload form, reference-guided (character) form, preset application, or the `consent-checkbox` on uploads |
| validation | Covered | registry unit:22/25 (`validateAgainstModel`), generation:202 (`unsupported_settings`, `input_required`, `model_unavailable`), generation:108 (`cost_changed`), policy unit (29 cases), generation:193 server-side block | HTTP-level 400/422 shapes of `POST /api/generations` are not asserted; only service error codes |
| uploads | Partial | platform:134/166/191 use `acceptUpload` with a generated PNG and a consent statement | `POST /api/uploads` route untested (size limit, mime sniffing, rejection paths, video upload); no e2e upload; `upload-input` test id exists in `create-panel.tsx:309` but no test uses it |
| job creation | Covered | generation:63/90/99/108/210/220; e2e:39 through the UI; `POST /api/generations` reached only indirectly via UI in e2e | Direct route tests for `POST /api/generations` and `/confirm` absent |
| queue | Partial | e2e:39 exercises the real BullMQ worker (`src/worker/index.ts`) to reach "Ready"; generation:180 `reconcile` for stale processing rows | vitest calls `processJob` directly, so enqueue/dequeue, BullMQ retry/backoff config, `WORKER_CONCURRENCY`, and worker health endpoint are only exercised implicitly by one e2e case (inferred: `confirmJob` enqueues, but no test inspects the queue) |
| completion/failure | Covered | generation:63 (completed), 141 (retry exhaustion → failed), 155 (fatal → failed), 167 (timeout → failed), 180 (stale → failed), 243 (video completed) | Failure state not surfaced in a UI test |
| credits | Covered | generation:63 reserve/settle exactly once, 90 concurrent confirm, 99 insufficient, 114/126/141/155/167/180 refunds; platform:283 admin adjust idempotent + overdraft refused; platform:88 purchase grants once; e2e:39 balance 0 → 36 after a 40 grant and 4 spend | Checkout creation (`POST /api/checkout`, 503 without `STRIPE_SECRET_KEY`) untested; plan-driven concurrency limits by plan untested |
| webhooks | Partial | Stripe route: platform:88/99/106/113 (duplicate, forged 400, unpaid ignored, invoice-before-subscription 500 then processed); Replicate: signatures unit:27/31 verify function only | `src/app/api/webhooks/replicate/route.ts` has no route test (plan.md line 143 says it only verifies and logs); Stripe `customer.subscription.deleted`/cancellation path untested |
| collection | Partial | e2e:39 `/collection` shows the Ready creation, Demo badge, detail page `/collection/<id>` with loaded image; e2e:84 cross-user 404 | No test for collection listing filters/sort, folders (`/api/folders`, `/api/folders/[id]/items`) beyond the 403 origin check, history (`/api/me/history`) |
| download | Partial | signatures unit:7 verifies the `d` (download filename) parameter is part of the HMAC; platform:296 media route serves bytes and ranges | `GET /api/generations/[id]/download` (redirect to signed URL with `Content-Disposition: attachment`, `src/app/api/media/route.ts:30`) has no test; no cross-user download test |
| deletion | Covered | platform:222 `deleteJob` soft-deletes poster; platform:134 consent withdrawal purges files; platform:154 character removal; platform:265 account deletion; e2e:84 cross-user `DELETE /api/generations/<id>` → 404; generation:220 cross-user `deleteJob` 404 | Owner-path `DELETE /api/generations/[id]` via HTTP (200 shape) and file purge after plain deletion (as opposed to consent withdrawal) not asserted |
| publishing | Covered | platform:178 (new public asset, original stays private), 191 (`personal_media` 403), 198 (cross-user 404), 205 (report → removed, 409 on re-resolve), 222 (clip cover) | No UI or route test for `POST /api/templates`; rate/report routes (`/api/templates/[id]/rate`, `/report`) untested |
| private access | Covered | platform:296 media route 200/206/403/403/404; platform:178 `assetUrl` null for other user and anonymous; signatures unit:7; e2e:84 forged signature 403 and cross-user page/API 404s | S3 driver path untested (no credentials; plan.md line 147) |
| responsive layouts | Partial | e2e:136–150 three viewports, four anonymous pages, horizontal-overflow assertion, screenshots | Authenticated pages (`/collection`, `/generate/*`, `/projects`, admin) not checked; plan.md line 120 notes an admin table layout defect at narrow widths that no test catches |
| keyboard a11y | Partial | e2e:152 skip link focus + `#main`, all visible `a`/`button` on `/explore` have accessible names | No focus-trap/Escape test for the confirm dialog, no test that form inputs/checkboxes have labels, only `/explore` is checked, no `prefers-reduced-motion` test |
| consent | Covered | platform:134 (upload consent withdrawal cascades + purges), 154 (character removal), 191 (consent boundary blocks publishing), 255 (adult attestation at signup), e2e:39 signup clicks "I am at least 18" and "I agree to the", e2e:109 underage refusal | `/api/me/consents/[id]` route (HTTP) untested; likeness consent record creation for characters not asserted; strict-region 451 path tested only at the pure-function level (policy unit:62), not through `createDraft` with a country |
| cross-user URL manipulation blocked | Covered | generation:220 (confirm/cancel/derive/delete/parent), platform:166 (character/upload), 198 (publish), 326 (project detail/select/create), 357 (preset), e2e:84 (page, GET, derive, DELETE all 404; forged media 403) | Folders, favorites, presets `[id]` and scenes routes not probed cross-user over HTTP |
| retries never double-charge | Covered | generation:63 (duplicate `processJob` and repeat confirm leave ledger at `reserve`+`settle`), 90 (concurrent confirms reserve once), 141 (three provider attempts, one reserve, one refund), platform:88 (duplicate Stripe event grants once), platform:283 (admin adjust once per key) | — |
| cancelled/failed reach consistent terminal states | Covered | generation:114 (cancel sticks after a late `processJob`), 126 (cancel during processing), 141/155/167 (failed with `failureCode`), 180 (reconcile) | No test that a completed job refuses a later cancel (inferred gap) |
| mobile/tablet/desktop checks | Partial | e2e:136–150 (390/820/1440) | Same limits as "responsive layouts" |
| unit + integration + e2e layers | Covered | 4 unit files, 2 integration files, 1 e2e file | — |
| failure cases | Covered | generation 99/108/141/155/167/180/193/202/210; platform 99/106/113/191/198/205/255/265/283/296 | — |

Summary: 13 covered, 11 partial, 1 not covered (filters).

## 4. Observations about the harness (verified unless marked)

1. All vitest integration tests call service functions directly; only two HTTP handlers (`/api/webhooks/stripe`, `/api/media`) are invoked as route modules. The 43 API routes under `src/app/api` are otherwise exercised only by the e2e file (login, admin credits, generations GET/derive/DELETE, folders POST, media GET) and only on their refusal paths except `POST /api/auth/login` and `POST /api/admin/credits`.
2. The e2e suite is serial and state-sharing: `tests/e2e/journey.spec.ts` lines 36–37 and the `expect(creationId).not.toBe("")` guard at line 85 mean test 2 is skipped-as-failed if test 1 fails.
3. `MEDIA_SIGNING_SECRET` is randomized per Playwright run (`playwright.config.ts` line 15) but shared by both `webServer` processes through the same `env` object, so app and worker agree.
4. `tests/global-setup.ts` depends on a pre-existing `playbox_test` database; `scripts/e2e-prepare.ts` creates `playbox_e2e` itself. Asymmetric, documented in plan.md line 35.
5. `vitest.config.ts` sets `STORAGE_LOCAL_DIR=.storage-test` relative to cwd; nothing in the harness clears that directory between runs (inferred: `resetDb` truncates tables and flushes Redis only, lines 10–17 of helpers.ts).
6. `tests/integration/generation.test.ts` line 36–38 mutates the module-level `MODELS` array and the adapter registry; because `fileParallelism: false` and each file is a separate module graph, this does not leak into `platform.test.ts`, but it would if the files were ever merged.
7. An untracked `dump.rdb` sits at the repo root (`git status`), produced by the local `redis-server`; it is unrelated to the tests but is noise a future session may commit by accident.
8. No test runs with `ENABLE_DEMO_PROVIDER` unset, with `REPLICATE_API_TOKEN` set, with `STORAGE_DRIVER=s3`, or with `AGE_ASSURANCE_STRICT_REGIONS` passed through `createDraft` (only the pure `ageAssuranceBlocksRegion` helper is tested). The 451 refusal described in plan.md line 88 therefore has no integration or e2e proof.
9. Nothing checks `npm run verify` ordering beyond package.json; plan.md line 59–66 records the last green run at commit `0987b7c`, two commits before HEAD `a4752a9` (the two later commits are notes and a lockfile name sync).
