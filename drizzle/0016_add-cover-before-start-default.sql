ALTER TABLE "guild_settings" ALTER COLUMN "organiser_primary_response_minutes" SET DEFAULT 70;--> statement-breakpoint
ALTER TABLE "guild_settings" ALTER COLUMN "organiser_backup_response_minutes" SET DEFAULT 35;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "organiser_cover_before_start_minutes" integer DEFAULT 15 NOT NULL;