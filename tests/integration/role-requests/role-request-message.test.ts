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

import { pool as applicationPool } from "../../../src/db/client.js";
import { refreshRoleRequestGroupMessage } from "../../../src/role-requests/role-request-message.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "810000000000000001";

const ROLE_REQUEST_CHANNEL_ID = "810000000000000002";

const OLD_MESSAGE_ID = "810000000000000003";

const REPLACEMENT_MESSAGE_ID = "810000000000000004";

const ADMIN_USER_ID = "810000000000000005";

const SECOND_REPLACEMENT_MESSAGE_ID = "810000000000000006";

describe("role-request group message refresh and recovery", () => {
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

  it("replaces a deleted role-request group message without recreating domain state", async () => {
    // Arrange
    const fixture = await createRoleRequestGroup(pool);

    const replacementMessage = {
      id: REPLACEMENT_MESSAGE_ID,

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
      id: ROLE_REQUEST_CHANNEL_ID,

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
    const result = await refreshRoleRequestGroupMessage(guild, fixture.groupId);

    // Assert
    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(OLD_MESSAGE_ID);

    /*
     * The existing role-request group still exists. Only its missing
     * Discord presentation should need replacing.
     */
    expect(sendMessage).toHaveBeenCalledTimes(1);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },

        embeds: expect.any(Array),

        components: expect.any(Array),
      }),
    );

    expect(result).toBe(true);

    /*
     * Recovery updates the existing group's Discord linkage rather than
     * creating another logical role-request group.
     */
    const groupResult = await pool.query<{
      id: number;
      event_id: number;
      channel_id: string;
      message_id: string | null;
      closed_at: Date | null;
    }>(
      `
              SELECT
                "id",
                "event_id",
                "channel_id",
                "message_id",
                "closed_at"
              FROM "role_request_groups"
              WHERE "event_id" = $1
              ORDER BY "id"
            `,
      [fixture.eventId],
    );

    expect(groupResult.rows).toEqual([
      {
        id: fixture.groupId,

        event_id: fixture.eventId,

        channel_id: ROLE_REQUEST_CHANNEL_ID,

        message_id: REPLACEMENT_MESSAGE_ID,

        closed_at: null,
      },
    ]);

    /*
     * Presentation recovery must not alter the event lifecycle.
     */
    const eventResult = await pool.query<{
      status: string;
      published_at: Date;
    }>(
      `
              SELECT
                "status",
                "published_at"
              FROM "events"
              WHERE "id" = $1
            `,
      [fixture.eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    expect(eventResult.rows[0]?.status).toBe("open");

    expect(eventResult.rows[0]?.published_at.getTime()).toBe(
      fixture.publishedAt.getTime(),
    );

    /*
     * The existing scheduled close remains exactly one piece of
     * lifecycle work. Message recovery must not schedule the group again.
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
        action_key: `role_request_group_close:${fixture.groupId}`,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });

  it("keeps only one authoritative replacement when deleted role-request message recovery races", async () => {
    // Arrange
    const fixture = await createRoleRequestGroup(pool);

    const firstReplacement = {
      id: REPLACEMENT_MESSAGE_ID,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const secondReplacement = {
      id: SECOND_REPLACEMENT_MESSAGE_ID,

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
     * Both refreshes must initially observe the same deleted Discord
     * message.
     *
     * Once one recovery wins the database linkage, the losing recovery
     * should be able to fetch that winning replacement.
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
     * Hold both channel.send() calls until each refresh has independently
     * reached recovery.
     *
     * This prevents one refresh from completing recovery before the other
     * has observed OLD_MESSAGE_ID as missing.
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

      return sendIndex === 0 ? firstReplacement : secondReplacement;
    });

    const channel = {
      id: ROLE_REQUEST_CHANNEL_ID,

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
      refreshRoleRequestGroupMessage(guild, fixture.groupId),

      refreshRoleRequestGroupMessage(guild, fixture.groupId),
    ]);

    // Assert
    /*
     * Both callers genuinely entered recovery.
     */
    expect(sendMessage).toHaveBeenCalledTimes(2);

    expect(
      fetchMessage.mock.calls.filter(
        ([messageId]) => messageId === OLD_MESSAGE_ID,
      ),
    ).toHaveLength(2);

    /*
     * There is still exactly one logical role-request group.
     */
    const groupResult = await pool.query<{
      id: number;
      event_id: number;
      channel_id: string;
      message_id: string | null;
      closed_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "event_id",
            "channel_id",
            "message_id",
            "closed_at"
          FROM "role_request_groups"
          WHERE "event_id" = $1
        `,
      [fixture.eventId],
    );

    expect(groupResult.rows).toHaveLength(1);

    const authoritativeMessageId = groupResult.rows[0]?.message_id;

    expect([REPLACEMENT_MESSAGE_ID, SECOND_REPLACEMENT_MESSAGE_ID]).toContain(
      authoritativeMessageId,
    );

    expect(groupResult.rows[0]).toMatchObject({
      id: fixture.groupId,

      event_id: fixture.eventId,

      channel_id: ROLE_REQUEST_CHANNEL_ID,

      closed_at: null,
    });

    /*
     * Both callers ultimately succeed even though only one candidate
     * replacement becomes authoritative.
     */
    expect(firstResult).toBe(true);

    expect(secondResult).toBe(true);

    const authoritativeMessage =
      authoritativeMessageId === firstReplacement.id
        ? firstReplacement
        : secondReplacement;

    const duplicateMessage =
      authoritativeMessageId === firstReplacement.id
        ? secondReplacement
        : firstReplacement;

    /*
     * The winning Discord message remains. The losing candidate is removed.
     */
    expect(authoritativeMessage.delete).not.toHaveBeenCalled();

    expect(duplicateMessage.delete).toHaveBeenCalledTimes(1);

    /*
     * Recovery must not recreate the group's role-option membership.
     */
    const groupOptionResult = await pool.query<{
      group_id: number;
    }>(
      `
          SELECT
            "group_id"
          FROM "role_request_group_options"
          WHERE "group_id" = $1
        `,
      [fixture.groupId],
    );

    expect(groupOptionResult.rows).toHaveLength(1);

    /*
     * Existing lifecycle scheduling remains singular and untouched.
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
        action_key: `role_request_group_close:${fixture.groupId}`,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });

  it("refreshes an existing role-request group message without creating a replacement", async () => {
    // Arrange
    const fixture = await createRoleRequestGroup(pool);

    const editMessage = vi.fn().mockResolvedValue(undefined);

    const existingMessage = {
      id: OLD_MESSAGE_ID,

      edit: editMessage,
    };

    const fetchMessage = vi.fn().mockResolvedValue(existingMessage);

    const sendMessage = vi.fn();

    const channel = {
      id: ROLE_REQUEST_CHANNEL_ID,

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
    const result = await refreshRoleRequestGroupMessage(guild, fixture.groupId);

    // Assert
    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(OLD_MESSAGE_ID);

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
     * Ordinary refresh must not enter recovery.
     */
    expect(sendMessage).not.toHaveBeenCalled();

    expect(result).toBe(true);

    /*
     * The existing Discord linkage remains authoritative.
     */
    const groupResult = await pool.query<{
      id: number;
      channel_id: string;
      message_id: string | null;
      closed_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "channel_id",
            "message_id",
            "closed_at"
          FROM "role_request_groups"
          WHERE "id" = $1
        `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        id: fixture.groupId,

        channel_id: ROLE_REQUEST_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,

        closed_at: null,
      },
    ]);

    /*
     * Refreshing presentation must not disturb existing lifecycle work.
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
        action_key: `role_request_group_close:${fixture.groupId}`,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });

  it("fails safely when the linked role-request channel has been deleted", async () => {
    // Arrange
    const fixture = await createRoleRequestGroup(pool);

    /*
     * Discord reports a deleted/missing channel as Unknown Channel.
     *
     * There is no safe automatic recovery destination here. The group may
     * intentionally have been posted somewhere other than the guild's
     * current/default role-request channel.
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
    const result = await refreshRoleRequestGroupMessage(guild, fixture.groupId);

    // Assert
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(ROLE_REQUEST_CHANNEL_ID);

    /*
     * Missing destination is an expected presentation/configuration
     * failure, not an exception which should escape the refresh helper.
     */
    expect(result).toBe(false);

    /*
     * The logical role-request group and its old Discord linkage remain
     * intact. The bot must not guess another destination.
     */
    const groupResult = await pool.query<{
      id: number;
      event_id: number;
      channel_id: string;
      message_id: string | null;
      closed_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "event_id",
            "channel_id",
            "message_id",
            "closed_at"
          FROM "role_request_groups"
          WHERE "id" = $1
        `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        id: fixture.groupId,

        event_id: fixture.eventId,

        channel_id: ROLE_REQUEST_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,

        closed_at: null,
      },
    ]);

    /*
     * Losing the Discord presentation channel must not modify the event
     * itself.
     */
    const eventResult = await pool.query<{
      status: string;
      published_at: Date;
    }>(
      `
          SELECT
            "status",
            "published_at"
          FROM "events"
          WHERE "id" = $1
        `,
      [fixture.eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    expect(eventResult.rows[0]?.status).toBe("open");

    expect(eventResult.rows[0]?.published_at.getTime()).toBe(
      fixture.publishedAt.getTime(),
    );

    /*
     * Existing group lifecycle scheduling remains untouched.
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
        action_key: `role_request_group_close:${fixture.groupId}`,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });

  it("does not disguise an unexpected role-request channel fetch failure as a missing channel", async () => {
    // Arrange
    const fixture = await createRoleRequestGroup(pool);

    const unexpectedError = new Error("Temporary Discord failure");

    const fetchChannel = vi.fn().mockRejectedValue(unexpectedError);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act / Assert
    await expect(
      refreshRoleRequestGroupMessage(guild, fixture.groupId),
    ).rejects.toBe(unexpectedError);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(ROLE_REQUEST_CHANNEL_ID);

    /*
     * A transient or unexpected Discord failure must not mutate the
     * authoritative role-request linkage.
     */
    const groupResult = await pool.query<{
      id: number;
      event_id: number;
      channel_id: string;
      message_id: string | null;
      closed_at: Date | null;
    }>(
      `
          SELECT
            "id",
            "event_id",
            "channel_id",
            "message_id",
            "closed_at"
          FROM "role_request_groups"
          WHERE "id" = $1
        `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        id: fixture.groupId,

        event_id: fixture.eventId,

        channel_id: ROLE_REQUEST_CHANNEL_ID,

        message_id: OLD_MESSAGE_ID,

        closed_at: null,
      },
    ]);

    /*
     * Existing scheduler state also remains untouched.
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
        action_key: `role_request_group_close:${fixture.groupId}`,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });
});

async function createRoleRequestGroup(pool: Pool): Promise<{
  eventId: number;
  groupId: number;
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
    [DISCORD_GUILD_ID, "Role Request Message Recovery Test Guild"],
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

  const publishedAt = new Date("2026-09-03T16:00:00.000Z");

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
          'Role Request Message Recovery Test',
          NOW() + INTERVAL '2 hours',
          true,
          $3,
          'open',
          $4
        )
        RETURNING "id"
      `,
    [guildDatabaseId, eventTypeId, publishedAt, ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const optionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_role_options" (
          "event_id",
          "key",
          "display_name",
          "request_restriction",
          "active"
        )
        VALUES (
          $1,
          'captain',
          'Captain',
          'open',
          true
        )
        RETURNING "id"
      `,
    [eventId],
  );

  const optionId = optionResult.rows[0]?.id;

  if (!optionId) {
    throw new Error("The integration-test role option was not created.");
  }

  const groupResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "role_request_groups" (
          "event_id",
          "name",
          "channel_id",
          "message_id",
          "requires_positive_signup",
          "opens_at",
          "closes_at",
          "created_by_user_id"
        )
        VALUES (
          $1,
          'General Role Requests',
          $2,
          $3,
          false,
          NOW() - INTERVAL '1 hour',
          NOW() + INTERVAL '1 hour',
          $4
        )
        RETURNING "id"
      `,
    [eventId, ROLE_REQUEST_CHANNEL_ID, OLD_MESSAGE_ID, ADMIN_USER_ID],
  );

  const groupId = groupResult.rows[0]?.id;

  if (!groupId) {
    throw new Error("The integration-test role-request group was not created.");
  }

  await pool.query(
    `
      INSERT INTO "role_request_group_options" (
        "group_id",
        "event_role_option_id",
        "sort_order"
      )
      VALUES ($1, $2, 0)
    `,
    [groupId, optionId],
  );

  /*
   * Represents legitimate lifecycle work created when the group was
   * originally posted.
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
        $2,
        NOW() + INTERVAL '1 hour',
        'pending'
      )
    `,
    [eventId, `role_request_group_close:${groupId}`],
  );

  return {
    eventId,
    groupId,
    publishedAt,
  };
}
