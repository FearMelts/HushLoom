# Hushloom storage and media delivery map

Read-only survey of `/home/claude/hushloom` at commit `a4752a9` (branch `claude/playbox-2-foundation-q7fpbs`).
Everything under "Verified" was read in the source; "Inference" sections are my reading of behaviour not directly exercised by tests or code I saw.

Files covered:

- `src/server/storage/index.ts` (116 lines) — driver interface, local + S3 drivers, HMAC signing
- `src/server/media.ts` (125 lines) — `assetUrl`, `acceptUpload`, purge helpers
- `src/app/api/media/route.ts` (45 lines) — local-driver byte server with Range support
- `src/app/api/uploads/route.ts` (23 lines) — source-image upload endpoint
- `src/app/api/characters/route.ts`, `src/app/api/characters/[id]/route.ts` — likeness references
- `src/server/characters.ts` (63 lines)
- `src/app/api/generations/[id]/download/route.ts` — download redirect
- `src/server/templates/publish.ts` lines 36–131 — publish copies output to a public asset
- `src/server/generation/processor.ts` lines 104–235 — output storage, poster, discard path
- `src/server/auth/account.ts` lines 110–172 — consent withdrawal, account deletion
- `src/worker/index.ts` lines 31–42 — hourly purge timer
- `src/server/env.ts` — env schema and production guards
- `src/server/db/schema.ts` lines 57–66, 131–178, 345–358, 418–434 — `consent_records`, `media_assets`, `uploads`, `character_references`, `generation_outputs`

---

## 1. Storage drivers

### Interface (verified, `src/server/storage/index.ts:8-14`)

```ts
interface StorageDriver {
  put(key, body: Buffer, mime): Promise<void>;
  get(key): Promise<Buffer>;
  delete(key): Promise<void>;
  signedUrl(key, ttlSeconds, opts?: { download?: string }): Promise<string>;
}
```

Whole-object `Buffer` in and out; there is no streaming API on either driver.

### Key format (verified, `storage/index.ts:16-18`)

`newStorageKey(scope, ownerId, ext)` returns `${scope}/${ownerId}/${randomUUID()}.${ext}` with `scope` one of `"uploads" | "outputs" | "templates" | "avatars"`. Scopes actually used:

| Scope | Writer | Line |
| --- | --- | --- |
| `uploads/` | `acceptUpload` | `src/server/media.ts:75` |
| `outputs/` | worker, output + poster | `src/server/generation/processor.ts:155,176` |
| `templates/` | `publishTemplate` (output + poster copies), `scripts/seed.ts:157` | `src/server/templates/publish.ts:71,75` |
| `avatars/` | **nobody** (grep over `src/` finds no call with `"avatars"`) | — |

`media_assets.storage_key` has a unique index `media_storage_key_uq` (`schema.ts:163`), so one file is one row.

### Driver selection (verified, `storage/index.ts:109-116`)

`storage()` is a module-level singleton. `STORAGE_DRIVER=s3` → `S3Driver(S3_BUCKET)`, otherwise `LocalDriver(path.resolve(STORAGE_LOCAL_DIR))`.

Env (`src/server/env.ts`):

- `STORAGE_DRIVER` enum `local|s3`, default `local` (line 12)
- `STORAGE_LOCAL_DIR` default `.storage` (line 13); production refuses a relative path (lines 45-47) because the standalone server changes cwd and the worker would otherwise write elsewhere
- `S3_BUCKET` (required when driver is s3, lines 48-50), `S3_REGION` (default `"auto"` in the client), `S3_ENDPOINT` (sets `forcePathStyle: true` when present, so MinIO/R2 work), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (both optional; when either is missing the SDK's default credential chain is used)
- `MEDIA_SIGNING_SECRET` min 32 chars, optional in dev/test, **required in production** (lines 40-42); `mediaSigningSecret()` falls back to the literal `"dev-only-media-signing-secret-not-for-production"` (line 57)
- `MEDIA_URL_TTL_S` default 300

Test configs: vitest uses `.storage-test` (`vitest.config.ts:13`), Playwright uses an absolute `.storage-e2e` and a random 32-byte `MEDIA_SIGNING_SECRET` (`playwright.config.ts:14-15`). `.gitignore` excludes `.storage/`, `.storage-test/`, `.storage-e2e/`. The dev `.storage/` directory currently holds only `templates/` (512K, seed media).

### Local driver (verified, `storage/index.ts:24-66`)

- `safeLocalPath` (lines 37-42) accepts only keys matching `^[a-z]+\/[0-9a-zA-Z-]+\/[0-9a-zA-Z-]+\.[a-z0-9]+$` and then re-checks that `path.resolve(root, key)` stays under `root + path.sep`. Two independent traversal guards.
- `put` does `mkdir -p` then `writeFile`; `delete` uses `rm(force: true)` so a missing file is not an error; `get` is `readFile` (throws ENOENT when the file is gone).
- `signedUrl` returns a **relative** URL `/api/media?k=<key>&e=<exp>&s=<sig>[&d=<filename>]`.

### S3 driver (verified, `storage/index.ts:68-107`)

`PutObjectCommand` with `ContentType`, `GetObjectCommand` + `transformToByteArray`, `DeleteObjectCommand`, and `getSignedUrl(GetObjectCommand, { expiresIn: ttlSeconds })` with `ResponseContentDisposition: attachment; filename="<download>"` when a download name is given. Nothing else; no multipart, no public ACLs, no bucket policy assumptions (objects are fetched through presigned GETs only).

`notes/plan.md:147` states the S3 driver has never been run. I confirm there is no test that constructs `S3Driver` (grep of `tests/` for `S3` finds nothing).

---

## 2. HMAC signing for the local driver

### What is signed (verified, `storage/index.ts:26-28`)

```
sig = HMAC-SHA256(secret, `${key}\n${exp}\n${download}`)  → base64url
```

Three fields: the storage key, the expiry as integer Unix seconds, and the download filename (empty string when none). Not signed: the viewer identity, IP, or asset id. A signed URL is therefore a bearer link: anyone who holds it can fetch the bytes until `exp`.

### TTL (verified, `storage/index.ts:58-60`)

Expiry is rounded **up to the next multiple of `ttlSeconds`**: `exp = ceil((now + ttl) / ttl) * ttl`. The comment says this keeps URLs stable within a window so the browser cache can reuse them. Consequence: effective lifetime is between `ttl` and `2 × ttl`. With the defaults that is 300–600 s for private assets and 3600–7200 s for public ones (`media.ts:16`).

### Verification (verified, `storage/index.ts:30-35`)

`verifyLocalSignature(key, exp, download, sig, now = Date.now())`: rejects non-finite or past `exp`, recomputes the HMAC, compares with `timingSafeEqual` after a length check. Covered by `tests/unit/signatures.test.ts:6-19` (tamper key, tamper exp, tamper download name, expired clock).

### Ownership check before signing (verified, `src/server/media.ts:12-18`)

```ts
assetUrl(asset, viewerId, opts):
  if (asset.deletedAt) return null;
  if (asset.visibility !== "public" && asset.ownerId !== viewerId) return null;
  ttl = visibility === "public" ? 3600 : env().MEDIA_URL_TTL_S;
  return storage().signedUrl(asset.storageKey, ttl, opts);
```

This is the single choke point. Every URL the app hands to a browser goes through `assetUrl`/`assetUrlById`; callers found by grep:

- `src/server/generation/views.ts:64,107` (library / creation detail)
- `src/server/discovery/templates.ts:105-106` (explore grid, poster + preview)
- `src/server/projects.ts:107` (project covers)
- `src/server/creators.ts:76`
- `src/server/characters.ts:30`
- `src/app/api/generations/[id]/download/route.ts:54` (with `download` name)

There is no other call to `storage().signedUrl` outside tests. `publish.ts`, `processor.ts`, `seed.ts` use `put/get` only.

Note that `assetUrl` relies on the **caller** having already scoped the query to the viewer or to published content; it only re-checks `ownerId === viewerId` and `visibility`. Admin users get no bypass here (an admin viewing another user's private asset gets `null`); I did not find an admin media path, which is consistent with `notFound()` semantics in `http.ts:20-21`.

---

## 3. `/api/media` byte server (verified, `src/app/api/media/route.ts`)

`GET /api/media?k=&e=&s=[&d=]`:

1. `verifyLocalSignature` fails → **403** `{error:{code:"forbidden"}}` (line 17-19). This is the "forged media link (403)" acceptance case; covered by `tests/integration/platform.test.ts:313-318` and `tests/e2e/journey.spec.ts:98-100`.
2. Looks up `media_assets` by `storage_key`; missing row or `deleted_at` set → **404** (line 20-21). Covered by `platform.test.ts:320-321`. So a URL signed before a soft delete stops working immediately, before purge.
3. `storage().get(key)` reads the **entire file into memory** (line 23).
4. Headers: `Content-Type` from the row's `mime` (not sniffed), `Accept-Ranges: bytes`, `Cache-Control: private, max-age=<seconds until exp>`, `X-Robots-Tag: noindex`; `Content-Disposition: attachment; filename="<d stripped to [\w.-]>"` when `d` present (lines 24-30).
5. Range: parses `bytes=a-b`, `bytes=a-`, `bytes=-N` (suffix). Out of range → **416** with `Content-Range: bytes */len`; otherwise **206** with `Content-Range` and `Content-Length` (lines 32-43). Multi-range (`bytes=0-1,5-6`) does not match the regex and falls through to a full 200. Tested at `platform.test.ts:307-311` (`bytes=0-9`, `bytes=-4`).
6. No range → 200 with `Content-Length`.

Not wrapped in `route()` from `src/server/http.ts:46`, so a thrown error (e.g. the DB row exists but the file is missing on disk, or an `invalid storage key` from `safeLocalPath`) surfaces as a Next.js 500 rather than the JSON error envelope. `safeLocalPath` cannot be reached with a bad key in practice because the signature must match first.

Middleware (`src/middleware.ts`) only enforces Origin on mutating methods, so GET `/api/media` is unaffected. There is no `Vary` header and no ETag/If-Range support.

With `STORAGE_DRIVER=s3` this route is never used: `assetUrl` returns an absolute presigned S3 URL and the browser fetches the bucket directly. Range on S3 is then the bucket's own behaviour.

---

## 4. Uploads

### Endpoint `POST /api/uploads` (verified, `src/app/api/uploads/route.ts`)

- `requireUser()` → 401 if anonymous.
- Redis rate limit `upload:<userId>` 40 per 3600 s → **429** `rate_limited`.
- `multipart/form-data`; `file` must be a `File` → else **422** `invalid_input`; `consent` must equal the string `"true"` → else **422** `consent_required`; optional `subject` truncated to 80 chars.
- Consent statement is the server constant `CONSENT_STATEMENT` (line 6-7), never client text.
- `acceptUpload(user.id, {bytes, declaredMime: file.type}, {...}, "source")` → **201** `{assetId, kind, width, height, warnings}`.
- The form field `purpose` sent by `create-panel.tsx:175` is ignored by the server; purpose is hard-coded to `"source"`.

### `acceptUpload` validation (verified, `src/server/media.ts:26-90`)

Branch on the **client-declared** MIME (`file.type`):

- `video/*`:
  - `> 100 MB` (`MAX_VIDEO_BYTES`) → **413** `too_large`
  - bytes 4–8 must be ASCII `ftyp` (ISO BMFF brand box) → else **415** `unsupported_type` "Videos must be MP4."
  - stored **as-is** (no re-mux, no metadata strip), `mime` forced to `video/mp4`, `width/height/durationMs` all `null`, `kind = "video"`
- anything else (treated as image):
  - `> 20 MB` (`MAX_IMAGE_BYTES`) → **413**
  - `sharp(bytes).metadata()` must succeed and report format `jpeg|png|webp` with width and height → else **415**
  - re-encoded: `sharp().rotate().webp({quality: 92})` — applies EXIF orientation and drops EXIF/GPS (comment at lines 32-34), `mime = image/webp`, `kind = "image"`
  - dimensions read from the re-encoded buffer; `min(width,height) < 512` → `warnings: ["low_resolution"]` (the copilot's "flags low-res uploads" hook)
  - **no maximum dimension or pixel-count limit**; a 20 MB PNG that decodes to a very large bitmap is passed to sharp without a `limitInputPixels` override (sharp's default cap of 268 M pixels applies; inference from sharp defaults, not from this code)

Then (line 75-89): `storage().put(key, body, mime)` happens **before** the DB transaction. The transaction inserts a `consent_records` row (`kind = "likeness"` for `purpose === "reference"`, else `"upload_subject"`), a `media_assets` row (`visibility: "private"`, `sha256`, `bytes`), and an `uploads` row (`purpose`, `consentRecordId`). If the transaction fails the file is orphaned on disk with no row (inference; no cleanup code on that path).

The whole upload is buffered by `file.arrayBuffer()` in the route **before** the size check runs, so the 413 is enforced after the bytes are in memory. I did not find a `bodySizeLimit` in `next.config.*` (only `output: "standalone"`). Inference: App Router route handlers have no built-in body cap, so the only protection against a multi-GB POST is the host/proxy in front of Next.

The UI restricts `<input accept="image/jpeg,image/png,image/webp">` (`create-panel.tsx:307`, `train.tsx:115`), so the video path is server-only today.

`sha256` is stored on every asset but nothing reads it (grep: only writes). No deduplication.

### Character references (verified, `src/server/characters.ts`, `src/app/api/characters/route.ts`)

`POST /api/characters`: rate limit `character:<userId>` 10/hour → 429; needs `file`, non-empty `name` (≤ 40 chars), and both `consentAdult === "true"` and `consentLikeness === "true"` → else 422 `consent_required`. `createCharacter` rejects non-`image/*` declared MIME with 415 (line 38), enforces at most **20 live characters** per user via `offset(19).limit(1)` (lines 39-45) → 422 `limit_reached`, then calls `acceptUpload(..., "reference")` with `LIKENESS_STATEMENT` (lines 8-9), reads back the `uploads.consentRecordId` and inserts `character_references` (`assetId`, `consentRecordId`). Not transactional with the upload: if the `character_references` insert fails, the asset + consent + upload rows remain (inference).

`listCharacters` joins `consent_records` and filters `withdrawnAt IS NULL` and `deletedAt IS NULL`, so a withdrawn likeness disappears even before the soft-delete lands.

`DELETE /api/characters/[id]` → `removeCharacter` → 404 if not owned → `withdrawConsent(userId, consentRecordId)`. Returns `{ok:true}`.

The doc comment (lines 11-15) states plainly that no model fine-tuning happens; the reference is passed to providers at generation time. Processor confirms: inputs are loaded from `media_assets` by id (`processor.ts:106-112`) and handed to `adapter.execute`.

---

## 5. Where generated files come from (verified, `processor.ts:148-235`)

For every provider output: `qualityCheck` → fail → job `finishFailed` (no file written). Otherwise `storage().put("outputs/<userId>/<uuid>.<ext>")`, insert `media_assets` (`visibility: "private"`, `ownerId: job.userId`, dims from the quality report when the provider gave none). For video, `videoPoster` (`src/server/generation/poster.ts`: ffmpeg frame at 0.5 s → sharp WebP q82; returns `null` on any failure, never fails the job) is stored as a second private asset and linked via `generation_outputs.poster_asset_id`.

Files are written **before** the commit transaction. Inside the transaction the job row is locked `FOR UPDATE`; if the job is no longer `processing` (reconciler timeout) or `cancelRequested`, the new assets are soft-deleted in the same transaction and then `purgeAssetsNow(storedIds)` removes the files immediately (lines 200-231). So cancelled-during-processing outputs never persist.

Inputs: any `inputAssetIds` already soft-deleted → provider error `invalid_input` "an input was deleted" (line 109).

---

## 6. Publish copies to a public asset (verified, `src/server/templates/publish.ts:41-131`)

Guards, in order:

1. Job must be the caller's and not deleted → 404.
2. `status !== "completed"` → **409** `not_ready`.
3. `job.inputAssetIds.length || job.characterReferenceId` → **403** `personal_media` (consent boundary: anything made from an upload or a likeness cannot leave the owner's library). Tested `platform.test.ts:191-195`.
4. `checkPrompt(title, description, tags, job.prompt)` blocked → `moderation_events` row + **422** `policy_blocked`.
5. No live output → **409** `no_output`.

Then (lines 69-76): `storage().get(privateKey)` → `storage().put("templates/<userId>/<uuid>.<ext>")`, same for the poster when present. Only afterwards does a transaction insert the public `media_assets` rows by spreading the private row (`{...out.asset, id: undefined, storageKey: key, visibility: "public", createdAt: new Date(), deletedAt: null}` — this also copies `ownerId`, `sha256`, `bytes`, dims), insert `templates` (`posterAssetId` = public image for stills, public poster for clips; `previewAssetId` = public clip), `template_versions` v1 (seed stripped from defaults), promote `member → creator`, `creator_profiles` upsert, audit `template.publish`.

Properties:

- The original output stays `private`; `platform.test.ts:177-189` verifies another user gets `null` for it and non-null for the copy.
- File copy happens outside the transaction; a failed transaction leaves orphaned `templates/` files (inference).
- Public assets are signed with TTL 3600 (effective 3600–7200 s) and still go through `/api/media`; they are not served from a public bucket or `public/` directory.

### What happens to the public copy later

- `updateTemplate` with `status: "unpublished"` (`publish.ts:176-190`) only changes `templates.status`; the public `media_assets` rows stay `visibility: "public"` and undeleted.
- Admin removal (`src/server/admin.ts:117`) sets `templates.status = "removed"` only.
- Account deletion (`account.ts:163`) soft-deletes **all** `media_assets` with `ownerId = userId`, which includes the public template copies (ownerId was copied on publish), and sets `templates.status = "removed"`.
- Discovery filters on `status = "published" AND deleted_at IS NULL` (`discovery/templates.ts:128`), so unpublished/removed templates stop being listed; a previously issued signed URL for the public copy keeps working until its expiry (≤ 2 h), and the row remains fetchable by anyone who can obtain a fresh signature, which only `assetUrl` callers scoped by `published` would produce. Inference: no path re-signs an unpublished template's asset for non-owners.

---

## 7. Deletion, consent withdrawal and purge

### Soft delete sites (verified)

| Trigger | Code | What is soft-deleted | File purge |
| --- | --- | --- | --- |
| User deletes a creation (`DELETE /api/generations/[id]`) | `generation/service.ts:414-432` `deleteJob` | `generation_outputs`, their `media_assets` (output + poster), `generation_jobs`; 409 `job_active` if queued/processing | deferred: hourly worker, 30-day retention |
| Consent withdrawal (upload_subject / likeness) | `auth/account.ts:111-150` `withdrawConsent` | the consent row (`withdrawnAt`), uploaded assets, `character_references`, every job of that user whose `inputAssetIds` overlap or `characterReferenceId` matches (`cancelRequested: true` too), their outputs + posters | **immediate** `purgeAssetsNow(removed)` after commit (line 149) |
| Character removal | `characters.ts:56-63` → `withdrawConsent` | as above | immediate |
| Account deletion | `account.ts:153-172` | all of the user's assets, outputs, jobs; templates → `removed`; all consents withdrawn; `discoveryEvents` hard-deleted | deferred 30 days |
| Admin removes an output | `admin.ts:119-120` | the output and its primary asset (poster not included) | deferred |
| Worker discards outputs of a cancelled/timed-out job | `processor.ts:200-231` | the just-written assets | immediate |

`terms` and `adult_attestation` consents cannot be withdrawn through `withdrawConsent` (422 `use_account_deletion`, `account.ts:119-121`).

The consent-withdrawal path is tested end to end in `platform.test.ts:134-150`: after withdrawal every affected asset's `storageKey` starts with `purged/` and `storage().get(oldKey)` rejects.

### Purge mechanics (verified, `media.ts:92-125`)

- `purgeDeletedMedia(retentionDays)`: up to 500 rows per run where `deleted_at < now - retention` and `storage_key NOT LIKE 'purged/%'`.
- `purgeAssetsNow(ids)`: same filter restricted to the given ids and `deleted_at IS NOT NULL` (so a live asset can never be purged by mistake).
- `purgeRows`: per row `storage().delete(key)` then `UPDATE media_assets SET bytes = 0, storage_key = 'purged/<id>'`. Each failure is logged with `logger.warn` and skipped; the row keeps its real key so the next run retries. The `media_assets` row itself is never hard-deleted (keeps FKs from `generation_outputs`, `templates`, `character_references` valid).
- Scheduler: `src/worker/index.ts:31-42` — `setInterval(purge, 3_600_000)` calling `purgeDeletedMedia(30)`. The 30-day window is a literal, not an env var. No purge runs at worker start (only `sweep()` does), so the first purge is one hour after boot.

Because `/api/media` checks `deleted_at` before reading (section 3), bytes are unreachable from the moment of soft delete even though they sit on disk for up to 30 days.

---

## 8. Range requests and video playback (verified)

- `creation-detail.tsx:46` renders `<video src={output.url} poster={posterUrl} controls loop playsInline muted preload="metadata">`; the grid variant (line 312) uses `preload="none"` when a poster exists. Both rely on `/api/media` honouring `Range` for seeking and for `preload="metadata"`.
- Each Range request re-reads the whole file via `readFile` and slices in memory (`route.ts:23,39`). For a 100 MB upload that is 100 MB per request. Inference: fine for demo clips, a memory concern for real video.
- `notes/plan.md:141` says H.264 playback in headless Chromium is unverified; the e2e journey asserts only the `<img src>` contains `/api/media?` (`journey.spec.ts:77-78`).

---

## 9. Download (verified, `src/app/api/generations/[id]/download/route.ts`)

`GET /api/generations/[id]/download`: `requireUser` → `getOwnedJob` (404 for other users' jobs) → first live output → `assetUrl(asset, user.id, { download: "hushloom-<jobid8>[-demo].<ext>" })` → **302** to the signed URL. The `d` parameter is part of the HMAC, so a client cannot rename or strip the attachment disposition. Demo outputs carry `-demo` in the filename. `creation-detail.tsx:258` links to it with the `download` attribute.

---

## 10. Gaps and observations

Verified from code:

1. **Avatars are schema-only.** `users.avatar_asset_id` (`schema.ts:95`), `upload_purpose = 'avatar'`, and the `"avatars"` storage scope exist; no route or service writes them. Creator profile avatars in the spec (Part III §6) are not uploadable.
2. **`template_media` upload purpose unused** apart from the seed's direct inserts.
3. **Video uploads are untested and shallowly validated**: only the `ftyp` check; no codec/dimension/duration probe, no re-mux, `durationMs` null, metadata not stripped (contrast with images, which are re-encoded). No unit/integration test exercises 413 or 415 (grep for `too_large|unsupported_type|413|415` under `tests/` is empty).
4. **Size limit enforced after full buffering** (`uploads/route.ts:18` → `media.ts:50,56`).
5. **Files are written before their DB rows commit** in `acceptUpload`, `processor.ts`, and `publishTemplate`; no compensating delete on transaction failure → possible orphans on disk (not in the DB, so never purged).
6. **Public copies outlive unpublish/removal** (`publish.ts:176-190`, `admin.ts:117`): the `media_assets` row stays `public` and undeleted; only discovery filtering hides it.
7. **Admin removal of an output skips the poster asset** (`admin.ts:119-120`).
8. **`/api/media` is not wrapped in `route()`** → file-missing-on-disk gives a Next 500 page rather than the JSON envelope.
9. **Retention window hard-coded** (`worker/index.ts:34`: `purgeDeletedMedia(30)`); spec Part VIII asks for "transparent retention", which would be easier with an env var and a documented value.
10. **Signed URL lifetime is 1×–2× TTL** because of window rounding; documentation should state "up to 10 minutes" rather than "5 minutes" for private media.
11. **S3 driver unexercised** (plan.md:147; no S3 test; `S3Driver.get` buffers whole objects).
12. **No multi-range, ETag or `If-Range` support** on `/api/media`; single-range only.

Inference (not verified by running anything):

- Behind a reverse proxy the relative `/api/media?...` URL resolves against the page origin, which is what `download/route.ts:56` relies on (`new URL(url, req.nextUrl.origin)`); with S3 the presigned URL is absolute and the redirect works unchanged.
- Because the HMAC does not bind the viewer, link sharing within the TTL window is the accepted trade-off (same as S3 presigned URLs). A per-viewer binding would break the `Cache-Control: private` reuse the window rounding is designed for.

---

## 11. Test coverage of this area (verified)

- `tests/unit/signatures.test.ts:6-19` — HMAC accept/reject.
- `tests/integration/platform.test.ts:134-150` — consent withdrawal purges files now.
- `platform.test.ts:166-172` — cross-user use of an upload/character is refused.
- `platform.test.ts:175-195` — publish copies to public, original stays private, personal media refused.
- `platform.test.ts:220-238` — poster stored, used as cover, soft-deleted with creation.
- `platform.test.ts:295-322` — `/api/media` 200/206 (two range forms)/403×2/404.
- `tests/e2e/journey.spec.ts:77-100` — media URL is `/api/media?...`; tampered signature from another member's session → 403.

Not covered: upload size/type rejections, video uploads, S3 driver, 416 path, `purgeDeletedMedia` retention window, account-deletion purge, `download` route.
