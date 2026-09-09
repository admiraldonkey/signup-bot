import {
  ApplicationCommandOptionType,
  MessageFlags,
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

const applicationServiceMocks = vi.hoisted(() => ({
  applyRoleRequestPresetToEvent: vi.fn(),
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

vi.mock(
  "../../../src/role-requests/role-request-preset-service.js",
  () => applicationServiceMocks,
);

vi.mock("../../../src/audit/audit-log.js", () => auditMocks);

import { commandDefinitions } from "../../../src/commands/definitions.js";

import { handleRolePresetCommand } from "../../../src/commands/role-preset.js";

const DISCORD_GUILD_ID = "992000000000000001";

const ADMIN_USER_ID = "992000000000000002";

const EVENT_ADMIN_ROLE_ID = "992000000000000003";

const PRESET_ID = 7;

const GROUP_ID = 21;

describe("/role-preset group-set-active", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Preset Group Lifecycle Test Guild",

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

  it("registers group-set-active with required preset, group and active values", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "role-preset",
    );

    expect(definition).toBeDefined();

    const setActive = definition?.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "group-set-active",
    );

    expect(setActive).toBeDefined();

    if (
      !setActive ||
      setActive.type !== ApplicationCommandOptionType.Subcommand
    ) {
      throw new Error(
        "Expected /role-preset group-set-active to be registered as a subcommand.",
      );
    }

    expect(
      setActive.options?.map((option) => ({
        name: option.name,

        required: option.required,
      })),
    ).toEqual([
      {
        name: "preset-id",

        required: true,
      },

      {
        name: "group-id",

        required: true,
      },

      {
        name: "active",

        required: true,
      },
    ]);
  });

  it("deactivates a preset request group and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "updated",

      group: {
        id: GROUP_ID,

        presetId: PRESET_ID,

        name: "Naval Roles",

        active: false,
      },
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(
      adminServiceMocks.setRoleRequestPresetGroupActive,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: PRESET_ID,

      presetGroupId: GROUP_ID,

      active: false,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Preset request group **Naval Roles** (#21) is now inactive.",

        "",

        "It will be excluded from future event snapshots.",

        "Its role-option mappings and configuration are unchanged.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.group.active.set",

        outcome: "success",

        targetType: "role_request_preset_group",

        targetId: String(GROUP_ID),

        details: {
          presetId: PRESET_ID,

          active: false,
        },
      }),
    );
  });

  it("reactivates a preset request group without claiming its mappings were rebuilt", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "updated",

      group: {
        id: GROUP_ID,

        presetId: PRESET_ID,

        name: "Naval Roles",

        active: true,
      },
    });

    const interaction = createInteraction(true);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Preset request group **Naval Roles** (#21) is now active.",

        "",

        "It is available for future event snapshots again.",

        "Its existing role-option mappings and configuration are unchanged.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "role_preset.group.active.set",

        targetId: "21",

        details: {
          presetId: 7,

          active: true,
        },
      }),
    );
  });

  it("treats an already-matching group lifecycle state as an idempotent no-op", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "unchanged",

      group: {
        id: GROUP_ID,

        presetId: PRESET_ID,

        name: "Naval Roles",

        active: false,
      },
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset request group **Naval Roles** (#21) is already inactive. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a missing or foreign-guild preset as not found", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "preset_not_found",
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Role-request preset #7 was not found in this server.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a group that does not belong to the selected preset as not found", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "group_not_found",
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Request group #21 was not found in role-request preset #7.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

function createInteraction(active: boolean): {
  interaction: ChatInputCommandInteraction;

  deferReply: ReturnType<typeof vi.fn>;

  editReply: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);

  const editReply = vi.fn().mockResolvedValue(undefined);

  const interaction = {
    commandName: "role-preset",

    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,

      name: "Preset Group Lifecycle Test Guild",
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

    options: {
      getSubcommand: () => "group-set-active",

      getInteger: (name: string, required?: boolean) => {
        let value: number | null = null;

        switch (name) {
          case "preset-id":
            value = PRESET_ID;

            break;

          case "group-id":
            value = GROUP_ID;

            break;
        }

        if (required && value === null) {
          throw new Error(`Missing required integer option ${name}.`);
        }

        return value;
      },

      getBoolean: (name: string, required?: boolean) => {
        const value = name === "active" ? active : null;

        if (required && value === null) {
          throw new Error(`Missing required boolean option ${name}.`);
        }

        return value;
      },
    },
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,

    deferReply,

    editReply,
  };
}
