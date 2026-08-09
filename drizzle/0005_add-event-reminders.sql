CREATE TABLE "event_reminders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"timing_reference" varchar(32) NOT NULL,
	"minutes_before" integer NOT NULL,
	"message" text NOT NULL,
	"channel_id" text NOT NULL,
	"ping_event_roles" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_reminders_event_idx" ON "event_reminders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_reminders_enabled_idx" ON "event_reminders" USING btree ("event_id","enabled");