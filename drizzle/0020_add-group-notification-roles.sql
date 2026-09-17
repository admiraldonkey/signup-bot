CREATE TABLE "role_request_group_notification_roles" (
	"group_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name_snapshot" varchar(100),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_request_group_notification_roles_pk" PRIMARY KEY("group_id","discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "role_request_preset_group_notification_roles" (
	"preset_group_id" integer NOT NULL,
	"discord_role_id" text NOT NULL,
	"role_name_snapshot" varchar(100),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_request_preset_group_notification_roles_pk" PRIMARY KEY("preset_group_id","discord_role_id")
);
--> statement-breakpoint
ALTER TABLE "role_request_group_notification_roles" ADD CONSTRAINT "rr_group_notify_roles_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."role_request_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_request_preset_group_notification_roles" ADD CONSTRAINT "rr_preset_group_notify_roles_group_fk" FOREIGN KEY ("preset_group_id") REFERENCES "public"."role_request_preset_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_request_group_notification_roles_group_idx" ON "role_request_group_notification_roles" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "role_request_preset_group_notification_roles_group_idx" ON "role_request_preset_group_notification_roles" USING btree ("preset_group_id");
--> statement-breakpoint
INSERT INTO "role_request_preset_group_notification_roles" (
  "preset_group_id",
  "discord_role_id",
  "role_name_snapshot",
  "sort_order"
)
SELECT
  "id",
  "notify_role_id",
  "notify_role_name_snapshot",
  0
FROM
  "role_request_preset_groups"
WHERE
  "notify_role_id" IS NOT NULL
ON CONFLICT ("preset_group_id", "discord_role_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_request_group_notification_roles" (
  "group_id",
  "discord_role_id",
  "role_name_snapshot",
  "sort_order"
)
SELECT
  "id",
  "notify_role_id",
  "notify_role_name_snapshot",
  0
FROM
  "role_request_groups"
WHERE
  "notify_role_id" IS NOT NULL
ON CONFLICT ("group_id", "discord_role_id") DO NOTHING;