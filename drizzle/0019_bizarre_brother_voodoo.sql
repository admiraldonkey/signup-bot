ALTER TYPE "public"."event_message_kind" ADD VALUE 'organiser_cover';--> statement-breakpoint
ALTER TYPE "public"."event_message_kind" ADD VALUE 'organiser_missing_at_start';--> statement-breakpoint
ALTER TABLE "event_messages" ADD COLUMN "resolved_at" timestamp with time zone;