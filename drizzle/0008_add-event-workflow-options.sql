ALTER TYPE "public"."organiser_slot" ADD VALUE 'cover';--> statement-breakpoint
ALTER TYPE "public"."organiser_status" ADD VALUE 'timed_out' BEFORE 'replaced';--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "signups_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "event_organiser_role_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "event_admin_channel_id" text;