CREATE TABLE "event_audiences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_audiences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_guild_id" integer NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(100) NOT NULL,
	"default_timezone" varchar(64) NOT NULL,
	"ping_role_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "audience_id" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "timezone" varchar(64) DEFAULT 'Europe/London' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "ping_role_id" text;--> statement-breakpoint
ALTER TABLE "event_audiences" ADD CONSTRAINT "event_audiences_owner_guild_id_discord_guilds_id_fk" FOREIGN KEY ("owner_guild_id") REFERENCES "public"."discord_guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_audiences_owner_code_unique" ON "event_audiences" USING btree ("owner_guild_id","code");--> statement-breakpoint
CREATE INDEX "event_audiences_owner_guild_idx" ON "event_audiences" USING btree ("owner_guild_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_audience_id_event_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."event_audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_audience_idx" ON "events" USING btree ("audience_id");