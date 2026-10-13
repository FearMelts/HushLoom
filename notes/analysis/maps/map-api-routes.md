# Hushloom API route inventory (branch `claude/playbox-2-foundation-q7fpbs`)

Read-only inventory of every file under `src/app/api/**` (43 route files, 62 handler exports), produced by reading the handlers and the server modules they call. Everything in a "Verified" block was read from code; anything marked *Inference* is a conclusion drawn from the code, not something observed at runtime. No command that changes state was run.

Source of truth for shared behaviour:

| Concern | File | Lines |
| --- | --- | --- |
| Route wrapper, error envelope, auth guards, JSON parser | `src/server/http.ts` | 7–81 |
| Origin (CSRF) check on mutating API calls | `src/middleware.ts` | 3–24 |
| Rate limiter (Redis fixed window) | `src/server/redis.ts` | 18–23 |
| Session cookie, user lookup | `src/server/auth/session.ts` | 10–86 |
| Country header for age assurance | `src/server/request.ts` | 5–7 |
| Env var names and defaults | `src/server/env.ts` | 4–31 |

---

## 0. Cross-cutting contract

### 0.1 Wrapper and error envelope (`src/server/http.ts:46-73`)

Every route except `GET /api/health` and `GET /api/media` is wrapped in `route(handler)`. The wrapper maps thrown errors to one JSON envelope:

```json
{ "error": { "code": "<string>", "message": "<string>", "details": <any | undefined> } }
```

| Thrown | Status | `code` | `details` |
| --- | --- | --- | --- |
| `HttpError(status, code, message, details?)` | as given | as given | as given |
| `ZodError` (any `schema.parse`, incl. query parsing) | 422 | `invalid_input` | `err.flatten()` → `{ formErrors: string[], fieldErrors: Record<string,string[]> }` |
| `InsufficientCreditsError` (`src/server/credits/ledger.ts:5-12`) | 402 | `insufficient_credits` | `{ needed, available }` |
| Postgres `22P02` (malformed uuid) anywhere up to 3 `cause` levels deep (`http.ts:76-81`) | 404 | `not_found` | — |
| anything else | 500 | `internal` | — (logged via `logger.error`) |

Helpers: `unauthorized()` → 401 `unauthorized` "Sign in to continue." · `forbidden(msg)` → 403 `forbidden` · `notFound()` → 404 `not_found` "Not found." (`http.ts:18-21`). The comment at line 20 states that "not found" and "not yours" are deliberately indistinguishable.

### 0.2 Auth levels

| Level | Guard | Behaviour |
| --- | --- | --- |
| **anon** | none / `getCurrentUser()` | user optional |
| **member** | `requireUser()` (`http.ts:23-27`) | 401 `unauthorized` when no valid session |
| **admin** | `requireAdmin()` (`http.ts:29-33`) | 401 if signed out; **404 `not_found`** (not 403) when `user.role !== "admin"` |

Session: cookie `hl_session` (`session.ts:10`), httpOnly, `SameSite=Lax`, `secure` only when `NODE_ENV=production`, `path=/`, expiry = `SESSION_TTL_DAYS` (default 30) (`session.ts:40-48`). Token is 32 random bytes base64url; only its SHA-256 is stored in `sessions.token_hash` (`session.ts:29-37`). `userForToken` (`session.ts:50-68`) returns a user only when the session is unexpired **and** `users.status = 'active'` **and** `deleted_at is null`, so suspended/deleted users become anonymous immediately. `SessionUser = { id, email, role: "member"|"creator"|"admin", handle, displayName, ageAssuranceMethod }` (`session.ts:12-19`).

### 0.3 Body parsing

`parseJson(req, schema)` (`http.ts:35-43`): non-JSON body → 400 `invalid_json` "Request body must be JSON."; schema failure → 422 `invalid_input` via the wrapper. Query strings are parsed with `schema.parse(Object.fromEntries(req.nextUrl.searchParams))` directly (GET `/api/generations`, GET `/api/templates`) and therefore also produce 422 on bad input. Two routes read `multipart/form-data` via `req.formData()` (`/api/uploads`, `/api/characters`); a non-multipart body there throws a non-`HttpError` and surfaces as **500 `internal`** (*Inference* from `http.ts:69-70`; not exercised).

### 0.4 Origin check (`src/middleware.ts`)

Matcher: every path except `_next/static`, `_next/image`, `favicon.ico` (`middleware.ts:24`). For `POST|PUT|PATCH|DELETE` on `/api/*` **except `/api/webhooks/*`** (`middleware.ts:10`): if an `Origin` header is present and equals neither `req.nextUrl.origin` nor `new URL(process.env.APP_URL).origin`, respond **403 `{ error: { code: "bad_origin", message: "Cross-site request refused." } }`** (`middleware.ts:11-16`). A request with **no** `Origin` header passes (curl, server-to-server). `GET`/`HEAD`/`OPTIONS` are never checked. Middleware also sets `x-pathname` on the forwarded request (`middleware.ts:19-21`). Note the middleware reads `process.env.APP_URL` directly, not `env()`, so the default `http://localhost:3000` from `env.ts:6` does **not** apply here; with `APP_URL` unset, `publicOrigin` is `null` and only `req.nextUrl.origin` is accepted.

### 0.5 Rate limiting (`src/server/redis.ts:18-23`)

`rateLimit(bucket, limit, windowS)`: `INCR rl:<bucket>`; on the first hit `EXPIRE windowS`; returns `count <= limit`. Fixed window, counts every call (successful or not). On Redis failure `incr` throws → the wrapper returns 500 `internal` (*Inference*: fail-closed). Routes that limit always throw `HttpError(429, "rate_limited", <message>)`. There is no `Retry-After` header anywhere.

IP is taken as `req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"` (`auth/login/route.ts:10`, `auth/signup/route.ts:8`). See defect D2.

### 0.6 Country / age assurance

`requestCountry(req)` (`src/server/request.ts:5-7`) reads header named by `GEO_COUNTRY_HEADER` (default `x-country-code`), first 2 chars upper-cased, else `null`. `ageAssuranceBlocksRegion` (`src/server/safety/policy.ts:90-97`) returns true only when the country is listed in `AGE_ASSURANCE_STRICT_REGIONS` (comma-separated) **and** `users.age_assurance_method = 'self_declaration'` → 451 on draft creation.

### 0.7 Success envelopes

There is no single success envelope. Most mutations return `{ "ok": true }`; creates return the created row under a domain key (`{ job }`, `{ project }`, `{ scene }`, `{ preset }`, `{ folder }`, `{ template }`) or the raw service result (`/api/uploads`, `/api/characters`, `/api/admin/credits`). Status 201 is used for creates where noted; everything else is 200.

---

## 1. Health and infrastructure

### `GET /api/health` — `src/app/api/health/route.ts`
- **Auth**: anon. **Not wrapped** in `route()`; `export const dynamic = "force-dynamic"` (line 6).
- **Checks**: `select 1` on Postgres (line 11); `redis().ping() === "PONG"` (line 17).
- **Response**: `{ ok: boolean, checks: { database: "ok"|"down", redis: "ok"|"down" } }`, status **200** when both ok, **503** otherwise (line 22).
- Rate limit: none. Origin check: n/a (GET).

### `GET /api/media` — `src/app/api/media/route.ts`
- **Auth**: anon by signature. **Not wrapped**; hand-rolled JSON errors.
- **Query**: `k` (storage key), `e` (unix-seconds expiry), `s` (HMAC base64url), optional `d` (download filename). Verified by `verifyLocalSignature` (`src/server/storage/index.ts:30-35`): HMAC-SHA256 over `"${key}\n${exp}\n${download}"` with `mediaSigningSecret()` (`MEDIA_SIGNING_SECRET`, dev fallback string at `env.ts:57`), timing-safe compare, rejects if `exp*1000 < now`.
- **Errors**: 403 `{ error: { code: "forbidden", message: "Link expired or invalid." } }` (line 18); 404 `not_found` when no `media_assets` row for `storage_key` or `deleted_at` set (line 21); 416 with `Content-Range: bytes */<len>` for an unsatisfiable range (line 38).
- **Success**: 200 full body or 206 partial (`Range: bytes=a-b`, `bytes=a-`, `bytes=-N`). Headers: `Content-Type: <asset.mime>`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=<seconds until exp>`, `X-Robots-Tag: noindex`, `Content-Length`, `Content-Disposition: attachment; filename="<d sanitised to [\w.-]>"` when `d` present (lines 24-30).
- Only used by the local storage driver; S3 driver issues presigned S3 URLs instead (`storage/index.ts:96-106`). Signed local URLs are `/api/media?k=&e=&s=[&d=]` with expiry rounded up to a TTL window boundary (`storage/index.ts:57-65`), TTL `MEDIA_URL_TTL_S` (default 300) for private assets, 3600 for public (`src/server/media.ts:16`).
- Rate limit: none. Tested by `tests/integration/platform.test.ts:295-323` ("media route").

---

## 2. Auth and age gate

### `POST /api/age-gate` — `src/app/api/age-gate/route.ts`
- Auth: anon. Body: `{ confirm: true }` (zod `z.literal(true)`, line 6).
- Success 200 `{ ok: true }` and sets cookie `hl_age_ok=1`, httpOnly, `SameSite=Lax`, `path=/`, `maxAge` 30 days, `secure` in production (line 8).
- Errors: 400 `invalid_json`, 422 `invalid_input`, 403 `bad_origin`. No rate limit.

### `POST /api/auth/signup` — `src/app/api/auth/signup/route.ts`
- Auth: anon. **Rate limit first**: `signup:<ip>` 10 / 3600 s → 429 "Too many sign-ups from here. Try later." (line 9).
- Body `signupSchema` (`src/server/auth/account.ts:31-44`): `email` (trim, lowercase, email), `password` (10–200), `handle` (3–24, `^[a-zA-Z0-9_]+$`), `displayName` (1–40), `dateOfBirth` (`YYYY-MM-DD` regex), `acceptTerms: true`, `confirmAdult: true` (literal true with custom messages).
- `registerUser` (`account.ts:46-95`): age computed in UTC (`policy.ts:77-83`); non-finite or >120 → 422 `invalid_input` with `details.fieldErrors.dateOfBirth`; age < 18 → **403 `underage`** "Hushloom is for adults only." and nothing is stored (line 49-52). Transaction inserts `users` (age_assurance_method `self_declaration`), `user_profiles`, `user_preferences`, `credit_accounts`, two `consent_records` (`terms`, `adult_attestation`), optional `signup_grant` ledger movement when `SIGNUP_GRANT_CREDITS > 0` (idempotency key `signup:<userId>`), audit `account.create`. Unique violations mapped to 409 `email_taken` / 409 `handle_taken` with `details.fieldErrors` (lines 91-92).
- Success **201** `{ ok: true }` + `hl_session` cookie set.
- Errors: 400, 422, 403 `underage`, 409, 429, 403 `bad_origin`.

### `POST /api/auth/login` — `src/app/api/auth/login/route.ts`
- Auth: anon. Body `{ email: string(≤200), password: string(≤200) }` (line 9).
- Rate limit: `login:ip:<ip>` 30 / 900 s **and** `login:email:<email lowercased>` 10 / 900 s (line 11; short-circuit `&&`, so the email bucket is only incremented when the IP bucket allowed) → 429 "Too many attempts. Wait 15 minutes and try again."
- `authenticate` (`account.ts:99-108`): matches `lower(email)`, `status='active'`, not deleted; always runs bcrypt against a dummy hash when the user is missing (timing equalisation). Failure → **401 `bad_credentials`** "Email or password is incorrect."
- Success 200 `{ ok: true }` + `hl_session` cookie.

### `POST /api/auth/logout` — `src/app/api/auth/logout/route.ts`
- Auth: anon (works signed out). Deletes the `sessions` row for the cookie token and clears the cookie (`session.ts:77-82`). 200 `{ ok: true }`. No body. No rate limit.

---

## 3. Account (`/api/me`)

### `GET /api/me` — `src/app/api/me/route.ts:8-11`
- Auth: member. Response = `settingsFor(userId)` (`src/server/me.ts:29-60`):
```
{ profile: { displayName, handle, bio },
  preferences: { personalizationEnabled, historyEnabled, autoplayPreviews, copilotEnabled, interests: string[] },
  consents: [{ id, kind, statement, subjectLabel, grantedAt: ISO, withdrawnAt: ISO|null }]   // newest 100
  activeSessions: number,
  popularTags: string[] }                                                                      // top 30 tags on published templates
```
- Note: no credit balance here (balance is rendered server-side elsewhere; no API exposes it).

### `PATCH /api/me` — `route.ts:13-17`
- Auth: member. Body `profileSchema` (`me.ts:8-17`): `displayName` (1–40), `handle` (3–24, `^[a-zA-Z0-9_]+$`), `bio` (≤280, default ""). All three required.
- 409 `handle_taken` with `details.fieldErrors.handle` when another user holds the handle case-insensitively (`me.ts:63-67`). Audit `profile.update`. 200 `{ ok: true }`.

### `DELETE /api/me` — `route.ts:20-27`
- Auth: member. Body `{ password: string(1–200) }`. `deleteAccount` (`account.ts:154-172`): wrong password → **403 `bad_password`**. On success: user status `deleted`, email replaced with `deleted-<uuid>@invalid`, password hash `!`, profile anonymised, all owned `media_assets`/`generation_outputs`/`generation_jobs` soft-deleted (`cancelRequested=true`), templates set `removed`, `discovery_events` deleted, all consents withdrawn, audit `account.delete`, all sessions destroyed. Response 200 `{ ok: true }` and `hl_session` cookie deleted. Files are purged later by the retention job, not immediately (comment at line 153).

### `PATCH /api/me/preferences` — `src/app/api/me/preferences/route.ts`
- Auth: member. Body `preferencesSchema` (`me.ts:19-27`), all optional: `personalizationEnabled`, `historyEnabled`, `autoplayPreviews`, `copilotEnabled` (booleans), `interests` (array ≤12 of trimmed lowercase 1–24 strings). Upsert into `user_preferences`; `historyEnabled: false` also calls `clearHistory` (`me.ts:79`). Empty body object is a no-op. 200 `{ ok: true }`.

### `DELETE /api/me/history` — `src/app/api/me/history/route.ts`
- Auth: member. Deletes all `discovery_events` for the user, audit `history.clear`. 200 `{ removed: number }`.

### `DELETE /api/me/sessions` — `src/app/api/me/sessions/route.ts`
- Auth: member. Deletes every `sessions` row for the user (including the current one), audit `sessions.revoke_all`, clears cookie. 200 `{ ok: true }`.

### `DELETE /api/me/consents/[id]` — `src/app/api/me/consents/[id]/route.ts`
- Auth: member. `withdrawConsent` (`account.ts:112-150`): sets `withdrawn_at` on the user's own un-withdrawn record or 404; kind `terms`/`adult_attestation` → **422 `use_account_deletion`** "To withdraw this, delete your account in Settings." (note: the `withdrawn_at` update has already happened inside the transaction when this throws, so it rolls back). Otherwise soft-deletes dependent `character_references`, every job whose `input_asset_ids` overlap or whose `character_reference_id` matches, their outputs + posters, the assets, audit `consent.withdraw`, then **purges files immediately** via `purgeAssetsNow` (`media.ts:104-111`). 200 `{ ok: true }`. Tested at `platform.test.ts:134,154`.

---

## 4. Uploads and characters (Train)

### `POST /api/uploads` — `src/app/api/uploads/route.ts`
- Auth: member. Rate limit `upload:<userId>` 40 / 3600 s → 429 "Upload limit reached for this hour." (line 11; checked **before** the body is read).
- Body: `multipart/form-data` — `file` (File, required → 422 `invalid_input` "Attach a file."), `consent` must be the string `"true"` → else 422 `consent_required`, optional `subject` (≤80 chars → `consent_records.subject_label`).
- `acceptUpload(..., "source")` (`src/server/media.ts:36-90`): video (`declaredMime` starts `video/`): >100 MB → 413 `too_large`; bytes 4–8 must be `ftyp` → else 415 `unsupported_type` "Videos must be MP4."; stored as-is with mime `video/mp4`. Image: >20 MB → 413; `sharp.metadata()` failure or format not jpeg/png/webp → 415; re-encoded to WebP q92 with `.rotate()` (strips EXIF); `low_resolution` warning when min side <512. Writes consent record (kind `upload_subject`, statement = `CONSENT_STATEMENT` at `uploads/route.ts:6-7`), `media_assets` (visibility `private`, sha256), `uploads` (purpose `source`).
- Success **201** `{ assetId, kind: "image"|"video", width, height, warnings: string[] }`.
- Note: no size cap is enforced before `file.arrayBuffer()` buffers the whole upload (D4).

### `GET /api/characters` — `src/app/api/characters/route.ts:6-9`
- Auth: member. 200 `{ characters: [{ id, name, createdAt, consentGrantedAt, imageUrl: string|null, width, height }] }` (`src/server/characters.ts:16-35`); excludes deleted refs and withdrawn consents.

### `POST /api/characters` — `route.ts:11-24`
- Auth: member. Rate limit `character:<userId>` 10 / 3600 s → 429.
- Body multipart: `file` (required → 422 `invalid_input` "Attach a photo."), `name` (trimmed, truncated to 40, required → 422 "Name the character."), `consentAdult === "true"` **and** `consentLikeness === "true"` → else 422 `consent_required`.
- `createCharacter` (`characters.ts:37-53`): non-`image/*` declared mime → 415 `unsupported_type`; 20th existing character → 422 `limit_reached`; then `acceptUpload(..., "reference")` (consent kind `likeness`, statement `LIKENESS_STATEMENT`), inserts `character_references`.
- Success **201** `{ id, warnings: string[] }`.

### `DELETE /api/characters/[id]` — `src/app/api/characters/[id]/route.ts`
- Auth: member. 404 when not owned/deleted; otherwise `withdrawConsent` on the reference's consent record (cascades to every creation that used it, purges files). 200 `{ ok: true }`.

---

## 5. Generation

Job row type `Job = typeof generationJobs.$inferSelect` (`src/server/generation/service.ts:31`). **Four handlers return the raw DB row** under `{ job }` (`POST /api/generations`, `confirm`, `cancel`, `derive`); `GET /api/generations/[id]` and the list return the hydrated `CreationListItem` shape instead (see D1).

`CreationListItem` (`src/server/generation/views.ts:6-24`):
```
{ id, status, mode, modelKey, prompt, isDemo, createdAt, queuedAt|null, startedAt|null, finishedAt|null,
  failureMessage|null, costCredits, templateTitle|null, projectId|null, relation|null,
  output: { assetId, kind: "image"|"video", url|null, posterUrl|null, width|null, height|null } | null,
  isFavorited }
```

Job status enum (`src/server/db/schema.ts:39-47`): `draft | awaiting_confirmation | queued | processing | completed | failed | cancelled`. Modes (`schema.ts:29-38`): `text_to_image | image_to_image | text_to_video | image_to_video | video_to_video | video_extension | scene_continuation | reference_guided`.

### `GET /api/generations` — `src/app/api/generations/route.ts:23-28`
- Auth: member. Query `listQuery` (lines 10-21): `active="1"`, `media=image|video`, `status=queued|processing|completed|failed|cancelled`, `favorites="1"`, `projectId` uuid, `templateId` uuid, `modelKey` ≤60, `folderId` uuid, `sort=newest|oldest`, `offset` int ≥0 (no max). No `limit` param; hard default 60 (`views.ts:59`).
- `listCreations` (`views.ts:40-62`): always excludes `awaiting_confirmation`/`draft` unless `active=1` (which restricts to queued/processing). `media=video` matches modes containing "video" or `scene_continuation`.
- 200 `{ items: CreationListItem[] }`. Bad query → 422.

### `POST /api/generations` (create draft) — `route.ts:30-36`
- Auth: member. Rate limit `draft:<userId>` 30 / 60 s → 429 "Slow down a little and try again in a minute."
- Body `draftSchema` (`service.ts:59-73`): `idempotencyKey` (8–100, required), `mode` (enum above), `modelKey` (1–60), `prompt` (trim, 1–2000), `negativePrompt` (≤1000, default ""), `params` (strict object, default `{}`: `aspectRatio` `^\d{1,2}:\d{1,2}$`, `durationS` 1–60, `quality` `hd|4k`, `motionIntensity` 1–10, `cameraMovement` ≤40, `pacing` ≤40, `atmosphere` ≤80, `lighting` ≤40, `framing` ≤40, `seed` 0–2147483647), `inputAssetIds` uuid[] ≤2 (default []), optional `templateId`, `characterReferenceId`, `projectId`, `sceneId`, `parentJobId` (uuids), `relation` `retry|variation|remix|continuation|extension`.
- `createDraft` (`service.ts:145-273`) in order:
  1. Same `(userId, idempotencyKey)` already exists → returns that row (still **201**).
  2. Strict-region self-declared user → **451 `age_assurance_required`**.
  3. Unknown model → 422 `unknown_model`; model not available → **503 `model_unavailable`** (message includes the provider reason).
  4. `validateAgainstModel` issues → 422 `unsupported_settings` with `details.issues: [{ field, message }]`.
  5. `checkPrompt(prompt, negativePrompt, params.atmosphere)` (`policy.ts:60-73`) → on block writes a resolved `moderation_events` row (`auto_block`) and throws **422 `policy_blocked`** with `details.category` ∈ `minors|non_consent|real_person|bestiality|incest|extreme_harm`.
  6. `validateInputs` (`service.ts:104-143`): any asset not owned/undeleted → 404; upload without active consent → 403 `consent_required`; counts vs `MODE_INPUTS` → 422 `input_required` / 422 `input_unexpected`.
  7. Character ref: not owned → 404; consent withdrawn → 403 `consent_withdrawn`; `reference_guided` without one → 422 `input_required`.
  8. Template: must be published or own → 404; VIP template without an active VIP plan → **403 `vip_required`**.
  9. `projectId` not owned → 404; `sceneId` without `projectId` → 422 `invalid_input`; scene not in project → 404; `parentJobId` not owned → 404.
  10. Seed auto-filled when the model supports it; `costCredits = estimateCost(...)` (`registry.ts:181-192`: image `pricing.imageBase`, video `pricing.videoPerSecond * durationS`, × quality multiplier × admin `priceMultiplierPct`/100, min 1).
  11. Insert with `onConflictDoNothing`; on a lost race returns the winner.
- Success **201 `{ job: <raw generation_jobs row> }`** with `status: "awaiting_confirmation"`, `costCredits` set. The client must echo `costCredits` as `expectedCost` to confirm.
- Possible codes: 400, 401, 403 (`bad_origin`, `consent_required`, `consent_withdrawn`, `vip_required`), 404, 422 (`invalid_input`, `unknown_model`, `unsupported_settings`, `policy_blocked`, `input_required`, `input_unexpected`), 429, 451, 503, 500.

### `GET /api/generations/[id]` — `src/app/api/generations/[id]/route.ts:8-14`
- Auth: member. Explicit guard `^[0-9a-f-]{36}$` before the query (line 11); non-matching or not owned/deleted → 404. 200 `{ job: CreationListItem }`.

### `DELETE /api/generations/[id]` — `route.ts:16-20`
- Auth: member. `deleteJob` (`service.ts:415-432`): not owned → 404; status `queued`/`processing` → **409 `job_active`** "Cancel this creation before deleting it."; otherwise soft-deletes outputs, output + poster assets, the job, audit `creation.delete`. 200 `{ ok: true }`. Files purged by retention job later.

### `POST /api/generations/[id]/confirm` — `src/app/api/generations/[id]/confirm/route.ts`
- Auth: member. Body `{ expectedCost: int ≥0 }`.
- `confirmJob` (`service.ts:276-323`) in one transaction with `FOR UPDATE`: not owned → 404; status ≠ `awaiting_confirmation` → returns the job unchanged (idempotent, 200, no cost check); `costCredits !== expectedCost` → **409 `cost_changed`** with `details.cost`; active (queued+processing) count ≥ `max(USER_MAX_ACTIVE_JOBS (default 3), plan.maxActiveJobs)` → **429 `too_many_active`**; `reserveForJob` (ledger `reserve`, key `job:<id>:reserve`) → **402 `insufficient_credits`** `{ needed, available }` when short; status → `queued`, `queuedAt` set; if `sceneId`, inserts `scene_versions` (branch `alternate` for `variation`, else `main`); if `templateId`, inserts `discovery_events` `generate`. After commit, `enqueueGeneration(jobId)` on BullMQ.
- Success 200 `{ job: <raw row> }`.

### `POST /api/generations/[id]/cancel` — `src/app/api/generations/[id]/cancel/route.ts`
- Auth: member. No body. `cancelJob` (`service.ts:325-354`): not owned → 404; `draft`/`awaiting_confirmation` → `cancelled`; `queued` → `releaseJob` (ledger `release`, key `job:<id>:close`) then `cancelled` with `failureCode: "cancelled"`; `processing` → only sets `cancelRequested = true` (the worker aborts and releases); terminal states → returned unchanged. Always 200 `{ job: <raw row> }`.

### `POST /api/generations/[id]/derive` — `src/app/api/generations/[id]/derive/route.ts`
- Auth: member. Body `{ relation: "retry"|"variation"|"continuation"|"extension", idempotencyKey: string(8–100) }` (lines 7-10). Note `remix` is accepted by `draftSchema` but **not** by this route.
- `deriveDraft` (`service.ts:357-403`): source not owned/deleted → 404; `variation` gets a fresh seed; `continuation`/`extension` require a finished **video** output → else 422 `unsupported`, and switch mode to `scene_continuation` / `video_extension` with the output as the single input; then runs `createDraft` with `parentJobId = source` (so all `createDraft` errors apply, including 451 and the `draft:` rate limit is **not** applied here).
- Success **201** `{ job: <raw row> }`.

### `GET /api/generations/[id]/download` — `src/app/api/generations/[id]/download/route.ts`
- Auth: member. Not owned → 404; no undeleted output → 404; `assetUrl(asset, userId, { download: "hushloom-<first 8 of job id>[-demo].<mp4|webp>" })` null (deleted or not viewer's) → 404.
- Success **302** `Location: <signed URL>` resolved against `req.nextUrl.origin` (line 23). Local driver → `/api/media?...&d=...`; S3 → presigned URL with `ResponseContentDisposition`.

---

## 6. Templates and discovery

Template status enum (`schema.ts:28`): `draft | published | unpublished | removed`.

### `GET /api/templates` — `src/app/api/templates/route.ts:19-23`
- Auth: **anon** (viewer id optional via `getCurrentUser()`).
- Query (lines 9-17): `q` ≤100, `category` ≤40 (slug), `media=image|video`, `sort=trending|new|top_rated|most_favorited` (default trending), `creatorId` uuid, `offset` 0–10000, `limit` 1–60 (default 24). `browseTemplates` (`src/server/discovery/templates.ts:142-165`): published + undeleted only; `q` does ILIKE on title, description, creator handle and tags (with `%`/`_` escaped); fetches `limit+1` to compute `hasMore`.
- 200 `{ items: TemplateCard[], hasMore: boolean }`. `TemplateCard` (`discovery/templates.ts:17-38`): `{ id, slug, title, creator: { id, handle, displayName }, category, mediaType, mode, durationS, isVip, quality, isNew, posterUrl, previewUrl, posterWidth, posterHeight, favoriteCount, generationCount, rating (1-decimal avg or null), isFavorited, tags }`. Poster/preview URLs are signed public URLs (1 h TTL).
- Rate limit: none. Bad query → 422.

### `POST /api/templates` (publish) — `route.ts:25-30`
- Auth: member. Body `publishSchema` (`src/server/templates/publish.ts:22-29`): `jobId` uuid, `title` (trim 2–60), `description` (≤500, default ""), `categorySlug` ≤40 optional, `tags` (≤8, each trim+lowercase 1–24, default []), `isVip` (default false).
- `publishTemplate` (`publish.ts:41-131`): job not owned → 404; status ≠ `completed` → **409 `not_ready`**; job has `inputAssetIds` or `characterReferenceId` → **403 `personal_media`** (consent boundary); `checkPrompt(title, description, tags, job.prompt)` → 422 `policy_blocked` (+ moderation row); no output → 409 `no_output`. Copies output bytes (and poster) to new **public** `media_assets` under `templates/<userId>/…`; inserts `templates` (status `published`, slug `<title-slug>-<5 random>`, `remixedFromId = job.templateId`), `template_versions` v1 (prompt, negative prompt, model, params minus seed, changelog "First version"); promotes role `member` → `creator`; upserts `creator_profiles`; audit `template.publish`.
- Success **201** `{ template: <raw templates row> }`.
- No rate limit. Tested `platform.test.ts:177-219`.

### `PATCH /api/templates/[id]` — `src/app/api/templates/[id]/route.ts`
- Auth: member (owner) **or admin** (`publish.ts:148`). Body `updateTemplateSchema` (`publish.ts:133-142`), all optional: `title` 2–60, `description` ≤500, `tags` ≤8, `categorySlug` ≤40, `isVip`, `status: published|unpublished`, `prompt` 1–2000, `changelog` ≤200.
- Not found / not owner & not admin → 404; status `removed` → **403 `removed`**; policy check on title/description/tags/prompt → 422 `policy_blocked`; a changed `prompt` creates `template_versions` v+1 and bumps `currentVersion`; `status: published` sets `publishedAt` if unset; audit `template.update`.
- 200 `{ template: <raw row> }`. `[id]` must be the uuid (not the slug) here; `templateForViewer` slug handling is only used by rate/report.

### `POST /api/templates/[id]/rate` — `src/app/api/templates/[id]/rate/route.ts`
- Auth: member. Body `{ score: int 1–5 }`. `[id]` may be uuid **or slug** (`templates/queries.ts:5-15`). Template not visible or not `published` → 404 (line 11). Upserts `template_ratings` on `(user_id, template_id)` and recomputes `rating_sum`/`rating_count` from source rows (`publish.ts:196-210`). 200 `{ ok: true }`. No self-rating guard. No rate limit.

### `POST /api/templates/[id]/report` — `src/app/api/templates/[id]/report/route.ts`
- Auth: member. Rate limit `report:<userId>` 20 / 3600 s → 429 "Report limit reached for now."
- Body `{ reason: "minor"|"non_consent"|"real_person"|"illegal"|"spam"|"other", note: string(≤1000, default "") }` (line 14). `[id]` uuid or slug; invisible → 404 (own unpublished templates are visible to the owner and can be reported).
- Inserts `moderation_events` `{ subjectType: "template", action: "report", status: "open", reporterId, reason, details: { note } }`. Success **201** `{ ok: true }`.

---

## 7. Social

### `POST /api/favorites` / `DELETE /api/favorites` — `src/app/api/favorites/route.ts`
- Auth: member. Body (both) `{ targetType: "template"|"creation", targetId: uuid }` (line 6). DELETE carries a JSON body.
- `setFavorite` (`src/server/social.ts:6-22`): template must be published+undeleted, creation must be the caller's own job → else 404. Insert `onConflictDoNothing` / delete; template `favorite_count` recomputed from `favorites`. 200 `{ ok: true }` for both.

### `POST /api/follows` / `DELETE /api/follows` — `src/app/api/follows/route.ts`
- Auth: member. Body `{ creatorId: uuid }`. `setFollow` (`social.ts:24-30`): self → **422 `self_follow`**; creator not `active` → 404. Idempotent insert/delete. 200 `{ ok: true }`.

---

## 8. Library organisation: folders and presets

### `GET /api/folders` — `src/app/api/folders/route.ts:6-9`
- Auth: member. 200 `{ folders: <raw folders rows ordered by name> }`.

### `POST /api/folders` — `route.ts:11-15`
- Auth: member. Body `{ name: string(trim 1–40) }`. **201** `{ folder: <raw row> }`. No per-user cap.

### `DELETE /api/folders/[id]` — `src/app/api/folders/[id]/route.ts`
- Auth: member. Hard delete of the owned folder (404 otherwise). 200 `{ ok: true }`.

### `POST /api/folders/[id]/items` — `src/app/api/folders/[id]/items/route.ts`
- Auth: member. Body `{ jobIds: uuid[] (1–100) }`. Folder not owned → 404. Adds the undeleted outputs of the caller's jobs; ids that are not the caller's are silently skipped (`src/server/folders.ts:21-30`). 200 `{ added: number }`. There is no remove-from-folder route.

### `GET /api/presets` — `src/app/api/presets/route.ts:5-8`
- Auth: member. 200 `{ presets: <raw saved_presets rows, newest first, ≤100> }`.

### `POST /api/presets` — `route.ts:10-14`
- Auth: member. Body `presetSchema` union (`src/server/presets.ts:11-20`): either `{ name (1–40), fromJobId: uuid }` or `{ name, mode (enum), modelKey (1–60), prompt (≤2000, default ""), params (paramsSchema, default {}) }`.
- `createPreset` (`presets.ts:33-51`): `fromJobId` not owned → 404; copies mode/model/prompt/params **minus seed**; manual form with unknown model → 422 `unknown_model`; 100th preset → 422 `limit_reached`. **201** `{ preset: <raw row> }`. Tested `platform.test.ts:356`.

### `DELETE /api/presets/[id]` — `src/app/api/presets/[id]/route.ts`
- Auth: member. Hard delete, 404 when not owned. 200 `{ ok: true }`.

---

## 9. Projects and scenes (Studio)

### `GET /api/projects` — `src/app/api/projects/route.ts:5-8`
- Auth: member. 200 `{ projects: [{ id, title, description, updatedAt: ISO, scenes: number, clips: number, cover: { kind, url, posterUrl } | null }] }` (`src/server/projects.ts:70-111`).

### `POST /api/projects` — `route.ts:10-14`
- Auth: member. Body `projectSchema` (`projects.ts:19-22`): `title` (trim 1–80), `description` (≤500, default ""). Creates the project plus a first scene "Opening" at position 0. **201** `{ project: <raw row> }`.

### `GET /api/projects/[id]` — `src/app/api/projects/[id]/route.ts:7-10`
- Auth: member. Not owned/deleted → 404. 200 `{ project: { id, title, description, updatedAt }, scenes: SceneDetail[], loose: CreationListItem[] }` where `SceneDetail = { id, position, title, continuity, versions: [{ id, parentVersionId, branchLabel, isSelected, createdAt, creation: CreationListItem }] }` (`projects.ts:30-38, 137-168`).

### `PATCH /api/projects/[id]` — `route.ts:12-16`
- Auth: member. Body `projectPatchSchema` = `projectSchema.partial()`. 404 when not owned. 200 `{ project: <raw row> }`.

### `DELETE /api/projects/[id]` — `route.ts:18-22`
- Auth: member. Soft delete (`deleted_at`); creations stay in the library. 200 `{ ok: true }`.

### `POST /api/projects/[id]/scenes` — `src/app/api/projects/[id]/scenes/route.ts:8-12`
- Auth: member. Body `sceneSchema` (`projects.ts:24-27`): `title` (1–80), optional `continuity` (strict: `lighting` ≤40, `framing` ≤40, `palette` ≤80, `characterReferenceId` uuid, `notes` ≤400). Project not owned → 404; `characterReferenceId` not owned → 404; 50 scenes already → 422 `limit_reached`. New scene inherits the previous scene's continuity when none is given. **201** `{ scene: <raw row> }`.

### `PUT /api/projects/[id]/scenes` (reorder) — `route.ts:15-20`
- Auth: member. Body `{ order: uuid[] (1–50) }`. Must list every scene exactly once → else **422 `invalid_order`**. 200 `{ ok: true }`.

### `PATCH /api/scenes/[id]` — `src/app/api/scenes/[id]/route.ts:7-11`
- Auth: member (ownership through the parent project, `projects.ts:49-57`). Body `scenePatchSchema` (title/continuity optional). 200 `{ scene: <raw row> }`.

### `DELETE /api/scenes/[id]` — `route.ts:13-17`
- Auth: member. Hard delete and renumber positions. 200 `{ ok: true }`. No guard against deleting the last scene.

### `POST /api/scenes/[id]/select` — `src/app/api/scenes/[id]/select/route.ts`
- Auth: member. Body `{ versionId: uuid }`. Version not in this scene or job deleted → 404; job not `completed` → **409 `not_ready`**. Marks exactly one version selected. 200 `{ ok: true }`.

---

## 10. Payments

### `POST /api/checkout` — `src/app/api/checkout/route.ts`
- Auth: member. Order of checks: `paymentsConfigured()` (needs **both** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, `src/server/payments/stripe.ts:12-14`) → else **503 `payments_unavailable`**; rate limit `checkout:<userId>` 10 / 600 s → 429; body `{ itemKey: string(≤40) }`.
- `createCheckout` (`stripe.ts:22-49`): key must match `pricing.packs[].key` or `pricing.plans[].key` (`src/config/pricing.ts`) → else 422 `unknown_item`; creates a Stripe Checkout Session (`mode: payment|subscription`, `metadata: { userId, itemKey }`, success/cancel URLs under `APP_URL/pricing`); no URL → **502 `checkout_failed`**.
- 200 `{ url: string }`. Never exercised live (plan.md "Known defects").

### `POST /api/webhooks/stripe` — `src/app/api/webhooks/stripe/route.ts`
- Auth: **Stripe signature**; exempt from the origin check. Reads raw text body; `verifyStripeEvent` (`stripe.ts:52-62`): secret unset → 503 `payments_unavailable`; missing `stripe-signature` → 400 `bad_signature` "Missing signature."; invalid → 400 `bad_signature` "Invalid signature."
- `processStripeEvent` (`stripe.ts:79-159`): inserts `payment_events (provider='stripe', provider_event_id)` with `onConflictDoNothing` → duplicate returns `"duplicate"` without side effects. Handles `checkout.session.completed` (pack → ledger `purchase` keyed `stripe:<event.id>`; plan → upsert `subscriptions` active), `invoice.paid` (ledger `subscription_grant` keyed `stripe-invoice:<invoice.id>`; **throws a plain Error → 500** when the subscription is not yet known so Stripe retries), `customer.subscription.updated|deleted` (status + `current_period_end`); other types → `"ignored"`. Sets `processed_at`, audit `payment.<type>`.
- 200 `{ received: true, outcome: "processed"|"duplicate"|"ignored" }`. Tested `platform.test.ts:74-131` with a locally generated signature.

---

## 11. Provider webhooks

### `POST /api/webhooks/replicate` — `src/app/api/webhooks/replicate/route.ts`
- Auth: **Standard-Webhooks HMAC** (`verifyReplicateWebhook`, `src/server/ai/providers/replicate.ts:126-144`): headers `webhook-id`, `webhook-timestamp` (±300 s), `webhook-signature` (`v1,<base64>` space-separated list); HMAC-SHA256 over `id.timestamp.body` with the base64 secret after `whsec_`. Exempt from the origin check.
- `REPLICATE_WEBHOOK_SECRET` unset → 503 `webhook_unconfigured`; bad signature → 400 `bad_signature`; non-JSON body → 400 `invalid_json`.
- Effect: looks up `generation_jobs.provider_job_id = prediction.id` and **only logs**; never changes job state or credits (comment lines 10-14; the worker polls). 200 `{ received: true }`. Never run against the real service (plan.md).

---

## 12. Admin

All four: `requireAdmin()` → 401 when signed out, **404** when not admin. No rate limits. Audit rows written for each action. There are no admin GET routes; admin pages are server-rendered from `src/server/admin.ts` (`adminStats`, `moderationQueue`, `modelsForAdmin`, `recentAudit`).

### `POST /api/admin/credits` — `src/app/api/admin/credits/route.ts`
- Body `adjustSchema` (`admin.ts:172-177`): `account` (trim 3–200; email or handle, leading `@` stripped, case-insensitive), `amount` (int −100000..100000, non-zero), `reason` (trim 3–200), `idempotencyKey` (8–100).
- `adjustCredits` (`admin.ts:180-201`): no such active account → 404 `not_found` "No account with that email or handle."; ledger `admin_adjust` with key `admin:<adminId>:<idempotencyKey>`; negative amounts below balance → 402 `insufficient_credits`; audit `credits.adjust` only when applied.
- 200 `{ handle, applied: boolean, available: number, reserved: number }`. Tested `platform.test.ts:283`.

### `PATCH /api/admin/models/[key]` — `src/app/api/admin/models/[key]/route.ts`
- Body `modelConfigSchema` (`admin.ts:160`): `enabled?: boolean`, `priceMultiplierPct?: int 10–1000`. Unknown model key (not in `MODELS`, `registry.ts:78`) → 404. Upserts `model_configs` (`priceMultiplierPct` → column `price_multiplier`), audit `model.configure`. 200 `{ ok: true }`.

### `POST /api/admin/reports/[id]` — `src/app/api/admin/reports/[id]/route.ts`
- Body `resolveSchema` (`admin.ts:106`): `action: "remove"|"dismiss"`, `note` (≤500, default ""). Event missing → 404; already resolved → **409 `already_resolved`**; `remove` on subject type other than `template`/`output` → 422 `unsupported`. `remove` sets template `removed` (or soft-deletes the output + asset) and resolves **every** open report on that subject; `dismiss` resolves only this one. Inserts a second `moderation_events` row recording the action; audit `moderation.<action>`. 200 `{ ok: true }`. Tested `platform.test.ts:205`.

### `POST /api/admin/users/[id]/suspend` — `src/app/api/admin/users/[id]/suspend/route.ts`
- Body `{ reason: string(trim 3–200) }`. Only `status='active'` users → else 404 (so suspending twice is 404). Destroys all sessions, audit `user.suspend`. 200 `{ ok: true }`. No unsuspend route.

---

## 13. Quick reference matrix

| Method | Path | Auth | Rate limit (bucket, n/window) | Success | Notable error codes |
| --- | --- | --- | --- | --- | --- |
| GET | /api/health | anon | – | 200/503 `{ok,checks}` | – |
| GET | /api/media | signature | – | 200/206 bytes | 403 forbidden, 404, 416 |
| POST | /api/age-gate | anon | – | 200 `{ok}` + cookie | 422 |
| POST | /api/auth/signup | anon | signup:ip 10/1h | 201 `{ok}` + cookie | 403 underage, 409 email_taken/handle_taken, 429 |
| POST | /api/auth/login | anon | login:ip 30/15m, login:email 10/15m | 200 `{ok}` + cookie | 401 bad_credentials, 429 |
| POST | /api/auth/logout | anon | – | 200 `{ok}` | – |
| GET | /api/me | member | – | 200 settings | – |
| PATCH | /api/me | member | – | 200 `{ok}` | 409 handle_taken |
| DELETE | /api/me | member | – | 200 `{ok}` | 403 bad_password |
| PATCH | /api/me/preferences | member | – | 200 `{ok}` | 422 |
| DELETE | /api/me/history | member | – | 200 `{removed}` | – |
| DELETE | /api/me/sessions | member | – | 200 `{ok}` | – |
| DELETE | /api/me/consents/[id] | member | – | 200 `{ok}` | 404, 422 use_account_deletion |
| POST | /api/uploads | member | upload:user 40/1h | 201 UploadResult | 413 too_large, 415 unsupported_type, 422 consent_required |
| GET | /api/characters | member | – | 200 `{characters}` | – |
| POST | /api/characters | member | character:user 10/1h | 201 `{id,warnings}` | 415, 422 consent_required/limit_reached |
| DELETE | /api/characters/[id] | member | – | 200 `{ok}` | 404 |
| GET | /api/generations | member | – | 200 `{items}` | 422 |
| POST | /api/generations | member | draft:user 30/60s | 201 `{job}` | 402, 403 vip_required/consent_*, 422 policy_blocked/…, 451, 503 model_unavailable |
| GET | /api/generations/[id] | member | – | 200 `{job}` | 404 |
| DELETE | /api/generations/[id] | member | – | 200 `{ok}` | 409 job_active |
| POST | /api/generations/[id]/confirm | member | – | 200 `{job}` | 402 insufficient_credits, 409 cost_changed, 429 too_many_active |
| POST | /api/generations/[id]/cancel | member | – | 200 `{job}` | 404 |
| POST | /api/generations/[id]/derive | member | – (no draft bucket) | 201 `{job}` | 422 unsupported + all createDraft codes |
| GET | /api/generations/[id]/download | member | – | 302 | 404 |
| GET | /api/templates | anon | – | 200 `{items,hasMore}` | 422 |
| POST | /api/templates | member | – | 201 `{template}` | 403 personal_media, 409 not_ready/no_output, 422 policy_blocked |
| PATCH | /api/templates/[id] | owner/admin | – | 200 `{template}` | 403 removed, 404, 422 policy_blocked |
| POST | /api/templates/[id]/rate | member | – | 200 `{ok}` | 404 |
| POST | /api/templates/[id]/report | member | report:user 20/1h | 201 `{ok}` | 404, 429 |
| POST/DELETE | /api/favorites | member | – | 200 `{ok}` | 404 |
| POST/DELETE | /api/follows | member | – | 200 `{ok}` | 404, 422 self_follow |
| GET | /api/folders | member | – | 200 `{folders}` | – |
| POST | /api/folders | member | – | 201 `{folder}` | 422 |
| DELETE | /api/folders/[id] | member | – | 200 `{ok}` | 404 |
| POST | /api/folders/[id]/items | member | – | 200 `{added}` | 404 |
| GET | /api/presets | member | – | 200 `{presets}` | – |
| POST | /api/presets | member | – | 201 `{preset}` | 404, 422 unknown_model/limit_reached |
| DELETE | /api/presets/[id] | member | – | 200 `{ok}` | 404 |
| GET | /api/projects | member | – | 200 `{projects}` | – |
| POST | /api/projects | member | – | 201 `{project}` | 422 |
| GET | /api/projects/[id] | member | – | 200 detail | 404 |
| PATCH | /api/projects/[id] | member | – | 200 `{project}` | 404 |
| DELETE | /api/projects/[id] | member | – | 200 `{ok}` | 404 |
| POST | /api/projects/[id]/scenes | member | – | 201 `{scene}` | 404, 422 limit_reached |
| PUT | /api/projects/[id]/scenes | member | – | 200 `{ok}` | 422 invalid_order |
| PATCH | /api/scenes/[id] | member | – | 200 `{scene}` | 404 |
| DELETE | /api/scenes/[id] | member | – | 200 `{ok}` | 404 |
| POST | /api/scenes/[id]/select | member | – | 200 `{ok}` | 404, 409 not_ready |
| POST | /api/checkout | member | checkout:user 10/10m | 200 `{url}` | 422 unknown_item, 502 checkout_failed, 503 payments_unavailable |
| POST | /api/webhooks/stripe | Stripe sig | – | 200 `{received,outcome}` | 400 bad_signature, 503 |
| POST | /api/webhooks/replicate | HMAC sig | – | 200 `{received}` | 400 bad_signature/invalid_json, 503 webhook_unconfigured |
| POST | /api/admin/credits | admin | – | 200 `{handle,applied,available,reserved}` | 402, 404 |
| PATCH | /api/admin/models/[key] | admin | – | 200 `{ok}` | 404 |
| POST | /api/admin/reports/[id] | admin | – | 200 `{ok}` | 404, 409 already_resolved, 422 unsupported |
| POST | /api/admin/users/[id]/suspend | admin | – | 200 `{ok}` | 404 |

Origin check applies to every `POST/PUT/PATCH/DELETE` row except the two `/api/webhooks/*` rows.

---

## 14. Defects and observations (verified unless marked)

**D1 — Inconsistent job payloads (low).** `POST /api/generations`, `/confirm`, `/cancel`, `/derive` return the raw `generation_jobs` row (`service.ts:31`, every handler `NextResponse.json({ job })`), which includes `providerJobId`, `idempotencyKey`, `inputAssetIds`, `characterReferenceId`, `failureCode`, `cancelRequested`, `templateVersion`, `deletedAt`. `GET /api/generations/[id]` returns the different `CreationListItem` shape (`views.ts:6-24`), with no `output.url` on the raw row and no `providerJobId` on the hydrated one. Clients must handle two shapes for the same resource. Owner-only, so not a cross-user leak.

**D2 — IP rate-limit keys collapse to `"local"` without a proxy (medium).** `auth/login/route.ts:10` and `auth/signup/route.ts:8` use `x-forwarded-for` and fall back to the constant `"local"`. Next.js does not populate that header itself (*Inference*), so a deployment that exposes the standalone server directly shares one `signup:local` bucket of 10 sign-ups per hour and one `login:ip:local` bucket of 30 attempts per 15 minutes across all visitors. Conversely, when the header is honoured it is spoofable unless a trusted proxy overwrites it.

**D3 — Login limiter counts successful logins and short-circuits (low).** `login/route.ts:11`: both buckets are incremented on every attempt including successes; 10 logins with the same email in 15 minutes yields 429. The `&&` means the email bucket is not incremented once the IP bucket is exhausted.

**D4 — Uploads are fully buffered before size checks (medium).** `/api/uploads` and `/api/characters` call `req.formData()` then `file.arrayBuffer()` (`uploads/route.ts:12-18`, `characters/route.ts:14-22`); the 20 MB / 100 MB limits in `media.ts:50,56` apply after the whole body is in memory. No `Content-Length` pre-check. A malformed multipart body throws a non-HttpError and surfaces as 500 `internal`.

**D5 — `/api/media` reads whole files into memory for every request, including Range requests (medium).** `media/route.ts:23` `storage().get(key)` returns a `Buffer` (local `readFile`, `storage/index.ts:51-53`); a 100 MB clip is read fully for each 206 chunk. The route is also unwrapped, so an on-disk miss (`ENOENT` after a DB row exists) is a Next default 500 rather than the JSON envelope.

**D6 — `derive` bypasses the draft rate limit (low).** `derive/route.ts` has no `rateLimit`, while `POST /api/generations` is limited to `draft:<user>` 30/60 s. Both end in `createDraft`.

**D7 — Replicate webhook is log-only (known, documented).** `webhooks/replicate/route.ts:31-35`. Matches plan.md "Known defects".

**D8 — `remix` relation accepted by `draftSchema` but not by `/derive` (low).** `service.ts:72` vs `derive/route.ts:8`. Remix is reachable only through `POST /api/generations` with `relation: "remix"` + `templateId`.

**D9 — Reports/ratings have no self checks (low).** A creator can rate their own template (`rate/route.ts`) and report their own unpublished template (`report/route.ts:16-17` uses `templateForViewer`, which shows owners their own drafts).

**D10 — Scene deletion can leave a project with zero scenes (low).** `projects.ts:197-205` has no minimum-scene guard; `createProject` always creates one.

**D11 — Origin check depends on `process.env.APP_URL` literally (low).** `middleware.ts:13` does not use the `env()` default; behind a proxy with `APP_URL` unset only `req.nextUrl.origin` (the internal host) is accepted, which may 403 legitimate browser writes. Requests without an `Origin` header are never blocked (by design per the comment on lines 8-9; `SameSite=Lax` is the primary defence).

**D12 — Existing idempotent draft returns 201 (cosmetic).** `createDraft` returns the earlier row (`service.ts:147-151`) and the route still answers 201.

---

## 15. Gaps relative to the spec (`ctx/spec.md`)

| Spec item | Status | Evidence |
| --- | --- | --- |
| "API contracts" (Part E deliverable) | missing in repo | no `docs/` API doc exists on the branch; this file is the first inventory (plan.md Remaining work #2) |
| Credit balance / ledger / purchase history via API | not exposed | no route reads `creditAccounts`/`creditLedger`/`paymentEvents`; `GET /api/me` omits balance (`me.ts:40-59`); balance only via server components |
| Age assurance for strict jurisdictions | partial | 451 refusal only (`service.ts:153-159`); no verification provider or endpoint; message says "not available yet in this build" |
| Creator profile / follow feed / For-You / categories via API | not exposed | `profileByHandle`, `forYou`, `followingFeed`, `listCategories` exist in `social.ts`/`discovery/templates.ts` but are only used by server components |
| Remove item from folder, rename folder | missing | `folders.ts` has no remove/rename; only add (`addToFolder`) and delete folder |
| Unsuspend user, admin user search, admin GET endpoints | missing | only four admin mutations; admin reads are server-rendered |
| Avatar upload, `template_media` upload | missing | `upload_purpose` enum (`schema.ts:66`) includes `avatar`/`template_media` but no route uses them |
| `training_data` consent | missing | `consent_kind` enum includes it (`schema.ts:57-63`); nothing writes it |
| Provider webhook driving job state | demo-only | Replicate webhook logs only; worker polling is the real path |
| Stripe checkout live | untested | returns 503 until keys set; webhook tests use a local fake secret |
| Copilot (prompt assistance provider) via API | missing | `src/lib/copilot.ts` is client-side rules; no server route |
| `Retry-After` on 429 | missing | all 429s are JSON only |

Test coverage touching routes directly: `tests/integration/platform.test.ts` (stripe webhook, media route, admin credits, consent, publishing, projects, presets) and `tests/e2e/journey.spec.ts` (signup, admin grant, draft → confirm → Ready, cross-user 404, forged media 403, cross-origin 403, under-18, blocked prompt). Routes with no direct test found: `/api/me/*`, `/api/favorites`, `/api/follows`, `/api/folders/[id]/*`, `/api/templates/[id]/rate|report`, `/api/checkout`, `/api/webhooks/replicate`, `/api/admin/models`, `/api/admin/users/*/suspend`, `/api/generations/[id]/download`, `/api/scenes/*` (projects test exercises the service, not the HTTP layer).
