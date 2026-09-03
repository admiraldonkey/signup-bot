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

const SECOND_REPLACEMENT_MESSAGE_ID = "800000000000000006";

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

  it("keeps only one authoritative replacement when deleted attendance-message recovery races", async () => {
    // Arrange
    const fixture = await createPublishedEvent(pool);

    const firstReplacement = {
      id: REPLACEMENT_MESSAGE_ID,

      url: `https://discord.test/channels/${DISCORD_GUILD_ID}/${ATTENDANCE_CHANNEL_ID}/${REPLACEMENT_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const secondReplacement = {
      id: SECOND_REPLACEMENT_MESSAGE_ID,

      url: `https://discord.test/channels/${DISCORD_GUILD_ID}/${ATTENDANCE_CHANNEL_ID}/${SECOND_REPLACEMENT_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const replacementMessages = new Map([
      [firstReplacement.id, firstReplacement],
      [secondReplacement.id, secondReplacement],
    ]);

    const unknownMessageError = () =>
      Object.assign(new Error("Unknown Message"), {
        code: 10008,
        status: 404,
      });

    /*
     * Both refreshes initially observe the same deleted Discord message.
     *
     * The losing recovery later fetches whichever replacement won the
     * conditional database update.
     */
    const fetchMessage = vi.fn(async (messageId: string) => {
      if (messageId === OLD_MESSAGE_ID) {
        throw unknownMessageError();
      }

      const message = replacementMessages.get(messageId);

      if (!message) {
        throw unknownMessageError();
      }

      return message;
    });

    /*
     * Do not allow either replacement send to finish until both refreshes
     * have reached channel.send().
     *
     * This guarantees both callers independently observed the deleted old
     * message before either can attempt the authoritative linkage swap.
     */
    let releaseBothSends: (() => void) | undefined;

    const bothSendsStarted = new Promise<void>((resolve) => {
      releaseBothSends = resolve;
    });

    let sendCount = 0;

    const sendMessage = vi.fn(async () => {
      const sendIndex = sendCount;

      sendCount += 1;

      if (sendCount === 2) {
        releaseBothSends?.();
      }

      await bothSendsStarted;

      if (sendIndex === 0) {
        return firstReplacement;
      }

      return secondReplacement;
    });

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
    const [firstResult, secondResult] = await Promise.all([
      refreshAttendanceMessage(guild, fixture.eventId),

      refreshAttendanceMessage(guild, fixture.eventId),
    ]);

    // Assert
    /*
     * Both callers really reached recovery rather than one simply seeing an
     * already-recovered message from the start.
     */
    expect(sendMessage).toHaveBeenCalledTimes(2);

    expect(
      fetchMessage.mock.calls.filter(
        ([messageId]) => messageId === OLD_MESSAGE_ID,
      ),
    ).toHaveLength(2);

    /*
     * There must still be exactly one logical attendance-message linkage.
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
            AND
            "kind" = 'attendance'
        `,
      [fixture.eventId],
    );

    expect(messageResult.rows).toHaveLength(1);

    const authoritativeMessageId = messageResult.rows[0]?.message_id;

    expect([REPLACEMENT_MESSAGE_ID, SECOND_REPLACEMENT_MESSAGE_ID]).toContain(
      authoritativeMessageId,
    );

    expect(messageResult.rows[0]).toMatchObject({
      id: fixture.eventMessageId,

      channel_id: ATTENDANCE_CHANNEL_ID,

      kind: "attendance",

      deleted_at: null,
    });

    /*
     * Both refresh calls should ultimately report the same winning Discord
     * message, even though each initially created its own candidate.
     */
    expect(firstResult.ok).toBe(true);

    expect(secondResult.ok).toBe(true);

    if (!firstResult.ok || !secondResult.ok) {
      throw new Error(
        "Expected both concurrent attendance recoveries to succeed.",
      );
    }

    expect(firstResult.messageUrl).toBe(secondResult.messageUrl);

    const authoritativeMessage =
      authoritativeMessageId === firstReplacement.id
        ? firstReplacement
        : secondReplacement;

    const duplicateMessage =
      authoritativeMessageId === firstReplacement.id
        ? secondReplacement
        : firstReplacement;

    expect(firstResult.messageUrl).toBe(authoritativeMessage.url);

    /*
     * The winner remains in Discord. The losing recovery cleans up the
     * duplicate message it created.
     */
    expect(authoritativeMessage.delete).not.toHaveBeenCalled();

    expect(duplicateMessage.delete).toHaveBeenCalledTimes(1);

    /*
     * Recovery must not recreate or modify lifecycle scheduler work.
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

  it("refreshes an existing attendance message without creating a replacement", async () => {
    // Arrange
    const fixture = await createPublishedEvent(pool);

    const editMessage = vi.fn().mockResolvedValue(undefined);

    const existingMessage = {
      id: OLD_MESSAGE_ID,

      url: `https://discord.test/channels/${DISCORD_GUILD_ID}/${ATTENDANCE_CHANNEL_ID}/${OLD_MESSAGE_ID}`,

      edit: editMessage,
    };

    const fetchMessage = vi.fn().mockResolvedValue(existingMessage);

    const sendMessage = vi.fn();

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
    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(OLD_MESSAGE_ID);

    /*
     * The existing linked message is refreshed in place.
     */
    expect(editMessage).toHaveBeenCalledTimes(1);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },

        embeds: expect.any(Array),

        components: expect.any(Array),
      }),
    );

    /*
     * Recovery is unnecessary, so no replacement message is posted.
     */
    expect(sendMessage).not.toHaveBeenCalled();

    expect(result).toEqual({
      ok: true,

      messageUrl: existingMessage.url,
    });

    /*
     * The authoritative Discord linkage remains unchanged.
     */
    const messageResult = await pool.query<{
      id: number;
      channel_id: string;
      message_id: string;
      deleted_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "channel_id",
            "message_id",
            "deleted_at"
          FROM "event_messages"
          WHERE
            "event_id" = $1
            AND "kind" = 'attendance'
        `,
      [fixture.eventId],
    );

    expect(messageResult.rows).toEqual([
      {
        id: fixture.eventMessageId,

        channel_id: ATTENDANCE_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,

        deleted_at: null,
      },
    ]);

    /*
     * An ordinary presentation refresh must not alter lifecycle work.
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

  it("fails safely when the linked attendance channel has been deleted", async () => {
    // Arrange
    const fixture = await createPublishedEvent(pool);

    /*
     * Discord reports a deleted/missing channel as Unknown Channel.
     *
     * Unlike a deleted message, there is no safe automatic recovery
     * destination here: the original event may intentionally have been
     * published somewhere other than the guild's current default channel.
     */
    const unknownChannelError = Object.assign(new Error("Unknown Channel"), {
      code: 10003,
      status: 404,
    });

    const fetchChannel = vi.fn().mockRejectedValue(unknownChannelError);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await refreshAttendanceMessage(guild, fixture.eventId);

    // Assert
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(ATTENDANCE_CHANNEL_ID);

    expect(result).toEqual({
      ok: false,
      reason: "channel-unavailable",
    });

    /*
     * Losing the Discord destination must not damage or rewrite the
     * authoritative attendance-message linkage.
     */
    const messageResult = await pool.query<{
      id: number;
      channel_id: string;
      message_id: string;
      deleted_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "channel_id",
            "message_id",
            "deleted_at"
          FROM "event_messages"
          WHERE
            "event_id" = $1
            AND "kind" = 'attendance'
        `,
      [fixture.eventId],
    );

    expect(messageResult.rows).toEqual([
      {
        id: fixture.eventMessageId,

        channel_id: ATTENDANCE_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,

        deleted_at: null,
      },
    ]);

    /*
     * Channel loss is a presentation/configuration failure, not an event
     * lifecycle transition.
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
     * Existing lifecycle work remains untouched. The bot must not treat a
     * missing Discord channel as a reason to replay publication or rebuild
     * scheduler state.
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

  it("does not disguise an unexpected attendance-channel fetch failure as a missing channel", async () => {
    // Arrange
    const fixture = await createPublishedEvent(pool);

    const unexpectedError = new Error("Temporary Discord failure");

    const fetchChannel = vi.fn().mockRejectedValue(unexpectedError);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act / Assert
    await expect(refreshAttendanceMessage(guild, fixture.eventId)).rejects.toBe(
      unexpectedError,
    );

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(ATTENDANCE_CHANNEL_ID);

    /*
     * An unexpected Discord/network failure must not mutate authoritative
     * state merely because presentation could not currently be refreshed.
     */
    const messageResult = await pool.query<{
      id: number;
      channel_id: string;
      message_id: string;
    }>(
      `
          SELECT
            "id",
            "channel_id",
            "message_id"
          FROM "event_messages"
          WHERE
            "event_id" = $1
            AND "kind" = 'attendance'
        `,
      [fixture.eventId],
    );

    expect(messageResult.rows).toEqual([
      {
        id: fixture.eventMessageId,

        channel_id: ATTENDANCE_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,
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
