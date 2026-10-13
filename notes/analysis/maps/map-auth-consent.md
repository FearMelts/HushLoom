# Hushloom: auth, sessions, consent, age assurance, origin checks, rate limits

Read-only map of `/home/claude/hushloom` on branch `claude/playbox-2-foundation-q7fpbs`. Everything under "Verified" was read directly from source; "Inferences" are conclusions drawn from the code, not confirmed by running it. Tests were not run (they are running in the background).

Files covered: `src/server/auth/session.ts`, `src/server/auth/account.ts`, `src/middleware.ts`, `src/server/request.ts`, `src/server/http.ts`, `src/server/me.ts`, `src/server/env.ts`, `src/server/redis.ts`, `src/server/safety/policy.ts`, `src/server/generation/service.ts`, `src/server/media.ts`, `src/server/characters.ts`, `src/server/admin.ts`, `src/server/storage/index.ts`, `src/app/layout.tsx`, `src/app/auth/page.tsx`, `src/app/api/auth/{login,logout,signup}/route.ts`, `src/app/api/age-gate/route.ts`, `src/app/api/me/**`, `src/app/api/admin/**`, `src/app/api/{uploads,characters,generations,checkout}/route.ts`, `src/app/api/templates/[id]/report/route.ts`, `src/app/api/media/route.ts`, `src/app/admin/page.tsx`, `src/components/{age-gate,auth-forms,settings}.tsx`, `src/server/db/schema.ts`, `next.config.ts`, `tests/**`.

---

## 1. Sessions and cookies (verified)

### Cookie `hl_session`
- Constant `SESSION_COOKIE = "hl_session"` at `src/server/auth/session.ts:10`.
- Set by `setSessionCookie()` (`session.ts:40-48`) with: `httpOnly: true`, `sameSite: "lax"`, `secure: env().NODE_ENV === "production"`, `path: "/"`, `expires: expiresAt` (a persistent cookie, not a session cookie).
- Value is the raw 32-byte random token, base64url (`randomBytes(32).toString("base64url")`, `session.ts:34`). The DB stores only `sha256(token)` hex in `sessions.token_hash` (`hashToken`, `session.ts:29-31`; schema `src/server/db/schema.ts:101-112`, unique index `sessions_token_uq`, index `sessions_user_idx`).
- No `domain` attribute is set.

### TTL
- `SESSION_TTL_DAYS` env, zod `coerce.number().int().positive().default(30)` (`src/server/env.ts:9`). `expiresAt = now + SESSION_TTL_DAYS * 86_400_000` (`session.ts:35`). Fixed expiry; there is no sliding renewal on use.
- Expired rows are never deleted by any job. `userForToken` filters with `gt(sessions.expiresAt, new Date())` (`session.ts:64`) and `settingsFor` counts only `expires_at > now()` (`src/server/me.ts:35`), so stale rows are harmless but accumulate. (Verified: grep for `sessions` in `src/worker/index.ts` returns nothing.)

### Session lookup
- `userForToken(token)` (`session.ts:50-68`): single query joining `sessions` → `users` → `user_profiles`, requiring `users.status = 'active'` and `users.deleted_at IS NULL`. Returns `SessionUser { id, email, role, handle, displayName, ageAssuranceMethod }`. A suspended or deleted user's existing cookie therefore stops resolving immediately even if the session row still exists.
- `getCurrentUser` (`session.ts:71-75`) is wrapped in React `cache()` so it runs once per request; it reads the cookie via `next/headers` `cookies()`.
- `destroyCurrentSession` (`session.ts:77-82`) deletes the row by token hash and deletes the cookie. `destroyAllSessions(userId)` (`session.ts:84-86`) deletes all rows for the user.

### Session creation points
- `POST /api/auth/signup` (`src/app/api/auth/signup/route.ts:7-15`): rate limit, `parseJson(signupSchema)`, `registerUser`, `createSession`, `setSessionCookie`, returns `201 {ok:true}`.
- `POST /api/auth/login` (`src/app/api/auth/login/route.ts:8-18`): rate limits, `authenticate`, `createSession(user.id, user-agent)`, `setSessionCookie`, returns `200 {ok:true}`. On bad credentials: `401 bad_credentials`.
- `POST /api/auth/logout` (`logout/route.ts:5-8`): `destroyCurrentSession`, `200 {ok:true}`. No auth check needed; idempotent.
- `DELETE /api/me/sessions` (`src/app/api/me/sessions/route.ts:7-14`): `requireUser`, `destroyAllSessions`, audit `sessions.revoke_all`, clears cookie. "Sign out everywhere" including current device.
- Login does not rotate or cap existing sessions; each login adds a row. `userAgent` is stored truncated to 300 chars (`session.ts:36`).

### Password hashing
- bcryptjs, cost 12: `bcrypt.hash(password, 12)` (`session.ts:21-23`); `verifyPassword` = `bcrypt.compare` (`session.ts:25-27`). `bcryptjs` is in `serverExternalPackages` in `next.config.ts:15`.
- `authenticate()` (`account.ts:99-108`) looks up by `lower(email)` with `status='active'` and `deleted_at IS NULL`, then always runs `bcrypt.compare` against either the real hash or a lazily-computed module-level `dummyHash` (`account.ts:97,105`) so a missing account costs the same time as a wrong password.
- Signup password policy: `z.string().min(10).max(200)` (`account.ts:33`). No complexity rules, no breach check. Login accepts `password: z.string().max(200)` with no min (`login/route.ts:9`).
- Account deletion overwrites `passwordHash` with `"!"` (`account.ts:160`), which bcrypt will never match.
- There is no password change or password reset route anywhere under `src/app/api` (verified by grep for `passwordHash` in routes: only `me/route.ts` via `deleteAccount`).

---

## 2. Authorization helpers (verified)

`src/server/http.ts`:
- `requireUser()` (`:23-27`): `getCurrentUser()` or throw `401 unauthorized` ("Sign in to continue.").
- `requireAdmin()` (`:29-33`): `requireUser()` then `user.role !== "admin"` → throw **404 `not_found`**, not 403. Comment at `:20`: "Not found and not-yours look identical, so ids of private content are not confirmed to others."
- `forbidden()` exists (`:19`) but is not used by the auth layer.
- `route()` wrapper (`:46-73`) maps `HttpError` → its status; `ZodError` → `422 invalid_input` with `err.flatten()`; `InsufficientCreditsError` → `402 insufficient_credits`; Postgres `22P02` (malformed uuid, searched up to 3 `cause` levels) → `404 not_found`; anything else → `500 internal` and `logger.error`.

### Roles
- Enum `user_role` = `member | creator | admin` (`schema.ts:24`); `users.role` defaults to `member` (`schema.ts:76`). Enum `user_status` = `active | suspended | deleted` (`schema.ts:25`).
- Admin is purely `users.role === "admin"`. Checked in:
  - `requireAdmin()` for `POST /api/admin/credits`, `POST /api/admin/users/[id]/suspend`, `PATCH /api/admin/models/[key]`, `POST /api/admin/reports/[id]` (each route file's first line in the handler).
  - `/admin` page: `src/app/admin/page.tsx:32` `if (user?.role !== "admin") notFound();`.
  - Shell nav shows the Admin link only when `user.role === "admin"` (`src/components/shell.tsx:124`).
- There is no route to grant or change a role. The only admin account is created by `scripts/seed.ts:204` (`admin@hushloom.local`). Role promotion is a DB edit. (Inference: nothing in `src/server/admin.ts` touches `users.role`; grep for `role` there returns nothing relevant.)
- `creator` role is defined but I found no code branching on it in the auth layer (not checked beyond grep of auth files; `src/server/templates/publish.ts` and `social.ts` reference `role` and were not read in full).

### Suspension
- `suspendUser(adminId, userId, reason)` (`src/server/admin.ts:203-208`): sets `status='suspended'` only if currently `active` (else 404), then `destroyAllSessions`, then audit `user.suspend`. Combined with the `status='active'` filter in `userForToken` and `authenticate`, a suspended user can neither keep a session nor log in. No unsuspend route found.

### Page-level gating
- Server components redirect anonymous visitors to `/auth?next=...`: `collection`, `collection/[id]`, `projects`, `projects/[id]`, `settings`, `train`, `favorites`, `studio` (e.g. `src/app/settings/page.tsx:11`). Client components push to `/auth?next=` from `create-panel.tsx:192`, `pricing.tsx:22`, `template-card.tsx:39`.
- `/auth` page (`src/app/auth/page.tsx:8-11`): sanitizes `next` (must start with `/` and not `//`), redirects already-signed-in users to `next`. `mode=signin` selects the sign-in tab; default is signup.

---

## 3. Request origin check (verified)

`src/middleware.ts`:
- Matcher: `"/((?!_next/static|_next/image|favicon.ico).*)"` (`:24`), so it runs on pages and all `/api/*`.
- For `pathname.startsWith("/api/")` AND method in `{POST, PUT, PATCH, DELETE}` AND NOT `pathname.startsWith("/api/webhooks/")` (`:10`): reads the `Origin` header. If `origin` is present and differs from both `req.nextUrl.origin` and `new URL(process.env.APP_URL).origin` (`:13-14`), returns `403 { error: { code: "bad_origin", message: "Cross-site request refused." } }` (`:15`).
- If `Origin` is absent, the request passes (`:14` requires `origin &&`). Comment calls it "defense in depth" alongside `SameSite=Lax` cookies.
- Then sets request header `x-pathname` (`:19-21`), overwriting any client-supplied value, which `src/app/layout.tsx:29` reads to decide age-gate exemption for `/policies`.
- Webhooks (`/api/webhooks/stripe`, `/api/webhooks/replicate`) skip the origin check and authenticate by signature instead (`src/app/api/webhooks/stripe/route.ts:8` `verifyStripeEvent`, `replicate/route.ts:19-24` `verifyReplicateWebhook` → `400 bad_signature`).
- `GET` requests are never origin-checked (consistent with Lax cookies; GET handlers are read-only by convention). `Sec-Fetch-Site` is not consulted.
- Browser client `src/lib/api.ts:14-19` uses `fetch(..., { credentials: "same-origin" })`; the browser adds `Origin` automatically on POST.
- Additional headers from `next.config.ts:3-9` on every path: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Robots-Tag: noindex, nofollow`. No CSP, no HSTS.

Tested: `tests/e2e/journey.spec.ts:103` posts to `/api/folders` with `Origin: https://evil.example` and expects 403.

---

## 4. Rate limits (verified)

Implementation `src/server/redis.ts:18-23` `rateLimit(bucket, limit, windowS)`: fixed window, `INCR rl:<bucket>`, `EXPIRE` set only when count is 1, returns `count <= limit`. Not atomic (INCR and EXPIRE are two commands; if the process dies between them the key never expires). No sliding window, no per-user override, no `Retry-After` header on 429.

| Route | Key | Limit / window | 429 code & message |
|---|---|---|---|
| `POST /api/auth/login` (`login/route.ts:10-12`) | `login:ip:<ip>` AND `login:email:<email lowercased>` | 30 / 900 s and 10 / 900 s | `rate_limited` "Too many attempts. Wait 15 minutes and try again." |
| `POST /api/auth/signup` (`signup/route.ts:8-9`) | `signup:<ip>` | 10 / 3600 s | `rate_limited` "Too many sign-ups from here. Try later." |
| `POST /api/uploads` (`uploads/route.ts:11`) | `upload:<userId>` | 40 / 3600 s | "Upload limit reached for this hour." |
| `POST /api/characters` (`characters/route.ts:13`) | `character:<userId>` | 10 / 3600 s | "Character limit reached for this hour." |
| `POST /api/templates/[id]/report` (`report/route.ts:11`) | `report:<userId>` | 20 / 3600 s | "Report limit reached for now." |
| `POST /api/checkout` (`checkout/route.ts:10`) | `checkout:<userId>` | 10 / 600 s | "Too many checkout attempts..." |
| `POST /api/generations` (`generations/route.ts:32`) | `draft:<userId>` | 30 / 60 s | "Slow down a little and try again in a minute." |

- IP is `x-forwarded-for` first entry, else literal `"local"` (`login/route.ts:10`, `signup/route.ts:8`). Without a trusted proxy setting this header, every direct client shares the `local` bucket; behind an untrusted proxy a client can spoof the header. (Inference.)
- Login: the IP bucket is incremented before the email bucket is checked (short-circuit `&&` at `login/route.ts:11`), and both are incremented on every attempt including successful ones. Successful logins are not reset.
- Rate limiting is applied before `parseJson` on signup but after it on login (the login email is needed for the key).
- No rate limit on `/api/age-gate`, `/api/auth/logout`, `/api/me/*` (including `DELETE /api/me` which verifies a password: `me/route.ts:20-27`), or the admin routes. Password-verification on `DELETE /api/me` is therefore brute-forceable only by an already-authenticated session holder (low value).
- Active-job concurrency (`429 too_many_active`, `service.ts:294`) is a plan limit, not a Redis rate limit.

---

## 5. Age assurance (verified)

### Anonymous age gate (notice only)
- Cookie `hl_age_ok`, set by `POST /api/age-gate` (`src/app/api/age-gate/route.ts:5-10`) after `parseJson({confirm: z.literal(true)})`: `httpOnly: true`, `sameSite: "lax"`, `path: "/"`, `maxAge: 30 days`, `secure` in production. Value `"1"`.
- Enforced in the root layout `src/app/layout.tsx:21-34`: `ageOk = Boolean(user) || cookie === "1"`; `gated = !ageOk && !path.startsWith("/policies")`. When gated, the whole page body renders `<AgeGate />` instead of `<Shell>{children}</Shell>`. So every page except `/policies*` shows the interstitial; signed-in users never see it regardless of cookie.
- `src/components/age-gate.tsx:40` says explicitly: "This screen is a notice, not age verification. Creating requires an account with a date of birth." The "Leave" link goes to google.com.
- The gate is applied at the layout (render) level only. API routes are not gated by `hl_age_ok`; anonymous API access is governed by `requireUser` on each route. (Verified: no route reads `hl_age_ok`; grep hits are `layout.tsx` and `age-gate/route.ts` only.) Public GET APIs for template browsing were not reviewed here.
- The POST to `/api/age-gate` is a mutating API call so it goes through the middleware origin check.

### Signup (real enforcement)
- `signupSchema` (`account.ts:31-44`): `email` (trim, lowercase, email), `password` (10–200), `handle` (3–24, `[a-zA-Z0-9_]`), `displayName` (1–40), `dateOfBirth` (`^\d{4}-\d{2}-\d{2}$`), `acceptTerms: z.literal(true)`, `confirmAdult: z.literal(true)`. Both checkbox fields fail zod (→ 422) if false.
- `registerUser` (`account.ts:46-95`): `ageOn(dateOfBirth)` (`policy.ts:77-83`, UTC calendar math) must be finite and ≤ 120 else `422 invalid_input` with `fieldErrors.dateOfBirth`; if `age < ADULT_AGE (18)` → `403 underage` "Hushloom is for adults only." thrown **before** any DB write (comment `:50` "Do not store anything about an underage visitor"). `ageOn` does not validate month/day ranges; `2000-13-45` passes the regex and yields a number.
- On success, in one transaction: `users` row with `dateOfBirth`, `ageAssuranceMethod: "self_declaration"`, `ageAssuredAt: now`; `user_profiles`; `user_preferences`; `credit_accounts`; two `consent_records` (`terms`, `adult_attestation`) with the literal `TERMS_STATEMENT` / `ADULT_STATEMENT` texts (`account.ts:27-29`); optional `signup_grant` ledger movement if `SIGNUP_GRANT_CREDITS > 0` (default 0, `env.ts:26`) with idempotency key `signup:<userId>`; audit `account.create`.
- Unique violations are mapped by regex on the error message: `users_email_uq` → `409 email_taken`, `user_profiles_handle_uq` → `409 handle_taken` (`account.ts:88-94`). Both indexes are on `lower(...)` (`schema.ts:86,99`).
- `users.age_assurance_method` is free `text` (`schema.ts:79`); only `"self_declaration"` is ever written in app code and seed (`scripts/seed.ts:187`).

Tested: `tests/integration/platform.test.ts:255-263` (17-year-old → 403 `underage`, no `users` row); `tests/e2e/journey.spec.ts:107-114` (16-year-old DOB in the UI shows "Hushloom is for adults only." and stays on `/auth`).

### Strict-region 451 path
- Env: `AGE_ASSURANCE_STRICT_REGIONS` (comma-separated country codes, default `""`), `GEO_COUNTRY_HEADER` (default `"x-country-code"`) (`env.ts:29-30`).
- `requestCountry(req)` (`src/server/request.ts:5-7`): reads `req.headers.get(env().GEO_COUNTRY_HEADER)`, first 2 chars uppercased, or `null`. The header is trusted as-is; nothing strips a client-supplied `x-country-code`. (Inference: a client can set it to force a 451 on itself, or, if a strict region is configured and the edge does not overwrite the header, omit it to bypass the block.)
- `ageAssuranceBlocksRegion(method, country, strictRegions)` (`policy.ts:90-97`): false if no country; true only when the country is in the list AND `method === "self_declaration"`.
- Only call site: `createDraft` in `src/server/generation/service.ts:153-159`, after the idempotency replay check (`:145-151`) and before model/policy checks. Throws `HttpError(451, "age_assurance_required", "Your region requires verified age assurance before creating. Verification is not available yet in this build.")`. Only `POST /api/generations` passes the country (`generations/route.ts:34` `{ country: requestCountry(req) }`).
- Not checked at signup, login, upload, character creation, confirm, or derive. Browsing and uploading from a strict region are allowed; only creating a new draft is blocked. (Verified by grep: `requestCountry` is imported only in `generations/route.ts`.)
- No test exercises the 451 path (grep for `451` in `tests/` returns nothing).

---

## 6. Consent (verified)

### Schema
`consent_records` (`schema.ts:131-143`): `id`, `user_id` (FK cascade), `kind` enum `consent_kind` = `terms | adult_attestation | upload_subject | likeness | training_data` (`schema.ts:57-63`), `statement text`, `subject_label text null`, `granted_at` default now, `withdrawn_at null`. Index on `(user_id, kind)`. Withdrawal is a timestamp, never a row delete (except via user FK cascade).

Linked from: `uploads.consent_record_id` (`media.ts:86`), `character_references.consent_record_id` (`characters.ts:50`).

### What each kind gates

| kind | Created at | Statement | What it gates |
|---|---|---|---|
| `terms` | signup (`account.ts:71`) | `TERMS_STATEMENT` (`account.ts:27`) | Nothing is checked against it later. Cannot be withdrawn via API (`422 use_account_deletion`, `account.ts:119-121`); only `deleteAccount` sets `withdrawnAt`. |
| `adult_attestation` | signup (`account.ts:72`) | `ADULT_STATEMENT` (`account.ts:29`) | Same as `terms`: recorded, not re-checked; withdraw → `422 use_account_deletion`. |
| `upload_subject` | `acceptUpload(..., "source")` (`media.ts:79-80`) | `CONSENT_STATEMENT` from `uploads/route.ts:6-7`; `subjectLabel` from form field `subject` (≤80 chars) | Required to use the upload as a generation input: `validateInputs` (`service.ts:104-131`) left-joins `consent_records` and throws `403 consent_required` if `consentId` null or `withdrawnAt` set. Route refuses the upload itself with `422 consent_required` unless form field `consent === "true"` (`uploads/route.ts:15`). |
| `likeness` | `acceptUpload(..., "reference")` via `createCharacter` (`characters.ts:47`, `media.ts:80`) | `LIKENESS_STATEMENT` (`characters.ts:8-9`); `subjectLabel` = character name | Required to use a character reference: `createDraft` `service.ts:186-197` inner-joins consent and throws `403 consent_withdrawn` if withdrawn, 404 if ref missing/deleted. `listCharacters` (`characters.ts:18-22`) and `createContext` (`create-context.ts:19-22`) hide refs whose consent is withdrawn. Route requires both `consentAdult === "true"` and `consentLikeness === "true"` (`characters/route.ts:19-21`) else `422 consent_required`. Max 20 live characters per user (`characters.ts:38-45`, `422 limit_reached`). |
| `training_data` | never created (grep: only the label in `settings.tsx:23`) | — | Unused. |

- Consent is per upload: each `acceptUpload` inserts a fresh `consent_records` row inside the same transaction as the asset and the `uploads` row (`media.ts:77-87`). There is no reuse of one consent across files.
- Publishing boundary: `src/server/templates/publish.ts:49-53` refuses (`403`) to publish any creation whose job has `inputAssetIds.length` or `characterReferenceId`, so consented material never becomes public.
- Settings UI (`src/components/settings.tsx:164-240`) lists active/withdrawn consents with labels and a "Withdraw and delete" sheet calling `DELETE /api/me/consents/<id>`.
- `settingsFor` (`me.ts:34`) returns at most the 100 most recent consent records.

### Withdrawal cascade
`withdrawConsent(userId, consentId)` (`account.ts:111-150`), route `DELETE /api/me/consents/[id]` (`requireUser`, `200 {ok:true}`); also called by `removeCharacter` (`characters.ts:56-63`), so deleting a character in Train is the same cascade.

Inside one transaction:
1. `UPDATE consent_records SET withdrawn_at = now()` where id, user_id match and `withdrawn_at IS NULL`; no row → `404 not_found` (so another user's id, an already-withdrawn id, and a nonexistent id all look alike).
2. If kind is `terms` or `adult_attestation` → throw `422 use_account_deletion` (the transaction rolls back the update).
3. Collect `uploads.asset_id` and `character_references.{id, asset_id}` referencing this consent.
4. Soft-delete the character references (`deleted_at`).
5. Find the user's `generation_jobs` whose `input_asset_ids` overlaps those assets (`arrayOverlaps`) OR whose `character_reference_id` is one of those refs.
6. For those jobs: soft-delete `generation_outputs`, collect their `asset_id` and `poster_asset_id`, then `UPDATE generation_jobs SET deleted_at = now(), cancel_requested = true`.
7. Soft-delete every collected `media_assets` row.
8. Audit `consent.withdraw` with `removedAssets` count.

After commit: `purgeAssetsNow(removed)` (`media.ts:104-112`) deletes the files from storage immediately for assets that are soft-deleted and not already `purged/%`, then sets `bytes = 0, storage_key = 'purged/<id>'`. Per-asset failures are logged and skipped (`media.ts:114-126`). Normal deletions instead wait for the worker's `purgeDeletedMedia(30)` (`src/worker/index.ts:34`).

Not cascaded (verified by reading the function): derived jobs that used an output of a cascaded job as an input are only caught if their `input_asset_ids` overlap the collected set, which is computed from uploads/refs only (step 3) before outputs are appended (step 6 appends to `assetIds` after the job query). So a second-generation creation (image-to-image from an output that was itself made from the withdrawn upload) is not deleted. Inference from the ordering at `account.ts:125-144`; not tested. Also not touched: `project_scenes`/`scene_versions` pointing at those jobs, favorites, folder items, and the in-flight BullMQ job itself (only `cancel_requested` is set; the worker is expected to honor it).

Tested: `tests/integration/platform.test.ts:133-141+` (withdraw upload consent deletes upload, creations and files).

### Account deletion
`deleteAccount(userId, password)` (`account.ts:153-172`), route `DELETE /api/me` (`me/route.ts:20-27`, body `{ password: string 1–200 }`, `requireUser`, clears `hl_session` cookie in the response).
- Wrong password → `403 bad_password`. No rate limit on this route.
- In one transaction: `users` → `status='deleted'`, `deleted_at`, email replaced by `deleted-<uuid>@invalid`, `password_hash='!'`; `user_profiles` → handle `deleted_<first 8 of id>`, displayName "Deleted account", bio ""; soft-delete all owned `media_assets`, all `generation_outputs`, all `generation_jobs` (+`cancel_requested`); `templates` by this creator → `status='removed'`, `deleted_at`; hard-delete `discovery_events`; set `withdrawn_at` on every active `consent_records`; audit `account.delete`.
- After commit: `destroyAllSessions`.
- Files are NOT purged immediately; they wait for the 30-day `purgeDeletedMedia` sweep. `/policies` page text (`policies/page.tsx:58`) matches this: "removed from storage within 30 days. Withdrawing a consent removes the files right away."
- Retained: `date_of_birth`, `age_assured_at`, `created_at`, consent records (with timestamps), ledger entries, audit log entries, `user_profiles` row, `sessions` rows (deleted), `user_preferences`, `credit_accounts`, projects/scenes/folders/presets/favorites/follows (not touched by `deleteAccount`; verified by the list of tables updated). The `users` row is kept (needed for FKs). Handle collision: `deleted_<8 hex>` is not guaranteed unique against a live handle of the same text (unlikely; inference).

Tested: `platform.test.ts:265-281` (wrong password 403; after delete the token no longer resolves, template `removed`, job soft-deleted, discovery events gone).

---

## 7. Media access (adjacent, verified briefly)
- `assetUrl()` (`media.ts:13-17`) returns `null` unless asset is public or `ownerId === viewerId`; otherwise asks the storage driver for a signed URL (`MEDIA_URL_TTL_S`, default 300 s).
- Local driver: HMAC-SHA256 over `key\nexp\ndownload` with `MEDIA_SIGNING_SECRET` (dev fallback string if unset; production refuses to boot without it, `env.ts:40-42,56-58`), expiry rounded up to a TTL window boundary (`storage/index.ts:26-28,57-63`). `GET /api/media` (`src/app/api/media/route.ts:12-21`) verifies with `timingSafeEqual` → `403 forbidden` "Link expired or invalid.", then `404` if the asset is missing or soft-deleted. The signed URL is not bound to the session or user; anyone holding a live link can fetch it until expiry (the `/policies` page line 54 says "tied to your session", which the code does not do; inference from reading `signLocal`).

---

## 8. Test coverage summary (verified from `tests/`)
- Integration (`platform.test.ts`): under-18 signup refused with no row; account deletion cascade + session invalidation + wrong password; consent withdrawal cascade + file purge; admin credit idempotency; report resolution; media route signature.
- E2E (`journey.spec.ts`): signup via UI; admin login + credit grant through `/api/admin/credits`; cross-user 404 on derive/delete; tampered media link 403; cross-origin POST 403; under-18 refusal in UI; blocked prompt.
- Not tested anywhere: login rate limit 429, signup rate limit 429, strict-region 451, `requireAdmin` returning 404 for a member, suspended-user login/session rejection, `terms`/`adult_attestation` withdrawal → 422, logout, `DELETE /api/me/sessions`, `hl_age_ok` gating of pages (e2e calls `enterAgeGate` as a helper, so the gate is exercised but not asserted as a block).

---

## 9. Observations and gaps (mix of verified facts and inferences, labeled)

1. **Verified**: No password reset, password change, or email verification flow. Email is accepted as-is at signup; nothing is sent.
2. **Verified**: `GEO_COUNTRY_HEADER` is trusted from the raw request; nothing in middleware strips a client-supplied copy. **Inference**: the 451 path is bypassable by omitting the header unless the edge always sets it, and triggerable by setting it.
3. **Verified**: `x-forwarded-for` is trusted for the login/signup rate-limit key; direct (non-proxied) deployments collapse all clients into bucket `local` (30 login attempts per 15 min total across everyone).
4. **Verified**: `rateLimit` is not atomic (INCR then EXPIRE).
5. **Verified**: session cookie has a fixed 30-day expiry with no renewal and no server-side cleanup of expired rows.
6. **Verified**: `requireAdmin` and the `/admin` page return 404 (not 403) for non-admins by design.
7. **Verified**: no route can promote a user to `admin`; seed only.
8. **Verified**: `training_data` consent kind exists in the enum and UI label map but is never created or checked.
9. **Inference** (from `account.ts:125-144` ordering): second-generation derivatives of consented material survive consent withdrawal because output asset ids are appended after the job query that uses them.
10. **Verified**: account deletion leaves files for the 30-day purge; consent withdrawal purges immediately. Deletion also keeps DOB and consent timestamps on the `users`/`consent_records` rows.
11. **Verified**: `ageOn` does not range-check month/day; the regex only enforces shape.
12. **Verified**: no CSP or HSTS header; `secure` cookie flag depends on `NODE_ENV === "production"`.
13. **Verified**: `DELETE /api/me` (password-verified) has no rate limit.
14. **Verified**: `.env.example` does not exist in the repo root (plan.md lists it as remaining work).
15. **Verified**: policies page states private links are "tied to your session"; the HMAC includes only key, expiry and download name.
