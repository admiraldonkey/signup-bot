import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  RECURRENCE_SWEEP_INTERVAL_MS,
  RECURRENCE_SWEEP_STALE_AFTER_MS,
  runDueRecurrenceSweeps,
} from "../../../src/templates/event-template-recurrence-sweep-service.js";
import { createEventTemplateRecurrence } from "../../../src/templates/event-template-recurrence-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const ADMIN_USER_ID = "995000000000000001";

const PUBLICATION_CHANNEL_ID = "995000000000000002";

const NOW = new Date("2099-01-05T00:00:00.000Z");

describe("event template recurrence sweep service", () => {
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

  it("allows only one concurrent sweep runner to claim one due recurrence", async () => {
    const fixture = await createSweepFixture(
      pool,
      "995000000000000010",
      "Concurrent",
    );

    const [first, second] = await Promise.all([
      runDueRecurrenceSweeps({
        now: NOW,
      }),

      runDueRecurrenceSweeps({
        now: NOW,
      }),
    ]);

    expect(first.claimedCount + second.claimedCount).toBe(1);

    const results = [...first.results, ...second.results];

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      recurrenceId: fixture.recurrenceId,

      templateId: fixture.templateId,

      guildDatabaseId: fixture.guildId,

      outcome: "success",

      generatedCount: 2,

      failedCount: 0,

      diagnostic: null,

      recorded: true,
    });

    const occurrenceCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "event_recurrence_occurrences"
        WHERE
          "recurrence_id" = $1
      `,
      [fixture.recurrenceId],
    );

    expect(occurrenceCount.rows).toEqual([
      {
        count: 2,
      },
    ]);

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
      [fixture.recurrenceId],
    );

    expect(sweepState.rows).toEqual([
      {
        next_sweep_at: new Date(NOW.getTime() + RECURRENCE_SWEEP_INTERVAL_MS),

        sweep_claim_token: null,

        last_sweep_started_at: NOW,

        last_sweep_completed_at: NOW,

        last_sweep_outcome: "success",

        last_sweep_diagnostic: null,
      },
    ]);
  });

  it("records one bad recurrence without preventing another series from materialising", async () => {
    const bad = await createSweepFixture(pool, "995000000000000020", "Bad");

    const good = await createSweepFixture(pool, "995000000000000021", "Good");

    /*
     * Bypass normal template validation deliberately.
     *
     * The sweep must persist an operational failure for this series and then
     * continue processing unrelated due recurrence work.
     */
    await pool.query(
      `
        UPDATE "event_templates"
        SET
          "timezone" = 'Definitely/Not_A_Timezone'
        WHERE
          "id" = $1
      `,
      [bad.templateId],
    );

    const result = await runDueRecurrenceSweeps({
      now: NOW,
    });

    expect(result.claimedCount).toBe(2);

    const badResult = result.results.find(
      (entry) => entry.recurrenceId === bad.recurrenceId,
    );

    const goodResult = result.results.find(
      (entry) => entry.recurrenceId === good.recurrenceId,
    );

    expect(badResult).toMatchObject({
      outcome: "failure",

      generatedCount: 0,

      recorded: true,
    });

    expect(badResult?.diagnostic).toContain("invalid_template_timezone");

    expect(goodResult).toMatchObject({
      outcome: "success",

      generatedCount: 2,

      failedCount: 0,

      recorded: true,
    });

    const stored = await pool.query<{
      id: number;

      last_sweep_outcome: string | null;

      last_sweep_diagnostic: string | null;
    }>(
      `
        SELECT
          "id",
          "last_sweep_outcome",
          "last_sweep_diagnostic"
        FROM
          "event_template_recurrences"
        WHERE
          "id" IN ($1, $2)
        ORDER BY
          "id"
      `,
      [bad.recurrenceId, good.recurrenceId],
    );

    const badStored = stored.rows.find((row) => row.id === bad.recurrenceId);

    const goodStored = stored.rows.find((row) => row.id === good.recurrenceId);

    expect(badStored?.last_sweep_outcome).toBe("failure");

    expect(badStored?.last_sweep_diagnostic).toContain(
      "invalid_template_timezone",
    );

    expect(goodStored).toMatchObject({
      last_sweep_outcome: "success",

      last_sweep_diagnostic: null,
    });

    const goodOccurrenceCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "event_recurrence_occurrences"
        WHERE
          "recurrence_id" = $1
      `,
      [good.recurrenceId],
    );

    expect(goodOccurrenceCount.rows[0]?.count).toBe(2);
  });

  it("does not claim recurrence work for a disabled guild", async () => {
    const fixture = await createSweepFixture(
      pool,
      "995000000000000030",
      "Disabled",
    );

    await pool.query(
      `
        UPDATE "discord_guilds"
        SET
          "enabled" = false
        WHERE
          "id" = $1
      `,
      [fixture.guildId],
    );

    const result = await runDueRecurrenceSweeps({
      now: NOW,
    });

    expect(result).toEqual({
      claimedCount: 0,

      results: [],
    });

    const state = await pool.query<{
      last_sweep_started_at: Date | null;
    }>(
      `
        SELECT
          "last_sweep_started_at"
        FROM
          "event_template_recurrences"
        WHERE
          "id" = $1
      `,
      [fixture.recurrenceId],
    );

    expect(state.rows).toEqual([
      {
        last_sweep_started_at: null,
      },
    ]);
  });

  it("does not steal a fresh claim but recovers it after the lease becomes stale", async () => {
    const fixture = await createSweepFixture(
      pool,
      "995000000000000040",
      "Lease",
    );

    await pool.query(
      `
        UPDATE "event_template_recurrences"
        SET
          "next_sweep_at" = $2,
          "sweep_claim_token" = 'fresh-claim',
          "last_sweep_started_at" = $3
        WHERE
          "id" = $1
      `,
      [
        fixture.recurrenceId,

        new Date(NOW.getTime() - 60_000),

        new Date(NOW.getTime() - 60_000),
      ],
    );

    const fresh = await runDueRecurrenceSweeps({
      now: NOW,
    });

    expect(fresh).toEqual({
      claimedCount: 0,

      results: [],
    });

    await pool.query(
      `
        UPDATE "event_template_recurrences"
        SET
          "last_sweep_started_at" = $2
        WHERE
          "id" = $1
      `,
      [
        fixture.recurrenceId,

        new Date(NOW.getTime() - RECURRENCE_SWEEP_STALE_AFTER_MS - 60_000),
      ],
    );

    const recovered = await runDueRecurrenceSweeps({
      now: NOW,
    });

    expect(recovered.claimedCount).toBe(1);

    expect(recovered.results[0]).toMatchObject({
      recurrenceId: fixture.recurrenceId,

      outcome: "success",

      recorded: true,
    });
  });
});

async function createSweepFixture(
  pool: Pool,
  discordGuildId: string,
  suffix: string,
): Promise<{
  guildId: number;

  templateId: number;

  recurrenceId: number;
}> {
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
        $2
      )
      RETURNING "id"
    `,
    [discordGuildId, `Recurrence Sweep ${suffix}`],
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
        "active"
      )
      VALUES (
        $1,
        'naval',
        'Naval',
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
      INSERT INTO "event_templates" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "timezone",
        "local_start_time",
        "signups_enabled",
        "publication_mode",
        "active",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        'Europe/London',
        '20:00',
        false,
        'manual',
        true,
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, `Recurring Sweep ${suffix}`, ADMIN_USER_ID],
  );

  const templateId = requireId(templateResult.rows[0]?.id, "template");

  const recurrence = await createEventTemplateRecurrence({
    guildDatabaseId: guildId,

    templateId,

    recurrenceRule: "FREQ=WEEKLY",

    startDate: "2099-01-05",

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
