import { ChannelType, type Guild } from "discord.js";
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

import { refreshAttendanceMessage } from "../../../src/events/attendance-refresh.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "800000000000000001";

const ATTENDANCE_CHANNEL_ID = "800000000000000002";

const OLD_MESSAGE_ID = "800000000000000003";

const REPLACEMENT_MESSAGE_ID = "800000000000000004";

const ADMIN_USER_ID = "800000000000000005";

describe("attendance message refresh and recovery", () => {
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

  it("replaces a deleted attendance message without replaying event publication", async () => {
    // Arrange
    const fixture = await createPublishedEvent(pool);

    const replacementMessage = {
      id: REPLACEMENT_MESSAGE_ID,

      url: `https://discord.test/channels/${DISCORD_GUILD_ID}/${ATTENDANCE_CHANNEL_ID}/${REPLACEMENT_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const fetchMessage = vi.fn().mockRejectedValue(
      Object.assign(new Error("Unknown Message"), {
        code: 10008,
        status: 404,
      }),
    );

    const sendMessage = vi.fn().mockResolvedValue(replacementMessage);

    const channel = {
      id: ATTENDANCE_CHANNEL_ID,

      type: ChannelType.GuildText,

      messages: {
        fetch: fetchMessage,
      },

      send: sendMessage,
    };

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },
    } as unknown as Guild;

    // Act
    const result = await refreshAttendanceMessage(guild, fixture.eventId);

    // Assert
    /*
     * The stored Discord message is genuinely unavailable.
     */
    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(OLD_MESSAGE_ID);

    /*
     * A replacement should be posted into the same known-good channel
     * rather than treating the event itself as unpublished.
     */
    expect(sendMessage).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      ok: true,

      messageUrl: replacementMessage.url,
    });

    /*
     * Recovery must replace the Discord linkage rather than creating a
     * second logical attendance-message record.
     */
    const messageResult = await pool.query<{
      id: number;
      channel_id: string;
      message_id: string;
      kind: string;
      deleted_at: Date | null;
    }>(
      `
              SELECT
                "id",
                "channel_id",
                "message_id",
                "kind",
                "deleted_at"
              FROM "event_messages"
              WHERE
                "event_id" = $1
                AND "kind" = 'attendance'
              ORDER BY "id"
            `,
      [fixture.eventId],
    );

    expect(messageResult.rows).toEqual([
      {
        id: fixture.eventMessageId,

        channel_id: ATTENDANCE_CHANNEL_ID,

        message_id: REPLACEMENT_MESSAGE_ID,

        kind: "attendance",

        deleted_at: null,
      },
    ]);

    /*
     * Message recovery is presentation repair, not publication.
     *
     * The original publication timestamp and event lifecycle state must
     * therefore remain untouched.
     */
    const eventResult = await pool.query<{
      published_at: Date;
      status: string;
    }>(
      `
              SELECT
                "published_at",
                "status"
              FROM "events"
              WHERE "id" = $1
            `,
      [fixture.eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    expect(eventResult.rows[0]?.published_at.getTime()).toBe(
      fixture.publishedAt.getTime(),
    );

    expect(eventResult.rows[0]?.status).toBe("open");

    /*
     * Existing scheduler state must not be recreated or otherwise
     * replayed merely because the Discord presentation message vanished.
     */
    const actionResult = await pool.query<{
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
              WHERE "event_id" = $1
              ORDER BY "action_key"
            `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: "close_attendance",

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });
});

async function createPublishedEvent(pool: Pool): Promise<{
  eventId: number;
  eventMessageId: number;
  publishedAt: Date;
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
    [DISCORD_GUILD_ID, "Message Recovery Test Guild"],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
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
    [guildDatabaseId, "naval", "Naval Event"],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const publishedAt = new Date("2026-08-28T15:30:00.000Z");

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
          "attendance_opens_at",
          "attendance_closes_at",
          "published_at",
          "publication_channel_id",
          "status",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          'Deleted Message Recovery Test',
          NOW() + INTERVAL '2 hours',
          true,
          $3,
          NOW() + INTERVAL '1 hour',
          $3,
          $4,
          'open',
          $5
        )
        RETURNING "id"
      `,
    [
      guildDatabaseId,
      eventTypeId,
      publishedAt,
      ATTENDANCE_CHANNEL_ID,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const eventMessageResult = await pool.query<{
    id: number;
  }>(
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
        RETURNING "id"
      `,
    [eventId, guildDatabaseId, ATTENDANCE_CHANNEL_ID, OLD_MESSAGE_ID],
  );

  const eventMessageId = eventMessageResult.rows[0]?.id;

  if (!eventMessageId) {
    throw new Error("The integration-test event message was not created.");
  }

  /*
   * This sentinel represents legitimate lifecycle work created during the
   * original publication. Recovery must leave it alone.
   */
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
        NOW() + INTERVAL '1 hour',
        'pending'
      )
    `,
    [eventId],
  );

  return {
    eventId,
    eventMessageId,
    publishedAt,
  };
}
