ALTER TABLE "event_organiser_assignments" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_organiser_assignments" ADD COLUMN "response_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "organiser_primary_response_minutes" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "organiser_backup_response_minutes" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "organiser_warning_minutes_before" integer DEFAULT 15 NOT NULL;
UPDATE "event_organiser_assignments"
SET "activated_at" = "assigned_at"
WHERE "slot" = 'primary'
  AND "is_current" = true;