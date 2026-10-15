# Hushloom Information Architecture

Deliverable C of the Hushloom spec (Part XIV): the sitemap, routes and object relationships at commit `09a436e` (notes/progress.md). Every route below exists under `src/app`; anything else is marked **planned**.

Naming: the spec's "Collection" is **Library** in the UI, at `/collection`. "Train" manages character references; nothing is trained on them. Playbox informs structure and interaction patterns only; Hushloom's look is its own.

Status words:

- **Operational**: runs as built. Verified at `09a436e` on a fresh install: typecheck and lint clean, vitest 507 tests in 45 files, `next build` exit 0 (notes/evidence/clean-verify-09a436e.log). Playwright: 72 tests, 40 passed, 32 skipped (visual captures, `VISUAL_REVIEW=1` only), 0 failed (notes/evidence/e2e-09a436e.log).
- **Demo**: AI generation. Without a provider key, demo models make labeled placeholders.
- **Sandbox / dev**: payments, age verification and scanning run labeled stand-ins until the owner opens accounts.
- **Off until keys**: push, until VAPID keys are set.
- **Unverified**: written from public docs, never run against the real service: CCBill, Segpay, live Stripe, Yoti, PhotoDNA, Cloudflare, Replicate, push delivery, device install.
- **Results** are verified, implemented but not verified, blocked or not done. **Verified**: the phase 4 visual review (223 screenshots of every main page and state, You sheet included, at 390, 820 and 1440 px; 43 defects fixed; none new on a second capture; notes/analysis/visual/visual-review.json) and `tests/e2e/layout.spec.ts` in every e2e run (main routes fit 390 and 820 px for a visitor and a member, with 40 px primary targets at 390). **Implemented but not verified**: `error.tsx` (never captured).

## 1. Sitemap and page route table

### 1.1 Access levels

| Level | Rule |
|---|---|
| Anyone | Every visitor past the age notice. |
| Member | Signed out, a server 307 to `/auth?next=<path>`. On `/collection`, `/projects` and `/favorites` a skeleton has already streamed a 200, so the browser follows it. |
| Owner | A malformed, missing or other member's id is the same 404. |
| Admin | Everyone else, signed out included, gets the 404 page. |
| Age | Where a provider check is required and missing (section 7.1), media is withheld, and creating, uploading, downloading and publishing return 451. |

The age notice is not a route. `src/app/layout.tsx` shows it instead of the shell only when there is no session, no `hl_age_ok` cookie and the path is not under `/policies`; `/offline` renders bare. "I am 18 or older, enter" sets a 30-day cookie (`POST /api/age-gate`); the notice says it is not age verification. Until a visitor passes it, pages and `GET /api/templates` carry no media URLs (src/server/age/access.ts).

### 1.2 Pages

The folder under `src/app` follows the path when they differ. **age** in the Who column: a viewer who needs the check and lacks it sees no media there, on member pages their own ("Verify your age to see this").

| Path (folder) | Purpose | Who | Missing, private, signed out | Primary actions | Entry points | Exits |
|---|---|---|---|---|---|---|
| `/` (`(home)`) | Home gallery: Trending tonight, Categories, New; signed in also For you, Continue exploring, Your favorites, Following | Anyone; age | 200 | Make, favorite, preview | Wordmark, Discover, 404 and error pages, `/offline` | Templates, creators, `/explore`, `/favorites`, `/generate/{kind}`, `/settings#discovery` |
| `/explore` | Search and browse published templates | Anyone; age | 200 | Sort, media, VIP, category, search | Top-bar search, tab bar Search, Home rails, tags | Templates, creators |
| `/templates/{slug}` (`templates/[id]`) | Template with the Create panel, versions, related rails | Anyone; age. VIP, no pass, not yours: panel locked, prompt and settings not sent | 404 if missing, or not published and not yours | Make it, follow, rate, report, Manage (owner) | Cards (Make opens `#make`), "Remix of", creation page, admin reports | Creator, `/explore`, `/pricing`, `/train`, `/studio`, `/settings#age-verification`, `/policies/takedown?target=` |
| `/generate/image`, `/generate/video` (`generate/[kind]`) | Blank or prefilled creation | Anyone; Make needs a member and, where required, the check | Other kinds: 404 | Make it, switch kind, preset, upload with consent | Create (rail, top bar, "+"), Home, Remix, scenes, Train | `/explore`, `/collection`, `/studio`, `/train`, `/auth`, `/settings#age-verification` |
| `/studio` | Every control, presets, job monitor | Member; age (job monitor data, which shows text only) | 307 to auth | Seed, negative prompt, project placement, presets | Rail, You sheet, panel link | `/collection/{id}` |
| `/collection` (`collection/(list)`) | Library: every creation you made | Member; age | Browser redirect | Filter (one row: chips, More filters, selects), select, bulk delete, folders, Retry | Library tab, toasts, 404 page, app shortcut | `/collection/{id}`, `/projects`, `/settings#age-verification` |
| `/collection/{jobId}` (`collection/[id]`) | One creation: media, settings, lineage, compare; screen-reader h1 "Creation" or "Creation from {template}" | Owner; age | 307 to auth; 404 if malformed, missing or not yours | Remix, Retry, Variation, Continue, Extend, Reuse, Save, Download, Folder, Preset, Publish, Delete, Cancel | Library, tray, toasts, push, Studio, takes | `/generate/{kind}?from=`, template, project, `/collection`, `/settings#age-verification` |
| `/favorites` | Saved templates; creations at `?tab=creations` | Member; age | Browser redirect | Open, unfavorite | Rail, You sheet, Home "All saved" | Templates, creations, `/explore` |
| `/projects` (`projects/(list)`) | Project index: Demo-badged covers, scene and finished-take counts | Member; age (covers) | Browser redirect | New project | Rail, You sheet, Library | `/projects/{id}` |
| `/projects/{id}` (`projects/[id]`) | Scene workspace: timeline, continuity guide, takes | Owner; age (covers, takes) | 307 to auth; 404 if malformed, missing or not yours | Edit scenes and guide, Make, Use as take, Branch, Continue, Compare, Play sequence | Index, creation "in {project}" | `/projects`, `/generate/{kind}?scene=`, `/collection/{id}` |
| `/train` | Character references with recorded consent | Member; age (photos) | 307 to auth | Add (photo, two consents), Remove, Make a still | Rail, You sheet, panel link | `/generate/image?character={id}` |
| `/creators/{handle}` (`creators/[id]`) | Published templates, public collections; the owner also sees "Your templates" (stacked on phones, actions in view) and private collections | Anyone; age | 404 if unknown, suspended or deleted | Follow; owner edits or unpublishes | Card handles, creator rows, profile row (rail, You sheet) | Templates |
| `/settings` | Profile, discovery, consents, `#age-verification`, `#device`, account | Member | 307 to auth | Edit, withdraw consent, Verify now, install, notifications, sign out everywhere, delete account | Rail, You sheet, Home "Tune", 451 and withheld-media verify links | `/verify/sandbox` or the provider, `/auth` |
| `/pricing` | Credits and passes; ledger and payment history when signed in | Anyone; buying needs a member | 200 | Buy a pack or pass | Credit pill, You sheet, VIP lock, short-balance line | Processor or `/pricing/sandbox` |
| `/pricing/sandbox` | Sandbox processor: "No money moves" | Member, payment sandbox on a non-live site | 307 to `/auth?next=/pricing`; else 307 to `/pricing` | Complete, Fail; refund, chargeback, renew, cancel | Checkout link (`?t=`, 30 minutes) | `/pricing?checkout=` |
| `/verify/sandbox` | Sandbox age check, "proves nothing" | Owner of a pending sandbox check | 404 when live, with another provider, or for a bad `ref`; 307 to auth; a finished check goes to Settings | Send a signed verified or failed result | Settings "Verify now" | `/settings#age-verification` |
| `/auth` | Sign up or sign in | Anyone; members go to `next` | 200 | Sign up (section 8), sign in | Member redirects, Join or sign in | `next` (default `/`) |
| `/admin` | Stats, reports, models, credits, flags, audit log | Admin | 404 | Remove or dismiss reports, suspend, price models, adjust credits, clear flags | Rail shield, You sheet | `/admin/review`, templates |
| `/admin/review` | Scanner matches, takedowns (100 a page), closed cases | Admin | 404 | Confirm or clear a match, take down or dismiss | `/admin` | `/admin`, `?takedowns={offset}`, templates |
| `/policies` | Policies with anchors | Anyone; no age notice | 200 | Read | Age notice, rail footer, You sheet, signup | `/policies/takedown` |
| `/policies/takedown` | Takedown form, no account needed | Anyone; no age notice | 200 | Submit (email if signed out) | Age notice, `/policies#abuse`, report sheet | `/policies` |
| `/offline` | Service-worker fallback, no shell | Anyone, offline | 200 | Try again, Go to Discover | Service worker | The failed page, `/` |

### 1.3 Route groups, loading, error and not-found

Route groups do not change URLs. `(home)`, `collection/(list)` and `projects/(list)` exist so a loading boundary wraps only the list page: a page under one has already streamed a 200 when it calls `notFound()` or `redirect()`, so it cannot answer 404 or 307 (src/app/(home)/loading.tsx).

| File | Behavior |
|---|---|
| `loading.tsx` in `(home)`, `explore`, `favorites`, `collection/(list)`, `projects/(list)` | Skeletons: Home's hero and grid, Explore's tabs, chips and grid, a header and grid elsewhere. |
| `error.tsx` | "A thread snapped" in the shell; Try again, Back to Discover; only the digest shows. |
| `global-error.tsx` | The root layout failed: standalone page; Try again reloads. |
| `not-found.tsx` | Every 404: "A loose thread", missing or private. Exits: `/`, `/collection`. |

## 2. Navigation model

`src/components/shell.tsx` defines the lists. **Primary**: Discover `/` (active on `/`, `/explore*`, `/templates*`), Create `/generate/image`, Library `/collection`, Train `/train`. **Go deeper**: Projects, Studio, Favorites.

| Surface | Where | Contents |
|---|---|---|
| Desktop rail | 1024 px and up | Wordmark, primary, Go deeper. Footer: New creation (`/generate/video`), credit pill, admin shield, Settings, Sign out, profile row; signed out, Join or sign in; always Pricing and policies links. |
| Top bar | All widths | Wordmark below 1024 px; search from 640 px, submitting to `/explore?q=`; credit pill below 1024 px; Create (signed in) or Sign in; offline banner. |
| Mobile tab bar | Below 1024 px | Discover, Search (`/explore`), center "+" (`/generate/image`), Library, then You (signed in) or Sign in. |
| "You" sheet | Below 1024 px, from the You tab | Profile row, credits row (`/pricing`), Favorites, Projects, Studio, Train, Settings, Pricing, Policies, Admin (admins), Sign out. |
| Job tray | Signed in, all widths | Running creations, each linking to `/collection/{id}`; polls every 3 s (15 s hidden, paused offline). |
| Template Make bar | Below 1024 px, template pages | "Make it · N credits", with a DEMO label on demo models; links to `#make`. |

Below 1024 px, main's bottom padding adds the tray's and Make bar's heights (`--tray-h`, `--dock-h`), so the last controls scroll clear of them.

Open defect, not done: the top-bar Create button, meant for desktop only, also shows at phone width (phase 4 capture `visual/after/phone-member-library.png`). Cause: `buttonClass` already includes `inline-flex`, and `cn` is plain `clsx`, which merges nothing (src/lib/cn.ts).

Sign out (rail icon, You sheet) calls `POST /api/auth/logout`, drops this device's push subscription and reloads `/`. Sign out everywhere (`/settings`) ends every session.

Studio is never required, and Pricing is never an interstitial.

## 3. Relationship map

| From | To | Through |
|---|---|---|
| Home, Explore | Template | Card, or its Make button (`#make`) |
| Any card or template | Creator | Handle on the card or creator row |
| Template | Generate | The Create panel on the page; the draft records the template version |
| Template | Explore, Template | Category badge (`?category=`), tags (`?q=`), "More in #tag", "You might also like", "Remix of" (shown only while the source is published) |
| Generate | Library | Confirm queues a job; the toast, tray, completion toast and push open it |
| Library | Generate | Remix (`?from=`, new seed), Reuse settings (`&reuse=exact`) |
| Library | Library | Retry, Variation, Continue, Extend: derive, cost sheet, confirm |
| Library | Template, Creator | Publish a finished, scan-clean creation not made from an upload or character; refusals in section 5 |
| Library | Projects, Studio, Favorites, Folders | "in {project}" line; Preset sheet; Save; Folder sheet |
| Projects | Generate | Make a clip or still: `?scene=` carries continuity note, lighting, framing, character and studio mode |
| Projects | Library | Take cards; every take is a creation |
| Train | Generate, Projects | Make a still (`?character=`); continuity guide Character select |
| Studio | Library | Job monitor rows |
| Settings | Home, Create panel | Personalization, interests, history and autoplay shape Home; the assistant toggle only filters panel suggestions (rules-based, not AI) |

## 4. Object model with URLs

| Object | Table | Canonical URL; notes |
|---|---|---|
| Template | `templates` | `/templates/{slug}`; statuses draft, published, unpublished, removed. |
| Template version | `template_versions` | History on the template page; a prompt edit makes the next version. |
| Creation (job) | `generation_jobs` | `/collection/{jobId}`; template, project, scene, parent, relation. |
| Output, media asset | `generation_outputs`, `media_assets` | `/api/media` links, `/api/generations/{id}/download`; served only when `scan_status` is `clean`. |
| Project | `projects` | `/projects/{id}` |
| Scene | `project_scenes` | `/projects/{id}?scene={sceneId}`; holds the continuity guide. |
| Take | `scene_versions` | Under its scene; one per job; branch label; selected flag. |
| Character reference | `character_references` | `/train`; consent records; scanned photo. |
| Preset | `saved_presets` | `/studio?preset={id}&kind=` |
| Folder | `folders`, `folder_items` | `/collection?folder={id}` |
| Library | No table | `/collection`; a view over jobs, outputs, favorites and folders. |
| Favorite | `favorites` | `/favorites?tab=`; template or creation. |
| Creator | `users`, `user_profiles`, `creator_profiles` | `/creators/{handle}` |
| Template collection | `template_collections` | Rails on the creator page; no UI to create one (planned). |
| Consent record | `consent_records` | `/settings` Consents; withdrawal deletes dependent content. |
| Age verification | `age_verifications`, `users` status | `/settings#age-verification`; unverified, pending, verified, failed, expired. |
| Payment event, pass, ledger | `payment_events`, `subscriptions`, `credit_ledger` | `/pricing` |
| Account flag | `account_flags` | `/admin` flags panel, `/admin/review`; chargeback, csam_match, manual_review, credit_debt. |
| Escalation | `moderation_events` | `/admin/review` |
| Takedown request | `takedown_requests` | `/policies/takedown`, `/admin/review?takedowns={offset}`; open, actioned, dismissed. |
| Push subscription | `push_subscriptions` | `/settings#device`; one per device, tied to the session. |

## 5. API route inventory

56 route files under `src/app/api`. Auth: **anon** (anyone), **member** (401 when signed out), **owner** (404 when malformed, missing or not yours), **admin** (401 signed out, 404 for non-admins), **signature** (webhooks and media links). **age**: 451 `age_verification_required` for a member who needs the check and lacks it (src/server/age/gate.ts).

For every row: a cross-origin POST, PUT, PATCH or DELETE gets 403 `bad_origin` (src/middleware.ts; webhooks exempt, upload routes check it themselves). Every rate-limited route answers 503 `unavailable` while Redis is down (src/server/redis.ts). "Per IP" limits key on the client address only when `TRUSTED_PROXY_HOPS` is 1 or more; at the default 0 every visitor shares one key, so those limits apply site-wide (src/server/request.ts).

| Domain | Method and path | Auth and limits |
|---|---|---|
| Infrastructure | GET `/api/health`; GET `/api/media?k&e&s[&d]` (Range support) | anon; signed link |
| Age notice, auth | POST `/api/age-gate`, `/api/auth/logout` | anon, no limit |
| | POST `/api/auth/signup`, `/api/auth/login` | anon; signup 10/h per IP; login 30/15 min per IP and 10/15 min per account |
| Age verification | POST `/api/age-verification/start` | member, 10/h |
| | GET `/api/age-verification/return` | member (else `/auth`); always redirects to Settings |
| | POST `/api/webhooks/age-verification/{provider}` | signature of the active provider |
| Account | GET, PATCH `/api/me`; PATCH `/api/me/preferences`; DELETE `/api/me/history`, `/api/me/sessions` | member |
| | DELETE `/api/me` | member, password; shares the 10/15 min per-account budget with sign-in |
| | DELETE `/api/me/consents/{id}` | owner |
| Uploads, Train | POST `/api/uploads` (multipart, consent required) | member, age, 40/h |
| | GET, POST `/api/characters` | member; GET withholds photos (age); POST age, 10/h |
| | DELETE `/api/characters/{id}` | owner |
| Generation | GET `/api/generations` (`?active=1` for the tray) | member; media withheld (age) |
| | POST `/api/generations` (draft) | member, age; 30/min |
| | POST `.../{id}/derive` | owner, age; no rate limit |
| | POST `.../{id}/confirm` | owner, age; 409 `cost_changed`, 429 `too_many_active` |
| | GET `.../{id}/download` (302 to a signed link) | owner, age |
| | GET, DELETE `/api/generations/{id}`; POST `.../cancel` | owner; DELETE of a queued or running job is 409 `job_active` |
| Templates | GET `/api/templates` (browse; media withheld per viewer) | anon |
| | POST `/api/templates` (publish) | member, age; 409 `not_ready`, `no_output`, `not_cleared` or `taken_down`; 403 `personal_media` or `creator_suspended`; 422 `policy_blocked` |
| | POST `/api/templates/{id}/rate`, `/api/templates/{id}/report` | member; report 20/h |
| | PATCH `/api/templates/{uuid}` | owner or admin; 403 `creator_suspended` |
| Social | POST, DELETE `/api/favorites`, `/api/follows` | member |
| Library | GET, POST `/api/folders`, `/api/presets` | member |
| | DELETE `/api/folders/{id}`, `/api/presets/{id}`; POST `/api/folders/{id}/items` | owner |
| Projects | GET, POST `/api/projects` | member |
| | GET, PATCH, DELETE `/api/projects/{id}`; POST, PUT `/api/projects/{id}/scenes`; PATCH, DELETE `/api/scenes/{id}`; POST `/api/scenes/{id}/select` | owner |
| Payments | POST `/api/checkout` | member, 10 per 10 min; 503 when no processor; 403 for chargeback-flagged accounts |
| | POST `/api/pricing/sandbox` | member, sandbox only |
| | POST `/api/webhooks/payments/{provider}` (sandbox, ccbill, segpay, stripe); POST `/api/webhooks/stripe` (delegates) | processor signature; CCBill also needs `?token=` (`CCBILL_WEBHOOK_TOKEN`) and, on sales, a matching `dynamicPricingValidationDigest` (src/server/payments/providers/ccbill.ts) |
| Push | GET `/api/push/public-key`; POST, DELETE `/api/push/subscriptions` | anon; member (POST only: 60/h, 503 `push_disabled` without keys) |
| Takedowns | POST `/api/takedowns` | anon or member; 10/h per account, or per IP signed out |
| AI provider | POST `/api/webhooks/replicate` (verifies and logs only) | HMAC signature |
| Admin | POST `/api/admin/credits`; GET, POST `/api/admin/flags`; PATCH `/api/admin/models/{key}`; POST `/api/admin/reports/{id}`; POST `/api/admin/users/{id}/suspend` | admin |
| | GET `/api/admin/review`; POST `/api/admin/review/{id}`; GET `/api/admin/takedowns?status=&offset=`; POST `/api/admin/takedowns/{id}` | admin |

## 6. URL conventions

| Convention | Rule |
|---|---|
| Identifiers | UUIDs for jobs, projects, scenes, folders, presets, characters, consents and flags. `templates/[id]` takes a slug or a uuid; links use the slug, and `PATCH /api/templates/{id}` needs the uuid. `creators/[id]` takes a handle, case-insensitive. |
| Explore filters | `/explore?q=&category={slug}&media=image\|video&sort=trending\|new\|top_rated\|most_favorited&vipOnly=1`. Trending, the default, is left out of the URL. `GET /api/templates` takes the same keys plus `creatorId`, `offset`, `limit`. |
| Library filters | `/collection?media=&status=completed\|processing\|queued\|failed\|cancelled&favorites=1&folder={uuid}&model={key}&sort=newest\|oldest&project={uuid}&template={uuid}&creator={uuid}&quality=hd\|4k&from=YYYY-MM-DD&to=YYYY-MM-DD`. `creator` is the template creator's user id; dates are whole UTC days, inclusive. Invalid values are ignored, except `model`: an unknown key shows an empty Library. `GET /api/generations` takes `projectId`, `templateId`, `folderId`, `modelKey` and `offset` (up to 10,000), not `creator`, `quality`, `from` or `to`. |
| Other filters | `/favorites?tab=templates\|creations`; `/studio?kind=image\|video&preset={uuid}`; `/admin/review?takedowns={offset}` pages open takedowns 100 at a time, urgent categories first. |
| Prefill | `/generate/{kind}?from={jobId}` copies prompt, model, settings, project, scene and character from your own creation and drops the seed; `&reuse=exact` keeps it. `?scene={sceneId}` binds the draft to that scene and opens studio mode. Job or scene ids you do not own prefill nothing. `?character={id}` (images only) sets reference-guided mode with no ownership check; a character not on your file is dropped, leaving none selected. |
| Scene return | `/projects/{id}?scene={sceneId}` opens that scene; selecting a scene rewrites the URL in place. |
| Return paths | `/auth?next=` keeps only a same-origin path, query and hash, resolved as a browser would; anything else lands on `/` (src/app/auth/page.tsx). `?mode=signin` opens sign-in. `/pricing?checkout=success\|cancelled`. `/pricing/sandbox?t={token}`. `/verify/sandbox?ref={ref}`. `/policies/takedown?target={path or id}`. |
| Anchors | `#make` on template pages; `/settings#age-verification` and `#device`; `/policies#adults`, `#content`, `#consent`, `#abuse`, `#privacy`, `#training`, `#credits`, `#demo`. Home's "Tune" links to `/settings#discovery`, but no element has that id (open defect, not done). |
| API bodies | JSON, except multipart for `/api/uploads` and `/api/characters`. Drafts, derives and admin credit grants carry an idempotency key. Confirm echoes `expectedCost`. Errors use `{ error: { code, message, details } }`. |
| Media | Signed `/api/media` links only: one hour for public covers, `MEDIA_URL_TTL_S` (default 300 s) for private media (src/server/media.ts, src/server/env.ts). Public media is served only while a published, undeleted template uses it, so once the template is removed or unpublished or its creator suspended, earlier links work only for the owner (src/app/api/media/route.ts). |
| Robots | `noindex, nofollow` in page metadata and in an `X-Robots-Tag` header on every path. |

## 7. Where age verification, scanning, payments and the web app surface

| Addition | Pages | Default mode | Live needs |
|---|---|---|---|
| Age verification | `/settings#age-verification`, `/verify/sandbox`, withheld-media placeholders | Labeled sandbox | Yoti account (adapter unverified) and an edge that sets geo headers |
| Abuse scanning | `/admin/review`, `/policies/takedown` | Labeled dev scanner | PhotoDNA approval (adapter unverified) |
| Payments | `/pricing`, `/pricing/sandbox`, `/admin` flags | Labeled sandbox | CCBill or Segpay (adapters unverified) |
| Web app | `/settings#device`, `/offline`, offline banner | Installable; push off | VAPID keys (self-generated) |

### 7.1 Age verification

Why: Ofcom requires "highly effective age assurance" where users can generate or upload pornographic content ([Ofcom](https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance)), and many US states have similar laws ([Free Speech Coalition](https://www.freespeechcoalition.com/faq)).

- **Who is covered.** `AGE_VERIFICATION_ENFORCE` defaults to true. Regions come from `AGE_VERIFICATION_REGIONS` or `src/config/jurisdictions.ts` (GB and 25 US states as of 2026-10-12, to re-check before launch), plus `AGE_ASSURANCE_STRICT_REGIONS` (default empty). A check is required when the stored jurisdiction or the request's location requires it; the stored value decides alone only when the request has no location (src/server/age/service.ts). An unknown location (no header, a bare `US` while US states are configured, or `XX`, `T1`, `A1`, `A2`) falls to `AGE_VERIFICATION_FAIL_CLOSED`, default **false**: no check is required (src/server/age/rules.ts). Geo headers are trusted as sent, so the edge must set them and strip client copies.
- **What is gated.** Section 5's **age** routes return 451 with `verifyPath: /settings#age-verification`, which the create panel (Make it, upload), Library Retry and creation-page Retry, Variation, Continue and Extend show as a "Verify your age" link. Public pages withhold media and show "Verify your age to see previews" (or "Sign in and verify..."). Every public template counts as explicit.
- **Sandbox on a live site.** A live site refuses to boot with the sandbox provider while enforcement is on, and a sandbox "verified" status reads as unverified there (service.ts).
- **Flow.** Settings "Verify now" calls `POST /api/age-verification/start`, which opens `/verify/sandbox?ref=` or Yoti's hosted page. Sandbox: that page posts a signed result to `/api/webhooks/age-verification/sandbox` and returns to Settings. Yoti (unverified): a signed notification, or `/api/age-verification/return` fetching the result, sets the status. Status reads "expired" after `AGE_VERIFICATION_VALID_DAYS` (365). No ID images or biometrics are stored.

### 7.2 Scanning

- **What is scanned.** Uploads, character photos and outputs, before they are served or used. Video is scanned across its whole length; clips over 60 s or 4096 px on a side are refused (src/server/safety/scan/index.ts). Anything not `clean` gets the same 404 as a deleted asset.
- **On a match.** The file goes on legal hold. The owner is suspended and signed out, their templates are unpublished and their push subscriptions deleted, and a `csam_match` flag and an escalation reach `/admin/review` (src/server/safety/suspend.ts). A matched upload gets a generic 403; a matched output fails with credits returned.
- **Takedowns.** Actioning one removes byte-identical copies on every account and blocks republishing them (409 `taken_down`).
- **Modes.** `SCAN_FAIL_CLOSED` defaults to true: during an outage uploads get 503 and outputs retry. A live site refuses to boot on `SCAN_PROVIDER=dev` only while fail-closed is on; `/admin/review` labels it "Development scanner · not live". Cloudflare's tool scans only cached responses ([Cloudflare](https://blog.cloudflare.com/the-csam-scanning-tool/)); app media is private, so as shipped it would see nothing. The runbook, `docs/abuse-response.md`, awaits legal review.

### 7.3 Payments

`PAYMENT_PROVIDER` picks sandbox (default), ccbill, segpay or stripe. Stripe is off unless chosen ([Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)). `/pricing` shows "Sandbox · no money moves". On a live site the sandbox counts as not configured, so buying is switched off with a notice; CCBill counts as not configured without `CCBILL_WEBHOOK_TOKEN`. Each provider event applies once. Refunds and chargebacks claw credits back through the ledger; a chargeback flag blocks checkout until an admin clears it.

### 7.4 Installable web app

Apple and Google ban sexually explicit apps ([App Store 1.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Play](https://support.google.com/googleplay/android-developer/answer/9878810)), so mobile is the web app. The manifest is standalone, with shortcuts to `/generate/image` and `/collection`. `public/sw.js` precaches the manifest, icons and `/offline`, caches static assets, and never answers `/api/*` or member pages. Install is offered only in `/settings#device`. Push is opt-in per account and device, opens `/collection/{jobId}`, and says only that a creation is ready, did not finish or was cancelled. Without VAPID keys the toggle is disabled: "Push is not configured on this server."

## 8. Three-perspective walkthrough

**Returning user.** Sessions last `SESSION_TTL_DAYS` (30), so they land on `/` signed in, with no age notice.

1. They tap Make on a For you or Trending tonight card.
2. `/templates/{slug}#make` opens with the panel in view, defaults filled, cost showing.
3. Make it opens the confirm sheet: cost, balance after, model, and a demo note on demo models.
4. Confirm queues the job; the tray shows it everywhere. Past the active-jobs cap (default 3) confirm answers 429. With notifications on, a push opens `/collection/{jobId}`.
5. On the creation page, Remix goes to `/generate/{kind}?from=`, Save adds a favorite, and the template link leads back to its "You might also like" rail.

On phones the same path runs through the tab bar, Make bar and tray.

**New user in a covered region** (for example a GB or US-TX geo header).

1. After the age notice, Home shows titles and creators but no media: "Sign in and verify to see previews".
2. The template page shows the cost first. Make redirects to `/auth?next=/templates/{slug}`.
3. Signup asks for email, password, handle, display name, date of birth and two attestations. The server refuses anyone under 18 and stores the jurisdiction.
4. Back on the template page, Make it returns 451; the alert's "Verify your age" button opens `/settings#age-verification`.
5. There, Verify now opens the labeled `/verify/sandbox` page (Yoti on a live site). The signed result marks them verified, and previews appear.
6. New accounts get `SIGNUP_GRANT_CREDITS` (default 0), so the cost line offers "Get credits". Buy on `/pricing` (sandbox badge) opens `/pricing/sandbox`; Complete sends a signed webhook event and returns to `/pricing?checkout=success`, with the ledger row visible.
7. They confirm the creation. Install and notifications wait in `/settings#device`, never as a popup.

**Advanced creator.**

1. In `/projects/{id}` they pick a scene; the URL keeps it (`?scene=`).
2. They edit its continuity guide: lighting, framing, palette, a `/train` character, notes.
3. Make a clip opens `/generate/video?scene={id}` in studio mode, labeled "Project scene". Character references apply to stills only.
4. The take lands under its scene. Branch and Continue show a cost sheet; Use as take, Compare and Play sequence cost nothing.
5. A good result becomes a preset, reused from `/studio?preset=` or "Start from preset".
6. Without an upload or character, it can be published. `/creators/{handle}` then shows 30-day views and uses, and lets them edit title, description or prompt (a new version) or unpublish.

Open defect, not done: the creation page's "in {project}" link opens the project's first scene, not the take's.
