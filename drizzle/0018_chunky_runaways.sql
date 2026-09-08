ALTER TABLE "role_request_groups" ALTER COLUMN "open_minutes_before_start" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "role_request_groups" ALTER COLUMN "open_minutes_before_start" DROP NOT NULL;
--> statement-breakpoint

UPDATE "role_request_groups"
SET "open_minutes_before_start" = NULL
WHERE "source_role_request_preset_group_id" IS NULL;