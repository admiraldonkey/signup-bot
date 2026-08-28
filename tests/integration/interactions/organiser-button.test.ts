import type { ButtonInteraction, Guild } from "discord.js";
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

const attendanceRefreshMocks = vi.hoisted(() => ({
  refreshAttendanceMessage: vi.fn(),
}));

vi.mock("../../../src/events/attendance-refresh.js", () => ({
  refreshAttendanceMessage: attendanceRefreshMocks.refreshAttendanceMessage,
}));
const organiserNotificationMocks = vi.hoisted(() => ({
  sendOrganiserAssignmentNotification: vi.fn(),
}));
vi.mock(
  "../../../src/events/organiser-notification.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/events/organiser-notification.js")
      >();

    return {
      ...actual,

      sendOrganiserAssignmentNotification:
        organiserNotificationMocks.sendOrganiserAssignmentNotification,
    };
  },
);

import { handleOrganiserButton } from "../../../src/interactions/organiser-button.js";
import { escalateAfterFailedOrganiserAssignment } from "../../../src/organisers/organiser-escalation.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "700000000000000001";

const ORGANISER_USER_ID = "700000000000000002";

const ADMIN_USER_ID = "700000000000000003";

const BACKUP_ORGANISER_USER_ID = "700000000000000004";

const COVER_ORGANISER_USER_ID = "700000000000000005";

const EVENT_ORGANISER_ROLE_ID = "700000000000000006";

describe("organiser button interactions", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);

    attendanceRefreshMocks.refreshAttendanceMessage
      .mockReset()
      .mockResolvedValue({
        ok: true,
        messageUrl: "https://discord.test/messages/attendance",
      });
    organiserNotificationMocks.sendOrganiserAssignmentNotification
      .mockReset()
      .mockResolvedValue("dm");
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it.each([
    {
      responseAction: "confirm",
      terminalStatus: "cancelled",
    },
    {
      responseAction: "confirm",
      terminalStatus: "completed",
    },
    {
      responseAction: "decline",
      terminalStatus: "cancelled",
    },
    {
      responseAction: "decline",
      terminalStatus: "completed",
    },
  ] as const)(
    "does not save an organiser $responseAction response after $terminalStatus wins the event lifecycle race",
    async ({ responseAction, terminalStatus }) => {
      // Arrange
      const fixture = await createActivePendingOrganiserAssignment(pool);

      const interaction = createOrganiserResponseInteraction(
        fixture.assignmentId,
        responseAction,
      );

      const lockClient = await pool.connect();

      let interactionPromise: Promise<boolean> | undefined;

      try {
        await lockClient.query("BEGIN");

        /*
         * Own the event lifecycle row before the organiser handler begins.
         *
         * The handler's initial ordinary read may still observe the committed
         * open event, but its authoritative FOR UPDATE lifecycle check must
         * wait here.
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

        interactionPromise = handleOrganiserButton(interaction);

        await waitForBlockedOrganiserEventLock(pool);

        /*
         * A terminal lifecycle transition wins after the organiser handler's
         * initial read but before its response can be persisted.
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

        await interactionPromise;
      } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => undefined);

        await interactionPromise?.catch(() => undefined);

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
        status: string;
        is_current: boolean;
        responded_at: Date | null;
        ended_at: Date | null;
      }>(
        `
          SELECT
            "status",
            "is_current",
            "responded_at",
            "ended_at"
          FROM "event_organiser_assignments"
          WHERE "id" = $1
        `,
        [fixture.assignmentId],
      );

      expect(assignmentResult.rows).toHaveLength(1);

      /*
       * The event lifecycle transition became authoritative first. Neither a
       * stale confirmation nor a stale decline may mutate the assignment.
       */
      expect.soft(assignmentResult.rows[0]).toMatchObject({
        status: "pending",
        is_current: true,
        responded_at: null,
        ended_at: null,
      });

      /*
       * The organiser response no longer owns these actions.
       *
       * Event cancellation/completion may subsequently perform its own
       * lifecycle cleanup, but this stale interaction must not do so.
       */
      const actionResult = await pool.query<{
        action_key: string;
        status: string;
      }>(
        `
          SELECT
            "action_key",
            "status"
          FROM "scheduled_actions"
          WHERE "event_id" = $1
          ORDER BY "action_key"
        `,
        [fixture.eventId],
      );

      expect.soft(actionResult.rows).toEqual([
        {
          action_key: `organiser_timeout:${fixture.assignmentId}`,
          status: "pending",
        },
        {
          action_key: `organiser_warning:${fixture.assignmentId}`,
          status: "pending",
        },
      ]);

      /*
       * No organiser-response Discord side effects should occur.
       */
      expect.soft(interaction.message.edit).not.toHaveBeenCalled();

      expect
        .soft(attendanceRefreshMocks.refreshAttendanceMessage)
        .not.toHaveBeenCalled();

      /*
       * Neither confirmation nor decline should be recorded as successful
       * after the event lifecycle transition has won.
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
            AND "target_id" = $1
            AND "action" IN (
              'event.organiser.confirm',
              'event.organiser.decline'
            )
        `,
        [String(fixture.assignmentId)],
      );

      expect.soft(auditResult.rows).toEqual([]);

      expect
        .soft(interaction.editReply)
        .toHaveBeenLastCalledWith(
          "This event is no longer accepting organiser responses.",
        );
    },
  );

  it("confirms an active pending organiser assignment normally", async () => {
    // Arrange
    const fixture = await createActivePendingOrganiserAssignment(pool);

    const interaction = createOrganiserResponseInteraction(
      fixture.assignmentId,
      "confirm",
    );

    // Act
    const handled = await handleOrganiserButton(interaction);

    // Assert
    expect(handled).toBe(true);

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect(assignmentResult.rows[0]).toMatchObject({
      status: "confirmed",
      is_current: true,
      ended_at: null,
    });

    expect(assignmentResult.rows[0]?.responded_at).toBeInstanceOf(Date);

    const actionResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
        ORDER BY "action_key"
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: `organiser_timeout:${fixture.assignmentId}`,
        status: "cancelled",
      },
      {
        action_key: `organiser_warning:${fixture.assignmentId}`,
        status: "cancelled",
      },
    ]);

    expect(interaction.message.edit).toHaveBeenCalledWith({
      components: [],
    });

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
          AND "target_id" = $1
          AND "action" =
            'event.organiser.confirm'
      `,
      [String(fixture.assignmentId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "event.organiser.confirm",
        outcome: "success",
      },
    ]);

    expect(interaction.editReply).toHaveBeenLastCalledWith(
      "✅ You are confirmed as the organiser for **Organiser Interaction Race Test Event**.",
    );
  });

  it("activates the backup organiser normally after the primary declines", async () => {
    // Arrange
    const fixture = await createActivePendingOrganiserAssignment(pool, {
      withBackup: true,
    });

    if (!fixture.backupAssignmentId) {
      throw new Error(
        "Expected the organiser fixture to include a backup assignment.",
      );
    }

    const interaction = createOrganiserResponseInteraction(
      fixture.assignmentId,
      "decline",
    );

    // Act
    const handled = await handleOrganiserButton(interaction);

    // Assert
    expect(handled).toBe(true);

    /*
     * The primary has finished its assignment.
     */
    const primaryResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(primaryResult.rows).toHaveLength(1);

    expect(primaryResult.rows[0]).toMatchObject({
      status: "declined",
      is_current: false,
    });

    expect(primaryResult.rows[0]?.responded_at).toBeInstanceOf(Date);

    expect(primaryResult.rows[0]?.ended_at).toBeInstanceOf(Date);

    /*
     * The dormant backup should now be activated and awaiting its own
     * response.
     */
    const backupResult = await pool.query<{
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.backupAssignmentId],
    );

    expect(backupResult.rows).toHaveLength(1);

    expect(backupResult.rows[0]).toMatchObject({
      status: "pending",
      is_current: true,
      responded_at: null,
      ended_at: null,
    });

    const backupActivatedAt = backupResult.rows[0]?.activated_at;

    const backupDeadline = backupResult.rows[0]?.response_deadline_at;

    expect(backupActivatedAt).toBeInstanceOf(Date);

    expect(backupDeadline).toBeInstanceOf(Date);

    if (!backupActivatedAt || !backupDeadline) {
      throw new Error(
        "The activated backup assignment is missing its response timing.",
      );
    }

    /*
     * The fixture uses the guild default of 40 minutes for backup response.
     */
    expect(backupDeadline.getTime() - backupActivatedAt.getTime()).toBe(
      40 * 60 * 1000,
    );

    /*
     * Primary response work is retired; fresh backup response work is
     * scheduled.
     */
    const actionResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toHaveLength(4);

    expect(actionResult.rows).toEqual(
      expect.arrayContaining([
        {
          action_key: `organiser_timeout:${fixture.assignmentId}`,
          status: "cancelled",
        },
        {
          action_key: `organiser_warning:${fixture.assignmentId}`,
          status: "cancelled",
        },
        {
          action_key: `organiser_timeout:${fixture.backupAssignmentId}`,
          status: "pending",
        },
        {
          action_key: `organiser_warning:${fixture.backupAssignmentId}`,
          status: "pending",
        },
      ]),
    );

    /*
     * The newly activated backup is contacted.
     */
    expect(
      organiserNotificationMocks.sendOrganiserAssignmentNotification,
    ).toHaveBeenCalledTimes(1);

    expect(
      organiserNotificationMocks.sendOrganiserAssignmentNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: fixture.backupAssignmentId,

        eventId: fixture.eventId,

        eventName: "Organiser Interaction Race Test Event",

        discordUserId: BACKUP_ORGANISER_USER_ID,

        slot: "backup",

        eventAdminChannelId: null,
      }),
    );

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
     * The original response buttons should be removed after the primary's
     * decline is accepted.
     */
    expect(interaction.message.edit).toHaveBeenCalledWith({
      components: [],
    });

    /*
     * Both the primary decline and automatic backup activation should be
     * auditable.
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
          "target_id" IN (
            $1,
            $2
          )
          AND "action" IN (
            'event.organiser.decline',
            'event.organiser.backup.activate'
          )
        ORDER BY "action"
      `,
      [String(fixture.assignmentId), String(fixture.backupAssignmentId)],
    );

    expect(auditResult.rows).toEqual([
      {
        action: "event.organiser.backup.activate",
        outcome: "success",
      },
      {
        action: "event.organiser.decline",
        outcome: "success",
      },
    ]);

    expect(interaction.editReply).toHaveBeenLastCalledWith(
      [
        "❌ You have declined the organiser assignment for **Organiser Interaction Race Test Event**.",
        "",
        "The backup organiser has now been contacted.",
      ].join("\n"),
    );
  });

  it("does not create organiser cover after cancellation wins the event lifecycle race", async () => {
    // Arrange
    const fixture = await createCoverEligibleEvent(pool);

    const interaction = createOrganiserCoverInteraction(fixture.eventId);

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Own the event lifecycle row before the cover handler begins.
       *
       * Its initial ordinary event read may still observe the committed open
       * state through MVCC, but its authoritative FOR UPDATE check must wait
       * here.
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

      interactionPromise = handleOrganiserButton(interaction);

      await waitForBlockedOrganiserEventLock(pool);

      /*
       * Cancellation becomes authoritative after the handler has observed
       * the event as active, but before any cover assignment can be created.
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

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

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
        status: "cancelled",
      },
    ]);

    const assignmentResult = await pool.query<{
      slot: string;
      discord_user_id: string;
      status: string;
      is_current: boolean;
    }>(
      `
        SELECT
          "slot",
          "discord_user_id",
          "status",
          "is_current"
        FROM
          "event_organiser_assignments"
        WHERE
          "event_id" = $1
      `,
      [fixture.eventId],
    );

    /*
     * Cancellation won before organiser state could be persisted. A stale
     * cover interaction therefore owns nothing.
     */
    expect.soft(assignmentResult.rows).toEqual([]);

    expect.soft(interaction.message.edit).not.toHaveBeenCalled();

    expect
      .soft(attendanceRefreshMocks.refreshAttendanceMessage)
      .not.toHaveBeenCalled();

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
          "action" =
            'event.organiser.cover.claim'
          AND
          "outcome" =
            'success'
          AND
          "details" ->> 'eventId' =
            $1
      `,
      [String(fixture.eventId)],
    );

    expect.soft(auditResult.rows).toEqual([]);

    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith(
        "This event no longer requires organiser cover.",
      );
  });

  it("does not activate a stale backup after organiser cover is claimed", async () => {
    // Arrange
    const fixture = await createCoverEventWithDormantBackup(pool);

    const interaction = createOrganiserCoverInteraction(fixture.eventId);

    const guild = {
      id: DISCORD_GUILD_ID,
    } as unknown as Guild;

    const lockClient = await pool.connect();

    let escalationPromise:
      | ReturnType<typeof escalateAfterFailedOrganiserAssignment>
      | undefined;

    let escalationResult:
      | Awaited<ReturnType<typeof escalateAfterFailedOrganiserAssignment>>
      | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Hold the dormant backup row.
       *
       * Escalation can still:
       *
       * - read the event as active;
       * - observe no active organiser;
       * - select this dormant backup;
       *
       * but its activation UPDATE must wait here.
       */
      await lockClient.query(
        `
        SELECT "id"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [fixture.backupAssignmentId],
      );

      escalationPromise = escalateAfterFailedOrganiserAssignment({
        guild,

        eventId: fixture.eventId,

        failedAssignmentId: fixture.failedAssignmentId,

        trigger: "declined",
      });

      await waitForBlockedBackupLock(pool);

      /*
       * Escalation has already made its now-stale "no active organiser"
       * decision.
       *
       * While its backup UPDATE remains blocked, cover claims the event
       * completely. The cover therefore wins organiser ownership before the
       * backup activation can persist.
       */
      const handled = await handleOrganiserButton(interaction);

      expect(handled).toBe(true);

      /*
       * Let the stale escalation continue only after cover claiming has fully
       * completed, including its defensive conflict check.
       */
      await lockClient.query("COMMIT");

      escalationResult = await escalationPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await escalationPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert

    /*
     * Once cover has won, the stale backup escalation should recognise that
     * the event has already been resolved rather than activating the backup.
     */
    expect.soft(escalationResult).toEqual({
      kind: "already_resolved",
    });

    const activeAssignmentResult = await pool.query<{
      id: number;
      slot: string;
      discord_user_id: string;
      status: string;
    }>(
      `
        SELECT
          "id",
          "slot",
          "discord_user_id",
          "status"
        FROM
          "event_organiser_assignments"
        WHERE
          "event_id" = $1

          AND
          "is_current" = true

          AND
          "activated_at" IS NOT NULL

          AND
          "status" IN (
            'pending',
            'confirmed'
          )
        ORDER BY "id"
      `,
      [fixture.eventId],
    );

    /*
     * There must be exactly one active organiser after the race: the cover
     * claimant which completed successfully first.
     */
    expect.soft(activeAssignmentResult.rows).toHaveLength(1);

    expect.soft(activeAssignmentResult.rows[0]).toMatchObject({
      slot: "cover",

      discord_user_id: COVER_ORGANISER_USER_ID,

      status: "confirmed",
    });

    /*
     * The backup remains dormant.
     */
    const backupResult = await pool.query<{
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at"
        FROM
          "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.backupAssignmentId],
    );

    expect(backupResult.rows).toHaveLength(1);

    expect.soft(backupResult.rows[0]).toEqual({
      status: "pending",

      is_current: true,

      activated_at: null,

      response_deadline_at: null,
    });

    /*
     * No backup response work should have been scheduled.
     */
    const backupActionResult = await pool.query<{
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
          AND (
            "action_key" = $2
            OR
            "action_key" = $3
          )
        ORDER BY "action_key"
      `,
      [
        fixture.eventId,

        `organiser_warning:${fixture.backupAssignmentId}`,

        `organiser_timeout:${fixture.backupAssignmentId}`,
      ],
    );

    expect.soft(backupActionResult.rows).toEqual([]);

    /*
     * Cover won, so its ordinary success behaviour is still expected.
     */
    expect.soft(interaction.message.edit).toHaveBeenCalledTimes(1);

    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith(
        "✅ You are now the confirmed organiser for **Organiser Interaction Race Test Event**.",
      );

    /*
     * The stale backup path must not contact the backup organiser.
     */
    expect
      .soft(organiserNotificationMocks.sendOrganiserAssignmentNotification)
      .not.toHaveBeenCalled();

    /*
     * Only the cover claim should refresh attendance. A stale backup
     * activation would cause an additional refresh.
     */
    expect
      .soft(attendanceRefreshMocks.refreshAttendanceMessage)
      .toHaveBeenCalledTimes(1);

    const backupAuditResult = await pool.query<{
      action: string;
      outcome: string;
    }>(
      `
        SELECT
          "action",
          "outcome"
        FROM "audit_logs"
        WHERE
          "action" =
            'event.organiser.backup.activate'

          AND
          "target_id" = $1
      `,
      [String(fixture.backupAssignmentId)],
    );

    expect.soft(backupAuditResult.rows).toEqual([]);
  });

  it("does not queue stale organiser cover after another organiser claims the event", async () => {
    // Arrange
    const fixture = await createCoverEventAfterFailedPrimary(pool);

    const interaction = createOrganiserCoverInteraction(fixture.eventId);

    const guild = {
      id: DISCORD_GUILD_ID,
    } as unknown as Guild;

    const lockClient = await pool.connect();

    let escalationPromise:
      | ReturnType<typeof escalateAfterFailedOrganiserAssignment>
      | undefined;

    let escalationResult:
      | Awaited<ReturnType<typeof escalateAfterFailedOrganiserAssignment>>
      | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Let escalation perform all of its initial reads and conclude that no
       * active organiser or standby backup exists, then stop it at the actual
       * cover-request scheduled-action insert.
       */
      await lockClient.query(
        `
        LOCK TABLE "scheduled_actions"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      escalationPromise = escalateAfterFailedOrganiserAssignment({
        guild,

        eventId: fixture.eventId,

        failedAssignmentId: fixture.failedAssignmentId,

        trigger: "declined",
      });

      await waitForBlockedCoverRequestQueue(pool);

      /*
       * Escalation's earlier "cover is needed" decision is now stale.
       *
       * Allow the real cover handler to resolve organiser ownership completely
       * before the pending escalation is allowed to continue.
       */
      const handled = await handleOrganiserButton(interaction);

      expect(handled).toBe(true);

      /*
       * Only after cover has fully succeeded do we permit escalation's stale
       * queue attempt to resume.
       */
      await lockClient.query("COMMIT");

      escalationResult = await escalationPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await escalationPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert

    /*
     * Cover resolved the event before escalation persisted anything, so the
     * stale escalation no longer owns the right to request cover.
     */
    expect.soft(escalationResult).toEqual({
      kind: "already_resolved",
    });

    const activeAssignmentResult = await pool.query<{
      slot: string;
      discord_user_id: string;
      status: string;
      is_current: boolean;
    }>(
      `
        SELECT
          "slot",
          "discord_user_id",
          "status",
          "is_current"

        FROM
          "event_organiser_assignments"

        WHERE
          "event_id" = $1

          AND
          "is_current" = true

          AND
          "activated_at" IS NOT NULL

          AND
          "status" IN (
            'pending',
            'confirmed'
          )
      `,
      [fixture.eventId],
    );

    expect.soft(activeAssignmentResult.rows).toEqual([
      {
        slot: "cover",

        discord_user_id: COVER_ORGANISER_USER_ID,

        status: "confirmed",

        is_current: true,
      },
    ]);

    /*
     * The stale escalation must not leave behind another cover-request job.
     */
    const coverActionResult = await pool.query<{
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
          AND
          "action_key" = $2
      `,
      [
        fixture.eventId,

        `organiser_cover_request:${fixture.failedAssignmentId}`,
      ],
    );

    expect.soft(coverActionResult.rows).toEqual([]);

    /*
     * Only the successful cover claim should refresh the attendance message.
     */
    expect
      .soft(attendanceRefreshMocks.refreshAttendanceMessage)
      .toHaveBeenCalledTimes(1);

    expect.soft(interaction.message.edit).toHaveBeenCalledTimes(1);

    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith(
        "✅ You are now the confirmed organiser for **Organiser Interaction Race Test Event**.",
      );

    /*
     * No backup was involved in this scenario.
     */
    expect
      .soft(organiserNotificationMocks.sendOrganiserAssignmentNotification)
      .not.toHaveBeenCalled();

    /*
     * The stale escalation must not claim that it successfully queued cover.
     */
    const queueAuditResult = await pool.query<{
      action: string;
      outcome: string;
    }>(
      `
        SELECT
          "action",
          "outcome"

        FROM "audit_logs"

        WHERE
          "action" =
            'event.organiser.cover.queue'

          AND
          "target_type" =
            'event'

          AND
          "target_id" = $1
      `,
      [String(fixture.eventId)],
    );

    expect.soft(queueAuditResult.rows).toEqual([]);
  });
});

async function createActivePendingOrganiserAssignment(
  pool: Pool,
  options: {
    withBackup?: boolean;
  } = {},
): Promise<{
  eventId: number;
  assignmentId: number;
  backupAssignmentId: number | null;
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
    [DISCORD_GUILD_ID, "Organiser Interaction Test Guild"],
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
          NOW() + INTERVAL '2 hours',
          true,
          NOW(),
          'open',
          $4
        )
        RETURNING "id"
      `,
    [
      guildId,
      eventTypeId,
      "Organiser Interaction Race Test Event",
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const activatedAt = new Date();

  const responseDeadlineAt = new Date(activatedAt.getTime() + 80 * 60 * 1000);

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
          'Primary Organiser',
          'pending',
          true,
          $3,
          $4,
          $5
        )
        RETURNING "id"
      `,
    [
      eventId,
      ORGANISER_USER_ID,
      ADMIN_USER_ID,
      activatedAt,
      responseDeadlineAt,
    ],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
  }

  let backupAssignmentId: number | null = null;

  if (options.withBackup) {
    const backupResult = await pool.query<{
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
          'backup',
          $2,
          'Backup Organiser',
          'pending',
          true,
          $3,
          NULL,
          NULL
        )
        RETURNING "id"
      `,
      [eventId, BACKUP_ORGANISER_USER_ID, ADMIN_USER_ID],
    );

    backupAssignmentId = backupResult.rows[0]?.id ?? null;

    if (!backupAssignmentId) {
      throw new Error(
        "The integration-test backup organiser assignment was not created.",
      );
    }
  }

  /*
   * These represent the response work which belongs to this still-pending
   * assignment.
   */
  await pool.query(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status"
      )
      VALUES
        (
          $1,
          $2,
          $4,
          'pending'
        ),
        (
          $1,
          $3,
          $5,
          'pending'
        )
    `,
    [
      eventId,
      `organiser_warning:${assignmentId}`,
      `organiser_timeout:${assignmentId}`,
      new Date(activatedAt.getTime() + 60 * 60 * 1000),
      responseDeadlineAt,
    ],
  );

  return {
    eventId,
    assignmentId,
    backupAssignmentId,
  };
}

function createOrganiserResponseInteraction(
  assignmentId: number,
  action: "confirm" | "decline",
): ButtonInteraction {
  const guild = {
    id: DISCORD_GUILD_ID,
  } as unknown as Guild;

  const interaction = {
    customId: `organiser:${assignmentId}:${action}`,

    deferReply: vi.fn().mockResolvedValue(undefined),

    editReply: vi.fn().mockResolvedValue(undefined),

    user: {
      id: ORGANISER_USER_ID,
      username: "PrimaryOrganiser",
    },

    message: {
      edit: vi.fn().mockResolvedValue(undefined),
    },

    client: {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    },
  };

  return interaction as unknown as ButtonInteraction;
}

async function waitForBlockedOrganiserEventLock(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
        SELECT EXISTS (
          SELECT 1
          FROM "pg_stat_activity"
          WHERE
            "datname" =
              current_database()
            AND "state" = 'active'
            AND "wait_event_type" =
              'Lock'
            AND "query" ILIKE
              '%"events"%'
            AND "query" ILIKE
              '%for update%'
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
    "Timed out waiting for the organiser response to block on the event lifecycle row.",
  );
}

async function createCoverEligibleEvent(pool: Pool): Promise<{
  eventId: number;
}> {
  const fixture = await createActivePendingOrganiserAssignment(pool);

  /*
   * Cover is only claimable when there is no active primary/backup.
   *
   * Reuse the normal event fixture, then remove its organiser-response work
   * and assignment so this event represents the cover-required state.
   */
  await pool.query(
    `
      DELETE FROM "scheduled_actions"
      WHERE "event_id" = $1
    `,
    [fixture.eventId],
  );

  await pool.query(
    `
      DELETE FROM "event_organiser_assignments"
      WHERE "event_id" = $1
    `,
    [fixture.eventId],
  );

  /*
   * The claimant must hold the server's configured Event Organiser role.
   */
  await pool.query(
    `
      UPDATE "guild_settings"
      SET
        "event_organiser_role_id" = $2,
        "updated_at" = NOW()
      WHERE
        "guild_id" = (
          SELECT "owner_guild_id"
          FROM "events"
          WHERE "id" = $1
        )
    `,
    [fixture.eventId, EVENT_ORGANISER_ROLE_ID],
  );

  return {
    eventId: fixture.eventId,
  };
}

function createOrganiserCoverInteraction(eventId: number): ButtonInteraction {
  const guild = {
    id: DISCORD_GUILD_ID,
  } as unknown as Guild;

  const interaction = {
    customId: `organiser-cover:${eventId}`,

    deferReply: vi.fn().mockResolvedValue(undefined),

    editReply: vi.fn().mockResolvedValue(undefined),

    inCachedGuild: () => true,

    guildId: DISCORD_GUILD_ID,

    guild,

    user: {
      id: COVER_ORGANISER_USER_ID,

      username: "CoverOrganiser",
    },

    member: {
      displayName: "Cover Organiser",

      roles: {
        cache: {
          has: vi.fn((roleId: string) => roleId === EVENT_ORGANISER_ROLE_ID),
        },
      },
    },

    message: {
      content: [
        "🚨 **Event organiser cover required**",
        "",
        "**Organiser Interaction Race Test Event** needs cover.",
      ].join("\n"),

      edit: vi.fn().mockResolvedValue(undefined),
    },
  };

  return interaction as unknown as ButtonInteraction;
}

async function createCoverEventWithDormantBackup(pool: Pool): Promise<{
  eventId: number;
  failedAssignmentId: number;
  backupAssignmentId: number;
}> {
  const fixture = await createActivePendingOrganiserAssignment(pool, {
    withBackup: true,
  });

  if (!fixture.backupAssignmentId) {
    throw new Error(
      "Expected the organiser fixture to include a backup assignment.",
    );
  }

  /*
   * Represent the point immediately after the primary has failed but before
   * escalation activates the dormant backup.
   */
  await pool.query(
    `
      UPDATE "event_organiser_assignments"
      SET
        "status" = 'declined',
        "is_current" = false,
        "responded_at" = NOW(),
        "ended_at" = NOW(),
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
    [fixture.assignmentId],
  );

  /*
   * Primary response actions no longer matter to this fixture. Keeping the
   * table clear also makes any new backup actions unambiguous.
   */
  await pool.query(
    `
      DELETE FROM "scheduled_actions"
      WHERE "event_id" = $1
    `,
    [fixture.eventId],
  );

  /*
   * Make the event claimable by the cover-test member.
   */
  await pool.query(
    `
      UPDATE "guild_settings"
      SET
        "event_organiser_role_id" = $2,
        "updated_at" = NOW()
      WHERE
        "guild_id" = (
          SELECT "owner_guild_id"
          FROM "events"
          WHERE "id" = $1
        )
    `,
    [fixture.eventId, EVENT_ORGANISER_ROLE_ID],
  );

  return {
    eventId: fixture.eventId,

    failedAssignmentId: fixture.assignmentId,

    backupAssignmentId: fixture.backupAssignmentId,
  };
}

async function waitForBlockedBackupLock(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
        SELECT EXISTS (
          SELECT 1
          FROM "pg_stat_activity"
          WHERE
            "datname" =
              current_database()

            AND
              "state" =
                'active'

            AND
              "wait_event_type" =
                'Lock'

            AND
              "query" ILIKE
                '%event_organiser_assignments%'

            AND
              "query" ILIKE
                '%for update%'
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
    "Timed out waiting for escalation to block while locking the dormant backup assignment.",
  );
}

async function createCoverEventAfterFailedPrimary(pool: Pool): Promise<{
  eventId: number;
  failedAssignmentId: number;
}> {
  const fixture = await createActivePendingOrganiserAssignment(pool);

  /*
   * Represent the point after the primary has failed and before escalation
   * decides whether backup activation or general cover is required.
   *
   * This fixture deliberately has no backup assignment.
   */
  await pool.query(
    `
      UPDATE "event_organiser_assignments"
      SET
        "status" = 'declined',
        "is_current" = false,
        "responded_at" = NOW(),
        "ended_at" = NOW(),
        "updated_at" = NOW()
      WHERE "id" = $1
    `,
    [fixture.assignmentId],
  );

  await pool.query(
    `
      DELETE FROM "scheduled_actions"
      WHERE "event_id" = $1
    `,
    [fixture.eventId],
  );

  /*
   * Permit the test's real cover claimant to resolve organiser ownership.
   */
  await pool.query(
    `
      UPDATE "guild_settings"
      SET
        "event_organiser_role_id" = $2,
        "updated_at" = NOW()
      WHERE
        "guild_id" = (
          SELECT "owner_guild_id"
          FROM "events"
          WHERE "id" = $1
        )
    `,
    [fixture.eventId, EVENT_ORGANISER_ROLE_ID],
  );

  return {
    eventId: fixture.eventId,

    failedAssignmentId: fixture.assignmentId,
  };
}

async function waitForBlockedCoverRequestQueue(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
        SELECT EXISTS (
          SELECT 1

          FROM
            "pg_locks"
              AS "waiting_lock"

          INNER JOIN
            "pg_stat_activity"
              AS "activity"
            ON
              "activity"."pid" =
                "waiting_lock"."pid"

          WHERE
            "activity"."datname" =
              current_database()

            AND
              "waiting_lock"."locktype" =
                'relation'

            AND
              "waiting_lock"."relation" =
                'scheduled_actions'::regclass

            AND
              "waiting_lock"."granted" =
                false
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
    "Timed out waiting for escalation to block while queueing organiser cover.",
  );
}
