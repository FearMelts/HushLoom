# Hushloom data model map

Read-only survey of `/home/claude/hushloom` on branch `claude/playbox-2-foundation-q7fpbs`, 2026-10-12.
Sources read in full: `src/server/db/schema.ts` (589 lines), `src/server/db/index.ts`, `drizzle/0000_init.sql` (470 lines),
`drizzle/0001_output_posters.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0001_snapshot.json`, `src/server/credits/ledger.ts`,
and every function that opens a `db.transaction` (listed in section 5). Spec reference: Part VI "Data model entities" line in
`/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx/spec.md:40` (the spec file has no numbered
"section 15"; Part VI is the only place that lists entities, so that list is used).

Convention below: **V** = verified by reading the code; **I** = inference.

## 1. Infrastructure

- ORM: Drizzle (`drizzle-orm/pg-core`, `drizzle-orm/postgres-js`) over the `postgres` driver. Client singleton in
  `src/server/db/index.ts:11-19` (`getSql()`, `getDb()`), pool `max: 10`, connection string from `env().DATABASE_URL`. `closeDb()` at line 21. (V)
- Exported `Tx` type (`index.ts:7`) is the transaction handle passed into helpers such as `applyMovement` and `audit`. (V)
- Migrations: two SQL files, journal `drizzle/meta/_journal.json` lists `0000_init` and `0001_output_posters` (dialect postgresql, version 7). (V)
  - `0000_init.sql`: 12 enums (lines 1-12), 32 `CREATE TABLE` (lines 13-382), 51 `ALTER TABLE ... FOREIGN KEY` (383-433), 38 `CREATE [UNIQUE] INDEX` (434-471). (V)
  - `0001_output_posters.sql`: adds `generation_outputs.poster_asset_id uuid` and FK to `media_assets(id)` ON DELETE no action. (V)
- The `0001_snapshot.json` column lists match `schema.ts` table by table (counts checked for all 32 tables); no schema/migration drift found. (V)
- All ids are `uuid` with `defaultRandom()` (`gen_random_uuid()`), except `model_configs` (text PK) and the pure join tables with composite PKs. (V)
- All timestamps are `timestamptz`. Soft delete is a nullable `deleted_at` (helper `deletedAt()` at `schema.ts:22`). (V)

Enums (`schema.ts:24-66`): `user_role` (member, creator, admin), `user_status` (active, suspended, deleted), `media_kind` (image, video),
`visibility` (private, public), `template_status` (draft, published, unpublished, removed), `generation_mode` (8 values: text_to_image,
image_to_image, text_to_video, image_to_video, video_to_video, video_extension, scene_continuation, reference_guided), `job_status`
(draft, awaiting_confirmation, queued, processing, completed, failed, cancelled), `ledger_kind` (signup_grant, purchase, subscription_grant,
reserve, release, settle, admin_adjust), `consent_kind` (terms, adult_attestation, upload_subject, likeness, training_data),
`moderation_action` (report, auto_block, approve, remove, dismiss), `moderation_status` (open, resolved), `upload_purpose` (source,
reference, avatar, template_media). (V)

## 2. Tables (32)

Format: columns `name: type [constraints]`. "FK" rows give the referenced table and ON DELETE behaviour from `0000_init.sql`.
"Spec entity" is the Part VI entity the table covers.

### Identity

**users** (`schema.ts:70-86`; SQL 369-382) — spec: *Users*
- `id uuid PK`, `email text NN`, `password_hash text NN`, `role user_role NN default member`, `status user_status NN default active`,
  `date_of_birth date NN`, `age_assurance_method text NN`, `age_assured_at timestamptz NN`, `created_at`, `updated_at`, `deleted_at` (soft delete).
- Unique index `users_email_uq` on `lower(email)` (expression index). No other indexes.
- No FKs out. Age/consent facts live here (dob + assurance method/time); the attestation itself is a `consent_records` row (see `registerUser`). (V)

**user_profiles** (`schema.ts:88-99`; SQL 360-368) — spec: *User Profiles*
- `user_id uuid PK FK users(id) CASCADE`, `handle text NN`, `display_name text NN`, `bio text NN default ''`, `avatar_asset_id uuid` (NO FK), `updated_at`.
- Unique index `user_profiles_handle_uq` on `lower(handle)`.
- `avatar_asset_id` has no foreign key to `media_assets` (schema line 95). Nothing in `src/` writes it (grep for `avatarAssetId` outside schema: no hits). (V)

**sessions** (`schema.ts:101-112`; SQL 249-257) — spec: *Sessions*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `token_hash text NN`, `expires_at timestamptz NN`, `user_agent text`, `created_at`.
- Unique `sessions_token_uq(token_hash)`, index `sessions_user_idx(user_id)`.
- Hard-deleted on logout / destroyAllSessions (`src/server/auth/session.ts:80,85`). Expired rows are filtered at read time
  (`session.ts:64`, `gt(expiresAt, now)`); no sweeper deletes expired rows (grep found no such delete). (V)

**creator_profiles** (`schema.ts:114-119`; SQL 43-49) — spec: *Creator Profiles*
- `user_id uuid PK FK users CASCADE`, `headline text NN default ''`, `share_analytics boolean NN default false`, `created_at`. No extra indexes.
- Created lazily by `publishTemplate` (`src/server/templates/publish.ts:127`, `onConflictDoNothing`), which also promotes `users.role` member → creator (line 126). (V)

**user_preferences** (`schema.ts:121-129`; SQL 350-359) — spec: *User Preferences*
- `user_id uuid PK FK users CASCADE`, `personalization_enabled bool NN default true`, `history_enabled bool NN default true`,
  `autoplay_previews bool NN default false`, `copilot_enabled bool NN default true`, `interests text[] NN default '{}'`, `updated_at`.
- Upserted in `src/server/me.ts:77` (`onConflictDoUpdate` on `user_id`). (V)

**consent_records** (`schema.ts:131-143`; SQL 33-42) — spec: *Consent Records*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `kind consent_kind NN`, `statement text NN`, `subject_label text`,
  `granted_at timestamptz NN default now()`, `withdrawn_at timestamptz` (acts as the soft-delete/withdrawal marker).
- Index `consent_user_idx(user_id, kind)`.
- Referenced by `uploads.consent_record_id` (nullable, NO ACTION) and `character_references.consent_record_id` (NN, NO ACTION). (V)

### Media

**media_assets** (`schema.ts:147-165`; SQL 159-174) — spec: *Media Assets*
- `id uuid PK`, `owner_id uuid FK users SET NULL`, `kind media_kind NN`, `storage_key text NN`, `mime text NN`, `bytes int NN`,
  `width int`, `height int`, `duration_ms int`, `sha256 text NN`, `visibility visibility NN default private`, `created_at`, `deleted_at` (soft delete).
- Unique `media_storage_key_uq(storage_key)`, index `media_owner_idx(owner_id)`.
- Retention: `purgeDeletedMedia(retentionDays)` (`src/server/media.ts:93-101`) selects rows with `deleted_at < now - N days` and
  `storage_key NOT LIKE 'purged/%'` (limit 500) and removes the bytes; `src/worker/index.ts:34` calls it with 30 days. `purgeAssetsNow`
  (`media.ts:104`) removes bytes immediately for consent withdrawal and for discarded outputs. (V) The row itself is never deleted; the
  storage key is rewritten to a `purged/` prefix (I, from the `notLike` filter; `purgeRows` body not read).

**uploads** (`schema.ts:167-178`; SQL 341-349) — spec: *Uploads*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `asset_id uuid NN FK media_assets CASCADE`, `purpose upload_purpose NN`,
  `consent_record_id uuid FK consent_records NO ACTION`, `created_at`. Index `uploads_user_idx(user_id)`. No soft-delete column (the asset carries it). (V)

### Templates and community

**template_categories** (`schema.ts:182-187`; SQL 269-275) — spec: *Template Categories*
- `id uuid PK`, `slug text NN UNIQUE` (constraint `template_categories_slug_unique`), `name text NN`, `sort_order smallint NN default 0`. (V)

**templates** (`schema.ts:189-224`; SQL 313-340) — spec: *Templates*
- `id uuid PK`, `slug text NN`, `creator_id uuid NN FK users NO ACTION`, `category_id uuid FK template_categories NO ACTION`,
  `title text NN`, `description text NN default ''`, `media_type media_kind NN`, `mode generation_mode NN`, `tags text[] NN default '{}'`,
  `status template_status NN default draft`, `is_vip bool NN default false`, `quality text NN default 'hd'`, `duration_s smallint`,
  `poster_asset_id uuid FK media_assets NO ACTION`, `preview_asset_id uuid FK media_assets NO ACTION`, `current_version int NN default 1`,
  `remixed_from_id uuid` (NO FK), `favorite_count int NN default 0`, `generation_count int NN default 0`, `rating_sum int NN default 0`,
  `rating_count int NN default 0`, `published_at timestamptz`, `created_at`, `updated_at`, `deleted_at` (soft delete).
- Unique `templates_slug_uq(slug)`; indexes `templates_status_pub_idx(status, published_at)`, `templates_creator_idx(creator_id)`, `templates_category_idx(category_id)`.
- Denormalised counters: `favorite_count` recomputed from `favorites` in `src/server/social.ts:19`; `rating_sum`/`rating_count` recomputed from
  `template_ratings` in `publish.ts:203-209`; `generation_count` incremented in `processor.ts:216-219`. (V)
- `creator_id` FK is NO ACTION: deleting a `users` row with templates would fail. In practice accounts are soft-deleted (`deleteAccount` sets
  `templates.status = removed, deleted_at`), so this is not hit. (V for behaviour, I for "never hit")

**template_versions** (`schema.ts:226-240`; SQL 301-312) — spec: *Template Versions*
- `id uuid PK`, `template_id uuid NN FK templates CASCADE`, `version int NN`, `prompt text NN`, `negative_prompt text NN default ''`,
  `model_key text NN`, `defaults jsonb NN`, `changelog text NN default ''`, `created_at`.
- Unique `template_versions_uq(template_id, version)`. Prompt edits create a new version (`publish.ts:156-174`). (V)

**template_ratings** (`schema.ts:242-251`; SQL 292-300) — spec: not a named entity (supports "Top Rated" browsing in Part I)
- `user_id uuid NN FK users CASCADE`, `template_id uuid NN FK templates CASCADE`, `score smallint NN`, `created_at`.
- PK `(user_id, template_id)`; CHECK `rating_range` (`score between 1 and 5`). (V)

**favorites** (`schema.ts:253-262`; SQL 82-89) — spec: *Favorites*
- `user_id uuid NN FK users CASCADE`, `target_type text NN` (TS-typed `"template" | "creation"`, not a DB enum), `target_id uuid NN` (polymorphic, NO FK), `created_at`.
- PK `(user_id, target_type, target_id)`; index `favorites_target_idx(target_type, target_id)`.
- Because `target_id` has no FK, favorites of a hard-deleted template would dangle; templates are only soft-deleted/`removed` so far. (V/I)

**follows** (`schema.ts:264-272`; SQL 104-111) — spec: *Followers*
- `follower_id uuid NN FK users CASCADE`, `creator_id uuid NN FK users CASCADE`, `created_at`.
- PK `(follower_id, creator_id)`; index `follows_creator_idx(creator_id)`; CHECK `no_self_follow` (`follower_id <> creator_id`). (V)

**template_collections** (`schema.ts:274-284`; SQL 284-291) — spec: *Collections* (creator-curated template lists; see section 3 on the ambiguity)
- `id uuid PK`, `creator_id uuid NN FK users CASCADE`, `title text NN`, `is_public bool NN default true`, `created_at`. Index `template_collections_creator_idx(creator_id)`. (V)

**template_collection_items** (`schema.ts:286-294`; SQL 277-283) — spec: *Collections* (join)
- `collection_id uuid NN FK template_collections CASCADE`, `template_id uuid NN FK templates CASCADE`, `position int NN default 0`. PK `(collection_id, template_id)`. (V)
- No code outside `schema.ts` reads or writes `template_collections`/`template_collection_items` (grep `templateCollections` in `src/`: only the schema). (V)

**discovery_events** (`schema.ts:296-306`; SQL 74-81) — spec: *Discovery History*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `template_id uuid NN FK templates CASCADE`, `event text NN` (TS `"view" | "generate"`), `created_at`.
- Index `discovery_user_time_idx(user_id, created_at)`. Hard-deleted on account deletion (`account.ts:166`). Written on confirm (`service.ts:317`). (V)

### Projects and continuity

**projects** (`schema.ts:310-322`; SQL 218-227) — spec: *Projects*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `title text NN`, `description text NN default ''`, `created_at`, `updated_at`, `deleted_at` (soft delete). Index `projects_user_idx(user_id)`. (V)

**project_scenes** (`schema.ts:332-343`; SQL 209-217) — spec: *Project Scenes*
- `id uuid PK`, `project_id uuid NN FK projects CASCADE`, `position int NN`, `title text NN`, `continuity jsonb NN default {}` (TS `ContinuityGuide`: lighting, framing, palette, characterReferenceId, notes), `created_at`.
- Index `scenes_project_idx(project_id, position)`. No unique constraint on `(project_id, position)`; ordering is maintained by code (`projects.ts:199-219`). Hard-deleted (`projects.ts:200`). (V)

**scene_versions** (`schema.ts:436-448`; SQL 239-248) — spec: *Scene Versions*
- `id uuid PK`, `scene_id uuid NN FK project_scenes CASCADE`, `job_id uuid NN FK generation_jobs CASCADE`, `parent_version_id uuid` (NO FK, self-reference),
  `branch_label text NN default 'main'`, `is_selected bool NN default false`, `created_at`.
- Index `scene_versions_scene_idx(scene_id)`, unique `scene_versions_job_uq(job_id)` (one version per job). Inserted on confirm (`service.ts:301-315`). (V)

**character_references** (`schema.ts:345-357`; SQL 23-32) — spec: *Character References*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `name text NN`, `asset_id uuid NN FK media_assets NO ACTION`,
  `consent_record_id uuid NN FK consent_records NO ACTION`, `created_at`, `deleted_at` (soft delete). Index `charrefs_user_idx(user_id)`. (V)

### Generation

**generation_jobs** (`schema.ts:374-417`; SQL 112-147) — spec: *Generation Jobs*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `idempotency_key text NN`, `status job_status NN default draft`, `mode generation_mode NN`,
  `model_key text NN`, `provider_key text NN`, `is_demo bool NN`, `template_id uuid FK templates SET NULL`, `template_version int`,
  `project_id uuid FK projects SET NULL`, `scene_id uuid FK project_scenes SET NULL`, `parent_job_id uuid` (NO FK, self-reference),
  `relation text` (TS `retry | variation | remix | continuation | extension`), `prompt text NN`, `negative_prompt text NN default ''`,
  `params jsonb NN` (TS `GenerationParams`), `input_asset_ids uuid[] NN default '{}'` (NO FK; array), `character_reference_id uuid FK character_references NO ACTION`,
  `cost_credits int NN`, `provider_job_id text`, `attempts int NN default 0`, `max_attempts int NN default 3`, `cancel_requested bool NN default false`,
  `failure_code text`, `failure_message text`, `queued_at`, `started_at`, `finished_at` (all timestamptz nullable), `created_at`, `updated_at`, `deleted_at` (soft delete).
- Unique `jobs_idempotency_uq(user_id, idempotency_key)`; indexes `jobs_user_created_idx(user_id, created_at)`, `jobs_status_idx(status)`, `jobs_scene_idx(scene_id)`;
  CHECK `jobs_cost_nonneg` (`cost_credits >= 0`).
- Draft insert uses `onConflictDoNothing()` on the idempotency index and returns the existing winner on a race (`service.ts:263-272`). (V)
- `status` enum includes `draft` even though the notes describe the machine as starting at `awaiting_confirmation`; `cancelJob` handles both (`service.ts:333`). (V)

**generation_outputs** (`schema.ts:419-434`; SQL 148-158 + migration 0001) — spec: *Generation Outputs*
- `id uuid PK`, `job_id uuid NN FK generation_jobs CASCADE`, `user_id uuid NN FK users CASCADE`, `asset_id uuid NN FK media_assets NO ACTION`,
  `poster_asset_id uuid FK media_assets NO ACTION` (added in 0001), `is_demo bool NN`, `quality_report jsonb NN default {}`, `created_at`, `deleted_at` (soft delete).
- Indexes `outputs_user_idx(user_id, created_at)`, `outputs_job_idx(job_id)`. (V)

**folders** (`schema.ts:450-459`; SQL 97-103) — spec: *Collections* ("folders" in Part II item 5)
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `name text NN`, `created_at`. Index `folders_user_idx(user_id)`. No soft delete. (V)

**folder_items** (`schema.ts:461-469`; SQL 90-96) — spec: *Collections* (join)
- `folder_id uuid NN FK folders CASCADE`, `output_id uuid NN FK generation_outputs CASCADE`, `created_at`. PK `(folder_id, output_id)`. Inserted with `onConflictDoNothing` (`src/server/folders.ts:28`). (V)

**saved_presets** (`schema.ts:471-484`; SQL 228-238) — spec: *Saved Presets*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `name text NN`, `mode generation_mode NN`, `model_key text NN`, `params jsonb NN`, `prompt text NN default ''`, `created_at`. Index `presets_user_idx(user_id)`. (V)

**model_configs** (`schema.ts:486-491`; SQL 175-181) — spec: *Model Configurations*
- `model_key text PK`, `enabled bool NN default true`, `price_multiplier_pct int NN default 100`, `updated_at`.
- Overrides only; the model catalogue itself is in code (`src/config/pricing.ts` per notes, `getModel()` in processor). Upserted by admin (`admin.ts:168`). (V)

### Money

**credit_accounts** (`schema.ts:495-504`; SQL 50-58) — spec: *Credit Accounts*
- `user_id uuid PK FK users CASCADE`, `available int NN default 0`, `reserved int NN default 0`, `updated_at`.
- CHECK `credits_available_nonneg` (`available >= 0`), CHECK `credits_reserved_nonneg` (`reserved >= 0`). (V)

**credit_ledger** (`schema.ts:506-523`; SQL 59-73) — spec: *Credit Ledger Entries*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `kind ledger_kind NN`, `available_delta int NN`, `reserved_delta int NN`,
  `available_after int NN`, `reserved_after int NN`, `job_id uuid FK generation_jobs SET NULL`, `payment_event_id uuid` (NO FK),
  `idempotency_key text NN`, `note text NN default ''`, `created_at`.
- Unique `ledger_idempotency_uq(idempotency_key)` (global, not per user); index `ledger_user_idx(user_id, created_at)`.
- Idempotency keys in use: `job:<id>:reserve`, `job:<id>:close` (shared by settle and release so a job closes exactly once, `ledger.ts:82-107`),
  `signup:<userId>`, `stripe:<eventId>`, `stripe-invoice:<invoiceId>`, `admin:<adminId>:<clientKey>`. (V)
- `payment_event_id` has no FK to `payment_events` though it is populated with `row.id` in `stripe.ts:106`. (V)

**subscriptions** (`schema.ts:525-538`; SQL 258-268) — spec: *Subscriptions*
- `id uuid PK`, `user_id uuid NN FK users CASCADE`, `plan_key text NN`, `status text NN` (free text, Stripe status strings), `provider_subscription_id text NN`,
  `current_period_end timestamptz`, `created_at`, `updated_at`.
- Unique `subscriptions_provider_uq(provider_subscription_id)`; index `subscriptions_user_idx(user_id)`. Upserted on checkout (`stripe.ts:111-114`). (V)

**payment_events** (`schema.ts:540-555`; SQL 196-208) — spec: *Payment Events*
- `id uuid PK`, `provider text NN`, `provider_event_id text NN`, `type text NN`, `user_id uuid FK users SET NULL`, `amount_cents int`, `currency text`,
  `credits int`, `processed_at timestamptz`, `created_at`.
- Unique `payment_events_provider_uq(provider, provider_event_id)`: the exactly-once guard. Insert with `onConflictDoNothing().returning()`; no row returned → `"duplicate"` (`stripe.ts:80-86`). `processed_at` set at `stripe.ts:154` inside the same transaction. (V)

### Trust and audit

**moderation_events** (`schema.ts:559-575`; SQL 182-195) — spec: *Moderation Events*
- `id uuid PK`, `subject_type text NN` (TS `template | prompt | upload | user | output`), `subject_id text NN` (polymorphic, NO FK), `action moderation_action NN`,
  `status moderation_status NN default open`, `reporter_id uuid FK users SET NULL`, `actor_id uuid FK users SET NULL`, `reason text NN`,
  `details jsonb NN default {}`, `created_at`, `resolved_at timestamptz`.
- Index `moderation_status_idx(status, created_at)`. (V)

**audit_logs** (`schema.ts:577-589`; SQL 13-22) — spec: *Audit Logs*
- `id uuid PK`, `actor_id uuid FK users SET NULL`, `action text NN`, `target_type text NN`, `target_id text NN`, `metadata jsonb NN default {}`, `created_at`.
- Indexes `audit_target_idx(target_type, target_id)`, `audit_time_idx(created_at)`. Written via `audit()` in `src/server/audit.ts:4-13`, which takes an optional `Tx` so the audit row commits with the action. (V)

## 3. Spec entities vs tables

All 29 entities named in spec Part VI (`spec.md:40`) mapped:

| Spec entity | Table(s) | Status |
| --- | --- | --- |
| Users | `users` | covered |
| User Profiles | `user_profiles` | covered |
| Sessions | `sessions` | covered |
| Creator Profiles | `creator_profiles` | covered (table exists; only `headline`/`share_analytics`, written only on first publish) |
| Templates | `templates` | covered |
| Template Versions | `template_versions` | covered |
| Template Categories | `template_categories` | covered |
| Favorites | `favorites` | covered (polymorphic, template or creation) |
| Followers | `follows` | covered |
| Generation Jobs | `generation_jobs` | covered |
| Generation Outputs | `generation_outputs` | covered |
| Media Assets | `media_assets` | covered |
| Uploads | `uploads` | covered |
| Collections | **no table named "collections"**. Covered by three things: `favorites` (saved templates / favourite creations), `folders` + `folder_items` (user folders of outputs), and `template_collections` + `template_collection_items` (creator-curated template lists, schema only, unused by any server code). The spec's "Living Collection" (Part II item 5) is a view over `generation_jobs`/`generation_outputs` + these tables, not a row type. (V) |
| Projects | `projects` | covered |
| Project Scenes | `project_scenes` | covered |
| Scene Versions | `scene_versions` | covered |
| Character References | `character_references` | covered |
| Model Configurations | `model_configs` | covered (overrides only; catalogue in code) |
| Saved Presets | `saved_presets` | covered |
| Subscriptions | `subscriptions` | covered |
| Credit Accounts | `credit_accounts` | covered |
| Credit Ledger Entries | `credit_ledger` | covered |
| Payment Events | `payment_events` | covered |
| Moderation Events | `moderation_events` | covered |
| Consent Records | `consent_records` | covered |
| User Preferences | `user_preferences` | covered |
| Discovery History | `discovery_events` | covered |
| Audit Logs | `audit_logs` | covered |

Tables with no named spec entity: `template_ratings` (Top Rated), `folders`/`folder_items` (Part II "folders"), `template_collections`/`template_collection_items`.

Spec items in Part II that have no dedicated table and are derived instead (I, based on the schema alone):
- "prompt history" → `generation_jobs.prompt` per job; no separate prompt-history table.
- "version comparison" / "timelines" → `scene_versions` joined to `generation_jobs`; `parent_job_id` chain in `generation_jobs`.
- "purchase history" (Part IX) → `payment_events` + `credit_ledger`.
- "Train section" (Part I) → `consent_kind.training_data` exists in the enum, but no training/dataset table and no code writes that kind (grep `training_data` in `src/`: schema only). (V)

## 4. Soft delete, cascade and retention summary

- Soft-delete columns (`deleted_at`): `users`, `media_assets`, `templates`, `projects`, `character_references`, `generation_jobs`, `generation_outputs`. (V)
- Withdrawal marker instead of delete: `consent_records.withdrawn_at`. (V)
- Hard-deleted by code: `sessions`, `favorites`, `follows`, `project_scenes`, `discovery_events` (on account delete), `folder_items`/`folders` (I: no deleted_at column exists). (V except where marked)
- `users.status = deleted` plus `deleted_at` and email rewritten to `deleted-<uuid>@invalid`, `password_hash = '!'` (`account.ts:157-163`). (V)
- DB-level cascade from `users` reaches: profiles, sessions, creator_profiles, preferences, consent_records, uploads, favorites, follows, collections, discovery_events, projects (→ scenes), character_references, generation_jobs (→ outputs, scene_versions), folders, presets, credit_accounts, credit_ledger, subscriptions. NOT cascaded (SET NULL): media_assets.owner_id, payment_events.user_id, moderation reporter/actor, audit actor, ledger.job_id. NO ACTION (would block a hard delete of users): `templates.creator_id`. (V)
- Columns that look like FKs but have none: `user_profiles.avatar_asset_id`, `templates.remixed_from_id`, `generation_jobs.parent_job_id`, `generation_jobs.input_asset_ids[]`, `scene_versions.parent_version_id`, `credit_ledger.payment_event_id`, `favorites.target_id`, `moderation_events.subject_id` (text), `audit_logs.target_id` (text). (V)
- Retention: media bytes purged after 30 days (`src/worker/index.ts:34` → `purgeDeletedMedia(30)`); immediate purge on consent withdrawal (`account.ts:149`) and on outputs discarded after a late cancel/timeout (`processor.ts:230`). No retention sweep for `generation_jobs`, `discovery_events`, `audit_logs` or expired `sessions`. (V)

## 5. Transactional patterns

Every `db.transaction` call in `src/` (21 sites, grep verified). Pattern names: **lock** = `SELECT ... FOR UPDATE`; **idem** = relies on a unique index + `onConflictDoNothing`.

| File:line | Function | What is atomic | Pattern |
| --- | --- | --- | --- |
| `src/server/credits/ledger.ts:29-69` | `lockAccount` / `applyMovement` (takes a `Tx`, never opens its own) | upsert account row, `FOR UPDATE` on `credit_accounts`, look up `credit_ledger.idempotency_key`, update balances, insert ledger row | lock + idem; the only place balances change (comment at line 36-40). Throws `InsufficientCreditsError` if available would go negative; the CHECK constraints are a second guard. |
| `src/server/auth/account.ts:56-88` | `registerUser` | insert users, user_profiles, user_preferences, credit_accounts, 2 consent_records, signup grant via `applyMovement`, audit | all-or-nothing signup; unique-index violations mapped to 409 `email_taken` / `handle_taken` outside the tx (lines 89-95). |
| `account.ts:112-147` | `withdrawConsent` | mark `withdrawn_at`, soft-delete dependent character_references, jobs (via `input_asset_ids && ` or `character_reference_id`), outputs, media_assets; audit | then `purgeAssetsNow` after commit. |
| `account.ts:157-168` | `deleteAccount` | anonymise user+profile, soft-delete media/outputs/jobs/templates, delete discovery_events, withdraw all consents, audit | sessions destroyed after commit. |
| `src/server/generation/service.ts:278-320` | `confirmJob` | `FOR UPDATE` job (owner-scoped), 409 on `cost_changed`, 429 on active-job cap, `reserveForJob`, status → queued, insert scene_version (idem on `job_id`), insert discovery_event | lock + idem; BullMQ enqueue happens after commit (line 321). |
| `service.ts:326-...` | `cancelJob` | `FOR UPDATE` job; draft/awaiting → cancelled; queued → `releaseJob` + cancelled; (processing path continues past the excerpt read) | lock |
| `service.ts:421-431` | `deleteJob` | soft-delete outputs, their assets and posters, the job; audit | |
| `src/server/generation/processor.ts:43-61` | `finishFailed` | `FOR UPDATE` job; only if still `processing`: `releaseJob`, status → failed/cancelled | lock; no-op if another writer closed it |
| `processor.ts:71-85` | `processJob` claim | `FOR UPDATE` job; only if `queued`: either release+cancel (cancel_requested) or status → processing, attempts+1 | lock; makes duplicate queue deliveries no-ops |
| `processor.ts:189-223` | `processJob` finish | `FOR UPDATE` job; if no longer processing → soft-delete just-written assets; if cancel_requested → release + cancelled; else insert outputs, `settleJob`, status → completed, bump `templates.generation_count` | lock; files written before the tx, purged after if discarded |
| `src/server/admin.ts:110-...` | `resolveReport` | `FOR UPDATE` moderation event; remove template or output (+asset), resolve all open events on the subject, insert resolution event | lock |
| `admin.ts:188-200` | `adjustCredits` | `applyMovement` (admin_adjust) + audit only if applied | idem via `admin:<adminId>:<key>` |
| `src/server/projects.ts:114-119` | `createProject` | project + first scene "Opening" | |
| `projects.ts:199-204` | `deleteScene` | delete scene, renumber positions | |
| `projects.ts:210-218` | `reorderScenes` | `FOR UPDATE` all scenes of the project, validate permutation (422), renumber | lock |
| `projects.ts:224-235` | `selectVersion` | verify version is completed (409 `not_ready`), clear then set `is_selected` | |
| `src/server/templates/publish.ts:83-130` | `publishTemplate` | insert public copy of asset (+poster), templates row, template_versions v1, promote role, upsert creator_profiles, audit | idem on `creator_profiles` |
| `publish.ts:156-192` | `updateTemplate` | optional new template_version, update templates (current_version), audit | |
| `publish.ts:197-210` | `rateTemplate` | raw SQL upsert on `template_ratings`, recompute `rating_sum`/`rating_count` from source rows | idem via composite PK |
| `src/server/media.ts:77-88` | `acceptUpload` | insert consent_record, media_assets, uploads | bytes stored before the tx (line 76) |
| `src/server/social.ts:15-21` | `setFavorite` | insert/delete favorite, recompute `templates.favorite_count` | idem via composite PK |
| `src/server/payments/stripe.ts:80-158` | `processStripeEvent` | insert payment_events (idem on provider+event id → "duplicate"), grant credits / upsert subscription / update status, set `processed_at`, audit | idem; throws (so Stripe retries) when an invoice arrives before its subscription row (line 128-131) |

Non-transactional writes worth noting (V): `setFollow` (`social.ts:28-29`) and `suspendUser` (`admin.ts:203-207`) are single statements; `audit()` without a `Tx` runs outside any transaction.

## 6. Observations and inferences

Verified:
1. The credit model is a two-bucket account (`available`, `reserved`) plus an append-only ledger with `*_after` snapshots. Every movement goes through `applyMovement` under a row lock, and the global unique `ledger_idempotency_uq` makes replays no-ops. Settle and release share the `job:<id>:close` key, so a job cannot be both charged and refunded.
2. Exactly-once Stripe handling rests on `payment_events_provider_uq` and the whole handler being one transaction.
3. The generation state machine is enforced by code (status checks after `FOR UPDATE`), not by DB constraints; there is no CHECK or trigger restricting status transitions.
4. Ownership is a column (`user_id`/`owner_id`/`creator_id`) on every user-facing table and is checked in queries (`eq(generationJobs.userId, user.id)`, etc.); there is no row-level security.
5. `template_collections` and `template_collection_items` exist in the schema and migration but no application code uses them.
6. Several logical references are intentionally or accidentally un-constrained (list in section 4); of these, `credit_ledger.payment_event_id` and `generation_jobs.parent_job_id` are populated by code and could carry FKs.
7. `subscriptions.status`, `favorites.target_type`, `discovery_events.event`, `moderation_events.subject_type`, `generation_jobs.relation` are `text` with TypeScript-only typing, not Postgres enums.

Inferences:
- `ledger_idempotency_uq` being global rather than `(user_id, idempotency_key)` is fine because every key embeds a job/user/event id; a client-chosen admin key is namespaced by `adminId`.
- The spec's "retention" requirement is met for media bytes only; metadata rows (jobs, outputs, discovery events, audit) have no expiry.
- `users.age_assurance_method` is always `"self_declaration"` at signup (`account.ts:62`); the column is shaped for stronger methods later.
