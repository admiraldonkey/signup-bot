import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { generateRecurringOccurrence } from "../../../src/templates/event-template-recurrence-generation-service.js";
import {
  createEventTemplateRecurrence,
  setEventTemplateRecurrenceActive,
} from "../../../src/templates/event-template-recurrence-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "993000000000000001";

const ADMIN_USER_ID = "993000000000000002";

const PUBLICATION_CHANNEL_ID = "993000000000000003";

const ROLE_REQUEST_CHANNEL_ID = "993000000000000004";

describe("event template recurrence generation service", () => {
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

  it("atomically generates an ordinary event and immutable recurrence provenance", async () => {
    const fixture = await createFixture(pool);

    const result = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2099-01-05",

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("generated");

    if (result.kind !== "generated") {
      throw new Error(
        `Expected recurring generation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.recurrenceId).toBe(fixture.recurrenceId);

    expect(result.occurrenceDate).toBe("2099-01-05");

    expect(result.generation.event.startsAt).toEqual(
      new Date("2099-01-05T20:00:00.000Z"),
    );

    const stored = await pool.query<{
      event_id: number;

      template_id: number | null;

      starts_at: Date;

      occurrence_date: string;

      recurrence_id: number;
    }>(
      `
              SELECT
                e."id" AS "event_id",

                e."template_id",

                e."starts_at",

                o."occurrence_date"::text,

                o."recurrence_id"
              FROM
                "event_recurrence_occurrences" o
              INNER JOIN
                "events" e
                  ON e."id" =
                    o."event_id"
              WHERE
                o."recurrence_id" = $1
                AND
                o."occurrence_date" =
                  '2099-01-05'
            `,
      [fixture.recurrenceId],
    );

    expect(stored.rows).toEqual([
      {
        event_id: result.generation.event.id,

        template_id: fixture.templateId,

        starts_at: new Date("2099-01-05T20:00:00.000Z"),

        occurrence_date: "2099-01-05",

        recurrence_id: fixture.recurrenceId,
      },
    ]);
  });

  it("defensively refuses generation if persisted recurrence state somehow uses immediate publication", async () => {
    const fixture = await createFixture(pool);

    /*
     * Correct administration services prevent this state.
     *
     * Mutate PostgreSQL directly so this test proves the generation boundary
     * remains safe even after manual database changes, stale application
     * versions or a future validation regression.
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

    const result = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2099-01-05",

      generatedByUserId: ADMIN_USER_ID,

      now: new Date("2099-01-05T00:00:00.000Z"),
    });

    expect(result.kind).not.toBe("generated");

    expect(result.kind).not.toBe("already_generated");

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
            ) AS "occurrence_count",

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

  it("returns the existing event when the same occurrence is generated repeatedly", async () => {
    const fixture = await createFixture(pool);

    const first = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2099-01-05",

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(first.kind).toBe("generated");

    if (first.kind !== "generated") {
      throw new Error("Expected first recurring generation to succeed.");
    }

    const second = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2099-01-05",

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(second).toEqual({
      kind: "already_generated",

      recurrenceId: fixture.recurrenceId,

      occurrenceDate: "2099-01-05",

      eventId: first.generation.event.id,
    });

    const counts = await pool.query<{
      event_count: number;

      occurrence_count: number;
    }>(
      `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM "events"
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
                ) AS "occurrence_count"
            `,
      [fixture.templateId, fixture.recurrenceId],
    );

    expect(counts.rows).toEqual([
      {
        event_count: 1,

        occurrence_count: 1,
      },
    ]);
  });

  it("rejects a requested date which is not a slot in the recurrence rule", async () => {
    const fixture = await createFixture(pool, {
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

      recurrenceStartDate: "2026-10-05",
    });

    expect(
      await generateRecurringOccurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        occurrenceDate: "2026-10-06",

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "occurrence_not_in_rule",
    });

    const eventCount = await countTemplateEvents(pool, fixture.templateId);

    expect(eventCount).toBe(0);
  });

  it("does not generate from an inactive recurrence", async () => {
    const fixture = await createFixture(pool);

    const lifecycle = await setEventTemplateRecurrenceActive({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      active: false,
    });

    expect(lifecycle.kind).toBe("updated");

    expect(
      await generateRecurringOccurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        occurrenceDate: "2099-01-05",

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "recurrence_inactive",
    });

    expect(await countTemplateEvents(pool, fixture.templateId)).toBe(0);
  });

  it("rejects an ambiguous recurring local wall-clock time rather than choosing a DST offset", async () => {
    const fixture = await createFixture(pool, {
      localStartTime: "01:30",

      recurrenceRule: "FREQ=DAILY",

      recurrenceStartDate: "2026-10-25",
    });

    const result = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2026-10-25",

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("invalid_local_occurrence_time");

    if (result.kind !== "invalid_local_occurrence_time") {
      throw new Error(
        `Expected ambiguous local time rejection, received "${result.kind}".`,
      );
    }

    expect(result.error).toContain("occurs twice");

    expect(await countTemplateEvents(pool, fixture.templateId)).toBe(0);
  });

  it("rolls back the generated event when a late preset snapshot fails", async () => {
    const fixture = await createFixture(pool, {
      invalidPreset: true,
    });

    const result = await generateRecurringOccurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      occurrenceDate: "2099-01-05",

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("generation_failed");

    if (result.kind !== "generation_failed") {
      throw new Error(
        `Expected generation failure, received "${result.kind}".`,
      );
    }

    expect(result.result.kind).toBe("preset_application_failed");

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
                  FROM "events"
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
                ) AS "occurrence_count",

                                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    "scheduled_actions"
                  WHERE
                    "action_key" =
                      'publish_event'
                ) AS "publication_action_count"
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

  it("serialises concurrent generation of the same recurrence slot", async () => {
    const fixture = await createFixture(pool);

    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");

      await blocker.query(
        `
              SELECT "id"
              FROM
                "event_template_recurrences"
              WHERE "id" = $1
              FOR UPDATE
            `,
        [fixture.recurrenceId],
      );

      const first = generateRecurringOccurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        occurrenceDate: "2099-01-05",

        generatedByUserId: ADMIN_USER_ID,
      });

      const second = generateRecurringOccurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        occurrenceDate: "2099-01-05",

        generatedByUserId: ADMIN_USER_ID,
      });

      await waitForBlockedQueries(pool, "event_template_recurrences", 2);

      await blocker.query("COMMIT");

      const results = await Promise.all([first, second]);

      expect(results.map((result) => result.kind).sort()).toEqual([
        "already_generated",
        "generated",
      ]);
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } catch {
        /*
         * Harmless when the transaction was already committed.
         */
      }

      blocker.release();
    }

    const counts = await pool.query<{
      event_count: number;

      occurrence_count: number;
    }>(
      `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM "events"
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
                ) AS "occurrence_count"
            `,
      [fixture.templateId, fixture.recurrenceId],
    );

    expect(counts.rows).toEqual([
      {
        event_count: 1,

        occurrence_count: 1,
      },
    ]);
  });
});

type FixtureOptions = {
  localStartTime?: string;

  recurrenceRule?: string;

  recurrenceStartDate?: string;

  invalidPreset?: boolean;

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
  const localStartTime = options.localStartTime ?? "20:00";

  const recurrenceRule = options.recurrenceRule ?? "FREQ=DAILY";

  const recurrenceStartDate = options.recurrenceStartDate ?? "2099-01-01";

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
          'Recurring Generation Test Guild'
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
        "default_attendance_channel_id",
        "default_role_request_channel_id"
      )
      VALUES (
        $1,
        $2,
        $3
      )
    `,
    [guildId, PUBLICATION_CHANNEL_ID, ROLE_REQUEST_CHANNEL_ID],
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

  let presetId: number | null = null;

  if (options.invalidPreset) {
    const presetResult = await pool.query<{
      id: number;
    }>(
      `
          INSERT INTO
            "role_request_presets" (
              "owner_guild_id",
              "name",
              "active",
              "created_by_user_id"
            )
          VALUES (
            $1,
            'Invalid Empty Preset',
            true,
            $2
          )
          RETURNING "id"
        `,
      [guildId, ADMIN_USER_ID],
    );

    presetId = requireId(presetResult.rows[0]?.id, "role-request preset");
  }

  const templateResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_templates" (
            "owner_guild_id",
            "event_type_id",
            "role_request_preset_id",
            "name",
            "timezone",
            "local_start_time",
            "publication_mode",
            "created_by_user_id"
          )
        VALUES (
          $1,
          $2,
          $3,
          'Recurring Naval',
          'Europe/London',
          $4,
            $5,
            $6
        )
        RETURNING "id"
      `,
    [
      guildId,
      eventTypeId,
      presetId,
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

    startDate: recurrenceStartDate,

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

async function countTemplateEvents(
  pool: Pool,
  templateId: number,
): Promise<number> {
  const result = await pool.query<{
    count: number;
  }>(
    `
        SELECT
          COUNT(*)::int AS "count"
        FROM "events"
        WHERE
          "template_id" = $1
      `,
    [templateId],
  );

  return result.rows[0]?.count ?? 0;
}

function requireId(value: number | undefined, description: string): number {
  if (value === undefined) {
    throw new Error(
      `Expected ${description} fixture creation to return an ID.`,
    );
  }

  return value;
}

async function waitForBlockedQueries(
  pool: Pool,
  queryFragment: string,
  minimumCount: number,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      count: number;
    }>(
      `
          SELECT
            COUNT(*)::int AS "count"
          FROM
            "pg_stat_activity"
          WHERE
            "datname" =
              current_database()
            AND
            "state" = 'active'
            AND
            "wait_event_type" =
              'Lock'
            AND
            "query" ILIKE $1
        `,
      [`%${queryFragment}%`],
    );

    if ((result.rows[0]?.count ?? 0) >= minimumCount) {
      return;
    }

    /*
     * Polling observes PostgreSQL's actual lock state. Correctness does not
     * depend on an arbitrary sleep completing before the competing work.
     */
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for ${minimumCount} blocked PostgreSQL queries containing "${queryFragment}".`,
  );
}
