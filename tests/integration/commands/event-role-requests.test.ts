import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
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

const authMocks = vi.hoisted(() => ({
  getGuildConfiguration: vi.fn(),

  memberCanManageEvents: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

const messageMocks = vi.hoisted(() => ({
  buildRoleRequestGroupMessagePayload: vi.fn(),

  refreshRoleRequestGroupMessage: vi.fn(),
}));

const schedulingMocks = vi.hoisted(() => ({
  scheduleRoleRequestGroupClose: vi.fn(),

  markRoleRequestGroupCloseCompleted: vi.fn(),
}));

vi.mock("../../../src/auth/event-admin.js", () => authMocks);

vi.mock("../../../src/audit/audit-log.js", () => auditMocks);

vi.mock(
  "../../../src/role-requests/role-request-message.js",
  () => messageMocks,
);

vi.mock(
  "../../../src/role-requests/role-request-scheduling.js",
  () => schedulingMocks,
);

import { commandDefinitions } from "../../../src/commands/definitions.js";

import {
  listRoleRequestGroups,
  postRoleRequestGroup,
} from "../../../src/commands/event-role-requests.js";

import { pool as applicationPool } from "../../../src/db/client.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "989000000000000001";

const ADMIN_USER_ID = "989000000000000002";

const EVENT_ADMIN_ROLE_ID = "989000000000000003";

const ROLE_REQUEST_CHANNEL_ID = "989000000000000004";

const NAVAL_NOTIFY_ROLE_ID = "989000000000000010";

const OFFICER_NOTIFY_ROLE_ID = "989000000000000011";

const RESERVE_NOTIFY_ROLE_ID = "989000000000000012";

const SENT_MESSAGE_ID = "989000000000000020";

describe("/event role-request group commands", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    await resetIntegrationDatabase(pool);

    authMocks.memberCanManageEvents.mockReturnValue(true);

    auditMocks.writeAuditLog.mockResolvedValue(undefined);

    messageMocks.buildRoleRequestGroupMessagePayload.mockResolvedValue({
      embeds: [],

      components: [],
    });

    messageMocks.refreshRoleRequestGroupMessage.mockResolvedValue(undefined);

    schedulingMocks.scheduleRoleRequestGroupClose.mockResolvedValue(undefined);

    schedulingMocks.markRoleRequestGroupCloseCompleted.mockResolvedValue(
      undefined,
    );
  });

  afterAll(async () => {
    await pool.end();

    await applicationPool.end();
  });

  it("registers four optional notification-role selectors for role-group-post", () => {
    const eventDefinition = commandDefinitions.find(
      (command) => command.name === "event",
    );

    expect(eventDefinition).toBeDefined();

    const roleGroupPost = eventDefinition?.options?.find(
      (option) => option.name === "role-group-post",
    ) as
      | {
          name: string;

          options?: {
            name: string;
          }[];
        }
      | undefined;

    expect(roleGroupPost).toBeDefined();

    expect(
      roleGroupPost?.options
        ?.filter((option) => option.name.startsWith("notify-role"))
        .map((option) => option.name),
    ).toEqual([
      "notify-role-1",
      "notify-role-2",
      "notify-role-3",
      "notify-role-4",
    ]);
  });

  it("posts a manual role-request group with multiple notification roles", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const interaction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: fixture.optionIds,

      notificationRoles: [
        {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: true,
        },

        {
          id: RESERVE_NOTIFY_ROLE_ID,

          name: "Reserve",

          mentionable: true,
        },
      ],
    });

    // Act
    await postRoleRequestGroup(interaction.interaction);

    // Assert
    const groups = await pool.query<{
      id: number;

      name: string;

      channel_id: string;

      message_id: string | null;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;
    }>(
      `
        SELECT
          "id",
          "name",
          "channel_id",
          "message_id",
          "notify_role_id",
          "notify_role_name_snapshot"
        FROM
          "role_request_groups"
        WHERE
          "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(groups.rows).toHaveLength(1);

    const storedGroup = groups.rows[0];

    expect(storedGroup).toMatchObject({
      name: "Naval Roles",

      channel_id: ROLE_REQUEST_CHANNEL_ID,

      message_id: SENT_MESSAGE_ID,

      /*
       * The first role remains mirrored into the compatibility shadow.
       */
      notify_role_id: NAVAL_NOTIFY_ROLE_ID,

      notify_role_name_snapshot: "Naval",
    });

    if (!storedGroup) {
      throw new Error("The manual role-request group was not stored.");
    }

    const notificationRoles = await pool.query<{
      discord_role_id: string;

      role_name_snapshot: string | null;

      sort_order: number;
    }>(
      `
        SELECT
          "discord_role_id",
          "role_name_snapshot",
          "sort_order"
        FROM
          "role_request_group_notification_roles"
        WHERE
          "group_id" = $1
        ORDER BY
          "sort_order"
      `,
      [storedGroup.id],
    );

    expect(notificationRoles.rows).toEqual([
      {
        discord_role_id: NAVAL_NOTIFY_ROLE_ID,

        role_name_snapshot: "Naval",

        sort_order: 0,
      },

      {
        discord_role_id: OFFICER_NOTIFY_ROLE_ID,

        role_name_snapshot: "Officers",

        sort_order: 1,
      },

      {
        discord_role_id: RESERVE_NOTIFY_ROLE_ID,

        role_name_snapshot: "Reserve",

        sort_order: 2,
      },
    ]);

    const mappings = await pool.query<{
      event_role_option_id: number;

      sort_order: number;
    }>(
      `
        SELECT
          "event_role_option_id",
          "sort_order"
        FROM
          "role_request_group_options"
        WHERE
          "group_id" = $1
        ORDER BY
          "sort_order"
      `,
      [storedGroup.id],
    );

    expect(mappings.rows).toEqual([
      {
        event_role_option_id: fixture.optionIds[0],

        sort_order: 0,
      },

      {
        event_role_option_id: fixture.optionIds[1],

        sort_order: 1,
      },
    ]);

    expect(interaction.sendMessage).toHaveBeenCalledTimes(1);

    expect(interaction.sendMessage).toHaveBeenCalledWith({
      content: [
        `<@&${NAVAL_NOTIFY_ROLE_ID}>`,

        `<@&${OFFICER_NOTIFY_ROLE_ID}>`,

        `<@&${RESERVE_NOTIFY_ROLE_ID}>`,
      ].join(" "),

      embeds: [],

      components: [],

      allowedMentions: {
        parse: [],

        roles: [
          NAVAL_NOTIFY_ROLE_ID,

          OFFICER_NOTIFY_ROLE_ID,

          RESERVE_NOTIFY_ROLE_ID,
        ],
      },
    });

    expect(schedulingMocks.scheduleRoleRequestGroupClose).toHaveBeenCalledTimes(
      1,
    );

    expect(schedulingMocks.scheduleRoleRequestGroupClose).toHaveBeenCalledWith(
      fixture.eventId,

      storedGroup.id,

      expect.any(Date),
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: fixture.guildDatabaseId,

        actorUserId: ADMIN_USER_ID,

        action: "event.role_group.post",

        outcome: "success",

        targetType: "role_request_group",

        targetId: String(storedGroup.id),

        details: expect.objectContaining({
          eventId: fixture.eventId,

          channelId: ROLE_REQUEST_CHANNEL_ID,

          roleOptionIds: fixture.optionIds,

          notificationRoleIds: [
            NAVAL_NOTIFY_ROLE_ID,

            OFFICER_NOTIFY_ROLE_ID,

            RESERVE_NOTIFY_ROLE_ID,
          ],

          requiresPositiveSignup: false,

          closeOffsetMinutes: 30,
        }),
      }),
    );

    expect(interaction.editReply).toHaveBeenCalledTimes(1);

    const reply = interaction.editReply.mock.calls[0]?.[0];

    expect(reply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${NAVAL_NOTIFY_ROLE_ID}>`),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(reply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${OFFICER_NOTIFY_ROLE_ID}>`),
      }),
    );

    expect(reply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${RESERVE_NOTIFY_ROLE_ID}>`),
      }),
    );
  });

  it("allows a manual role-request group with no notification roles", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const interaction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [fixture.optionIds[0]!],

      notificationRoles: [],
    });

    // Act
    await postRoleRequestGroup(interaction.interaction);

    // Assert
    const groups = await pool.query<{
      id: number;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;
    }>(
      `
        SELECT
          "id",
          "notify_role_id",
          "notify_role_name_snapshot"
        FROM
          "role_request_groups"
        WHERE
          "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(groups.rows).toHaveLength(1);

    expect(groups.rows[0]).toMatchObject({
      notify_role_id: null,

      notify_role_name_snapshot: null,
    });

    const groupId = groups.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The no-notification integration-test group was not created.",
      );
    }

    const notificationCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "role_request_group_notification_roles"
        WHERE
          "group_id" = $1
      `,
      [groupId],
    );

    expect(notificationCount.rows).toEqual([
      {
        count: 0,
      },
    ]);

    expect(interaction.sendMessage).toHaveBeenCalledWith({
      content: undefined,

      embeds: [],

      components: [],

      allowedMentions: {
        parse: [],

        roles: [],
      },
    });
  });

  it("rejects a duplicate manual notification role before creating the group", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const interaction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [fixture.optionIds[0]!],

      notificationRoles: [
        {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },
      ],
    });

    // Act
    await postRoleRequestGroup(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Notification role **Naval** was selected more than once.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(interaction.sendMessage).not.toHaveBeenCalled();

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();

    await expectNoStoredGroup(pool, fixture.eventId);
  });

  it("rejects @everyone as a manual notification role", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const interaction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [fixture.optionIds[0]!],

      notificationRoles: [
        {
          /*
           * Discord's @everyone role has the guild snowflake.
           */
          id: DISCORD_GUILD_ID,

          name: "@everyone",

          mentionable: true,
        },
      ],
    });

    // Act
    await postRoleRequestGroup(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "`@everyone` cannot be used as a role-request notification role.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(interaction.sendMessage).not.toHaveBeenCalled();

    await expectNoStoredGroup(pool, fixture.eventId);
  });

  it("rejects an unmentionable manual notification role when the bot lacks Mention Everyone", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const interaction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [fixture.optionIds[0]!],

      notificationRoles: [
        {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: false,
        },
      ],

      canMentionUnmentionableRoles: false,
    });

    // Act
    await postRoleRequestGroup(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "The bot cannot mention **Officers** in that channel.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(interaction.sendMessage).not.toHaveBeenCalled();

    await expectNoStoredGroup(pool, fixture.eventId);
  });

  it("lists all stored notification roles and falls back to the legacy shadow when child rows are absent", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    configureAuthorisation(fixture.guildDatabaseId);

    const postInteraction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [fixture.optionIds[0]!],

      notificationRoles: [
        {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: true,
        },

        {
          id: RESERVE_NOTIFY_ROLE_ID,

          name: "Reserve",

          mentionable: true,
        },
      ],
    });

    await postRoleRequestGroup(postInteraction.interaction);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        SELECT
          "id"
        FROM
          "role_request_groups"
        WHERE
          "event_id" = $1
      `,
      [fixture.eventId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The list integration-test role-request group was not created.",
      );
    }

    const listInteraction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [],
    });

    // Act — collection-backed read
    await listRoleRequestGroups(listInteraction.interaction);

    // Assert
    const collectionReply = listInteraction.editReply.mock.calls[0]?.[0];

    expect(collectionReply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${NAVAL_NOTIFY_ROLE_ID}>`),
      }),
    );

    expect(collectionReply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${OFFICER_NOTIFY_ROLE_ID}>`),
      }),
    );

    expect(collectionReply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${RESERVE_NOTIFY_ROLE_ID}>`),
      }),
    );

    /*
     * Simulate an old app revision which has only the singular compatibility
     * shadow populated.
     */
    await pool.query(
      `
        DELETE FROM
          "role_request_group_notification_roles"
        WHERE
          "group_id" = $1
      `,
      [groupId],
    );

    const fallbackInteraction = createInteraction({
      eventId: fixture.eventId,

      roleOptionIds: [],
    });

    // Act — legacy fallback
    await listRoleRequestGroups(fallbackInteraction.interaction);

    // Assert
    const fallbackReply = fallbackInteraction.editReply.mock.calls[0]?.[0];

    expect(fallbackReply).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`<@&${NAVAL_NOTIFY_ROLE_ID}>`),
      }),
    );

    expect(
      String(
        (
          fallbackReply as {
            content?: unknown;
          }
        )?.content ?? "",
      ),
    ).not.toContain(`<@&${OFFICER_NOTIFY_ROLE_ID}>`);

    expect(
      String(
        (
          fallbackReply as {
            content?: unknown;
          }
        )?.content ?? "",
      ),
    ).not.toContain(`<@&${RESERVE_NOTIFY_ROLE_ID}>`);
  });
});

function configureAuthorisation(guildDatabaseId: number): void {
  authMocks.getGuildConfiguration.mockResolvedValue({
    guildId: guildDatabaseId,

    guildName: "Event Role Request Test Guild",

    timezone: "Europe/London",

    enabled: true,

    eventAdminRoleId: EVENT_ADMIN_ROLE_ID,

    attendanceChannelId: null,

    roleRequestChannelId: ROLE_REQUEST_CHANNEL_ID,

    eventAdminChannelId: null,

    eventOrganiserRoleId: null,

    organisersEnabled: true,

    organiserDmsEnabled: true,

    organiserPrimaryResponseMinutes: 70,

    organiserBackupResponseMinutes: 35,

    organiserWarningMinutesBefore: 15,

    botLogChannelId: null,
  });
}

async function createFixture(pool: Pool): Promise<{
  guildDatabaseId: number;

  eventId: number;

  optionIds: [number, number];

  startsAt: Date;
}> {
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
        'Event Role Request Test Guild'
      )
      RETURNING
        "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
    throw new Error("The integration-test Discord guild was not created.");
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
          "role_requests_enabled",
          "active"
        )
      VALUES (
        $1,
        'naval',
        'Naval',
        true,
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

  const startsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "events" (
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
        'Saturday Naval Event',
        $3,
        false,
        NULL,
        'scheduled',
        $4
      )
      RETURNING
        "id"
    `,
    [guildDatabaseId, eventTypeId, startsAt, ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const optionResult = await pool.query<{
    id: number;

    key: string;
  }>(
    `
      INSERT INTO
        "event_role_options" (
          "event_id",
          "key",
          "display_name",
          "request_restriction",
          "sort_order",
          "active"
        )
      VALUES
        (
          $1,
          'captain',
          'Captain',
          'open',
          0,
          true
        ),
        (
          $1,
          'carpenter',
          'Carpenter',
          'open',
          1,
          true
        )
      RETURNING
        "id",
        "key"
    `,
    [eventId],
  );

  const optionIdByKey = new Map(
    optionResult.rows.map((row) => [row.key, row.id]),
  );

  const captainId = optionIdByKey.get("captain");

  const carpenterId = optionIdByKey.get("carpenter");

  if (!captainId || !carpenterId) {
    throw new Error(
      "The integration-test event role options were not created.",
    );
  }

  return {
    guildDatabaseId,

    eventId,

    optionIds: [captainId, carpenterId],

    startsAt,
  };
}

function createInteraction(input: {
  eventId: number;

  roleOptionIds: number[];

  notificationRoles?: {
    id: string;

    name: string;

    mentionable: boolean;
  }[];

  canMentionUnmentionableRoles?: boolean;
}): {
  interaction: ChatInputCommandInteraction<"cached">;

  editReply: ReturnType<typeof vi.fn>;

  sendMessage: ReturnType<typeof vi.fn>;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);

  const sentMessage = {
    id: SENT_MESSAGE_ID,

    url: `https://discord.test/messages/${SENT_MESSAGE_ID}`,

    delete: vi.fn().mockResolvedValue(undefined),
  };

  const sendMessage = vi.fn().mockResolvedValue(sentMessage);

  const notificationRoles = input.notificationRoles ?? [];

  const roleByOptionName = new Map(
    notificationRoles.map((role, index) => [`notify-role-${index + 1}`, role]),
  );

  const integerValues: Record<string, number | null> = {
    "event-id": input.eventId,

    "role-1": input.roleOptionIds[0] ?? null,

    "role-2": input.roleOptionIds[1] ?? null,

    "role-3": input.roleOptionIds[2] ?? null,

    "role-4": input.roleOptionIds[3] ?? null,

    "role-5": input.roleOptionIds[4] ?? null,

    "role-6": input.roleOptionIds[5] ?? null,

    "role-7": input.roleOptionIds[6] ?? null,

    "role-8": input.roleOptionIds[7] ?? null,

    "role-9": input.roleOptionIds[8] ?? null,

    "role-10": input.roleOptionIds[9] ?? null,

    "close-minutes-before-start": 30,

    "close-minutes-after-start": null,
  };

  const channel = {
    id: ROLE_REQUEST_CHANNEL_ID,

    type: ChannelType.GuildText,

    isSendable: () => true,

    permissionsFor: () => ({
      has: (permission: bigint) => {
        if (permission === PermissionFlagsBits.MentionEveryone) {
          return input.canMentionUnmentionableRoles ?? false;
        }

        return true;
      },
    }),

    send: sendMessage,
  };

  const interaction = {
    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,

      name: "Event Role Request Test Guild",

      channels: {
        fetch: vi.fn(async (channelId: string) =>
          channelId === ROLE_REQUEST_CHANNEL_ID ? channel : null,
        ),
      },

      members: {
        me: {
          id: "989000000000000099",
        },

        fetchMe: vi.fn(),
      },
    },

    member: {},

    user: {
      id: ADMIN_USER_ID,
    },

    options: {
      getInteger: vi.fn((name: string) => integerValues[name] ?? null),

      getString: vi.fn((name: string) => {
        switch (name) {
          case "name":
            return "Naval Roles";

          case "description":
            return "Choose a naval role.";

          default:
            return null;
        }
      }),

      getBoolean: vi.fn((name: string) =>
        name === "requires-signup" ? false : null,
      ),

      getChannel: vi.fn((name: string) =>
        name === "channel" ? channel : null,
      ),

      getRole: vi.fn((name: string) => roleByOptionName.get(name) ?? null),
    },

    editReply,
  } as unknown as ChatInputCommandInteraction<"cached">;

  return {
    interaction,

    editReply,

    sendMessage,
  };
}

async function expectNoStoredGroup(pool: Pool, eventId: number): Promise<void> {
  const result = await pool.query<{
    count: number;
  }>(
    `
      SELECT
        COUNT(*)::int AS "count"
      FROM
        "role_request_groups"
      WHERE
        "event_id" = $1
    `,
    [eventId],
  );

  expect(result.rows).toEqual([
    {
      count: 0,
    },
  ]);
}
