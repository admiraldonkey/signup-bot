CREATE TABLE "actual_attendance_records" (
	"event_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name_snapshot" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actual_attendance_records_event_id_discord_user_id_pk" PRIMARY KEY("event_id","discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "event_attendance_reports" (
	"event_id" integer PRIMARY KEY NOT NULL,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"recorded_by_user_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actual_attendance_records" ADD CONSTRAINT "actual_attendance_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_reports" ADD CONSTRAINT "event_attendance_reports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actual_attendance_user_idx" ON "actual_attendance_records" USING btree ("discord_user_id");--> statement-breakpoint
CREATE INDEX "actual_attendance_event_idx" ON "actual_attendance_records" USING btree ("event_id");