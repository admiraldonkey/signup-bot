import type { Client } from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  startEventScheduler,
  stopEventScheduler,
} from "../../../src/scheduler/event-scheduler.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "300000000000000001";
const ADMIN_USER_ID = "300000000000000002";

describe("event scheduler", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    stopEventScheduler();
    await resetIntegrationDatabase(pool);
  });

  afterEach(() => {
    stopEventScheduler();
  });

  afterAll(async () => {
    stopEventScheduler();

    await pool.end();
    await applicationPool.end();
  });

  it("does not report a successful automatic attendance close after losing the event-state race", async () => {
    // Arrange
    const eventId = await createOpenEventWithDueAttendanceClose(pool);

    const actionResult = await pool.query<{
      id: number;
    }>(
      `
        SELECT "id"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" = 'close_attendance'
      `,
      [eventId],
    );

    const actionId = actionResult.rows[0]?.id;

    if (!actionId) {
      throw new Error("The automatic attendance-close action was not created.");
    }

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Prevent the scheduler's event UPDATE from completing.
       *
       * The scheduler can still:
       * - discover the due action,
       * - claim it,
       * - read the event as "open",
       * - decide that attendance needs closing.
       *
       * Its conditional UPDATE then waits on this row lock.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
          SELECT "id"
          FROM "events"
          WHERE "id" = $1
          FOR UPDATE
        `,
        [eventId],
      );

      /*
       * startEventScheduler() immediately starts one scheduler tick before
       * scheduling future ticks on its interval.
       */
      startEventScheduler(client);

      await waitForBlockedSchedulerEventUpdate(pool);

      /*
       * Another lifecycle transition wins while the automatic close is
       * waiting.
       *
       * The scheduler's UPDATE is already guarded to only match scheduled
       * or open events, so after this commits its UPDATE should affect
       * zero rows.
       */
      await lockClient.query(
        `
          UPDATE "events"
          SET
            "status" = 'cancelled',
            "updated_at" = NOW()
          WHERE "id" = $1
        `,
        [eventId],
      );

      await lockClient.query("COMMIT");

      /*
       * The scheduler action itself remains processing here.
       *
       * Once executeCloseAttendance() returns, the scheduler's normal
       * outer loop should mark the action completed. Waiting for that gives
       * us a deterministic signal that all executor side-effects have
       * finished before we assert.
       */
      await waitForScheduledActionStatus(pool, actionId, "completed");
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
      stopEventScheduler();
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
      [eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    /*
     * The conditional scheduler UPDATE already protects the event row.
     * The competing lifecycle transition must remain authoritative.
     */
    expect(eventResult.rows[0]?.status).toBe("cancelled");

    const completedActionResult = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
    }>(
      `
          SELECT
            "status",
            "attempt_count",
            "locked_at",
            "completed_at"
          FROM "scheduled_actions"
          WHERE "id" = $1
        `,
      [actionId],
    );

    expect(completedActionResult.rows).toHaveLength(1);

    expect(completedActionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(completedActionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * Losing the state transition is a harmless obsolete action, not a
     * successful attendance close.
     *
     * The scheduler action itself may complete normally, but no success
     * audit may claim that attendance was actually closed.
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
          AND "action" = 'scheduler.close_attendance'
          AND "outcome" = 'success'
      `,
      [String(eventId)],
    );

    expect(auditResult.rows).toEqual([]);
  });
});

async function createOpenEventWithDueAttendanceClose(
  pool: Pool,
): Promise<number> {
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
    [DISCORD_GUILD_ID, "Scheduler Integration Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  /*
   * Keep the bot-log channel unset so scheduler audit behaviour remains
   * database-only during this test.
   */
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
        null,
        'open',
        $6
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Scheduler Attendance Close Race",
      new Date(Date.now() + 60 * 60 * 1000),
      new Date(Date.now() - 60 * 1000),
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  await pool.query(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status"
      )
      VALUES (
        $1,
        'close_attendance',
        NOW() - INTERVAL '1 minute',
        'pending'
      )
    `,
    [eventId],
  );

  return eventId;
}

function createSchedulerClient(): Client<true> {
  const client = {
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        id: DISCORD_GUILD_ID,
      }),
    },
  };

  return client as unknown as Client<true>;
}

async function waitForBlockedSchedulerEventUpdate(pool: Pool): Promise<void> {
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
    "Timed out waiting for the automatic attendance-close UPDATE to block on the event row.",
  );
}

async function waitForScheduledActionStatus(
  pool: Pool,
  actionId: number,
  expectedStatus: string,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      status: string;
    }>(
      `
        SELECT "status"
        FROM "scheduled_actions"
        WHERE "id" = $1
      `,
      [actionId],
    );

    if (result.rows[0]?.status === expectedStatus) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for scheduled action #${actionId} to reach status "${expectedStatus}".`,
  );
}
