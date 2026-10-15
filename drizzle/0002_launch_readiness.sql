CREATE TYPE "public"."account_flag_kind" AS ENUM('chargeback', 'csam_match', 'manual_review', 'credit_debt');--> statement-breakpoint
CREATE TYPE "public"."age_verification_status" AS ENUM('unverified', 'pending', 'verified', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'clean', 'matched', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."takedown_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" ADD VALUE 'refund';--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" ADD VALUE 'chargeback';--> statement-breakpoint
ALTER TYPE "public"."moderation_action" ADD VALUE 'hold';--> statement-breakpoint
ALTER TYPE "public"."moderation_action" ADD VALUE 'escalate';--> statement-breakpoint
CREATE TABLE "account_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "account_flag_kind" NOT NULL,
	"reason" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid
);
--> statement-breakpoint
CREATE TABLE "age_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "age_verification_status" DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"method" text,
	"jurisdiction" text,
	"failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "takedown_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"requester_email" text,
	"target_type" text NOT NULL,
	"target_ref" text NOT NULL,
	"category" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "takedown_status" DEFAULT 'open' NOT NULL,
	"resolution_note" text DEFAULT '' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scan_status" "scan_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scan_provider" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scan_ref" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "transaction_ref" text;--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_customer_id" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "notify_on_finish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_verification_status" "age_verification_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_verification_provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "account_flags" ADD CONSTRAINT "account_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_flags" ADD CONSTRAINT "account_flags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_flags" ADD CONSTRAINT "account_flags_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD CONSTRAINT "takedown_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD CONSTRAINT "takedown_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_flags_user_idx" ON "account_flags" USING btree ("user_id","cleared_at");--> statement-breakpoint
CREATE INDEX "age_verifications_user_idx" ON "age_verifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "age_verifications_provider_ref_uq" ON "age_verifications" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "takedown_status_idx" ON "takedown_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_scan_idx" ON "media_assets" USING btree ("scan_status");--> statement-breakpoint
CREATE INDEX "payment_events_txn_idx" ON "payment_events" USING btree ("provider","transaction_ref");