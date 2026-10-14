-- The SHA-256 of every file an actioned takedown removed, so the same bytes cannot be published
-- again (regenerated with the same seed, retried, or made by another account), and an index to
-- find copies of one file by its bytes.
CREATE TABLE "taken_down_hashes" (
	"sha256" text PRIMARY KEY NOT NULL,
	"takedown_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "taken_down_hashes" ADD CONSTRAINT "taken_down_hashes_takedown_id_takedown_requests_id_fk" FOREIGN KEY ("takedown_id") REFERENCES "public"."takedown_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_sha256_idx" ON "media_assets" USING btree ("sha256");