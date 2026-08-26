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
const eventCustomMessageMocks = vi.hoisted(() => ({
  sendEventCustomMessage: vi.fn(),
}));

vi.mock("../../../src/events/event-custom-message.js", () => ({
  sendEventCustomMessage: eventCustomMessageMocks.sendEventCustomMessage,
}));
import {
  claimAction,
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
    eventCustomMessageMocks.sendEventCustomMessage.mockReset();
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

  it.each([
    {
      initialAttemptCount: 0,
      claimedAttemptCount: 1,
    },
    {
      initialAttemptCount: 4,
      claimedAttemptCount: 5,
    },
  ])(
    "preserves cancellation when claimed attempt $claimedAttemptCount fails after another actor cancels it",
    async ({ initialAttemptCount, claimedAttemptCount }) => {
      // Arrange
      const fixture = await createDueFailingReminderAction(
        pool,
        initialAttemptCount,
      );

      const delivery = createBlockedFailingReminderDelivery();

      const client = createSchedulerClient();

      const lockClient = await pool.connect();

      try {
        // Act
        startEventScheduler(client);

        /*
         * By the time the notification boundary is reached, claimAction()
         * has committed and the action is genuinely "processing".
         */
        await delivery.waitUntilStarted();

        const processingResult = await pool.query<{
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
          [fixture.actionId],
        );

        expect(processingResult.rows[0]).toMatchObject({
          status: "processing",
          attempt_count: claimedAttemptCount,
        });

        /*
         * Take ownership of the scheduler-action row and cancel it while its
         * executor remains suspended at the external delivery boundary.
         */
        await lockClient.query("BEGIN");

        await lockClient.query(
          `
          SELECT "id"
          FROM "scheduled_actions"
          WHERE "id" = $1
          FOR UPDATE
        `,
          [fixture.actionId],
        );

        await lockClient.query(
          `
          UPDATE "scheduled_actions"
          SET
            "status" = 'cancelled',
            "locked_at" = null,
            "last_error" = $2,
            "updated_at" = NOW()
          WHERE "id" = $1
        `,
          [fixture.actionId, "Cancelled while executor was in flight."],
        );

        /*
         * Let the external operation fail.
         *
         * handleActionFailure() will now try to update the same scheduler row,
         * but must wait for our transaction first.
         */
        delivery.release();

        const failureUpdatePid =
          await waitForBlockedSchedulerActionUpdate(pool);

        /*
         * Cancellation commits first.
         *
         * PostgreSQL should then re-evaluate handleActionFailure()'s
         * `status = processing` predicate and update zero rows.
         */
        await lockClient.query("COMMIT");

        await waitForDatabaseQueryToFinish(pool, failureUpdatePid);
      } catch (error) {
        delivery.release();

        await lockClient.query("ROLLBACK").catch(() => undefined);

        throw error;
      } finally {
        lockClient.release();
        stopEventScheduler();
      }

      // Assert
      const actionResult = await pool.query<{
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

      expect(actionResult.rows).toHaveLength(1);

      const action = actionResult.rows[0];

      /*
       * The newer cancellation owns the durable action.
       *
       * Attempt 1 must not be rescheduled to pending, and attempt 5 must not
       * overwrite cancellation with failed.
       */
      expect.soft(action?.status).toBe("cancelled");

      expect.soft(action?.attempt_count).toBe(claimedAttemptCount);

      expect.soft(action?.locked_at).toBeNull();

      expect.soft(action?.completed_at).toBeNull();

      expect
        .soft(action?.last_error)
        .toBe("Cancelled while executor was in flight.");

      /*
       * Failure handling must not alter the retry deadline after losing
       * ownership of the action.
       */
      expect(action?.due_at.getTime()).toBe(fixture.originalDueAt.getTime());

      const reminderResult = await pool.query<{
        sent_at: Date | null;
      }>(
        `
          SELECT "sent_at"
          FROM "event_reminders"
          WHERE "id" = $1
        `,
        [fixture.reminderId],
      );

      expect(reminderResult.rows[0]?.sent_at).toBeNull();
    },
  );

  it("allows only one worker to claim the same pending action", async () => {
    // Arrange
    const fixture = await createDuePendingFailingAction(pool, 0);

    /*
     * Two independent scheduler workers may both discover the same due row.
     *
     * claimAction() is the authoritative ownership boundary, so race two
     * calls against the same persisted action without serialising them in
     * the test.
     */
    // Act
    const [firstClaim, secondClaim] = await Promise.all([
      claimAction(fixture.actionId),
      claimAction(fixture.actionId),
    ]);

    // Assert
    const successfulClaims = [firstClaim, secondClaim].filter(
      (claim): claim is NonNullable<typeof claim> => claim !== null,
    );

    expect(successfulClaims).toHaveLength(1);

    expect(successfulClaims[0]).toMatchObject({
      id: fixture.actionId,
      eventId: fixture.eventId,
      attemptCount: 1,
    });

    const failedClaims = [firstClaim, secondClaim].filter(
      (claim) => claim === null,
    );

    expect(failedClaims).toHaveLength(1);

    /*
     * Most importantly, the database must show one consumed attempt and one
     * owner. Competing discovery must not increment the counter twice.
     */
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "locked_at"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]).toMatchObject({
      status: "processing",
      attempt_count: 1,
    });

    expect(result.rows[0]?.locked_at).toBeInstanceOf(Date);
  });

  it("refuses to claim a pending action which has already exhausted its attempts", async () => {
    // Arrange
    const fixture = await createDuePendingFailingAction(pool, 5);

    // Act
    const claim = await claimAction(fixture.actionId);

    // Assert
    expect(claim).toBeNull();

    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "locked_at"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(result.rows).toEqual([
      {
        status: "pending",
        attempt_count: 5,
        locked_at: null,
      },
    ]);
  });

  it("does not let a stale failed attempt reschedule a newer claimed attempt", async () => {
    // Arrange
    const fixture = await createDueFailingReminderAction(pool, 0);

    const delivery = createBlockedFailingReminderDelivery();

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Worker A claims attempt 1 and then remains suspended at the external
       * delivery boundary.
       */
      startEventScheduler(client);

      await delivery.waitUntilStarted();

      const firstClaimResult = await pool.query<{
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
        [fixture.actionId],
      );

      expect(firstClaimResult.rows[0]).toMatchObject({
        status: "processing",
        attempt_count: 1,
      });

      /*
       * Simulate another scheduler process deciding that Worker A's lock has
       * become stale.
       *
       * We perform the recovery transition directly so the test does not need
       * to wait five real minutes merely to prove that clocks exist.
       */
      await pool.query(
        `
        UPDATE "scheduled_actions"
        SET
          "status" = 'pending',
          "locked_at" = null,
          "last_error" = $2,
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
        [fixture.actionId, "Simulated stale recovery before second claim."],
      );

      /*
       * Worker B now claims the recovered action as attempt 2.
       */
      const secondClaim = await claimAction(fixture.actionId);

      expect(secondClaim).toMatchObject({
        id: fixture.actionId,
        eventId: fixture.eventId,
        attemptCount: 2,
      });

      /*
       * Hold Worker B's newly-claimed row while Worker A is allowed to fail.
       * This gives us a deterministic barrier around A's failure UPDATE.
       */
      await lockClient.query("BEGIN");

      /*
       * Use a table-level lock rather than a row lock for this barrier.
       *
       * With attempt ownership correctly included in handleActionFailure()'s
       * predicate, PostgreSQL can reject stale attempt 1 after observing that
       * the persisted row belongs to attempt 2. In that case it never needs to
       * acquire a row lock, so SELECT ... FOR UPDATE is no longer a reliable
       * synchronization point.
       *
       * A table lock pauses the UPDATE before it can evaluate that ownership
       * predicate, giving the test a deterministic signal that Worker A has
       * reached failure handling.
       */
      await lockClient.query(
        `
    LOCK TABLE "scheduled_actions"
    IN ACCESS EXCLUSIVE MODE
  `,
      );

      /*
       * Worker A's external operation now fails and proceeds into
       * handleActionFailure().
       */
      delivery.release();

      const failureUpdatePid = await waitForBlockedSchedulerActionUpdate(pool);

      /*
       * Allow failure handling to continue.
       *
       * Once PostgreSQL evaluates the UPDATE predicate, attempt 1 must lose
       * ownership because the persisted action is already attempt 2.
       */
      await lockClient.query("COMMIT");

      await waitForDatabaseQueryToFinish(pool, failureUpdatePid);
    } catch (error) {
      delivery.release();

      await lockClient.query("ROLLBACK").catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();

      stopEventScheduler();
    }

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

    /*
     * Attempt 2 is now the current owner. Attempt 1's eventual failure must
     * not reschedule, unlock or otherwise overwrite it.
     */
    expect.soft(action?.status).toBe("processing");

    expect.soft(action?.attempt_count).toBe(2);

    expect.soft(action?.locked_at).toBeInstanceOf(Date);

    expect.soft(action?.completed_at).toBeNull();

    expect.soft(action?.due_at.getTime()).toBe(fixture.originalDueAt.getTime());

    expect
      .soft(action?.last_error)
      .toBe("Simulated stale recovery before second claim.");

    expect
      .soft(action?.last_error)
      .not.toContain("Integration reminder delivery failure");
  });

  it("does not let a stale successful attempt complete a newer claimed attempt", async () => {
    // Arrange
    const fixture = await createDueFailingReminderAction(pool, 0);

    const delivery = createBlockedSuccessfulReminderDelivery();

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Worker A claims attempt 1 and pauses while sending the reminder.
       */
      startEventScheduler(client);

      await delivery.waitUntilStarted();

      const firstClaimResult = await pool.query<{
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
        [fixture.actionId],
      );

      expect(firstClaimResult.rows[0]).toMatchObject({
        status: "processing",
        attempt_count: 1,
      });

      /*
       * Hold the scheduler-action table while simulating another scheduler
       * process recovering the stale first attempt and claiming attempt 2.
       *
       * We only need to reproduce the resulting persisted ownership state
       * here. Stale recovery and claimAction() are covered separately.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
        LOCK TABLE "scheduled_actions"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      await lockClient.query(
        `
        UPDATE "scheduled_actions"
        SET
          "status" = 'processing',
          "attempt_count" = 2,
          "locked_at" = NOW(),
          "last_error" = $2,
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
        [fixture.actionId, "Simulated stale recovery and second claim."],
      );

      /*
       * Worker A now completes its external work successfully.
       *
       * Once executeAction() returns it will call markActionCompleted(), whose
       * UPDATE is forced to wait on our table lock.
       */
      delivery.release();

      const completionUpdatePid =
        await waitForBlockedSchedulerActionUpdate(pool);

      /*
       * Commit attempt 2 as the current persisted owner, then let Worker A's
       * stale completion UPDATE continue.
       */
      await lockClient.query("COMMIT");

      await waitForDatabaseQueryToFinish(pool, completionUpdatePid);
    } catch (error) {
      delivery.release();

      await lockClient.query("ROLLBACK").catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();

      stopEventScheduler();
    }

    // Assert
    const actionResult = await pool.query<{
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

    expect(actionResult.rows).toHaveLength(1);

    const action = actionResult.rows[0];

    /*
     * Attempt 2 owns the durable action. Attempt 1's eventual success must
     * not complete, unlock or otherwise overwrite it.
     */
    expect.soft(action?.status).toBe("processing");

    expect.soft(action?.attempt_count).toBe(2);

    expect.soft(action?.locked_at).toBeInstanceOf(Date);

    expect.soft(action?.completed_at).toBeNull();

    expect
      .soft(action?.last_error)
      .toBe("Simulated stale recovery and second claim.");

    /*
     * Worker A really did finish its reminder executor successfully.
     * The regression concerns ownership of the durable scheduled action,
     * not whether attempt 1 reached the end of executeAction().
     */
    const reminderResult = await pool.query<{
      sent_at: Date | null;
    }>(
      `
        SELECT "sent_at"
        FROM "event_reminders"
        WHERE "id" = $1
      `,
      [fixture.reminderId],
    );

    expect(reminderResult.rows[0]?.sent_at).toBeInstanceOf(Date);
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

async function waitForBlockedSchedulerActionUpdate(
  pool: Pool,
): Promise<number> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      pid: number;
    }>(`
        SELECT "pid"
        FROM "pg_stat_activity"
        WHERE
          "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE '%update "scheduled_actions"%'
        LIMIT 1
      `);

    const pid = result.rows[0]?.pid;

    if (pid) {
      return pid;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    "Timed out waiting for scheduler failure handling to block on the scheduled-action row.",
  );
}

async function waitForDatabaseQueryToFinish(
  pool: Pool,
  pid: number,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      state: string;
    }>(
      `
          SELECT "state"
          FROM "pg_stat_activity"
          WHERE "pid" = $1
        `,
      [pid],
    );

    const state = result.rows[0]?.state;

    if (!state || state !== "active") {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for database query on backend PID ${pid} to finish.`,
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

function createBlockedFailingReminderDelivery(): {
  waitUntilStarted: () => Promise<void>;
  release: () => void;
} {
  let resolveStarted: (() => void) | undefined;

  let resolveRelease: (() => void) | undefined;

  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });

  eventCustomMessageMocks.sendEventCustomMessage.mockImplementation(
    async () => {
      resolveStarted?.();

      await released;

      throw new Error("Integration reminder delivery failure.");
    },
  );

  return {
    waitUntilStarted: async () => {
      await started;
    },

    release: () => {
      resolveRelease?.();
    },
  };
}

function createBlockedSuccessfulReminderDelivery(): {
  waitUntilStarted: () => Promise<void>;
  release: () => void;
} {
  let resolveStarted: (() => void) | undefined;

  let resolveRelease: (() => void) | undefined;

  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });

  eventCustomMessageMocks.sendEventCustomMessage.mockImplementation(
    async () => {
      resolveStarted?.();

      await released;

      return {
        messageId: "400000000000000004",
        channelId: "400000000000000003",
        url: "https://discord.test/messages/reminder-success",
      };
    },
  );

  return {
    waitUntilStarted: async () => {
      await started;
    },

    release: () => {
      resolveRelease?.();
    },
  };
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

async function createDueFailingReminderAction(
  pool: Pool,
  attemptCount: number,
): Promise<{
  eventId: number;
  reminderId: number;
  actionId: number;
  originalDueAt: Date;
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
    [DISCORD_GUILD_ID, "Scheduler Failure Ownership Test Guild"],
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
    [guildId, eventTypeId, "Scheduler Failure Ownership Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const reminderResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_reminders" (
          "event_id",
          "timing_reference",
          "minutes_before",
          "message",
          "channel_id",
          "ping_event_roles",
          "enabled",
          "created_by_user_id"
        )
        VALUES (
          $1,
          'event_start',
          60,
          $2,
          $3,
          false,
          true,
          $4
        )
        RETURNING "id"
      `,
    [eventId, "Integration reminder", "400000000000000003", ADMIN_USER_ID],
  );

  const reminderId = reminderResult.rows[0]?.id;

  if (!reminderId) {
    throw new Error("The integration-test reminder was not created.");
  }

  const originalDueAt = new Date(Date.now() - 60_000);

  const actionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count"
        )
        VALUES (
          $1,
          $2,
          $3,
          'pending',
          $4
        )
        RETURNING "id"
      `,
    [eventId, `event_reminder:${reminderId}`, originalDueAt, attemptCount],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The integration-test reminder action was not created.");
  }

  return {
    eventId,
    reminderId,
    actionId,
    originalDueAt,
  };
}
