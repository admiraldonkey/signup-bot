CREATE TYPE "public"."organiser_slot" AS ENUM('primary', 'backup');--> statement-breakpoint
CREATE TYPE "public"."organiser_status" AS ENUM('pending', 'confirmed', 'declined', 'replaced', 'removed');--> statement-breakpoint
CREATE TABLE "event_organiser_assignments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_organiser_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"slot" "organiser_slot" NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name_snapshot" varchar(100) NOT NULL,
	"status" "organiser_status" DEFAULT 'pending' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"assigned_by_user_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_organiser_assignments" ADD CONSTRAINT "event_organiser_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_organiser_assignments_event_idx" ON "event_organiser_assignments" USING btree ("event_id","is_current");--> statement-breakpoint
CREATE INDEX "event_organiser_assignments_user_idx" ON "event_organiser_assignments" USING btree ("discord_user_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "event_organiser_assignments_current_slot_unique" ON "event_organiser_assignments" USING btree ("event_id","slot") WHERE "event_organiser_assignments"."is_current" = true;