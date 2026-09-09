import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getGuildConfiguration: vi.fn(),

  memberCanManageEvents: vi.fn(),
}));

const adminServiceMocks = vi.hoisted(() => ({
  createRoleRequestPreset: vi.fn(),

  addPresetRoleOption: vi.fn(),
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

  it("registers create, list, show and option-add subcommands", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "role-preset",
    );

    expect(definition).toBeDefined();

    expect(definition?.options?.map((option) => option.name)).toEqual([
      "create",
      "list",
      "show",
      "option-add",
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
    } | null
  >;
}): {
  interaction: ChatInputCommandInteraction;

  deferReply: ReturnType<typeof vi.fn>;

  editReply: ReturnType<typeof vi.fn>;

  followUp: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);

  const editReply = vi.fn().mockResolvedValue(undefined);

  const followUp = vi.fn().mockResolvedValue(undefined);

  const interaction = {
    commandName: "role-preset",

    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,

      name: "Preset Command Test Guild",
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
    },
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,

    deferReply,

    editReply,

    followUp,
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
