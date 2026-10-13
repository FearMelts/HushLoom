> **Draft, not final.** Written 2026-10-12 against commit 9e1db60; a critique asked for revisions (see `critiques.json` beside this file). Phase 5 of the run plan re-checks it against the merged build before it moves to `docs/`.

# Hushloom Information Architecture

Deliverable C of the Hushloom spec (Part XIV): the sitemap and route structure as built at commit 9e1db60 on branch `claude/playbox-2-foundation-q7fpbs`, plus what the launch-readiness addendum adds. Everything not marked "being added" or "planned" exists under `src/app` today. Playbox informs only the structure (gallery first, generation on the template page, a personal library, projects for continuity), never the appearance.

Naming: the spec's "Collection" is **Library** in the UI, at `/collection`. The spec's "Train" is a character-reference manager; no model is fine-tuned, and the page says so.

## 1. Sitemap and route structure

Access levels: **public** renders for anyone past the age notice; **member** redirects signed-out visitors to `/auth?next=<path>`; **owner** returns 404 for anything the signed-in user does not own; **admin** returns 404 for non-admins. The age notice is not a route: `src/app/layout.tsx` renders it in place of the shell only when there is no session, no `hl_age_ok` cookie, and the path is not under `/policies`. A signed-in user is never gated, whatever the cookie says.

### 1.1 Pages that exist

| Path | Purpose | Who | Primary actions | Entry points | Exits |
|---|---|---|---|---|---|
| `/` | Home: gallery front door (Trending, New; signed in also For You, Continue exploring, Following) | public | Make an image or video, favorite, preview, Make on a card | nav Discover, wordmark, 404 page | `/generate/{kind}`, `/explore`, `/templates/{slug}`, `/creators/{handle}`, `/settings#discovery` |
| `/explore` | Browse and search every published template; query-string filters, infinite scroll | public | sort tabs, media and category chips, search | top-bar search, tab bar Search, home "Explore all", category pills, template tags | `/templates/{slug}`, `/creators/{handle}` |
| `/templates/{slug}` | Template detail with generation in place: versions, creator, ten similar templates | public; VIP templates lock the panel for non-VIP viewers | Make it (draft, then confirm), favorite, follow, rate, report, Manage (owner) | any card (`#make` from its Make button), "Remixed from", admin report row, creation detail | `/creators/{handle}`, `/explore` (category or tag), source template, `/pricing`, `/train`, `/studio` |
| `/generate/{image\|video}` | Blank-canvas and prefilled creation (`?from`, `?scene`, `?character`) | public page, member to submit; 404 for other kinds | Make it, switch kind, Start from a template, upload with consent sheet | nav Create, rail New creation, tab bar "+", creation detail, project and Train "Make a" buttons | `/explore`, `/collection` (toast), `/studio`, `/train`, `/pricing` |
| `/studio` | Full controls, presets, job monitor | member | the whole panel plus seed, negative prompt, atmosphere, project and scene placement; delete preset; cancel job | rail Go deeper, panel "More controls in Studio", preset toast | `/studio?kind=`, `/collection/{id}` |
| `/collection` | Library: every creation the user made | member | filter, select, bulk delete, add to folder, retry failed, open | nav Library, the confirm toast's Library action, 404 page, Favorites empty state | `/collection/{id}`, `/projects`, `/` |
| `/collection/{jobId}` | One creation: media, settings, lineage, actions | owner | Remix, Retry, Variation, Continue, Extend, Reuse settings, Save, Download, Folder, Preset, Publish, Delete, Cancel, Compare | Library grid, job tray, Studio monitor, project takes, completion toast | `/generate/{kind}?from=`, `/templates/{slug}`, `/projects/{id}`, `/api/generations/{id}/download`, `/collection` |
| `/favorites` | Saved templates and favorited creations, by `?tab=` | member | open, unfavorite | rail Go deeper | `/templates/{slug}`, `/collection/{id}`, `/explore`, `/collection` |
| `/projects` | Project index with scene and clip counts | member | New project | rail Go deeper, Library, workspace back link | `/projects/{id}` |
| `/projects/{id}` | Scene workspace: timeline, continuity guide, takes | owner | add, reorder, remove scenes; save guide; Make a clip or still; Use as take; Branch; Continue; Compare; Play sequence; rename; delete | project index, creation detail "in {project}", new-project sheet | `/generate/{kind}?scene=`, `/collection/{id}`, `/projects` |
| `/train` | Character references with recorded consent | member | Add a character (photo, two consents), Remove, Make a still | nav Train, panel link when a mode needs a reference | `/generate/image?character=` |
| `/creators/{handle}` | Creator profile: published templates, collections; owner analytics | public; 404 for an unknown handle | follow; owner: edit metadata, publish or unpublish | card handle, template creator row, rail profile row | `/templates/{slug}` |
| `/settings` | Profile, discovery and privacy, consents, account | member | edit profile, toggles, interests, clear history, withdraw consent, sign out everywhere, delete account | rail Settings icon, tab bar You, home "Tune" | `/auth` (after sign-out), `/` (after deletion) |
| `/pricing` | Credits and passes; balance and ledger when signed in | public | buy a pack or pass | credit pill, VIP lock, short-balance line, rail Pricing | checkout URL (processor hosted; `/pricing/sandbox` in sandbox mode, being added, see 1.2) |
| `/auth` | Create account or sign in | public; signed-in users bounce to `next` | sign up (email, password, handle, name, date of birth, two attestations), sign in | every member redirect, rail, tab bar, card favorite when signed out | `next` (sanitized, default `/`), `/policies` |
| `/admin` | Operator console: stats, reports, models, audit log | admin | remove or dismiss reports, suspend, set model price and enable, adjust credits | rail shield icon (admins only) | `/templates/{slug}` (reported item) |
| `/policies` | Adults-only, content, consent, privacy, credits, demo | public; bypasses the age notice | none | age notice footer, rail, signup terms link | in-page anchors |
| any unknown path | "A loose thread" 404 | public | none | bad or foreign ids | `/`, `/collection` |

### 1.2 Pages being added by the addendum

| Path | Purpose | Who | Status |
|---|---|---|---|
| `/pricing/sandbox` | Sandbox checkout: says no money moves; Complete and Cancel post a signed sandbox event to the payment webhook, so credits reach the ledger as with a live processor. Replaced by the processor's hosted page once CCBill or Segpay keys are set. | member, while `PAYMENT_PROVIDER=sandbox` | being added |
| `/verify` | Age-verification status (unverified, pending, verified, failed, expired) and start page for covered jurisdictions. Linked from the 451 refusal and from Settings. | member | being added (path proposed here) |
| `/verify/sandbox` | Sandbox verification page: labeled as such, returns a signed callback, never marks a real user verified in production. | member, while `AGE_VERIFICATION_PROVIDER=sandbox` | being added |
| `/offline` | Service-worker fallback when the shell is cached but the server is unreachable; nothing chargeable. | installed app | being added |
| `/admin/review` | Review queue for scanner matches and takedown requests, separate from `/admin` reports. Evidence stays under legal hold; actions: report, hold, dismiss. | admin | being added |
| `/policies/takedown` | Takedown form for nonconsensual intimate imagery and likeness misuse; bypasses the age notice like all of `/policies`; writes a `takedown_requests` row. | public | being added |

Also being added: `manifest.webmanifest`, the app icons and `sw.js`, which caches the app shell only, never `/api/*` responses or media.

## 2. Navigation model

The shell (`src/components/shell.tsx`) defines two lists. **Primary**: Discover `/` (active on `/`, `/explore*`, `/templates*`), Create `/generate/image` (active on `/generate*`), Library `/collection`, Train `/train`. **Secondary** ("Go deeper"): Projects, Studio, Favorites. Everything else is reached contextually or from the account area.

| Surface | Width | Contents |
|---|---|---|
| Desktop rail | 1024 px and up, fixed 236 px | wordmark; primary; Go deeper; footer: New creation (`/generate/video`), credit pill (`/pricing`), admin shield, Settings, profile row (`/creators/{handle}`); signed out: Join or sign in; always: Pricing, Content policy and privacy (`/policies`) |
| Top bar | all widths | wordmark below 1024 px; search (640 px and up) submits to `/explore?q=`; credit pill below 1024 px; Create or Sign in |
| Mobile tab bar | below 1024 px | Discover, Search (`/explore`), center "+" (`/generate/image`), Library, You (`/settings`) or Sign in (`/auth`) |
| Job tray | all widths, signed in | floating list of running creations, each linking to `/collection/{id}`; sits above the tab bar |
| "You" sheet | below 1024 px | planned, not built: a sheet listing Favorites, Projects, Studio, Train, Settings, Pricing, Policies, Install app, Notifications and Verify age. Today You goes straight to `/settings`, so the Go deeper pages are unreachable from phone chrome (UX audit, gap 4). |

Contextual reachability keeps the main nav uncrowded (spec Part VI):

- **Studio**: the panel's Tweak section ("More controls in Studio"), the preset-saved toast, the rail. Never required; the same panel runs on template pages and `/generate` with Tweak collapsed.
- **Train**: the panel, when a mode needs a character reference and the user has none; the rail.
- **Projects**: the Library, a creation's "in {project}" line, the rail; the workspace alone launches scene-bound generation.
- **Pricing**: passive only (credit pill, VIP lock notice, short-balance line). No interstitials.
- **Admin**: a rail icon for admins; the page 404s for everyone else.

## 3. Relationship map

How the hubs link, by the object that carries the link:

- **Explore and Home to Template and Creator.** A template card opens `/templates/{slug}` (its Make button lands on `#make`); the handle on a card or creator row opens `/creators/{handle}`.
- **Template to Generate, Explore and Template.** The Create panel is embedded on the template page, and a draft records `templateId` and `templateVersion`. Category and tags link to `/explore?category=` and `/explore?q={tag}`. "Remixed from" links the source template (`templates.remixed_from_id`).
- **Generate to Library.** Confirm queues the job; the tray and the toast link to `/collection/{jobId}`.
- **Library to Generate, Template, Projects, Studio, Folders and Favorites.** A creation derives new ones: Remix (`?from=`, new seed), Reuse settings (`&reuse=exact`), Retry, Variation, Continue, Extend. Publish turns a completed creation into a public template with a copied asset; creations from uploads or character references cannot be published. The "in {project}" line opens the project; Studio and scene-bound drafts set `projectId`. Save preset leads to `/studio?preset={id}`. Folders and favorites are `/collection?folder=` and `/favorites?tab=creations`.
- **Projects to Generate and Library.** Make a clip or still carries `?scene={id}` (continuity note, lighting and framing, character reference, studio mode). Every take is a creation, and take cards open `/collection/{jobId}`.
- **Train to Generate and Projects.** `/generate/image?character={id}` sets reference-guided mode; the continuity guide's Character select uses the same references.
- **Studio to Library.** Job monitor rows link to `/collection/{id}`.
- **Creator profile to Template.** The published grid and the collection rails.
- **Settings to Home.** Personalization, history and autoplay toggles change what Home shows; the assistant toggle only hides non-blocking suggestions in the Create panel.

The spec's loop (Discover, Choose, Personalize, Generate, Remix, Continue, Explore again) maps to card, template page, panel, confirm sheet, creation detail, derive or scene, and the "You might also like" rail.

## 4. Object model as the IA sees it

| Object | Table | Canonical URL | Reached from, links to |
|---|---|---|---|
| Template | `templates` | `/templates/{slug}` (uuid also resolves) | cards everywhere; links to creator, category, tags, source template |
| Template version | `template_versions` | none; Version history on the template page | created by publish (v1) and by a prompt edit through `PATCH /api/templates/{uuid}` |
| Creation (job) | `generation_jobs` | `/collection/{jobId}` | Library, tray, Studio monitor, project takes; carries template, project, scene, parent job, relation |
| Output | `generation_outputs` + `media_assets` | no page; bytes through signed `/api/media` or `/api/generations/{id}/download` | `scan_status` (default `pending`) and `legal_hold` (default `false`) exist in the schema; at this commit nothing reads them at serve time, and serving only `clean` assets is planned work for the scanning track |
| Project | `projects` | `/projects/{id}` | index, creation detail |
| Scene | `project_scenes` | none; the active scene in the workspace | `?scene=` on `/generate/{kind}`; `/projects/{id}?scene=` is planned so a return lands on the same scene |
| Scene version (take) | `scene_versions` | none; one per job, under its scene | branch label main or alternate, selected flag |
| Character reference | `character_references` | `/train` | `?character=` on `/generate/image`; scene continuity guide |
| Preset | `saved_presets` | `/studio?preset={id}&kind=` | Studio sidebar; saved from a creation |
| Folder | `folders` | `/collection?folder={id}` | Library filter and Add to folder sheet |
| Collection (Library) | not a table | `/collection` | a view over jobs, outputs, favorites and folders; creator-curated `template_collections` render read-only on creator pages, with no UI to create them yet |
| Favorite | `favorites` | `/favorites?tab=` | polymorphic: template or creation |
| Creator | `users`, `user_profiles`, `creator_profiles` | `/creators/{handle}` | a member becomes a creator on first publish |

Being added by the four tracks: `age_verifications` plus a status on `users` (`/verify`, `/settings`; unverified, pending, verified, failed, expired; no ID images stored); a transaction reference and provider on `payment_events` (`/pricing`; refunds and chargebacks post `refund` and `chargeback` ledger rows); `takedown_requests` (`/policies/takedown`, `/admin/review`); `push_subscriptions` (`/settings`; one row per device, tied to the session, removed at logout); `account_flags` (`/admin/review`; kinds chargeback, csam_match, manual_review, credit_debt).

## 5. API route inventory by domain

All routes live under `src/app/api`. Auth levels: anon; member (401 when signed out); owner (404 when not yours); admin (404 when not admin); signature (webhooks and media links). Every mutating call outside `/api/webhooks/*` must be same-origin or it gets 403 `bad_origin` (`src/middleware.ts`).

| Domain | Method and path | Auth |
|---|---|---|
| Infrastructure | GET `/api/health`; GET `/api/media?k&e&s[&d]` | anon; signed link |
| Age notice and auth | POST `/api/age-gate` | anon |
| | POST `/api/auth/signup` (10 per hour per IP); POST `/api/auth/login` (30 per 15 min per IP, 10 per 15 min per email) | anon, rate limited |
| | POST `/api/auth/logout` | anon, no rate limit |
| Account | GET, PATCH, DELETE `/api/me`; PATCH `/api/me/preferences`; DELETE `/api/me/history`, `/api/me/sessions` | member |
| | DELETE `/api/me/consents/{id}` | owner |
| Uploads and Train | POST `/api/uploads` (multipart, consent required, scanned before use); GET, POST `/api/characters` | member |
| | DELETE `/api/characters/{id}` | owner |
| Generation | GET, POST `/api/generations` (list; create draft) | member |
| | GET, DELETE `/api/generations/{id}`; POST `/api/generations/{id}/confirm` (echoes `expectedCost`), `/cancel`, `/derive`; GET `/api/generations/{id}/download` (302 to a signed link) | owner |
| Templates and discovery | GET `/api/templates` (browse, search, filters, pagination) | anon |
| | POST `/api/templates` (publish a completed creation); POST `/api/templates/{id}/rate`, `/report` | member |
| | PATCH `/api/templates/{uuid}` (metadata, status, new prompt version) | owner or admin |
| Social | POST, DELETE `/api/favorites`; POST, DELETE `/api/follows` | member |
| Library organisation | GET, POST `/api/folders`; GET, POST `/api/presets` | member |
| | DELETE `/api/folders/{id}`; POST `/api/folders/{id}/items`; DELETE `/api/presets/{id}` | owner |
| Projects and scenes | GET, POST `/api/projects` | member |
| | GET, PATCH, DELETE `/api/projects/{id}`; POST, PUT `/api/projects/{id}/scenes` (add; reorder); PATCH, DELETE `/api/scenes/{id}`; POST `/api/scenes/{id}/select` | owner |
| Payments | POST `/api/checkout` (today Stripe-only and 503 without keys; being rewired to the active adapter) | member |
| | POST `/api/webhooks/stripe` | Stripe signature; adapter off by default |
| Provider webhooks | POST `/api/webhooks/replicate` (verifies and logs only) | HMAC signature |
| Admin | POST `/api/admin/credits`; PATCH `/api/admin/models/{key}`; POST `/api/admin/reports/{id}`; POST `/api/admin/users/{id}/suspend` | admin |

Routes being added by the four tracks. Names are proposed here and the implementing tracks own the final paths; the `/api/webhooks/` prefix matters because the origin check already exempts it.

| Domain | Method and path | Auth | Status |
|---|---|---|---|
| Payments | POST `/api/webhooks/ccbill`, `/api/webhooks/segpay`, `/api/webhooks/payments-sandbox` | processor signature; unsigned, malformed or replayed events rejected | being added |
| Age verification | POST `/api/verify/start`; POST `/api/webhooks/age-verification` | member; provider signature | being added |
| Scanning | no public route; `scanAsset` runs inside uploads and the worker; `/api/webhooks/scan` if Cloudflare's edge callback is used | internal; signature | being added |
| Push | GET `/api/push/public-key`; POST, DELETE `/api/push/subscriptions` | anon; member | being added |
| Takedown and review | POST `/api/takedown`; POST `/api/admin/review/{id}` | anon (rate limited); admin | being added |

What the adapters do (`src/server/payments`, `src/server/age`, `src/server/safety/scan`, `src/server/push`). `PAYMENT_PROVIDER` (default `sandbox`; `ccbill`, `segpay`, `stripe`) picks the payment adapter, which verifies every webhook and normalizes events to `purchase_completed`, `subscription_*`, `refund` and `chargeback`; Stripe stays off unless selected, since its policy bans adult content. `AGE_VERIFICATION_PROVIDER` (default `sandbox`; `yoti`, `veriff`) picks the age adapter that `assertAgeVerified` consults in draft creation and uploads for `GB` and the US states in `src/config/jurisdictions.ts` (`AGE_VERIFICATION_REGIONS` overrides the list; the operator re-checks it before launch). `SCAN_PROVIDER` (default `dev`; `photodna`, `cloudflare`) picks the scanner that `scanAsset` runs on every upload and generated output. With `SCAN_FAIL_CLOSED` at its default of true, production refuses to start on `dev` (`src/server/env.ts`); set to false, production starts on the dev scanner, which matches nothing, so that is an explicit opt-out, not a safe mode. Push uses VAPID keys and `notifyJobFinished`, which the worker calls with only the job id and outcome. At this commit the three hooks are stubs the tracks are filling in: `assertAgeVerified` returns without checking, and `scanAsset` returns `clean` without recording a verdict. Until the owner adds account keys, payments, age verification and scanning run in labeled sandbox or dev mode, and the UI and the verification report say so.

## 6. URL conventions

| Convention | Rule |
|---|---|
| Identifiers | Jobs, projects, scenes, folders, presets, characters and consents use UUIDs. Templates link by slug (`{title-slug}-{5 random chars}`); the page also accepts the uuid, and `PATCH /api/templates/{id}` requires it. Creators are addressed by handle, case-insensitive. A malformed uuid is a 404, never a 500. |
| Ownership in the URL | A valid id that belongs to someone else is a 404, identical to a missing one. |
| Filters | Server-rendered from the query string, so every filtered view is a shareable URL: `/explore?q=&category=&media=image\|video&sort=trending\|new\|top_rated\|most_favorited`; `/collection?media=&status=&favorites=1&folder={uuid}&model={key}&sort=newest\|oldest`; `/favorites?tab=templates\|creations`; `/studio?kind=image\|video&preset={uuid}`. Unknown values fall back to defaults. |
| Prefill | `/generate/{kind}?from={jobId}` copies prompt, model and params from your own creation and drops the seed; `&reuse=exact` keeps it. `?scene={sceneId}` binds the draft to that project and scene and opens the panel in studio mode. `?character={id}` (images only) sets reference-guided mode. Ids you do not own are ignored. |
| Return paths | `/auth?next=/path` must start with `/` and not `//`; `?mode=signin` picks the sign-in tab. `/pricing?checkout=success\|cancelled` shows a status banner. |
| Anchors | `/templates/{slug}#make` scrolls to the Create panel. `/policies#adults`, `#content`, `#consent`, `#privacy`, `#credits`, `#demo`. Home links to `/settings#discovery`; the settings page still needs that id (open defect). |
| API bodies | JSON, except the two multipart uploads. Drafts, derives and admin credit adjustments carry a client idempotency key; confirm echoes `expectedCost` and gets 409 if the price moved. Errors share one envelope: `{ error: { code, message, details? } }`. |
| Media | Only signed, expiring `/api/media` links (or presigned S3 URLs) appear in HTML; storage keys are never linked. Public covers get one-hour links, private outputs five minutes. |
| Webhooks | Everything under `/api/webhooks/` skips the origin check and must verify a provider signature instead. |
| Robots | Every page sends `noindex, nofollow` in metadata and headers. |

## 7. Three-perspective walkthrough

**Returning user.** Lands on `/` (the age cookie and the session each last 30 days). Scrolls Trending or For You, taps a card, hits Make. `/templates/{slug}#make` opens with the panel in view, defaults filled, the cost line visible. Make it opens the confirm sheet (cost, balance after, model name). Confirm queues the job; the tray shows "1 weaving" on every page, and the toast's Open action lands on `/collection/{jobId}`. From there Remix goes to `/generate/video?from=`, or Save adds a favorite. The "You might also like" rail returns them to discovery. On a phone the same path runs through the tab bar: Discover, card, Make, confirm, tray, Library.

**New user.** Any URL first shows the age notice ("I am 18 or older, enter" or "Leave", with a link to `/policies`). `/` loads with public posters and previews; no account is needed. The template page shows the price in credits before asking for anything. Pressing Make redirects to `/auth?next=/templates/{slug}`: email, password, handle, name, date of birth, two attestations; under 18 is refused on the server. Back on the template page with the signup grant, confirm runs. Being added: for users in the UK or a listed US state, the draft will return 451 `age_verification_required` with a link to `/verify`, which starts the provider session (`/verify/sandbox` until a provider is configured) and brings them back verified, pending or failed. Today `assertAgeVerified` is a stub (section 5), so only the legacy `age_assurance_required` 451 can fire, when `AGE_ASSURANCE_STRICT_REGIONS` lists the country and the user is self-declared (`src/server/generation/service.ts`). If credits run short, the panel links to `/pricing`; checkout opens the processor's hosted page (`/pricing/sandbox` in sandbox mode, being added) and returns to `/pricing?checkout=success` with the ledger row visible. Install and notifications are offered on `/settings` (being added), never as a popup.

**Advanced creator.** Starts at `/projects`, opens `/projects/{id}`, picks a scene, edits the continuity guide (lighting, framing, palette, a character from `/train`). Make a clip goes to `/generate/video?scene={id}` with the panel in studio mode and the scene set. After confirm the take appears under its scene; Use as take, Branch and Continue create sibling or child takes with cost confirmation; Compare puts two side by side; Play sequence plays the selected takes in order. Everything is server-side; the planned `?scene=` on the workspace URL will land a return on the same scene. A good result becomes a preset (`/studio?preset=`) or, if it used no uploads or likeness references, a published template, after which `/creators/{handle}` shows 30-day views and uses and lets them edit metadata or unpublish.
