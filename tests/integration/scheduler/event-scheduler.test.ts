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
const roleRequestMessageMocks = vi.hoisted(() => ({
  refreshRoleRequestGroupMessage: vi.fn().mockResolvedValue(undefined),

  refreshRoleRequestMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/role-requests/role-request-message.js", () => ({
  refreshRoleRequestGroupMessage:
    roleRequestMessageMocks.refreshRoleRequestGroupMessage,

  refreshRoleRequestMessages:
    roleRequestMessageMocks.refreshRoleRequestMessages,
}));
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

    roleRequestMessageMocks.refreshRoleRequestGroupMessage.mockClear();
    roleRequestMessageMocks.refreshRoleRequestMessages.mockClear();
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

  it("treats a due role-request group close as obsolete after the event has completed", async () => {
    // Arrange
    const fixture = await createEventWithDueRoleGroupClose(pool, "completed");

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    /*
     * A terminal parent event makes this group-close action obsolete.
     *
     * The action itself should still complete normally so it is not retried,
     * but it must not mutate the role-request group or perform success
     * side-effects.
     */
    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

    // Assert
    const groupResult = await pool.query<{
      closed_at: Date | null;
    }>(
      `
      SELECT "closed_at"
      FROM "role_request_groups"
      WHERE "id" = $1
    `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toHaveLength(1);

    /*
     * The event was already completed before this scheduler action ran.
     * There is no live role-request lifecycle left for this action to close.
     */
    expect.soft(groupResult.rows[0]?.closed_at).toBeNull();

    const actionResult = await pool.query<{
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
      [fixture.actionId],
    );

    expect(actionResult.rows).toHaveLength(1);

    expect.soft(actionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * Discord should not be refreshed for lifecycle work which became
     * obsolete when the parent event completed.
     */
    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestGroupMessage)
      .not.toHaveBeenCalled();

    /*
     * Nor should an obsolete action claim that it successfully closed
     * the group.
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
        "target_type" = 'role_request_group'
        AND "target_id" = $1
        AND "action" = 'scheduler.role_group_close'
        AND "outcome" = 'success'
    `,
      [String(fixture.groupId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("does not close a role-request group when the event completes after the scheduler reads it", async () => {
    // Arrange
    const fixture = await createEventWithDueRoleGroupClose(pool, "open");

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Hold the role-request group row.
       *
       * A normal SELECT can still read the group and its currently-open
       * parent event, so the scheduler will pass its terminal-state guard.
       * Its later UPDATE of the group must then wait here.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
        SELECT "id"
        FROM "role_request_groups"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [fixture.groupId],
      );

      /*
       * The scheduler claims the due action and reads the parent event
       * while it is still "open".
       */
      startEventScheduler(client);

      await waitForBlockedSchedulerRoleGroupUpdate(pool);

      /*
       * Completion wins after the scheduler's read but before its stale
       * role-group UPDATE is allowed to proceed.
       */
      await lockClient.query(
        `
        UPDATE "events"
        SET
          "status" = 'completed',
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
        [fixture.eventId],
      );

      await lockClient.query("COMMIT");

      /*
       * Releasing the group lock allows the stale scheduler operation to
       * continue. Once the durable action is completed, all executor
       * side-effects have finished and the assertions are deterministic.
       */
      await waitForScheduledActionStatus(pool, fixture.actionId, "completed");
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
      [fixture.eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    /*
     * Completion won the lifecycle race and remains authoritative.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("completed");

    const groupResult = await pool.query<{
      closed_at: Date | null;
    }>(
      `
      SELECT "closed_at"
      FROM "role_request_groups"
      WHERE "id" = $1
    `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toHaveLength(1);

    /*
     * The scheduler made its close decision using stale "open" state.
     * It must not mutate the group after completion has won.
     */
    expect.soft(groupResult.rows[0]?.closed_at).toBeNull();

    const actionResult = await pool.query<{
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
      [fixture.actionId],
    );

    expect(actionResult.rows).toHaveLength(1);

    /*
     * Losing the domain race makes the action obsolete, not retryable.
     */
    expect.soft(actionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * No Discord work should be performed for the stale close.
     */
    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestGroupMessage)
      .not.toHaveBeenCalled();

    /*
     * Nor may it claim a successful role-group close.
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
        "target_type" = 'role_request_group'
        AND "target_id" = $1
        AND "action" = 'scheduler.role_group_close'
        AND "outcome" = 'success'
    `,
      [String(fixture.groupId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
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

async function waitForBlockedSchedulerRoleGroupUpdate(
  pool: Pool,
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
          AND query ILIKE '%update "role_request_groups"%'
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
    "Timed out waiting for the role-request group close UPDATE to block on the group row.",
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

async function createEventWithDueRoleGroupClose(
  pool: Pool,
  status: "open" | "completed",
): Promise<{
  eventId: number;
  groupId: number;
  actionId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Role Request Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  /*
   * Keep the bot-log channel unset so successful/obsolete scheduler
   * behaviour can be asserted from PostgreSQL without needing Discord.
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
        "published_at",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() - INTERVAL '2 hours',
        true,
        NOW() - INTERVAL '3 hours',
        $4,
        $5
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Role Request Scheduler Test Event",
      status,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const groupResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "role_request_groups" (
        "event_id",
        "name",
        "channel_id",
        "requires_positive_signup",
        "opens_at",
        "close_minutes_before_start",
        "closes_at",
        "closed_at",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        false,
        NOW() - INTERVAL '3 hours',
        0,
        NOW() - INTERVAL '2 hours',
        null,
        $4
      )
      RETURNING "id"
    `,
    [
      eventId,
      "Completed Event Role Requests",
      "300000000000000003",
      ADMIN_USER_ID,
    ],
  );

  const groupId = groupResult.rows[0]?.id;

  if (!groupId) {
    throw new Error("The integration-test role-request group was not created.");
  }

  const actionResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status"
      )
      VALUES (
        $1,
        $2,
        NOW() - INTERVAL '1 minute',
        'pending'
      )
      RETURNING "id"
    `,
    [eventId, `role_request_group_close:${groupId}`],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The role-request group close action was not created.");
  }

  return {
    eventId,
    groupId,
    actionId,
  };
}
