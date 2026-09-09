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

const DISCORD_GUILD_ID = "989000000000000001";

const ADMIN_USER_ID = "989000000000000002";

const EVENT_ADMIN_ROLE_ID = "989000000000000003";

const PRESET_ID = 7;

const EVENT_ID = 101;

describe("/role-preset apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Preset Apply Test Guild",

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

  it("registers an apply subcommand with preset and event IDs", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "role-preset",
    );

    expect(definition).toBeDefined();

    const apply = definition?.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "apply",
    );

    expect(apply).toBeDefined();

    if (!apply || apply.type !== ApplicationCommandOptionType.Subcommand) {
      throw new Error(
        "Expected /role-preset apply to be registered as a subcommand.",
      );
    }

    expect(
      apply.options?.map((option) => ({
        name: option.name,

        required: option.required,
      })),
    ).toEqual([
      {
        name: "preset-id",

        required: true,
      },

      {
        name: "event-id",

        required: true,
      },
    ]);
  });

  it("applies a preset snapshot to an event and audits the mutation", async () => {
    // Arrange
    applicationServiceMocks.applyRoleRequestPresetToEvent.mockResolvedValue({
      kind: "applied",

      eventId: EVENT_ID,

      presetId: PRESET_ID,

      eventRoleOptionIds: [31, 32, 33],

      roleRequestGroupIds: [41, 42],
    });

    const interaction = createInteraction();

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(
      applicationServiceMocks.applyRoleRequestPresetToEvent,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      eventId: EVENT_ID,

      presetId: PRESET_ID,

      appliedByUserId: ADMIN_USER_ID,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Applied role-request preset #7 to event #101");

    expect(content).toContain("3 role options");

    expect(content).toContain("#31, #32, #33");

    expect(content).toContain("2 request groups");

    expect(content).toContain("#41, #42");

    expect(content).toContain("/event role-group-list");

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.apply",

        outcome: "success",

        targetType: "event",

        targetId: String(EVENT_ID),

        details: {
          presetId: PRESET_ID,

          eventRoleOptionIds: [31, 32, 33],

          roleRequestGroupIds: [41, 42],
        },
      }),
    );
  });

  it.each([
    [
      {
        kind: "event_not_found",
      },

      "Event #101 was not found in this server.",
    ],

    [
      {
        kind: "event_terminal",

        status: "cancelled",
      },

      "Event #101 is cancelled and cannot accept a role-request preset.",
    ],

    [
      {
        kind: "event_terminal",

        status: "completed",
      },

      "Event #101 is completed and cannot accept a role-request preset.",
    ],

    [
      {
        kind: "role_requests_disabled",
      },

      "Event #101's event type has role requests disabled.",
    ],

    [
      {
        kind: "preset_not_found",
      },

      "Role-request preset #7 was not found in this server.",
    ],

    [
      {
        kind: "preset_inactive",
      },

      "Role-request preset #7 is inactive and cannot be applied.",
    ],

    [
      {
        kind: "already_applied",
      },

      "Role-request preset #7 has already been applied to event #101.",
    ],

    [
      {
        kind: "missing_default_channel",

        presetGroupId: 21,
      },

      "Preset group #21 uses the guild default role-request channel, but no default role-request channel is configured.",
    ],

    [
      {
        kind: "signup_required",

        presetGroupId: 22,
      },

      "Preset group #22 requires a positive signup, but event #101 has signups disabled.",
    ],

    [
      {
        kind: "role_option_conflict",

        key: "captain",
      },

      "Event #101 already has a role option with the logical key `captain`.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "no_active_options",
      },

      "Role-request preset #7 has no active role options.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "no_active_groups",
      },

      "Role-request preset #7 has no active request groups.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "invalid_request_restriction",

        presetOptionId: 11,
      },

      "Preset role option #11 has an invalid request restriction.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "missing_qualification_roles",

        presetOptionId: 11,
      },

      "Preset role option #11 is qualified-only but has no qualification roles.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "invalid_qualification_level",

        presetOptionId: 11,
      },

      "Preset role option #11 contains an invalid qualification level.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "group_option_outside_preset",

        presetGroupId: 21,

        presetOptionId: 999,
      },

      "Preset group #21 references role option #999 outside preset #7.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "active_group_without_active_options",

        presetGroupId: 21,
      },

      "Preset group #21 has no active role options.",
    ],

    [
      {
        kind: "invalid_preset",

        reason: "invalid_group_window",

        presetGroupId: 21,
      },

      "Preset group #21 does not open before it closes.",
    ],
  ])(
    "reports application failure %# without auditing a successful mutation",
    async (result, expectedContent) => {
      // Arrange
      applicationServiceMocks.applyRoleRequestPresetToEvent.mockResolvedValue(
        result,
      );

      const interaction = createInteraction();

      // Act
      await handleRolePresetCommand(interaction.interaction);

      // Assert
      const content = readFirstReplyContent(interaction.editReply);

      expect(content).toBe(expectedContent);

      expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
    },
  );
});

function createInteraction(): {
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

      name: "Preset Apply Test Guild",
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
      getSubcommand: () => "apply",

      getInteger: (name: string, required?: boolean) => {
        let value: number | null = null;

        switch (name) {
          case "preset-id":
            value = PRESET_ID;

            break;

          case "event-id":
            value = EVENT_ID;

            break;
        }

        if (required && value === null) {
          throw new Error(`Missing required integer option ${name}.`);
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
