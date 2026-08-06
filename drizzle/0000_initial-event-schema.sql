CREATE TYPE "public"."attendance_status" AS ENUM('attending', 'tentative', 'not_attending');--> statement-breakpoint
CREATE TYPE "public"."event_message_kind" AS ENUM('attendance', 'role_request', 'reminder', 'admin_summary');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('scheduled', 'open', 'closed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."scheduled_action_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "attendance_responses" (
	"event_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"source_guild_id" integer,
	"status" "attendance_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_responses_event_id_discord_user_id_pk" PRIMARY KEY("event_id","discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "discord_guilds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discord_guilds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"discord_guild_id" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Europe/London' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_guilds_discord_guild_id_unique" UNIQUE("discord_guild_id")
);
--> statement-breakpoint
CREATE TABLE "event_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"guild_id" integer NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"kind" "event_message_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "event_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "event_role_options" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_role_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"source_template_role_option_id" integer,
	"key" varchar(64) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"description" text,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_templates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_guild_id" integer NOT NULL,
	"event_type_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"timezone" varchar(64) DEFAULT 'Europe/London' NOT NULL,
	"recurrence_rule" text,
	"local_start_time" varchar(5),
	"duration_minutes" integer,
	"attendance_open_minutes_before" integer DEFAULT 120 NOT NULL,
	"attendance_close_minutes_before" integer DEFAULT 60 NOT NULL,
	"role_requests_open_minutes_before" integer DEFAULT 60 NOT NULL,
	"attendance_channel_id" text,
	"role_request_channel_id" text,
	"ping_role_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_types" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_guild_id" integer NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"role_requests_enabled" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"template_id" integer,
	"owner_guild_id" integer NOT NULL,
	"event_type_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"attendance_opens_at" timestamp with time zone,
	"attendance_closes_at" timestamp with time zone,
	"role_requests_open_at" timestamp with time zone,
	"status" "event_status" DEFAULT 'scheduled' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" integer PRIMARY KEY NOT NULL,
	"event_admin_role_id" text,
	"default_attendance_channel_id" text,
	"default_role_request_channel_id" text,
	"default_ping_role_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_requests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"event_role_option_id" integer NOT NULL,
	"preference_rank" integer DEFAULT 1 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_actions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scheduled_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"action_key" varchar(100) NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "scheduled_action_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_role_options" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "template_role_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"template_id" integer NOT NULL,
	"key" varchar(64) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"description" text,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_responses" ADD CONSTRAINT "attendance_responses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_responses" ADD CONSTRAINT "attendance_responses_source_guild_id_discord_guilds_id_fk" FOREIGN KEY ("source_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_messages" ADD CONSTRAINT "event_messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_messages" ADD CONSTRAINT "event_messages_guild_id_discord_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_role_options" ADD CONSTRAINT "event_role_options_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_role_options" ADD CONSTRAINT "event_role_options_source_template_role_option_id_template_role_options_id_fk" FOREIGN KEY ("source_template_role_option_id") REFERENCES "public"."template_role_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "event_templates_owner_guild_id_discord_guilds_id_fk" FOREIGN KEY ("owner_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "event_templates_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_owner_guild_id_discord_guilds_id_fk" FOREIGN KEY ("owner_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_template_id_event_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_guild_id_discord_guilds_id_fk" FOREIGN KEY ("owner_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guild_id_discord_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_requests" ADD CONSTRAINT "role_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_requests" ADD CONSTRAINT "role_requests_event_role_option_id_event_role_options_id_fk" FOREIGN KEY ("event_role_option_id") REFERENCES "public"."event_role_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_role_options" ADD CONSTRAINT "template_role_options_template_id_event_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_responses_user_idx" ON "attendance_responses" USING btree ("discord_user_id");--> statement-breakpoint
CREATE INDEX "attendance_responses_event_status_idx" ON "attendance_responses" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "event_messages_event_idx" ON "event_messages" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_messages_guild_channel_idx" ON "event_messages" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_role_options_event_key_unique" ON "event_role_options" USING btree ("event_id","key");--> statement-breakpoint
CREATE INDEX "event_role_options_event_idx" ON "event_role_options" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_templates_owner_guild_idx" ON "event_templates" USING btree ("owner_guild_id");--> statement-breakpoint
CREATE INDEX "event_templates_event_type_idx" ON "event_templates" USING btree ("event_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_types_owner_code_unique" ON "event_types" USING btree ("owner_guild_id","code");--> statement-breakpoint
CREATE INDEX "event_types_owner_guild_idx" ON "event_types" USING btree ("owner_guild_id");--> statement-breakpoint
CREATE INDEX "events_owner_starts_at_idx" ON "events" USING btree ("owner_guild_id","starts_at");--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_template_idx" ON "events" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_requests_user_option_unique" ON "role_requests" USING btree ("event_id","discord_user_id","event_role_option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_requests_user_rank_unique" ON "role_requests" USING btree ("event_id","discord_user_id","preference_rank");--> statement-breakpoint
CREATE INDEX "role_requests_event_idx" ON "role_requests" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_actions_event_key_unique" ON "scheduled_actions" USING btree ("event_id","action_key");--> statement-breakpoint
CREATE INDEX "scheduled_actions_status_due_idx" ON "scheduled_actions" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "template_role_options_template_key_unique" ON "template_role_options" USING btree ("template_id","key");--> statement-breakpoint
CREATE INDEX "template_role_options_template_idx" ON "template_role_options" USING btree ("template_id");