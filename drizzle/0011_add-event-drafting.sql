ALTER TABLE "events" ADD COLUMN "published_at" timestamp with time zone;
UPDATE "events"
SET "published_at" = existing_publication.first_published_at
FROM (
  SELECT
    "event_id",
    MIN("created_at") AS first_published_at
  FROM "event_messages"
  WHERE "kind" = 'attendance'
  GROUP BY "event_id"
) AS existing_publication
WHERE
  "events"."id" = existing_publication."event_id"
  AND "events"."published_at" IS NULL;