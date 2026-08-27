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

import { handleOrganiserButton } from "../../../src/interactions/organiser-button.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "700000000000000001";

const ORGANISER_USER_ID = "700000000000000002";

const ADMIN_USER_ID = "700000000000000003";

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
});

async function createActivePendingOrganiserAssignment(pool: Pool): Promise<{
  eventId: number;
  assignmentId: number;
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
