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

const attendanceRefreshMocks = vi.hoisted(() => ({
  refreshAttendanceMessage: vi.fn().mockResolvedValue({
    ok: true,
    messageUrl: "https://discord.test/messages/attendance-refresh",
  }),
}));

vi.mock("../../../src/events/attendance-refresh.js", () => ({
  refreshAttendanceMessage: attendanceRefreshMocks.refreshAttendanceMessage,
}));

const organiserNotificationMocks = vi.hoisted(() => ({
  sendOrganiserPendingWarning: vi.fn().mockResolvedValue({
    channelId: "300000000000000010",

    messageId: "300000000000000011",
  }),

  reconcileOrganiserPendingWarning: vi.fn().mockResolvedValue(true),

  sendOrganiserCoverRequest: vi.fn().mockResolvedValue("pinged"),
}));

vi.mock("../../../src/events/organiser-notification.js", () => ({
  sendOrganiserPendingWarning:
    organiserNotificationMocks.sendOrganiserPendingWarning,

  reconcileOrganiserPendingWarning:
    organiserNotificationMocks.reconcileOrganiserPendingWarning,

  sendOrganiserCoverRequest:
    organiserNotificationMocks.sendOrganiserCoverRequest,
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
    attendanceRefreshMocks.refreshAttendanceMessage.mockClear();
    organiserNotificationMocks.sendOrganiserPendingWarning.mockClear();
    organiserNotificationMocks.reconcileOrganiserPendingWarning.mockClear();
    organiserNotificationMocks.sendOrganiserCoverRequest.mockClear();
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

  it("closes a due role-request group normally while the parent event is active", async () => {
    // Arrange
    const fixture = await createEventWithDueRoleGroupClose(pool, "open");

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
     * Closing role requests is not itself an event lifecycle transition.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("open");

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
     * With a still-active parent event, the scheduler should perform the
     * intended role-request lifecycle transition.
     */
    expect(groupResult.rows[0]?.closed_at).toBeInstanceOf(Date);

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
     * A genuine role-group close should refresh its Discord message exactly
     * once.
     */
    expect(
      roleRequestMessageMocks.refreshRoleRequestGroupMessage,
    ).toHaveBeenCalledTimes(1);

    expect(
      roleRequestMessageMocks.refreshRoleRequestGroupMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),
      fixture.groupId,
    );

    /*
     * Unlike the obsolete/race cases, this really was a successful domain
     * transition and should therefore have exactly one success audit.
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

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.role_group_close",
        outcome: "success",
      },
    ]);
  });

  it("does not time out an organiser assignment when the event completes after the scheduler reads it", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserTimeout(pool);

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Hold the organiser assignment row.
       *
       * The scheduler can still read both the pending assignment and its
       * currently-open event, so it passes all of its initial checks.
       * Its later assignment UPDATE must then wait on this lock.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
        SELECT "id"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [fixture.assignmentId],
      );

      startEventScheduler(client);

      await waitForBlockedSchedulerOrganiserAssignmentUpdate(pool);

      /*
       * Event completion wins after executeOrganiserTimeout() has already
       * read the old "open" state but before its assignment mutation is
       * allowed to proceed.
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
       * The timeout action is now obsolete rather than retryable.
       * Wait for the real scheduler loop to finish processing it.
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

    expect.soft(eventResult.rows[0]?.status).toBe("completed");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      ended_at: Date | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "ended_at"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    const assignment = assignmentResult.rows[0];

    /*
     * Completion made the pending organiser workflow obsolete.
     *
     * A timeout decision made using the earlier "open" snapshot must not
     * turn the assignment into timed_out afterwards.
     */
    expect.soft(assignment?.status).toBe("pending");

    expect.soft(assignment?.is_current).toBe(true);

    expect.soft(assignment?.ended_at).toBeNull();

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
     * The durable timeout action itself may finish normally because the
     * event lifecycle has made its work obsolete.
     */
    expect.soft(actionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * An obsolete timeout must not claim successful organiser failure.
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
        "target_type" = 'organiser_assignment'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_timeout'
        AND "outcome" = 'success'
    `,
      [String(fixture.assignmentId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("times out an overdue organiser normally while the parent event remains active", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserTimeout(pool);

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
     * Timing out an organiser does not itself change the event lifecycle.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("open");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      ended_at: Date | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "ended_at"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    /*
     * Unlike the lifecycle-race case, this assignment really is overdue
     * and the parent event remains active.
     */
    expect.soft(assignmentResult.rows[0]?.status).toBe("timed_out");

    expect.soft(assignmentResult.rows[0]?.is_current).toBe(false);

    expect(assignmentResult.rows[0]?.ended_at).toBeInstanceOf(Date);

    const timeoutActionResult = await pool.query<{
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

    expect(timeoutActionResult.rows).toHaveLength(1);

    expect.soft(timeoutActionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(timeoutActionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * The timeout itself should have one genuine success audit.
     */
    const timeoutAuditResult = await pool.query<{
      action: string;
      outcome: string;
    }>(
      `
        SELECT
          "action",
          "outcome"
        FROM "audit_logs"
        WHERE
          "target_type" = 'organiser_assignment'
          AND "target_id" = $1
          AND "action" = 'scheduler.organiser_timeout'
          AND "outcome" = 'success'
      `,
      [String(fixture.assignmentId)],
    );

    expect(timeoutAuditResult.rows).toEqual([
      {
        action: "scheduler.organiser_timeout",
        outcome: "success",
      },
    ]);

    /*
     * This fixture deliberately has no backup organiser.
     *
     * The intended escalation is therefore to queue a durable cover
     * request for another eligible organiser.
     */
    const coverActionResult = await pool.query<{
      action_key: string;
      status: string;
      attempt_count: number;
    }>(
      `
        SELECT
          "action_key",
          "status",
          "attempt_count"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" = $2
      `,
      [fixture.eventId, `organiser_cover_request:${fixture.assignmentId}`],
    );

    expect(coverActionResult.rows).toEqual([
      {
        action_key: `organiser_cover_request:${fixture.assignmentId}`,
        status: "pending",
        attempt_count: 0,
      },
    ]);

    /*
     * Escalation should also record why that cover request was queued.
     */
    const escalationAuditResult = await pool.query<{
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
          AND "action" = 'event.organiser.cover.queue'
          AND "outcome" = 'success'
      `,
      [String(fixture.eventId)],
    );

    expect(escalationAuditResult.rows).toEqual([
      {
        action: "event.organiser.cover.queue",
        outcome: "success",
      },
    ]);

    /*
     * The escalation path refreshes the event message after changing the
     * organiser workflow.
     */
    expect(
      attendanceRefreshMocks.refreshAttendanceMessage,
    ).toHaveBeenCalledTimes(1);
  });

  it("reconciles an already-posted organiser warning when the assignment times out", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserTimeout(pool);

    /*
     * Simulate the warning having been successfully posted earlier in the
     * organiser response window.
     */
    await pool.query(
      `
        UPDATE
          "event_organiser_assignments"
        SET
          "warning_channel_id" = $2,
          "warning_message_id" = $3,
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      [fixture.assignmentId, "300000000000000010", "300000000000000011"],
    );

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

    // Assert
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      ended_at: Date | null;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
          SELECT
            "status",
            "is_current",
            "ended_at",
            "warning_channel_id",
            "warning_message_id"
          FROM
            "event_organiser_assignments"
          WHERE "id" = $1
        `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect.soft(assignmentResult.rows[0]).toMatchObject({
      status: "timed_out",

      is_current: false,

      warning_channel_id: "300000000000000010",

      warning_message_id: "300000000000000011",
    });

    expect(assignmentResult.rows[0]?.ended_at).toBeInstanceOf(Date);

    /*
     * The timeout is now authoritative. Any warning which previously said
     * the organiser was still awaiting a response must be reconciled.
     */
    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledWith({
      guild: expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),

      assignmentId: fixture.assignmentId,
    });
  });

  it("does not send an organiser warning when the event completes after the scheduler reads it", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserWarning(pool);

    const guildFetch = createBlockedGuildFetchSchedulerClient();

    // Act
    startEventScheduler(guildFetch.client);

    /*
     * executeOrganiserWarning() has already read the assignment and event
     * before it fetches the guild. Pausing that fetch gives us a
     * deterministic point between the stale read and the external warning.
     */
    await guildFetch.waitUntilFetchStarted();

    await pool.query(
      `
      UPDATE "events"
      SET
        "status" = 'completed',
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
      [fixture.eventId],
    );

    /*
     * Completion makes outstanding organiser warning work obsolete.
     *
     * We mirror that scheduler state as well, although the important
     * assertion is that no stale Discord warning is sent.
     */
    await pool.query(
      `
      UPDATE "scheduled_actions"
      SET
        "status" = 'cancelled',
        "locked_at" = null,
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    guildFetch.releaseFetch();

    await waitForScheduledActionStatus(pool, fixture.actionId, "cancelled");

    stopEventScheduler();

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

    expect.soft(eventResult.rows[0]?.status).toBe("completed");

    /*
     * The assignment itself remains untouched by an organiser warning.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
    }>(
      `
      SELECT
        "status",
        "is_current"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect.soft(assignmentResult.rows[0]).toMatchObject({
      status: "pending",
      is_current: true,
    });

    /*
     * Most importantly, a warning based on stale event state must not cross
     * the Discord boundary after completion made it irrelevant.
     */
    expect
      .soft(organiserNotificationMocks.sendOrganiserPendingWarning)
      .not.toHaveBeenCalled();

    /*
     * No Discord delivery means no successful warning audit either.
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
        "target_type" = 'organiser_assignment'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_warning'
        AND "outcome" = 'success'
    `,
      [String(fixture.assignmentId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("reconciles an organiser warning when the assignment is confirmed while the warning send is in flight", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserWarning(pool);

    let signalWarningSendStarted: (() => void) | undefined;

    let releaseWarningSend: (() => void) | undefined;

    const warningSendStarted = new Promise<void>((resolve) => {
      signalWarningSendStarted = resolve;
    });

    const warningSendRelease = new Promise<void>((resolve) => {
      releaseWarningSend = resolve;
    });

    /*
     * Let the scheduler complete all of its eligibility checks and reach the
     * actual Discord boundary, then hold the external send open.
     */
    organiserNotificationMocks.sendOrganiserPendingWarning.mockImplementationOnce(
      async () => {
        signalWarningSendStarted?.();

        await warningSendRelease;

        return {
          channelId: "300000000000000010",

          messageId: "300000000000000011",
        };
      },
    );

    let signalReconciliationStarted: (() => void) | undefined;

    const reconciliationStarted = new Promise<void>((resolve) => {
      signalReconciliationStarted = resolve;
    });

    organiserNotificationMocks.reconcileOrganiserPendingWarning.mockImplementationOnce(
      async () => {
        signalReconciliationStarted?.();

        return true;
      },
    );

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    /*
     * At this point:
     *
     * - the scheduler has revalidated the assignment as pending/current;
     * - the warning send has started;
     * - Discord has not yet returned a message ID;
     * - PostgreSQL therefore cannot yet contain a warning linkage.
     */
    await warningSendStarted;

    const beforeConfirmationResult = await pool.query<{
      status: string;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
          SELECT
            "status",
            "warning_channel_id",
            "warning_message_id"
          FROM
            "event_organiser_assignments"
          WHERE "id" = $1
        `,
      [fixture.assignmentId],
    );

    expect(beforeConfirmationResult.rows).toEqual([
      {
        status: "pending",

        warning_channel_id: null,

        warning_message_id: null,
      },
    ]);

    /*
     * Simulate the authoritative database state produced by a successful
     * organiser confirmation while Discord is still completing the warning
     * send.
     *
     * The organiser-button integration tests separately prove that the real
     * confirmation flow produces this state and requests warning
     * reconciliation.
     */
    await pool.query(
      `
        UPDATE
          "event_organiser_assignments"
        SET
          "status" = 'confirmed',
          "responded_at" = NOW(),
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    /*
     * A real organiser response also cancels outstanding warning/timeout
     * work. Mirror that ownership change while this scheduler worker still
     * has its external send in flight.
     */
    await pool.query(
      `
        UPDATE
          "scheduled_actions"
        SET
          "status" = 'cancelled',
          "locked_at" = null,
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      [fixture.actionId],
    );

    /*
     * The confirmation-side reconciliation would find no warning linkage at
     * this instant because Discord has not returned the message yet.
     *
     * Allow the already-started send to finish. The scheduler must then
     * persist the returned Discord IDs, notice that the assignment became
     * confirmed meanwhile, and reconcile the newly-recorded warning itself.
     */
    releaseWarningSend?.();

    await reconciliationStarted;

    stopEventScheduler();

    // Assert
    expect(
      organiserNotificationMocks.sendOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledWith({
      guild: expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),

      assignmentId: fixture.assignmentId,
    });

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
          SELECT
            "status",
            "is_current",
            "responded_at",
            "ended_at",
            "warning_channel_id",
            "warning_message_id"
          FROM
            "event_organiser_assignments"
          WHERE "id" = $1
        `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect.soft(assignmentResult.rows[0]).toMatchObject({
      status: "confirmed",

      is_current: true,

      ended_at: null,

      warning_channel_id: "300000000000000010",

      warning_message_id: "300000000000000011",
    });

    expect(assignmentResult.rows[0]?.responded_at).toBeInstanceOf(Date);

    /*
     * The response won ownership of the scheduled warning action while the
     * Discord send was in flight.
     */
    const actionResult = await pool.query<{
      status: string;
      locked_at: Date | null;
      completed_at: Date | null;
    }>(
      `
          SELECT
            "status",
            "locked_at",
            "completed_at"
          FROM
            "scheduled_actions"
          WHERE "id" = $1
        `,
      [fixture.actionId],
    );

    expect(actionResult.rows).toHaveLength(1);

    expect.soft(actionResult.rows[0]).toMatchObject({
      status: "cancelled",

      locked_at: null,
    });

    /*
     * This is not a successful still-pending warning delivery. The warning
     * crossed Discord only because its send was already in progress and was
     * immediately reconciled after the response won.
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
            "target_type" =
              'organiser_assignment'
            AND
            "target_id" = $1
            AND
            "action" =
              'scheduler.organiser_warning'
            AND
            "outcome" =
              'success'
        `,
      [String(fixture.assignmentId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("records a non-retryable failure when an organiser warning cannot be delivered", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserWarning(pool);

    /*
     * null means the configured Event Administration destination is
     * definitively unusable, rather than a transient Discord failure.
     */
    organiserNotificationMocks.sendOrganiserPendingWarning.mockResolvedValueOnce(
      null,
    );

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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

    /*
     * Definitive configuration failure is not retryable. The scheduler action
     * should settle after its first attempt rather than cycling through
     * backoff against the same unusable channel.
     */
    expect(actionResult.rows[0]).toMatchObject({
      status: "completed",

      attempt_count: 1,

      locked_at: null,

      last_error: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    expect(
      organiserNotificationMocks.sendOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    /*
     * No Discord warning was actually created, so no warning linkage may be
     * persisted on the organiser assignment.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "warning_channel_id",
        "warning_message_id"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        warning_channel_id: null,

        warning_message_id: null,
      },
    ]);

    /*
     * Although the durable action is non-retryable, the missed warning must be
     * visible persistently rather than existing only as a process log message.
     */
    const auditResult = await pool.query<{
      action: string;
      outcome: string;
      delivery: string | null;
    }>(
      `
      SELECT
        "action",
        "outcome",
        "details" ->> 'delivery' AS "delivery"
      FROM "audit_logs"
      WHERE
        "target_type" = 'organiser_assignment'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_warning'
    `,
      [String(fixture.assignmentId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.organiser_warning",

        outcome: "failure",

        delivery: "failed",
      },
    ]);
  });

  it("sends an organiser warning normally while the assignment and event remain active", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserWarning(pool);

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
     * Sending a warning does not change the event lifecycle.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("open");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      ended_at: Date | null;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "ended_at",
        "warning_channel_id",
        "warning_message_id"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    /*
     * A warning is informational. The organiser remains pending/current
     * until they respond or their actual timeout occurs.
     */
    expect.soft(assignmentResult.rows[0]).toMatchObject({
      status: "pending",
      is_current: true,
      ended_at: null,
      warning_channel_id: "300000000000000010",
      warning_message_id: "300000000000000011",
    });

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
     * With the event and assignment still eligible after the fresh
     * revalidation, the warning should cross the Discord boundary once.
     */
    expect(
      organiserNotificationMocks.sendOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.sendOrganiserPendingWarning,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: fixture.eventId,
        discordUserId: "300000000000000004",
        slot: "primary",
      }),
    );

    /*
     * This was a real successful delivery, so exactly one success audit
     * should be recorded.
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
        "target_type" = 'organiser_assignment'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_warning'
        AND "outcome" = 'success'
    `,
      [String(fixture.assignmentId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.organiser_warning",
        outcome: "success",
      },
    ]);
  });

  it("does not send an organiser cover request when the event completes after the scheduler reads it", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserCoverRequest(pool);

    const guildFetch = createBlockedGuildFetchSchedulerClient();

    // Act
    startEventScheduler(guildFetch.client);

    /*
     * executeOrganiserCoverRequest() has already established that:
     * - the event is active,
     * - the failed assignment is eligible for escalation,
     * - no replacement organiser is active.
     *
     * It then fetches the Discord guild. Pause at that external boundary.
     */
    await guildFetch.waitUntilFetchStarted();

    /*
     * Event completion wins while the cover request is preparing to cross
     * the Discord boundary.
     */
    await pool.query(
      `
      UPDATE "events"
      SET
        "status" = 'completed',
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
      [fixture.eventId],
    );

    /*
     * Real event completion also cancels outstanding organiser escalation
     * actions. Reproduce that state so the processing action no longer
     * belongs to this scheduler worker.
     */
    await pool.query(
      `
      UPDATE "scheduled_actions"
      SET
        "status" = 'cancelled',
        "locked_at" = null,
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    guildFetch.releaseFetch();

    await waitForScheduledActionStatus(pool, fixture.actionId, "cancelled");

    stopEventScheduler();

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

    expect.soft(eventResult.rows[0]?.status).toBe("completed");

    /*
     * A cover request which became obsolete while Discord was being fetched
     * must never reach the notification boundary.
     */
    expect
      .soft(organiserNotificationMocks.sendOrganiserCoverRequest)
      .not.toHaveBeenCalled();

    /*
     * Nor may the stale executor claim successful delivery.
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
        AND "action" = 'scheduler.organiser_cover_request'
        AND "outcome" = 'success'
    `,
      [String(fixture.eventId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("sends an organiser cover request normally while the event remains active and no replacement exists", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserCoverRequest(pool);

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
     * Requesting organiser cover does not itself change the event lifecycle.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("open");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
    }>(
      `
      SELECT
        "status",
        "is_current"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    /*
     * Sending the cover request does not rewrite the failed source
     * assignment. It remains the reason cover was required.
     */
    expect.soft(assignmentResult.rows[0]).toMatchObject({
      status: "timed_out",
      is_current: false,
    });

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
     * With every eligibility condition still true after the fresh
     * revalidation, exactly one Discord cover request should be sent.
     */
    expect(
      organiserNotificationMocks.sendOrganiserCoverRequest,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.sendOrganiserCoverRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: fixture.eventId,
        eventName: "Organiser Cover Race Event",
        eventAdminChannelId: "300000000000000005",
        eventOrganiserRoleId: "300000000000000006",
      }),
    );

    /*
     * A real successful delivery should produce exactly one success audit,
     * including the delivery mode returned by the notification boundary.
     */
    const auditResult = await pool.query<{
      action: string;
      outcome: string;
      delivery: string | null;
    }>(
      `
      SELECT
        "action",
        "outcome",
        "details" ->> 'delivery' AS "delivery"
      FROM "audit_logs"
      WHERE
        "target_type" = 'event'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_cover_request'
        AND "outcome" = 'success'
    `,
      [String(fixture.eventId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.organiser_cover_request",
        outcome: "success",
        delivery: "pinged",
      },
    ]);
  });

  it("does not retry an organiser cover request when delivery is definitively unavailable", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserCoverRequest(pool);

    organiserNotificationMocks.sendOrganiserCoverRequest.mockResolvedValueOnce(
      "failed",
    );

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    /*
     * Wait until the first claimed attempt has completely settled, regardless
     * of whether production currently marks it completed or reschedules it.
     */
    await waitForScheduledActionAttemptSettled(pool, fixture.actionId, 1);

    stopEventScheduler();

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

    /*
     * "failed" from the notification boundary means the configured
     * destination is definitively unusable. Retrying the same configuration
     * through the scheduler backoff cycle cannot make this attempt transiently
     * successful.
     *
     * The durable action therefore completes normally after recording the
     * delivery failure rather than returning to pending.
     */
    expect(actionResult.rows[0]).toMatchObject({
      status: "completed",

      attempt_count: 1,

      locked_at: null,

      last_error: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    expect(
      organiserNotificationMocks.sendOrganiserCoverRequest,
    ).toHaveBeenCalledTimes(1);

    /*
     * The failed source assignment remains historical evidence for why cover
     * was requested. A Discord configuration problem does not rewrite
     * organiser domain state.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
    }>(
      `
      SELECT
        "status",
        "is_current"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "timed_out",

        is_current: false,
      },
    ]);

    /*
     * Definitive non-delivery must be visible in the audit trail even though
     * the scheduler action itself is non-retryable.
     */
    const auditResult = await pool.query<{
      action: string;
      outcome: string;
      delivery: string | null;
    }>(
      `
      SELECT
        "action",
        "outcome",
        "details" ->> 'delivery' AS "delivery"
      FROM "audit_logs"
      WHERE
        "target_type" = 'event'
        AND "target_id" = $1
        AND "action" = 'scheduler.organiser_cover_request'
    `,
      [String(fixture.eventId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.organiser_cover_request",

        outcome: "failure",

        delivery: "failed",
      },
    ]);
  });

  it("retries an organiser cover request after an unexpected transient delivery failure", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueOrganiserCoverRequest(pool);

    const transientError = new Error(
      "Temporary Discord cover-request transport failure.",
    );

    organiserNotificationMocks.sendOrganiserCoverRequest.mockRejectedValueOnce(
      transientError,
    );

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionAttemptSettled(pool, fixture.actionId, 1);

    stopEventScheduler();

    // Assert
    const actionResult = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
      due_at: Date;
    }>(
      `
      SELECT
        "status",
        "attempt_count",
        "locked_at",
        "completed_at",
        "last_error",
        "due_at"
      FROM "scheduled_actions"
      WHERE "id" = $1
    `,
      [fixture.actionId],
    );

    expect(actionResult.rows).toHaveLength(1);

    expect(actionResult.rows[0]).toMatchObject({
      status: "pending",

      attempt_count: 1,

      locked_at: null,

      completed_at: null,
    });

    expect(actionResult.rows[0]?.last_error).toContain(
      "Temporary Discord cover-request transport failure.",
    );

    /*
     * Attempt 1 uses the scheduler's normal one-minute retry delay.
     */
    expect(actionResult.rows[0]?.due_at.getTime()).toBeGreaterThan(Date.now());

    expect(
      organiserNotificationMocks.sendOrganiserCoverRequest,
    ).toHaveBeenCalledTimes(1);

    /*
     * A transient exception does not mean the cover request itself reached a
     * definitive delivery outcome, so no cover-request success/failure audit
     * should be written yet.
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
        AND "action" = 'scheduler.organiser_cover_request'
    `,
      [String(fixture.eventId)],
    );

    expect(auditResult.rows).toEqual([]);
  });

  it("does not report or refresh a successful automatic completion after cancellation wins the event-state race", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueCompletion(pool);

    const client = createSchedulerClient();

    const lockClient = await pool.connect();

    try {
      /*
       * Hold the event row.
       *
       * The scheduler can still claim the due complete_event action and read
       * the currently-open event, but its later conditional lifecycle UPDATE
       * must wait here.
       */
      await lockClient.query("BEGIN");

      await lockClient.query(
        `
        SELECT "id"
        FROM "events"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [fixture.eventId],
      );

      startEventScheduler(client);

      await waitForBlockedSchedulerEventUpdate(pool);

      /*
       * Cancellation wins after executeCompleteEvent() has read "open" but
       * before its conditional UPDATE can apply.
       *
       * This test isolates the event lifecycle race itself. We deliberately
       * leave the already-claimed complete_event action in "processing" so the
       * scheduler's normal markActionCompleted() step gives us a deterministic
       * signal that executeCompleteEvent() has fully returned.
       */
      await lockClient.query(
        `
    UPDATE "events"
    SET
      "status" = 'cancelled',
      "updated_at" = NOW()
    WHERE "id" = $1
  `,
        [fixture.eventId],
      );

      await lockClient.query("COMMIT");

      /*
       * executeCompleteEvent() must now discover that its conditional event
       * UPDATE affected zero rows and return without any completion side-effects.
       *
       * Only after that return can the outer scheduler mark this obsolete
       * durable action completed.
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
     * Cancellation won the conditional lifecycle transition.
     */
    expect.soft(eventResult.rows[0]?.status).toBe("cancelled");

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
     * Losing the event-state race makes this completion action obsolete rather
     * than retryable. The executor returns harmlessly and the scheduler then
     * completes the durable action normally.
     */
    expect.soft(actionResult.rows[0]).toMatchObject({
      status: "completed",
      attempt_count: 1,
      locked_at: null,
    });

    expect(actionResult.rows[0]?.completed_at).toBeInstanceOf(Date);

    /*
     * A completion transition which affected zero event rows must not refresh
     * role-request state as though the event genuinely completed.
     */
    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    /*
     * This fixture is published, so the buggy executor also attempts to
     * refresh the attendance/event message after losing the race.
     */
    expect
      .soft(attendanceRefreshMocks.refreshAttendanceMessage)
      .not.toHaveBeenCalled();

    /*
     * Most importantly, it must not claim that automatic completion
     * succeeded.
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
        AND "action" = 'scheduler.complete_event'
        AND "outcome" = 'success'
    `,
      [String(fixture.eventId)],
    );

    expect.soft(auditResult.rows).toEqual([]);
  });

  it("reconciles an already-posted organiser warning after automatic event completion", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueCompletion(pool);

    const assignmentId = await createPendingOrganiserWarningForEvent(
      pool,
      fixture.eventId,
    );

    const client = createSchedulerClient();

    /*
     * Discord reconciliation must happen only after PostgreSQL has made
     * automatic completion authoritative.
     */
    organiserNotificationMocks.reconcileOrganiserPendingWarning.mockImplementationOnce(
      async (input: { assignmentId: number }) => {
        expect(input.assignmentId).toBe(assignmentId);

        const eventStateAtReconciliation = await pool.query<{
          status: string;
        }>(
          `
          SELECT "status"
          FROM "events"
          WHERE "id" = $1
        `,
          [fixture.eventId],
        );

        expect(eventStateAtReconciliation.rows).toEqual([
          {
            status: "completed",
          },
        ]);

        return true;
      },
    );

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
        status: "completed",
      },
    ]);

    /*
     * Completion is an event-level lifecycle transition. The organiser
     * assignment history remains intact; the terminal event state makes its
     * outstanding response obsolete.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "warning_channel_id",
        "warning_message_id"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        warning_channel_id: "300000000000000012",

        warning_message_id: "300000000000000013",
      },
    ]);

    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.reconcileOrganiserPendingWarning,
    ).toHaveBeenCalledWith({
      guild: expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),

      assignmentId,
    });
  });

  it("completes an overdue event normally while its lifecycle remains active", async () => {
    // Arrange
    const fixture = await createOpenEventWithDueCompletion(pool);

    const client = createSchedulerClient();

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "completed");

    stopEventScheduler();

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
     * With no competing lifecycle transition, the due completion action
     * should perform the intended terminal state change.
     */
    expect(eventResult.rows[0]?.status).toBe("completed");

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
     * Completion refreshes role-request state so any remaining controls
     * reflect that the event has ended.
     */
    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledTimes(1);

    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),
      fixture.eventId,
    );

    /*
     * This fixture is published, so its attendance/event message should also
     * be refreshed exactly once.
     */
    expect(
      attendanceRefreshMocks.refreshAttendanceMessage,
    ).toHaveBeenCalledTimes(1);

    expect(
      attendanceRefreshMocks.refreshAttendanceMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),
      fixture.eventId,
    );

    /*
     * A genuine automatic completion should produce exactly one success
     * audit.
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
        AND "action" = 'scheduler.complete_event'
        AND "outcome" = 'success'
    `,
      [String(fixture.eventId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "scheduler.complete_event",
        outcome: "success",
      },
    ]);
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

function createBlockedGuildFetchSchedulerClient(): {
  client: Client<true>;
  waitUntilFetchStarted: () => Promise<void>;
  releaseFetch: () => void;
} {
  let resolveFetchStarted: (() => void) | undefined;

  let resolveFetch: (() => void) | undefined;

  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });

  const release = new Promise<void>((resolve) => {
    resolveFetch = resolve;
  });

  const guild = {
    id: DISCORD_GUILD_ID,
  };

  const client = {
    guilds: {
      fetch: vi.fn().mockImplementation(async () => {
        resolveFetchStarted?.();

        await release;

        return guild;
      }),
    },
  };

  return {
    client: client as unknown as Client<true>,

    waitUntilFetchStarted: async () => {
      await fetchStarted;
    },

    releaseFetch: () => {
      resolveFetch?.();
    },
  };
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

async function waitForBlockedSchedulerOrganiserAssignmentUpdate(
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
          AND query ILIKE '%update "event_organiser_assignments"%'
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
    "Timed out waiting for the organiser-timeout UPDATE to block on the assignment row.",
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

async function waitForScheduledActionAttemptSettled(
  pool: Pool,
  actionId: number,
  expectedAttemptCount: number,
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
      action.status !== "processing"
    ) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for scheduled action #${actionId} attempt ${expectedAttemptCount} to settle.`,
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

async function createOpenEventWithDueOrganiserTimeout(pool: Pool): Promise<{
  eventId: number;
  assignmentId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Organiser Test Guild"],
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
        NOW() + INTERVAL '1 hour',
        true,
        NOW() - INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Organiser Timeout Race Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const assignmentResult = await pool.query<{
    id: number;
  }>(
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
          "response_deadline_at"
        )
        VALUES (
          $1,
          'primary',
          $2,
          $3,
          'pending',
          true,
          $4,
          NOW() - INTERVAL '90 minutes',
          NOW() - INTERVAL '1 minute'
        )
        RETURNING "id"
      `,
    [eventId, "300000000000000004", "Test Primary Organiser", ADMIN_USER_ID],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
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
    [eventId, `organiser_timeout:${assignmentId}`],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The organiser timeout action was not created.");
  }

  return {
    eventId,
    assignmentId,
    actionId,
  };
}

async function createOpenEventWithDueOrganiserWarning(pool: Pool): Promise<{
  eventId: number;
  assignmentId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Organiser Warning Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "event_admin_channel_id"
      )
      VALUES ($1, $2)
    `,
    [guildId, "300000000000000005"],
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
        NOW() + INTERVAL '1 hour',
        true,
        NOW() - INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Organiser Warning Race Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const assignmentResult = await pool.query<{
    id: number;
  }>(
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
          "response_deadline_at"
        )
        VALUES (
          $1,
          'primary',
          $2,
          $3,
          'pending',
          true,
          $4,
          NOW() - INTERVAL '60 minutes',
          NOW() + INTERVAL '10 minutes'
        )
        RETURNING "id"
      `,
    [eventId, "300000000000000004", "Test Primary Organiser", ADMIN_USER_ID],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
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
    [eventId, `organiser_warning:${assignmentId}`],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The organiser warning action was not created.");
  }

  return {
    eventId,
    assignmentId,
    actionId,
  };
}

async function createOpenEventWithDueOrganiserCoverRequest(
  pool: Pool,
): Promise<{
  eventId: number;
  assignmentId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Organiser Cover Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "event_admin_channel_id",
        "event_organiser_role_id"
      )
      VALUES ($1, $2, $3)
    `,
    [guildId, "300000000000000005", "300000000000000006"],
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
        NOW() + INTERVAL '1 hour',
        true,
        NOW() - INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Organiser Cover Race Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  /*
   * Cover is only appropriate after the source assignment has already
   * failed and there is no active replacement organiser.
   */
  const assignmentResult = await pool.query<{
    id: number;
  }>(
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
          "response_deadline_at",
          "ended_at"
        )
        VALUES (
          $1,
          'primary',
          $2,
          $3,
          'timed_out',
          false,
          $4,
          NOW() - INTERVAL '2 hours',
          NOW() - INTERVAL '1 hour',
          NOW() - INTERVAL '1 hour'
        )
        RETURNING "id"
      `,
    [eventId, "300000000000000004", "Test Primary Organiser", ADMIN_USER_ID],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
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
    [eventId, `organiser_cover_request:${assignmentId}`],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The organiser cover-request action was not created.");
  }

  return {
    eventId,
    assignmentId,
    actionId,
  };
}

async function createPendingOrganiserWarningForEvent(
  pool: Pool,
  eventId: number,
): Promise<number> {
  const assignmentResult = await pool.query<{
    id: number;
  }>(
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
        "response_deadline_at",
        "warning_channel_id",
        "warning_message_id"
      )
      VALUES (
        $1,
        'primary',
        $2,
        'Completion Test Primary Organiser',
        'pending',
        true,
        $3,
        NOW() - INTERVAL '10 minutes',
        NOW() + INTERVAL '5 minutes',
        $4,
        $5
      )
      RETURNING "id"
    `,
    [
      eventId,
      "300000000000000004",
      ADMIN_USER_ID,
      "300000000000000012",
      "300000000000000013",
    ],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
  }

  return assignmentId;
}

async function createOpenEventWithDueCompletion(pool: Pool): Promise<{
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
    [DISCORD_GUILD_ID, "Scheduler Completion Test Guild"],
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

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "starts_at",
        "ends_at",
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
        NOW() - INTERVAL '1 minute',
        true,
        NOW() - INTERVAL '3 hours',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Automatic Completion Race Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
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
        'complete_event',
        NOW() - INTERVAL '1 minute',
        'pending'
      )
      RETURNING "id"
    `,
    [eventId],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The automatic completion action was not created.");
  }

  return {
    eventId,
    actionId,
  };
}
