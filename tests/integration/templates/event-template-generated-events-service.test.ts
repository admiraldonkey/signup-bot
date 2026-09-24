import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { listGeneratedEventsForTemplate } from "../../../src/templates/event-template-generated-events-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "996000000000000001";

const OTHER_DISCORD_GUILD_ID = "996000000000000002";

const ADMIN_USER_ID = "996000000000000003";

const PUBLICATION_CHANNEL_ID = "996000000000000004";

const NOW = new Date("2099-01-05T12:00:00.000Z");

const CURRENT_TEMPLATE_REVISION = new Date("2099-01-04T09:00:00.000Z");

const OLDER_TEMPLATE_REVISION = new Date("2098-12-31T09:00:00.000Z");

describe("event template generated-event inspection service", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();

    await applicationPool.end();
  });

  it("lists upcoming generated events with publication, recurrence and template-revision provenance", async () => {
    const fixture = await createGeneratedEventsFixture(pool);

    const result = await listGeneratedEventsForTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now: NOW,
    });

    expect(result.kind).toBe("found");

    if (result.kind !== "found") {
      throw new Error(
        `Expected generated-event inspection to succeed, received "${result.kind}".`,
      );
    }

    expect(result.template).toEqual({
      id: fixture.templateId,

      name: "Sunday Naval",

      updatedAt: CURRENT_TEMPLATE_REVISION,
    });

    expect(result.events).toEqual([
      {
        id: fixture.currentRecurringEventId,

        name: "Current Recurring Naval",

        startsAt: new Date("2099-01-06T20:00:00.000Z"),

        status: "open",

        publishedAt: new Date("2099-01-03T20:00:00.000Z"),

        publicationActionStatus: "completed",

        publicationDueAt: new Date("2099-01-03T20:00:00.000Z"),

        recurrenceOccurrenceDate: "2099-01-06",

        templateSourceUpdatedAt: CURRENT_TEMPLATE_REVISION,

        templateRevisionState: "current",
      },

      {
        id: fixture.olderOneOffEventId,

        name: "Older One-Off Naval",

        startsAt: new Date("2099-01-13T20:00:00.000Z"),

        status: "scheduled",

        publishedAt: null,

        publicationActionStatus: "pending",

        publicationDueAt: new Date("2099-01-10T20:00:00.000Z"),

        recurrenceOccurrenceDate: null,

        templateSourceUpdatedAt: OLDER_TEMPLATE_REVISION,

        templateRevisionState: "older",
      },
    ]);
  });

  it("includes historical generated events only when requested and preserves unknown revision provenance", async () => {
    const fixture = await createGeneratedEventsFixture(pool);

    const result = await listGeneratedEventsForTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      includePast: true,

      now: NOW,
    });

    expect(result.kind).toBe("found");

    if (result.kind !== "found") {
      throw new Error(
        `Expected generated-event inspection to succeed, received "${result.kind}".`,
      );
    }

    expect(
      result.events.map((event) => ({
        id: event.id,

        recurrenceOccurrenceDate: event.recurrenceOccurrenceDate,

        templateRevisionState: event.templateRevisionState,
      })),
    ).toEqual([
      {
        id: fixture.historicalEventId,

        recurrenceOccurrenceDate: null,

        templateRevisionState: "unknown",
      },

      {
        id: fixture.currentRecurringEventId,

        recurrenceOccurrenceDate: "2099-01-06",

        templateRevisionState: "current",
      },

      {
        id: fixture.olderOneOffEventId,

        recurrenceOccurrenceDate: null,

        templateRevisionState: "older",
      },
    ]);
  });

  it("treats a template owned by another guild as not found", async () => {
    const fixture = await createGeneratedEventsFixture(pool);

    const otherGuildResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO "discord_guilds" (
          "discord_guild_id",
          "name"
        )
        VALUES ($1, 'Other Generated Event Inspection Guild')
        RETURNING "id"
      `,
      [OTHER_DISCORD_GUILD_ID],
    );

    const otherGuildId = requireReturnedId(
      otherGuildResult.rows[0]?.id,

      "other guild",
    );

    const result = await listGeneratedEventsForTemplate({
      guildDatabaseId: otherGuildId,

      templateId: fixture.templateId,

      includePast: true,

      now: NOW,
    });

    expect(result).toEqual({
      kind: "template_not_found",
    });
  });
});

async function createGeneratedEventsFixture(pool: Pool): Promise<{
  guildId: number;
  templateId: number;
  currentRecurringEventId: number;
  olderOneOffEventId: number;
  historicalEventId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, 'Generated Event Inspection Guild')
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildId = requireReturnedId(
    guildResult.rows[0]?.id,

    "guild",
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name",
        "role_requests_enabled",
        "active"
      )
      VALUES (
        $1,
        'naval',
        'Naval',
        true,
        true
      )
      RETURNING "id"
    `,
    [guildId],
  );

  const eventTypeId = requireReturnedId(
    eventTypeResult.rows[0]?.id,

    "event type",
  );

  const templateResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_templates" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "description",
        "timezone",
        "local_start_time",
        "duration_minutes",
        "signups_enabled",
        "attendance_close_minutes_before",
        "publication_mode",
        "publish_minutes_before_start",
        "publication_channel_id",
        "active",
        "created_by_user_id",
        "updated_at"
      )
      VALUES (
        $1,
        $2,
        'Sunday Naval',
        'Reusable naval event.',
        'Europe/London',
        '20:00',
        90,
        true,
        60,
        'scheduled',
        4320,
        $3,
        true,
        $4,
        $5
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      PUBLICATION_CHANNEL_ID,
      ADMIN_USER_ID,
      CURRENT_TEMPLATE_REVISION,
    ],
  );

  const templateId = requireReturnedId(
    templateResult.rows[0]?.id,

    "event template",
  );

  const recurrenceResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_template_recurrences" (
        "template_id",
        "recurrence_rule",
        "start_date",
        "active",
        "created_by_user_id"
      )
      VALUES (
        $1,
        'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
        '2099-01-06',
        true,
        $2
      )
      RETURNING "id"
    `,
    [templateId, ADMIN_USER_ID],
  );

  const recurrenceId = requireReturnedId(
    recurrenceResult.rows[0]?.id,

    "event template recurrence",
  );

  const currentRecurringEventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "template_id",
        "template_source_updated_at",
        "owner_guild_id",
        "event_type_id",
        "timezone",
        "name",
        "description",
        "starts_at",
        "ends_at",
        "signups_enabled",
        "attendance_closes_at",
        "published_at",
        "publish_minutes_before_start",
        "publication_channel_id",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'Europe/London',
        'Current Recurring Naval',
        'Current template revision.',
        '2099-01-06T20:00:00.000Z',
        '2099-01-06T21:30:00.000Z',
        true,
        '2099-01-06T19:00:00.000Z',
        '2099-01-03T20:00:00.000Z',
        4320,
        $5,
        'open',
        $6
      )
      RETURNING "id"
    `,
    [
      templateId,
      CURRENT_TEMPLATE_REVISION,
      guildId,
      eventTypeId,
      PUBLICATION_CHANNEL_ID,
      ADMIN_USER_ID,
    ],
  );

  const currentRecurringEventId = requireReturnedId(
    currentRecurringEventResult.rows[0]?.id,

    "current recurring event",
  );

  await pool.query(
    `
      INSERT INTO "event_recurrence_occurrences" (
        "recurrence_id",
        "occurrence_date",
        "event_id"
      )
      VALUES (
        $1,
        '2099-01-06',
        $2
      )
    `,
    [recurrenceId, currentRecurringEventId],
  );

  await pool.query(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status",
        "attempt_count",
        "completed_at"
      )
      VALUES (
        $1,
        'publish_event',
        '2099-01-03T20:00:00.000Z',
        'completed',
        0,
        '2099-01-03T20:00:00.000Z'
      )
    `,
    [currentRecurringEventId],
  );

  const olderOneOffEventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "template_id",
        "template_source_updated_at",
        "owner_guild_id",
        "event_type_id",
        "timezone",
        "name",
        "description",
        "starts_at",
        "ends_at",
        "signups_enabled",
        "published_at",
        "publish_minutes_before_start",
        "publication_channel_id",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'Europe/London',
        'Older One-Off Naval',
        'Generated from an older template revision.',
        '2099-01-13T20:00:00.000Z',
        '2099-01-13T21:30:00.000Z',
        false,
        NULL,
        4320,
        $5,
        'scheduled',
        $6
      )
      RETURNING "id"
    `,
    [
      templateId,
      OLDER_TEMPLATE_REVISION,
      guildId,
      eventTypeId,
      PUBLICATION_CHANNEL_ID,
      ADMIN_USER_ID,
    ],
  );

  const olderOneOffEventId = requireReturnedId(
    olderOneOffEventResult.rows[0]?.id,

    "older one-off event",
  );

  await pool.query(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status",
        "attempt_count"
      )
      VALUES (
        $1,
        'publish_event',
        '2099-01-10T20:00:00.000Z',
        'pending',
        0
      )
    `,
    [olderOneOffEventId],
  );

  const historicalEventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "template_id",
        "template_source_updated_at",
        "owner_guild_id",
        "event_type_id",
        "timezone",
        "name",
        "description",
        "starts_at",
        "ends_at",
        "signups_enabled",
        "published_at",
        "publication_channel_id",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        NULL,
        $2,
        $3,
        'Europe/London',
        'Historical Naval',
        'Predates exact source-revision provenance.',
        '2099-01-01T20:00:00.000Z',
        '2099-01-01T21:30:00.000Z',
        false,
        '2098-12-29T20:00:00.000Z',
        $4,
        'completed',
        $5
      )
      RETURNING "id"
    `,
    [templateId, guildId, eventTypeId, PUBLICATION_CHANNEL_ID, ADMIN_USER_ID],
  );

  const historicalEventId = requireReturnedId(
    historicalEventResult.rows[0]?.id,

    "historical event",
  );

  return {
    guildId,

    templateId,

    currentRecurringEventId,

    olderOneOffEventId,

    historicalEventId,
  };
}

function requireReturnedId(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
    throw new Error(`Expected ${label} insert to return a positive ID.`);
  }

  return value;
}
