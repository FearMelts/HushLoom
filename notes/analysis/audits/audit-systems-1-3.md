# Spec audit: Systems One–Three and the Part V journey

Repository: `/home/claude/hushloom`, branch `claude/playbox-2-foundation-q7fpbs`, HEAD `a4752a9` (code last changed at `0987b7c`). Read-only review; nothing was run. Every `file:line` below was read in this session. Statements marked **[inferred]** are reasoning about behaviour, not something a test or a run proved.

Context that frames the whole audit: no AI provider credentials exist. The only configured provider is `demo` (`src/server/env.ts:263` `ENABLE_DEMO_PROVIDER` defaults to `"true"`; `src/server/ai/providers/demo.ts:363`). `replicate-flux-schnell` is registered but reports `available: false, reason: "Needs credentials"` (`src/server/ai/providers/index.ts:497-502`). Per the task brief, generation being a labeled demo is expected and is not counted as a gap; only misrepresentation of a demo as real would be.

Status legend: **met** / **partial** / **missing** / **demo-only** (works end to end, but the output is the labeled demo placeholder, as expected).

---

## System One: AI-Powered Discovery

| # | Requirement (spec Part III §1) | Status | Evidence |
|---|---|---|---|
| 1.1 | Keep browsing categories | met | `listCategories` `src/server/discovery/templates.ts:254-256`; category chips on home `src/app/page.tsx:48-54`, on Explore `src/components/explore-feed.tsx:263-267`; `?category=` filter `discovery/templates.ts:154`. |
| 1.2 | Trending / New / Top Rated / Most Favorited | met | `sortExpr` `discovery/templates.ts:49-60`; trending score = 7-day generate events ×3 + favorites ×2 + generationCount (`:42-45`); Bayesian top-rated (`:47`); tabs `explore-feed.tsx:152-157, 235-251`; API enum `src/app/api/templates/route.ts:13`. |
| 1.3 | Search | met | `ilike` on title/description/creator handle + tag unnest `discovery/templates.ts:143-153`; header search `src/components/shell.tsx:283-306`; mobile search form `explore-feed.tsx:216-233`. |
| 1.4 | For You | met | `forYou` `discovery/templates.ts:212-252` (favorites w=3, generate w=2, view w=1, interests w=4; category + tag affinity only; excludes own templates `:248`); rendered `page.tsx:57-70` with a "Tune" link to `/settings#discovery`. Test: `tests/integration/platform.test.ts:242-253`. |
| 1.5 | Similar Creations / Related | partial | Related *templates* exist: `similarTemplates` (category + tag overlap) `discovery/templates.ts:174-186`, rail "You might also like" `src/app/templates/[id]/page.tsx:37, 152-157`. There is no "similar creations" surface in the Library or on a creation. |
| 1.6 | Continue Exploring / Recently Viewed | met | `recentlyViewed` from `discovery_events` where `event='view'` `discovery/templates.ts:188-197`; view recorded on template open only when `historyEnabled !== false` `templates/[id]/page.tsx:33-36`; rail `page.tsx:72-77`. |
| 1.7 | Recommended Templates | met | Same as 1.4 (For You). No separate "recommended" layer. |
| 1.8 | Saved Inspirations | partial | `/favorites` page with Templates and Your creations tabs `src/app/favorites/page.tsx:94-128`; nothing on the home feed surfaces saved templates. |
| 1.9 | Following | met | `followingFeed` `discovery/templates.ts:199-205`; rail `page.tsx:92-97`; follow/unfollow `src/server/social.ts:269-275`, `FollowButton` `src/components/template-detail.tsx:209-234`. |
| 1.10 | Related Visual Styles | missing | No style/visual-similarity layer. Tags on a template are plain links to `/explore?q=<tag>` `templates/[id]/page.tsx:98-108`. |
| 1.11 | Card: poster/media preview | met | Poster `<img loading="lazy">` + preview `<video preload="none" muted loop playsInline>` revealed on hover/focus or explicit button `src/components/template-card.tsx:363-386, 409-418`; autoplay only if the user opted in (`autoplayPreviews` default false `src/server/db/schema.ts:125`, `page.tsx:25`). |
| 1.12 | Card: title, creator, media type, duration, quality/VIP, favorite | met | Title/creator `template-card.tsx:433-441`; VIP/New/4K badges `:388-392`; video badge with `${durationS}s` `:409-418`; favorite button with `aria-pressed`, optimistic update and rollback `:336-352, 394-406`; favorite count `:442-444`. |
| 1.13 | Card: Quick Generate | partial | "Make" on the card is a `<Link href="/templates/${slug}#make">` `template-card.tsx:422-427`. It navigates to the detail page; generation then needs "Make it" plus the confirm sheet. There is no in-gallery generate. |
| 1.14 | Card: details, related, remix | partial | Details link yes (`:363, 434`). "Related" and "remix" live on the detail page only (`templates/[id]/page.tsx:152-157`; remix is a creation-level action, see 2.19). |
| 1.15 | Signals: favorites, viewed categories, explicit preferences, saved interests | met | All four feed `forYou` `discovery/templates.ts:217-238`; interests editable `src/components/settings.tsx:142-156`, schema `src/server/me.ts:176`. |
| 1.16 | Users control personalization, can clear history | met | `personalizationEnabled`, `historyEnabled` toggles `settings.tsx:120-133`; `PATCH /api/me/preferences` `src/app/api/me/preferences/route.ts:73-77`; turning history off deletes it `me.ts:229-230`; `DELETE /api/me/history` `src/app/api/me/history/route.ts:65-68` → `clearHistory` `me.ts:234-238` (audited). |
| 1.17 | Never infer sensitive attributes | met | Only `category_id` and `tags` are aggregated `discovery/templates.ts:217-229`; the settings copy says so `settings.tsx:122`. |
| 1.18 | Fast browsing, skeletons, lazy media | met | `GridSkeleton` during load-more `explore-feed.tsx:285-289, template-card.tsx:472-484`; `.skeleton` shimmer `src/app/globals.css:112-123`; IntersectionObserver with 600px `rootMargin` + "Load more" fallback `explore-feed.tsx:203-209, 290-296`; pagination capped at 60 per page `api/templates/route.ts:16`. |
| 1.19 | Keyboard nav | met (basic) | Cards are links/buttons; focus plays the preview and reveals "Make" (`template-card.tsx:359, 424` `focus:opacity-100`); skip link `shell.tsx:332-334`; e2e checks skip link and that every visible control is labelled `tests/e2e/journey.spec.ts:149-167`. No arrow-key/roving grid navigation. |
| 1.20 | Responsive gallery | met | 2→6 columns `template-card.tsx:452`; snap rails `:460-470`; e2e no-horizontal-scroll at 390/820/1440 `journey.spec.ts:129-147`. |
| 1.21 | Reduced motion honoured | met | `@media (prefers-reduced-motion: reduce)` cuts all animation/transition to 1ms `globals.css:132-140`. |

---

## System Two: Intelligent Template Remix

| # | Requirement (spec Part III §2) | Status | Evidence |
|---|---|---|---|
| 2.1 | Select template → generate with defaults immediately | met (two taps + confirm) | Template page mounts `CreatePanel` with the version's prompt/model/defaults `templates/[id]/page.tsx:110-131`; "Make it" enabled with defaults `src/components/create-panel.tsx:645-655`; confirm sheet `:699-733` is required by Part V ("user confirms chargeable ops"). |
| 2.2 | Optional: image upload | met | Mode chips `create-panel.tsx:258-266`; upload UI when the mode needs an image `:268-322`; consent sheet before upload `:678-697`; server `acceptUpload` re-encodes, strips EXIF, records consent `src/server/media.ts:36-90`; `POST /api/uploads` 422 `consent_required` without the flag `src/app/api/uploads/route.ts:507`. |
| 2.3 | Prompt editing | met | `create-panel.tsx:360-371`. |
| 2.4 | Camera movement | met | `:551-560`, only when `model.supports.cameraMovement`. |
| 2.5 | Motion intensity | met | `:561-565`. |
| 2.6 | Scene pacing | met | `:567-576` (video only). |
| 2.7 | Atmosphere | partial | Only rendered when `studio` is true `:594-598`; on the template page and `/generate` it is hidden (reachable only through "More controls in Studio →" `:631-633`). The server accepts it everywhere `src/server/generation/service.ts:52`. |
| 2.8 | Lighting, framing | met | `:577-592`. |
| 2.9 | Aspect ratio, duration, quality | met | `:517-550`; "4K (2× credits)" label `:545`. |
| 2.10 | Presets | partial | Presets apply only via Studio: `/studio?preset=<id>` `src/components/studio.tsx:26`, `src/app/studio/page.tsx:138-142`. No preset picker in the template panel or `/generate`. |
| 2.11 | AI translates natural language into settings | met (rules, labelled neutrally) | `interpret()` `src/lib/copilot.ts:197-282` maps aspect, duration, camera, intensity, pacing, lighting, framing, quality; snaps to the model's offered values and lists what the model cannot do (`unsupported`). UI button is "Interpret" `create-panel.tsx:433-435`; no claim of AI. Unit tests `tests/unit/copilot.test.ts:331-348`. |
| 2.12 | Show interpreted settings before submission when they change result or cost | met | "This would set:" list with a reason per field `create-panel.tsx:437-451`; "Cost changes from X to Y credits" `:452-460`; Apply/Dismiss `:466-484`. |
| 2.13 | Validate incompatible combos | met | Server `validateAgainstModel` → 422 `unsupported_settings` `service.ts:166-167`, `src/server/ai/registry.ts:136-178` (mode, aspect, duration, quality, negative prompt, seed, camera, intensity). Client: conflict detection `copilot.ts:81-88`; `switchModel` drops params the new model cannot take `create-panel.tsx:150-167`. Test `tests/integration/generation.test.ts:369-375`. |
| 2.14 | Preserve template defaults unless overridden | met | `original` snapshot `create-panel.tsx:72-75`; "Restore original" `:136-140, 353-357`; server stores `templateVersion` on the job `service.ts:210, 252`. |
| 2.15 | Action: Generate | demo-only | `POST /api/generations` → `createDraft` (status `awaiting_confirmation`, cost) `service.ts:240-264`; `POST /api/generations/[id]/confirm` with `expectedCost` → reserve + enqueue `service.ts:276-323`; worker `src/worker/index.ts:115-121`. Output is the labelled demo placeholder. |
| 2.16 | Action: Remix | partial (see D3) | "Remix" → `/generate/<kind>?from=<jobId>` `src/components/creation-detail.tsx:232-234`; `prefillFor` copies prompt/params minus seed `src/app/generate/[kind]/page.tsx:355-371`. The new draft carries no `parentJobId`, `relation`, or `templateId` (`create-panel.tsx:200-213`), so the remix is not linked to its source. |
| 2.17 | Action: Reuse Settings | met | `?reuse=exact` keeps the seed `generate/[kind]/page.tsx:367`; button `creation-detail.tsx:251-253`. |
| 2.18 | Action: Save Preset | partial | Only from a finished creation `creation-detail.tsx:267-269, 405-438`; `createPreset` strips the seed `src/server/presets.ts:453`; owner-only (test `tests/integration/platform.test.ts:357-366`). Not offered while composing. |
| 2.19 | Action: Create Variation | demo-only | `deriveDraft(..., "variation")` reseeds `service.ts:370`; button `creation-detail.tsx:238-240`; lineage recorded (`parentJobId`, `relation`) and tested `generation.test.ts:398-408`. |
| 2.20 | Action: Continue Scene | demo-only | `deriveDraft(..., "continuation")` sets mode `scene_continuation` with the clip as input `service.ts:373-383`; only for finished video (`422 unsupported` otherwise); button `creation-detail.tsx:243-245`. `demo-motion` lists `scene_continuation` `registry.ts:99`. |
| 2.21 | No multi-step wizard | met | Single panel; progressive "Tweak" disclosure `create-panel.tsx:489-503`. |
| 2.22 | Cost visible before execution | met | Live cost line `create-panel.tsx:656-670` (`estimateCost`, same function as the server `registry.ts:181-192`); the confirm sheet shows the server's `draft.costCredits` and balance-after `:702-715`. |

---

## System Three: Invisible Creative Copilot

| # | Requirement (spec Part III §3) | Status | Evidence |
|---|---|---|---|
| 3.1 | Embedded, distributed (no chat) | met | Pure function `analyze()` `src/lib/copilot.ts:43-176` runs in the panel via `useMemo` `create-panel.tsx:108-116`; suggestions render inline `:375-410`. No chat surface anywhere. |
| 3.2 | Improves prompts | met | `short-prompt` patch appends light/framing/texture `copilot.ts:60-71`; `long-prompt` advice `:72-79`. Patch shown before apply `create-panel.tsx:393`. |
| 3.3 | Recommends templates | missing | Nothing in `copilot.ts` or the create surfaces suggests templates. Recommendations exist only on discovery pages (For You, related). |
| 3.4 | Detects unsupported aspect ratios | met | `aspect-unsupported` with nearest supported patch `copilot.ts:90-100`; test `copilot.test.ts:308-311`. |
| 3.5 | Flags low-res uploads | met | `low-res` when short side < `model.minInputShortSidePx` `copilot.ts:102-111` (512 for demo models `registry.ts:90, 105`); plus `aspect-crop` `:112-126`; test `copilot.test.ts:313-323`. Server also returns `warnings: ["low_resolution"]` `media.ts:72` but the panel never renders that field (`create-panel.tsx:40, 177`). |
| 3.6 | Explains artifacts | met | `artifact-risk` (intensity ≥ 8 and duration ≥ 5) with a patch to 5 `copilot.ts:129-141`; `text` lettering warning `:164-166`. |
| 3.7 | Recommends motion/camera | met | `camera` suggestion from prompt nouns `copilot.ts:142-158`. |
| 3.8 | Detects conflicts | met | Six prompt-level contradictions `copilot.ts:25-32, 81-85`; camera param vs prompt `:86-88`; test `copilot.test.ts:303-306`. |
| 3.9 | Suggests coherent settings | partial | Camera/intensity suggestions only; no suggestions for lighting/framing/pacing coherence with the prompt. |
| 3.10 | Explains controls | partial | Hints on motion intensity `create-panel.tsx:562`, seed `:605`, model notes `:515`; camera/pacing/lighting/framing have no hint text. |
| 3.11 | Helps reproduce results | met | "Reuse settings" keeps seed (2.17); seed hint "Same seed + same settings = closest repeat" `:605`; settings grid on the creation incl. seed `creation-detail.tsx:146-159, 281-290`. |
| 3.12 | Assists scene extensions | met | `continuity` note when the model's `continuity === "none"` `copilot.ts:167-174`; scene continuity note prefilled from the scene `generate/[kind]/page.tsx:380-391`, flagged in the panel `create-panel.tsx:372`. |
| 3.13 | Small contextual suggestions | met | Compact list items, severity-coloured, dismissible `create-panel.tsx:375-410`. |
| 3.14 | Never auto-overwrite prompts | met | Patches apply only on click `applyPatch` `:122-128`; `interpret` result applies only on "Apply" `:466-479`. |
| 3.15 | Show changes before applying | met | Patched prompt text shown `:393`; interpreted field list with reasons `:442-451`. |
| 3.16 | Undo and Restore Original | met (see D1) | 20-deep `history` `:119-121`, `undo` `:129-135`, `restore` `:136-140`, buttons `:348-357`. |
| 3.17 | No unsolicited conversation | met | No chat, no modal prompts; the "wish" box is user-initiated `:412-436`. |
| 3.18 | User-controlled preferences | met | `copilotEnabled` pref `schema.ts:126`, toggle `settings.tsx:135-140`; when off, only `block` severity survives `create-panel.tsx:112`; wired via `createContext` `src/server/create-context.ts:453, 470`. |
| 3.19 | Policy block before spend | met | `analyze` runs `checkPrompt` client-side (`copilot.ts:55-58`), disables "Make it" (`create-panel.tsx:117, 651`); the server enforces independently with 422 `policy_blocked` + moderation event `service.ts:169-182`. e2e `journey.spec.ts:116-127`; integration `generation.test.ts:360-367`. |

---

## Part V: Core journey

| Step | Requirement | Status | Evidence |
|---|---|---|---|
| Discover | Media-first feed | met | Home `page.tsx:28-112`; Explore `explore/page.tsx`. |
| Choose | Preview, metadata, creator, Generate visible | met | `TemplateMedia` with play/pause `template-detail.tsx:170-207`; badges/metadata/tags `templates/[id]/page.tsx:49-108`; creator + follow `:62-71`; `CreatePanel` on the same page `:110-131`. |
| Personalize | Defaults or options; AI available | met | Systems 2 and 3 above. |
| Generate: authorization | met | `requireUser` → 401 `src/server/http.ts:179-183`; sessions require `users.status = 'active'` `src/server/auth/session.ts:64`; age-gate cookie `hl_age_ok` for browsing `src/app/layout.tsx:28-30`, `src/app/api/age-gate/route.ts`; strict-region 451 `service.ts:153-159`; cross-origin writes 403 `src/middleware.ts:220-227` (e2e `journey.spec.ts:103`). |
| Generate: input compatibility | met | `validateInputs` (ownership, consent, counts) `service.ts:104-143`; `validateAgainstModel` `:166-167`; model availability 422/503 `:161-164`. |
| Generate: entitlements | met | VIP template → 403 `vip_required` `service.ts:207-209`; UI lock `create-panel.tsx:249-256`; concurrency → 429 `too_many_active` `service.ts:289-295` (test `generation.test.ts:377-385`). |
| Generate: credits + estimated cost + user confirms | met | Draft returns `costCredits` `service.ts:238, 261`; confirm requires `expectedCost` (409 on mismatch `:286-288`); reservation `src/server/credits/ledger.ts:71-80`; insufficient → 402 `http.ts:216-221` (test `generation.test.ts:266-273`). Confirm sheets: `create-panel.tsx:699-733`, `creation-detail.tsx:326-343`. Exception: Library Retry, see D2. |
| Generate: real job submitted | met | `enqueueGeneration` (BullMQ, attempt-scoped job id) `src/server/generation/queue.ts:100-102`; worker `src/worker/index.ts:115-121`; e2e on the production standalone build `journey.spec.ts:39-82`. |
| Receive Result: clear status | met | State machine `schema.ts:39-47`; `JobTray` polls `/api/generations?active=1` only while something runs, shows status + elapsed time, no fake percentage `src/components/job-tray.tsx:546-591, 616`; Library thumb running state `src/components/library.tsx:335-344`; `STATUS_LABEL` `src/lib/format.ts:148-156`. |
| Receive Result: playback | met | `<video controls>` with poster `creation-detail.tsx:45-46`; signed, expiring media URLs `src/server/media.ts:13-18`, verified in `src/app/api/media/route.ts:50-52` (403 on bad signature, e2e `journey.spec.ts:98-100`); Range support `:65-76`. |
| Receive Result: demo labelled | met | `isDemo` on job and output `schema.ts:382, 427`; "Demo" badge + explanatory note `creation-detail.tsx:187-191, 198`, `library.tsx:355`; toasts say "demo" `job-tray.tsx:556`, `create-panel.tsx:231`; watermark `demo.ts:270, 314`; download filename suffix `-demo` `src/app/api/generations/[id]/download/route.ts:21`. |
| Receive Result: failures actionable, correct credits | met | `finishFailed` releases the reservation and stores a user-facing message that says credits were returned `src/server/generation/processor.ts:191-208`, `src/server/ai/providers/types.ts:245-254`; Retry on failed thumb `library.tsx:374-378` and on detail `creation-detail.tsx:235-237`; tests `generation.test.ts:308-345`. |
| Remix or Continue | met | Remix, Retry, Variation, Continue, Extend, Reuse, Save, Download, Folder, Preset, Publish, Delete `creation-detail.tsx:231-278`; version compare `:292-322` via `lineage` `src/server/generation/views.ts:130-149`. |
| Return to Discovery | partial | Creation detail links back to its source template and project `creation-detail.tsx:204-223` but shows no related-templates rail; Library's empty state links to `/` `library.tsx:530`. |

---

## Defects (verified)

Ordered by user impact.

### D1 — Stale draft confirmed after Undo / Restore / model or mode change (high)
`src/components/create-panel.tsx`. `startDraft` reuses `idemKey.current` if set (`:198`), and the server returns the *existing* job for a repeated key regardless of the request body (`src/server/generation/service.ts:147-151`). The key is cleared on prompt edits (`:365`), `setParam` (`:148`), `applyPatch` (`:127`), successful upload (`:179`) and successful confirm (`:229`), but **not** on `undo()` (`:129-135`), `restore()` (`:136-140`), `switchModel()` (`:150-167`, writes `setParams` directly), mode chips `setMode` (`:261`), `setNegativePrompt` (`:601`), removing the upload (`:285`), character/project/scene selects (`:327, 612, 620`), or when the draft sheet is dismissed with "Not now"/close (`:699, 724`).

Failure scenario: open a template, click "Make it", click "Not now"; click "Undo" or "Restore original" (or switch model/mode); click "Make it" again. The server returns the first draft (old prompt/params/model); the user confirms and is charged for, and receives, the earlier version. The confirm sheet shows `model.displayName` from client state (`:713`), so after a model switch it names a model the draft does not use. `draft.isDemo` comes from the server, so the demo label itself stays correct.

Fix (small): set `idemKey.current = null` in `undo`, `restore`, `switchModel`, the mode chip handler, `setNegativePrompt`, the upload-remove button, the three selects, and in the draft sheet's `onClose`/"Not now". Simplest single change: clear the key whenever `setDraft(null)` is called by the user, plus in `switchModel`/`setMode`/`undo`/`restore`. Optionally show `draft.modelKey` in the sheet instead of client state.

### D2 — Library "Retry" charges without a cost confirmation (medium)
`src/components/library.tsx:289-302` (`retry()` posts `/derive` then immediately `/confirm`) and `:374-378` (button on failed thumbs). The cost appears only in the after-the-fact toast ("Retrying for N credits."). Spec Part V requires the user to confirm chargeable operations and Part IX requires the cost visible before execution. The creation-detail Retry does it correctly (`creation-detail.tsx:235-237, 326-343`).

Fix (small): reuse the `Pending` sheet pattern from `creation-detail.tsx:82-110`: after `/derive`, open a sheet with `job.costCredits` and a Confirm button; only then call `/confirm`.

### D3 — Remix and Reuse-settings drop lineage and template attribution (medium)
`src/app/generate/[kind]/page.tsx:355-371` builds the prefill from `?from=<jobId>` without `parentJobId`, `relation` or `templateId`; `CreatePrefill` has no such fields (`create-panel.tsx:28-38`) and `startDraft` sends `templateId: template?.id` only (`:209`), never `parentJobId`/`relation`. Consequences: the `relation: "remix"` value in `draftSchema` (`service.ts:72`) is never produced; `lineage()` (`views.ts:130-149`) will not show the remix next to its source; a remix of a template-based creation records no `templateId`, so no `discovery_events` "generate" row (`service.ts:316-318`), no `generationCount` increment (`processor.ts:370-375`), and the "From <template>" line on the new creation reads "From scratch" (`creation-detail.tsx:205-214`).

Fix (small): add `parentJobId`, `relation: "remix"` and `templateId` to `CreatePrefill` in `prefillFor` (job.templateId is already loaded), and send them in `startDraft`.

### D4 — `IntersectionObserver` re-created on every render (low)
`src/components/explore-feed.tsx:203-209`: `useEffect` has no dependency array, so each render disconnects and re-observes the sentinel. Works, but wasteful; add `[loadMore]` or a ref to the latest `loadMore`.

### D5 — Server upload `warnings` never shown (low)
`src/server/media.ts:72` returns `warnings: ["low_resolution"]`; `create-panel.tsx:40, 177` types it and discards it. The copilot's own check (`copilot.ts:102-111`) covers the demo models, so there is no user impact today; for a model with `minInputShortSidePx: 0` (flux, `registry.ts:119`) the server's warning would be the only one and is lost.

### D6 — Dismissed drafts are never cleaned up (low)
A draft dismissed with "Not now" stays `awaiting_confirmation` forever; no sweeper touches that status (`processor.ts:391-406` only handles `queued`/`processing`). Hidden from the Library (`views.ts:44`) so not user-visible; table growth only. **[inferred]** from the absence of any code path that expires them.

### D7 — `cost_changed` (409) cannot trigger from the UI (low, observation)
`service.ts:286-288` compares `job.costCredits` (frozen at draft time) with the client's `expectedCost`, which the client echoes from the same draft. An admin `priceMultiplier` change between draft and confirm is not re-priced. The user always pays the number shown, so this is not a misrepresentation; it just means the check only guards a tampered client.

No defect was found where a demo output is presented as real: `isDemo` is persisted on job and output, surfaced on every creation view, in every toast, in the watermark and in the download name (see Part V "demo labelled").

---

## Gaps ranked by user impact

Effort: small = under ~2 h in one or two files; medium = half a day, new UI plus a query; large = multi-day.

| Rank | Gap | Spec ref | Status | Effort | Proposal |
|---|---|---|---|---|---|
| 1 | Remix/Reuse lose lineage and template attribution (D3) | §2 actions; §6 remix attribution | partial | small | As in D3. |
| 2 | Library Retry charges without confirmation (D2) | Part V, Part IX | partial | small | As in D2. |
| 3 | Stale draft after Undo/Restore/model switch (D1) | §3 Undo/Restore; Part V confirm | partial | small | As in D1. |
| 4 | No Quick Generate from the card | §1 card actions; §2 "generate immediately" | partial | medium | Extend `TemplateCard` data with the current version's `modelKey`/`prompt`/`defaults` (`toCards` in `discovery/templates.ts:78-117`, join `template_versions`), and give the card's "Make" a client handler that POSTs `/api/generations` with those defaults and opens the same confirm `Sheet` in place; fall back to the detail link when signed out or VIP-locked. Keep the detail page as the personalization path. |
| 5 | Copilot does not recommend templates | §3 | missing | medium | On `/generate` and Studio, add a debounced rail "Templates like this prompt" that calls `GET /api/templates?q=<2-3 content words from the prompt>&limit=6` (the API already supports `q` and returns `TemplateCard`s); render with `TemplateRail`. Server-side variant: a `templatesForPrompt(prompt)` that scores tag overlap, reusing the `overlap` expression from `similarTemplates`. |
| 6 | No return-to-discovery rail on a creation | Part V last step | partial | small | In `src/app/collection/[id]/page.tsx`, when `job.templateId` is set call `similarTemplates(job.templateId, user.id, 8)` (else `forYou(user.id, 8)`) and render `TemplateRail` under `CreationDetail` with the heading "Make another". |
| 7 | Presets unreachable while composing; no "Save preset" before generating | §2 presets / Save Preset | partial | small | Add `presets: await listPresets(user.id)` to `createContext` (`src/server/create-context.ts`), render a "Start from preset" `<select>` at the top of the Tweak section that calls `applyPatch({ prompt, params })` and `switchModel`, and a "Save as preset" button that POSTs the non-job branch of `presetSchema` (`presets.ts:428-434`) with the current `mode/modelKey/prompt/params`. |
| 8 | Atmosphere (and negative prompt where supported) hidden outside Studio | §2 personalization list | partial | small | Move the `Atmosphere` field out of the `studio ?` branch in `create-panel.tsx:594-598`; keep seed/project placement Studio-only. The server already accepts it (`service.ts:52`) and the policy check already reads it (`service.ts:169`). |
| 9 | Related Visual Styles / Similar Creations layers | §1 optional layers | missing | medium | Per template, show "More in #tag" rails for the top two tags via `browseTemplates({ q: tag, limit: 8 })`; in the Library, a "Same template" filter already exists via `templateId` (`views.ts:48`) and could be exposed from the creation page as "Others you made from this template". |
| 10 | Saved Inspirations not on the home feed | §1 optional layers | partial | small | On `page.tsx`, when the user has template favorites, add a rail from `cardsByIds(favoriteIds)` (the query already exists in `favorites/page.tsx:104-110`). |
| 11 | Copilot "explains controls" / "coherent settings" are thin | §3 | partial | small | Add `hint` strings to the camera/pacing/lighting/framing `Field`s in `create-panel.tsx:551-592`; add a `analyze` rule that, when the prompt names a lighting or framing word and the matching param is unset, offers the matching patch (reuse the regex tables in `interpret`, `copilot.ts:246-275`). |
| 12 | VIP filter not exposed | §1 VIP indicators | partial | small | Add `vipOnly: z.enum(["1"]).optional()` to the query schema in `src/app/api/templates/route.ts:9-17` (mapped to the existing `BrowseQuery.vipOnly`, `discovery/templates.ts:136, 157`) and a "VIP" chip in `explore-feed.tsx:252-268`. |
| 13 | Prompt assistance is not behind a provider adapter | §3 + Part VI "prompt assistance" adapter | partial | medium | Keep `src/lib/copilot.ts` as the default adapter and introduce a `PromptAssistProvider` interface (`suggest(input) → Suggestion[]`, `interpret(text, model) → Interpretation`) in `src/server/ai/providers`, selected by env; an LLM-backed implementation can be added later without touching the panel. Not in scope for the demo-only build, but it is the one extensibility seam Part VI asks for that is absent. |
| 14 | Arrow-key navigation in the gallery | §1 keyboard nav | partial | small–medium | Optional roving tabindex on `TemplateGrid`; tab order already works. |

---

## Observations that are not gaps

- The natural-language "Interpret" feature is deterministic rules (`copilot.ts:197-282`), which is the honest fallback with no AI credentials; the UI never labels it as AI.
- Every discovery query is `force-dynamic` and signs media URLs per card (`assetUrl`, `media.ts:13-18`); costs are an HMAC per asset, not a storage round-trip. **[inferred]** acceptable at seed scale; a cache for public-asset URLs would help at scale.
- `forYou` falls back to trending with `personalized: false` when the user has no signals or opted out (`discovery/templates.ts:214, 231-233`); the home page labels the rail "Popular to start" in that case (`page.tsx:60`), so the user is not told the rail is personal when it is not.
- The confirm sheet's copy "If it fails, your credits come back automatically" is true per `finishFailed` and the shared `job:<id>:close` idempotency key for settle/release (`ledger.ts:86-107`), which makes double charge or charge-plus-refund impossible for one job.
- Tests covering this scope: `tests/unit/copilot.test.ts` (8 cases), `tests/integration/generation.test.ts` (16 cases on draft/confirm/process/cancel/retry/variation/policy/limits/ownership), `tests/integration/platform.test.ts:242-253, 357-366` (For You fallback, presets), `tests/e2e/journey.spec.ts` (full journey on the production build, cross-user 404/403, under-18, blocked prompt, layouts, keyboard). Per `notes/plan.md` these last passed at `0987b7c` (79/79 vitest, 8/8 e2e); not re-run here.
