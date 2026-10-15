# Hushloom domain features map

Read-only survey of `/home/claude/hushloom` (branch `claude/playbox-2-foundation-q7fpbs`). Everything under "Verified" was read in source; "Inference" marks conclusions not directly stated in code. No files were modified and no npm scripts were run.

Files covered: `src/server/discovery/templates.ts`, `src/server/templates/publish.ts`, `src/server/templates/queries.ts`, `src/server/creators.ts`, `src/server/social.ts`, `src/server/projects.ts`, `src/server/presets.ts`, `src/server/folders.ts`, `src/server/characters.ts`, `src/server/audit.ts`, `src/server/log.ts`, `src/server/create-context.ts`, `scripts/seed.ts`, plus the API routes, pages, schema and tests that wire them.

---

## 1. Discovery

### 1.1 Layers implemented (verified)

All in `src/server/discovery/templates.ts`. Every layer goes through `selectCards()` (line 119: `templates` inner join `user_profiles` on creator, left join `template_categories`, left join `media_assets` on poster) and `toCards()` (line 78), and every layer applies the `published` predicate (line 128: `status = 'published' and deleted_at is null`).

| Layer | Function | Signal / ordering | Surfaced on |
| --- | --- | --- | --- |
| Browse (Trending / New / Top rated / Most favorited) | `browseTemplates` (141) | `sortExpr` (49). Trending = `trendingScore` (42): 3 × count of `discovery_events` with `event='generate'` in last 7 days + 2 × `favorite_count` + `generation_count`. Top rated = Bayesian `ratingScore` (47): `(rating_sum + 9) / (rating_count + 3)`, tiebreak `rating_count`. New = `published_at desc`. Most favorited = `favorite_count desc`. | `/` (`src/app/page.tsx` 18–19), `/explore` (`src/app/explore/page.tsx` 17), `GET /api/templates` (`src/app/api/templates/route.ts` 19) |
| Search + filters | `browseTemplates` | `q` → `ilike` on title, description, creator handle, and `exists (unnest(tags) ilike)` (147–150); `%`/`_` escaped (144). `category` (slug), `media`, `creatorId`, `vipOnly`. Limit clamp 60, default 24; returns `hasMore` via limit+1 (158–164). | `/explore`, `/api/templates` |
| For You | `forYou` (212) | See 1.2. | `/` section "For you", kicker toggles "From what you love" vs "Popular to start" based on `personalized` flag (`src/app/page.tsx` 57–70) |
| Continue exploring (Recently Viewed) | `recentlyViewed` (188) | Distinct `template_id` from `discovery_events` where `event='view'`, ordered by `max(created_at)`, limit 12. | `/` "Continue exploring" (page.tsx 72–77) |
| Following | `followingFeed` (199) | Published templates whose `creator_id` is in `follows.creator_id` for the viewer, `published_at desc`. | `/` "Following" (page.tsx 92–97) |
| Similar Creations / Related | `similarTemplates` (174) | `overlap` = 2 if same `category_id` + count of shared tags (array intersect subquery, line 179). Excludes the template itself, requires `overlap > 0`, ordered by overlap then `favorite_count`. | `/templates/[id]` (`src/app/templates/[id]/page.tsx` 37, limit 10) |
| Saved inspirations | favorites table | `favorites` table with `target_type` in `{template, creation}` (schema 253). | `/favorites` page exists (`src/app/favorites/page.tsx`, not read in detail) |
| Categories | `listCategories` (254) | `template_categories` ordered by `sort_order`. | Home category chips (page.tsx 48–54) |

Card payload (`TemplateCard`, lines 17–38): id, slug, title, creator {id, handle, displayName}, category slug, mediaType, mode, durationS, isVip, quality, `isNew` (published within 7 days, `NEW_DAYS` line 40), signed `posterUrl`/`previewUrl` via `assetUrl(asset, viewerId)`, poster dims, favoriteCount, generationCount, rating (rounded to 0.1, null when no ratings), `isFavorited` (batch lookup, line 80–87), tags.

Not implemented as distinct layers (verified absence in `src/server/discovery/`): "Recommended Templates" as a separate feed (For You covers it), "Related Visual Styles" (only tag/category overlap). No cursor pagination; offset-based.

### 1.2 For You signals (verified, `forYou` lines 212–252)

1. Reads `user_preferences`. If `personalization_enabled = false` → returns trending with `personalized: false` (214).
2. Affinity CTE (217–229): favorites of templates weight 3; `discovery_events` in last 90 days weight 2 for `generate`, 1 for `view`. If `history_enabled = false` the event set is `'generate'` only (216). Aggregated per `category_id` and per tag.
3. Explicit `interests` (text[] in `user_preferences`) each add weight 4 as tags (237).
4. If no affinity rows and no interests → trending fallback, `personalized: false` (231–233).
5. Score = category CASE weights + sum of tag CASE weights + `ln(1 + favorite_count + generation_count)` (246). Excludes the viewer's own templates (`ne(templates.creatorId, viewerId)`, 248).

Only template `category_id` and `tags` feed the score; no user attributes (matches the docstring at 207–211 and plan.md "Decisions" line 106). Test: `tests/integration/platform.test.ts` 241–252 "For You falls back to trending when personalization is off".

### 1.3 Event capture (verified)

- `discovery_events` table (schema 296–306): `user_id`, `template_id`, `event` in `{view, generate}`, `created_at`; index `(user_id, created_at)`. Cascades on user and template delete.
- `view` is inserted on every server render of `/templates/[id]` for a signed-in user unless `history_enabled === false` (`src/app/templates/[id]/page.tsx` 33–36). No dedupe per session; repeated reloads append rows (inference: table grows unbounded per view; `recentlyViewed` groups by template so the UI is unaffected).
- `generate` is inserted at confirm time when the job has a `templateId` (`src/server/generation/service.ts` 316–318). `templates.generation_count` is incremented separately on completion (`src/server/generation/processor.ts` 221–226).
- No `discovery_events` index on `template_id`; `trendingScore` and `creatorAnalytics` run a correlated subquery per template row over `(template_id, event, created_at)` (inference: fine at seed scale, will need an index at volume).

### 1.4 Personalization controls and history clearing (verified)

- `user_preferences` (schema 121–129): `personalization_enabled` (default true), `history_enabled` (true), `autoplay_previews` (false), `copilot_enabled` (true), `interests text[]`.
- `PATCH /api/me/preferences` (`src/app/api/me/preferences/route.ts`) → `updatePreferences` (`src/server/me.ts` 72–80): upsert; setting `historyEnabled: false` also calls `clearHistory`. Schema `preferencesSchema` (me.ts 19–27): all fields optional, interests max 12 tags of ≤24 chars, lowercased.
- `DELETE /api/me/history` (`src/app/api/me/history/route.ts`) → `clearHistory` (me.ts 83–87): deletes all the user's `discovery_events`, returns count, audits `history.clear`.
- Settings UI (`src/components/settings.tsx` 123–159): toggles for personalization and "Keep viewing history" (description states turning it off deletes recorded history), interest tag chips seeded from `popularTags` (top 30 tags across published templates, me.ts 36–38), and a "Clear history now" button.
- Account deletion also deletes `discovery_events` (`src/server/auth/account.ts` 167).
- Gap: `history_enabled=false` stops `view` inserts and removes `view` from For You, but `generate` events are still recorded and still used by For You and Trending. `updatePreferences` itself is not audited (only the embedded clearHistory is).

---

## 2. Templates: publishing, versioning, remix attribution, reporting, moderation

### 2.1 Tables (verified, `src/server/db/schema.ts`)

- `templates` (189–224): slug (unique), creator_id, category_id, title, description, media_type, mode, tags[], status enum `draft|published|unpublished|removed` (28), is_vip, quality, duration_s, poster_asset_id, preview_asset_id, current_version, `remixed_from_id` (no FK), favorite_count, generation_count, rating_sum, rating_count, published_at, soft `deleted_at`. Indexes on (status, published_at), creator, category.
- `template_versions` (226–240): template_id (cascade), version, prompt, negative_prompt, model_key, defaults jsonb, changelog; unique (template_id, version).
- `template_ratings` (242–251): PK (user_id, template_id), `score` with check 1..5.
- `template_collections` / `template_collection_items` (274–294): creator-owned, `is_public` default true, positioned items.
- `moderation_events` (559–575): subject_type in `template|prompt|upload|user|output`, action enum `report|auto_block|approve|remove|dismiss` (64), status `open|resolved`, reporter_id, actor_id, reason, details jsonb, resolved_at.

### 2.2 Publishing (verified, `src/server/templates/publish.ts` `publishTemplate` 41–131)

Route: `POST /api/templates` (`src/app/api/templates/route.ts` 25–30), `requireUser`, body `publishSchema` (22–29: jobId uuid, title 2–60, description ≤500, categorySlug, tags ≤8 × ≤24 lowercased, isVip).

Steps and status codes:
1. Job must be the caller's and not deleted → else 404 (47).
2. `status !== 'completed'` → 409 `not_ready` (48).
3. `inputAssetIds.length || characterReferenceId` → 403 `personal_media` (49–55). This is the consent boundary: creations from uploads or likeness references never become public.
4. `checkPrompt(title, description, tags, job.prompt)` → on block, inserts `moderation_events` `auto_block`/resolved with matched terms, throws 422 `policy_blocked` (56–60).
5. First non-deleted output required → 409 `no_output` (61–67).
6. Copies the output bytes to a new storage key under `templates/` and, for video, copies the poster frame too (69–76). Then in a transaction: inserts a new `media_assets` row with `visibility: 'public'` for the copy (and poster), inserts `templates` with `status: 'published'`, `remixedFromId: job.templateId`, `quality` from `job.params.quality ?? 'hd'`, `durationS` for video, poster/preview asset wiring (83–116); inserts `template_versions` v1 with prompt, negativePrompt, modelKey, `defaults` = job.params minus `seed`, changelog "First version" (117–125); promotes `member` → `creator` role and upserts `creator_profiles` (126–127); audits `template.publish` (128).

Original private asset is untouched (test: platform.test.ts 178–190 "copies the output to a new public asset and leaves the original private"; 191–204 cover personal-media refusal and cross-user 404).

Slug: `slugify` (31–34) lowercases, strips to 40 chars, appends a 5-char random suffix. The seed uses plain slugs without suffix (seed.ts 233).

### 2.3 Editing, unpublishing, versioning (verified, `updateTemplate` 144–194)

Route: `PATCH /api/templates/[id]` (`src/app/api/templates/[id]/route.ts`). Schema `updateTemplateSchema` (133–142): title, description, tags, categorySlug, isVip, `status` in `{published, unpublished}`, `prompt` (1–2000), `changelog` ≤200.

- Owner or admin, else 404 (148). `status === 'removed'` → 403 `removed` (149).
- Prompt text runs through `checkPrompt` → 422 `policy_blocked` (150–151).
- If `prompt` differs from the current version's prompt → inserts `template_versions` with `version = current_version + 1`, copying negativePrompt/modelKey/defaults from the current version, with the provided changelog (157–175), and bumps `templates.current_version`.
- Metadata edits apply in place; `published_at` is set when first published; audit `template.update` with the list of field names (191).

Which version a remix uses: `generation_jobs.template_version` is recorded from `templates.current_version` at draft time (`src/server/generation/service.ts` 200–210, schema 386). `templateForViewer` returns the current version plus a `versions` list (`queries.ts` 19–27); the template page lists versions when more than one exists (`src/app/templates/[id]/page.tsx` 137–143).

UI gap (verified): `src/components/creator-manage.tsx` sends only metadata and status toggles; its copy at line 144 says "To change the prompt, publish a new version from a creation", but no flow publishes a new version onto an existing template (publishing always creates a new template). The prompt-versioning path exists only at the API level and has no test.

### 2.4 Remix attribution (verified)

- `templates.remixed_from_id` is set to the source job's `templateId` on publish (publish.ts 113). No FK and no "remix count" column.
- `templateForViewer` resolves `remixedFrom {slug, title}` (queries.ts 34–37); template page renders a "remixed from" link (`src/app/templates/[id]/page.tsx` 89–93).
- Inference: attribution is one hop only; nothing lists a template's descendants, and deleting/removing the source leaves a dangling id (the lookup simply returns null).

### 2.5 Ratings (verified)

`POST /api/templates/[id]/rate` (`src/app/api/templates/[id]/rate/route.ts`): `score` int 1–5, template must be published (404 otherwise), `rateTemplate` (publish.ts 196–210) upserts `template_ratings` and recomputes `rating_sum`/`rating_count` from the source rows inside one transaction.

### 2.6 Reporting (verified)

`POST /api/templates/[id]/report` (`src/app/api/templates/[id]/report/route.ts`): `requireUser`; Redis rate limit `report:<userId>` 20/hour → 429 `rate_limited`; body `reason` in `{minor, non_consent, real_person, illegal, spam, other}`, `note` ≤1000; template resolved through `templateForViewer` (404 if not visible); inserts `moderation_events` `report`/`open` with `reporter_id`; returns 201. Inference: a creator can report their own unpublished template since `templateForViewer` returns own templates in any status; harmless.

Template detail wires rating, report and follow (`src/components/template-detail.tsx` 63, 97, 142).

### 2.7 Moderation (verified, `src/server/admin.ts`)

- `moderationQueue` (77–105): open events, newest first, limit 100, joined to reporter handle and template metadata; `severe` flag when reason is in `SEVERE` (minor / non_consent / real_person / illegal — inferred from the sort, constant not read); severe sorted first.
- `POST /api/admin/reports/[id]` (`src/app/api/admin/reports/[id]/route.ts`): `requireAdmin`, `resolveSchema` action `remove|dismiss`, note ≤500. `resolveReport` (109–142): `select ... for update`; already resolved → 409 `already_resolved`; `remove` on a template sets `status = 'removed'`; on an output soft-deletes `generation_outputs` and its `media_assets`; other subject types → 422 `unsupported`; closes every open event on the same subject; `dismiss` closes only the one event; a resolution event row is inserted; audit `moderation.<action>`.
- Removed templates: `updateTemplate` refuses (403), discovery hides (status filter), `creatorAnalytics` excludes `removed` (creators.ts 64).
- Test: platform.test.ts 205–219 "removing a reported template takes it down and closes every report on it".
- Gaps: no appeal path; no `approve` action exposed although the enum has it; no moderation for users beyond `POST /api/admin/users/[id]/suspend` (`suspendUser`, admin.ts 203–208: sets status suspended, destroys sessions, audits `user.suspend`); no un-suspend route; no reporting of creators/outputs from the UI (only `subjectType: "template"` is ever inserted by a user route).

### 2.8 Template collections (verified)

Tables exist and the seed creates one ("After-dark essentials", seed.ts 277–278). `creatorPage` returns public collections (or all for the owner) with cards (creators.ts 18–38, 47). There is no API route or UI to create, edit or reorder collections (grep: `templateCollections` only referenced in `src/server/creators.ts`, `schema.ts`, `scripts/seed.ts`). Status: read-only, seed-only.

---

## 3. Creators, following, favorites

### 3.1 Creator profile (verified, `src/server/creators.ts`)

- `creatorPage(handle, viewerId)` (8–50): profile via `profileByHandle` (case-insensitive handle, user must be `active`, social.ts 32–39); `creator_profiles.headline`; follower and following counts; `isFollowing`; published templates `sort: 'new', limit: 60`; collections (see 2.8); totals of generations and favorites across published templates. Rendered by `src/app/creators/[id]/page.tsx` (`[id]` is the handle, line 18).
- `creatorAnalytics(creatorId)` (53–85): owner-only (page.tsx 22 gates on `data.isOwner`); all non-removed templates with status, version, favorites, generations, rating, `views30`/`generations30` from `discovery_events` in the last 30 days. Analytics only count events on the creator's own templates; no per-viewer data is exposed (consistent with spec Part III.6).
- `creator_profiles.shareAnalytics` is set true in the seed (seed.ts 208) but not read anywhere in the files reviewed (inference: unused flag).
- Avatar is a generated initial (`Avatar name=...`, page.tsx 28); no avatar upload (`upload_purpose` enum has `avatar` but no route uses it in the files reviewed).

### 3.2 Following (verified, `src/server/social.ts`)

- `POST|DELETE /api/follows` (`src/app/api/follows/route.ts`), body `{creatorId}`. `setFollow` (24–30): self-follow → 422 `self_follow` (also DB check `no_self_follow`, schema 271); target must be an `active` user, else 404; insert `onConflictDoNothing` / delete. No creator-role requirement: any active user can be followed.
- Feed: `followingFeed` (§1.1). Counts on creator page. `FollowButton` in `src/components/template-detail.tsx` (63) reused on creator page.
- Test coverage: none specific to follows (grep of test files).

### 3.3 Favorites (verified)

- `POST|DELETE /api/favorites` body `{targetType: template|creation, targetId}`. `setFavorite` (social.ts 6–22): template must be published (404 otherwise); creation must be the caller's own job (404 otherwise); insert/delete in a transaction and recompute `templates.favorite_count` from the source rows.
- Library filter `favorites` uses an EXISTS on `favorites` with `target_type='creation'` (`src/server/generation/views.ts` ~50).

---

## 4. Projects, scenes, branches

### 4.1 Tables (verified)

- `projects` (schema 310–322): user_id, title, description, soft delete.
- `project_scenes` (332–343): project_id (cascade), position, title, `continuity jsonb` typed `ContinuityGuide` = {lighting, framing, palette, characterReferenceId, notes} (324–330).
- `scene_versions` (436–448): scene_id (cascade), job_id (cascade, unique), parent_version_id (no FK), `branch_label` default `main`, `is_selected`.
- `generation_jobs` carries `project_id`, `scene_id`, `parent_job_id`, `relation` (service.ts 66–72 schema: relation in `retry|variation|remix|continuation|extension`).

### 4.2 Routes (verified)

| Route | Handler | Behaviour |
| --- | --- | --- |
| `GET /api/projects` | `listProjects` (projects.ts 70–111) | Own non-deleted projects, newest updated first, scene count, completed clip count, cover = newest completed creation (DISTINCT ON project_id) with signed URL and poster |
| `POST /api/projects` → 201 | `createProject` (113–119) | Title 1–80, description ≤500; creates the project and an "Opening" scene at position 0 in one transaction |
| `GET /api/projects/[id]` | `getProjectDetail` (137–168) | Owner or 404; scenes ascending by position; versions ascending by created_at with the creation (from `listCreations(..., {projectId, limit: 200, sort: 'oldest'})`); `loose` = creations in the project not attached to any scene version |
| `PATCH /api/projects/[id]` | `updateProject` | Partial title/description |
| `DELETE /api/projects/[id]` | `deleteProject` (132–135) | Soft delete; creations keep their `project_id` and remain in the Library (docstring 131) |
| `POST /api/projects/[id]/scenes` → 201 | `addScene` (171–183) | Max 50 scenes → 422 `limit_reached`; new scene inherits the previous scene's continuity unless one is given; `checkContinuity` verifies the character reference is the owner's and not deleted (59–66) |
| `PUT /api/projects/[id]/scenes` | `reorderScenes` (208–219) | `order` must list every scene exactly once → else 422 `invalid_order`; `select ... for update` |
| `PATCH /api/scenes/[id]` | `updateScene` (185–195) | Title and/or continuity, ownership through join to `projects` |
| `DELETE /api/scenes/[id]` | `deleteScene` (197–205) | Hard delete and re-pack positions |
| `POST /api/scenes/[id]/select` | `selectVersion` (222–236) | Version must belong to the scene and its job must be `completed` → else 409 `not_ready`; clears other selections on the scene |

Every mutation calls `touch(projectId)` to bump `updated_at`.

### 4.3 Timeline, continue, variation, compare (verified)

- A job created with `sceneId` (and matching `projectId`, service.ts 220–225) gets a `scene_versions` row at confirm time: `parent_version_id` = the version of `parent_job_id` if any, `branch_label` = `alternate` when `relation === 'variation'` else `main` (service.ts 302–314).
- `POST /api/generations/[id]/derive` (`src/app/api/generations/[id]/derive/route.ts`) body `{relation: retry|variation|continuation|extension, idempotencyKey}` → `deriveDraft` (service.ts 357–402): copies prompt/params/model/template/character/project/scene from the source job; `variation` assigns a fresh random seed; `continuation`/`extension` require a completed video output → else 422 `unsupported`, set mode `scene_continuation` / `video_extension` and feed the output asset as input; `parentJobId` = source. Returns 201 with the draft (cost shown before confirm).
- Workspace UI (`src/components/projects.tsx`): horizontal "Scene timeline" (219), per-version "Set as take" → select route (313), "Branch" → derive variation (318–320), "Continue" → derive continuation (323–325), "Compare" toggles up to two versions side by side (131, 194, 276–290, 331–334); continuity form with lighting/framing selects and character reference select (442–468). Project page `src/app/projects/[id]/page.tsx` loads detail plus the user's characters; bad UUID → 404.
- Creation detail (`src/components/creation-detail.tsx`) exposes Retry, Variation, Continue scene, Extend clip (235–246) and a version strip with "Compare with" (305–317).
- Tests: platform.test.ts 325–354 (scene order, continuity copy-forward, select only finished takes, cross-user 404s); generation.test.ts 231 "makes variations with a new seed and records lineage"; 220 cross-user derive refused.

Gaps: `parent_version_id` has no FK; there is no "shot sequence" export or clip concatenation; branch labels are only `main`/`alternate` (no user naming); deleting a scene hard-deletes its `scene_versions` (cascade) while jobs keep a dangling `scene_id` (inference from the cascade on `scene_versions.scene_id` and `set null` absent on `generation_jobs.scene_id`; the schema line for `generation_jobs.scene_id` was not read).

---

## 5. Presets (verified, `src/server/presets.ts`)

- Table `saved_presets` (schema 471–484): user_id, name, mode, model_key, params jsonb (`GenerationParams`), prompt.
- `GET /api/presets` → `listPresets` (newest first, limit 100). `POST /api/presets` → 201 `createPreset`; `DELETE /api/presets/[id]` → `deletePreset` (404 when not owner).
- `presetSchema` (11–20) is a union: `{name, fromJobId}` or `{name, mode, modelKey, prompt, params}`. From a job: ownership via `getOwnedJob` (404 otherwise), `seed` stripped (37–38). Manual: model must exist in the registry → else 422 `unknown_model`. Cap 100 per user → 422 `limit_reached` (44–45).
- UI: "Save as preset" sheet on creation detail (creation-detail.tsx 410–432); `/studio?preset=<id>` prefills the Create panel (`src/app/studio/page.tsx` 20–27); `PresetList` in `src/components/studio.tsx`.
- Test: platform.test.ts 356–366.
- Gaps: no rename/update route; "Reuse Settings" from a template is the template-defaults prefill rather than a preset.

---

## 6. Folders (verified, `src/server/folders.ts`)

- Tables `folders` (schema 450–459) and `folder_items` (461–469, PK (folder_id, output_id), both cascade).
- `GET /api/folders` (alphabetical), `POST /api/folders` → 201 (name 1–40), `DELETE /api/folders/[id]` (404 when not owner), `POST /api/folders/[id]/items` body `{jobIds: 1..100}` → `addToFolder` (21–30): folder must be owner's, maps job ids to the caller's non-deleted outputs, inserts `onConflictDoNothing`, returns `{added}` count.
- Library filter `folder=<uuid>` (`src/app/collection/page.tsx` 21; `views.ts` EXISTS on `folder_items` joined to `generation_outputs`). Library UI: multi-select "Add to folder" sheet with inline folder creation (`src/components/library.tsx` 165–170, 286–311); creation detail has the same sheet (creation-detail.tsx 364–395).
- Gaps: no route to remove an item from a folder or rename a folder; no per-folder listing endpoint other than the Library filter; no folder nesting. e2e uses `POST /api/folders` only as the cross-origin 403 probe (journey.spec.ts 103).

---

## 7. Character references and consent (verified, `src/server/characters.ts`)

- Table `character_references` (schema 345–357): user_id, name, asset_id (FK media_assets), `consent_record_id` (FK consent_records, NOT NULL), soft delete. `consent_records` (131–143): kind enum includes `likeness` and `upload_subject` (per `src/server/media.ts` 80), statement, subject_label, granted_at, withdrawn_at.
- `LIKENESS_STATEMENT` (8–9): adult, self-or-explicit-permission, acknowledges removal deletes every creation.
- `POST /api/characters` (`src/app/api/characters/route.ts`): `requireUser`; Redis rate limit `character:<userId>` 10/hour → 429; multipart `file`, `name` (trimmed to 40); both `consentAdult` and `consentLikeness` must be `"true"` → else 422 `consent_required`; → `createCharacter` (37–53): image MIME only → 415 `unsupported_type`; cap 20 live references → 422 `limit_reached`; `acceptUpload(..., purpose 'reference')` writes the asset, a `consent_records` row of kind `likeness` and an `uploads` row (media.ts 32–86); inserts the reference; returns 201 `{id, warnings}` (warnings from upload analysis, e.g. low resolution; inference).
- `GET /api/characters` → `listCharacters` (16–35): only references whose consent is not withdrawn; signed image URL.
- `DELETE /api/characters/[id]` → `removeCharacter` (56–63) → `withdrawConsent` (`src/server/auth/account.ts` 111–152): marks consent withdrawn (404 if not found/already withdrawn; `terms`/`adult_attestation` → 422 `use_account_deletion`), soft-deletes the reference, finds every job using the asset (`arrayOverlaps(inputAssetIds)`) or the reference id, soft-deletes their outputs and posters and jobs (`cancelRequested: true`), soft-deletes the assets, audits `consent.withdraw`, then `purgeAssetsNow` deletes files immediately (not waiting for the retention sweep).
- Enforcement at generation time (service.ts 186–195): the reference must be the caller's, not deleted, consent not withdrawn → 403 `consent_withdrawn`; uploads likewise need an active consent → 403 `consent_required` (116–128). Scene continuity `characterReferenceId` validated in projects.ts 59–66. `createContext` only offers references with active consent (create-context.ts 18–22).
- Publishing block for anything using a reference: §2.2 step 3.
- Train page (`src/components/train.tsx`): states plainly that no fine-tuning happens (66); two consent checkboxes; removal dialog explains immediate deletion (157).
- Tests: platform.test.ts 133–175 (upload consent withdrawal deletes creations and files; removing a character deletes reference and creations; cross-user use refused).
- Gaps: `subjectLabel` is always `null` from the route (route line 22) so the consent record uses the character name as the label (characters.ts 46); no age-assurance beyond the user's own attestation for the depicted subject (self-declaration, as the statement says); no identity verification of the subject.

---

## 8. Audit log (verified)

`audit(actorId, action, targetType, targetId, metadata = {}, tx?)` in `src/server/audit.ts` inserts into `audit_logs` (schema 577–589: actor_id nullable FK set-null, action, target_type, target_id text, metadata jsonb, created_at; indexes on (target_type, target_id) and created_at). Viewer: `recentAudit(60)` (admin.ts 210–222) rendered on `/admin` (`src/app/admin/page.tsx` 33). No API to query the log; no retention policy; no hash chain.

Actions recorded (grep of `audit(` across `src`):

| Action | Where | Target |
| --- | --- | --- |
| `account.create` | auth/account.ts 85 | user |
| `account.delete` | auth/account.ts 169 | user |
| `consent.withdraw` | auth/account.ts 145 | consent_record, `{removedAssets}` |
| `sessions.revoke_all` | api/me/sessions/route.ts 10 | user |
| `profile.update` | me.ts 69 | user, `{handle}` |
| `history.clear` | me.ts 85 | user, `{removed}` |
| `template.publish` | templates/publish.ts 128 | template, `{fromJob}` |
| `template.update` | templates/publish.ts 191 | template, `{fields}` |
| `creation.delete` | generation/service.ts 430 | generation_job |
| `moderation.remove` / `moderation.dismiss` | admin.ts 141 | subject type/id, `{reportId, note}` |
| `model.configure` | admin.ts 169 | model |
| `credits.adjust` | admin.ts 197 | user, `{amount, reason}` (only when applied) |
| `user.suspend` | admin.ts 207 | user, `{reason}` |
| `payment.<stripe event type>` | payments/stripe.ts 155 | payment_event, `{outcome}`, actor null |

Not audited (verified absence): login/logout, preference changes, favorites, follows, ratings, reports (recorded in `moderation_events` instead), folder/preset/project/scene mutations, character creation (consent record is the evidence), generation draft/confirm/cancel (state lives on the job row), uploads.

---

## 9. Structured logging (verified, `src/server/log.ts`)

- `logger.{debug,info,warn,error}(msg, meta?)` writes one JSON line `{t, level, msg, ...meta}`; `Error` values in meta are serialized to `{name, message, stack}` (3–10). `warn`/`error` go to stderr, others to stdout (15–16). In `NODE_ENV=test`, everything below `error` is suppressed unless `LOG_TESTS` is set (13).
- No log level filter in production, no request id / correlation id, no redaction helper, no pino/winston dependency. Comment at line 19 says to ship stdout to an external pipeline; no error-monitoring SDK is wired (spec Part VI asks for "error monitoring").
- Call sites: `generation.start` / `generation.provider_error` / `generation.discarded` / `generation.done` (`src/server/generation/processor.ts` 113, 129, 231, 234); unhandled route errors with path (`src/server/http.ts` 69); media purge failures (`src/server/media.ts` 121); Stripe event outcome (`src/server/payments/stripe.ts` 156); Replicate webhook (`src/app/api/webhooks/replicate/route.ts` 34); worker lifecycle, crashes, reconcile and purge (`src/worker/index.ts` 21–56).
- Inference: HTTP access logging is left to the platform; successful API calls are not logged.

---

## 10. `createContext` (verified, `src/server/create-context.ts`)

`createContext(user | null)` returns what the Create panel needs: `models` from `listModelAvailability()`, `balance.available`, `vip` (`hasVip`), `copilot` preference, `characterRefs` (active-consent only), `projects` (≤30 by updated_at, each with ordered scenes). Anonymous callers get models with zero balance and empty lists. Used by `/templates/[id]`, `/generate/[kind]`, `/studio`.

---

## 11. Seed (`scripts/seed.ts`, verified)

- Entry: `npm run db:seed` → `tsx scripts/seed.ts` (package.json 16). Refuses if `templates` has rows (38–43). Password from `SEED_PASSWORD` or a random base64url printed once (45, 281).
- Creates 9 categories (47–57), 1 admin (`admin@hushloom.local`, handle `hushloom`), 5 creators with `creator_profiles` (`shareAnalytics: true`), 1 member `demo@hushloom.local` with 200 credits via `applyMovement` idempotency key `seed:<id>` (211–214). Every seeded user gets `user_preferences`, `credit_accounts`, DOB 1990-01-01 with `ageAssuranceMethod: self_declaration`, and `terms` + `adult_attestation` consent records (184–198).
- 24 templates (`T`, 83–108) with original procedurally generated SVG→WebP covers (`coverSvg`, 122–147) stored as public `media_assets`; video templates get a 3 s ffmpeg zoompan MP4 preview at 480px (166–181), silently skipped if ffmpeg fails. Each gets a `template_versions` v1 with `modelKey` `demo-motion` or `demo-still` and defaults (aspect, duration, quality, camera, motion).
- Deterministic signals: favorites and ratings from a seeded RNG, counts recomputed by SQL, `generation_count = abs(hashtext(slug)) % 400` (260–275). One follow (member → first creator) and one public collection with 4 items (276–278).
- Inference: `generation_count` is synthetic and therefore Trending's "+ generation_count" term is seeded fiction until real jobs run; the plan's "Night swim" project, character "Mara" and preset "Lace window" are dev-DB state, not in the seed.

---

## 12. Spec coverage summary for these areas

| Spec item | Status | Evidence |
| --- | --- | --- |
| Browse categories, Trending/New/Top Rated/Most Favorited | done | §1.1 |
| For You, Recently Viewed, Following, Similar | done | §1.1–1.2 |
| Recommended Templates / Related Visual Styles as separate layers | partial | merged into For You / Similar |
| Users control personalization, clear history | done | §1.4 (generate events persist with history off) |
| Never infer sensitive attributes | done | only category/tag affinity |
| Publishing explicit; private never auto-public | done | §2.2 |
| Editing metadata, unpublishing | done | §2.3 |
| Versioning | partial | API bumps versions on prompt change; no UI, no test |
| Remix attribution | partial | one-hop `remixed_from_id`, shown on detail; no descendants list |
| Following, public collections | following done; collections read-only seed data | §3.2, §2.8 |
| Moderation and reporting | done for templates; outputs removable by admin | §2.6–2.7 |
| Creator analytics (approved, no private content) | done | §3.1 |
| Projects, scenes, timeline, branches, compare, continue | done | §4 |
| Presets | done (create/list/delete) | §5 |
| Folders | partial (no remove-from-folder, no rename) | §6 |
| Character references with consent, withdrawal deletes | done | §7 |
| Audit logs | done for admin/account/publish actions; many user actions unlogged | §8 |
| Structured logs | done (JSON lines); error monitoring absent | §9 |
