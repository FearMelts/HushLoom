# Hushloom generation pipeline map

Read-only survey of `/home/claude/hushloom` (branch `claude/playbox-2-foundation-q7fpbs`) on 2026-10-12. Everything under "Verified" was read directly from source; anything marked **Inference** was not executed or confirmed by a test.

Files covered:

| Area | File | Lines |
| --- | --- | --- |
| Draft / confirm / cancel / derive / delete | `src/server/generation/service.ts` | 432 |
| Worker-side processing, quality check, reconcile | `src/server/generation/processor.ts` | 257 |
| BullMQ queue | `src/server/generation/queue.ts` | 24 |
| Poster frames | `src/server/generation/poster.ts` | 31 |
| Read models for Library/Collection | `src/server/generation/views.ts` | 149 |
| Model registry, capability validation, cost | `src/server/ai/registry.ts` | 192 |
| Adapter interface + error normalization | `src/server/ai/providers/types.ts` | 62 |
| Adapter lookup + live availability | `src/server/ai/providers/index.ts` | 44 |
| Demo adapter (sharp + ffmpeg) | `src/server/ai/providers/demo.ts` | 147 |
| Replicate adapter + webhook verifier | `src/server/ai/providers/replicate.ts` | 144 |
| Content policy + age assurance | `src/server/safety/policy.ts` | 97 |
| Rules-based copilot | `src/lib/copilot.ts` | 282 |
| Worker process | `src/worker/index.ts` | 66 |
| Redis + rate limiter | `src/server/redis.ts` | 23 |
| Credit ledger | `src/server/credits/ledger.ts` | 121 |
| HTTP routes | `src/app/api/generations/**`, `src/app/api/webhooks/replicate/route.ts` | — |
| Schema (generation part) | `src/server/db/schema.ts:361-433, 486-491` | — |
| Env | `src/server/env.ts` | 58 |
| Pricing | `src/config/pricing.ts` | 38 |

---

## 1. End-to-end flow (verified)

```
POST /api/generations            createDraft()      → status awaiting_confirmation, costCredits stored
POST /api/generations/:id/confirm confirmJob()      → reserve credits, status queued, BullMQ add
  [worker]  processJob()                             → claim (queued→processing), adapter.execute()
            qualityCheck → storage().put → mediaAssets insert → poster (video)
            tx: generationOutputs insert, settleJob, status completed
POST /api/generations/:id/cancel  cancelJob()       → cancelled (+ release) or cancelRequested flag
GET  /api/generations?active=1    listCreations()   → polled by job tray every 3 s (15 s hidden)
GET  /api/generations/:id         getCreation()
GET  /api/generations/:id/download                   → 302 to signed media URL
POST /api/generations/:id/derive  deriveDraft()     → new draft (retry/variation/continuation/extension)
DELETE /api/generations/:id       deleteJob()       → soft delete job + outputs + assets
POST /api/webhooks/replicate                         → verify signature, log only
```

All `/api/generations/*` handlers call `requireUser()` (`src/server/http.ts:23`); unauthenticated → 401 `unauthorized`. Ownership is enforced by `eq(generationJobs.userId, user.id)` in every query, and a non-owned id yields the same 404 `not_found` as a missing one (`http.ts:20-21`). Malformed UUIDs map to 404 via Postgres error 22P02 (`http.ts:66-67, 76-80`). The origin-check middleware (`src/middleware.ts:9-15`) returns 403 `bad_origin` on cross-site mutating API calls; webhooks have no `Origin` header and pass.

---

## 2. State machine

Enum `job_status` (`schema.ts:39-47`): `draft, awaiting_confirmation, queued, processing, completed, failed, cancelled`.

**Verified: `draft` is never written.** `createDraft` inserts with `status: "awaiting_confirmation"` (`service.ts:245`). The column default is `draft` (`schema.ts:380`) and `cancelJob` handles it (`service.ts:334`), but no code path sets it. `views.ts:326, 425` exclude both `draft` and `awaiting_confirmation` from library/lineage lists.

### Transitions and their DB guards

| # | From → To | Where | Guard (all in a transaction unless noted) |
| --- | --- | --- | --- |
| T1 | (none) → `awaiting_confirmation` | `createDraft` `service.ts:240-264` | `INSERT ... ON CONFLICT DO NOTHING` against `jobs_idempotency_uq (user_id, idempotency_key)` (`schema.ts:411`); loser re-selects winner (`service.ts:267-272`). Not in a transaction; prior checks are plain reads. |
| T2 | `awaiting_confirmation` → `queued` | `confirmJob` `service.ts:278-320` | `SELECT ... FOR UPDATE` on the job row (`:283`); if status ≠ `awaiting_confirmation` returns job unchanged without enqueueing (`:285`); `costCredits !== expectedCost` → 409 (`:286-288`); active count `>= maxActive` → 429 (`:289-295`); `reserveForJob` (locks `credit_accounts` row, `ledger.ts:29-34`); UPDATE sets `queuedAt`. Enqueue happens **after** commit (`:321`). |
| T3 | `awaiting_confirmation`/`draft` → `cancelled` | `cancelJob` `service.ts:334-337` | FOR UPDATE; no ledger movement (nothing reserved). |
| T4 | `queued` → `cancelled` | `cancelJob` `service.ts:338-346` | FOR UPDATE; `releaseJob(... "cancelled before processing")`; sets `cancelRequested=true, failureCode="cancelled", finishedAt`. Queue entry is left in Redis; the worker's claim finds status ≠ `queued` and returns (`processor.ts:73`). |
| T5 | `queued` → `cancelled` (worker side) | `processJob` claim `processor.ts:74-78` | FOR UPDATE; if `cancelRequested` already true on a still-queued job, release + cancel. (Reachable only if T4's UPDATE raced; in practice T4 sets cancelled directly.) |
| T6 | `queued` → `processing` | `processJob` claim `processor.ts:79-84` | FOR UPDATE, `status === "queued"`; sets `startedAt`, `attempts = attempts + 1`. Idempotent: any other status → no-op, so duplicate BullMQ deliveries are harmless. |
| T7 | `processing` → `queued` (retry) | `processor.ts:130-139` | Plain UPDATE with `WHERE status = 'processing'` (`:135`); condition `err.retryable && job.attempts < job.maxAttempts` (maxAttempts default 3, `schema.ts:399`); `failureCode` recorded; no ledger movement (reservation held). Re-enqueued with delay `retryBaseDelayMs(5000) * 2^(attempts-1)` → 5 s, 10 s. |
| T8 | `processing` → `failed` | `finishFailed` `processor.ts:42-59` | FOR UPDATE, `status === "processing"` else return; `releaseJob` (refund) then UPDATE with `failureCode`, `failureMessage = USER_FACING_ERRORS[code]`, `finishedAt`. |
| T9 | `processing` → `cancelled` (error path) | `finishFailed` with `err.code === "cancelled" || job.cancelRequested` `processor.ts:46` | Same tx as T8; release note "cancelled". |
| T10 | `processing` → `cancelled` (after successful render) | `processor.ts:197-205` | FOR UPDATE; if `cancelRequested` set after the provider finished: soft-delete just-written assets, release, mark cancelled; files purged with `purgeAssetsNow` (`:230`). |
| T11 | `processing` → `completed` | `processor.ts:189-228` | FOR UPDATE, `status === "processing"` else assets soft-deleted and purged (`:192-196`); inserts `generation_outputs` rows (`isDemo` copied from job, `qualityReport`), `settleJob`, UPDATE status/`finishedAt`, template `generationCount + 1`. |
| T12 | `processing` → `failed` (`timeout`) | `reconcile` `processor.ts:251-255` | Jobs with `startedAt < now - (PROVIDER_TIMEOUT_S*1000 + 120_000)` → `finishFailed(..., "timeout")`; refund via T8. |
| T13 | `queued` → (re-enqueue) | `reconcile` `processor.ts:246-250` | Jobs with `updatedAt < now - 120_000` → `enqueueGeneration(id, 0, attempts+1)`. |
| T14 | `processing` → `cancelRequested=true` | `cancelJob` `service.ts:347-351` | FOR UPDATE; flag only; worker polls the flag every `cancelPollMs` (default 2000 ms, `processor.ts:99-102`) and aborts the `AbortController`. |
| — | terminal → anything | `cancelJob` `service.ts:352` returns the job unchanged (HTTP 200). `confirmJob` on a non-`awaiting_confirmation` job returns it unchanged (200), **without** checking `expectedCost`. |

Timestamps recorded: `createdAt`, `queuedAt`, `startedAt`, `finishedAt`, `updatedAt` (`schema.ts:403-407`). Provider id: `providerJobId` via `ctx.onProviderJobId` (`processor.ts:118-120`). Retries: `attempts`/`maxAttempts`. Failure: `failureCode`/`failureMessage`. Output location: `media_assets.storage_key` via `generation_outputs.asset_id`.

**No invented progress:** `views.ts` exposes only status and timestamps; `src/components/job-tray.tsx:28` states "there is no invented progress bar" and shows elapsed time.

---

## 3. Draft → confirm: `expectedCost` and the 409

- Draft body is validated by `draftSchema` (`service.ts:59-73`); `params` by `paramsSchema` (`:44-57`, `.strict()`; `durationS` 1–60, `motionIntensity` 1–10, `seed` 0–2^31-1, `aspectRatio` `/^\d{1,2}:\d{1,2}$/`).
- Cost is computed once at draft time: `estimateCost(model, params, model.priceMultiplierPct)` (`service.ts:238`, `registry.ts:181-192`): image = `pricing.imageBase` (4); video = `pricing.videoPerSecond` (3) × `durationS` (default `durationsS[0]` or 5); × `qualityMultiplier` (hd 1, 4k 2) × admin `price_multiplier_pct` from `model_configs` (`schema.ts:486-491`, default 100); `Math.max(1, Math.ceil(...))`. Stored in `cost_credits` (CHECK `>= 0`, `schema.ts:415`).
- Confirm body: `{ expectedCost: z.number().int().nonnegative() }` (`confirm/route.ts:8`). Mismatch → **409 `cost_changed`** with `details.cost` (`service.ts:286-288`).
- **Inference:** `costCredits` is never recomputed after draft (no code re-prices on confirm), so the 409 only catches a client sending a stale or wrong number; an admin changing a multiplier between draft and confirm does not change the job's price.
- Insufficient balance: `reserveForJob` throws `InsufficientCreditsError` (`ledger.ts:52`) inside the tx → rolled back → **402 `insufficient_credits`** with `{needed, available}` (`http.ts:60-65`). Job stays `awaiting_confirmation` (test `generation.test.ts:99`).
- Client calls (`create-panel.tsx:227`, `library.tsx:27`, `creation-detail.tsx:100`, `projects.tsx:182`) all send `expectedCost: job.costCredits` from the draft response.

---

## 4. Idempotency

- **Job creation:** `idempotencyKey` (8–100 chars) is required on draft and derive; unique per `(user_id, idempotency_key)` (`schema.ts:411`). `createDraft` first SELECTs and returns an existing job (`service.ts:147-151`) before any validation (so a repeat with the same key returns the original even if policy/age checks would now fail), then relies on `onConflictDoNothing` + re-select for races (`:263-272`). Test: `generation.test.ts:90`.
- **Confirm:** safe to repeat; a job no longer `awaiting_confirmation` is returned as-is (`service.ts:285`).
- **Credits:** every movement carries an idempotency key; `ledger_idempotency_uq` (`schema.ts:522`). `reserve` = `job:{id}:reserve`; `settle` and `release` **share** `job:{id}:close` (`ledger.ts:86-107`) so a job is closed exactly once: it cannot be both charged and refunded or charged twice. `applyMovement` locks the account row and checks the key inside the same tx (`ledger.ts:41-69`).
- **Queue:** BullMQ job id is `${jobId}-a${attempt}` (`queue.ts:22`), so re-adding the same attempt is a no-op; a retry gets a new id.
- **Processing:** claim requires `status === "queued"` (`processor.ts:73`); completion requires `status === "processing"` (`:192`).
- **Rate limit on draft:** `rateLimit("draft:{userId}", 30, 60)` → 429 `rate_limited` (`generations/route.ts:32`). Fixed window via `INCR` + `EXPIRE` (`redis.ts:17-22`).

---

## 5. Per-user active-job limit

`confirmJob` (`service.ts:277`): `maxActive = max(env().USER_MAX_ACTIVE_JOBS, activePlan(user).maxActiveJobs ?? 0)`.
- `USER_MAX_ACTIVE_JOBS` default **3** (`env.ts:25`).
- Plans: `plan_member` → 3, `plan_studio` → 6 (`pricing.ts:15-34`). `activePlan` (`service.ts:82-95`) picks the plan with the highest `maxActiveJobs` among subscriptions with status `active|trialing` and `currentPeriodEnd` null or in the future.
- Counts jobs in `["queued","processing"]` (`ACTIVE`, `service.ts:79`) inside the confirm tx; `active >= maxActive` → **429 `too_many_active`**.
- **Inference (race):** the count runs before the credit-account row lock and only the confirmed job's row is locked, so two concurrent confirms of different drafts can each see `active = maxActive - 1` and both pass. Not covered by a test; `generation.test.ts:210` confirms sequentially.

---

## 6. BullMQ queue and worker

Verified in `queue.ts` and `worker/index.ts`:

| Option | Value | Where |
| --- | --- | --- |
| Queue name | `"generation"` | `queue.ts:4` |
| Job name | `"run"` | `queue.ts:23` |
| Payload | `{ jobId, attempt }` | `queue.ts:6` |
| `attempts` (BullMQ) | **1** — BullMQ never retries; retries are application-level (T7) | `queue.ts:13` |
| `backoff` (BullMQ) | none configured; app backoff = `5000 * 2^(attempts-1)` ms (overridable via `ProcessOptions.retryBaseDelayMs`) | `processor.ts:136` |
| `removeOnComplete` / `removeOnFail` | 1000 / 5000 | `queue.ts:13` |
| `delay` | per-add, used for retry backoff | `queue.ts:23` |
| Worker `concurrency` | `WORKER_CONCURRENCY`, default **2** | `env.ts:23`, `worker/index.ts:11-19` |
| Timeout | none at BullMQ level; app-level `AbortController` after `PROVIDER_TIMEOUT_S * 1000` (default **600 s**) | `processor.ts:69, 97-98` |
| Lock duration / stalled handling | BullMQ defaults (not configured) | — |
| Connection | shared `ioredis` with `maxRetriesPerRequest: null`, `lazyConnect: false` | `redis.ts:8` |
| Worker `failed` event | logged only (`"queue job crashed"`) | `worker/index.ts:21` |
| Reconcile sweep | at start, then every **60 s**: `reconcile()` | `worker/index.ts:41-42` |
| Media purge | every **3600 s**: `purgeDeletedMedia(30)` (30-day retention) | `worker/index.ts:32-43` |
| Health | `WORKER_HEALTH_PORT` optional; `GET /health` → 200 `{ok:true}` if `worker.isRunning()`, else 503 | `worker/index.ts:47-53` |
| Shutdown | SIGINT/SIGTERM → clear timers, close health, `worker.close()`, `closeRedis()`, `closeDb()` | `worker/index.ts:55-66` |

Processor flow per attempt (`processJob`, `processor.ts:67-235`): claim → resolve adapter (`getModel` + `adapterFor`; unconfigured → `provider_unavailable`, non-retryable) → load `inputAssetIds` from storage (deleted input → `invalid_input`) → `adapter.execute()` under abort signal → on error: re-read `cancelRequested` and coerce to `cancelled`; retry or `finishFailed` → on success: per output `qualityCheck`, `storage().put`, `mediaAssets` insert (`visibility: "private"`, sha256), poster for video → final tx (T10/T11).

**Reconcile edge (inference, not tested):** T13 re-adds `${id}-a${attempts+1}`. If the worker crashed *before* the claim (e.g. DB error inside `processJob`), BullMQ keeps the failed entry with that same id (`removeOnFail: 5000`), and BullMQ ignores an `add` whose custom id already exists. The DB job would then stay `queued` and be "re-enqueued" every 60 s without effect until the failed entry ages out. The common cases (enqueue failed after commit; worker died after claim) are handled.

---

## 7. Provider adapter interface

`src/server/ai/providers/types.ts`:

```ts
interface ProviderAdapter {
  readonly key: string;
  readonly isDemo: boolean;           // "Demo adapters never call an AI model; outputs labeled as such everywhere"
  isConfigured(): boolean;
  execute(req: ProviderRequest, ctx: ExecuteContext): Promise<ProviderOutput[]>;
}
ProviderRequest = { jobId, model: ModelSpec, mode, prompt, negativePrompt, params, inputs: ProviderInput[] }
ProviderInput   = { kind: "image"|"video", mime, bytes: Buffer, width?, height? }
ProviderOutput  = { mime, bytes: Buffer, width?, height?, durationMs? }
ExecuteContext  = { signal: AbortSignal; onProviderJobId(id): Promise<void> }
ProviderError(code, message, retryable)  code ∈ timeout | rate_limited | provider_unavailable | invalid_input | content_rejected | unsupported | cancelled | internal
```

`USER_FACING_ERRORS` (`types.ts:53-62`) maps every code to a sentence ending "Your credits were returned." and is what lands in `failureMessage`.

Registry (`providers/index.ts`): `ADAPTERS = { demo, replicate }`; `registerAdapter()` is a test hook (used by `tests/integration/generation.test.ts:38` with a `fake` adapter). `listModelAvailability()` (`:26-44`) joins `MODELS` with `model_configs` and reports `available = adapter && isConfigured() && !disabled`, `reason ∈ "No adapter" | "Needs credentials" | "Disabled by an admin"`, `priceMultiplierPct`, `isDemo`. Admin toggles via `src/app/api/admin/models/[key]/route.ts` (not read in depth).

### Model registry (`registry.ts:78-123`)

| key | providerKey | output | modes | aspectRatios | durationsS | qualities | supports | continuity | minInputShortSidePx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `demo-still` ("Demo Still (not AI)") | `demo` | image | text_to_image, image_to_image, reference_guided | 1:1, 4:5, 3:4, 2:3, 9:16, 16:9 | — | hd, 4k | negativePrompt ✓, seed ✓, camera ✗, motion ✗, cancel ✓ | none | 512 |
| `demo-motion` ("Demo Motion (not AI)") | `demo` | video | text_to_video, image_to_video, video_extension, scene_continuation | 9:16, 1:1, 16:9 | 3, 5, 8 | hd | negativePrompt ✗, seed ✓, camera ✓, motion ✓, cancel ✓ | none | 512 |
| `replicate-flux-schnell` ("FLUX.1 schnell (Replicate)") | `replicate` | image | text_to_image | 1:1, 4:5, 3:4, 2:3, 9:16, 16:9 | — | hd | negativePrompt ✗, seed ✓, camera ✗, motion ✗, cancel ✓ | none | 0 |

Pricing per model is not declared on the spec; it is derived from `pricing.ts` by output type/quality/duration plus the admin multiplier (section 3). `validateAgainstModel` (`registry.ts:136-178`) rejects unsupported mode, aspect ratio, duration (video only; images reject any duration), quality, negative prompt, seed, camera movement, motion intensity → draft 422 `unsupported_settings` with `details.issues`.

### Mode support matrix (verified from `modes` arrays)

| Spec mode | demo-still | demo-motion | replicate-flux-schnell | Notes |
| --- | --- | --- | --- | --- |
| text-to-image | ✓ | — | ✓ | |
| image-to-image | ✓ | — | — | Demo recolors the upload under the watermark (`demo.ts:71-76`) |
| text-to-video | — | ✓ | — | |
| image-to-video | — | ✓ | — | Demo zoompans the upload |
| video-to-video | — | — | — | **No model supports it**; any draft gets 422 `unsupported_settings` ("does not support video to video"). `MODE_INPUTS` requires 1 video. |
| video extension | — | ✓ | — | **Demo ignores the input clip**: `renderStill` only reads `inputs.find(i => i.kind === "image")` (`demo.ts:69`); the result is a fresh clip from the prompt |
| scene continuation | — | ✓ | — | Same as above |
| reference-guided | ✓ | — | — | `characterReferenceId` is validated at draft (`service.ts:187-198`) but **never loaded by the processor or passed to any adapter** (`grep characterReference src/server/generation/processor.ts src/server/ai/` → no hits). The demo output is identical to text_to_image. |

---

## 8. Demo adapters and `isDemo` labeling

`demo.ts` — single adapter `key: "demo"`, `isDemo: true`, `isConfigured: () => env().ENABLE_DEMO_PROVIDER === "true"` (default `"true"`, `env.ts:19`). It serves both `demo-still` and `demo-motion` (`req.model.output` decides, `demo.ts:115`).
- Still: SVG with seeded HSL gradients from `sha256(prompt|seed)`, caption = first 70 chars of the prompt, bottom band with text `"DEMO OUTPUT · NOT AI-GENERATED"` (`DEMO_WATERMARK`, `demo.ts:16`), rendered by sharp → WebP q88. Long side 1280 (hd) or 2048 (4k). Image-to-image composites the upload at 0.6 saturation under a 55 % alpha overlay of the art.
- Motion: same still, then `ffmpeg -loop 1 ... zoompan ... libx264 -preset veryfast -crf 26 -movflags +faststart -an`, 24 fps, duration `params.durationS ?? 5`, camera presets for "slow push in", "pull back", "pan left/right", "tilt up/down" else a default push (`demo.ts:93-104`). Abort → `ProviderError("timeout", retryable: true)`; missing ffmpeg → `unsupported`; non-zero exit → `internal`.
- `onProviderJobId("demo-" + jobId)` is called first (`demo.ts:112`).

Where `isDemo` is recorded and shown (verified):
- `generation_jobs.is_demo` set from `model.isDemo` (= `adapter.isDemo`) at draft (`service.ts:249`).
- `generation_outputs.is_demo` copied from the job at completion (`processor.ts:212`).
- Download filename gets a `-demo` suffix (`download/route.ts:21`).
- UI: `Badge tone="demo"` in `library.tsx:89`, `creation-detail.tsx:198`, `admin.tsx:109`; explanatory copy in `creation-detail.tsx:189` ("made locally by the development placeholder model, not by an AI model"), `create-panel.tsx:231,671,716`, `projects.tsx:178`, `job-tray.tsx:48,109`, `studio.tsx:88`. Registry display names carry "(not AI)". The watermark is baked into pixels.
- E2E asserts the "Demo" badge and the "Weaving a demo placeholder." toast (`tests/e2e/journey.spec.ts:61,70`).

---

## 9. Replicate adapter and webhook

`replicate.ts` — `key: "replicate"`, `isDemo: false`, `isConfigured: () => Boolean(env().REPLICATE_API_TOKEN)`.
- Input mapping per `providerModel` in `INPUT_BUILDERS` (`:21-30`); only `black-forest-labs/flux-schnell`: `{ prompt, aspect_ratio (default "1:1"), num_outputs: 1, output_format: "webp", seed? }`. Negative prompt is not sent (model declares no support).
- `POST https://api.replicate.com/v1/models/{providerModel}/predictions`, then polls `GET /predictions/{id}` with sleep 1 s × 1.5 up to 8 s until status leaves `starting|processing` (`:78-93`). `onProviderJobId(prediction.id)` right after creation.
- HTTP normalization (`:32-39`): 401/403 → `provider_unavailable` (non-retryable); 404 → `unsupported`; 422 → `invalid_input`; 429 → `rate_limited` (retryable); ≥500 → `provider_unavailable` (retryable); other → `internal`. Network error → `provider_unavailable` retryable; abort → `timeout` retryable.
- On abort during polling it best-effort `POST /predictions/{id}/cancel` then rethrows (`:94-101`).
- Terminal: `canceled` → `cancelled`; `failed` → `content_rejected` if `error` matches `/nsfw|safety|content/i` else `internal`; downloads each output URL (`fetch`, non-ok → `provider_unavailable` retryable); mime from the `content-type` header, dimensions left for `qualityCheck` to fill via sharp.
- **Status (from the file header and `notes/plan.md:143`):** written against the documented API, never run against the live service. No integration test; only the webhook verifier has unit tests (`tests/unit/signatures.test.ts:21-31`).
- **Inference:** a `timeout` from the abort is `retryable: true`, so a provider that overruns `PROVIDER_TIMEOUT_S` is retried up to 3 total attempts, each creating a new paid prediction at Replicate (the previous one is cancelled best-effort). The `sleep` helper adds an abort listener per loop iteration without removing it (`:62-69`); harmless for short polls.

Webhook `POST /api/webhooks/replicate` (`webhooks/replicate/route.ts`):
- `REPLICATE_WEBHOOK_SECRET` unset → **503 `webhook_unconfigured`**.
- Verifies Standard-Webhooks headers `webhook-id`, `webhook-timestamp`, `webhook-signature`: HMAC-SHA256 over `"{id}.{timestamp}.{body}"` with the base64 secret after `whsec_`, ±300 s tolerance, constant-time compare, any `v1,<sig>` part may match (`replicate.ts:116-139`). Bad → **400 `bad_signature`**; non-JSON → **400 `invalid_json`**.
- Looks up the job by `providerJobId`, **logs only**, returns 200 `{received:true}`. It never changes job state or credits (by design, header comment lines 10-14). The adapter does not pass a `webhook` URL when creating the prediction, so Replicate would only call this if configured on their side.

---

## 10. Failure handling and credit release (verified)

- Reserve on confirm (`job:{id}:reserve`); settle on completion; release on fail/cancel/timeout/quality failure/discard. Settle and release share `job:{id}:close`, so a reconcile timeout (T12) racing a late completion (T11) cannot double-close: whichever commits first wins the key, and the T11 guard `status === "processing"` makes the loser discard its files (`processor.ts:192-196`).
- Retry (T7) keeps the reservation; only terminal states move credits (`processor.ts:131` comment).
- Quality check (`processor.ts:21-40`): `< 1024` bytes → fail; images must decode in sharp with width/height ≥ 64; `video/mp4` must have `ftyp` at bytes 4–8; other mimes fail. Failure → `internal`, non-retryable, refund.
- Test coverage (`tests/integration/generation.test.ts`): charges exactly once (:63), insufficient credits (:99), cost mismatch (:108), cancel queued refund (:114), cancel during processing (:126), retryable then exhausted (:141), non-retryable fast fail (:155), hung provider timeout (:167), dead-worker reconcile refund (:180), policy block + moderation event (:193), capability validation (:202), concurrency limit (:210), cross-user isolation (:220), variation seed + lineage (:231), real ffmpeg demo clip (:243). `notes/plan.md:63` reports 79/79 vitest passing at 0987b7c.

---

## 11. Cancellation (verified)

Route: `POST /api/generations/:id/cancel` → `cancelJob` (`service.ts:325-354`). Behavior by state is in T3/T4/T14. During processing: `cancelWatch` polls `cancel_requested` every 2 s and calls `controller.abort()` (`processor.ts:99-102`); adapters receive `ctx.signal` (demo passes it to `spawn`, Replicate to `fetch`/sleep). After the catch, the processor re-reads the flag and rewrites any error as `cancelled` (`:126-128`); after a successful render it still checks the flag and discards (T10). The sharp still render does not observe the signal (**inference**: it is sub-second so a cancel lands via T10). Cancel on a terminal job returns 200 with the unchanged job; `deleteJob` refuses active jobs with **409 `job_active`** (`service.ts:417-419`).

---

## 12. Poster frames (verified)

`poster.ts`: `videoPoster(clip, atSeconds = 0.5)` writes the clip to a temp dir, runs `ffmpeg -ss 0.5 -i in.mp4 -frames:v 1 frame.png`, converts to WebP q82 with sharp, returns `{bytes,width,height}` or **null** on any failure ("a poster is a convenience, never a reason to fail a job"). The processor stores it as a second private `media_assets` row (`kind: "image"`) and links it via `generation_outputs.poster_asset_id` (`processor.ts:172-184`, `schema.ts:427`, migration 0001 per `notes/plan.md:107`). `views.ts:358-359, 390` resolve `posterUrl` with the same signed-URL path as the main asset. `deleteJob` soft-deletes poster assets with the output (`service.ts:427`). Pre-migration clips lack posters (`notes/plan.md:133`, one in dev DB).

---

## 13. Safety and copilot (verified)

`safety/policy.ts`:
- `checkPrompt(...texts)` runs 6 regex rule groups (`minors`, `non_consent`, `real_person`, `bestiality`, `incest`, `extreme_harm`) over both the raw lowercase text and `normalizeForPolicy` (NFKD, strip combining marks, leetspeak `0@4`, joined spaced letters, collapsed triple letters). Called at draft with `prompt`, `negativePrompt`, `params.atmosphere` (`service.ts:169`). Block → `moderation_events` row (`action: "auto_block"`, `reason: category`, `details.matched`) and **422 `policy_blocked`** with `details.category`.
- `ageAssuranceBlocksRegion(method, country, AGE_ASSURANCE_STRICT_REGIONS)` → **451 `age_assurance_required`** when the country (from header `GEO_COUNTRY_HEADER`, default `x-country-code`, `request.ts`) is in the comma list and the user is `self_declaration`.
- Other draft-time guards: unknown model 422 `unknown_model`; unavailable model **503 `model_unavailable`** with the reason; inputs must be the user's own consented upload (403 `consent_required` if no/withdrawn consent) or own output, counts must match `MODE_INPUTS` (422 `input_required` / `input_unexpected`); character ref owned + consent not withdrawn (403 `consent_withdrawn`); template must be published or own, VIP needs `hasVip` (403 `vip_required`); project/scene/parent ownership → 404.

`lib/copilot.ts` (pure, runs client and server): `analyze()` emits `Suggestion{severity: info|warn|block, patch?}` — policy block first, short/long prompt, 6 contradiction pairs, camera-param conflict, unsupported aspect with nearest patch, low-res input (vs `minInputShortSidePx`) and crop warning, warping risk (intensity ≥ 8 and duration ≥ 5), camera suggestion by prompt keywords, negative-prompt ignored, lettering warning, continuity caveat for `scene_continuation`/`video_extension` on `continuity: "none"` models. `interpret(text, model)` maps plain language to `aspectRatio`, `durationS` (snapped to offered), `cameraMovement`, `motionIntensity` (3/8), `pacing`, `lighting`, `framing`, `quality`, reporting `unsupported[]` instead of pretending. Suggestions never auto-apply (patches are returned, not written). Unit tests: `tests/unit/copilot.test.ts`, `policy.test.ts`.

---

## 14. Env vars touched by this pipeline (names and defaults from `env.ts`)

`ENABLE_DEMO_PROVIDER` ("true"), `REPLICATE_API_TOKEN` (unset), `REPLICATE_WEBHOOK_SECRET` (unset), `PROVIDER_TIMEOUT_S` (600), `WORKER_CONCURRENCY` (2), `WORKER_HEALTH_PORT` (unset), `USER_MAX_ACTIVE_JOBS` (3), `REDIS_URL` (`redis://localhost:6379`; vitest uses db 1), `AGE_ASSURANCE_STRICT_REGIONS` (""), `GEO_COUNTRY_HEADER` (`x-country-code`), `STORAGE_DRIVER`/`STORAGE_LOCAL_DIR` for output files, `MEDIA_SIGNING_SECRET`/`MEDIA_URL_TTL_S` (300) for the signed URLs the views return.

---

## 15. Defects and gaps (summary)

Verified:
1. `reference_guided` accepts and validates a character reference but nothing downstream uses it (`processor.ts` never loads `characterReferenceId`; neither adapter reads it). Output equals text-to-image. Spec §4 "reuse character references" is demo-only in name.
2. `video_extension` / `scene_continuation` on `demo-motion` ignore the source clip (`demo.ts:69` filters for image inputs only). The spec allows "where available", but the UI offers Continue/Extend and the result has no relation to the clip.
3. `video_to_video` is in the enum and `MODE_INPUTS` but no model lists it; every attempt is a 422. Acceptable per spec ("where available") but should be disclosed in the verification report.
4. `confirmJob` returns a non-`awaiting_confirmation` job as 200 without checking `expectedCost`; harmless but means a stale confirm never sees the 409.
5. Replicate adapter and webhook are untested against the live service (`notes/plan.md:143`); the webhook is log-only.

Inferences (not reproduced):
6. Reconcile cannot revive a `queued` job whose BullMQ entry `${id}-a${n}` sits in the failed set (worker threw before claim), because BullMQ ignores adds with an existing id; the job stays queued until the failed record is evicted.
7. The per-user active-job count is not serialized across concurrent confirms (count precedes the account-row lock), so the 429 can be bypassed by parallel requests.
8. Replicate `timeout` is retryable, so a slow prediction can be billed up to three times at the provider (prior ones cancelled best-effort).
9. `rateLimit` (`redis.ts:17-22`): if `EXPIRE` fails after the first `INCR`, the window never resets.
