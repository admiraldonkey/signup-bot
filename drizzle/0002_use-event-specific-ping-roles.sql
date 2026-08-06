CREATE TABLE "event_ping_roles" (
	"event_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_ping_roles_event_id_discord_role_id_pk" PRIMARY KEY("event_id","discord_role_id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "show_detailed_deadline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_ping_roles" ADD CONSTRAINT "event_ping_roles_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_ping_roles_event_idx" ON "event_ping_roles" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "event_audiences" DROP COLUMN "ping_role_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "ping_role_id";