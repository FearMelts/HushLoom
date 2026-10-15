# Spec audit: Part III Systems Four to Seven

Repository: `/home/claude/hushloom`, branch `claude/playbox-2-foundation-q7fpbs`, HEAD `a4752a9` (code identical to `0987b7c` for everything cited here).
Spec: `scratchpad/ctx/spec.md`, Part III items 4 (Scene Continuity Engine), 5 (Living Collection), 6 (Creator Ecosystem), 7 (Optional Advanced Studio).

Method: read-only pass over `src/server/db/schema.ts`, the server modules, API routes, pages and components for these four systems, plus `tests/`. No code was run; the "last verified" numbers in `notes/plan.md` (vitest 79/79, e2e 8/8 at `0987b7c`) are quoted, not re-measured.

Conventions in this document:
- **Verified** = I read the lines cited. **Inferred** = a conclusion drawn from what I read without executing it; each inference is marked.
- Status values: `met`, `partial`, `missing`, `demo-only`. "demo-only" means the code path exists and is honestly labeled as a demonstration; per the task brief that is expected and is not counted as a gap unless the label is wrong.
- Line numbers are from `cat -n` on the working tree.

Summary counts (requirements as itemised below): System 4: 8 met, 5 partial, 0 missing. System 5: 19 met, 7 partial, 3 missing. System 6: 15 met, 6 partial, 1 missing. System 7: 15 met, 2 partial, 0 missing.

---

## System Four: Scene Continuity Engine

Spec text: "extend videos, continue scene, alternate angles, reuse character references, preserve attributes, lighting/framing guidance, branches, compare variations, shot sequences. Scene workspace: lightweight timeline (clips, sequence, history, settings, references, branches, continuation actions). Distinguish desired vs guaranteed consistency; provider-specific feature validation; identity workflows only for authorized adult subjects."

| # | Requirement | Status | Evidence (verified) |
|---|---|---|---|
| 4.1 | Extend videos | met (infrastructure) / demo-only (output) | `POST /api/generations/[id]/derive` with `relation: "extension"` → `deriveDraft` `src/server/generation/service.ts:357-403`: only a completed **video** output may be extended (422 `unsupported` at :380), mode becomes `video_extension` (:381), the source clip becomes the input asset (:382). Button: `src/components/creation-detail.tsx:246-248`. Worker loads the clip as a provider input `src/server/generation/processor.ts:106-112`. `demo-motion` declares `video_extension` in `src/server/ai/registry.ts:99`; the demo adapter ignores video inputs (`src/server/ai/providers/demo.ts:69` only reads image inputs) and renders a fresh labeled clip. Confirm sheet says "the result is a labeled placeholder, not AI output" `creation-detail.tsx:332`. |
| 4.2 | Continue scene | met / demo-only (output) | Same path with `relation: "continuation"` → mode `scene_continuation` (`service.ts:381`). Buttons: `creation-detail.tsx:243-245`, project workspace `src/components/projects.tsx:322-326`. The derived draft keeps `projectId`/`sceneId` of the source (`service.ts:396-397`), so the new take lands in the same scene; the toast says so (`projects.tsx:184`). |
| 4.3 | Alternate angles | partial | No "alternate angle" action. What exists: a `framing` setting with `over the shoulder`, `low angle`, `high angle` (`registry.ts:76`) editable in the continuity guide (`projects.tsx:449-456`) and in Tweak (`create-panel.tsx:585-592`); "Branch" (variation) only re-rolls the seed (`service.ts:370`) and labels the branch `alternate` (`service.ts:312`). Spec intent (a one-tap different angle on the same take) is not implemented. |
| 4.4 | Reuse character references | **partial, with a misrepresentation (see Defect D1)** | Data model and consent are complete: `character_references` `schema.ts:345-357` (FK to `consent_records`), `Train` page `src/components/train.tsx`, `createCharacter` `src/server/characters.ts:37-53` (415 for non-image at :38, 20-character limit 422 at :45), both consent boxes enforced server-side `src/app/api/characters/route.ts:19-21` (422 `consent_required`). The guide can pin a character (`projects.tsx:460-469`, validated as the owner's at `src/server/projects.ts:59-66`). Draft creation validates ownership and live consent (`service.ts:186-198`, 403 `consent_withdrawn`). **But the worker never sends the reference to the provider**: `processor.ts:106-112` builds `inputs` only from `job.inputAssetIds`; `MODE_INPUTS.reference_guided` is `{image: 0, video: 0, characterRef: true}` (`registry.ts:42`) so `inputs` is `[]`; `ProviderRequest` (`src/server/ai/providers/types.ts:6-14`) has no field for a reference at all. `grep characterReference src/server/generation/processor.ts src/server/ai/` returns nothing. |
| 4.5 | Preserve attributes | partial | Continuity guide (`lighting`, `framing`, `palette`, `characterReferenceId`, `notes`; `ContinuityGuide` `schema.ts:324-330`, zod `src/server/projects.ts:9-17`) is copied into new scenes (`projects.ts:170-183`, tested `tests/integration/platform.test.ts:332-334`) and folded into the prompt + params when a take starts from a scene (`src/app/generate/[kind]/page.tsx:40-60`). Nothing is enforced on the provider side beyond prompt text and `lighting`/`framing` params. For **video** scenes the pinned character is dropped silently (see Defect D2). |
| 4.6 | Lighting/framing guidance | met | Guide selects: `projects.tsx:441-456` using `LIGHTINGS`/`FRAMINGS` from `registry.ts:75-76`; prefill `generate/[kind]/page.tsx:48-52`; copilot "continuity" note `src/lib/copilot.ts:167-174`. |
| 4.7 | Branches | met | `scene_versions` with `parent_version_id` and `branch_label` `schema.ts:436-448`; written on confirm `service.ts:302-315`; shown with parent timestamp `projects.tsx:299-309`. Labels are only `main` / `alternate` (no user-named branches). `parent_version_id` has no FK (`drizzle/0000_init.sql:243`). |
| 4.8 | Compare variations | met | Project workspace side-by-side of two takes `projects.tsx:276-295` (toggle :327-336). Creation detail compare against lineage `creation-detail.tsx:168-183`, `292-322`. |
| 4.9 | Shot sequences | met | Ordered scenes (`position`, `scenes_project_idx` `schema.ts:342`), reorder via `PUT /api/projects/[id]/scenes` (`reorderScenes` `projects.ts:208-219`, 422 `invalid_order`, `for update` lock), move buttons `projects.tsx:158-164, 240-245`, "Play sequence" `SequencePlayer` `projects.tsx:528-552` plays each scene's selected take in order. Tested `platform.test.ts:336-339`. |
| 4.10 | Scene workspace timeline: clips, sequence, history, settings, references, branches, continuation actions | met | `/projects/[id]` → `ProjectWorkspace` `projects.tsx:126-393`: horizontal timeline :219-259, per-scene takes :296-342 (status shown for unfinished takes :338), continuity guide :395-487, "Use as take" :312-316 (`selectVersion` 409 `not_ready` unless completed `projects.ts:231`), Branch/Continue/Compare, "Also in this project" loose creations :350-363. Polls every 4 s while a take is running (:137-143). |
| 4.11 | Distinguish desired vs guaranteed consistency | partial | Registry declares `continuity: "none" \| "best_effort"` (`registry.ts:63-67`); all three models are `"none"`. Copilot shows "Continuity is a goal, not a guarantee" only when the mode is `scene_continuation`/`video_extension` (`copilot.ts:167-174`). The guide's own hint overstates: "Add a consented character in Train to keep a face consistent" (`projects.tsx:460`) — see D2. |
| 4.12 | Provider-specific feature validation | met | `validateAgainstModel` `registry.ts:136-178` (mode, aspect, duration, quality, negative prompt, seed, camera, motion); applied on draft `service.ts:166-167` (422 `unsupported_settings`); the panel drops unsupported params on model switch `create-panel.tsx:150-167`. Unit test `tests/unit/registry.test.ts:20-26`. |
| 4.13 | Identity workflows only for authorized adult subjects | met | `LIKENESS_STATEMENT` `characters.ts:8-9`; consent kind `likeness` (`src/server/media.ts:80`); both boxes required (`api/characters/route.ts:19-21`); removal withdraws consent and deletes every creation made with it (`characters.ts:56-63` → `withdrawConsent` `src/server/auth/account.ts:111-150`, immediate purge :149). Tested `platform.test.ts:154-174`. |

---

## System Five: Living Collection

Spec text: "creations, saved templates, favorites, history, folders, projects, prompt history, version comparison, metadata, presets, timelines, downloads, deletion. Filters: images, videos, favorites, projects, date, status, template, creator, quality, model. Version branching. Open a creation → Remix, Retry, Create Variation, Continue, Save, Download, Delete. Media-dominant."

| # | Requirement | Status | Evidence (verified) |
|---|---|---|---|
| 5.1 | Creations | met | `/collection` → `LibraryView` `src/components/library.tsx:118-316`; data `listCreations` `src/server/generation/views.ts:40-62` (drafts/awaiting excluded :44). Grid 2→6 columns :267. |
| 5.2 | Saved templates | met | `/favorites` templates tab `src/app/favorites/page.tsx:26-38`; favorite only for published templates (`src/server/social.ts:9-10`, 404 otherwise). |
| 5.3 | Favorites (creations) | met | Heart on detail `creation-detail.tsx:254-256`; `POST/DELETE /api/favorites` `targetType: "creation"` ownership-checked `social.ts:11-14`; Library chip :226-228 and `/favorites?tab=creations`. |
| 5.4 | History | partial | Chronological library with newest/oldest sort (`views.ts:58`); Studio "Job monitor" shows the last 15 (`src/app/studio/page.tsx:23`, `src/components/studio.tsx:56-114`). No dedicated date-grouped history view; no date filter. |
| 5.5 | Folders | partial | `folders`/`folder_items` `schema.ts:450-469`; create + add from Library multi-select (`library.tsx:165-179, 286-313`) and from detail (`creation-detail.tsx:364-403`); filter by folder `views.ts:51`. `DELETE /api/folders/[id]` exists (`src/app/api/folders/[id]/route.ts`) **but no component calls it** (`grep "api/folders/" src/components | grep -i delete` → none). There is no "remove from folder" or rename at all (`src/server/folders.ts` has `listFolders`, `createFolder`, `deleteFolder`, `addToFolder` only). |
| 5.6 | Projects | met | System 4 above; Library header links to Projects `library.tsx:208-210`; detail shows "in {project}" `creation-detail.tsx:215-222`. |
| 5.7 | Prompt history | partial | Each creation stores its prompt (`generation_jobs.prompt`) and shows it (`creation-detail.tsx:202`); lineage lists retries/variations. No prompt-only history or reuse list. |
| 5.8 | Version comparison | met | `lineage()` `views.ts:130-149` + compare UI `creation-detail.tsx:292-322`. Limitation: lineage is one level deep (`root = job.parentJobId ?? job.id` :133; where clause :142) — a variation of a variation does not see its grandparent or its parent's siblings. |
| 5.9 | Metadata | met | Settings `<dl>` `creation-detail.tsx:146-159, 281-290` (mode, model, aspect, length, quality, camera, motion, pacing, lighting, framing, seed, cost); template and project links :204-223; demo/relation badges :196-201. |
| 5.10 | Presets | met | `saved_presets` `schema.ts:471-484`; `POST /api/presets` from a job (`createPreset` `src/server/presets.ts:33-51`, seed dropped :38, limit 100 → 422 `limit_reached` :45, cross-user 404 tested `platform.test.ts:356-365`); save sheet `creation-detail.tsx:405-438`; list/load/delete in Studio `studio.tsx:13-53`. |
| 5.11 | Timelines | met | Project workspace (System 4). |
| 5.12 | Downloads | met | `GET /api/generations/[id]/download` `src/app/api/generations/[id]/download/route.ts:10-24` → owner check → 302 to a signed URL with `Content-Disposition` (served by `src/app/api/media/route.ts:30`); filename carries `-demo` for demo outputs (:21). Button only when completed `creation-detail.tsx:257-261`. |
| 5.13 | Deletion | met | `DELETE /api/generations/[id]` → `deleteJob` `service.ts:415-432` (409 `job_active` for queued/processing :417-419; outputs, posters and assets soft-deleted; audited). Bulk delete `library.tsx:147-163`. Worker purges soft-deleted files after 30 days `src/worker/index.ts:32-39,43` (matches the UI copy at `library.tsx:275`, `creation-detail.tsx:346`). |
| 5.14 | Filter: images / videos | met | Chips `library.tsx:220-225`; SQL `views.ts:46`. |
| 5.15 | Filter: favorites | met | `library.tsx:226-228`; `views.ts:50`. |
| 5.16 | Filter: projects | partial | API supports `projectId` (`src/app/api/generations/route.ts:15`, `views.ts:47`); Library UI has no project filter (`src/app/collection/page.tsx:16-24` does not read one). |
| 5.17 | Filter: date | missing | Only newest/oldest sort (`library.tsx:254-257`). No date range. |
| 5.18 | Filter: status | met | `library.tsx:230-237`; whitelist `collection/page.tsx:19`. |
| 5.19 | Filter: template | partial | API `templateId` (`generations/route.ts:16`, `views.ts:48`); no Library UI. |
| 5.20 | Filter: creator | missing | Not in `CreationFilters` (`views.ts:26-38`) or UI. |
| 5.21 | Filter: quality | missing | Not in `CreationFilters`; would need `params->>'quality'`. |
| 5.22 | Filter: model | met | `library.tsx:238-245`; `views.ts:49`. |
| 5.23 | Version branching | met | `parent_job_id` + `relation` `schema.ts:389-390`; set by `deriveDraft` `service.ts:398-399`; tested `tests/integration/generation.test.ts:231-241`. `parent_job_id` has no FK (`drizzle/0000_init.sql:125`). |
| 5.24 | Open → Remix | partial | "Remix" is a link to `/generate/{kind}?from={id}` (`creation-detail.tsx:232-234`) which prefills prompt/params/project/scene (`generate/[kind]/page.tsx:22-39`). The CreatePanel never sends `parentJobId`/`relation` (`create-panel.tsx:200-214`; `grep parentJobId src/components/create-panel.tsx` → none), so a remix is a new root job and `relation: "remix"` is never written anywhere (only declared in `service.ts:72`). Remixed creations therefore do not appear in version comparison. |
| 5.25 | Open → Retry | met | `creation-detail.tsx:235-237` and from the grid for failed items `library.tsx:23-36, 108-112`; `relation: "retry"` keeps the seed. |
| 5.26 | Open → Create Variation | met | `creation-detail.tsx:238-240` (disabled until completed); new seed `service.ts:370`. |
| 5.27 | Open → Continue | met | `creation-detail.tsx:241-250` (video only). |
| 5.28 | Open → Save | met | Favorite :254-256; also Folder :262-266, Preset :267-269, Publish :270-274. |
| 5.29 | Open → Download / Delete | met | :257-261 / :275-277 with confirm sheet :345-355. |
| 5.30 | Cost shown and confirmed before derived charges | met | Derive returns `awaiting_confirmation` draft; sheet shows cost + balance, blocks confirm when short `creation-detail.tsx:326-343`; confirm sends `expectedCost` (409 `cost_changed` on mismatch `service.ts:286-288`). Project workspace uses `window.confirm` instead of the sheet (`projects.tsx:178`) and cancels the draft on "no" (:179-181). |
| 5.31 | Media-dominant | met | Thumb is the whole card; text is one truncated line `library.tsx:38-115`. Video thumbs use posters (`preload="none"` when a poster exists :60). |
| 5.32 | Private media | met | Every URL goes through `assetUrl` `src/server/media.ts:13-18` (owner or public only, TTL `MEDIA_URL_TTL_S`); `/api/media` verifies HMAC and `deletedAt` (`api/media/route.ts:17-21`, 403/404). e2e forged-link 403 `tests/e2e/journey.spec.ts:98-100`. |

---

## System Six: Creator Ecosystem

Spec text: "profiles (display name, avatar, bio, published templates, collections, followers, favorites, approved analytics). Publishing, editing metadata, unpublishing, versioning, remix attribution, following, public collections, search/filter, moderation and reporting. Privacy: private generations never auto-public; publishing explicit; uploads, prompts, histories private by default; analytics never expose others' private content."

| # | Requirement | Status | Evidence (verified) |
|---|---|---|---|
| 6.1 | Profile: display name, handle, bio | met | `user_profiles` `schema.ts:88-99`; `/creators/[handle]` `src/app/creators/[id]/page.tsx:17-75`; edit via `PATCH /api/me` (`src/app/api/me/route.ts:13-17`, `profileSchema` `src/server/me.ts:8-17`, handle uniqueness 409 `handle_taken` :63-67). Suspended/deleted users 404 (`src/server/social.ts:32-39` requires `status = 'active'`). |
| 6.2 | Profile: avatar | partial | `Avatar` renders initials (`creators/[id]/page.tsx:28`). `user_profiles.avatar_asset_id` (`schema.ts:95`, no FK `0000_init.sql:365`) and `upload_purpose = 'avatar'` (`schema.ts:66`) exist but nothing reads or writes them (`grep avatarAssetId src scripts` → schema only). |
| 6.3 | Profile: published templates | met | `browseTemplates({creatorId})` restricted to published (`src/server/creators.ts:17`, `published` predicate `src/server/discovery/templates.ts:128`). |
| 6.4 | Profile: collections / public collections | demo-only (seed) | Tables `template_collections`/`template_collection_items` `schema.ts:274-294`; read on the profile with private ones visible only to the owner (`creators.ts:18-38`, page :59-64). **No API or UI creates or edits a collection**; the only writer is `scripts/seed.ts:277-278`. |
| 6.5 | Profile: followers | met (count) | Follower/following counts `creators.ts:14-15`, header `creators/[id]/page.tsx:36-47`. No follower list. |
| 6.6 | Profile: favorites | partial | Not shown on the profile. The viewer's own favorites live at `/favorites`. |
| 6.7 | Profile: approved analytics | partial | Owner-only table with lifetime and 30-day counts from real `discovery_events` (`creatorAnalytics` `creators.ts:53-85`, `CreatorManage` `src/components/creator-manage.tsx:29-119`). Public header shows aggregate "Uses" (:40). `creator_profiles.share_analytics` (`schema.ts:117`) is written by the seed only and never read, so there is no opt-in to share analytics publicly. |
| 6.8 | Publishing | met | `POST /api/templates` → `publishTemplate` `src/server/templates/publish.ts:41-131`: owner + completed only (404 / 409 `not_ready` :47-48); **403 `personal_media`** for creations made from uploads or character refs (:49-55); policy check on title/description/tags/prompt with an auto-block moderation event (422 `policy_blocked` :56-60); output and poster copied to **new public assets** (:69-76, :84-95), original stays private; `template_versions` v1 with seed stripped (:117-125); role promoted to `creator` (:126). UI sheet with explicit public-acknowledgement checkbox `creation-detail.tsx:440-508` (blocked copy :451-454; checkbox gates the button :494-501). Tests `platform.test.ts:178-203`. |
| 6.9 | Editing metadata | met (UI subset) | `PATCH /api/templates/[id]` → `updateTemplate` `publish.ts:145-194` (owner or admin, 404 otherwise :148; removed → 403 :149; policy check :150-151; title/description/tags/category/isVip/status). `EditSheet` exposes title, description, VIP only (`creator-manage.tsx:121-151`); tags/category edits have no UI. |
| 6.10 | Unpublishing | met | `status: "unpublished"` toggle `creator-manage.tsx:98-109`; unpublished templates 404 for everyone but the owner (`src/server/templates/queries.ts:17-18`); favorites/ratings refuse non-published (`social.ts:9`, `api/templates/[id]/rate/route.ts:11`). |
| 6.11 | Versioning | partial, with misleading copy | Server: a prompt change through PATCH creates `template_versions` v+1 and bumps `current_version` (`publish.ts:158-175, 186`); jobs record `template_version` (`service.ts:200-211, 251`); history list on the template page `src/app/templates/[id]/page.tsx:137-148`. **No UI sends `prompt`** — `EditSheet` only sends `{title, description, isVip}` (`creator-manage.tsx:131`) and tells the creator "To change the prompt, publish a new version from a creation" (:144), but publishing from a creation always creates a **new template** (`publish.ts:96-116`), never a version of an existing one. |
| 6.12 | Remix attribution | met | `templates.remixed_from_id` set from the source job's `templateId` at publish (`publish.ts:113`); "Remix of {title}" link `templates/[id]/page.tsx:89-96` via `queries.ts:34-36`. No FK on the column (`0000_init.sql:330`). |
| 6.13 | Following | met | `follows` with `no_self_follow` check `schema.ts:264-272`; `POST/DELETE /api/follows` → `setFollow` `social.ts:24-30` (422 `self_follow`, 404 for non-active users); `FollowButton` `src/components/template-detail.tsx:49-74` on template and profile; "Following" rail on home `src/app/page.tsx:22, 94` via `followingFeed` `discovery/templates.ts:199-205`. |
| 6.14 | Search/filter of templates and creators | met | `GET /api/templates` `src/app/api/templates/route.ts:9-23` → `browseTemplates` (`q` matches title, description, creator handle, tags `discovery/templates.ts:143-153`; category, media, sort, `creatorId`). |
| 6.15 | Reporting | met | `POST /api/templates/[id]/report` `src/app/api/templates/[id]/report/route.ts:9-28` (reasons enum, 1000-char note, 20/h rate limit 429, only templates the viewer can see). `ReportButton` `template-detail.tsx:115-173`, shown to signed-in non-owners `templates/[id]/page.tsx:135`. |
| 6.16 | Moderation | met | Queue sorted severe-first `src/server/admin.ts:76-104`; `POST /api/admin/reports/[id]` → `resolveReport` :109-143 (remove sets `templates.status = 'removed'` and closes every open report on the subject; 409 `already_resolved`; audited); `suspendUser` :203-208 destroys sessions; UI `src/components/admin.tsx:43-90`. Auto-blocks from policy also land in `moderation_events` (`service.ts:171-180`, `publish.ts:58`). Test `platform.test.ts:205-218`. Gap: suspending a creator does not unpublish their templates (`admin.ts:203-208` touches only `users`; explore still lists them, their profile 404s). |
| 6.17 | Private generations never auto-public | met | `media_assets.visibility` defaults `private` (`schema.ts:160`); outputs inserted private (`processor.ts:170`); the only path to `public` is the copy in `publishTemplate`. Test `platform.test.ts:178-189`. |
| 6.18 | Publishing explicit | met | Checkbox + button; nothing publishes implicitly. |
| 6.19 | Uploads, prompts, histories private by default | met | Uploads private (`media.ts:84`), never publishable (6.8). Prompts are private until the owner publishes a template, at which point the prompt is the template recipe shown in the panel (`templates/[id]/page.tsx:124`) — explicit and expected. Discovery history is per-user, clearable (`DELETE /api/me/history`, `me.ts:83-87`) and not used in analytics beyond counts. |
| 6.20 | Analytics never expose others' private content | met | `creatorAnalytics` only counts rows (`creators.ts:59-60`); no viewer identity or private media is returned. |
| 6.21 | Creator role / creator profile record | met | `creator_profiles` created on first publish (`publish.ts:127`); `headline` shown on the profile (`creators/[id]/page.tsx:32`) but there is no UI to edit `headline` (`profileSchema` `me.ts:8-17` has `displayName`, `handle`, `bio` only). |
| 6.22 | Template deletion by creator | missing (not explicitly required) | Only unpublish; no `DELETE /api/templates/[id]` (`src/app/api/templates/[id]/route.ts` exports `PATCH` only). Noted for completeness, not counted as a gap. |

---

## System Seven: Optional Advanced Studio

Spec text: "prompt editor, negative prompt where supported, model selection, aspect ratio, duration, quality, motion intensity, camera direction, seed where supported, reference image management, presets, scene sequencing, version comparison, history, credit estimates, job status. Optional; same components and visual language; 'a deeper room inside the playground'."

| # | Requirement | Status | Evidence (verified) |
|---|---|---|---|
| 7.1 | Prompt editor | met | `/studio` → `CreatePanel` with `studio` (`src/app/studio/page.tsx:52-63`); 5-row textarea in studio mode `src/components/create-panel.tsx:360-371`; Undo / Restore original :348-358. |
| 7.2 | Negative prompt where supported | met | Rendered only when `model.supports.negativePrompt` :599-603; stripped from the request otherwise :206; server rejects it for models that ignore it (`registry.ts:162-164`). |
| 7.3 | Model selection | met | Select with availability reason :505-515 and model notes :515; demo models named "Demo Still (not AI)" / "Demo Motion (not AI)" (`registry.ts:82, 96`). |
| 7.4 | Aspect ratio | met | :517-526 from `model.aspectRatios`. |
| 7.5 | Duration | met | :527-538 from `model.durationsS` (video models). |
| 7.6 | Quality | met | :539-550, "4K (2× credits)" label; cost recomputed live (:104, `estimateCost` `registry.ts:181-192`). |
| 7.7 | Motion intensity | met | :561-565 gated by `supports.motionIntensity`. |
| 7.8 | Camera direction | met | :551-560 gated by `supports.cameraMovement`; demo-motion actually maps it to ffmpeg zoompan (`demo.ts:93-104`). |
| 7.9 | Seed where supported | met | :604-608 gated by `supports.seed`; server assigns a random seed when omitted (`service.ts:237`); "Reuse settings" keeps the seed (`generate/[kind]/page.tsx:34`). |
| 7.10 | Reference image management | partial | Upload with consent sheet :268-322, :678-697; character select for `reference_guided` :324-340; management itself lives in `/train`. Reference is not delivered to the provider (D1). |
| 7.11 | Presets | met | List/load/delete `studio.tsx:13-53`; `?preset=` prefill `studio/page.tsx:24-28, 51`. |
| 7.12 | Scene sequencing | met (via placement) | Project + scene selectors in studio mode :609-628 (`createContext` `src/server/create-context.ts:23-36`); sequencing proper is the Projects workspace, linked from the panel copy. |
| 7.13 | Version comparison | partial | Not inside Studio; lives on `/collection/[id]` (5.8). |
| 7.14 | History | met | "Job monitor" with real server timestamps and elapsed time, 3 s refresh while running `studio.tsx:56-114`. |
| 7.15 | Credit estimates | met | Cost line :656-670 (`data-testid="cost-line"`), "Cost changes from X to Y" when the interpreter would change price :452-460, confirm sheet with balance-after :699-733. |
| 7.16 | Job status | met | Job monitor + cancel per row :91-108 (`POST /api/generations/[id]/cancel`). |
| 7.17 | Optional, never mandatory | met | `/generate/*` works without Studio; Tweak panel collapsed by default (:92 `useState(studio)`), "More controls in Studio →" :631-633. Nav: Studio in the secondary rail group (`src/components/shell.tsx:33-35`). |
| 7.18 | Same components and visual language | met | One `CreatePanel` for template page, `/generate/*` and `/studio`. |

---

## Defects (ranked by user impact)

**D1 — Train page states the reference photo is sent to the model; it is not.** `src/components/train.tsx:66-67`: "The photo is sent to a model that accepts a reference image at generation time". `src/server/generation/processor.ts:106-112` loads only `job.inputAssetIds`; `reference_guided` requires no input assets (`registry.ts:42`); `ProviderRequest` (`providers/types.ts:6-14`) has no reference field; `grep characterReference` over `processor.ts` and `src/server/ai/` is empty. The output is correctly labeled "Demo", so no one is told the face was matched — but the sentence describing the mechanism is false for every adapter, including a future real one, until the pipeline is extended. Severity: high (misrepresents how consented likeness data is used; this is the one place in the four systems where copy and code disagree on a privacy-relevant fact). Fix: either (a) change the copy to "In this build the reference is recorded against the creation but not yet sent to any model", or (b) add `references: ProviderInput[]` to `ProviderRequest`, load `job.characterReferenceId → character_references.asset_id` in `processJob`, and have `demo-still` composite the reference the way it already composites `image_to_image` inputs (`demo.ts:69-76`). (b) is ~60 lines.

**D2 — Pinned character is silently dropped for video takes and the guide copy implies otherwise.** `src/app/generate/[kind]/page.tsx:55-57` sets `mode: "reference_guided"` only when `kind === "image"`; for video the `characterReferenceId` is passed in the prefill but `CreatePanel` sends it only when `needs.characterRef` (`create-panel.tsx:210`), so it is discarded. The guide hint says "Add a consented character in Train to keep a face consistent" (`projects.tsx:460`) and the video flow shows no notice. Severity: medium. Fix: in `CreatePanel`, when `prefill.characterReferenceId` is set and the chosen mode cannot use it, render one line: "This model can't use a character reference for clips; continuity relies on the guide text." (~10 lines).

**D3 — "Reuse settings" / "Remix" on a reference-guided creation can swap to a different character.** `generate/[kind]/page.tsx:29-38` does not copy `characterReferenceId` from the source job; `create-panel.tsx:89` then defaults to `characterRefs[0]`. The mode stays `reference_guided`, so the draft is created with whichever character is first in the list. Still the owner's own consented character (no consent breach), but it is not a reuse of the source settings. Severity: medium. Fix: add `characterReferenceId: job.characterReferenceId ?? undefined` to the `from=` prefill (1 line) and, in the panel, show which character is selected above the Make button when the mode is reference-guided.

**D4 — Creator-side "versioning" instruction is wrong.** `creator-manage.tsx:144`: "To change the prompt, publish a new version from a creation." No such path exists; `POST /api/templates` always inserts a new template (`publish.ts:96-116`). The real versioning path (`PATCH` with `prompt`, `publish.ts:158-175`) has no UI. Severity: medium (dead instruction; creator ends up with duplicate templates). Fix: add a "Prompt" textarea and "Changelog" input to `EditSheet` sending `{prompt, changelog}` (~25 lines) and reword the hint.

**D5 — Creation detail links to a soft-deleted project.** `src/app/collection/[id]/page.tsx:30` selects the project by id without `isNull(projects.deletedAt)`; after "Delete project" the detail page still renders "in {title}" linking to a 404. Severity: low. Fix: add the `deletedAt` predicate (1 line).

**D6 — Suspending a creator leaves their templates published.** `admin.ts:203-208` updates only `users`; `browseTemplates` filters on template status only (`discovery/templates.ts:128`); the creator link on every card then 404s (`social.ts:37`). Severity: low-medium (moderation outcome incomplete). Fix: in `suspendUser`, also `update templates set status = 'unpublished' where creator_id = $1 and status = 'published'` inside one transaction, and reverse on reinstatement if that is added (~8 lines).

**D7 — Lineage columns lack foreign keys.** `parent_job_id` (`0000_init.sql:125`), `parent_version_id` (:243), `remixed_from_id` (:330), `avatar_asset_id` (:365), `payment_event_id` (:68) are plain `uuid`. Spec Part VI asks for FKs. Nothing dangles today because rows are soft-deleted, but a hard delete would leave orphans. Severity: low. Fix: one migration adding `references ... on delete set null` (self-references are fine in Postgres).

**D8 — Remix loses lineage.** See 5.24: the CreatePanel never sends `parentJobId`/`relation`, so `relation: "remix"` is never recorded and remixed creations are invisible to version comparison. Severity: low. Fix: carry `parentJobId` in the `from=` prefill and send `{parentJobId, relation: "remix"}` from the panel when present (~8 lines; the server already validates ownership at `service.ts:228-234`).

No defect was found where a demo output is presented as a real AI result: every output path carries `isDemo` (`generation_jobs.is_demo`, `generation_outputs.is_demo`), the grid badge (`library.tsx:89`), the detail notice (`creation-detail.tsx:187-191`), the confirm sheets (`create-panel.tsx:716-721`, `creation-detail.tsx:332`, `projects.tsx:178`), the download filename (`download/route.ts:21`) and the watermark burned into the pixels (`demo.ts:16, 60`).

---

## Gaps ranked by user impact (with effort and proposals)

1. **Character reference never reaches a provider** (4.4, 7.10; D1). Effort: medium. Proposal: extend `ProviderRequest` with `references: ProviderInput[]`; in `processJob` load the reference asset when `job.characterReferenceId` is set (join `character_references` → `media_assets`, refuse if the consent is withdrawn, mirroring `service.ts:186-195`); make `demo-still` composite it under the watermark band exactly as it does for `image_to_image` (`demo.ts:69-76`); add an integration test asserting the adapter received one reference input. Until then, change the Train copy (D1 option a).
2. **Collections are read-only seed data** (6.4). Effort: small-medium. Proposal: `POST/PATCH/DELETE /api/collections` and `POST/DELETE /api/collections/[id]/items` in a new `src/server/collections.ts` (owner checks like `folders.ts`), plus an "Add to collection" entry on the template page for creators and a sheet on the profile page. ~150 lines including zod schemas.
3. **Template versioning has no UI** (6.11; D4). Effort: small. Proposal in D4.
4. **Library filters: date, template, creator, quality missing; project/template exist in the API only** (5.16-5.21). Effort: small. Proposal: in `collection/page.tsx` pass through `project`, `template` (both already in `listCreations`); add `quality` via `sql\`${generationJobs.params}->>'quality' = ${q}\`` and `from`/`to` dates on `createdAt`; add three selects in `library.tsx` next to the model select. Creator filter is only meaningful as "template creator" (join `templates.creator_id`), ~5 lines in `views.ts`.
5. **Folder management is add-only** (5.5). Effort: small. Proposal: `DELETE /api/folders/[id]/items` with `{jobIds}` (mirror of `addToFolder`), a "Remove from folder" action when `query.folder` is set in `LibraryView`, and a delete button on the folder select (route exists).
6. **Alternate angles** (4.3). Effort: small. Proposal: add `"angle"` to the derive `relation` enum; in `deriveDraft` pick the next `FRAMINGS` value and, for video models with camera support, a different `CAMERA_MOVEMENTS` entry; label the scene version `angle`. ~30 lines plus one test.
7. **Suspended creators' templates stay live** (D6). Effort: small.
8. **Avatar upload** (6.2). Effort: small-medium. Proposal: `POST /api/me/avatar` using `acceptUpload(..., "avatar")` (needs `purpose` widened at `media.ts:40`), store `avatar_asset_id`, serve public via `assetUrl`; `Avatar` component falls back to initials. Note the consent record created by `acceptUpload` would be `upload_subject`; an avatar should probably get its own statement.
9. **Analytics sharing opt-in** (6.7). Effort: small. Proposal: expose `share_analytics` in settings; when true, show the 30-day "Uses" per template on the public profile. Nothing private is involved, counts only.
10. **Lineage depth** (5.8). Effort: small. Proposal: recursive CTE on `parent_job_id` bounded to depth 5 in `lineage()`.
11. **Remix lineage** (D8). Effort: small.
12. **Follower list / favorites on profile** (6.5, 6.6). Effort: small. Low value; only if the product wants social proof pages.
13. **Headline edit** (6.21). Effort: trivial. Add `headline` to `profileSchema` and the settings form; upsert `creator_profiles`.
14. **UI-level tests for Systems 4-7**. Effort: medium. The integration suite covers projects, presets, publishing, consent cascade and moderation at the service layer (`platform.test.ts:133-365`); the Playwright journey (`tests/e2e/journey.spec.ts`) touches none of `/projects`, `/studio`, `/train`, `/creators/*` or the publish sheet (`grep` → only the folders origin check at :103). Proposal: one serial e2e spec that creates a project, saves a guide, makes a demo still into the scene, selects it as the take, publishes it, and verifies the template page and the creator's manage table.

---

## Observations that are inferences, not verified by execution

- The demo adapter ignoring video inputs for continuation/extension (4.1, 4.2) is read from `demo.ts:69` (`req.inputs.find((i) => i.kind === "image")`); I did not run a continuation.
- `SequencePlayer` relies on `video.play()` after a click-opened sheet (`projects.tsx:534-536`); autoplay policy should allow it since a gesture precedes it, but this was not exercised (and `notes/plan.md` already lists H.264 playback in headless Chromium as unverified).
- The 30-day purge (`worker/index.ts:34`) runs hourly only while a worker process is alive; a deployment without the worker would never purge. This is consistent with the UI copy but worth stating in the verification report.
- `creatorPage` builds collection cards with `cardsByIds`, which drops unpublished templates (`discovery/templates.ts:169`); a seeded collection that includes an unpublished template therefore shows fewer items without saying so. Not observed in data.

## Status codes and env vars referenced

Status codes seen in these systems: 401 `unauthorized`; 403 `personal_media`, `consent_withdrawn`, `consent_required`, `removed`, `forbidden` (media); 404 `not_found` (ownership and bad UUID via 22P02 mapping `src/server/http.ts:66-68, 76-81`); 409 `not_ready`, `no_output`, `job_active`, `cost_changed`, `already_resolved`, `handle_taken`; 413 `too_large`; 415 `unsupported_type`; 422 `limit_reached`, `invalid_order`, `policy_blocked`, `unsupported_settings`, `input_required`, `unsupported`, `self_follow`, `invalid_input`; 429 `rate_limited`, `too_many_active`; 451 `age_assurance_required`; 503 `model_unavailable`.

Env vars touched by these paths: `ENABLE_DEMO_PROVIDER` (demo adapter `isConfigured`, `demo.ts:109`), `MEDIA_URL_TTL_S` (`media.ts:16`), `USER_MAX_ACTIVE_JOBS` (`service.ts:277`), `PROVIDER_TIMEOUT_S` (`processor.ts:70`), `WORKER_CONCURRENCY` / `WORKER_HEALTH_PORT` (`worker/index.ts:11, 47`), `AGE_ASSURANCE_STRICT_REGIONS` / `GEO_COUNTRY_HEADER` (derive goes through `createDraft`, `service.ts:153-159`).
