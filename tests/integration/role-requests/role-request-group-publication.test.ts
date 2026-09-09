import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

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

import { publishRoleRequestGroup } from "../../../src/role-requests/role-request-group-publication.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "984000000000000001";

const ROLE_REQUEST_CHANNEL_ID = "984000000000000002";

const NOTIFY_ROLE_ID = "984000000000000003";

const ADMIN_USER_ID = "984000000000000004";

const FIRST_MESSAGE_ID = "984000000000000005";

const SECOND_MESSAGE_ID = "984000000000000006";

type Fixture = {
  guildDatabaseId: number;

  eventId: number;

  groupId: number;
};

describe("role-request group publication service", () => {
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

  it("posts a due planned group and atomically links its Discord message", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const sentMessage = {
      id: FIRST_MESSAGE_ID,

      url: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const fetchRole = vi.fn().mockResolvedValue({
      id: NOTIFY_ROLE_ID,

      name: "Naval",

      mentionable: true,
    });

    const guild = createGuild({
      sendMessage,

      fetchRole,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: true,

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      messageId: FIRST_MESSAGE_ID,

      messageUrl: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      notification: {
        kind: "pinged",

        roleId: NOTIFY_ROLE_ID,

        roleNameSnapshot: "Naval",
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `<@&${NOTIFY_ROLE_ID}>`,

        embeds: expect.any(Array),

        components: expect.any(Array),

        allowedMentions: {
          parse: [],

          roles: [NOTIFY_ROLE_ID],
        },
      }),
    );

    expect(fetchRole).toHaveBeenCalledTimes(1);

    expect(fetchRole).toHaveBeenCalledWith(NOTIFY_ROLE_ID);

    expect(sentMessage.delete).not.toHaveBeenCalled();

    const groupResult = await pool.query<{
      message_id: string | null;
    }>(
      `
        SELECT
          "message_id"
        FROM
          "role_request_groups"
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        message_id: FIRST_MESSAGE_ID,
      },
    ]);
  });

  it("posts without pinging when the snapshotted notification role no longer exists", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const sentMessage = {
      id: FIRST_MESSAGE_ID,

      url: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const fetchRole = vi.fn().mockRejectedValue(
      Object.assign(new Error("Unknown Role"), {
        code: 10011,

        status: 404,
      }),
    );

    const guild = createGuild({
      sendMessage,

      fetchRole,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: true,

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      messageId: FIRST_MESSAGE_ID,

      messageUrl: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      notification: {
        kind: "skipped",

        roleId: NOTIFY_ROLE_ID,

        roleNameSnapshot: "Naval",

        reason: "missing-role",
      },
    });

    /*
     * Losing a notification role must not prevent the operational
     * role-request group itself from opening.
     */
    expect(sendMessage).toHaveBeenCalledTimes(1);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: undefined,

        allowedMentions: {
          parse: [],

          roles: [],
        },
      }),
    );

    const groupResult = await pool.query<{
      message_id: string | null;
    }>(
      `
        SELECT
          "message_id"
        FROM
          "role_request_groups"
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        message_id: FIRST_MESSAGE_ID,
      },
    ]);
  });

  it("posts without pinging when the snapshotted notification role is no longer mentionable", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const sentMessage = {
      id: FIRST_MESSAGE_ID,

      url: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const guild = createGuild({
      sendMessage,

      fetchRole: vi.fn().mockResolvedValue({
        id: NOTIFY_ROLE_ID,

        name: "Naval",

        mentionable: false,
      }),

      canMentionUnmentionableRoles: false,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: true,

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      messageId: FIRST_MESSAGE_ID,

      messageUrl: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      notification: {
        kind: "skipped",

        roleId: NOTIFY_ROLE_ID,

        roleNameSnapshot: "Naval",

        reason: "not-mentionable",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: undefined,

        allowedMentions: {
          parse: [],

          roles: [],
        },
      }),
    );
  });

  it("does not post a group which already has an authoritative Discord message", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    await pool.query(
      `
        UPDATE
          "role_request_groups"
        SET
          "message_id" = $1
        WHERE
          "id" = $2
      `,
      [FIRST_MESSAGE_ID, fixture.groupId],
    );

    const sendMessage = vi.fn();

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: false,

      reason: "already-posted",

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      messageId: FIRST_MESSAGE_ID,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not post a planned group before its current opening time", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    await pool.query(
      `
        UPDATE
          "role_request_groups"
        SET
          "opens_at" = NOW() + INTERVAL '30 minutes'
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    const sendMessage = vi.fn();

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected the future role-request group not to publish.");
    }

    expect(result.reason).toBe("not-open-yet");

    if (result.reason !== "not-open-yet") {
      throw new Error(`Expected not-open-yet, received ${result.reason}.`);
    }

    expect(result.eventId).toBe(fixture.eventId);

    expect(result.groupId).toBe(fixture.groupId);

    expect(result.opensAt).toBeInstanceOf(Date);

    expect(sendMessage).not.toHaveBeenCalled();

    await expectGroupUnlinked(pool, fixture.groupId);
  });

  it("does not post a group after its request window has expired", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    await pool.query(
      `
        UPDATE
          "role_request_groups"
        SET
          "closes_at" = NOW() - INTERVAL '1 minute'
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    const sendMessage = vi.fn();

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: false,

      reason: "window-expired",

      eventId: fixture.eventId,

      groupId: fixture.groupId,
    });

    expect(sendMessage).not.toHaveBeenCalled();

    await expectGroupUnlinked(pool, fixture.groupId);
  });

  it("does not post a group belonging to a completed event", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    await pool.query(
      `
        UPDATE
          "events"
        SET
          "status" = 'completed'
        WHERE
          "id" = $1
      `,
      [fixture.eventId],
    );

    const sendMessage = vi.fn();

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: false,

      reason: "inactive",

      eventId: fixture.eventId,

      groupId: fixture.groupId,
    });

    expect(sendMessage).not.toHaveBeenCalled();

    await expectGroupUnlinked(pool, fixture.groupId);
  });

  it("keeps authoritative planned state when the snapshotted channel has been deleted", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const fetchChannel = vi.fn().mockRejectedValue(
      Object.assign(new Error("Unknown Channel"), {
        code: 10003,

        status: 404,
      }),
    );

    const guild = createGuild({
      fetchChannel,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: false,

      reason: "channel-unavailable",

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      channelId: ROLE_REQUEST_CHANNEL_ID,
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(ROLE_REQUEST_CHANNEL_ID);

    /*
     * Discord presentation loss must not destroy the preset-derived
     * event-level configuration.
     */
    const groupResult = await pool.query<{
      id: number;

      message_id: string | null;
    }>(
      `
        SELECT
          "id",
          "message_id"
        FROM
          "role_request_groups"
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toEqual([
      {
        id: fixture.groupId,

        message_id: null,
      },
    ]);
  });

  it("keeps only one authoritative Discord message when concurrent publication races", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const firstMessage = {
      id: FIRST_MESSAGE_ID,

      url: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const secondMessage = {
      id: SECOND_MESSAGE_ID,

      url: `https://discord.test/messages/${SECOND_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    let sendCount = 0;

    let releaseSends: (() => void) | undefined;

    const bothSendsStarted = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });

    const sendMessage = vi.fn(async () => {
      sendCount += 1;

      /*
       * Capture this invocation's identity before waiting.
       *
       * Once both concurrent calls have reached the barrier, the shared
       * sendCount is 2 for both callers. Using sendCount after the await
       * would therefore incorrectly make both calls return secondMessage.
       */
      const thisSendNumber = sendCount;

      if (thisSendNumber === 2) {
        releaseSends?.();
      }

      await bothSendsStarted;

      return thisSendNumber === 1 ? firstMessage : secondMessage;
    });

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const [firstResult, secondResult] = await Promise.all([
      publishRoleRequestGroup(guild, fixture.groupId),

      publishRoleRequestGroup(guild, fixture.groupId),
    ]);

    // Assert
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const groupResult = await pool.query<{
      message_id: string | null;
    }>(
      `
        SELECT
          "message_id"
        FROM
          "role_request_groups"
        WHERE
          "id" = $1
      `,
      [fixture.groupId],
    );

    expect(groupResult.rows).toHaveLength(1);

    const authoritativeMessageId = groupResult.rows[0]?.message_id;

    expect([FIRST_MESSAGE_ID, SECOND_MESSAGE_ID]).toContain(
      authoritativeMessageId,
    );

    const successfulResults = [firstResult, secondResult].filter(
      (
        result,
      ): result is Extract<
        typeof result,
        {
          ok: true;
        }
      > => result.ok,
    );

    const losingResults = [firstResult, secondResult].filter(
      (
        result,
      ): result is Extract<
        typeof result,
        {
          ok: false;
        }
      > => !result.ok,
    );

    expect(successfulResults).toHaveLength(1);

    expect(losingResults).toHaveLength(1);

    expect(losingResults[0]).toMatchObject({
      ok: false,

      reason: "already-posted",

      eventId: fixture.eventId,

      groupId: fixture.groupId,

      messageId: authoritativeMessageId,
    });

    if (authoritativeMessageId === FIRST_MESSAGE_ID) {
      expect(firstMessage.delete).not.toHaveBeenCalled();

      expect(secondMessage.delete).toHaveBeenCalledTimes(1);
    } else {
      expect(secondMessage.delete).not.toHaveBeenCalled();

      expect(firstMessage.delete).toHaveBeenCalledTimes(1);
    }
  });

  it("deletes the Discord message if authoritative database linkage fails", async () => {
    // Arrange
    const fixture = await createPlannedRoleRequestGroup(pool);

    const sentMessage = {
      id: FIRST_MESSAGE_ID,

      url: `https://discord.test/messages/${FIRST_MESSAGE_ID}`,

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = vi.fn(async () => {
      /*
       * Make the group ineligible after Discord accepts the message but
       * before the publication service attempts authoritative linkage.
       *
       * This simulates a state transition crossing the external Discord
       * boundary without mocking PostgreSQL itself.
       */
      await pool.query(
        `
            UPDATE
              "role_request_groups"
            SET
              "closed_at" = NOW()
            WHERE
              "id" = $1
          `,
        [fixture.groupId],
      );

      return sentMessage;
    });

    const guild = createGuild({
      sendMessage,
    });

    // Act
    const result = await publishRoleRequestGroup(guild, fixture.groupId);

    // Assert
    expect(result).toEqual({
      ok: false,

      reason: "window-expired",

      eventId: fixture.eventId,

      groupId: fixture.groupId,
    });

    expect(sentMessage.delete).toHaveBeenCalledTimes(1);

    await expectGroupUnlinked(pool, fixture.groupId);
  });
});

async function createPlannedRoleRequestGroup(pool: Pool): Promise<Fixture> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "discord_guilds" (
          "discord_guild_id",
          "name"
        )
      VALUES (
        $1,
        'Role Request Publication Test Guild'
      )
      RETURNING
        "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
    throw new Error("The integration-test guild was not created.");
  }

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_types" (
            "owner_guild_id",
            "code",
            "name",
            "role_requests_enabled"
          )
        VALUES (
          $1,
          'naval',
          'Naval Event',
          true
        )
        RETURNING
          "id"
      `,
    [guildDatabaseId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "events" (
          "owner_guild_id",
          "event_type_id",
          "timezone",
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
        'Europe/London',
        'Role Request Publication Test',
        NOW() + INTERVAL '2 hours',
        NOW() + INTERVAL '3 hours',
        true,
        NOW() - INTERVAL '1 hour',
        'open',
        $3
      )
      RETURNING
        "id"
    `,
    [guildDatabaseId, eventTypeId, ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const optionResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "event_role_options" (
          "event_id",
          "key",
          "display_name",
          "description",
          "request_restriction",
          "active"
        )
      VALUES (
        $1,
        'captain',
        'Captain',
        'Command the ship.',
        'open',
        true
      )
      RETURNING
        "id"
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
      INSERT INTO
        "role_request_groups" (
          "event_id",
          "name",
          "description",
          "channel_id",
          "message_id",
          "notify_role_id",
          "notify_role_name_snapshot",
          "requires_positive_signup",
          "open_minutes_before_start",
          "opens_at",
          "close_minutes_before_start",
          "closes_at",
          "closed_at",
          "created_by_user_id"
        )
      VALUES (
        $1,
        'Naval Roles',
        'Choose any naval roles you would be willing to perform.',
        $2,
        NULL,
        $3,
        'Naval',
        true,
        60,
        NOW() - INTERVAL '1 minute',
        0,
        NOW() + INTERVAL '1 hour',
        NULL,
        $4
      )
      RETURNING
        "id"
    `,
    [eventId, ROLE_REQUEST_CHANNEL_ID, NOTIFY_ROLE_ID, ADMIN_USER_ID],
  );

  const groupId = groupResult.rows[0]?.id;

  if (!groupId) {
    throw new Error("The integration-test role-request group was not created.");
  }

  await pool.query(
    `
      INSERT INTO
        "role_request_group_options" (
          "group_id",
          "event_role_option_id",
          "sort_order"
        )
      VALUES (
        $1,
        $2,
        0
      )
    `,
    [groupId, optionId],
  );

  return {
    guildDatabaseId,

    eventId,

    groupId,
  };
}

function createGuild(
  options: {
    sendMessage?: ReturnType<typeof vi.fn>;

    fetchChannel?: ReturnType<typeof vi.fn>;

    fetchRole?: ReturnType<typeof vi.fn>;

    canMentionUnmentionableRoles?: boolean;
  } = {},
): Guild {
  const sendMessage = options.sendMessage ?? vi.fn();

  const channel = {
    id: ROLE_REQUEST_CHANNEL_ID,

    type: ChannelType.GuildText,

    isSendable: () => true,

    permissionsFor: () => ({
      has: (permission: bigint) => {
        /*
         * MentionEveryone is the only permission which these tests need to
         * vary independently. All ordinary posting permissions are granted.
         */
        if (permission === PermissionFlagsBits.MentionEveryone) {
          return options.canMentionUnmentionableRoles ?? true;
        }

        return true;
      },
    }),

    send: sendMessage,
  };

  const fetchChannel =
    options.fetchChannel ?? vi.fn().mockResolvedValue(channel);

  const fetchRole =
    options.fetchRole ??
    vi.fn().mockResolvedValue({
      id: NOTIFY_ROLE_ID,

      name: "Naval",

      mentionable: true,
    });

  return {
    id: DISCORD_GUILD_ID,

    channels: {
      fetch: fetchChannel,
    },

    members: {
      me: {
        id: "984000000000000099",
      },
    },

    roles: {
      fetch: fetchRole,
    },
  } as unknown as Guild;
}

async function expectGroupUnlinked(pool: Pool, groupId: number): Promise<void> {
  const result = await pool.query<{
    message_id: string | null;
  }>(
    `
      SELECT
        "message_id"
      FROM
        "role_request_groups"
      WHERE
        "id" = $1
    `,
    [groupId],
  );

  expect(result.rows).toEqual([
    {
      message_id: null,
    },
  ]);
}
