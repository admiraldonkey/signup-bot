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

const templateServiceMocks = vi.hoisted(() => ({
  createEventTemplate: vi.fn(),

  editEventTemplate: vi.fn(),

  getEventTemplate: vi.fn(),

  listEventTemplates: vi.fn(),

  setEventTemplateActive: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("../../../src/auth/event-admin.js", () => authMocks);

vi.mock(
  "../../../src/templates/event-template-admin-service.js",
  () => templateServiceMocks,
);

vi.mock("../../../src/audit/audit-log.js", () => auditMocks);

import { commandDefinitions } from "../../../src/commands/definitions.js";
import { handleTemplateCommand } from "../../../src/commands/template.js";

const DISCORD_GUILD_ID = "991000000000000001";

const ADMIN_USER_ID = "991000000000000002";

const EVENT_ADMIN_ROLE_ID = "991000000000000003";

const PUBLICATION_CHANNEL_ID = "991000000000000004";

describe("/template command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Template Command Test Guild",

      timezone: "Europe/London",

      enabled: true,

      eventAdminRoleId: EVENT_ADMIN_ROLE_ID,

      attendanceChannelId: "991000000000000099",

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

  it("registers the initial template administration subcommands", () => {
    const definition = commandDefinitions.find(
      (command) => command.name === "template",
    );

    expect(definition).toBeDefined();

    expect(definition?.description).toBe(
      "Creates and manages reusable event templates.",
    );

    expect(definition?.options?.map((option) => option.name)).toEqual([
      "create",
      "edit",
      "list",
      "show",
      "set-active",
    ]);

    const createDefinition = definition?.options?.find(
      (option) => option.name === "create",
    );

    expect(createDefinition).toBeDefined();

    if (
      !createDefinition ||
      !("options" in createDefinition) ||
      !createDefinition.options
    ) {
      throw new Error(
        "Expected /template create to be a subcommand with options.",
      );
    }

    expect(createDefinition.options.map((option) => option.name)).toEqual([
      "name",
      "event-type",
      "region",
      "timezone",
      "description",
      "local-time",
      "duration-minutes",
      "signups",
      "close-minutes-before",
      "detailed-deadline",
      "publication-mode",
      "publish-minutes-before-start",
      "publication-channel",
      "role-preset-id",
    ]);

    const editDefinition = definition?.options?.find(
      (option) => option.name === "edit",
    );

    expect(editDefinition).toBeDefined();

    if (
      !editDefinition ||
      !("options" in editDefinition) ||
      !editDefinition.options
    ) {
      throw new Error(
        "Expected /template edit to be a subcommand with options.",
      );
    }

    expect(editDefinition.options.map((option) => option.name)).toEqual([
      "template-id",
      "name",
      "event-type",
      "region",
      "clear-region",
      "role-preset-id",
      "clear-role-preset",
      "timezone",
      "description",
      "clear-description",
      "local-time",
      "clear-local-time",
      "duration-minutes",
      "signups",
      "close-minutes-before",
      "detailed-deadline",
      "publication-mode",
      "publish-minutes-before-start",
      "clear-publish-schedule",
      "publication-channel",
      "clear-publication-channel",
    ]);
  });

  it("creates a template through the administration service and audits the mutation", async () => {
    templateServiceMocks.createEventTemplate.mockResolvedValue({
      kind: "created",

      template: {
        id: 7,

        ownerGuildId: 42,

        eventTypeId: 11,

        audienceId: 12,

        roleRequestPresetId: 5,

        name: "Sunday Naval",

        description: "Reusable naval event.",

        timezone: "Europe/London",

        localStartTime: "19:00",

        durationMinutes: 90,

        signupsEnabled: true,

        attendanceCloseMinutesBefore: 60,

        showDetailedDeadline: true,

        publicationMode: "scheduled",

        publishMinutesBeforeStart: 180,

        publicationChannelId: PUBLICATION_CHANNEL_ID,

        active: true,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date(),

        updatedAt: new Date(),
      },
    });

    const publicationChannel = createTestTextChannel();

    const interaction = createInteraction({
      subcommand: "create",

      strings: {
        name: "Sunday Naval",

        "event-type": "11",

        region: "12",

        timezone: "Europe/London",

        description: "Reusable naval event.",

        "local-time": "19:00",

        "publication-mode": "scheduled",
      },

      integers: {
        "duration-minutes": 90,

        "close-minutes-before": 60,

        "publish-minutes-before-start": 180,

        "role-preset-id": 5,
      },

      booleans: {
        signups: true,

        "detailed-deadline": true,
      },

      channels: {
        "publication-channel": publicationChannel,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(templateServiceMocks.createEventTemplate).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      eventTypeId: 11,

      audienceId: 12,

      roleRequestPresetId: 5,

      name: "Sunday Naval",

      description: "Reusable naval event.",

      timezone: "Europe/London",

      localStartTime: "19:00",

      durationMinutes: 90,

      signupsEnabled: true,

      attendanceCloseMinutesBefore: 60,

      showDetailedDeadline: true,

      publicationMode: "scheduled",

      publishMinutesBeforeStart: 180,

      publicationChannelId: PUBLICATION_CHANNEL_ID,

      createdByUserId: ADMIN_USER_ID,
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Created event template **Sunday Naval** (#7)",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "event_template.create",

        outcome: "success",

        targetType: "event_template",

        targetId: "7",
      }),
    );
  });

  it("edits core template configuration with explicit clear semantics and audits a real mutation", async () => {
    templateServiceMocks.editEventTemplate.mockResolvedValue({
      kind: "updated",

      template: {
        id: 7,

        ownerGuildId: 42,

        eventTypeId: 13,

        audienceId: null,

        roleRequestPresetId: null,

        name: "Updated Naval",

        description: null,

        timezone: "Europe/London",

        localStartTime: null,

        durationMinutes: 75,

        signupsEnabled: false,

        attendanceCloseMinutesBefore: 60,

        showDetailedDeadline: false,

        publicationMode: "manual",

        publishMinutesBeforeStart: null,

        publicationChannelId: null,

        active: true,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date(),

        updatedAt: new Date(),
      },
    });

    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        name: "Updated Naval",

        "event-type": "13",

        "publication-mode": "manual",
      },

      integers: {
        "template-id": 7,

        "duration-minutes": 75,
      },

      booleans: {
        "clear-region": true,

        "clear-role-preset": true,

        "clear-description": true,

        "clear-local-time": true,

        signups: false,

        "clear-publish-schedule": true,

        "clear-publication-channel": true,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.editEventTemplate).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      eventTypeId: 13,

      audienceId: null,

      roleRequestPresetId: null,

      name: "Updated Naval",

      description: null,

      timezone: undefined,

      localStartTime: null,

      durationMinutes: 75,

      signupsEnabled: false,

      attendanceCloseMinutesBefore: undefined,

      showDetailedDeadline: undefined,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,

      publicationChannelId: null,
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Updated event template **Updated Naval** (#7)",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 42,

        actorUserId: ADMIN_USER_ID,

        action: "event_template.edit",

        outcome: "success",

        targetType: "event_template",

        targetId: "7",
      }),
    );
  });

  it("rejects contradictory template edit clear options before calling the service", async () => {
    const interaction = createInteraction({
      subcommand: "edit",

      strings: {
        region: "12",
      },

      integers: {
        "template-id": 7,
      },

      booleans: {
        "clear-region": true,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.editEventTemplate).not.toHaveBeenCalled();

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "either a replacement region",
    );
  });

  it("lists active templates by default and can include inactive templates", async () => {
    templateServiceMocks.listEventTemplates.mockResolvedValue([
      {
        id: 7,

        name: "Active Naval",

        eventTypeId: 11,

        eventTypeName: "Naval",

        audienceId: 12,

        audienceName: "EU",

        roleRequestPresetId: null,

        roleRequestPresetName: null,

        timezone: "Europe/London",

        localStartTime: "19:00",

        active: true,

        updatedAt: new Date(),
      },
      {
        id: 8,

        name: "Old Naval",

        eventTypeId: 11,

        eventTypeName: "Naval",

        audienceId: 12,

        audienceName: "EU",

        roleRequestPresetId: null,

        roleRequestPresetName: null,

        timezone: "Europe/London",

        localStartTime: null,

        active: false,

        updatedAt: new Date(),
      },
    ]);

    const activeOnly = createInteraction({
      subcommand: "list",
    });

    await handleTemplateCommand(activeOnly.interaction);

    const activeContent = readFirstReplyContent(activeOnly.editReply);

    expect(activeContent).toContain("**Active Naval** (#7)");

    expect(activeContent).not.toContain("Old Naval");

    const includeInactive = createInteraction({
      subcommand: "list",

      booleans: {
        "include-inactive": true,
      },
    });

    await handleTemplateCommand(includeInactive.interaction);

    const completeContent = readFirstReplyContent(includeInactive.editReply);

    expect(completeContent).toContain("**Active Naval** (#7)");

    expect(completeContent).toContain("**Old Naval** (#8) — inactive");
  });

  it("shows the complete reusable source definition", async () => {
    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template: {
        id: 7,

        ownerGuildId: 42,

        eventTypeId: 11,

        audienceId: 12,

        roleRequestPresetId: 5,

        eventTypeName: "Naval",

        audienceName: "EU",

        roleRequestPresetName: "Naval Roles",

        name: "Sunday Naval",

        description: "Reusable naval event.",

        timezone: "Europe/London",

        localStartTime: "19:00",

        durationMinutes: 90,

        signupsEnabled: true,

        attendanceCloseMinutesBefore: 60,

        showDetailedDeadline: true,

        publicationMode: "scheduled",

        publishMinutesBeforeStart: 180,

        publicationChannelId: PUBLICATION_CHANNEL_ID,

        active: true,

        createdByUserId: ADMIN_USER_ID,

        createdAt: new Date(),

        updatedAt: new Date(),

        pingRoles: [
          {
            discordRoleId: "991000000000000020",

            roleNameSnapshot: "Naval",

            sortOrder: 0,
          },
        ],

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: "991000000000000021",

            displayNameSnapshot: "Admiral",
          },
        ],

        reminders: [
          {
            id: 31,

            timingReference: "event_start",

            minutesBefore: 30,

            message: "Event starts soon.",

            channelId: null,

            pingEventRoles: true,
          },
        ],
      },
    });

    const interaction = createInteraction({
      subcommand: "show",

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.getEventTemplate).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,
    });

    const content = readFirstReplyContent(interaction.editReply);

    expect(content).toContain("## Sunday Naval (#7)");

    expect(content).toContain("Naval (<@&991000000000000020>)");

    expect(content).toContain("**Event type:** Naval (#11)");

    expect(content).toContain("**Region / audience:** EU (#12)");

    expect(content).toContain("**Role-request preset:** Naval Roles (#5)");

    expect(content).toContain("**Primary:** Admiral");

    expect(content).toContain("Event starts soon.");

    expect(content).toContain("Generated event publication destination");
  });

  it("changes template lifecycle through the service and audits only a real mutation", async () => {
    templateServiceMocks.setEventTemplateActive.mockResolvedValueOnce({
      kind: "updated",

      template: {
        id: 7,

        name: "Sunday Naval",

        active: false,
      },
    });

    const interaction = createInteraction({
      subcommand: "set-active",

      integers: {
        "template-id": 7,
      },

      booleans: {
        active: false,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.setEventTemplateActive).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      active: false,
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "is now inactive",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_template.active.set",

        targetType: "event_template",

        targetId: "7",
      }),
    );

    vi.clearAllMocks();

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: 42,

      guildName: "Template Command Test Guild",

      timezone: "Europe/London",

      enabled: true,

      eventAdminRoleId: EVENT_ADMIN_ROLE_ID,

      attendanceChannelId: "991000000000000099",

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

    templateServiceMocks.setEventTemplateActive.mockResolvedValue({
      kind: "unchanged",

      template: {
        id: 7,

        name: "Sunday Naval",

        active: false,
      },
    });

    const unchanged = createInteraction({
      subcommand: "set-active",

      integers: {
        "template-id": 7,
      },

      booleans: {
        active: false,
      },
    });

    await handleTemplateCommand(unchanged.interaction);

    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("uses the normal Event Admin authorisation contract", async () => {
    authMocks.memberCanManageEvents.mockReturnValue(false);

    const interaction = createInteraction({
      subcommand: "list",
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.listEventTemplates).not.toHaveBeenCalled();

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "configured Event Admin role",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "command.denied",

        outcome: "denied",

        targetType: "command",

        targetId: "/template list",
      }),
    );
  });
});

function createInteraction(input: {
  subcommand: string;

  strings?: Record<string, string | null>;

  integers?: Record<string, number | null>;

  booleans?: Record<string, boolean | null>;

  channels?: Record<string, ReturnType<typeof createTestTextChannel> | null>;
}) {
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
    commandName: "template",

    guildId: DISCORD_GUILD_ID,

    guild: {
      id: DISCORD_GUILD_ID,

      name: "Template Command Test Guild",

      members: {
        me: {
          id: "991000000000000099",
        },

        fetchMe: vi.fn().mockResolvedValue({
          id: "991000000000000099",
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

      getBoolean: (name: string, required?: boolean) => {
        const value = input.booleans?.[name] ?? null;

        if (required && value === null) {
          throw new Error(`Missing required boolean option ${name}.`);
        }

        return value;
      },

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

function createTestTextChannel() {
  return {
    id: PUBLICATION_CHANNEL_ID,

    type: ChannelType.GuildText,

    isSendable: () => true,

    permissionsFor: () => ({
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.SendMessages ||
        permission === PermissionFlagsBits.EmbedLinks ||
        permission === PermissionFlagsBits.ReadMessageHistory,
    }),
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
