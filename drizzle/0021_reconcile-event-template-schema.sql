CREATE TABLE "event_template_organiser_defaults" (
	"template_id" integer NOT NULL,
	"slot" varchar(16) NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name_snapshot" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evt_tpl_org_defaults_pk" PRIMARY KEY("template_id","slot"),
	CONSTRAINT "evt_tpl_org_slot_chk" CHECK ("event_template_organiser_defaults"."slot" in ('primary', 'backup'))
);
--> statement-breakpoint
CREATE TABLE "event_template_ping_roles" (
	"template_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name_snapshot" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evt_tpl_ping_roles_pk" PRIMARY KEY("template_id","discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "event_template_reminders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_template_reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"template_id" integer NOT NULL,
	"timing_reference" varchar(32) NOT NULL,
	"minutes_before" integer NOT NULL,
	"message" text NOT NULL,
	"channel_id" text,
	"ping_event_roles" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_role_options" DROP CONSTRAINT "event_role_options_source_template_role_option_id_template_role_options_id_fk";--> statement-breakpoint
ALTER TABLE "template_role_options" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "template_role_options";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_template_id_event_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "event_templates" ALTER COLUMN "duration_minutes" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "event_templates" ALTER COLUMN "duration_minutes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "audience_id" integer;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "role_request_preset_id" integer;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "signups_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "show_detailed_deadline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "publication_mode" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "publish_minutes_before_start" integer;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "publication_channel_id" text;--> statement-breakpoint
ALTER TABLE "event_templates" ADD COLUMN "created_by_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "event_template_organiser_defaults" ADD CONSTRAINT "evt_tpl_org_tpl_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_template_ping_roles" ADD CONSTRAINT "evt_tpl_ping_roles_tpl_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_template_reminders" ADD CONSTRAINT "evt_tpl_reminders_tpl_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evt_tpl_org_user_uq" ON "event_template_organiser_defaults" USING btree ("template_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "evt_tpl_ping_roles_order_idx" ON "event_template_ping_roles" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE INDEX "evt_tpl_reminders_tpl_idx" ON "event_template_reminders" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "evt_tpl_audience_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."event_audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "evt_tpl_preset_fk" FOREIGN KEY ("role_request_preset_id") REFERENCES "public"."role_request_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_template_id_event_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evt_tpl_audience_idx" ON "event_templates" USING btree ("audience_id");--> statement-breakpoint
CREATE INDEX "evt_tpl_preset_idx" ON "event_templates" USING btree ("role_request_preset_id");--> statement-breakpoint
ALTER TABLE "event_role_options" DROP COLUMN "source_template_role_option_id";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "recurrence_rule";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "attendance_open_minutes_before";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "role_requests_open_minutes_before";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "attendance_channel_id";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "role_request_channel_id";--> statement-breakpoint
ALTER TABLE "event_templates" DROP COLUMN "ping_role_id";--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "evt_tpl_pub_mode_chk" CHECK ("event_templates"."publication_mode" in ('manual', 'scheduled', 'immediate'));--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "evt_tpl_pub_offset_chk" CHECK ((
        ("event_templates"."publication_mode" = 'scheduled'
          and "event_templates"."publish_minutes_before_start" is not null)
        or
        ("event_templates"."publication_mode" <> 'scheduled'
          and "event_templates"."publish_minutes_before_start" is null)
      ));