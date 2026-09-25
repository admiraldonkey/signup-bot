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
              'evt_recur_occ_event_fk',
              'evt_tpl_recur_sweep_outcome_chk'
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

    const sweepColumns = await pool.query<{
      column_name: string;

      is_nullable: string;
    }>(`
      SELECT
        "column_name",
        "is_nullable"
      FROM
        "information_schema"."columns"
      WHERE
        "table_schema" = 'public'
        AND "table_name" = 'event_template_recurrences'
        AND "column_name" IN (
          'next_sweep_at',
          'sweep_claim_token',
          'last_sweep_started_at',
          'last_sweep_completed_at',
          'last_sweep_outcome',
          'last_sweep_diagnostic'
        )
      ORDER BY
        "column_name"
    `);

    expect(sweepColumns.rows).toEqual([
      {
        column_name: "last_sweep_completed_at",

        is_nullable: "YES",
      },
      {
        column_name: "last_sweep_diagnostic",

        is_nullable: "YES",
      },
      {
        column_name: "last_sweep_outcome",

        is_nullable: "YES",
      },
      {
        column_name: "last_sweep_started_at",

        is_nullable: "YES",
      },
      {
        column_name: "next_sweep_at",

        is_nullable: "NO",
      },
      {
        column_name: "sweep_claim_token",

        is_nullable: "YES",
      },
    ]);

    const sweepIndex = await pool.query<{
      indexname: string;
    }>(`
      SELECT
        "indexname"
      FROM
        "pg_indexes"
      WHERE
        "schemaname" = 'public'
        AND "tablename" = 'event_template_recurrences'
        AND "indexname" = 'evt_tpl_recur_active_sweep_idx'
    `);

    expect(sweepIndex.rows).toEqual([
      {
        indexname: "evt_tpl_recur_active_sweep_idx",
      },
    ]);

    expect(definitions.get("evt_tpl_recur_sweep_outcome_chk")).toContain(
      "CHECK",
    );
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

    const sweepState = await pool.query<{
      next_sweep_at: Date;

      sweep_claim_token: string | null;

      last_sweep_started_at: Date | null;

      last_sweep_completed_at: Date | null;

      last_sweep_outcome: string | null;

      last_sweep_diagnostic: string | null;
    }>(
      `
        SELECT
          "next_sweep_at",
          "sweep_claim_token",
          "last_sweep_started_at",
          "last_sweep_completed_at",
          "last_sweep_outcome",
          "last_sweep_diagnostic"
        FROM
          "event_template_recurrences"
        WHERE
          "id" = $1
      `,
      [recurrenceId],
    );

    expect(sweepState.rows).toEqual([
      {
        next_sweep_at: expect.any(Date),

        sweep_claim_token: null,

        last_sweep_started_at: null,

        last_sweep_completed_at: null,

        last_sweep_outcome: null,

        last_sweep_diagnostic: null,
      },
    ]);

    await expect(
      pool.query(
        `
          UPDATE "event_template_recurrences"
          SET
            "last_sweep_outcome" = 'definitely_not_a_real_outcome'
          WHERE
            "id" = $1
        `,
        [recurrenceId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
    });

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
