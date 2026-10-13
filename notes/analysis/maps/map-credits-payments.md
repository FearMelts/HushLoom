# Hushloom map: credits, ledger, pricing, Stripe, admin

Read-only survey of `/home/claude/hushloom` at commit `a4752a9` (branch `claude/playbox-2-foundation-q7fpbs`). Everything under "Verified" was read directly from the source; "Inference" sections are my reading of behavior that was not executed here. No file was modified; no npm script was run.

## 1. Files in scope

| Area | Path |
| --- | --- |
| Ledger core | `src/server/credits/ledger.ts` (121 lines) |
| Stripe | `src/server/payments/stripe.ts` (159 lines) |
| Pricing config | `src/config/pricing.ts` (38 lines) |
| Admin service | `src/server/admin.ts` (225 lines) |
| Admin API | `src/app/api/admin/credits/route.ts`, `src/app/api/admin/models/[key]/route.ts`, `src/app/api/admin/reports/[id]/route.ts`, `src/app/api/admin/users/[id]/suspend/route.ts` |
| Checkout API | `src/app/api/checkout/route.ts` (there is no `src/app/api/billing/`) |
| Stripe webhook | `src/app/api/webhooks/stripe/route.ts` |
| Pricing page | `src/app/pricing/page.tsx`, `src/components/pricing.tsx` |
| Admin page | `src/app/admin/page.tsx`, `src/components/admin.tsx` |
| Schema | `src/server/db/schema.ts` lines 48-56 (`ledger_kind` enum), 495-555 (money tables); `drizzle/0000_init.sql` |
| Env | `src/server/env.ts` lines 25-28 |
| Consumers | `src/server/generation/service.ts` (reserve, release on cancel, plan lookup, VIP gate), `src/server/generation/processor.ts` (settle, release on fail/cancel/timeout), `src/server/auth/account.ts` (signup grant), `src/server/create-context.ts`, `src/app/layout.tsx` (balance in shell), `scripts/seed.ts` |
| Tests | `tests/integration/platform.test.ts` lines 74-131 (Stripe webhook), 283-292 (admin adjust); `tests/integration/generation.test.ts` (reserve/settle/release across the state machine); `tests/e2e/journey.spec.ts` lines 44-81 (admin grant via API, balance in UI); `tests/helpers.ts` line 34 (test grant) |

## 2. Data model (verified)

`src/server/db/schema.ts`:

- `credit_accounts` (line 495): `user_id` PK -> `users.id` cascade; `available int default 0`; `reserved int default 0`; `updated_at`. CHECK constraints `credits_available_nonneg` and `credits_reserved_nonneg` (line 503) back the application-level checks at the database.
- `credit_ledger` (line 506): `id`, `user_id` (cascade), `kind` (`ledger_kind` enum), `available_delta`, `reserved_delta`, `available_after`, `reserved_after`, `job_id` -> `generation_jobs.id` set null, `payment_event_id` (uuid, **no FK**, line 517), `idempotency_key text not null`, `note`, `created_at`. Unique index `ledger_idempotency_uq` on `idempotency_key` alone (global, not per user) (line 522). Index `ledger_user_idx (user_id, created_at)`.
- `ledger_kind` enum (line 48): `signup_grant`, `purchase`, `subscription_grant`, `reserve`, `release`, `settle`, `admin_adjust`.
- `subscriptions` (line 526): `user_id`, `plan_key text`, `status text`, `provider_subscription_id text` (unique `subscriptions_provider_uq`), `current_period_end`, timestamps.
- `payment_events` (line 540): `provider text`, `provider_event_id text`, `type text`, `user_id` (set null), `amount_cents`, `currency`, `credits`, `processed_at`, `created_at`. Unique index `payment_events_provider_uq (provider, provider_event_id)` (line 554). This index is the exactly-once mechanism.
- `generation_jobs.cost_credits int not null` with CHECK `jobs_cost_nonneg` (lines 396, 415); `jobs_idempotency_uq (user_id, idempotency_key)` for draft creation.

Migration `drizzle/0000_init.sql` lines 50-68, 196-204, 258-263, 389-391, 438-439, 453, 461 create these objects exactly as above.

## 3. Ledger invariants (verified from `src/server/credits/ledger.ts`)

`applyMovement(tx, m)` (lines 41-69) is documented as "the only function that changes a balance", and every caller in the repo goes through it (`reserveForJob`, `settleJob`, `releaseJob`, `grant()` in stripe.ts, `adjustCredits` in admin.ts, signup grant in `auth/account.ts` line 76, seed at `scripts/seed.ts` line 213, test helper `tests/helpers.ts` line 34). It must be called inside a transaction (`Tx`), never with the root db.

Sequence inside one transaction:
1. `lockAccount` (lines 29-34): `INSERT ... ON CONFLICT DO NOTHING` then `SELECT ... FOR UPDATE` on `credit_accounts` by `user_id`. Serializes all movements per user.
2. Idempotency check (lines 43-48): `SELECT id FROM credit_ledger WHERE idempotency_key = ? LIMIT 1`. If found, returns `{ applied: false, available, reserved }` with the current balances and writes nothing.
3. Computes `available + availableDelta` and `reserved + reservedDelta`. If `available < 0` throws `InsufficientCreditsError(needed=-availableDelta, available)` (line 52). If `reserved < 0` throws a plain `Error("ledger invariant: reserved would go negative ...")` (line 53), which surfaces as HTTP 500 via `route()`.
4. Updates `credit_accounts` and inserts the ledger row with `availableAfter`/`reservedAfter` snapshots (lines 55-67). Both writes share the caller's transaction, so a balance change without a ledger row (or vice versa) cannot commit.

The unique index `ledger_idempotency_uq` is the backstop if two transactions race past the SELECT: the second insert fails and the caller's transaction rolls back. Because the account row is locked first (step 1), concurrent movements for the same user serialize before the SELECT, so in practice the race only exists across different users sharing a key, which the key prefixes prevent.

Idempotency keys in use:

| Movement | Key | Where |
| --- | --- | --- |
| reserve | `job:${jobId}:reserve` | `ledger.ts` line 77 |
| settle (capture) | `job:${jobId}:close` | line 92 |
| release (refund) | `job:${jobId}:close` | line 103 |
| signup grant | `signup:${userId}` | `auth/account.ts` line 81 |
| Stripe pack purchase | `stripe:${event.id}` | `stripe.ts` line 105 |
| Stripe subscription grant | `stripe-invoice:${invoice.id}` | line 134 |
| admin adjust | `admin:${adminId}:${clientKey}` | `admin.ts` line 133 |
| seed | `seed:${userId}` | `scripts/seed.ts` line 213 |
| test helper | `test-grant:${userId}` | `tests/helpers.ts` line 34 |

Reserve / capture / release semantics:
- `reserveForJob` (lines 71-80): `available -= cost`, `reserved += cost`, kind `reserve`. Throws `InsufficientCreditsError` when `available` would go negative. `src/server/http.ts` lines 60-65 map that error to **HTTP 402** `insufficient_credits` with `{ needed, available }`.
- `settleJob` (lines 86-95): `reserved -= cost`, available unchanged, kind `settle`. This is "capture".
- `releaseJob` (lines 97-107): `available += cost`, `reserved -= cost`, kind `release`, with a free-text note.
- Settle and release **share the key `job:${jobId}:close`** (comment lines 82-85), so a job's reservation can close exactly once: a job cannot be both charged and refunded, nor charged twice. Whichever of settle/release runs first wins; the other returns `applied: false`.

Where the movements happen in the job state machine:
- Reserve: `generation/service.ts` `confirmJob` lines 276-300 inside a `FOR UPDATE` transaction on the job, after the `409 cost_changed` check (line 286-288) and the concurrency check (lines 289-295, **HTTP 429** `too_many_active`). A job not in `awaiting_confirmation` returns as-is without reserving (line 285), so repeat confirms are safe.
- Release on cancel: `cancelJob` lines 325-354. `draft`/`awaiting_confirmation` -> cancelled with no ledger movement (nothing was reserved). `queued` -> `releaseJob(... "cancelled before processing")`. `processing` -> only sets `cancelRequested`; the worker releases.
- Worker (`generation/processor.ts`): claim step releases if `cancelRequested` is already set on a queued job (lines 74-77); `finishFailed` (lines 43-58) releases under `FOR UPDATE` only when status is still `processing`, note `cancelled` or `failed: ${code}`; retryable provider errors go back to `queued` with the reservation **held** (lines 133-141, comment "credits move only on a terminal state"); completion transaction (lines 189-226) checks `cancelRequested` once more, releases if set, otherwise inserts outputs and `settleJob`s; `reconcile()` (lines 242-257) fails stuck `processing` jobs through `finishFailed`, which releases.
- `retry` as a relation (`deriveDraft`) creates a new draft with its own job id and therefore its own reservation; it does not reuse the failed job's reservation.

`getBalance` (lines 109-112) returns `{available: 0, reserved: 0}` for users with no account row. `listLedger(userId, limit=50)` (lines 114-121) returns newest first.

Tests covering the invariants (verified to exist, not run by me): `tests/integration/generation.test.ts` lines 63-88 (reserve then settle, ledger kinds `["reserve","settle"]`), 99-106 (402 path leaves job unqueued and balance untouched), 108-112 (409 cost mismatch), 114-124 (cancel queued refunds), 126-139 (cancel during processing refunds), 141-153 (retries then refund once), 155-165, 167-178 (timeout refund), 180-191 (reconciler refund), 210-218 (concurrency cap). `notes/plan.md` reports vitest 79/79 at `0987b7c`.

## 4. Pricing config and cost estimate (verified)

`src/config/pricing.ts` is a `const` object with the header comment "Placeholder economics. None of these numbers come from any existing product; the operator sets real prices here (and per-model multipliers in model_configs)."

- `imageBase: 4`, `videoPerSecond: 3`, `qualityMultiplier: { hd: 1, "4k": 2 }`, `currency: "usd"`.
- Packs: `pack_small` "Spark" 100 credits $9.99; `pack_medium` "Flicker" 550 credits $44.99; `pack_large` "Blaze" 1200 credits $89.99.
- Plans: `plan_member` "Night Pass" 400 credits/month $19.99, `maxActiveJobs: 3`, `vip: true`; `plan_studio` "Studio Pass" 1500 credits/month $59.99, `maxActiveJobs: 6`, `vip: true`.
- `estimateCost(model, params, priceMultiplierPct=100)` at `src/server/ai/registry.ts` lines 181-191: `max(1, ceil(base * qualityFactor * pct / 100))` with base `imageBase` for stills and `videoPerSecond * duration` for clips. The per-model multiplier (`model_configs.price_multiplier`, 10..1000 percent) is set by the admin via `PATCH /api/admin/models/[key]` (`admin.ts` lines 113-123).
- Cost is computed at draft time and stored on the job (`service.ts` line 238, 261); confirm requires the client to echo `expectedCost` and returns 409 `cost_changed` on mismatch. The pricing page copy (line 38) and the create panel (`components/create-panel.tsx` lines 657-728) show the cost before confirmation.

The pricing page states "Prices below are placeholders" only inside the "payments not configured" banner (line 54). With Stripe configured, nothing on the page marks the numbers as placeholders; only the source comment does.

## 5. Stripe checkout (verified)

`POST /api/checkout` (`src/app/api/checkout/route.ts`):
1. `requireUser()` -> 401 if signed out.
2. `paymentsConfigured()` false -> **503** `payments_unavailable`. `paymentsConfigured()` (`stripe.ts` line 13) requires **both** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
3. Redis rate limit `checkout:${userId}` 10 per 600 s -> **429** `rate_limited` (`src/server/redis.ts` lines 18-23, fixed-window INCR/EXPIRE).
4. Body `{ itemKey: string (max 40) }`; unknown key -> **422** `unknown_item` (`stripe.ts` line 25).
5. `createCheckout` (`stripe.ts` lines 22-49): `new Stripe(key)` with SDK `stripe@18.5.0` (`package.json` line 41); session `mode` `subscription` for a plan, `payment` for a pack; `customer_email`, `client_reference_id = user.id`, `metadata { userId, itemKey }` on the session and (for plans) on `subscription_data.metadata`; inline `price_data` with `unit_amount = priceCents`, `recurring { interval: "month" }` for plans; `success_url ${APP_URL}/pricing?checkout=success`, `cancel_url ${APP_URL}/pricing?checkout=cancelled`. Missing `session.url` -> **502** `checkout_failed`. Returns `{ url }`.
6. Client `BuyButton` (`components/pricing.tsx`): signed-out click routes to `/auth?next=/pricing`; signed-in with `configured=false` the button is `disabled` with a title tooltip; otherwise POSTs and `window.location.assign(url)`.

No Stripe Products/Prices are created or referenced; every checkout uses ad-hoc `price_data`. No Stripe customer record is created or stored; the `subscriptions` table keys only on `provider_subscription_id`. There is no customer portal, cancel-subscription, or refund endpoint anywhere in `src/app/api`.

## 6. Stripe webhook and exactly-once processing (verified)

`POST /api/webhooks/stripe` (`src/app/api/webhooks/stripe/route.ts`): reads `req.text()` raw, `verifyStripeEvent(raw, stripe-signature header)`, then `processStripeEvent(event)`, returns `{ received: true, outcome }` with 200.

The origin-check middleware (`src/middleware.ts` line 10) explicitly exempts `/api/webhooks/` from the Origin check, so Stripe (which sends no Origin) is not refused with 403.

`verifyStripeEvent` (`stripe.ts` lines 52-62): no `STRIPE_WEBHOOK_SECRET` -> **503** `payments_unavailable`; no header -> **400** `bad_signature`; `constructEvent` failure -> **400** `bad_signature`. It constructs `new Stripe(STRIPE_SECRET_KEY ?? "sk_unused")` because signature verification is offline.

`processStripeEvent` (lines 79-159) runs in one `getDb().transaction`:
1. `INSERT INTO payment_events (provider='stripe', provider_event_id=event.id, type) ON CONFLICT DO NOTHING RETURNING`. No row returned -> returns `"duplicate"` immediately (line 86). This is the exactly-once gate; it rests on `payment_events_provider_uq`.
2. `checkout.session.completed`: requires `metadata.userId` and `metadata.itemKey`, otherwise `"ignored"`. For `mode === "payment"` with a known pack: `payment_status !== "paid"` -> `"ignored"` (the event row still commits, so a later `paid` state for the same event id would also be a duplicate; Stripe sends a separate `checkout.session.async_payment_succeeded` for that case, which this switch does not handle, see gaps). Paid -> `grant()` with key `stripe:${event.id}` kind `purchase`, then fills `user_id, amount_cents, currency, credits` on the event row. For `mode === "subscription"` with a known plan and string `subscription`: upsert `subscriptions` on `provider_subscription_id` with `status 'active'`; no credits granted here.
3. `invoice.paid`: finds the subscription id from `invoice.subscription` or `invoice.parent.subscription_details.subscription` (API 2025 shape). Unknown subscription -> **throws** (line 132), which rolls back the whole transaction including the `payment_events` row, so Stripe's 500 triggers a retry later; the test at `platform.test.ts` lines 113-131 asserts status 500 then success after the checkout event arrives. Known -> `grant()` with key `stripe-invoice:${invoice.id}` kind `subscription_grant` for `plan.monthlyCredits`.
4. `customer.subscription.updated` / `.deleted`: updates `status` (forced to `canceled` on delete) and `current_period_end` (from `items.data[0].current_period_end` or top-level) for the matching `provider_subscription_id`. Nothing happens if the row does not exist yet (no error, no retry).
5. Any other type -> `"ignored"`.
6. Sets `processed_at = now()`, writes an audit row `payment.${event.type}` with actor `null` (line 155), logs, returns the outcome.

Because the `payment_events` insert, the ledger movement, and `processed_at` all commit in the same transaction, a crash mid-way leaves no event row, and Stripe's retry processes it fresh. The handover note in `notes/plan.md` line 95 describes this same design.

Verified tests (`platform.test.ts` lines 74-131): duplicate delivery grants once (`outcome: "duplicate"`, one `purchase` ledger row, balance 100); forged signature -> 400 and balance 0; unpaid checkout -> `"ignored"`; invoice-before-subscription -> 500 then processed, third delivery duplicate, balance 400, subscription `active`. Tests sign locally with `STRIPE_WEBHOOK_SECRET=whsec_local_test_secret` from `vitest.config.ts` lines 16-17; nothing reaches Stripe.

## 7. Behavior without `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (verified)

`src/server/env.ts` lines 27-28: both are `z.string().optional()`; the app starts without them. `notes/plan.md` line 55: "No real provider, Stripe or S3 credentials have ever been present; those paths are untested live."

- `/pricing` renders a brass banner (`page.tsx` lines 52-56): "Payments are not connected on this server, so buying is switched off. The operator enables it by setting STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Prices below are placeholders." Buy buttons are disabled for signed-in users.
- `POST /api/checkout` -> 503 `payments_unavailable` (checked before rate limit and body parse).
- `POST /api/webhooks/stripe` -> 503 if `STRIPE_WEBHOOK_SECRET` is unset, regardless of the secret key.
- With only `STRIPE_SECRET_KEY` set, `paymentsConfigured()` is still false (checkout 503, banner shown) while the webhook still 503s. With only the webhook secret set, the webhook verifies and processes but checkout stays 503.
- Credits can still enter the system through: `SIGNUP_GRANT_CREDITS` (default 0; `auth/account.ts` lines 74-83, kind `signup_grant`, key `signup:${userId}`), the admin adjust path (section 9), and the seed (200 credits for `demo@hushloom.local`).

## 8. Plan entitlements: VIP and concurrency (verified)

`activePlan(userId)` (`service.ts` lines 82-95): selects `subscriptions` rows for the user with `status IN ('active','trialing')` and (`current_period_end IS NULL` OR `> now()`), maps to `pricing.plans`, and returns the one with the largest `maxActiveJobs`. Rows whose `plan_key` is no longer in `pricing.plans` are dropped. `hasVip(userId)` (line 97, exported at line 101) is `Boolean(activePlan()?.vip)`.

Note: `current_period_end` is only ever written by `customer.subscription.updated/deleted` (stripe.ts line 148). After `checkout.session.completed` alone it is `NULL`, so the plan counts as active indefinitely until Stripe sends an update or delete event. Status `past_due`, `unpaid`, `incomplete`, `paused` and `canceled` all exclude the plan.

VIP gate:
- Server: `createDraft` (`service.ts` lines 207-209) throws **403** `vip_required` ("This is a VIP template. A pass unlocks it.") when `templates.is_vip` is true, the viewer is not the creator, and `hasVip` is false. Any user can still *view* a VIP template; only generation from it is gated.
- UI: `src/app/templates/[id]/page.tsx` line 38 computes `locked = t.isVip && !ctx.vip && !data.own`; `createContext` (`create-context.ts` line 16, 33) passes `vip` to the create panel; template cards show a brass `VIP` badge (`template-card.tsx` line 90, `ui.tsx` line 61). Creators set `isVip` when publishing (`templates/publish.ts` lines 28, 108, 183); nothing restricts who may mark a template VIP.
- Discovery filter `vipOnly` (`discovery/templates.ts` lines 136, 157).

Concurrency: `confirmJob` line 277 uses `maxActive = max(USER_MAX_ACTIVE_JOBS (default 3), plan.maxActiveJobs ?? 0)`. Counts jobs with status `queued` or `processing` (`ACTIVE`, line 79) inside the locked transaction; at or over the cap -> **429** `too_many_active`. With default env, `plan_member`'s 3 equals the free cap, so Night Pass's "3 generations at once" perk adds nothing unless the operator lowers `USER_MAX_ACTIVE_JOBS` (inference: the perk text in `pricing.ts` line 20 would then be misleading relative to the free tier).

`WORKER_CONCURRENCY` (default 2, `env.ts` line 23) is the BullMQ worker concurrency and is unrelated to plans.

## 9. Admin credit grant path (verified)

`POST /api/admin/credits` (`src/app/api/admin/credits/route.ts`): `requireAdmin()` returns **404** (not 403) for non-admins (`http.ts` lines 29-33, "so the route does not advertise itself"); the admin page does the same with `notFound()` (`admin/page.tsx` line 32).

`adjustSchema` (`admin.ts` lines 118-123): `account` 3..200 chars (email or handle, leading `@` stripped, matched with `lower()`), `amount` int in [-100000, 100000] and non-zero, `reason` 3..200 ("Say why."), `idempotencyKey` 8..100 chars. Validation errors -> 422 `invalid_input` via ZodError mapping.

`adjustCredits` (lines 126-147): looks up a non-deleted user by email or handle (join on `user_profiles`); none -> **404** `not_found` "No account with that email or handle." Then one transaction: `applyMovement` kind `admin_adjust`, `availableDelta = amount`, key `admin:${adminId}:${idempotencyKey}`, `note = reason`; an audit row `credits.adjust` on target `user` only when `applied`. Returns `{ handle, applied, available, reserved }`. A negative amount larger than `available` throws `InsufficientCreditsError` -> 402 (test at `platform.test.ts` line 291). Adjustments never touch `reserved`.

The key is scoped per admin, so two admins reusing the same client key do not collide; the same admin replaying the same key is a no-op (`applied: false`, test lines 283-290).

UI: `CreditAdjust` (`components/admin.tsx` lines 139-175) generates a `crypto.randomUUID()` key on mount (`lib/api.ts` line 30), sends `{ account, amount, reason, idempotencyKey }`, and rotates the key only after success, so a retried failed submit reuses the key. The reason is shown to the user in their credit history (`pricing/page.tsx` line 130).

The e2e journey (`journey.spec.ts` lines 46-49) grants 40 credits through this API as the seeded admin with an `Origin` header and then asserts the shell balance.

Other admin endpoints in the same module: `PATCH /api/admin/models/[key]` (`enabled`, `priceMultiplierPct` 10..1000), `POST /api/admin/reports/[id]` (`remove`/`dismiss`), `POST /api/admin/users/[id]/suspend` (sets `status='suspended'`, destroys sessions). All audited.

## 10. Purchase history and balance display (verified)

- There is no dedicated purchase-history endpoint or table view. The "Credit history" section of `/pricing` (`page.tsx` lines 110-146) lists the last 40 `credit_ledger` rows via `listLedger(user.id, 40)` with human labels from `KIND_LABEL` (line 16-24: Welcome credits, Purchase, Pass credits, Held for a creation, Returned, Spent, Adjustment), the note, `availableDelta` (and `reservedDelta` as "(n held)"), and `availableAfter`. Purchases therefore appear as `purchase` / `subscription_grant` ledger rows with notes like "Spark pack" or "Night Pass monthly credits". Amounts paid (`amount_cents`) are stored on `payment_events` but are not shown to the user anywhere.
- Balance surfaces: `/pricing` cards for `available`, `reserved` ("Held for running creations") and the active plan label (lines 58-75, `data-testid="pricing-balance"`); the shell `CreditPill` shows `available` only (`layout.tsx` line 26, `shell.tsx` lines 38-50, `data-testid="credit-balance"`); the create panel shows balance, cost, and balance-after and disables confirm when short (`create-panel.tsx` lines 657-728).
- `GET /api/me` (`me.ts` `settingsFor`) does **not** include balance, ledger, or subscription; there is no JSON endpoint for balance or ledger at all. Clients get the balance only through server-rendered pages. `/api/me/history` is discovery history, not purchases.
- Admin stats (`admin.ts` lines 25-73): `revenueCents30d` and `creditsSold30d` sum `payment_events.amount_cents`/`credits` over 30 days (counts every event row with an amount, including subscription checkout rows that carry `amount_total` but no credits); `creditsSpent24h` sums `-reserved_delta` of `settle` rows.

## 11. Observations and gaps

Verified from code unless marked inference.

1. **`credit_ledger.payment_event_id` has no foreign key** (`schema.ts` line 517; no ALTER in `0000_init.sql`). Integrity between ledger and payment events is by convention only. Low severity.
2. **`checkout.session.completed` with `payment_status` other than `paid` is recorded and ignored**, and `checkout.session.async_payment_succeeded` is not handled (switch at `stripe.ts` lines 88-152). Inference: delayed-notification payment methods (bank debits, some wallets) would never grant credits, with no retry because the event row commits as `ignored`. Card payments are `paid` at completion, so the default flow works. Medium if non-card methods are enabled in Stripe.
3. **Subscription renewals depend on `invoice.paid`**, and the first `invoice.paid` for a new subscription can precede `checkout.session.completed`; the code throws to make Stripe retry (lines 126-133). Verified by test. Retrying with a 500 is intentional but means Stripe's dashboard shows failed deliveries during the race.
4. **`current_period_end` is NULL after checkout** until a `customer.subscription.updated` arrives; `activePlan` treats NULL as open-ended. Inference: if the operator's webhook endpoint is not subscribed to `customer.subscription.*` events, a cancelled or lapsed subscription keeps VIP and the concurrency bump forever. `invoice.payment_failed` is also unhandled, so a subscription in `past_due` still counts as active until Stripe sends the status change.
5. **No Stripe customer id stored, no portal, no cancel endpoint, no refund handling** (`charge.refunded`, `charge.dispute.created` are ignored). A refunded pack keeps its credits. Spec line 54 asks for "failed-generation reimbursement rules" (covered by release) but the product also lacks any operator path to claw back credits except a negative admin adjustment, which fails with 402 if the user already spent them.
6. **Plan concurrency perk vs free cap**: with `USER_MAX_ACTIVE_JOBS=3` (default), `plan_member.maxActiveJobs=3` grants nothing extra (`service.ts` line 277). Operator configuration matter, but the perk copy in `pricing.ts` line 20 promises it.
7. **Prices are placeholders only in source and in the not-configured banner.** Once Stripe is configured the page shows the placeholder dollar amounts with no marker. `pricing.ts` is a compile-time constant; there is no env or DB override for pack/plan prices (model multipliers are DB-backed). The spec asks for "configurable prices and limits".
8. **Subscription `checkout.session.completed` with a non-string `subscription`** (expanded object) is ignored (line 110 requires `typeof s.subscription === "string"`). Stripe sends a string id unless `expand` is used, which this code does not request. Inference: fine in practice.
9. **Rate limit on checkout** is a fixed window of 10 per 10 minutes per user (`redis.ts`). The webhook route has no rate limit, which is correct for Stripe.
10. **Ledger idempotency key is globally unique**, not per user (`ledger_idempotency_uq`). All keys carry a prefix and id, so collisions are not possible from current callers; a future caller using a bare client-supplied key could collide across users and would get a silent `applied: false`.
11. **Admin adjust applies to deleted users?** No: the lookup filters `isNull(users.deletedAt)` (line 132). Suspended users can still be adjusted (status not checked).
12. **The admin page has no view of a user's ledger, balance, subscription, or `payment_events`**; the only money widgets are the two 30-day stats and the adjust form. There is no per-user lookup. Spec line 54 "purchase history" is satisfied only from the user's own `/pricing` ledger table.
13. **`reserved` can only go negative through a programming error**; the message is a plain `Error` -> 500. The DB CHECK constraints would also reject it. This is defensive and fine.
14. **Audit row for Stripe events uses `actorId = null`** (line 155); the admin audit table renders this as "system" (`admin/page.tsx` line 71).
15. **Tests**: webhook and ledger behavior are covered by integration tests signed with a fake secret; `createCheckout` (the only code that talks to Stripe's API) has no test and has never run against Stripe (`notes/plan.md` lines 55, 145).

## 12. Quick reference: status codes

| Route | Condition | Status / code |
| --- | --- | --- |
| `POST /api/checkout` | signed out | 401 `unauthorized` |
| | Stripe env missing | 503 `payments_unavailable` |
| | >10 attempts / 600 s | 429 `rate_limited` |
| | unknown `itemKey` | 422 `unknown_item` |
| | Stripe returned no URL | 502 `checkout_failed` |
| `POST /api/webhooks/stripe` | no `STRIPE_WEBHOOK_SECRET` | 503 `payments_unavailable` |
| | missing/invalid signature | 400 `bad_signature` |
| | invoice before subscription | 500 `internal` (intentional retry) |
| | ok | 200 `{received, outcome: processed/duplicate/ignored}` |
| `POST /api/admin/credits` | non-admin | 404 `not_found` |
| | account not found | 404 `not_found` |
| | schema failure | 422 `invalid_input` |
| | negative beyond available | 402 `insufficient_credits` |
| `POST /api/generations/[id]/confirm` (via `confirmJob`) | cost mismatch | 409 `cost_changed` |
| | too many active | 429 `too_many_active` |
| | insufficient credits | 402 `insufficient_credits` |
| `POST /api/generations` (draft) | VIP template without pass | 403 `vip_required` |
