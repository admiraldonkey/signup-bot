CREATE TABLE "event_role_option_qualification_roles" (
	"event_role_option_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name_snapshot" varchar(100) NOT NULL,
	"qualification_level" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_role_option_qualification_roles_event_role_option_id_discord_role_id_pk" PRIMARY KEY("event_role_option_id","discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_group_options" (
	"group_id" integer NOT NULL,
	"event_role_option_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "role_request_group_options_group_id_event_role_option_id_pk" PRIMARY KEY("group_id","event_role_option_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_request_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"channel_id" text NOT NULL,
	"message_id" text,
	"requires_positive_signup" boolean DEFAULT false NOT NULL,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"close_minutes_before_start" integer DEFAULT 0 NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_request_groups_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
DROP INDEX "role_requests_user_rank_unique";--> statement-breakpoint
ALTER TABLE "guild_settings" ALTER COLUMN "organiser_primary_response_minutes" SET DEFAULT 80;--> statement-breakpoint
ALTER TABLE "guild_settings" ALTER COLUMN "organiser_backup_response_minutes" SET DEFAULT 40;--> statement-breakpoint
ALTER TABLE "event_role_options" ADD COLUMN "request_restriction" varchar(32) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "role_requests" ADD COLUMN "source_group_id" integer;--> statement-breakpoint
ALTER TABLE "event_role_option_qualification_roles" ADD CONSTRAINT "event_role_option_qualification_roles_event_role_option_id_event_role_options_id_fk" FOREIGN KEY ("event_role_option_id") REFERENCES "public"."event_role_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_group_options" ADD CONSTRAINT "role_request_group_options_group_id_role_request_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."role_request_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_group_options" ADD CONSTRAINT "role_request_group_options_event_role_option_id_event_role_options_id_fk" FOREIGN KEY ("event_role_option_id") REFERENCES "public"."event_role_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_groups" ADD CONSTRAINT "role_request_groups_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_role_option_qualification_idx" ON "event_role_option_qualification_roles" USING btree ("event_role_option_id");--> statement-breakpoint
CREATE INDEX "role_request_group_options_group_idx" ON "role_request_group_options" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "role_request_group_options_role_idx" ON "role_request_group_options" USING btree ("event_role_option_id");--> statement-breakpoint
CREATE INDEX "role_request_groups_event_idx" ON "role_request_groups" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "role_request_groups_closes_at_idx" ON "role_request_groups" USING btree ("event_id","closes_at");--> statement-breakpoint
ALTER TABLE "role_requests" ADD CONSTRAINT "role_requests_source_group_id_role_request_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."role_request_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_requests_user_idx" ON "role_requests" USING btree ("discord_user_id");--> statement-breakpoint
ALTER TABLE "role_requests" DROP COLUMN "preference_rank";