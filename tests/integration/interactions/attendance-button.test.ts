import type { ButtonInteraction } from "discord.js";
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

const roleRequestMessageMocks = vi.hoisted(() => ({
  refreshRoleRequestMessages: vi.fn(),
}));

/*
 * Keep the real event lookup used by the attendance handler, but replace
 * the delayed Discord refresh boundary.
 */
vi.mock("../../../src/events/attendance-refresh.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/events/attendance-refresh.js")
    >();

  return {
    ...actual,

    refreshAttendanceMessage: attendanceRefreshMocks.refreshAttendanceMessage,
  };
});

vi.mock("../../../src/role-requests/role-request-message.js", () => ({
  refreshRoleRequestMessages:
    roleRequestMessageMocks.refreshRoleRequestMessages,
}));

import { handleAttendanceButton } from "../../../src/interactions/attendance-button.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "500000000000000001";

const MEMBER_USER_ID = "500000000000000002";

const ADMIN_USER_ID = "500000000000000003";

const ATTENDANCE_CHANNEL_ID = "500000000000000004";

const ATTENDANCE_MESSAGE_ID = "500000000000000005";

describe("attendance button interactions", () => {
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

    roleRequestMessageMocks.refreshRoleRequestMessages
      .mockReset()
      .mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it("does not record a stale attendance response after the event closes", async () => {
    // Arrange
    const fixture = await createOpenAttendanceEvent(pool);

    const interaction = createAttendanceButtonInteraction(
      fixture.eventId,
      "attending",
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Block writes to attendance_responses without blocking the handler's
       * initial event lookup.
       *
       * This lets the real interaction read the event as open, pass its
       * lifecycle checks, and then stop precisely when it tries to persist
       * the attendance response.
       */
      await lockClient.query(
        `
          LOCK TABLE "attendance_responses"
          IN ACCESS EXCLUSIVE MODE
        `,
      );

      interactionPromise = handleAttendanceButton(interaction);

      await waitForBlockedAttendanceInsert(pool);

      /*
       * Attendance closure wins after the interaction has already read the
       * old "open" state but before its response is persisted.
       */
      await pool.query(
        `
          UPDATE "events"
          SET
            "status" = 'closed',
            "updated_at" = NOW()
          WHERE "id" = $1
        `,
        [fixture.eventId],
      );

      /*
       * Release the attendance table.
       *
       * The stale interaction may now continue, but it must observe that
       * attendance is no longer open rather than inserting its response.
       */
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
        status: "closed",
      },
    ]);

    const attendanceResult = await pool.query<{
      discord_user_id: string;
      status: string;
    }>(
      `
          SELECT
            "discord_user_id",
            "status"
          FROM "attendance_responses"
          WHERE "event_id" = $1
        `,
      [fixture.eventId],
    );

    /*
     * Closure committed before the attendance write.
     *
     * A response based on the handler's stale "open" snapshot must therefore
     * not be inserted.
     */
    expect.soft(attendanceResult.rows).toEqual([]);

    /*
     * The user must also not receive a false success confirmation for an
     * attendance response which was rejected by the newer lifecycle state.
     */
    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith("Attendance is no longer open for this event.");
  });

  it("records an attendance response normally while the event remains open", async () => {
    // Arrange
    const fixture = await createOpenAttendanceEvent(pool);

    const interaction = createAttendanceButtonInteraction(
      fixture.eventId,
      "attending",
    );

    // Act
    const handled = await handleAttendanceButton(interaction);

    // Assert
    expect(handled).toBe(true);

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
        status: "open",
      },
    ]);

    const attendanceResult = await pool.query<{
      discord_user_id: string;
      source_guild_id: number | null;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT
          "discord_user_id",
          "source_guild_id",
          "status",
          "created_at",
          "updated_at"
        FROM "attendance_responses"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    expect(attendanceResult.rows).toHaveLength(1);

    expect(attendanceResult.rows[0]).toMatchObject({
      discord_user_id: MEMBER_USER_ID,

      source_guild_id: fixture.guildDatabaseId,

      status: "attending",
    });

    expect(attendanceResult.rows[0]?.created_at).toBeInstanceOf(Date);

    expect(attendanceResult.rows[0]?.updated_at).toBeInstanceOf(Date);

    /*
     * The normal path must still give the member the expected success
     * confirmation once the authoritative database write succeeds.
     */
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      "You are marked as **attending**.",
    );
  });
});

async function createOpenAttendanceEvent(pool: Pool): Promise<{
  eventId: number;
  guildDatabaseId: number;
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
    [DISCORD_GUILD_ID, "Attendance Interaction Test Guild"],
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
          'open',
          $6
        )
        RETURNING "id"
      `,
    [
      guildId,
      eventTypeId,
      "Attendance Interaction Race Test Event",
      startsAt,
      attendanceClosesAt,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  /*
   * handleAttendanceButton() resolves an event through the actual Discord
   * attendance message which produced the button click.
   */
  await pool.query(
    `
      INSERT INTO "event_messages" (
        "event_id",
        "guild_id",
        "channel_id",
        "message_id",
        "kind"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'attendance'
      )
    `,
    [eventId, guildId, ATTENDANCE_CHANNEL_ID, ATTENDANCE_MESSAGE_ID],
  );

  return {
    eventId,
    guildDatabaseId: guildId,
  };
}

function createAttendanceButtonInteraction(
  eventId: number,
  status: "attending" | "tentative" | "not_attending",
): ButtonInteraction {
  const interaction = {
    customId: `attendance:${eventId}:${status}`,

    deferReply: vi.fn().mockResolvedValue(undefined),

    inCachedGuild: () => true,

    guildId: DISCORD_GUILD_ID,

    channelId: ATTENDANCE_CHANNEL_ID,

    message: {
      id: ATTENDANCE_MESSAGE_ID,
    },

    user: {
      id: MEMBER_USER_ID,
    },

    guild: {
      id: DISCORD_GUILD_ID,
    },

    editReply: vi.fn().mockResolvedValue(undefined),
  };

  return interaction as unknown as ButtonInteraction;
}

async function waitForBlockedAttendanceInsert(pool: Pool): Promise<void> {
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
            AND "query" ILIKE
              '%insert into "attendance_responses"%'
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
    "Timed out waiting for the attendance interaction to block while inserting its response.",
  );
}
