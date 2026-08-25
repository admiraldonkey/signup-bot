import type { ChatInputCommandInteraction } from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { handleEventCommand } from "../../../src/commands/event.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "200000000000000001";
const ADMIN_USER_ID = "200000000000000002";

describe("event lifecycle", () => {
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

  it("does not allow a stale attendance close to overwrite cancellation", async () => {
    // Arrange
    const event = await createPublishedSignupEvent(pool, "open");

    const interaction = createEventCommandInteraction("close", event.id);

    const lockClient = await pool.connect();

    try {
      /*
       * Hold a row-level lock on the event.
       *
       * A normal SELECT from /event close can still read the currently
       * committed "open" version, but its later UPDATE must wait for this
       * transaction to release the row.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
          SELECT "id"
          FROM "events"
          WHERE "id" = $1
          FOR UPDATE
        `,
        [event.id],
      );

      /*
       * Start the real command.
       *
       * It will read the event as open, pass its status checks, and then
       * block when it reaches its UPDATE because we still hold the row lock.
       */
      const closePromise = handleEventCommand(interaction);

      await waitForBlockedEventUpdate(pool, "close");

      /*
       * Cancellation wins while the stale close operation is waiting.
       *
       * This direct UPDATE deliberately represents the competing terminal
       * state transition. The thing under test is whether the already-started
       * close operation is allowed to overwrite that newer state.
       */
      await lockClient.query(
        `
          UPDATE "events"
          SET
            "status" = 'cancelled',
            "updated_at" = NOW()
          WHERE "id" = $1
        `,
        [event.id],
      );

      await lockClient.query("COMMIT");

      /*
       * Releasing the lock now allows the stale /event close UPDATE to
       * continue.
       */
      await closePromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const eventResult = await pool.query<{
      status: string;
      attendance_closes_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "attendance_closes_at"
        FROM "events"
        WHERE "id" = $1
      `,
      [event.id],
    );

    expect(eventResult.rows).toHaveLength(1);

    const storedEvent = eventResult.rows[0];

    /*
     * Cancellation is a terminal administrative state.
     * The stale close must not replace it with "closed".
     */
    expect.soft(storedEvent?.status).toBe("cancelled");

    /*
     * A close operation which lost the race must also not apply its
     * attendance-closing timestamp.
     */
    expect
      .soft(storedEvent?.attendance_closes_at?.getTime())
      .toBe(event.originalAttendanceClosesAt.getTime());

    /*
     * Nor should a stale operation which did not actually close the event
     * record a successful close in the authoritative audit log.
     */
    const auditResult = await pool.query<{
      action: string;
      outcome: string;
    }>(
      `
        SELECT
          "action",
          "outcome"
        FROM "audit_logs"
        WHERE
          "target_type" = 'event'
          AND "target_id" = $1
          AND "action" = 'event.close'
          AND "outcome" = 'success'
      `,
      [String(event.id)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("does not allow a stale attendance reopen to overwrite cancellation", async () => {
    // Arrange
    const event = await createPublishedSignupEvent(pool, "closed");

    const interaction = createEventCommandInteraction("reopen", event.id);

    const lockClient = await pool.connect();

    try {
      /*
       * Hold the event row so /event reopen can read the currently
       * committed "closed" state but must wait when it tries to update it.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
        SELECT "id"
        FROM "events"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [event.id],
      );

      /*
       * Start the real /event reopen command.
       *
       * It sees the event as closed, passes its checks, calculates a new
       * attendance deadline, then blocks on the UPDATE.
       */
      const reopenPromise = handleEventCommand(interaction);

      await waitForBlockedEventUpdate(pool, "reopen");

      /*
       * Cancellation wins before the stale reopen can apply its update.
       */
      await lockClient.query(
        `
        UPDATE "events"
        SET
          "status" = 'cancelled',
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
        [event.id],
      );

      await lockClient.query("COMMIT");

      /*
       * The stale reopen is now allowed to continue.
       */
      await reopenPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const eventResult = await pool.query<{
      status: string;
      attendance_closes_at: Date | null;
    }>(
      `
      SELECT
        "status",
        "attendance_closes_at"
      FROM "events"
      WHERE "id" = $1
    `,
      [event.id],
    );

    expect(eventResult.rows).toHaveLength(1);

    const storedEvent = eventResult.rows[0];

    /*
     * Cancellation is final. A reopen command which made its decision
     * using stale state must not restore the event to "open".
     */
    expect.soft(storedEvent?.status).toBe("cancelled");

    /*
     * The losing reopen must not replace the previous attendance deadline.
     */
    expect
      .soft(storedEvent?.attendance_closes_at?.getTime())
      .toBe(event.originalAttendanceClosesAt.getTime());

    /*
     * Reopening normally schedules a new automatic attendance close.
     * A stale reopen which lost to cancellation must create no such work.
     */
    const scheduledActionResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
      SELECT
        "action_key",
        "status"
      FROM "scheduled_actions"
      WHERE
        "event_id" = $1
        AND "action_key" = 'close_attendance'
    `,
      [event.id],
    );

    expect.soft(scheduledActionResult.rows).toEqual([]);

    /*
     * Nor may the losing command record a successful reopen.
     */
    const auditResult = await pool.query<{
      action: string;
      outcome: string;
    }>(
      `
      SELECT
        "action",
        "outcome"
      FROM "audit_logs"
      WHERE
        "target_type" = 'event'
        AND "target_id" = $1
        AND "action" = 'event.reopen'
        AND "outcome" = 'success'
    `,
      [String(event.id)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });
});

async function createPublishedSignupEvent(
  pool: Pool,
  status: "open" | "closed",
): Promise<{
  id: number;
  originalAttendanceClosesAt: Date;
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
    [DISCORD_GUILD_ID, "Lifecycle Integration Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id"
      )
      VALUES ($1)
    `,
    [guildId],
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

  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const attendanceClosesAt = new Date(Date.now() + 6 * 60 * 60 * 1000);

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
        "attendance_closes_at",
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
        $5,
        NOW(),
        $6,
        $7
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Lifecycle Race Test Event",
      startsAt,
      attendanceClosesAt,
      status,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  return {
    id: eventId,
    originalAttendanceClosesAt: attendanceClosesAt,
  };
}

function createEventCommandInteraction(
  subcommand: "close" | "reopen",
  eventId: number,
): ChatInputCommandInteraction {
  const interaction = {
    inCachedGuild: () => true,

    deferReply: vi.fn().mockResolvedValue(undefined),

    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,
    },

    user: {
      id: ADMIN_USER_ID,
    },

    member: {
      permissions: {
        has: () => true,
      },

      roles: {
        cache: {
          has: () => false,
        },
      },
    },

    options: {
      getSubcommand: () => subcommand,

      getInteger: (name: string) => (name === "event-id" ? eventId : null),
    },

    editReply: vi.fn().mockResolvedValue(undefined),
  };

  return interaction as unknown as ChatInputCommandInteraction;
}

async function waitForBlockedEventUpdate(
  pool: Pool,
  commandName: "close" | "reopen",
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE
          datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE '%update "events"%'
      ) AS blocked
    `);

    if (result.rows[0]?.blocked) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for /event ${commandName} to block on the event row lock.`,
  );
}
