import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  claimEventOrganiserCover,
  getOrganiserCoverClaimContext,
} from "../../../src/organisers/organiser-cover-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "960000000000000001";
const OTHER_DISCORD_GUILD_ID = "960000000000000002";
const ADMIN_USER_ID = "960000000000000003";
const COVER_USER_ID = "960000000000000004";
const SECOND_COVER_USER_ID = "960000000000000005";
const PRIMARY_USER_ID = "960000000000000006";
const EVENT_ORGANISER_ROLE_ID = "960000000000000007";

describe("organiser cover service", () => {
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

  it("returns the configured organiser role for an eligible cover request", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    // Act
    const result = await getOrganiserCoverClaimContext({
      eventId: fixture.eventId,

      discordGuildId: DISCORD_GUILD_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "eligible",

      event: {
        id: fixture.eventId,

        name: "Organiser Cover Service Test",

        guildDatabaseId: fixture.guildId,

        eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
      },
    });
  });

  it("does not expose a cover request through a different Discord server", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    // Act
    const result = await getOrganiserCoverClaimContext({
      eventId: fixture.eventId,

      discordGuildId: OTHER_DISCORD_GUILD_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "event_unavailable",
    });
  });

  it("creates a confirmed current cover assignment", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    // Act
    const result = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: COVER_USER_ID,

      displayNameSnapshot: "Cover Organiser",
    });

    // Assert
    expect(result).toMatchObject({
      kind: "claimed",
    });

    if (result.kind !== "claimed") {
      throw new Error(
        `Expected cover claim to succeed, received "${result.kind}".`,
      );
    }

    const assignmentResult = await pool.query<{
      slot: string;
      discord_user_id: string;
      display_name_snapshot: string;
      status: string;
      is_current: boolean;
      assigned_by_user_id: string;
      activated_at: Date | null;
      response_deadline_at: Date | null;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "slot",
          "discord_user_id",
          "display_name_snapshot",
          "status",
          "is_current",
          "assigned_by_user_id",
          "activated_at",
          "response_deadline_at",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [result.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    const assignment = assignmentResult.rows[0];

    expect(assignment).toMatchObject({
      slot: "cover",

      discord_user_id: COVER_USER_ID,

      display_name_snapshot: "Cover Organiser",

      status: "confirmed",

      is_current: true,

      assigned_by_user_id: COVER_USER_ID,

      response_deadline_at: null,

      ended_at: null,
    });

    expect(assignment?.activated_at).toBeInstanceOf(Date);

    expect(assignment?.responded_at).toBeInstanceOf(Date);

    /*
     * Cover claims are immediately confirmed, so activation and response
     * represent the same authoritative transition.
     */
    expect(assignment?.responded_at?.getTime()).toBe(
      assignment?.activated_at?.getTime(),
    );
  });

  it("does not claim cover when another active organiser already owns the event", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool, {
      withActivePrimary: true,
    });

    // Act
    const result = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: COVER_USER_ID,

      displayNameSnapshot: "Cover Organiser",
    });

    // Assert
    expect(result).toEqual({
      kind: "active_assignment",
    });

    const coverResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'cover'
      `,
      [fixture.eventId],
    );

    expect(coverResult.rows).toEqual([
      {
        count: 0,
      },
    ]);

    const primaryResult = await pool.query<{
      discord_user_id: string;
      status: string;
      is_current: boolean;
    }>(
      `
        SELECT
          "discord_user_id",
          "status",
          "is_current"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'primary'
      `,
      [fixture.eventId],
    );

    expect(primaryResult.rows).toEqual([
      {
        discord_user_id: PRIMARY_USER_ID,

        status: "confirmed",

        is_current: true,
      },
    ]);
  });

  it("does not claim cover after the event has started", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool, {
      started: true,
    });

    // Act
    const result = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: COVER_USER_ID,

      displayNameSnapshot: "Cover Organiser",
    });

    // Assert
    expect(result).toEqual({
      kind: "event_started",
    });

    const assignmentResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_organiser_assignments"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("allows only one sequential cover claimant to own the event", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    // Act
    const firstResult = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: COVER_USER_ID,

      displayNameSnapshot: "First Cover Organiser",
    });

    const secondResult = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: SECOND_COVER_USER_ID,

      displayNameSnapshot: "Second Cover Organiser",
    });

    // Assert
    expect(firstResult.kind).toBe("claimed");

    expect(secondResult).toEqual({
      kind: "active_assignment",
    });

    const assignmentResult = await pool.query<{
      discord_user_id: string;
      status: string;
      is_current: boolean;
    }>(
      `
        SELECT
          "discord_user_id",
          "status",
          "is_current"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'cover'
        ORDER BY "id"
      `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        discord_user_id: COVER_USER_ID,

        status: "confirmed",

        is_current: true,
      },
    ]);
  });

  it.each(["cancelled", "completed"] as const)(
    "does not create cover when %s wins the event lifecycle race",
    async (terminalStatus) => {
      // Arrange
      const fixture = await createCoverFixture(pool);

      const lockClient = await pool.connect();

      let claimPromise: ReturnType<typeof claimEventOrganiserCover> | undefined;

      try {
        await lockClient.query("BEGIN");

        /*
         * Hold the event lifecycle row before the cover service reaches its
         * authoritative FOR UPDATE check.
         */
        await lockClient.query(
          `
            SELECT "id"
            FROM "events"
            WHERE "id" = $1
            FOR UPDATE
          `,
          [fixture.eventId],
        );

        claimPromise = claimEventOrganiserCover({
          eventId: fixture.eventId,

          organiserUserId: COVER_USER_ID,

          displayNameSnapshot: "Cover Organiser",
        });

        await waitForBlockedCoverEventLock(pool);

        /*
         * The terminal transition becomes authoritative before the cover
         * transaction is allowed to inspect the locked lifecycle state.
         */
        await lockClient.query(
          `
            UPDATE "events"
            SET
              "status" = $2,
              "updated_at" = NOW()
            WHERE "id" = $1
          `,
          [fixture.eventId, terminalStatus],
        );

        await lockClient.query("COMMIT");

        const result = await claimPromise;

        expect(result).toEqual({
          kind: "event_inactive",
        });
      } catch (error: unknown) {
        await lockClient.query("ROLLBACK").catch(() => undefined);

        await claimPromise?.catch(() => undefined);

        throw error;
      } finally {
        lockClient.release();
      }

      // Assert
      const eventResult = await pool.query<{
        status: string;
      }>(
        `
          SELECT "status"
          FROM "events"
          WHERE "id" = $1
        `,
        [fixture.eventId],
      );

      expect(eventResult.rows).toEqual([
        {
          status: terminalStatus,
        },
      ]);

      const assignmentResult = await pool.query<{
        count: number;
      }>(
        `
          SELECT COUNT(*)::int AS "count"
          FROM "event_organiser_assignments"
          WHERE "event_id" = $1
        `,
        [fixture.eventId],
      );

      expect(assignmentResult.rows).toEqual([
        {
          count: 0,
        },
      ]);
    },
  );

  it("does not expose cover eligibility when organisers are disabled", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    await pool.query(
      `
      UPDATE "guild_settings"
      SET
        "organisers_enabled" = false,
        "updated_at" = NOW()
      WHERE "guild_id" = $1
    `,
      [fixture.guildId],
    );

    // Act
    const result = await getOrganiserCoverClaimContext({
      eventId: fixture.eventId,

      discordGuildId: DISCORD_GUILD_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "organisers_disabled",
    });
  });

  it("does not create a cover assignment when organisers are disabled", async () => {
    // Arrange
    const fixture = await createCoverFixture(pool);

    await pool.query(
      `
      UPDATE "guild_settings"
      SET
        "organisers_enabled" = false,
        "updated_at" = NOW()
      WHERE "guild_id" = $1
    `,
      [fixture.guildId],
    );

    // Act
    const result = await claimEventOrganiserCover({
      eventId: fixture.eventId,

      organiserUserId: COVER_USER_ID,

      displayNameSnapshot: "Cover Organiser",
    });

    // Assert
    expect(result).toEqual({
      kind: "organisers_disabled",
    });

    const assignmentResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'cover'
      `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });
});

async function createCoverFixture(
  pool: Pool,
  options: {
    started?: boolean;

    withActivePrimary?: boolean;
  } = {},
): Promise<{
  guildId: number;

  eventId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, $2)
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID, "Organiser Cover Service Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "event_organiser_role_id"
      )
      VALUES ($1, $2)
    `,
    [guildId, EVENT_ORGANISER_ROLE_ID],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name"
      )
      VALUES ($1, $2, $3)
      RETURNING "id"
    `,
    [guildId, "naval", "Naval Event"],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const startsAt = options.started
    ? new Date(Date.now() - 5 * 60 * 1000)
    : new Date(Date.now() + 2 * 60 * 60 * 1000);

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "starts_at",
        "signups_enabled",
        "published_at",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        true,
        NOW(),
        'open',
        $5
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Organiser Cover Service Test",
      startsAt,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  if (options.withActivePrimary) {
    await pool.query(
      `
        INSERT INTO "event_organiser_assignments" (
          "event_id",
          "slot",
          "discord_user_id",
          "display_name_snapshot",
          "status",
          "is_current",
          "assigned_by_user_id",
          "activated_at",
          "responded_at"
        )
        VALUES (
          $1,
          'primary',
          $2,
          'Existing Primary Organiser',
          'confirmed',
          true,
          $3,
          NOW(),
          NOW()
        )
      `,
      [eventId, PRIMARY_USER_ID, ADMIN_USER_ID],
    );
  }

  return {
    guildId,

    eventId,
  };
}

async function waitForBlockedCoverEventLock(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
      SELECT EXISTS (
        SELECT 1
        FROM "pg_stat_activity"
        WHERE
          "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE '%"events"%'
          AND "query" ILIKE '%for update%'
      ) AS "blocked"
    `);

    if (result.rows[0]?.blocked) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    "Timed out waiting for the organiser cover service to block on the event lifecycle row.",
  );
}
