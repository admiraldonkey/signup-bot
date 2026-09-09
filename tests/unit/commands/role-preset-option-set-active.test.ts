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

const DISCORD_GUILD_ID = "991000000000000001";

const ADMIN_USER_ID = "991000000000000002";

const EVENT_ADMIN_ROLE_ID = "991000000000000003";

const PRESET_ID = 7;

const OPTION_ID = 11;

describe("/role-preset option-set-active", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Preset Option Lifecycle Test Guild",

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

  it("registers option-set-active with required preset, option and active values", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "role-preset",
    );

    expect(definition).toBeDefined();

    const setActive = definition?.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "option-set-active",
    );

    expect(setActive).toBeDefined();

    if (
      !setActive ||
      setActive.type !== ApplicationCommandOptionType.Subcommand
    ) {
      throw new Error(
        "Expected /role-preset option-set-active to be registered as a subcommand.",
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
        name: "option-id",

        required: true,
      },

      {
        name: "active",

        required: true,
      },
    ]);
  });

  it("deactivates a preset role option without rewriting neighbouring configuration", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "updated",

      option: {
        id: OPTION_ID,

        presetId: PRESET_ID,

        displayName: "Captain",

        active: false,
      },

      newlyInvalidActiveGroups: [],
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(
      adminServiceMocks.setRoleRequestPresetOptionActive,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: PRESET_ID,

      presetOptionId: OPTION_ID,

      active: false,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Preset role option **Captain** (#11) is now inactive.",

        "",
        "It will be excluded from future event snapshots.",

        "Its qualification rules and request-group mappings are unchanged.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.option.active.set",

        outcome: "success",

        targetType: "role_request_preset_option",

        targetId: String(OPTION_ID),

        details: {
          presetId: PRESET_ID,

          active: false,

          newlyInvalidActiveGroupIds: [],
        },
      }),
    );
  });

  it("warns when deactivation leaves active request groups with no active role options", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "updated",

      option: {
        id: OPTION_ID,

        presetId: PRESET_ID,

        displayName: "Captain",

        active: false,
      },

      newlyInvalidActiveGroups: [
        {
          id: 21,

          name: "Captain Only",
        },

        {
          id: 23,

          name: "Command Cover",
        },
      ],
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain(
      "Preset role option **Captain** (#11) is now inactive.",
    );

    expect(content).toContain("⚠️ **Preset configuration warning**");

    expect(content).toContain("**Captain Only** (#21)");

    expect(content).toContain("**Command Cover** (#23)");

    expect(content).toContain(
      "These groups remain active, but now have no active role options.",
    );

    expect(content).toContain(
      "The preset cannot be applied successfully while an active group has no active role options.",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "role_preset.option.active.set",

        targetId: "11",

        details: {
          presetId: 7,

          active: false,

          newlyInvalidActiveGroupIds: [21, 23],
        },
      }),
    );
  });

  it("reactivates a preset role option and preserves its existing mappings", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "updated",

      option: {
        id: OPTION_ID,

        presetId: PRESET_ID,

        displayName: "Captain",

        active: true,
      },

      newlyInvalidActiveGroups: [],
    });

    const interaction = createInteraction(true);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Preset role option **Captain** (#11) is now active.",

        "",
        "It is available for future event snapshots again.",

        "Existing qualification rules and request-group mappings are unchanged.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "role_preset.option.active.set",

        targetId: "11",

        details: {
          presetId: 7,

          active: true,

          newlyInvalidActiveGroupIds: [],
        },
      }),
    );
  });

  it("treats an already-matching option lifecycle state as an idempotent no-op", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "unchanged",

      option: {
        id: OPTION_ID,

        presetId: PRESET_ID,

        displayName: "Captain",

        active: false,
      },
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset role option **Captain** (#11) is already inactive. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a missing or foreign-guild preset as not found", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
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

  it("reports an option that does not belong to the selected preset as not found", async () => {
    // Arrange
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "option_not_found",
    });

    const interaction = createInteraction(false);

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Role option #11 was not found in role-request preset #7.",

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

      name: "Preset Option Lifecycle Test Guild",
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
      getSubcommand: () => "option-set-active",

      getInteger: (name: string, required?: boolean) => {
        let value: number | null = null;

        switch (name) {
          case "preset-id":
            value = PRESET_ID;

            break;

          case "option-id":
            value = OPTION_ID;

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
