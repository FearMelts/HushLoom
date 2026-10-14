# Hushloom Information Architecture

Deliverable C of the Hushloom spec (Part XIV): the sitemap, routes and object relationships of the merged build at commit `c52f843` (all seven build tracks). Every route below exists under `src/app`; anything else is marked **planned**.

Naming: the spec's "Collection" is **Library** in the UI, at `/collection`. "Train" manages character references; nothing is trained on them. Playbox informs the structure only (gallery first, generation on the template page, a private library, projects for continuity). Hushloom's look is its own.

Status words used in this document:

- **Operational**: runs as built; covered by the test suite (vitest 258/258 at the infra merge).
- **Demo**: AI generation. Without a provider key, demo models make labeled placeholders.
- **Sandbox / dev**: payments, age verification and scanning run labeled stand-ins until the owner opens accounts.
- **Off until keys**: push stays off, and says so, until VAPID keys are set.
- **Unverified**: written from public docs, never run against the real service: CCBill, Segpay, live Stripe, Yoti, PhotoDNA, Cloudflare, Replicate, push delivery, device install.
- **Not yet seen in a browser**: fix-track UI such as the phone "You" sheet and the template Make bar. The merged build's browser journey has not run yet.

## 1. Sitemap and page route table

### 1.1 Access levels

| Level | Rule |
|---|---|
| Anyone | Renders for every visitor past the age notice. |
| Member | Signed-out visitors are redirected to `/auth?next=<path>`. |
| Owner | A valid id you do not own is a 404, the same as a missing one. |
| Admin | Everyone else gets the 404 page. |
| Age-verified | Matters only where the jurisdiction requires a provider check (section 7.1): media is withheld and drafts and uploads return 451 until verified. |

The age notice is not a route. `src/app/layout.tsx` shows it instead of the shell only when there is no session, no `hl_age_ok` cookie and the path is not under `/policies`. A signed-in user never sees it, whatever the cookie says. `/offline` renders bare, with no gate. The notice offers "I am 18 or older, enter" (a 30-day cookie via `POST /api/age-gate`) and "Leave", links to `/policies` and `/policies/takedown`, and says it is a notice, not age verification.

### 1.2 Pages

| Path | Purpose | Who | Primary actions | Entry points | Exits |
|---|---|---|---|---|---|
| `/` | Home gallery. Trending tonight and New for all; signed in also For you, Continue exploring, Your favorites, Following | Anyone; media withheld if an age check is needed | Make an image or video, favorite, preview, Make on a card | Wordmark, Discover, 404 and error pages, `/offline` | `/templates/{slug}`, `/creators/{handle}`, `/explore`, `/favorites`, `/generate/{kind}`, `/settings#discovery` |
| `/explore` | Search and browse published templates, infinite scroll | Anyone; media rule as `/` | Sort, Images or Videos, VIP, category, search | Top-bar search, tab bar Search, Home links, category and tag links, Generate "Start from a template" | `/templates/{slug}`, `/creators/{handle}` |
| `/templates/{slug}` | Template detail with the Create panel in place, version history, related rails | Anyone; 404 if not published and not yours; VIP locks the panel without a pass | Make it (draft, then confirm sheet), favorite, follow, rate, report, Manage (owner) | Any card (Make lands on `#make`), "Remix of" link, creation page, admin report row | `/creators/{handle}`, `/explore?category=` or `?q={tag}`, `/pricing`, `/train`, `/studio`, `/auth`, `/policies/takedown?target=` |
| `/generate/image`, `/generate/video` | Blank-canvas or prefilled creation (`?from`, `?scene`, `?character`) | Anyone may open; Make needs a member and, where required, a verified age; other kinds 404 | Make it, switch kind, start from a preset, upload with a consent sheet | Create (rail, top bar, tab bar "+"), New creation, Home buttons, Remix, scene and Train buttons, app shortcut | `/explore`, `/collection` (toast), `/studio`, `/train`, `/pricing`, `/auth` |
| `/studio` | The same panel with every control open, presets, job monitor | Member | Seed, negative prompt, project and scene placement; start from or delete a preset | Rail, You sheet, panel "More controls in Studio", preset toast | `/studio?kind=&preset=`, `/collection/{id}` |
| `/collection` | Library: every creation you made | Member | Filter, select, bulk delete, add to folder, Retry a failed one (cost sheet first) | Library (rail, tab bar), panel toast, 404 page, Favorites empty state, app shortcut | `/collection/{id}`, `/projects`, `/` |
| `/collection/{jobId}` | One creation: media, settings, lineage, compare | Owner | Remix, Retry, Variation, Continue and Extend (video), Reuse settings, Save, Download, Folder, Preset, Publish, Delete; Cancel while running | Library, job tray, completion toasts, push notification, Studio monitor, project takes | `/generate/{kind}?from=`, `/templates/{slug}`, `/projects/{id}`, `/collection` |
| `/favorites` | Saved templates (default) and saved creations (`?tab=creations`) | Member | Open, unfavorite | Rail, You sheet, Home "All saved" | `/templates/{slug}`, `/collection/{id}`, `/explore` |
| `/projects` | Project index | Member | New project | Rail, You sheet, Library "Projects", workspace back link | `/projects/{id}` |
| `/projects/{id}` | Scene workspace: timeline, continuity guide, takes; `?scene=` keeps the open scene | Owner | Add, reorder, rename, delete scenes; save guide; Make a clip or still; Use as take; Branch; Continue; Compare; Play sequence | Index, creation "in {project}" line, new-project sheet | `/generate/{kind}?scene=`, `/collection/{id}`, `/projects` |
| `/train` | Character references with recorded consent | Member | Add a character (photo, two consents), Remove, Make a still | Rail, You sheet, panel "Add one in Train" | `/generate/image?character={id}` |
| `/creators/{handle}` | Profile: published templates, public collections; owner sees "Your templates" | Anyone; 404 for unknown or suspended handles | Follow; owner edits title, description or prompt, publishes or unpublishes | Card handle, template creator row, rail profile row, You sheet | `/templates/{slug}` |
| `/settings` | Profile, discovery and privacy, consents, age check (`#age-verification`), this device (`#device`), account | Member | Edit profile and preferences, clear history, withdraw consent, Verify now, install, notifications, sign out everywhere, delete account | Rail, You sheet, Home "Tune", withheld-media and 451 links | `/auth`, `/`, `/verify/sandbox` or the provider's page |
| `/pricing` | Credits and passes; balance, ledger and payment history when signed in; names the processor | Anyone; buying needs a member | Buy a pack or pass | Credit pill, You sheet, rail footer, VIP lock, short-balance line | Processor page or `/pricing/sandbox`, back to `?checkout=success` or `cancelled` |
| `/pricing/sandbox` | Sandbox processor page: "No money moves" | Member; payment sandbox on a non-live site only, else redirects to `/pricing` | Complete or Fail an order; refund, chargeback, renew or cancel your own sandbox payments | Link returned by `POST /api/checkout` (`?t=`, valid 30 minutes) | `/pricing?checkout=success` or `cancelled` |
| `/verify/sandbox` | Sandbox age check, labeled "proves nothing" | Signed-in owner of a pending sandbox check; 404 on a live site or with another provider | Deliver a signed verified or failed result | Settings "Verify now" | `/settings#age-verification` |
| `/auth` | Create an account or sign in | Anyone; members bounce to `next` | Sign up (email, password, handle, display name, date of birth, two attestations), sign in | Every member redirect, Join or sign in, signed-out favorite or Make | `next` (default `/`), `/policies` |
| `/admin` | Stats, reports, models, credit adjustment, account flags, audit log | Admin | Remove or dismiss a report, suspend, set model price or enabled, adjust credits, clear a flag | Rail shield icon, You sheet | `/admin/review`, `/templates/{slug}` |
| `/admin/review` | Scanner matches, takedown requests, recently closed; scanner status badges | Admin | Confirm a match and record the report reference, clear a false match, take down or dismiss | `/admin`, Account flags panel | `/admin`, `/templates/{slug}` |
| `/policies` | Plain-language policies with anchors | Anyone; skips the age notice | Read | Age notice, rail footer, You sheet, signup form | `/policies/takedown` |
| `/policies/takedown` | Takedown request form, no account needed | Anyone; skips the age notice | Submit category, target, details, good-faith box (email if signed out) | Age notice, `/policies#abuse`, template report sheet | `/policies` |
| `/offline` | Service-worker fallback, no shell, no account data | Anyone, offline | Try again, Go to Discover | Service worker only | The failed page, `/` |

### 1.3 Loading, error and not-found

| File | Behavior |
|---|---|
| `loading.tsx` (root) | Hero block and grid skeleton for any page without its own. |
| Route skeletons | `/explore`, `/templates/{slug}`, `/collection`, `/collection/{id}`, `/favorites`, `/projects`, `/projects/{id}`, `/creators/{handle}`. |
| `error.tsx` | "A thread snapped" inside the shell; Try again or Back to Discover; only the error digest shows. |
| `global-error.tsx` | The root layout failed. Standalone page; Try again is a full reload. |
| `not-found.tsx` | "A loose thread", for bad paths and other people's private objects. Exits: `/`, `/collection`. |

## 2. Navigation model

`src/components/shell.tsx` defines the lists. **Primary**: Discover `/` (active on `/`, `/explore*`, `/templates*`), Create `/generate/image`, Library `/collection`, Train `/train`. **Go deeper**: Projects, Studio, Favorites.

| Surface | Where | Contents |
|---|---|---|
| Desktop rail | 1024 px and up | Wordmark, primary, Go deeper. Footer: New creation (`/generate/video`), credit pill, admin shield, Settings, Sign out, profile row; signed out, Join or sign in; always Pricing and policies links. |
| Top bar | All widths | Wordmark below 1024 px; search from 640 px, submitting to `/explore?q=`; credit pill below 1024 px; Create (desktop) or Sign in; offline banner. |
| Mobile tab bar | Below 1024 px | Discover, Search (`/explore`), center "+" (`/generate/image`), Library, then You (signed in) or Sign in. |
| "You" sheet | Phone, from the You tab | Profile row, credits row (`/pricing`), Favorites, Projects, Studio, Train, Settings, Pricing, Policies, Admin (admins), Sign out. Not yet seen in a browser. |
| Job tray | Signed in, all widths | Running creations, each linking to `/collection/{id}`; the only poller (3 s visible, 15 s hidden, paused offline). |
| Template Make bar | Phone, template pages | "Make it · N credits", a link to `#make`. Not yet seen in a browser. |

"Sign out" (rail icon, You sheet) calls `POST /api/auth/logout`, drops this device's push subscription and reloads `/`. "Sign out everywhere" (`/settings`) ends every session and goes to `/auth`.

The primary nav stays at four items (spec Part VI). Studio, Projects and Favorites sit under Go deeper and in the You sheet, and are also reached in context (section 1.2 entry points). Studio is never required. Pricing is reached passively (credit pill, VIP lock, short-balance line), never through an interstitial.

## 3. Relationship map

| From | To | Through | Carries |
|---|---|---|---|
| Home, Explore | Template | Card, or its Make button (`#make`) | slug |
| Any card or template | Creator | Handle on the card or creator row | handle |
| Template | Generate | The Create panel embedded on the page | `templateId` and version on the draft |
| Template | Explore, Template | Category badge, tags, "More in #tag", "Remix of", "You might also like" | `?category=`, `?q={tag}`, `remixed_from_id` |
| Generate | Library | Confirm queues a job; toast "Library", tray, completion toast and push open it | job id |
| Library | Generate | Remix (`?from=`, new seed), Reuse settings (`&reuse=exact`) | parent job, relation `remix`, template while still usable |
| Library | Library | Retry, Variation, Continue, Extend: derive, cost sheet, confirm | new job with parent and relation |
| Library | Template, Creator | Publish a completed, scan-clean creation not made from an upload or character | new template; appears on the creator page |
| Library | Projects, Studio, Favorites, Folders | "in {project}" line; Preset sheet (toast to `/studio`); Save; Folder sheet | project id, preset, `?tab=creations`, `?folder=` |
| Projects | Generate | Make a clip or still | `?scene=` (continuity note, lighting, framing, character, studio mode) |
| Projects | Library | Take cards; every take is a creation | job id |
| Train | Generate, Projects | Make a still; continuity guide Character select | `?character=`, reference id |
| Studio | Library | Job monitor rows | job id |
| Settings | Home, Create panel | Personalization, history, autoplay and interests shape Home; the assistant toggle only filters panel suggestions (rules-based, not AI) | preferences |

The spec's loop maps onto pages: Discover (Home, Explore), Choose (template page), Personalize (panel), Generate (confirm sheet, tray), Remix and Continue (creation page, project scene), Explore again (the template page rails).

## 4. Object model with URLs

| Object | Table | Canonical URL | Notes |
|---|---|---|---|
| Template | `templates` | `/templates/{slug}` (uuid also resolves) | Statuses draft, published, unpublished, removed. |
| Template version | `template_versions` | None; history on the template page | A prompt edit makes the next version. |
| Creation (job) | `generation_jobs` | `/collection/{jobId}` | Carries template, project, scene, parent, relation. |
| Output, media asset | `generation_outputs`, `media_assets` | No page; signed `/api/media` links or `/api/generations/{id}/download` | Served only when `scan_status` is `clean`. |
| Project | `projects` | `/projects/{id}` | |
| Scene | `project_scenes` | `/projects/{id}?scene={sceneId}` | Holds the continuity guide. |
| Take | `scene_versions` | None; under its scene | One per job; branch label; selected flag. |
| Character reference | `character_references` | `/train` | Consent records; scanned photo. |
| Preset | `saved_presets` | `/studio?preset={id}&kind=` | |
| Folder | `folders`, `folder_items` | `/collection?folder={id}` | |
| Library | No table | `/collection` | A view over jobs, outputs, favorites and folders. |
| Favorite | `favorites` | `/favorites?tab=` | Template or creation. |
| Creator | `users`, `user_profiles`, `creator_profiles` | `/creators/{handle}` | |
| Template collection | `template_collections` | Rails on the creator page | No UI to create one yet (planned). |
| Consent record | `consent_records` | `/settings` Consents | Withdrawal deletes dependent content. |
| Age verification | `age_verifications`, `users` status | `/settings#age-verification` | unverified, pending, verified, failed, expired. |
| Payment event, pass, ledger | `payment_events`, `subscriptions`, `credit_ledger` | `/pricing` | |
| Account flag | `account_flags` | `/admin` flags panel, `/admin/review` | chargeback, csam_match, manual_review, credit_debt. |
| Escalation | `moderation_events` | `/admin/review` | |
| Takedown request | `takedown_requests` | `/policies/takedown`, `/admin/review` | open, actioned, dismissed. |
| Push subscription | `push_subscriptions` | `/settings#device` | One per device, tied to the session. |

## 5. API route inventory

56 route files under `src/app/api`. Auth: **anon** (anyone), **member** (401 when signed out), **owner** (404 when not yours), **admin** (401 signed out, 404 for non-admins), **signature** (webhooks and media links). Every POST, PUT, PATCH or DELETE outside `/api/webhooks/` from another origin gets 403 `bad_origin` (`src/middleware.ts`).

| Domain | Method and path | Auth and limits |
|---|---|---|
| Infrastructure | GET `/api/health`; GET `/api/media?k&e&s[&d]` (Range support) | anon; signed link |
| Age notice, auth | POST `/api/age-gate`, `/api/auth/logout` | anon, no limit |
| | POST `/api/auth/signup`, `/api/auth/login` | anon; signup 10/h per IP; login 30/15 min per IP and 10/15 min per email |
| Age verification | POST `/api/age-verification/start` | member, 10/h |
| | GET `/api/age-verification/return` | member (else redirect to `/auth`) |
| | POST `/api/webhooks/age-verification/{provider}` | signature of the active provider |
| Account | GET, PATCH, DELETE `/api/me`; PATCH `/api/me/preferences`; DELETE `/api/me/history`, `/api/me/sessions` | member |
| | DELETE `/api/me/consents/{id}` | owner |
| Uploads, Train | POST `/api/uploads` (multipart, consent required) | member, age check, 40/h |
| | GET, POST `/api/characters` (multipart) | member; POST 10/h, no age check |
| | DELETE `/api/characters/{id}` | owner |
| Generation | GET `/api/generations` (list, `?active=1` for the tray) | member |
| | POST `/api/generations` (draft) | member, age check, 30/min |
| | GET, DELETE `/api/generations/{id}`; POST `.../confirm`, `.../cancel`, `.../derive` (age check); GET `.../download` (302 to a signed link) | owner |
| Templates | GET `/api/templates` (browse; media withheld per viewer) | anon |
| | POST `/api/templates` (publish), `/api/templates/{id}/rate`, `/api/templates/{id}/report` | member; report 20/h |
| | PATCH `/api/templates/{uuid}` | owner or admin |
| Social | POST, DELETE `/api/favorites`, `/api/follows` | member |
| Library | GET, POST `/api/folders`, `/api/presets` | member |
| | DELETE `/api/folders/{id}`, `/api/presets/{id}`; POST `/api/folders/{id}/items` | owner |
| Projects | GET, POST `/api/projects` | member |
| | GET, PATCH, DELETE `/api/projects/{id}`; POST, PUT `/api/projects/{id}/scenes`; PATCH, DELETE `/api/scenes/{id}`; POST `/api/scenes/{id}/select` | owner |
| Payments | POST `/api/checkout` | member, 10 per 10 min; 503 when no processor; 403 for chargeback-flagged accounts |
| | POST `/api/pricing/sandbox` | member, sandbox only |
| | POST `/api/webhooks/payments/{provider}` (sandbox, ccbill, segpay, stripe); POST `/api/webhooks/stripe` (delegates) | processor signature |
| Push | GET `/api/push/public-key`; POST, DELETE `/api/push/subscriptions` | anon; member, 60/h, 503 `push_disabled` without keys |
| Takedowns | POST `/api/takedowns` | anon or member, 10/h per user or IP |
| AI provider | POST `/api/webhooks/replicate` (verifies and logs only) | HMAC signature |
| Admin | POST `/api/admin/credits`; GET, POST `/api/admin/flags`; PATCH `/api/admin/models/{key}`; POST `/api/admin/reports/{id}`; POST `/api/admin/users/{id}/suspend` | admin |
| | GET `/api/admin/review`; POST `/api/admin/review/{id}`; GET `/api/admin/takedowns?status=`; POST `/api/admin/takedowns/{id}` | admin |

`GET /api/admin/review` and `GET /api/admin/takedowns` have no UI caller: `/admin/review` renders its lists on the server.

## 6. URL conventions

| Convention | Rule |
|---|---|
| Identifiers | UUIDs for jobs, projects, scenes, folders, presets, characters, consents and flags. Templates link by slug and also accept the uuid; `PATCH /api/templates/{id}` needs the uuid. Creators by handle, case-insensitive. A malformed uuid is a 404. |
| Ownership | Someone else's valid id is a 404, identical to a missing one. |
| Explore filters | `/explore?q=&category={slug}&media=image\|video&sort=trending\|new\|top_rated\|most_favorited&vipOnly=1`. Trending is the default and is left out of the URL. `GET /api/templates` takes the same keys plus `creatorId`, `offset`, `limit`. |
| Library filters | `/collection?media=&status=completed\|processing\|queued\|failed\|cancelled&favorites=1&folder={uuid}&model={key}&sort=newest\|oldest&project={uuid}&template={uuid}&creator={uuid}&quality=hd\|4k&from=YYYY-MM-DD&to=YYYY-MM-DD`. `creator` is the template creator's user id; dates are whole UTC days, inclusive. Invalid values are ignored. `GET /api/generations` takes `projectId`, `templateId`, `folderId` and `modelKey`, but not `creator`, `quality`, `from` or `to`. |
| Other filters | `/favorites?tab=templates\|creations`; `/studio?kind=image\|video&preset={uuid}`. `/creators/{handle}?tab=manage` (the template page's Manage link) is not read; owners see their section anyway. |
| Prefill | `/generate/{kind}?from={jobId}` copies prompt, model, settings, project, scene and character from your own creation and drops the seed; `&reuse=exact` keeps it. `?scene={sceneId}` binds the draft to that scene and opens studio mode. `?character={id}` (images only) sets reference-guided mode. Ids you do not own prefill nothing. |
| Scene return | `/projects/{id}?scene={sceneId}` opens that scene; selecting a scene rewrites the URL in place. The creation page's project link does not carry the scene yet (planned). |
| Return paths | `/auth?next=/path` must start with `/` and not `//`; `?mode=signin` opens sign-in. `/pricing?checkout=success\|cancelled`. `/pricing/sandbox?t={token}`. `/verify/sandbox?ref={ref}`. `/policies/takedown?target={path or id}`. |
| Anchors | `#make` on template pages; `/settings#age-verification` and `#device`; `/policies#adults`, `#content`, `#consent`, `#abuse`, `#privacy`, `#training`, `#credits`, `#demo`. Home's "Tune" links to `/settings#discovery`, but no element has that id (open defect). |
| API bodies | JSON, except multipart for `/api/uploads` and `/api/characters`. Drafts, derives and admin credit grants carry an idempotency key. Confirm echoes `expectedCost`; a changed price is 409 `cost_changed`. Errors use `{ error: { code, message, details? } }`. |
| Media | HTML only ever holds signed, expiring links: one hour for public covers, `MEDIA_URL_TTL_S` (default 300 s) for private outputs. |
| Robots | `noindex, nofollow` in page metadata and in an `X-Robots-Tag` header on every path. |

## 7. Where age verification, scanning, payments and the web app surface

| Addition | Pages | API | Default mode | Live needs |
|---|---|---|---|---|
| Age verification | `/settings#age-verification`, `/verify/sandbox`, withheld-media placeholders | `/api/age-verification/*`, `/api/webhooks/age-verification/{provider}` | Labeled sandbox | Yoti account (adapter unverified) and an edge that sets geo headers |
| Abuse scanning | `/admin/review`, `/policies/takedown` | `/api/admin/review*`, `/api/takedowns`, `/api/admin/takedowns*` | Labeled dev scanner | PhotoDNA approval (adapter unverified) |
| Payments | `/pricing`, `/pricing/sandbox`, `/admin` flags | `/api/checkout`, `/api/pricing/sandbox`, `/api/webhooks/payments/{provider}` | Labeled sandbox | CCBill or Segpay (adapters unverified) |
| Web app | `/settings#device`, `/offline`, offline banner | `/api/push/*` | Installable; push off | VAPID keys (self-generated) |

### 7.1 Age verification

Why: Ofcom requires "highly effective age assurance" where users can generate or upload pornographic content ([Ofcom](https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance)), and many US states have similar laws ([Free Speech Coalition](https://www.freespeechcoalition.com/faq)).

- **Who is covered.** `AGE_VERIFICATION_ENFORCE` defaults to true. Regions come from `AGE_VERIFICATION_REGIONS` or the defaults in `src/config/jurisdictions.ts` (GB and 25 US states, compiled 2026-10-12; the operator must re-check them). The jurisdiction stored at signup or sign-in wins, else the request's geo headers. With no location, `AGE_VERIFICATION_FAIL_CLOSED` decides, and it defaults to **false**: creation is allowed. Geo headers are trusted as sent, so the edge must set them and strip client copies.
- **What is gated.** Drafts, derives and `POST /api/uploads` return 451 `age_verification_required` with `verifyPath: /settings#age-verification`. Home, Explore, template pages, creator pages, Favorites and `GET /api/templates` withhold media URLs and show "Verify your age to see previews" (or "Sign in and verify..."). Every public template counts as explicit; there is no per-template flag. Your own Library is not gated.
- **Gap.** `POST /api/characters` (the Train photo) skips the age check. The photo is still scanned, and it cannot be used until the user verifies, because every draft is gated.
- **Flow.** Settings "Verify now" calls `POST /api/age-verification/start`. The sandbox sends the user to `/verify/sandbox?ref=` to pick an outcome; Yoti uses its hosted page. A signed callback sets the status, and `/api/age-verification/return` leads back to Settings. Status reads "expired" after `AGE_VERIFICATION_VALID_DAYS` (365). No ID images or biometrics are stored. A live site refuses to boot with the sandbox while enforcement is on.
- **451 wording.** The create panel says "Open Settings › Age verification" without a link; the creation page's toast carries one.

### 7.2 Scanning

Every upload, character photo and generated output (videos as up to 30 keyframes) passes `scanAsset` before anything is served or used. Only `clean` assets are signed, served by `/api/media`, downloaded, used as inputs or published; anything else gets the same 404 as a deleted asset. On a match the file goes on legal hold, the owner is suspended and signed out, and a `csam_match` flag and an escalation reach `/admin/review`. The upload reply is a generic 403; a matched output fails with its credits returned. `SCAN_FAIL_CLOSED` defaults to true: during an outage uploads get 503 and outputs retry. A live site refuses to boot on `SCAN_PROVIDER=dev` only while fail-closed is on. `/admin/review` labels the dev scanner "Development scanner · not live". The runbook, `docs/abuse-response.md`, is marked for legal review. Cloudflare's tool scans only cached responses ([Cloudflare](https://blog.cloudflare.com/the-csam-scanning-tool/)); app media is private, so as shipped it would see nothing.

### 7.3 Payments

`PAYMENT_PROVIDER` picks sandbox (default), ccbill, segpay or stripe. Stripe is off unless chosen; the comment citing its policy sits on `PAYMENT_PROVIDER` in `src/server/env.ts` ([Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)). `/pricing` shows "Sandbox · no money moves". On a live site the sandbox counts as not configured, so buying is switched off with a notice. Webhooks are exactly-once per provider event. A refund or chargeback claws credits back through the ledger, and a chargeback flag blocks checkout until an admin clears it.

### 7.4 Installable web app

Apple and Google ban sexually explicit apps ([App Store 1.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Play](https://support.google.com/googleplay/android-developer/answer/9878810)), so mobile is the web app. The manifest is standalone, with shortcuts to `/generate/image` and `/collection`. `public/sw.js` caches static assets, icons and `/offline` only, and never answers `/api/*` or navigations under `/collection`, `/projects`, `/studio`, `/train`, `/settings`, `/admin`, `/favorites`, `/pricing`, `/auth` and `/verify`. Install is offered only in `/settings#device`. Push is opt-in per account and device, opens `/collection/{jobId}`, and says only "Your creation is ready", "A creation didn't finish" or "A creation was cancelled". Without VAPID keys the toggle is disabled: "Push is not configured on this server."

## 8. Three-perspective walkthrough

**Returning user.** Sessions last `SESSION_TTL_DAYS` (30), so they land on `/` signed in, with no age notice.

1. They scroll For you or Trending tonight and tap Make on a card.
2. `/templates/{slug}#make` opens with the panel in view, defaults filled, cost showing.
3. Make it opens the confirm sheet: cost, balance after, model, and a demo note on demo models.
4. Confirm queues the job; the tray shows it on every page. With notifications on, a push opens `/collection/{jobId}`.
5. On the creation page, Remix goes to `/generate/video?from=`, Save adds a favorite, and "You might also like" leads back to discovery.

On a phone the path runs through the tab bar, Make bar, tray and Library; Projects and Studio sit in the You sheet.

**New user in a covered region** (for example a GB or US-TX geo header).

1. The age notice comes first. After entering, Home shows titles and creators but no media: "Sign in and verify to see previews".
2. The template page shows the cost before asking for anything. Make redirects to `/auth?next=/templates/{slug}`.
3. Signup asks for email, password, handle, display name, date of birth and two attestations. The server refuses anyone under 18 and stores the jurisdiction.
4. Back on the template page, Make it returns 451, and the panel says to open Settings › Age verification.
5. At `/settings#age-verification`, Verify now opens the labeled `/verify/sandbox` page (Yoti on a live site). The signed result marks them verified, and previews appear.
6. New accounts get `SIGNUP_GRANT_CREDITS` (default 0), so the cost line offers "Get credits". `/pricing` shows the sandbox badge.
7. Buy opens `/pricing/sandbox`. Complete sends a signed event through the webhook and returns to `/pricing?checkout=success`, with the ledger row visible.
8. They confirm the creation. Install and notifications wait in `/settings#device`, never as a popup.

**Advanced creator.**

1. They open `/projects`, then `/projects/{id}`. Picking a scene writes `?scene=` to the URL, so a reload or shared link returns to it.
2. They edit the continuity guide: lighting, framing, palette, a character from `/train`, notes.
3. Make a clip opens `/generate/video?scene={id}` in studio mode, labeled "Project scene". Character references apply to stills only; the panel says so.
4. The confirmed take lands under its scene. Branch and Continue each show a cost sheet; Use as take, Compare and Play sequence cost nothing.
5. A good result becomes a preset, reused from `/studio?preset=` or "Start from preset" on `/generate`.
6. If it used no upload or character, it can be published. `/creators/{handle}` then shows 30-day views and uses, and lets them edit title, description or prompt (a new version) or unpublish.

One break remains: the creation page's "in {project}" link opens the project's first scene, not the take's (planned).
