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

const DISCORD_GUILD_ID = "400000000000000001";
const ADMIN_USER_ID = "400000000000000002";

describe("scheduler retry and recovery", () => {
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

  it("does not give a stale processing action a sixth attempt after the maximum attempt count was already reached", async () => {
    // Arrange
    const fixture = await createStaleProcessingAction(pool, 5);

    /*
     * No Discord functionality is needed for this regression.
     *
     * The deliberately-invalid action key will throw inside the scheduler
     * dispatcher if stale recovery incorrectly makes it executable again.
     */
    const client = {} as Client<true>;

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "failed");

    stopEventScheduler();

    // Assert
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
        SELECT
          "status",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        FROM "scheduled_actions"
        WHERE "id" = $1
      `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    const action = result.rows[0];

    /*
     * Five claimed attempts have already occurred.
     *
     * Recovering an interrupted fifth attempt must not return the action
     * to pending and allow claimAction() to increment it to six.
     */
    expect.soft(action?.attempt_count).toBe(5);

    expect.soft(action?.status).toBe("failed");

    expect.soft(action?.locked_at).toBeNull();

    expect.soft(action?.completed_at).toBeNull();

    /*
     * The failure should describe interrupted processing rather than an
     * error from executing the action for an impermissible sixth time.
     */
    expect.soft(action?.last_error).toContain("interrupted processing");

    expect
      .soft(action?.last_error)
      .not.toContain("Unknown scheduled action key");
  });

  it("recovers a stale fourth attempt and gives it exactly one final fifth attempt", async () => {
    // Arrange
    const fixture = await createStaleProcessingAction(pool, 4);

    /*
     * The invalid key makes execution fail deterministically once the
     * recovered action is claimed. That lets us observe that attempt 5
     * genuinely occurred without involving Discord or a domain executor.
     */
    const client = {} as Client<true>;

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "failed");

    stopEventScheduler();

    // Assert
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "locked_at",
        "completed_at",
        "last_error"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    const action = result.rows[0];

    /*
     * Attempt 4 was interrupted. Recovery should return it to pending and
     * claimAction() should consume the one remaining permitted attempt.
     */
    expect.soft(action?.attempt_count).toBe(5);

    /*
     * The deliberately-invalid action then fails on that final attempt, so
     * normal retry handling should make the action terminal.
     */
    expect.soft(action?.status).toBe("failed");

    expect.soft(action?.locked_at).toBeNull();

    expect.soft(action?.completed_at).toBeNull();

    /*
     * The final error should come from actually executing attempt 5.
     * This distinguishes successful stale recovery from simply marking the
     * fourth attempt failed during recovery.
     */
    expect.soft(action?.last_error).toContain("Unknown scheduled action key");

    expect
      .soft(action?.last_error)
      .not.toContain("maximum attempt count had already been reached");
  });

  it("does not execute an exhausted action which is already pending at the maximum attempt count", async () => {
    // Arrange
    const fixture = await createDuePendingFailingAction(pool, 5);

    /*
     * If the scheduler incorrectly claims this action, the invalid key makes
     * that sixth execution immediately visible in both attempt_count and
     * last_error.
     */
    const client = {} as Client<true>;

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "failed");

    stopEventScheduler();

    // Assert
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "locked_at",
        "completed_at",
        "last_error"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    const action = result.rows[0];

    /*
     * Five attempts have already been consumed.
     *
     * Merely being pending must not entitle the action to another claim.
     */
    expect.soft(action?.attempt_count).toBe(5);

    expect.soft(action?.status).toBe("failed");

    expect.soft(action?.locked_at).toBeNull();

    expect.soft(action?.completed_at).toBeNull();

    /*
     * This should be terminalised as an exhausted scheduler action without
     * executing its payload for an impermissible sixth time.
     */
    expect.soft(action?.last_error).toContain("maximum attempt count");

    expect
      .soft(action?.last_error)
      .not.toContain("Unknown scheduled action key");
  });

  it.each([
    {
      initialAttemptCount: 0,
      expectedAttemptCount: 1,
      retryDelayMinutes: 1,
    },
    {
      initialAttemptCount: 1,
      expectedAttemptCount: 2,
      retryDelayMinutes: 2,
    },
    {
      initialAttemptCount: 2,
      expectedAttemptCount: 3,
      retryDelayMinutes: 4,
    },
    {
      initialAttemptCount: 3,
      expectedAttemptCount: 4,
      retryDelayMinutes: 8,
    },
  ])(
    "reschedules failed attempt $expectedAttemptCount with a $retryDelayMinutes-minute retry delay",
    async ({
      initialAttemptCount,
      expectedAttemptCount,
      retryDelayMinutes,
    }) => {
      // Arrange
      const fixture = await createDuePendingFailingAction(
        pool,
        initialAttemptCount,
      );

      const client = {} as Client<true>;

      /*
       * handleActionFailure() calculates retryAt using its own current time.
       * Capture a window around scheduler execution rather than asserting an
       * exact millisecond timestamp.
       */
      const executionStartedAt = new Date();

      // Act
      startEventScheduler(client);

      await waitForScheduledActionAttempt(
        pool,
        fixture.actionId,
        expectedAttemptCount,
        "pending",
      );

      const executionFinishedAt = new Date();

      stopEventScheduler();

      // Assert
      const result = await pool.query<{
        status: string;
        attempt_count: number;
        due_at: Date;
        locked_at: Date | null;
        completed_at: Date | null;
        last_error: string | null;
      }>(
        `
          SELECT
            "status",
            "attempt_count",
            "due_at",
            "locked_at",
            "completed_at",
            "last_error"
          FROM "scheduled_actions"
          WHERE "id" = $1
        `,
        [fixture.actionId],
      );

      expect(result.rows).toHaveLength(1);

      const action = result.rows[0];

      expect.soft(action?.status).toBe("pending");

      expect.soft(action?.attempt_count).toBe(expectedAttemptCount);

      expect.soft(action?.locked_at).toBeNull();

      expect.soft(action?.completed_at).toBeNull();

      expect.soft(action?.last_error).toContain("Unknown scheduled action key");

      const expectedDelayMs = retryDelayMinutes * 60_000;

      const earliestRetryAt = executionStartedAt.getTime() + expectedDelayMs;

      const latestRetryAt = executionFinishedAt.getTime() + expectedDelayMs;

      /*
       * The scheduler's failure timestamp must have occurred somewhere
       * between executionStartedAt and executionFinishedAt.
       */
      expect(action?.due_at.getTime()).toBeGreaterThanOrEqual(earliestRetryAt);

      expect(action?.due_at.getTime()).toBeLessThanOrEqual(latestRetryAt);
    },
  );

  it("makes an ordinary fifth execution failure terminal instead of scheduling another retry", async () => {
    // Arrange
    const fixture = await createDuePendingFailingAction(pool, 4);

    const client = {} as Client<true>;

    // Act
    startEventScheduler(client);

    await waitForScheduledActionAttempt(pool, fixture.actionId, 5, "failed");

    stopEventScheduler();

    // Assert
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      due_at: Date;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "due_at",
        "locked_at",
        "completed_at",
        "last_error"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    const action = result.rows[0];

    expect.soft(action?.status).toBe("failed");

    expect.soft(action?.attempt_count).toBe(5);

    expect.soft(action?.locked_at).toBeNull();

    expect.soft(action?.completed_at).toBeNull();

    expect.soft(action?.last_error).toContain("Unknown scheduled action key");

    /*
     * A terminal fifth failure is not rescheduled. Its original due time
     * remains in the past.
     */
    expect(action?.due_at.getTime()).toBeLessThan(Date.now());
  });
});

async function createStaleProcessingAction(
  pool: Pool,
  attemptCount: number,
): Promise<{
  eventId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Retry Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

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
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Scheduler Retry Test Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  /*
   * Simulate a process which crashed while this action was being executed.
   *
   * The lock is older than the scheduler's five-minute stale threshold, so
   * recoverStaleActions() will decide whether the action may be retried or
   * has already exhausted its permitted attempts.
   */
  const actionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at"
        )
        VALUES (
          $1,
          'integration_test_invalid_action',
          NOW() - INTERVAL '10 minutes',
          'processing',
          $2,
          NOW() - INTERVAL '6 minutes'
        )
        RETURNING "id"
      `,
    [eventId, attemptCount],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The stale integration-test action was not created.");
  }

  return {
    eventId,
    actionId,
  };
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

async function waitForScheduledActionAttempt(
  pool: Pool,
  actionId: number,
  expectedAttemptCount: number,
  expectedStatus: "pending" | "failed",
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      status: string;
      attempt_count: number;
    }>(
      `
          SELECT
            "status",
            "attempt_count"
          FROM "scheduled_actions"
          WHERE "id" = $1
        `,
      [actionId],
    );

    const action = result.rows[0];

    if (
      action?.attempt_count === expectedAttemptCount &&
      action.status === expectedStatus
    ) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for scheduled action #${actionId} to reach attempt ${expectedAttemptCount} with status "${expectedStatus}".`,
  );
}

async function createDuePendingFailingAction(
  pool: Pool,
  attemptCount: number,
): Promise<{
  eventId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Pending Retry Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

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
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Pending Exhausted Action Test Event",
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  /*
   * Create due pending work at a chosen retry count.
   *
   * The invalid action key makes execution fail deterministically, allowing
   * the tests to observe the real claim and failure-handling behaviour
   * without involving Discord or a domain-specific executor.
   */
  const actionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at"
        )
        VALUES (
        $1,
        'integration_test_invalid_action',
        NOW() - INTERVAL '1 minute',
        'pending',
        $2,
        null
        )
        RETURNING "id"
      `,
    [eventId, attemptCount],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The exhausted pending action was not created.");
  }

  return {
    eventId,
    actionId,
  };
}
