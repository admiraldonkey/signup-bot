import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "991000000000000001";

const ADMIN_USER_ID = "991000000000000002";

describe("event recurrence schema", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies recurrence-series and occurrence provenance through the migration chain", async () => {
    const tables = await pool.query<{
      recurrence_series: string | null;

      recurrence_occurrences: string | null;
    }>(`
            SELECT
              to_regclass(
                'public.event_template_recurrences'
              )::text AS recurrence_series,

              to_regclass(
                'public.event_recurrence_occurrences'
              )::text AS recurrence_occurrences
          `);

    expect(tables.rows).toEqual([
      {
        recurrence_series: "event_template_recurrences",

        recurrence_occurrences: "event_recurrence_occurrences",
      },
    ]);

    const constraints = await pool.query<{
      conname: string;

      definition: string;
    }>(`
            SELECT
              "conname",

              pg_get_constraintdef(
                "oid"
              ) AS "definition"
            FROM "pg_constraint"
            WHERE "conname" IN (
              'evt_tpl_recur_tpl_fk',
              'evt_recur_occ_pk',
              'evt_recur_occ_recur_fk',
              'evt_recur_occ_event_fk'
            )
            ORDER BY "conname"
          `);

    const definitions = new Map(
      constraints.rows.map((constraint) => [
        constraint.conname,
        constraint.definition,
      ]),
    );

    expect(definitions.get("evt_tpl_recur_tpl_fk")).toContain(
      "ON DELETE RESTRICT",
    );

    expect(definitions.get("evt_recur_occ_recur_fk")).toContain(
      "ON DELETE RESTRICT",
    );

    expect(definitions.get("evt_recur_occ_event_fk")).toContain(
      "ON DELETE RESTRICT",
    );

    expect(definitions.get("evt_recur_occ_pk")).toContain("PRIMARY KEY");
  });

  it("enforces one recurrence per template and immutable recurrence-slot identity", async () => {
    const fixture = await createFixture(pool);

    const recurrenceResult = await pool.query<{
      id: number;
    }>(
      `
              INSERT INTO
                "event_template_recurrences" (
                  "template_id",
                  "recurrence_rule",
                  "start_date",
                  "created_by_user_id"
                )
              VALUES (
                $1,
                'FREQ=WEEKLY;BYDAY=MO',
                '2026-10-05',
                $2
              )
              RETURNING "id"
            `,
      [fixture.templateId, ADMIN_USER_ID],
    );

    const recurrenceId = recurrenceResult.rows[0]?.id;

    if (!recurrenceId) {
      throw new Error("Expected recurrence fixture creation to return an ID.");
    }

    await expect(
      pool.query(
        `
              INSERT INTO
                "event_template_recurrences" (
                  "template_id",
                  "recurrence_rule",
                  "start_date",
                  "created_by_user_id"
                )
              VALUES (
                $1,
                'FREQ=WEEKLY;BYDAY=TU',
                '2026-10-06',
                $2
              )
            `,
        [fixture.templateId, ADMIN_USER_ID],
      ),
    ).rejects.toMatchObject({
      code: "23505",
    });

    const firstEventId = await createEvent(
      pool,

      fixture,

      "2026-10-05T19:00:00.000Z",

      "First recurring event",
    );

    const secondEventId = await createEvent(
      pool,

      fixture,

      "2026-10-12T19:00:00.000Z",

      "Second recurring event",
    );

    await pool.query(
      `
            INSERT INTO
              "event_recurrence_occurrences" (
                "recurrence_id",
                "occurrence_date",
                "event_id"
              )
            VALUES (
              $1,
              '2026-10-05',
              $2
            )
          `,
      [recurrenceId, firstEventId],
    );

    /*
     * Moving the ordinary event must not rewrite its immutable recurrence
     * slot identity.
     */
    await pool.query(
      `
            UPDATE "events"
            SET
              "starts_at" =
                '2026-10-06T20:00:00.000Z'
            WHERE "id" = $1
          `,
      [firstEventId],
    );

    const storedOccurrence = await pool.query<{
      occurrence_date: string;

      event_id: number;
    }>(
      `
              SELECT
                "occurrence_date"::text,

                "event_id"
              FROM
                "event_recurrence_occurrences"
              WHERE
                "recurrence_id" = $1
            `,
      [recurrenceId],
    );

    expect(storedOccurrence.rows).toEqual([
      {
        occurrence_date: "2026-10-05",

        event_id: firstEventId,
      },
    ]);

    /*
     * The same recurrence slot cannot generate another event.
     */
    await expect(
      pool.query(
        `
              INSERT INTO
                "event_recurrence_occurrences" (
                  "recurrence_id",
                  "occurrence_date",
                  "event_id"
                )
              VALUES (
                $1,
                '2026-10-05',
                $2
              )
            `,
        [recurrenceId, secondEventId],
      ),
    ).rejects.toMatchObject({
      code: "23505",
    });

    /*
     * One event cannot represent two recurrence slots either.
     */
    await expect(
      pool.query(
        `
              INSERT INTO
                "event_recurrence_occurrences" (
                  "recurrence_id",
                  "occurrence_date",
                  "event_id"
                )
              VALUES (
                $1,
                '2026-10-12',
                $2
              )
            `,
        [recurrenceId, firstEventId],
      ),
    ).rejects.toMatchObject({
      code: "23505",
    });
  });
});

async function createFixture(pool: Pool): Promise<{
  guildId: number;

  eventTypeId: number;

  templateId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "discord_guilds" (
            "discord_guild_id",
            "name"
          )
        VALUES (
          $1,
          'Recurrence Schema Test Guild'
        )
        RETURNING "id"
      `,
    [DISCORD_GUILD_ID],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("Expected guild fixture creation to return an ID.");
  }

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_types" (
            "owner_guild_id",
            "code",
            "name"
          )
        VALUES (
          $1,
          'naval',
          'Naval'
        )
        RETURNING "id"
      `,
    [guildId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Expected event-type fixture creation to return an ID.");
  }

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
            "created_by_user_id"
          )
        VALUES (
          $1,
          $2,
          'Monday Naval',
          'Europe/London',
          '20:00',
          $3
        )
        RETURNING "id"
      `,
    [guildId, eventTypeId, ADMIN_USER_ID],
  );

  const templateId = templateResult.rows[0]?.id;

  if (!templateId) {
    throw new Error("Expected template fixture creation to return an ID.");
  }

  return {
    guildId,

    eventTypeId,

    templateId,
  };
}

async function createEvent(
  pool: Pool,
  fixture: {
    guildId: number;

    eventTypeId: number;

    templateId: number;
  },
  startsAt: string,
  name: string,
): Promise<number> {
  const result = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "events" (
          "template_id",
          "owner_guild_id",
          "event_type_id",
          "timezone",
          "name",
          "starts_at",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          $3,
          'Europe/London',
          $4,
          $5,
          $6
        )
        RETURNING "id"
      `,
    [
      fixture.templateId,

      fixture.guildId,

      fixture.eventTypeId,

      name,

      startsAt,

      ADMIN_USER_ID,
    ],
  );

  const eventId = result.rows[0]?.id;

  if (!eventId) {
    throw new Error("Expected event fixture creation to return an ID.");
  }

  return eventId;
}
