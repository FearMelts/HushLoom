-- Referential integrity for the five lineage/link columns that had none, and a nullable date of
-- birth so account deletion can erase it. Before each constraint, a reference that points at
-- nothing is cleared, so the migration applies to an existing database (the foreign keys use
-- ON DELETE SET NULL, which is what these UPDATEs do for rows that were already gone).
ALTER TABLE "users" ALTER COLUMN "date_of_birth" DROP NOT NULL;--> statement-breakpoint
UPDATE "users" SET "date_of_birth" = NULL WHERE "status" = 'deleted' AND "date_of_birth" IS NOT NULL;--> statement-breakpoint
UPDATE "credit_ledger" SET "payment_event_id" = NULL WHERE "payment_event_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "payment_events" p WHERE p."id" = "credit_ledger"."payment_event_id");--> statement-breakpoint
UPDATE "generation_jobs" SET "parent_job_id" = NULL WHERE "parent_job_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "generation_jobs" p WHERE p."id" = "generation_jobs"."parent_job_id");--> statement-breakpoint
UPDATE "scene_versions" SET "parent_version_id" = NULL WHERE "parent_version_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "scene_versions" p WHERE p."id" = "scene_versions"."parent_version_id");--> statement-breakpoint
UPDATE "templates" SET "remixed_from_id" = NULL WHERE "remixed_from_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "templates" p WHERE p."id" = "templates"."remixed_from_id");--> statement-breakpoint
UPDATE "user_profiles" SET "avatar_asset_id" = NULL WHERE "avatar_asset_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "media_assets" p WHERE p."id" = "user_profiles"."avatar_asset_id");--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payment_event_id_payment_events_id_fk" FOREIGN KEY ("payment_event_id") REFERENCES "public"."payment_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_parent_job_id_generation_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_versions" ADD CONSTRAINT "scene_versions_parent_version_id_scene_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."scene_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_remixed_from_id_templates_id_fk" FOREIGN KEY ("remixed_from_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatar_asset_id_media_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;
