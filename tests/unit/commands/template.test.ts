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
  addEventTemplateReminder: vi.fn(),

  createEventTemplate: vi.fn(),

  editEventTemplate: vi.fn(),

  editEventTemplateReminder: vi.fn(),

  getEventTemplate: vi.fn(),

  listEventTemplates: vi.fn(),

  removeEventTemplateReminder: vi.fn(),

  replaceEventTemplateOrganiserDefaults: vi.fn(),

  replaceEventTemplatePingRoles: vi.fn(),

  replaceEventTemplateReminders: vi.fn(),

  setEventTemplateActive: vi.fn(),
}));

const generationMocks = vi.hoisted(() => ({
  generateEventFromTemplate: vi.fn(),
}));

const publicationMocks = vi.hoisted(() => ({
  publishStoredEvent: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("../../../src/auth/event-admin.js", () => authMocks);

vi.mock(
  "../../../src/templates/event-template-admin-service.js",
  () => templateServiceMocks,
);

vi.mock(
  "../../../src/templates/event-template-generation-service.js",
  () => generationMocks,
);

vi.mock("../../../src/events/event-publication.js", () => publicationMocks);

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
      "generate",
      "edit",
      "set-ping-roles",
      "set-organisers",
      "reminder-add",
      "reminder-edit",
      "reminder-remove",
      "reminder-clear",
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

    const generateDefinition = definition?.options?.find(
      (option) => option.name === "generate",
    );

    expect(generateDefinition).toBeDefined();

    if (
      !generateDefinition ||
      !("options" in generateDefinition) ||
      !generateDefinition.options
    ) {
      throw new Error(
        "Expected /template generate to be a subcommand with options.",
      );
    }

    expect(generateDefinition.options.map((option) => option.name)).toEqual([
      "template-id",
      "date",
      "time",
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

    const pingRoleDefinition = definition?.options?.find(
      (option) => option.name === "set-ping-roles",
    );

    expect(pingRoleDefinition).toBeDefined();

    if (
      !pingRoleDefinition ||
      !("options" in pingRoleDefinition) ||
      !pingRoleDefinition.options
    ) {
      throw new Error(
        "Expected /template set-ping-roles to be a subcommand with options.",
      );
    }

    expect(pingRoleDefinition.options.map((option) => option.name)).toEqual([
      "template-id",
      "ping-role-1",
      "ping-role-2",
      "ping-role-3",
      "ping-role-4",
      "clear",
    ]);

    const organiserDefinition = definition?.options?.find(
      (option) => option.name === "set-organisers",
    );

    expect(organiserDefinition).toBeDefined();

    if (
      !organiserDefinition ||
      !("options" in organiserDefinition) ||
      !organiserDefinition.options
    ) {
      throw new Error(
        "Expected /template set-organisers to be a subcommand with options.",
      );
    }

    expect(organiserDefinition.options.map((option) => option.name)).toEqual([
      "template-id",
      "primary-organiser",
      "backup-organiser",
      "clear",
    ]);

    const reminderEditDefinition = definition?.options?.find(
      (option) => option.name === "reminder-edit",
    );

    expect(reminderEditDefinition).toBeDefined();

    if (
      !reminderEditDefinition ||
      !("options" in reminderEditDefinition) ||
      !reminderEditDefinition.options
    ) {
      throw new Error(
        "Expected /template reminder-edit to be a subcommand with options.",
      );
    }

    expect(reminderEditDefinition.options.map((option) => option.name)).toEqual(
      [
        "template-id",
        "reminder-id",
        "timing-reference",
        "minutes-before",
        "message",
        "channel",
        "clear-channel",
        "ping-event-roles",
      ],
    );
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

  it("replaces template ping roles through Discord-native role selections", async () => {
    templateServiceMocks.replaceEventTemplatePingRoles.mockResolvedValue({
      kind: "updated",

      pingRoles: [
        {
          discordRoleId: "991000000000000020",

          roleNameSnapshot: "Naval",

          sortOrder: 0,
        },
        {
          discordRoleId: "991000000000000022",

          roleNameSnapshot: "Events",

          sortOrder: 1,
        },
      ],
    });

    const interaction = createInteraction({
      subcommand: "set-ping-roles",

      integers: {
        "template-id": 7,
      },

      roles: {
        "ping-role-1": createTestRole("991000000000000020", "Naval"),

        "ping-role-2": createTestRole("991000000000000022", "Events"),
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(
      templateServiceMocks.replaceEventTemplatePingRoles,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      pingRoles: [
        {
          discordRoleId: "991000000000000020",

          roleNameSnapshot: "Naval",
        },
        {
          discordRoleId: "991000000000000022",

          roleNameSnapshot: "Events",
        },
      ],
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Replaced the ping roles for event template #7",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_template.ping_roles.replace",

        targetType: "event_template",

        targetId: "7",
      }),
    );
  });

  it("replaces template organiser defaults using current member display names", async () => {
    const primaryId = "991000000000000030";

    const backupId = "991000000000000031";

    templateServiceMocks.replaceEventTemplateOrganiserDefaults.mockResolvedValue(
      {
        kind: "updated",

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: primaryId,

            displayNameSnapshot: "Admiral",
          },
          {
            slot: "backup",

            discordUserId: backupId,

            displayNameSnapshot: "Vice Admiral",
          },
        ],
      },
    );

    const interaction = createInteraction({
      subcommand: "set-organisers",

      integers: {
        "template-id": 7,
      },

      users: {
        "primary-organiser": createTestUser(primaryId),

        "backup-organiser": createTestUser(backupId),
      },

      members: {
        [primaryId]: createTestMember(primaryId, "Admiral"),

        [backupId]: createTestMember(backupId, "Vice Admiral"),
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(
      templateServiceMocks.replaceEventTemplateOrganiserDefaults,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      organiserDefaults: [
        {
          slot: "primary",

          discordUserId: primaryId,

          displayNameSnapshot: "Admiral",
        },
        {
          slot: "backup",

          discordUserId: backupId,

          displayNameSnapshot: "Vice Admiral",
        },
      ],
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Replaced organiser defaults for event template #7",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_template.organisers.replace",

        targetType: "event_template",

        targetId: "7",
      }),
    );
  });

  it("requires explicit clear intent before removing template ping roles", async () => {
    templateServiceMocks.replaceEventTemplatePingRoles.mockResolvedValue({
      kind: "updated",

      pingRoles: [],
    });

    const missingIntent = createInteraction({
      subcommand: "set-ping-roles",

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(missingIntent.interaction);

    expect(
      templateServiceMocks.replaceEventTemplatePingRoles,
    ).not.toHaveBeenCalled();

    const clear = createInteraction({
      subcommand: "set-ping-roles",

      integers: {
        "template-id": 7,
      },

      booleans: {
        clear: true,
      },
    });

    await handleTemplateCommand(clear.interaction);

    expect(
      templateServiceMocks.replaceEventTemplatePingRoles,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      pingRoles: [],
    });
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

  it("adds a reusable template reminder through the reminder service", async () => {
    templateServiceMocks.addEventTemplateReminder.mockResolvedValue({
      kind: "created",

      reminder: {
        id: 31,

        timingReference: "event_start",

        minutesBefore: 30,

        message: "Event starts soon.",

        channelId: PUBLICATION_CHANNEL_ID,

        pingEventRoles: true,
      },
    });

    const reminderChannel = createTestTextChannel();

    const interaction = createInteraction({
      subcommand: "reminder-add",

      strings: {
        "timing-reference": "event_start",

        message: "Event starts soon.",
      },

      integers: {
        "template-id": 7,

        "minutes-before": 30,
      },

      booleans: {
        "ping-event-roles": true,
      },

      channels: {
        channel: reminderChannel,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.addEventTemplateReminder).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      reminder: {
        timingReference: "event_start",

        minutesBefore: 30,

        message: "Event starts soon.",

        channelId: PUBLICATION_CHANNEL_ID,

        pingEventRoles: true,
      },
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Added reminder #31 to event template #7",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_template.reminder.add",

        targetType: "event_template",

        targetId: "7",
      }),
    );
  });

  it("edits a template reminder and explicitly restores inherited channel behaviour", async () => {
    templateServiceMocks.editEventTemplateReminder.mockResolvedValue({
      kind: "updated",

      reminder: {
        id: 31,

        timingReference: "signup_close",

        minutesBefore: 15,

        message: "Signups close soon.",

        channelId: null,

        pingEventRoles: false,
      },
    });

    const interaction = createInteraction({
      subcommand: "reminder-edit",

      strings: {
        "timing-reference": "signup_close",

        message: "Signups close soon.",
      },

      integers: {
        "template-id": 7,

        "reminder-id": 31,

        "minutes-before": 15,
      },

      booleans: {
        "clear-channel": true,

        "ping-event-roles": false,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(templateServiceMocks.editEventTemplateReminder).toHaveBeenCalledWith(
      {
        guildDatabaseId: 42,

        templateId: 7,

        reminderId: 31,

        timingReference: "signup_close",

        minutesBefore: 15,

        message: "Signups close soon.",

        channelId: null,

        pingEventRoles: false,
      },
    );

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Updated reminder #31 for event template #7",
    );
  });

  it("removes one template reminder and audits the mutation", async () => {
    templateServiceMocks.removeEventTemplateReminder.mockResolvedValue({
      kind: "removed",

      reminderId: 31,
    });

    const interaction = createInteraction({
      subcommand: "reminder-remove",

      integers: {
        "template-id": 7,

        "reminder-id": 31,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(
      templateServiceMocks.removeEventTemplateReminder,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      reminderId: 31,
    });

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_template.reminder.remove",

        targetId: "7",
      }),
    );
  });

  it("clears all template reminders through complete replacement", async () => {
    templateServiceMocks.replaceEventTemplateReminders.mockResolvedValue({
      kind: "updated",

      reminders: [],
    });

    const interaction = createInteraction({
      subcommand: "reminder-clear",

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(
      templateServiceMocks.replaceEventTemplateReminders,
    ).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      reminders: [],
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Cleared all reminder definitions from event template #7",
    );
  });

  it("rejects reminder-edit channel replacement and clear intent together", async () => {
    const interaction = createInteraction({
      subcommand: "reminder-edit",

      integers: {
        "template-id": 7,

        "reminder-id": 31,
      },

      booleans: {
        "clear-channel": true,
      },

      channels: {
        channel: createTestTextChannel(),
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(
      templateServiceMocks.editEventTemplateReminder,
    ).not.toHaveBeenCalled();

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "either a replacement reminder channel",
    );
  });

  it("generates an occurrence using the template local time and inspected revision", async () => {
    const template = createGenerationTemplate();

    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template,
    });

    generationMocks.generateEventFromTemplate.mockResolvedValue({
      kind: "generated",

      templateId: 7,

      event: {
        id: 119,

        timezone: "Europe/London",

        showDetailedDeadline: false,

        name: "Sunday Naval",

        startsAt: new Date("2026-09-24T19:00:00.000Z"),

        signupsEnabled: true,

        attendanceClosesAt: new Date("2026-09-24T18:00:00.000Z"),
      },

      publicationMode: "manual",

      requiresImmediatePublication: false,
    });

    const interaction = createInteraction({
      subcommand: "generate",

      strings: {
        date: "2026-09-24",
      },

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(generationMocks.generateEventFromTemplate).toHaveBeenCalledWith({
      guildDatabaseId: 42,

      templateId: 7,

      startsAt: new Date("2026-09-24T19:00:00.000Z"),

      generatedByUserId: ADMIN_USER_ID,

      expectedTemplateUpdatedAt: template.updatedAt,
    });

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Generated **Sunday Naval**",
    );

    expect(publicationMocks.publishStoredEvent).not.toHaveBeenCalled();
  });

  it("uses a supplied occurrence time without changing the reusable template", async () => {
    const template = createGenerationTemplate();

    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template,
    });

    generationMocks.generateEventFromTemplate.mockResolvedValue({
      kind: "generated",

      templateId: 7,

      event: {
        id: 120,

        timezone: "Europe/London",

        showDetailedDeadline: false,

        name: "Sunday Naval",

        startsAt: new Date("2026-09-24T17:30:00.000Z"),

        signupsEnabled: false,

        attendanceClosesAt: null,
      },

      publicationMode: "manual",

      requiresImmediatePublication: false,
    });

    const interaction = createInteraction({
      subcommand: "generate",

      strings: {
        date: "2026-09-24",

        time: "18:30",
      },

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(generationMocks.generateEventFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        startsAt: new Date("2026-09-24T17:30:00.000Z"),
      }),
    );
  });

  it("requires an occurrence time when the template has no default local start time", async () => {
    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template: createGenerationTemplate({
        localStartTime: null,
      }),
    });

    const interaction = createInteraction({
      subcommand: "generate",

      strings: {
        date: "2026-09-24",
      },

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(generationMocks.generateEventFromTemplate).not.toHaveBeenCalled();

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "has no default local start time",
    );
  });

  it("publishes an immediate template occurrence only after generation succeeds", async () => {
    const template = createGenerationTemplate({
      publicationMode: "immediate",
    });

    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template,
    });

    generationMocks.generateEventFromTemplate.mockResolvedValue({
      kind: "generated",

      templateId: 7,

      event: {
        id: 121,

        timezone: "Europe/London",

        showDetailedDeadline: false,

        name: "Sunday Naval",

        startsAt: new Date("2026-09-24T19:00:00.000Z"),

        signupsEnabled: false,

        attendanceClosesAt: null,
      },

      publicationMode: "immediate",

      requiresImmediatePublication: true,
    });

    publicationMocks.publishStoredEvent.mockResolvedValue({
      ok: true,

      eventId: 121,

      eventName: "Sunday Naval",

      messageUrl: "https://discord.com/channels/test/event",

      primaryOrganiserNotification: null,
    });

    const interaction = createInteraction({
      subcommand: "generate",

      strings: {
        date: "2026-09-24",
      },

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(generationMocks.generateEventFromTemplate).toHaveBeenCalledTimes(1);

    expect(publicationMocks.publishStoredEvent).toHaveBeenCalledWith(
      interaction.interaction.guild,
      121,
    );

    expect(
      generationMocks.generateEventFromTemplate.mock.invocationCallOrder[0],
    ).toBeLessThan(
      publicationMocks.publishStoredEvent.mock.invocationCallOrder[0]!,
    );

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "Generated and published",
    );
  });

  it("asks the administrator to retry when the template changes during occurrence preparation", async () => {
    templateServiceMocks.getEventTemplate.mockResolvedValue({
      kind: "found",

      template: createGenerationTemplate(),
    });

    generationMocks.generateEventFromTemplate.mockResolvedValue({
      kind: "template_changed",
    });

    const interaction = createInteraction({
      subcommand: "generate",

      strings: {
        date: "2026-09-24",
      },

      integers: {
        "template-id": 7,
      },
    });

    await handleTemplateCommand(interaction.interaction);

    expect(readFirstReplyContent(interaction.editReply)).toContain(
      "changed while this occurrence was being prepared",
    );
  });
});

function createGenerationTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,

    ownerGuildId: 42,

    eventTypeId: 11,

    eventTypeName: "Naval",

    audienceId: 12,

    audienceName: "EU",

    roleRequestPresetId: null,

    roleRequestPresetName: null,

    name: "Sunday Naval",

    description: null,

    timezone: "Europe/London",

    localStartTime: "20:00",

    durationMinutes: 60,

    signupsEnabled: true,

    attendanceCloseMinutesBefore: 60,

    showDetailedDeadline: false,

    publicationMode: "manual",

    publishMinutesBeforeStart: null,

    publicationChannelId: PUBLICATION_CHANNEL_ID,

    active: true,

    createdByUserId: ADMIN_USER_ID,

    createdAt: new Date("2026-09-01T12:00:00.000Z"),

    updatedAt: new Date("2026-09-20T12:00:00.000Z"),

    pingRoles: [],

    organiserDefaults: [],

    reminders: [],

    ...overrides,
  };
}

function createInteraction(input: {
  subcommand: string;

  strings?: Record<string, string | null>;

  integers?: Record<string, number | null>;

  booleans?: Record<string, boolean | null>;

  channels?: Record<string, ReturnType<typeof createTestTextChannel> | null>;

  roles?: Record<string, ReturnType<typeof createTestRole> | null>;

  users?: Record<string, ReturnType<typeof createTestUser> | null>;

  members?: Record<string, ReturnType<typeof createTestMember>>;
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

        fetch: vi.fn(async (userId: string) => {
          const member = input.members?.[userId];

          if (!member) {
            throw new Error(`Unknown test member ${userId}.`);
          }

          return member;
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

      getRole: (name: string) => input.roles?.[name] ?? null,

      getUser: (name: string) => input.users?.[name] ?? null,
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

function createTestRole(id: string, name: string, managed = false) {
  return {
    id,

    name,

    managed,
  };
}

function createTestUser(id: string, bot = false) {
  return {
    id,

    bot,
  };
}

function createTestMember(id: string, displayName: string) {
  return {
    id,

    displayName,

    roles: {
      cache: {
        has: () => true,
      },
    },
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
