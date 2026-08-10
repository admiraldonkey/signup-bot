ALTER TABLE "event_reminders" ADD COLUMN "missed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD COLUMN "missed_reason" text;