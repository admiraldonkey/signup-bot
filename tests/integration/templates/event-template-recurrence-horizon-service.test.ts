import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { generateRecurringHorizon } from "../../../src/templates/event-template-recurrence-horizon-service.js";
import {
  createEventTemplateRecurrence,
  setEventTemplateRecurrenceActive,
} from "../../../src/templates/event-template-recurrence-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "994000000000000001";

const ADMIN_USER_ID = "994000000000000002";

const PUBLICATION_CHANNEL_ID = "994000000000000003";

describe("event template recurrence horizon service", () => {
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

  it("materialises recurrence slots across exactly ten local calendar days", async () => {
    const fixture = await createFixture(pool);

    const result = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now: new Date("2099-01-05T00:00:00.000Z"),
    });

    expect(result.kind).toBe("processed");

    if (result.kind !== "processed") {
      throw new Error(
        `Expected horizon generation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.fromDate).toBe("2099-01-05");

    /*
     * Ten inclusive local calendar dates:
     *
     * 5 January through 14 January.
     */
    expect(result.throughDate).toBe("2099-01-14");

    expect(
      result.slotResults.map((slot) => ({
        kind: slot.kind,

        occurrenceDate: slot.occurrenceDate,
      })),
    ).toEqual([
      {
        kind: "generated",

        occurrenceDate: "2099-01-05",
      },
      {
        kind: "generated",

        occurrenceDate: "2099-01-12",
      },
    ]);

    const stored = await pool.query<{
      occurrence_date: string;

      created_by_user_id: string;
    }>(
      `
          SELECT
            o."occurrence_date"::text,

            e."created_by_user_id"
          FROM
            "event_recurrence_occurrences" o
          INNER JOIN
            "events" e
              ON e."id" =
                o."event_id"
          WHERE
            o."recurrence_id" = $1
          ORDER BY
            o."occurrence_date"
        `,
      [fixture.recurrenceId],
    );

    expect(stored.rows).toEqual([
      {
        occurrence_date: "2099-01-05",

        created_by_user_id: ADMIN_USER_ID,
      },
      {
        occurrence_date: "2099-01-12",

        created_by_user_id: ADMIN_USER_ID,
      },
    ]);
  });

  it("is idempotent when the same horizon is processed again", async () => {
    const fixture = await createFixture(pool);

    const now = new Date("2099-01-05T00:00:00.000Z");

    const first = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now,
    });

    expect(first.kind).toBe("processed");

    const second = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now,
    });

    expect(second.kind).toBe("processed");

    if (second.kind !== "processed") {
      throw new Error("Expected repeated horizon processing to succeed.");
    }

    expect(second.slotResults.map((slot) => slot.kind)).toEqual([
      "already_generated",
      "already_generated",
    ]);

    const counts = await pool.query<{
      event_count: number;

      occurrence_count: number;
    }>(
      `
          SELECT
            (
              SELECT
                COUNT(*)::int
              FROM
                "events"
              WHERE
                "template_id" = $1
            ) AS "event_count",

            (
              SELECT
                COUNT(*)::int
              FROM
                "event_recurrence_occurrences"
              WHERE
                "recurrence_id" = $2
            ) AS
              "occurrence_count"
        `,
      [fixture.templateId, fixture.recurrenceId],
    );

    expect(counts.rows).toEqual([
      {
        event_count: 2,

        occurrence_count: 2,
      },
    ]);
  });

  it("derives the horizon date from the template timezone rather than UTC", async () => {
    const fixture = await createFixture(pool, {
      timezone: "Europe/London",

      recurrenceRule: "FREQ=WEEKLY;BYDAY=TH",

      startDate: "2099-07-02",
    });

    /*
     * 23:30 UTC is already 00:30 on 2 July in London during BST.
     */
    const result = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now: new Date("2099-07-01T23:30:00.000Z"),
    });

    expect(result.kind).toBe("processed");

    if (result.kind !== "processed") {
      throw new Error("Expected timezone-aware horizon generation to succeed.");
    }

    expect(result.fromDate).toBe("2099-07-02");

    expect(result.throughDate).toBe("2099-07-11");

    expect(result.slotResults.map((slot) => slot.occurrenceDate)).toEqual([
      "2099-07-02",
      "2099-07-09",
    ]);
  });

  it("skips an already-past same-day slot while still generating later slots", async () => {
    const fixture = await createFixture(pool, {
      localStartTime: "10:00",
    });

    const result = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now: new Date("2099-01-05T12:00:00.000Z"),
    });

    expect(result.kind).toBe("processed");

    if (result.kind !== "processed") {
      throw new Error("Expected horizon generation to succeed.");
    }

    expect(
      result.slotResults.map((slot) => ({
        kind: slot.kind,

        occurrenceDate: slot.occurrenceDate,

        reason: slot.kind === "skipped" ? slot.reason : null,
      })),
    ).toEqual([
      {
        kind: "skipped",

        occurrenceDate: "2099-01-05",

        reason: "start_not_future",
      },
      {
        kind: "generated",

        occurrenceDate: "2099-01-12",

        reason: null,
      },
    ]);
  });

  it("does nothing while the recurrence series is inactive", async () => {
    const fixture = await createFixture(pool);

    const lifecycle = await setEventTemplateRecurrenceActive({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      active: false,
    });

    expect(lifecycle.kind).toBe("updated");

    expect(
      await generateRecurringHorizon({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        now: new Date("2099-01-05T00:00:00.000Z"),
      }),
    ).toEqual({
      kind: "recurrence_inactive",
    });

    const eventCount = await pool.query<{
      count: number;
    }>(
      `
              SELECT
                COUNT(*)::int AS "count"
              FROM "events"
            `,
    );

    expect(eventCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("defensively refuses horizon generation if persisted recurrence state uses immediate publication", async () => {
    const fixture = await createFixture(pool);

    /*
     * Correct mutation services forbid this combination.
     *
     * Bypass them to prove automatic horizon execution itself remains safe.
     */
    await pool.query(
      `
        UPDATE
          "event_templates"
        SET
          "publication_mode" =
            'immediate'
        WHERE
          "id" = $1
      `,
      [fixture.templateId],
    );

    const result = await generateRecurringHorizon({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      now: new Date("2099-01-05T00:00:00.000Z"),
    });

    expect(result.kind).not.toBe("processed");

    const counts = await pool.query<{
      event_count: number;

      occurrence_count: number;

      publication_action_count: number;
    }>(
      `
          SELECT
            (
              SELECT
                COUNT(*)::int
              FROM
                "events"
              WHERE
                "template_id" = $1
            ) AS "event_count",

            (
              SELECT
                COUNT(*)::int
              FROM
                "event_recurrence_occurrences"
              WHERE
                "recurrence_id" = $2
            ) AS
              "occurrence_count",

            (
              SELECT
                COUNT(*)::int
              FROM
                "scheduled_actions"
              WHERE
                "action_key" =
                  'publish_event'
            ) AS
              "publication_action_count"
        `,
      [fixture.templateId, fixture.recurrenceId],
    );

    expect(counts.rows).toEqual([
      {
        event_count: 0,

        occurrence_count: 0,

        publication_action_count: 0,
      },
    ]);
  });
});

type FixtureOptions = {
  timezone?: string;

  localStartTime?: string;

  recurrenceRule?: string;

  startDate?: string;

  publicationMode?: "manual" | "immediate";
};

async function createFixture(
  pool: Pool,
  options: FixtureOptions = {},
): Promise<{
  guildId: number;

  templateId: number;

  recurrenceId: number;
}> {
  const timezone = options.timezone ?? "Europe/London";

  const localStartTime = options.localStartTime ?? "20:00";

  const recurrenceRule = options.recurrenceRule ?? "FREQ=WEEKLY;BYDAY=MO";

  const startDate = options.startDate ?? "2099-01-05";

  const publicationMode = options.publicationMode ?? "manual";

  const guildResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "discord_guilds" (
          "discord_guild_id",
          "name"
        )
        VALUES (
          $1,
          'Recurrence Horizon Test Guild'
        )
        RETURNING "id"
      `,
    [DISCORD_GUILD_ID],
  );

  const guildId = requireId(guildResult.rows[0]?.id, "guild");

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "default_attendance_channel_id"
      )
      VALUES (
        $1,
        $2
      )
    `,
    [guildId, PUBLICATION_CHANNEL_ID],
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

  const eventTypeId = requireId(eventTypeResult.rows[0]?.id, "event type");

  const templateResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_templates" (
            "owner_guild_id",
            "event_type_id",
            "name",
            "timezone",
            "local_start_time",
            "signups_enabled",
            "publication_mode",
            "created_by_user_id"
          )
        VALUES (
          $1,
          $2,
          'Recurring Horizon Naval',
          $3,
          $4,
          false,
          $5,
          $6
        )
        RETURNING "id"
      `,
    [
      guildId,

      eventTypeId,

      timezone,

      localStartTime,

      publicationMode,

      ADMIN_USER_ID,
    ],
  );

  const templateId = requireId(templateResult.rows[0]?.id, "template");

  const recurrence = await createEventTemplateRecurrence({
    guildDatabaseId: guildId,

    templateId,

    recurrenceRule,

    startDate,

    createdByUserId: ADMIN_USER_ID,
  });

  if (recurrence.kind !== "created") {
    throw new Error(
      `Expected recurrence fixture creation to succeed, received "${recurrence.kind}".`,
    );
  }

  return {
    guildId,

    templateId,

    recurrenceId: recurrence.recurrence.id,
  };
}

function requireId(value: number | undefined, description: string): number {
  if (value === undefined) {
    throw new Error(
      `Expected ${description} fixture creation to return an ID.`,
    );
  }

  return value;
}
