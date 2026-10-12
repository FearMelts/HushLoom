CREATE TYPE "public"."consent_kind" AS ENUM('terms', 'adult_attestation', 'upload_subject', 'likeness', 'training_data');--> statement-breakpoint
CREATE TYPE "public"."generation_mode" AS ENUM('text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'video_to_video', 'video_extension', 'scene_continuation', 'reference_guided');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('draft', 'awaiting_confirmation', 'queued', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('signup_grant', 'purchase', 'subscription_grant', 'reserve', 'release', 'settle', 'admin_adjust');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."moderation_action" AS ENUM('report', 'auto_block', 'approve', 'remove', 'dismiss');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."template_status" AS ENUM('draft', 'published', 'unpublished', 'removed');--> statement-breakpoint
CREATE TYPE "public"."upload_purpose" AS ENUM('source', 'reference', 'avatar', 'template_media');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('member', 'creator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"statement" text NOT NULL,
	"subject_label" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "creator_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"share_analytics" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credits_available_nonneg" CHECK ("credit_accounts"."available" >= 0),
	CONSTRAINT "credits_reserved_nonneg" CHECK ("credit_accounts"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"available_delta" integer NOT NULL,
	"reserved_delta" integer NOT NULL,
	"available_after" integer NOT NULL,
	"reserved_after" integer NOT NULL,
	"job_id" uuid,
	"payment_event_id" uuid,
	"idempotency_key" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_target_type_target_id_pk" PRIMARY KEY("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "folder_items" (
	"folder_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_items_folder_id_output_id_pk" PRIMARY KEY("folder_id","output_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_creator_id_pk" PRIMARY KEY("follower_id","creator_id"),
	CONSTRAINT "no_self_follow" CHECK ("follows"."follower_id" <> "follows"."creator_id")
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "job_status" DEFAULT 'draft' NOT NULL,
	"mode" "generation_mode" NOT NULL,
	"model_key" text NOT NULL,
	"provider_key" text NOT NULL,
	"is_demo" boolean NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"project_id" uuid,
	"scene_id" uuid,
	"parent_job_id" uuid,
	"relation" text,
	"prompt" text NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"params" jsonb NOT NULL,
	"input_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"character_reference_id" uuid,
	"cost_credits" integer NOT NULL,
	"provider_job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "jobs_cost_nonneg" CHECK ("generation_jobs"."cost_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "generation_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"is_demo" boolean NOT NULL,
	"quality_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"kind" "media_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"sha256" text NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"model_key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"price_multiplier_pct" integer DEFAULT 100 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" "moderation_action" NOT NULL,
	"status" "moderation_status" DEFAULT 'open' NOT NULL,
	"reporter_id" uuid,
	"actor_id" uuid,
	"reason" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"user_id" uuid,
	"amount_cents" integer,
	"currency" text,
	"credits" integer,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"continuity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "saved_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "generation_mode" NOT NULL,
	"model_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"parent_version_id" uuid,
	"branch_label" text DEFAULT 'main' NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "template_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "template_collection_items" (
	"collection_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "template_collection_items_collection_id_template_id_pk" PRIMARY KEY("collection_id","template_id")
);
--> statement-breakpoint
CREATE TABLE "template_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_ratings" (
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_ratings_user_id_template_id_pk" PRIMARY KEY("user_id","template_id"),
	CONSTRAINT "rating_range" CHECK ("template_ratings"."score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"model_key" text NOT NULL,
	"defaults" jsonb NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"category_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"media_type" "media_kind" NOT NULL,
	"mode" "generation_mode" NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "template_status" DEFAULT 'draft' NOT NULL,
	"is_vip" boolean DEFAULT false NOT NULL,
	"quality" text DEFAULT 'hd' NOT NULL,
	"duration_s" smallint,
	"poster_asset_id" uuid,
	"preview_asset_id" uuid,
	"current_version" integer DEFAULT 1 NOT NULL,
	"remixed_from_id" uuid,
	"favorite_count" integer DEFAULT 0 NOT NULL,
	"generation_count" integer DEFAULT 0 NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"purpose" "upload_purpose" NOT NULL,
	"consent_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"personalization_enabled" boolean DEFAULT true NOT NULL,
	"history_enabled" boolean DEFAULT true NOT NULL,
	"autoplay_previews" boolean DEFAULT false NOT NULL,
	"copilot_enabled" boolean DEFAULT true NOT NULL,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"avatar_asset_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"date_of_birth" date NOT NULL,
	"age_assurance_method" text NOT NULL,
	"age_assured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_events" ADD CONSTRAINT "discovery_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_events" ADD CONSTRAINT "discovery_events_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_items" ADD CONSTRAINT "folder_items_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_items" ADD CONSTRAINT "folder_items_output_id_generation_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."generation_outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_scene_id_project_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."project_scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_character_reference_id_character_references_id_fk" FOREIGN KEY ("character_reference_id") REFERENCES "public"."character_references"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scenes" ADD CONSTRAINT "project_scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_presets" ADD CONSTRAINT "saved_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_versions" ADD CONSTRAINT "scene_versions_scene_id_project_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."project_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_versions" ADD CONSTRAINT "scene_versions_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_collection_items" ADD CONSTRAINT "template_collection_items_collection_id_template_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."template_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_collection_items" ADD CONSTRAINT "template_collection_items_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_collections" ADD CONSTRAINT "template_collections_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_ratings" ADD CONSTRAINT "template_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_ratings" ADD CONSTRAINT "template_ratings_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_category_id_template_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."template_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_poster_asset_id_media_assets_id_fk" FOREIGN KEY ("poster_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_preview_asset_id_media_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_time_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "charrefs_user_idx" ON "character_references" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consent_user_idx" ON "consent_records" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_idempotency_uq" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "discovery_user_time_idx" ON "discovery_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "favorites_target_idx" ON "favorites" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "folders_user_idx" ON "folders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "follows_creator_idx" ON "follows" USING btree ("creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_uq" ON "generation_jobs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_user_created_idx" ON "generation_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_scene_idx" ON "generation_jobs" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "outputs_user_idx" ON "generation_outputs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outputs_job_idx" ON "generation_outputs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key_uq" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media_assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "moderation_status_idx" ON "moderation_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_uq" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "scenes_project_idx" ON "project_scenes" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "presets_user_idx" ON "saved_presets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scene_versions_scene_idx" ON "scene_versions" USING btree ("scene_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scene_versions_job_uq" ON "scene_versions" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_uq" ON "subscriptions" USING btree ("provider_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "template_collections_creator_idx" ON "template_collections" USING btree ("creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_uq" ON "template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_slug_uq" ON "templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "templates_status_pub_idx" ON "templates" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "templates_creator_idx" ON "templates" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "templates_category_idx" ON "templates" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "uploads_user_idx" ON "uploads" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_handle_uq" ON "user_profiles" USING btree (lower("handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));