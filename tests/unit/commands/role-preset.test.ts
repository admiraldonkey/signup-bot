import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getGuildConfiguration: vi.fn(),

  memberCanManageEvents: vi.fn(),
}));

const adminServiceMocks = vi.hoisted(() => ({
  createRoleRequestPreset: vi.fn(),

  addPresetRoleOption: vi.fn(),

  addPresetRequestGroup: vi.fn(),

  setRoleRequestPresetActive: vi.fn(),

  setRoleRequestPresetOptionActive: vi.fn(),

  setRoleRequestPresetGroupActive: vi.fn(),
}));

const queryServiceMocks = vi.hoisted(() => ({
  listRoleRequestPresets: vi.fn(),

  getRoleRequestPresetDetails: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("../../../src/auth/event-admin.js", () => authMocks);

vi.mock(
  "../../../src/role-requests/role-request-preset-admin-service.js",
  () => adminServiceMocks,
);

vi.mock(
  "../../../src/role-requests/role-request-preset-query-service.js",
  () => queryServiceMocks,
);

vi.mock("../../../src/audit/audit-log.js", () => auditMocks);

import { commandDefinitions } from "../../../src/commands/definitions.js";

import { handleRolePresetCommand } from "../../../src/commands/role-preset.js";

const DISCORD_GUILD_ID = "988000000000000001";

const ADMIN_USER_ID = "988000000000000002";

const EVENT_ADMIN_ROLE_ID = "988000000000000003";

const QUALIFIED_ROLE_ID = "988000000000000010";

const SUPERVISED_ROLE_ID = "988000000000000011";

const EXPLICIT_CHANNEL_ID = "988000000000000020";

const NAVAL_NOTIFY_ROLE_ID = "988000000000000021";

describe("/role-preset command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Preset Command Test Guild",

      timezone: "Europe/London",

      enabled: true,

      eventAdminRoleId: EVENT_ADMIN_ROLE_ID,

      attendanceChannelId: null,

      roleRequestChannelId: null,

      eventAdminChannelId: null,

      eventOrganiserRoleId: null,

      organisersEnabled: true,

      organiserDmsEnabled: true,

      organiserPrimaryResponseMinutes: 70,

      organiserBackupResponseMinutes: 35,

      organiserWarningMinutesBefore: 15,

      botLogChannelId: null,
    });

    authMocks.memberCanManageEvents.mockReturnValue(true);

    auditMocks.writeAuditLog.mockResolvedValue(undefined);
  });

  it("registers all role-preset administration subcommands", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "role-preset",
    );

    expect(definition).toBeDefined();

    expect(definition?.options?.map((option) => option.name)).toEqual([
      "create",
      "list",
      "show",
      "option-add",
      "group-add",
      "apply",
      "set-active",
      "option-set-active",
      "group-set-active",
    ]);
  });

  it("creates a preset through the administration service and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.createRoleRequestPreset.mockResolvedValue({
      kind: "created",

      preset: {
        id: 7,

        name: "Naval",

        description: "Standard naval role requests.",

        active: true,

        createdByUserId: ADMIN_USER_ID,
      },
    });

    const interaction = createInteraction({
      subcommand: "create",

      strings: {
        name: "Naval",

        description: "Standard naval role requests.",
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(adminServiceMocks.createRoleRequestPreset).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      name: "Naval",

      description: "Standard naval role requests.",

      createdByUserId: ADMIN_USER_ID,
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "Created role-request preset **Naval** (#7)",
        ),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.create",

        outcome: "success",

        targetType: "role_request_preset",

        targetId: "7",
      }),
    );
  });

  it("adds a qualified role option through the administration service and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.addPresetRoleOption.mockResolvedValue({
      kind: "added",

      option: {
        id: 31,

        presetId: 7,

        key: "2-gun-gunner",

        displayName: "2-Gun Gunner",

        description: "Operates a two-gun position.",

        requestRestriction: "qualified_only",

        capacity: 2,

        sortOrder: 3,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "option-add",

      strings: {
        name: "2-Gun Gunner",

        description: "Operates a two-gun position.",

        restriction: "qualified_only",
      },

      integers: {
        "preset-id": 7,

        capacity: 2,
      },

      roles: {
        "qualified-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Gunner",
        },

        "supervised-role-1": {
          id: SUPERVISED_ROLE_ID,

          name: "Gunner Trainee",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRoleOption).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      displayName: "2-Gun Gunner",

      description: "Operates a two-gun position.",

      requestRestriction: "qualified_only",

      capacity: 2,

      qualificationRoles: [
        {
          discordRoleId: QUALIFIED_ROLE_ID,

          roleNameSnapshot: "Qualified Gunner",

          qualificationLevel: "qualified",
        },

        {
          discordRoleId: SUPERVISED_ROLE_ID,

          roleNameSnapshot: "Gunner Trainee",

          qualificationLevel: "supervision_required",
        },
      ],
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Added role option **2-Gun Gunner** (#31)");

    expect(content).toContain("to preset #7");

    expect(content).toContain("`2-gun-gunner`");

    expect(content).toContain("Qualified only");

    expect(content).toContain(`<@&${QUALIFIED_ROLE_ID}>`);

    expect(content).toContain(`<@&${SUPERVISED_ROLE_ID}>`);

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.option.add",

        outcome: "success",

        targetType: "role_request_preset_option",

        targetId: "31",

        details: expect.objectContaining({
          presetId: 7,

          key: "2-gun-gunner",

          requestRestriction: "qualified_only",

          capacity: 2,
        }),
      }),
    );
  });

  it("rejects one Discord role being selected at both qualification levels before calling the service", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-add",

      strings: {
        name: "Captain",

        restriction: "qualified_only",
      },

      integers: {
        "preset-id": 7,
      },

      roles: {
        "qualified-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Captain",
        },

        "supervised-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Captain",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRoleOption).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "**Qualified Captain** cannot be both fully qualified and supervision-required for the same preset role option.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects a qualified-only preset option without qualification roles before calling the service", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-add",

      strings: {
        name: "Captain",

        restriction: "qualified_only",
      },

      integers: {
        "preset-id": 7,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRoleOption).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "A `Qualified only` preset role option must have at least one configured qualification role.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects @everyone as a preset qualification role before calling the service", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-add",

      strings: {
        name: "Captain",

        restriction: "qualified_only",
      },

      integers: {
        "preset-id": 7,
      },

      roles: {
        "qualified-role-1": {
          id: DISCORD_GUILD_ID,

          name: "@everyone",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRoleOption).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "`@everyone` cannot be used as a preset qualification role.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("reports a preset option key conflict returned by the administration service", async () => {
    // Arrange
    adminServiceMocks.addPresetRoleOption.mockResolvedValue({
      kind: "key_conflict",

      key: "2-gun-gunner",
    });

    const interaction = createInteraction({
      subcommand: "option-add",

      strings: {
        name: "2 Gun Gunner",

        restriction: "open",
      },

      integers: {
        "preset-id": 7,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset #7 already has a role option with the logical key `2-gun-gunner`. Choose a more distinct name.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("adds a preset request group with ordered options, an explicit channel and a notification role", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.addPresetRequestGroup.mockResolvedValue({
      kind: "added",

      group: {
        id: 41,

        presetId: 7,

        name: "Naval Roles",

        description: "General naval applications.",

        channelId: EXPLICIT_CHANNEL_ID,

        notifyRoleId: NAVAL_NOTIFY_ROLE_ID,

        notifyRoleNameSnapshot: "Naval",

        requiresPositiveSignup: true,

        openMinutesBeforeStart: 60,

        closeMinutesBeforeStart: -10,

        sortOrder: 1,

        active: true,

        presetOptionIds: [12, 11],
      },
    });

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Naval Roles",

        description: "General naval applications.",
      },

      integers: {
        "preset-id": 7,

        "role-1": 12,

        "role-2": 11,

        "open-minutes-before-start": 60,

        "close-minutes-after-start": 10,
      },

      booleans: {
        "requires-signup": true,
      },

      roles: {
        "notify-role": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },
      },

      channels: {
        channel: createTestTextChannel(),
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      name: "Naval Roles",

      description: "General naval applications.",

      presetOptionIds: [12, 11],

      channelId: EXPLICIT_CHANNEL_ID,

      notifyRole: {
        discordRoleId: NAVAL_NOTIFY_ROLE_ID,

        roleNameSnapshot: "Naval",
      },

      requiresPositiveSignup: true,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: -10,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Added request group **Naval Roles** (#41)");

    expect(content).toContain("to preset #7");

    expect(content).toContain(`<#${EXPLICIT_CHANNEL_ID}>`);

    expect(content).toContain(`<@&${NAVAL_NOTIFY_ROLE_ID}>`);

    expect(content).toContain("T-60 → T+10");

    /*
     * Preserve the administrator's requested order, not the preset's
     * underlying option-table order.
     */
    expect(content).toContain("Carpenter (#12), Captain (#11)");

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.group.add",

        outcome: "success",

        targetType: "role_request_preset_group",

        targetId: "41",

        details: expect.objectContaining({
          presetId: 7,

          presetOptionIds: [12, 11],

          channelId: EXPLICIT_CHANNEL_ID,

          notifyRoleId: NAVAL_NOTIFY_ROLE_ID,

          requiresPositiveSignup: true,

          openMinutesBeforeStart: 60,

          closeMinutesBeforeStart: -10,
        }),
      }),
    );
  });

  it("stores no channel override when a preset group should resolve the guild default at application time", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.addPresetRequestGroup.mockResolvedValue({
      kind: "added",

      group: {
        id: 42,

        presetId: 7,

        name: "Command Roles",

        description: null,

        channelId: null,

        notifyRoleId: null,

        notifyRoleNameSnapshot: null,

        requiresPositiveSignup: false,

        openMinutesBeforeStart: 180,

        closeMinutesBeforeStart: 60,

        sortOrder: 2,

        active: true,

        presetOptionIds: [11],
      },
    });

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Command Roles",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,

        "open-minutes-before-start": 180,

        "close-minutes-before-start": 60,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: null,

        notifyRole: null,

        requiresPositiveSignup: false,

        openMinutesBeforeStart: 180,

        closeMinutesBeforeStart: 60,
      }),
    );

    /*
     * No explicit destination means there is deliberately nothing to fetch or
     * validate now. The guild default is resolved when the preset is applied.
     */
    expect(interaction.fetchChannel).not.toHaveBeenCalled();

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Guild default at application");

    expect(content).toContain("T-180 → T-60");
  });

  it("rejects a duplicate preset option selection before calling the administration service", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Duplicate Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,

        "role-2": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Role option #11 was selected more than once. Each option can appear only once in a preset request group.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects a missing or inactive role option before creating a preset group", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Invalid Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 999,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Role option #999 is not an active option in preset #7. Use `/role-preset show preset-id:7` to check the available option IDs.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects both before-start and after-start values for the same opening rule", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Confused Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,

        "open-minutes-before-start": 60,

        "open-minutes-after-start": 10,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Choose either `open-minutes-before-start` or `open-minutes-after-start`, not both.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects a preset group whose opening would not precede its closing", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Impossible Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,

        "open-minutes-before-start": 0,

        "close-minutes-before-start": 60,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "The role-request group must open before it closes. The supplied window would be T → T-60.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects an explicit preset channel where the bot cannot post", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Unavailable Channel",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,
      },

      channels: {
        channel: createTestTextChannel({
          canPost: false,
        }),
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "The bot does not currently have all required posting permissions in that preset role-request channel.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects @everyone as a preset request-group notification role", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Everyone Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,
      },

      roles: {
        "notify-role": {
          id: DISCORD_GUILD_ID,

          name: "@everyone",

          mentionable: true,
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "`@everyone` cannot be used as a preset request-group notification role.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects an unmentionable notification role for an explicit channel when the bot cannot mention it", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Unmentionable Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,
      },

      roles: {
        "notify-role": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: false,
        },
      },

      channels: {
        channel: createTestTextChannel({
          canMentionUnmentionableRoles: false,
        }),
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "The bot cannot currently mention **Naval** in that explicit preset channel.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("lists the guild's role-request presets", async () => {
    // Arrange
    queryServiceMocks.listRoleRequestPresets.mockResolvedValue([
      {
        id: 7,

        name: "Naval",

        description: "Standard naval roles.",

        active: true,

        activeOptionCount: 5,

        activeGroupCount: 2,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date("2026-09-01T12:00:00Z"),

        updatedAt: new Date("2026-09-02T12:00:00Z"),
      },

      {
        id: 8,

        name: "Old Competition",

        description: null,

        active: false,

        activeOptionCount: 0,

        activeGroupCount: 0,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date("2026-08-01T12:00:00Z"),

        updatedAt: new Date("2026-08-02T12:00:00Z"),
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",

      booleans: {
        "include-inactive": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(queryServiceMocks.listRoleRequestPresets).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      includeInactive: true,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("**Naval** (#7)");

    expect(content).toContain("5 active options");

    expect(content).toContain("2 active groups");

    expect(content).toContain("**Old Competition** (#8) — inactive");
  });

  it("shows a complete preset definition with relative timing and snapshotted destinations", async () => {
    // Arrange
    queryServiceMocks.getRoleRequestPresetDetails.mockResolvedValue({
      kind: "found",

      preset: {
        id: 7,

        name: "Naval",

        description: "Standard naval role requests.",

        active: true,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date("2026-09-01T12:00:00Z"),

        updatedAt: new Date("2026-09-02T12:00:00Z"),

        options: [
          {
            id: 11,

            key: "captain",

            displayName: "Captain",

            description: "Command the ship.",

            requestRestriction: "qualified_only",

            capacity: 1,

            sortOrder: 0,

            active: true,

            qualificationRoles: [
              {
                discordRoleId: "988000000000000010",

                roleNameSnapshot: "Qualified Captain",

                qualificationLevel: "qualified",
              },
            ],
          },

          {
            id: 12,

            key: "carpenter",

            displayName: "Carpenter",

            description: null,

            requestRestriction: "open",

            capacity: null,

            sortOrder: 1,

            active: true,

            qualificationRoles: [],
          },
        ],

        groups: [
          {
            id: 21,

            name: "Naval Roles",

            description: "General applications.",

            channelId: null,

            notifyRoleId: "988000000000000011",

            notifyRoleNameSnapshot: "Naval",

            requiresPositiveSignup: true,

            openMinutesBeforeStart: 60,

            closeMinutesBeforeStart: -10,

            sortOrder: 0,

            active: true,

            presetOptionIds: [12, 11],
          },
        ],
      },
    });

    const interaction = createInteraction({
      subcommand: "show",

      integers: {
        "preset-id": 7,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(queryServiceMocks.getRoleRequestPresetDetails).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("## Naval (#7)");

    expect(content).toContain("**Captain** (#11)");

    expect(content).toContain("Qualified only");

    expect(content).toContain("<@&988000000000000010>");

    expect(content).toContain("**Naval Roles** (#21)");

    expect(content).toContain("T-60 → T+10");

    expect(content).toContain("Guild default at application");

    expect(content).toContain("<@&988000000000000011>");

    expect(content).toContain("Carpenter (#12), Captain (#11)");
  });

  it("treats another guild's or missing preset as unavailable", async () => {
    // Arrange
    queryServiceMocks.getRoleRequestPresetDetails.mockResolvedValue({
      kind: "not_found",
    });

    const interaction = createInteraction({
      subcommand: "show",

      integers: {
        "preset-id": 999,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Role-request preset #999 was not found in this server.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("uses the normal event-admin authorisation contract", async () => {
    // Arrange
    authMocks.memberCanManageEvents.mockReturnValue(false);

    const interaction = createInteraction({
      subcommand: "create",

      strings: {
        name: "Naval",
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.createRoleRequestPreset).not.toHaveBeenCalled();

    expect(queryServiceMocks.listRoleRequestPresets).not.toHaveBeenCalled();

    expect(
      queryServiceMocks.getRoleRequestPresetDetails,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "You need the configured Event Admin role or the Manage Server permission to manage role-request presets.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "command.denied",

        outcome: "denied",

        targetType: "command",

        targetId: "/role-preset create",
      }),
    );
  });
});

function createInteraction(input: {
  subcommand: string;

  strings?: Record<string, string | null>;

  integers?: Record<string, number | null>;

  booleans?: Record<string, boolean | null>;

  roles?: Record<
    string,
    {
      id: string;

      name: string;

      mentionable?: boolean;
    } | null
  >;

  channels?: Record<
    string,
    {
      id: string;

      type: ChannelType;

      isSendable: () => boolean;

      permissionsFor: (member: unknown) => {
        has: (permission: bigint) => boolean;
      };
    } | null
  >;
}): {
  interaction: ChatInputCommandInteraction;

  deferReply: ReturnType<typeof vi.fn>;

  editReply: ReturnType<typeof vi.fn>;

  followUp: ReturnType<typeof vi.fn>;

  fetchChannel: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);

  const editReply = vi.fn().mockResolvedValue(undefined);

  const followUp = vi.fn().mockResolvedValue(undefined);

  const fetchChannel = vi.fn(async (channelId: string) => {
    const channel = Object.values(input.channels ?? {}).find(
      (candidate) => candidate?.id === channelId,
    );

    return channel ?? null;
  });

  const interaction = {
    commandName: "role-preset",

    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,

      name: "Preset Command Test Guild",

      members: {
        me: {
          id: "988000000000000099",
        },

        fetchMe: vi.fn().mockResolvedValue({
          id: "988000000000000099",
        }),
      },

      channels: {
        fetch: fetchChannel,
      },
    },

    member: {
      roles: {
        cache: new Map(),
      },
    },

    user: {
      id: ADMIN_USER_ID,
    },

    inCachedGuild: () => true,

    deferReply,

    editReply,

    followUp,

    options: {
      getSubcommand: () => input.subcommand,

      getString: (name: string, required?: boolean) => {
        const value = input.strings?.[name] ?? null;

        if (required && value === null) {
          throw new Error(`Missing required string option ${name}.`);
        }

        return value;
      },

      getInteger: (name: string, required?: boolean) => {
        const value = input.integers?.[name] ?? null;

        if (required && value === null) {
          throw new Error(`Missing required integer option ${name}.`);
        }

        return value;
      },

      getBoolean: (name: string) => input.booleans?.[name] ?? null,

      getRole: (name: string) => input.roles?.[name] ?? null,

      getChannel: (name: string) => input.channels?.[name] ?? null,
    },
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,

    deferReply,

    editReply,

    followUp,

    fetchChannel,
  };
}

function readFirstReplyContent(editReply: ReturnType<typeof vi.fn>): string {
  const firstCall = editReply.mock.calls[0];

  if (!firstCall) {
    throw new Error("Expected the command to edit its deferred reply.");
  }

  const payload = firstCall[0];

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("content" in payload) ||
    typeof payload.content !== "string"
  ) {
    throw new Error("Expected an object reply containing text content.");
  }

  return payload.content;
}

function createTestTextChannel(
  options: {
    canPost?: boolean;

    canMentionUnmentionableRoles?: boolean;
  } = {},
) {
  const canPost = options.canPost ?? true;

  const canMentionUnmentionableRoles =
    options.canMentionUnmentionableRoles ?? true;

  return {
    id: EXPLICIT_CHANNEL_ID,

    type: ChannelType.GuildText,

    isSendable: () => true,

    permissionsFor: () => ({
      has: (permission: bigint) => {
        if (permission === PermissionFlagsBits.MentionEveryone) {
          return canMentionUnmentionableRoles;
        }

        return canPost;
      },
    }),
  };
}

function mockPresetDetailsForGroup(): void {
  queryServiceMocks.getRoleRequestPresetDetails.mockResolvedValue({
    kind: "found",

    preset: {
      id: 7,

      name: "Naval",

      description: null,

      active: true,

      createdByUserId: ADMIN_USER_ID,

      createdAt: new Date("2026-09-01T12:00:00Z"),

      updatedAt: new Date("2026-09-01T12:00:00Z"),

      options: [
        {
          id: 11,

          key: "captain",

          displayName: "Captain",

          description: null,

          requestRestriction: "qualified_only",

          capacity: 1,

          sortOrder: 0,

          active: true,

          qualificationRoles: [],
        },

        {
          id: 12,

          key: "carpenter",

          displayName: "Carpenter",

          description: null,

          requestRestriction: "open",

          capacity: null,

          sortOrder: 1,

          active: true,

          qualificationRoles: [],
        },

        {
          id: 13,

          key: "retired-role",

          displayName: "Retired Role",

          description: null,

          requestRestriction: "open",

          capacity: null,

          sortOrder: 2,

          active: false,

          qualificationRoles: [],
        },
      ],

      groups: [],
    },
  });
}
