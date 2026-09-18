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

  editRoleRequestPreset: vi.fn(),

  editPresetRequestGroup: vi.fn(),

  editPresetRoleOption: vi.fn(),

  replacePresetRequestGroupOptions: vi.fn(),

  replacePresetRoleOptionQualificationRoles: vi.fn(),

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

const presetApplicationMocks = vi.hoisted(() => ({
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
  () => presetApplicationMocks,
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

const OFFICER_NOTIFY_ROLE_ID = "988000000000000022";

const RESERVE_NOTIFY_ROLE_ID = "988000000000000023";

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

    expect(definition?.description).toBe(
      "Creates and manages reusable event role-request presets.",
    );

    expect(definition?.options?.map((option) => option.name)).toEqual([
      "create",
      "edit",
      "list",
      "show",
      "option-add",
      "option-edit",
      "option-qualifications-set",
      "group-add",
      "group-edit",
      "group-options-set",
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

  it("edits preset metadata through the administration service and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "updated",

      preset: {
        id: 7,

        name: "Naval Operations",

        description: "Updated reusable naval roles.",

        active: false,
      },
    });

    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        name: "Naval Operations",

        description: "Updated reusable naval roles.",
      },

      integers: {
        "preset-id": 7,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editRoleRequestPreset).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      name: "Naval Operations",

      description: "Updated reusable naval roles.",
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Updated role-request preset **Naval Operations** (#7).",
        "**Description:** Updated reusable naval roles.",
        "**Status:** Inactive",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.edit",

        outcome: "success",

        targetType: "role_request_preset",

        targetId: "7",

        details: {
          name: "Naval Operations",

          description: "Updated reusable naval roles.",

          active: false,
        },
      }),
    );
  });

  it("clears a preset description explicitly", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "updated",

      preset: {
        id: 7,

        name: "Naval",

        description: null,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "edit",

      integers: {
        "preset-id": 7,
      },

      booleans: {
        "clear-description": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editRoleRequestPreset).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      name: undefined,

      description: null,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Updated role-request preset **Naval** (#7).",
        "**Description:** None",
        "**Status:** Active",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects supplying a preset description while also clearing it", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        description: "This should not be accepted.",
      },

      integers: {
        "preset-id": 7,
      },

      booleans: {
        "clear-description": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editRoleRequestPreset).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Choose either `description` or `clear-description:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports an unchanged preset metadata edit without auditing a mutation", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "unchanged",

      preset: {
        id: 7,

        name: "Naval",

        description: "Reusable naval roles.",

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        name: "Naval",
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
        "Role-request preset **Naval** (#7) already has the requested metadata. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a conflicting preset name returned by metadata editing", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "name_conflict",

      name: "Linebattle",
    });

    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        name: "Linebattle",
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
        "A role-request preset named **Linebattle** already exists in this server.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports invalid or empty preset metadata edits", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "invalid_input",

      reason: "no_changes_requested",
    });

    const interaction = createInteraction({
      subcommand: "edit",

      integers: {
        "preset-id": 7,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editRoleRequestPreset).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      name: undefined,

      description: undefined,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Supply at least one metadata change: `name`, `description`, or `clear-description:true`.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a preset that cannot be found for metadata editing", async () => {
    // Arrange
    adminServiceMocks.editRoleRequestPreset.mockResolvedValue({
      kind: "preset_not_found",
    });

    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        name: "Renamed preset",
      },

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

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
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

  it("edits a preset role option and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.editPresetRoleOption.mockResolvedValue({
      kind: "updated",

      option: {
        id: 11,

        presetId: 7,

        key: "captain",

        displayName: "Ship Captain",

        description: "Leads the ship.",

        requestRestriction: "open",

        capacity: 4,

        sortOrder: 0,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "option-edit",

      strings: {
        name: "Ship Captain",

        description: "Leads the ship.",

        restriction: "open",
      },

      integers: {
        "preset-id": 7,

        "option-id": 11,

        capacity: 4,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRoleOption).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetOptionId: 11,

      displayName: "Ship Captain",

      description: "Leads the ship.",

      requestRestriction: "open",

      capacity: 4,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Updated preset role option **Ship Captain** (#11) in preset #7.",
        "**Logical key:** `captain`",
        "**Restriction:** Open",
        "**Capacity:** 4",
        "**Description:** Leads the ship.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.option.edit",

        outcome: "success",

        targetType: "role_request_preset_option",

        targetId: "11",

        details: {
          presetId: 7,

          key: "captain",

          displayName: "Ship Captain",

          description: "Leads the ship.",

          requestRestriction: "open",

          capacity: 4,

          active: true,
        },
      }),
    );
  });

  it("explicitly clears preset role-option description and capacity", async () => {
    // Arrange
    adminServiceMocks.editPresetRoleOption.mockResolvedValue({
      kind: "updated",

      option: {
        id: 11,

        presetId: 7,

        key: "captain",

        displayName: "Captain",

        description: null,

        requestRestriction: "open",

        capacity: null,

        sortOrder: 0,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "option-edit",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        "clear-description": true,

        "clear-capacity": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRoleOption).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetOptionId: 11,

      displayName: undefined,

      description: null,

      requestRestriction: undefined,

      capacity: null,
    });
  });

  it("rejects conflicting preset role-option clear arguments", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-edit",

      strings: {
        description: "Description",
      },

      integers: {
        "preset-id": 7,

        "option-id": 11,

        capacity: 2,
      },

      booleans: {
        "clear-description": true,

        "clear-capacity": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRoleOption).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Choose either a new value or its corresponding clear option, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports an unchanged preset role-option edit without auditing a mutation", async () => {
    // Arrange
    adminServiceMocks.editPresetRoleOption.mockResolvedValue({
      kind: "unchanged",

      option: {
        id: 11,

        presetId: 7,

        key: "captain",

        displayName: "Captain",

        description: null,

        requestRestriction: "open",

        capacity: null,

        sortOrder: 0,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "option-edit",

      strings: {
        name: "Captain",
      },

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset role option **Captain** (#11) already has the requested definition. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a missing qualification requirement for preset option editing", async () => {
    // Arrange
    adminServiceMocks.editPresetRoleOption.mockResolvedValue({
      kind: "invalid_input",

      reason: "missing_qualification_roles",
    });

    const interaction = createInteraction({
      subcommand: "option-edit",

      strings: {
        restriction: "qualified_only",
      },

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset role option #11 cannot be restricted to qualified members because it has no qualification roles configured.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports a preset role option that does not belong to the selected preset", async () => {
    // Arrange
    adminServiceMocks.editPresetRoleOption.mockResolvedValue({
      kind: "option_not_found",
    });

    const interaction = createInteraction({
      subcommand: "option-edit",

      strings: {
        name: "Ship Captain",
      },

      integers: {
        "preset-id": 7,

        "option-id": 999,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Role option #999 was not found in role-request preset #7.",

      allowedMentions: {
        parse: [],
      },
    });
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

  it("replaces preset role-option qualification roles and audits the mutation", async () => {
    // Arrange
    adminServiceMocks.replacePresetRoleOptionQualificationRoles.mockResolvedValue(
      {
        kind: "updated",

        option: {
          id: 11,

          presetId: 7,

          displayName: "Captain",

          requestRestriction: "qualified_only",

          active: true,
        },

        qualificationRoles: [
          {
            discordRoleId: QUALIFIED_ROLE_ID,

            roleNameSnapshot: "Qualified Captain",

            qualificationLevel: "qualified",
          },

          {
            discordRoleId: SUPERVISED_ROLE_ID,

            roleNameSnapshot: "Captain Trainee",

            qualificationLevel: "supervision_required",
          },
        ],
      },
    );

    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      roles: {
        "qualified-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Captain",
        },

        "supervised-role-1": {
          id: SUPERVISED_ROLE_ID,

          name: "Captain Trainee",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetOptionId: 11,

      qualificationRoles: [
        {
          discordRoleId: QUALIFIED_ROLE_ID,

          roleNameSnapshot: "Qualified Captain",

          qualificationLevel: "qualified",
        },

        {
          discordRoleId: SUPERVISED_ROLE_ID,

          roleNameSnapshot: "Captain Trainee",

          qualificationLevel: "supervision_required",
        },
      ],
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Replaced qualification roles for **Captain** (#11) in preset #7.",
        "**Restriction:** Qualified only",
        `**Fully qualified roles:** <@&${QUALIFIED_ROLE_ID}>`,
        `**Supervision-required roles:** <@&${SUPERVISED_ROLE_ID}>`,
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.option.qualifications.set",

        outcome: "success",

        targetType: "role_request_preset_option",

        targetId: "11",

        details: {
          presetId: 7,

          requestRestriction: "qualified_only",

          qualifiedRoleIds: [QUALIFIED_ROLE_ID],

          supervisedRoleIds: [SUPERVISED_ROLE_ID],

          active: true,
        },
      }),
    );
  });

  it("explicitly clears qualification roles from an open preset option", async () => {
    // Arrange
    adminServiceMocks.replacePresetRoleOptionQualificationRoles.mockResolvedValue(
      {
        kind: "updated",

        option: {
          id: 11,

          presetId: 7,

          displayName: "Captain",

          requestRestriction: "open",

          active: true,
        },

        qualificationRoles: [],
      },
    );

    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        "clear-all": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetOptionId: 11,

      qualificationRoles: [],
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "✅ Replaced qualification roles for **Captain** (#11) in preset #7.",
        "**Restriction:** Open",
        "**Fully qualified roles:** None configured",
        "**Supervision-required roles:** None configured",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("requires an explicit clear when no qualification roles are supplied", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Select at least one qualification role, or use `clear-all:true` to explicitly remove the complete qualification-role set.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("rejects clear-all together with replacement qualification roles", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        "clear-all": true,
      },

      roles: {
        "qualified-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Captain",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Choose either replacement qualification roles or `clear-all:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects one Discord role at both qualification levels before replacement", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
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
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "**Qualified Captain** cannot be both fully qualified and supervision-required for the same preset role option.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects @everyone before replacing preset qualification roles", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
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
    expect(
      adminServiceMocks.replacePresetRoleOptionQualificationRoles,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "`@everyone` cannot be used as a preset qualification role.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("reports an unchanged qualification-role replacement without auditing", async () => {
    // Arrange
    adminServiceMocks.replacePresetRoleOptionQualificationRoles.mockResolvedValue(
      {
        kind: "unchanged",

        option: {
          id: 11,

          presetId: 7,

          displayName: "Captain",

          requestRestriction: "qualified_only",

          active: true,
        },

        qualificationRoles: [
          {
            discordRoleId: QUALIFIED_ROLE_ID,

            roleNameSnapshot: "Qualified Captain",

            qualificationLevel: "qualified",
          },
        ],
      },
    );

    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      roles: {
        "qualified-role-1": {
          id: QUALIFIED_ROLE_ID,

          name: "Qualified Captain",
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset role option **Captain** (#11) already has the requested qualification-role set. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports when clearing qualifications would invalidate a qualified-only option", async () => {
    // Arrange
    adminServiceMocks.replacePresetRoleOptionQualificationRoles.mockResolvedValue(
      {
        kind: "invalid_input",

        reason: "missing_qualification_roles",
      },
    );

    const interaction = createInteraction({
      subcommand: "option-qualifications-set",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        "clear-all": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "A `Qualified only` preset role option must have at least one configured qualification role.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("edits a preset request group through the administration service and audits the final definition", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.editPresetRequestGroup.mockResolvedValue({
      kind: "updated",

      group: {
        id: 21,

        presetId: 7,

        name: "Command Roles",

        description: "Updated command applications.",

        channelId: EXPLICIT_CHANNEL_ID,

        notificationRoles: [
          {
            discordRoleId: OFFICER_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Officers",

            sortOrder: 0,
          },

          {
            discordRoleId: RESERVE_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Reserve",

            sortOrder: 1,
          },
        ],

        requiresPositiveSignup: false,

        openMinutesBeforeStart: -5,

        closeMinutesBeforeStart: -30,

        sortOrder: 0,

        active: false,
      },
    });

    const interaction = createInteraction({
      subcommand: "group-edit",

      strings: {
        name: "Command Roles",

        description: "Updated command applications.",
      },

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "open-minutes-after-start": 5,

        "close-minutes-after-start": 30,
      },

      booleans: {
        "requires-signup": false,
      },

      roles: {
        "notify-role-1": {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: true,
        },

        "notify-role-2": {
          id: RESERVE_NOTIFY_ROLE_ID,

          name: "Reserve",

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
    expect(adminServiceMocks.editPresetRequestGroup).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetGroupId: 21,

      name: "Command Roles",

      description: "Updated command applications.",

      channelId: EXPLICIT_CHANNEL_ID,

      notificationRoles: [
        {
          discordRoleId: OFFICER_NOTIFY_ROLE_ID,

          roleNameSnapshot: "Officers",
        },

        {
          discordRoleId: RESERVE_NOTIFY_ROLE_ID,

          roleNameSnapshot: "Reserve",
        },
      ],

      requiresPositiveSignup: false,

      openMinutesBeforeStart: -5,

      closeMinutesBeforeStart: -30,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Updated request group **Command Roles** (#21)");

    expect(content).toContain("Updated command applications.");

    expect(content).toContain(`<#${EXPLICIT_CHANNEL_ID}>`);

    expect(content).toContain(`<@&${OFFICER_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(`<@&${RESERVE_NOTIFY_ROLE_ID}>`);

    expect(content).toContain("T+5 → T+30");

    expect(content).toContain("**Status:** Inactive");

    expect(content).toContain("Existing role-option mappings are unchanged.");

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.group.edit",

        outcome: "success",

        targetType: "role_request_preset_group",

        targetId: "21",

        details: {
          presetId: 7,

          name: "Command Roles",

          description: "Updated command applications.",

          channelId: EXPLICIT_CHANNEL_ID,

          notificationRoleIds: [OFFICER_NOTIFY_ROLE_ID, RESERVE_NOTIFY_ROLE_ID],

          requiresPositiveSignup: false,

          openMinutesBeforeStart: -5,

          closeMinutesBeforeStart: -30,

          active: false,
        },
      }),
    );
  });

  it("explicitly clears nullable preset request-group configuration", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.editPresetRequestGroup.mockResolvedValue({
      kind: "updated",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        description: null,

        channelId: null,

        notificationRoles: [],

        requiresPositiveSignup: true,

        openMinutesBeforeStart: 60,

        closeMinutesBeforeStart: -10,

        sortOrder: 0,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },

      booleans: {
        "clear-description": true,

        "clear-channel": true,

        "clear-notification-roles": true,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRequestGroup).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetGroupId: 21,

      name: undefined,

      description: null,

      channelId: null,

      notificationRoles: [],

      requiresPositiveSignup: undefined,

      openMinutesBeforeStart: undefined,

      closeMinutesBeforeStart: undefined,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("**Description:** None");

    expect(content).toContain("**Channel:** Guild default at application");

    expect(content).toContain("**Notification roles:** None");
  });

  it("rejects replacement notification roles together with an explicit clear", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },

      booleans: {
        "clear-notification-roles": true,
      },

      roles: {
        "notify-role-1": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      queryServiceMocks.getRoleRequestPresetDetails,
    ).not.toHaveBeenCalled();

    expect(adminServiceMocks.editPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Choose either replacement notification roles or `clear-notification-roles:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects duplicate notification roles before editing a preset request group", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },

      roles: {
        "notify-role-1": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        "notify-role-2": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Notification role **Naval** was selected more than once.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects a preset request-group edit whose final window is invalid", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        /*
         * Existing close is T+10.
         *
         * Moving opening to T+20 would place opening after closing.
         */
        "open-minutes-after-start": 20,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "The role-request group must open before it closes. The supplied final window would be T+20 → T+10.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("validates replacement notification roles against an existing explicit preset channel", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },

      roles: {
        "notify-role-1": {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: false,
        },
      },

      /*
       * This channel is available to guild.channels.fetch(), but is not supplied
       * as the `channel` slash option. The group is therefore keeping its
       * existing destination rather than replacing it.
       */
      channels: {
        existing: createTestTextChannel({
          canMentionUnmentionableRoles: false,
        }),
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.fetchChannel).toHaveBeenCalledWith(EXPLICIT_CHANNEL_ID);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "The bot cannot currently mention **Officers** in that explicit preset channel.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("reports an unchanged preset request-group edit without auditing a mutation", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.editPresetRequestGroup.mockResolvedValue({
      kind: "unchanged",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        description: "General naval applications.",

        channelId: EXPLICIT_CHANNEL_ID,

        notificationRoles: [
          {
            discordRoleId: NAVAL_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Naval",

            sortOrder: 0,
          },
        ],

        requiresPositiveSignup: true,

        openMinutesBeforeStart: 60,

        closeMinutesBeforeStart: -10,

        sortOrder: 0,

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "group-edit",

      strings: {
        name: "Naval Roles",
      },

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset request group **Naval Roles** (#21) already has the requested definition. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports when no preset request-group changes were supplied", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.editPresetRequestGroup.mockResolvedValue({
      kind: "invalid_input",

      reason: "no_changes_requested",
    });

    const interaction = createInteraction({
      subcommand: "group-edit",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.editPresetRequestGroup).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetGroupId: 21,

      name: undefined,

      description: undefined,

      channelId: undefined,

      notificationRoles: undefined,

      requiresPositiveSignup: undefined,

      openMinutesBeforeStart: undefined,

      closeMinutesBeforeStart: undefined,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Supply at least one request-group change: `name`, `description`, `clear-description:true`, `channel`, `clear-channel:true`, notification roles, `clear-notification-roles:true`, `requires-signup`, or an opening/closing offset.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("replaces a preset request group's ordered role-option mappings and audits the mutation", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.replacePresetRequestGroupOptions.mockResolvedValue({
      kind: "updated",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        active: true,
      },

      presetOptionIds: [12, 11],

      inactivePresetOptionIds: [],
    });

    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 12,

        "role-2": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRequestGroupOptions,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetGroupId: 21,

      presetOptionIds: [12, 11],
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain(
      "Replaced role-option mappings for request group **Naval Roles** (#21)",
    );

    /*
     * The supplied order is authoritative.
     */
    expect(content.indexOf("Carpenter (#12)")).toBeLessThan(
      content.indexOf("Captain (#11)"),
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "role_preset.group.options.set",

        outcome: "success",

        targetType: "role_request_preset_group",

        targetId: "21",

        details: {
          presetId: 7,

          presetOptionIds: [12, 11],

          inactivePresetOptionIds: [],

          active: true,
        },
      }),
    );
  });

  it("allows an inactive preset option in a replacement group mapping and warns the administrator", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.replacePresetRequestGroupOptions.mockResolvedValue({
      kind: "updated",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        active: true,
      },

      presetOptionIds: [13],

      inactivePresetOptionIds: [13],
    });

    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 13,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRequestGroupOptions,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      presetId: 7,

      presetGroupId: 21,

      presetOptionIds: [13],
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Retired Role (#13) — inactive");

    expect(content).toContain(
      "This active request group currently has no active mapped role options.",
    );

    expect(content).toContain("Preset application will reject it");
  });

  it("rejects duplicate role options before replacing preset group mappings", async () => {
    // Arrange
    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 11,

        "role-2": 11,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      queryServiceMocks.getRoleRequestPresetDetails,
    ).not.toHaveBeenCalled();

    expect(
      adminServiceMocks.replacePresetRequestGroupOptions,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Role option #11 was selected more than once. Each option can appear only once in a preset request group.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("rejects a group mapping option that does not belong to the preset", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 999,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(
      adminServiceMocks.replacePresetRequestGroupOptions,
    ).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Role option #999 was not found in role-request preset #7. Use `/role-preset show preset-id:7` to check the available option IDs.",

      allowedMentions: {
        parse: [],
      },
    });
  });

  it("reports an unchanged preset group mapping without auditing a mutation", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.replacePresetRequestGroupOptions.mockResolvedValue({
      kind: "unchanged",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        active: true,
      },

      presetOptionIds: [11, 12],

      inactivePresetOptionIds: [],
    });

    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 11,

        "role-2": 12,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Preset request group **Naval Roles** (#21) already has the requested ordered role-option mapping. No changes were made.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("reports when a preset option disappears before group mapping replacement commits", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    adminServiceMocks.replacePresetRequestGroupOptions.mockResolvedValue({
      kind: "invalid_input",

      reason: "option_not_found",

      presetOptionId: 12,
    });

    const interaction = createInteraction({
      subcommand: "group-options-set",

      integers: {
        "preset-id": 7,

        "group-id": 21,

        "role-1": 12,
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Role option #12 was not found in role-request preset #7. Use `/role-preset show preset-id:7` to check the available option IDs.",

      allowedMentions: {
        parse: [],
      },
    });

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("adds a preset request group with ordered options, an explicit channel and multiple notification roles", async () => {
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

        notificationRoles: [
          {
            discordRoleId: NAVAL_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Naval",

            sortOrder: 0,
          },

          {
            discordRoleId: OFFICER_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Officers",

            sortOrder: 1,
          },

          {
            discordRoleId: RESERVE_NOTIFY_ROLE_ID,

            roleNameSnapshot: "Reserve",

            sortOrder: 2,
          },
        ],

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
        "notify-role-1": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        "notify-role-2": {
          id: OFFICER_NOTIFY_ROLE_ID,

          name: "Officers",

          mentionable: true,
        },

        "notify-role-3": {
          id: RESERVE_NOTIFY_ROLE_ID,

          name: "Reserve",

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

      notificationRoles: [
        {
          discordRoleId: NAVAL_NOTIFY_ROLE_ID,

          roleNameSnapshot: "Naval",
        },

        {
          discordRoleId: OFFICER_NOTIFY_ROLE_ID,

          roleNameSnapshot: "Officers",
        },

        {
          discordRoleId: RESERVE_NOTIFY_ROLE_ID,

          roleNameSnapshot: "Reserve",
        },
      ],

      requiresPositiveSignup: true,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: -10,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("Added request group **Naval Roles** (#41)");

    expect(content).toContain("to preset #7");

    expect(content).toContain(`<#${EXPLICIT_CHANNEL_ID}>`);

    expect(content).toContain(`<@&${NAVAL_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(`<@&${OFFICER_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(`<@&${RESERVE_NOTIFY_ROLE_ID}>`);

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

          notificationRoleIds: [
            NAVAL_NOTIFY_ROLE_ID,

            OFFICER_NOTIFY_ROLE_ID,

            RESERVE_NOTIFY_ROLE_ID,
          ],

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

        notificationRoles: [],

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

        notificationRoles: [],

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
        "notify-role-1": {
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

  it("rejects the same preset request-group notification role selected more than once", async () => {
    // Arrange
    mockPresetDetailsForGroup();

    const interaction = createInteraction({
      subcommand: "group-add",

      strings: {
        name: "Duplicate Notification Group",
      },

      integers: {
        "preset-id": 7,

        "role-1": 11,
      },

      roles: {
        "notify-role-1": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },

        "notify-role-2": {
          id: NAVAL_NOTIFY_ROLE_ID,

          name: "Naval",

          mentionable: true,
        },
      },
    });

    // Act
    await handleRolePresetCommand(interaction.interaction);

    // Assert
    expect(adminServiceMocks.addPresetRequestGroup).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Notification role **Naval** was selected more than once.",

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
        "notify-role-1": {
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

  it("does not imply that activating a preset guarantees successful application", async () => {
    adminServiceMocks.setRoleRequestPresetActive.mockResolvedValue({
      kind: "updated",

      preset: {
        id: 7,

        name: "Naval",

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "set-active",

      integers: {
        "preset-id": 7,
      },

      booleans: {
        active: true,
      },
    });

    await handleRolePresetCommand(interaction.interaction);

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("eligible for application again");

    expect(content).toContain(
      "provided its current active role options and request groups form a valid reusable configuration",
    );

    expect(content).toContain("/role-preset show preset-id:7");

    expect(content).not.toContain("It can now be applied to new events.");
  });

  it("describes reactivated preset options as participating through active group mappings", async () => {
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "updated",

      option: {
        id: 11,

        presetId: 7,

        displayName: "Captain",

        active: true,
      },

      newlyInvalidActiveGroups: [],
    });

    const interaction = createInteraction({
      subcommand: "option-set-active",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        active: true,
      },
    });

    await handleRolePresetCommand(interaction.interaction);

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain(
      "participate in future preset applications where it is mapped into an active request group",
    );

    expect(content).not.toContain("available for future event snapshots again");
  });

  it("gives actionable repair commands when option deactivation invalidates active groups", async () => {
    adminServiceMocks.setRoleRequestPresetOptionActive.mockResolvedValue({
      kind: "updated",

      option: {
        id: 11,

        presetId: 7,

        displayName: "Captain",

        active: false,
      },

      newlyInvalidActiveGroups: [
        {
          id: 21,

          name: "Naval Roles",
        },
      ],
    });

    const interaction = createInteraction({
      subcommand: "option-set-active",

      integers: {
        "preset-id": 7,

        "option-id": 11,
      },

      booleans: {
        active: false,
      },
    });

    await handleRolePresetCommand(interaction.interaction);

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("/role-preset option-set-active");

    expect(content).toContain("/role-preset group-options-set");

    expect(content).toContain("/role-preset group-set-active");
  });

  it("does not imply that activating a preset group guarantees a usable snapshot", async () => {
    adminServiceMocks.setRoleRequestPresetGroupActive.mockResolvedValue({
      kind: "updated",

      group: {
        id: 21,

        presetId: 7,

        name: "Naval Roles",

        active: true,
      },
    });

    const interaction = createInteraction({
      subcommand: "group-set-active",

      integers: {
        "preset-id": 7,

        "group-id": 21,
      },

      booleans: {
        active: true,
      },
    });

    await handleRolePresetCommand(interaction.interaction);

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain(
      "It will be considered by future preset applications.",
    );

    expect(content).toContain(
      "still requires the group to have at least one active mapped role option",
    );

    expect(content).toContain("/role-preset show preset-id:7");
  });

  it("gives actionable guidance when preset application finds an active group with no active mappings", async () => {
    presetApplicationMocks.applyRoleRequestPresetToEvent.mockResolvedValue({
      kind: "invalid_preset",

      reason: "active_group_without_active_options",

      presetGroupId: 21,
    });

    const interaction = createInteraction({
      subcommand: "apply",

      integers: {
        "preset-id": 7,

        "event-id": 42,
      },
    });

    await handleRolePresetCommand(interaction.interaction);

    expect(
      presetApplicationMocks.applyRoleRequestPresetToEvent,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      eventId: 42,

      presetId: 7,

      appliedByUserId: ADMIN_USER_ID,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain(
      "Preset group #21 has no active mapped role options.",
    );

    expect(content).toContain("/role-preset show preset-id:7");

    expect(content).toContain("/role-preset option-set-active");

    expect(content).toContain("/role-preset group-options-set");

    expect(content).toContain("/role-preset group-set-active");

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("points administrators to inactive presets when the active list is empty", async () => {
    queryServiceMocks.listRoleRequestPresets.mockResolvedValue([]);

    const interaction = createInteraction({
      subcommand: "list",
    });

    await handleRolePresetCommand(interaction.interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "This server has no active role-request presets. Use `/role-preset list include-inactive:true` to inspect inactive presets.",

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

    expect(content).toContain(
      "Use `/role-preset show preset-id:<id>` to see role-option and request-group IDs.",
    );

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

        groups: [
          {
            id: 21,

            name: "Naval Roles",

            description: "General applications.",

            channelId: null,

            notificationRoles: [
              {
                discordRoleId: NAVAL_NOTIFY_ROLE_ID,

                roleNameSnapshot: "Naval",

                sortOrder: 0,
              },

              {
                discordRoleId: OFFICER_NOTIFY_ROLE_ID,

                roleNameSnapshot: "Officers",

                sortOrder: 1,
              },

              {
                discordRoleId: RESERVE_NOTIFY_ROLE_ID,

                roleNameSnapshot: "Reserve",

                sortOrder: 2,
              },
            ],

            requiresPositiveSignup: true,

            openMinutesBeforeStart: 60,

            closeMinutesBeforeStart: -10,

            sortOrder: 0,

            active: true,

            presetOptionIds: [12, 13, 11],
          },
          {
            id: 22,

            name: "Retired Roles",

            description: null,

            channelId: EXPLICIT_CHANNEL_ID,

            notificationRoles: [],

            requiresPositiveSignup: false,

            openMinutesBeforeStart: 30,

            closeMinutesBeforeStart: -10,

            sortOrder: 1,

            active: true,

            presetOptionIds: [13],
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

    expect(content).toContain("Apply-time guild default");

    expect(content).toContain(`<@&${NAVAL_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(`<@&${OFFICER_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(`<@&${RESERVE_NOTIFY_ROLE_ID}>`);

    expect(content).toContain(
      "Carpenter (#12), Retired Role (#13) — inactive, Captain (#11)",
    );

    expect(content).toContain(
      "Inactive mapped options remain stored but are omitted from new event snapshots while inactive.",
    );

    expect(content).toContain("**Retired Roles** (#22)");

    expect(content).toContain(`Channel: Fixed — <#${EXPLICIT_CHANNEL_ID}>`);

    expect(content).toContain(
      "Active group has no active mapped role options. Preset application will reject this group until it is repaired or deactivated.",
    );

    expect(content).toContain("**Retired Role** (#13) — inactive");
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

      groups: [
        {
          id: 21,

          name: "Naval Roles",

          description: "General naval applications.",

          channelId: EXPLICIT_CHANNEL_ID,

          notificationRoles: [
            {
              discordRoleId: NAVAL_NOTIFY_ROLE_ID,

              roleNameSnapshot: "Naval",

              sortOrder: 0,
            },
          ],

          requiresPositiveSignup: true,

          openMinutesBeforeStart: 60,

          closeMinutesBeforeStart: -10,

          sortOrder: 0,

          active: true,

          presetOptionIds: [11, 12],
        },
      ],
    },
  });
}
