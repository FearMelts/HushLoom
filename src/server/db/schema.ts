import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

export const userRole = pgEnum("user_role", ["member", "creator", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "suspended", "deleted"]);
export const mediaKind = pgEnum("media_kind", ["image", "video"]);
export const visibility = pgEnum("visibility", ["private", "public"]);
export const templateStatus = pgEnum("template_status", ["draft", "published", "unpublished", "removed"]);
export const generationMode = pgEnum("generation_mode", [
  "text_to_image",
  "image_to_image",
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "video_extension",
  "scene_continuation",
  "reference_guided",
]);
export const jobStatus = pgEnum("job_status", [
  "draft",
  "awaiting_confirmation",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);
export const ledgerKind = pgEnum("ledger_kind", [
  "signup_grant",
  "purchase",
  "subscription_grant",
  "reserve",
  "release",
  "settle",
  "admin_adjust",
  "refund",
  "chargeback",
]);
export const ageVerificationStatus = pgEnum("age_verification_status", ["unverified", "pending", "verified", "failed", "expired"]);
export const scanStatus = pgEnum("scan_status", ["pending", "clean", "matched", "unavailable"]);
export const accountFlagKind = pgEnum("account_flag_kind", ["chargeback", "csam_match", "manual_review", "credit_debt"]);
export const takedownStatus = pgEnum("takedown_status", ["open", "actioned", "dismissed"]);
export const consentKind = pgEnum("consent_kind", [
  "terms",
  "adult_attestation",
  "upload_subject",
  "likeness",
  "training_data",
]);
export const moderationAction = pgEnum("moderation_action", ["report", "auto_block", "approve", "remove", "dismiss", "hold", "escalate"]);
export const moderationStatus = pgEnum("moderation_status", ["open", "resolved"]);
export const uploadPurpose = pgEnum("upload_purpose", ["source", "reference", "avatar", "template_media"]);

// ── Identity ────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("member"),
    status: userStatus("status").notNull().default("active"),
    /** Nulled when the account is deleted (migration 0003); every live account has one from signup. */
    dateOfBirth: date("date_of_birth"),
    ageAssuranceMethod: text("age_assurance_method").notNull(),
    ageAssuredAt: timestamp("age_assured_at", { withTimezone: true }).notNull(),
    /** Provider-backed age verification (addendum §2). `self_declaration` above is only step one. */
    ageVerificationStatus: ageVerificationStatus("age_verification_status").notNull().default("unverified"),
    ageVerifiedAt: timestamp("age_verified_at", { withTimezone: true }),
    ageVerificationProvider: text("age_verification_provider"),
    /** Jurisdiction captured from the edge headers at signup / last sign-in, e.g. "GB" or "US-TX". */
    jurisdiction: text("jurisdiction"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    avatarAssetId: uuid("avatar_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("user_profiles_handle_uq").on(sql`lower(${t.handle})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const creatorProfiles = pgTable("creator_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  headline: text("headline").notNull().default(""),
  shareAnalytics: boolean("share_analytics").notNull().default(false),
  createdAt: createdAt(),
});

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  personalizationEnabled: boolean("personalization_enabled").notNull().default(true),
  historyEnabled: boolean("history_enabled").notNull().default(true),
  autoplayPreviews: boolean("autoplay_previews").notNull().default(false),
  copilotEnabled: boolean("copilot_enabled").notNull().default(true),
  interests: text("interests").array().notNull().default(sql`'{}'::text[]`),
  /** Opt-in push notification when a generation finishes or fails (addendum §4). */
  notifyOnFinish: boolean("notify_on_finish").notNull().default(false),
  updatedAt: updatedAt(),
});

export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: consentKind("kind").notNull(),
    statement: text("statement").notNull(),
    subjectLabel: text("subject_label"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [index("consent_user_idx").on(t.userId, t.kind)],
);

// ── Media ───────────────────────────────────────────────────────────────────

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    kind: mediaKind("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    sha256: text("sha256").notNull(),
    visibility: visibility("visibility").notNull().default("private"),
    /** Abuse scan (addendum §3). Fail closed: only `clean` assets are ever served or published. */
    scanStatus: scanStatus("scan_status").notNull().default("pending"),
    scanProvider: text("scan_provider"),
    scanRef: text("scan_ref"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    /** Evidence preserved for a report; purge and deletion skip held assets. */
    legalHold: boolean("legal_hold").notNull().default(false),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("media_storage_key_uq").on(t.storageKey), index("media_owner_idx").on(t.ownerId), index("media_scan_idx").on(t.scanStatus)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    purpose: uploadPurpose("purpose").notNull(),
    consentRecordId: uuid("consent_record_id").references(() => consentRecords.id),
    createdAt: createdAt(),
  },
  (t) => [index("uploads_user_idx").on(t.userId)],
);

// ── Templates & community ───────────────────────────────────────────────────

export const templateCategories = pgTable("template_categories", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  sortOrder: smallint("sort_order").notNull().default(0),
});

export const templates = pgTable(
  "templates",
  {
    id: id(),
    slug: text("slug").notNull(),
    creatorId: uuid("creator_id").notNull().references(() => users.id),
    categoryId: uuid("category_id").references(() => templateCategories.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    mediaType: mediaKind("media_type").notNull(),
    mode: generationMode("mode").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    status: templateStatus("status").notNull().default("draft"),
    isVip: boolean("is_vip").notNull().default(false),
    quality: text("quality").notNull().default("hd"),
    durationS: smallint("duration_s"),
    posterAssetId: uuid("poster_asset_id").references(() => mediaAssets.id),
    previewAssetId: uuid("preview_asset_id").references(() => mediaAssets.id),
    currentVersion: integer("current_version").notNull().default(1),
    remixedFromId: uuid("remixed_from_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
    favoriteCount: integer("favorite_count").notNull().default(0),
    generationCount: integer("generation_count").notNull().default(0),
    ratingSum: integer("rating_sum").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("templates_slug_uq").on(t.slug),
    index("templates_status_pub_idx").on(t.status, t.publishedAt),
    index("templates_creator_idx").on(t.creatorId),
    index("templates_category_idx").on(t.categoryId),
  ],
);

export const templateVersions = pgTable(
  "template_versions",
  {
    id: id(),
    templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull().default(""),
    modelKey: text("model_key").notNull(),
    defaults: jsonb("defaults").$type<Record<string, unknown>>().notNull(),
    changelog: text("changelog").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("template_versions_uq").on(t.templateId, t.version)],
);

export const templateRatings = pgTable(
  "template_ratings",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    score: smallint("score").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.templateId] }), check("rating_range", sql`${t.score} between 1 and 5`)],
);

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<"template" | "creation">().notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.targetType, t.targetId] }), index("favorites_target_idx").on(t.targetType, t.targetId)],
);

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    creatorId: uuid("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.creatorId] }), index("follows_creator_idx").on(t.creatorId), check("no_self_follow", sql`${t.followerId} <> ${t.creatorId}`)],
);

export const templateCollections = pgTable(
  "template_collections",
  {
    id: id(),
    creatorId: uuid("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    isPublic: boolean("is_public").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("template_collections_creator_idx").on(t.creatorId)],
);

export const templateCollectionItems = pgTable(
  "template_collection_items",
  {
    collectionId: uuid("collection_id").notNull().references(() => templateCollections.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.templateId] })],
);

export const discoveryEvents = pgTable(
  "discovery_events",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    event: text("event").$type<"view" | "generate">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("discovery_user_time_idx").on(t.userId, t.createdAt)],
);

// ── Projects & continuity ───────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

export type ContinuityGuide = {
  lighting?: string;
  framing?: string;
  palette?: string;
  characterReferenceId?: string;
  notes?: string;
};

export const projectScenes = pgTable(
  "project_scenes",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    continuity: jsonb("continuity").$type<ContinuityGuide>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("scenes_project_idx").on(t.projectId, t.position)],
);

export const characterReferences = pgTable(
  "character_references",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    assetId: uuid("asset_id").notNull().references(() => mediaAssets.id),
    consentRecordId: uuid("consent_record_id").notNull().references(() => consentRecords.id),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("charrefs_user_idx").on(t.userId)],
);

// ── Generation ──────────────────────────────────────────────────────────────

export type GenerationParams = {
  aspectRatio?: string;
  durationS?: number;
  quality?: "hd" | "4k";
  motionIntensity?: number;
  cameraMovement?: string;
  pacing?: string;
  atmosphere?: string;
  lighting?: string;
  framing?: string;
  seed?: number;
};

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: jobStatus("status").notNull().default("draft"),
    mode: generationMode("mode").notNull(),
    modelKey: text("model_key").notNull(),
    providerKey: text("provider_key").notNull(),
    isDemo: boolean("is_demo").notNull(),
    templateId: uuid("template_id").references(() => templates.id, { onDelete: "set null" }),
    templateVersion: integer("template_version"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    sceneId: uuid("scene_id").references(() => projectScenes.id, { onDelete: "set null" }),
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => generationJobs.id, { onDelete: "set null" }),
    relation: text("relation").$type<"retry" | "variation" | "remix" | "continuation" | "extension">(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull().default(""),
    params: jsonb("params").$type<GenerationParams>().notNull(),
    inputAssetIds: uuid("input_asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    characterReferenceId: uuid("character_reference_id").references(() => characterReferences.id),
    costCredits: integer("cost_credits").notNull(),
    providerJobId: text("provider_job_id"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_uq").on(t.userId, t.idempotencyKey),
    index("jobs_user_created_idx").on(t.userId, t.createdAt),
    index("jobs_status_idx").on(t.status),
    index("jobs_scene_idx").on(t.sceneId),
    check("jobs_cost_nonneg", sql`${t.costCredits} >= 0`),
  ],
);

export const generationOutputs = pgTable(
  "generation_outputs",
  {
    id: id(),
    jobId: uuid("job_id").notNull().references(() => generationJobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => mediaAssets.id),
    /** A still frame for video outputs, so grids never have to download or decode the clip. */
    posterAssetId: uuid("poster_asset_id").references(() => mediaAssets.id),
    isDemo: boolean("is_demo").notNull(),
    qualityReport: jsonb("quality_report").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("outputs_user_idx").on(t.userId, t.createdAt), index("outputs_job_idx").on(t.jobId)],
);

export const sceneVersions = pgTable(
  "scene_versions",
  {
    id: id(),
    sceneId: uuid("scene_id").notNull().references(() => projectScenes.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => generationJobs.id, { onDelete: "cascade" }),
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => sceneVersions.id, { onDelete: "set null" }),
    branchLabel: text("branch_label").notNull().default("main"),
    isSelected: boolean("is_selected").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("scene_versions_scene_idx").on(t.sceneId), uniqueIndex("scene_versions_job_uq").on(t.jobId)],
);

export const folders = pgTable(
  "folders",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("folders_user_idx").on(t.userId)],
);

export const folderItems = pgTable(
  "folder_items",
  {
    folderId: uuid("folder_id").notNull().references(() => folders.id, { onDelete: "cascade" }),
    outputId: uuid("output_id").notNull().references(() => generationOutputs.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.outputId] })],
);

export const savedPresets = pgTable(
  "saved_presets",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: generationMode("mode").notNull(),
    modelKey: text("model_key").notNull(),
    params: jsonb("params").$type<GenerationParams>().notNull(),
    prompt: text("prompt").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("presets_user_idx").on(t.userId)],
);

export const modelConfigs = pgTable("model_configs", {
  modelKey: text("model_key").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  priceMultiplier: integer("price_multiplier_pct").notNull().default(100),
  updatedAt: updatedAt(),
});

// ── Money ───────────────────────────────────────────────────────────────────

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    available: integer("available").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check("credits_available_nonneg", sql`${t.available} >= 0`), check("credits_reserved_nonneg", sql`${t.reserved} >= 0`)],
);

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: ledgerKind("kind").notNull(),
    availableDelta: integer("available_delta").notNull(),
    reservedDelta: integer("reserved_delta").notNull(),
    availableAfter: integer("available_after").notNull(),
    reservedAfter: integer("reserved_after").notNull(),
    jobId: uuid("job_id").references(() => generationJobs.id, { onDelete: "set null" }),
    paymentEventId: uuid("payment_event_id").references(() => paymentEvents.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ledger_idempotency_uq").on(t.idempotencyKey), index("ledger_user_idx").on(t.userId, t.createdAt)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planKey: text("plan_key").notNull(),
    status: text("status").notNull(),
    provider: text("provider").notNull().default("stripe"),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_provider_uq").on(t.providerSubscriptionId), index("subscriptions_user_idx").on(t.userId)],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    credits: integer("credits"),
    /** The processor's transaction id, so a refund or chargeback can find the purchase it reverses. */
    transactionRef: text("transaction_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payment_events_provider_uq").on(t.provider, t.providerEventId), index("payment_events_txn_idx").on(t.provider, t.transactionRef)],
);

// ── Trust & audit ───────────────────────────────────────────────────────────

export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: id(),
    subjectType: text("subject_type").$type<"template" | "prompt" | "upload" | "user" | "output">().notNull(),
    subjectId: text("subject_id").notNull(),
    action: moderationAction("action").notNull(),
    status: moderationStatus("status").notNull().default("open"),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("moderation_status_idx").on(t.status, t.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_target_idx").on(t.targetType, t.targetId), index("audit_time_idx").on(t.createdAt)],
);

// ── Launch-readiness additions (2026-10-12 addendum) ────────────────────────

/** One row per verification attempt with an age-verification provider. Never stores ID images or biometrics. */
export const ageVerifications = pgTable(
  "age_verifications",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: ageVerificationStatus("status").notNull().default("pending"),
    /** The provider's own reference for this check; the only thing we keep from their side. */
    providerRef: text("provider_ref"),
    /** The method the provider reports (e.g. "document", "facial_age_estimation", "sandbox"). */
    method: text("method"),
    jurisdiction: text("jurisdiction"),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("age_verifications_user_idx").on(t.userId, t.createdAt), uniqueIndex("age_verifications_provider_ref_uq").on(t.provider, t.providerRef)],
);

/** Flags that restrict an account (chargeback, abuse match, manual review) until cleared by an admin. */
export const accountFlags = pgTable(
  "account_flags",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: accountFlagKind("kind").notNull(),
    reason: text("reason").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: uuid("cleared_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("account_flags_user_idx").on(t.userId, t.clearedAt)],
);

/** Requests to remove content (nonconsensual intimate imagery, abuse, other), from members or outsiders. */
export const takedownRequests = pgTable(
  "takedown_requests",
  {
    id: id(),
    requesterId: uuid("requester_id").references(() => users.id, { onDelete: "set null" }),
    requesterEmail: text("requester_email"),
    targetType: text("target_type").$type<"output" | "template" | "asset" | "url">().notNull(),
    targetRef: text("target_ref").notNull(),
    category: text("category").$type<"ncii" | "csam" | "likeness" | "copyright" | "other">().notNull(),
    details: text("details").notNull().default(""),
    status: takedownStatus("status").notNull().default("open"),
    resolutionNote: text("resolution_note").notNull().default(""),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("takedown_status_idx").on(t.status, t.createdAt)],
);

/** Web Push subscriptions, one per browser/device; removed when that session signs out. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);
