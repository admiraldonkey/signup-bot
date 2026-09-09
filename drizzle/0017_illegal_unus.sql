CREATE TABLE "event_role_request_preset_applications" (
	"event_id" integer NOT NULL,
	"preset_id" integer NOT NULL,
	"applied_by_user_id" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_role_request_preset_applications_pk" PRIMARY KEY("event_id","preset_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_preset_group_options" (
	"group_id" integer NOT NULL,
	"preset_option_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "role_request_preset_group_options_pk" PRIMARY KEY("group_id","preset_option_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_preset_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_request_preset_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"preset_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"channel_id" text,
	"notify_role_id" text,
	"notify_role_name_snapshot" varchar(100),
	"requires_positive_signup" boolean DEFAULT false NOT NULL,
	"open_minutes_before_start" integer DEFAULT 60 NOT NULL,
	"close_minutes_before_start" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_request_preset_option_qualification_roles" (
	"preset_option_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name_snapshot" varchar(100) NOT NULL,
	"qualification_level" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_request_preset_option_qual_roles_pk" PRIMARY KEY("preset_option_id","discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_preset_options" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_request_preset_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"preset_id" integer NOT NULL,
	"key" varchar(64) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"description" text,
	"request_restriction" varchar(32) DEFAULT 'open' NOT NULL,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_request_presets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_request_presets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_guild_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_role_options" ADD COLUMN "source_role_request_preset_option_id" integer;--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD COLUMN "source_role_request_preset_group_id" integer;--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD COLUMN "notify_role_id" text;--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD COLUMN "notify_role_name_snapshot" varchar(100);--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD COLUMN "open_minutes_before_start" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_role_request_preset_applications" ADD CONSTRAINT "event_role_request_preset_applications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_role_request_preset_applications" ADD CONSTRAINT "event_role_request_preset_applications_preset_id_role_request_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."role_request_presets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_group_options" ADD CONSTRAINT "role_request_preset_group_options_group_id_role_request_preset_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."role_request_preset_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_group_options" ADD CONSTRAINT "role_request_preset_group_options_preset_option_id_role_request_preset_options_id_fk" FOREIGN KEY ("preset_option_id") REFERENCES "public"."role_request_preset_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_groups" ADD CONSTRAINT "role_request_preset_groups_preset_id_role_request_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."role_request_presets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_option_qualification_roles" ADD CONSTRAINT "role_request_preset_option_qualification_roles_preset_option_id_role_request_preset_options_id_fk" FOREIGN KEY ("preset_option_id") REFERENCES "public"."role_request_preset_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_options" ADD CONSTRAINT "role_request_preset_options_preset_id_role_request_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."role_request_presets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_presets" ADD CONSTRAINT "role_request_presets_owner_guild_id_discord_guilds_id_fk" FOREIGN KEY ("owner_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_role_request_preset_applications_preset_idx" ON "event_role_request_preset_applications" USING btree ("preset_id");--> statement-breakpoint
CREATE INDEX "role_request_preset_group_options_group_idx" ON "role_request_preset_group_options" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "role_request_preset_group_options_option_idx" ON "role_request_preset_group_options" USING btree ("preset_option_id");--> statement-breakpoint
CREATE INDEX "role_request_preset_groups_preset_idx" ON "role_request_preset_groups" USING btree ("preset_id");--> statement-breakpoint
CREATE INDEX "role_request_preset_option_qualification_idx" ON "role_request_preset_option_qualification_roles" USING btree ("preset_option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_request_preset_options_preset_key_unique" ON "role_request_preset_options" USING btree ("preset_id","key");--> statement-breakpoint
CREATE INDEX "role_request_preset_options_preset_idx" ON "role_request_preset_options" USING btree ("preset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_request_presets_owner_name_unique" ON "role_request_presets" USING btree ("owner_guild_id","name");--> statement-breakpoint
CREATE INDEX "role_request_presets_owner_guild_idx" ON "role_request_presets" USING btree ("owner_guild_id");--> statement-breakpoint
ALTER TABLE "event_role_options" ADD CONSTRAINT "event_role_options_source_role_request_preset_option_id_role_request_preset_options_id_fk" FOREIGN KEY ("source_role_request_preset_option_id") REFERENCES "public"."role_request_preset_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD CONSTRAINT "role_request_groups_source_role_request_preset_group_id_role_request_preset_groups_id_fk" FOREIGN KEY ("source_role_request_preset_group_id") REFERENCES "public"."role_request_preset_groups"("id") ON DELETE set null ON UPDATE no action;