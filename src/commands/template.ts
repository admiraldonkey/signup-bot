import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { writeAuditLog } from "../audit/audit-log.js";
import {
  createEventTemplate,
  editEventTemplate,
  getEventTemplate,
  listEventTemplates,
  setEventTemplateActive,
  type CreateEventTemplateResult,
  type EditEventTemplateResult,
  type EventTemplateDetail,
} from "../templates/event-template-admin-service.js";

type CachedCommandInteraction = ChatInputCommandInteraction<"cached">;

type GuildConfiguration = NonNullable<
  Awaited<ReturnType<typeof getGuildConfiguration>>
>;

type TemplateCreateValidationReason = Extract<
  CreateEventTemplateResult,
  {
    kind: "invalid_input";
  }
>["reason"];

type TemplateEditValidationReason = Extract<
  EditEventTemplateResult,
  {
    kind: "invalid_input";
  }
>["reason"];

export async function handleTemplateCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "This command can only be used in a Discord server.",

      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const subcommand = interaction.options.getSubcommand();

  const configuration = await getAuthorisedConfiguration(
    interaction,
    subcommand,
  );

  if (!configuration) {
    return;
  }

  switch (subcommand) {
    case "create":
      await createTemplate(interaction, configuration);

      return;

    case "edit":
      await editTemplate(interaction, configuration);

      return;

    case "list":
      await listTemplates(interaction, configuration.guildId);

      return;

    case "show":
      await showTemplate(interaction, configuration.guildId);

      return;

    case "set-active":
      await setTemplateActive(interaction, configuration.guildId);

      return;

    default:
      throw new Error(`Unknown template subcommand: ${subcommand}`);
  }
}

async function getAuthorisedConfiguration(
  interaction: CachedCommandInteraction,
  subcommand: string,
) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply({
      content:
        "This server has not been initialised. Run `/setup initialise` first.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  if (!configuration.enabled) {
    await interaction.editReply({
      content: "Event management is currently disabled for this server.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    const command = `/template ${subcommand}`;

    await writeAuditLog({
      guildId: configuration.guildId,

      guild: interaction.guild,

      actorUserId: interaction.user.id,

      action: "command.denied",

      outcome: "denied",

      summary: `Denied ${command} command attempt.`,

      targetType: "command",

      targetId: command,

      details: {
        commandName: "template",

        subcommand,
      },
    });

    await interaction.editReply({
      content:
        "You need the configured Event Admin role or the Manage Server permission to manage event templates.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  return configuration;
}

async function createTemplate(
  interaction: CachedCommandInteraction,
  configuration: GuildConfiguration,
): Promise<void> {
  const eventTypeIdText = interaction.options.getString("event-type", true);

  const eventTypeId = parsePositiveIntegerId(eventTypeIdText);

  if (eventTypeId === null) {
    await interaction.editReply({
      content:
        "The selected event type is invalid. Choose one from the autocomplete list.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const audienceIdText = interaction.options.getString("region");

  const audienceId =
    audienceIdText === null ? null : parsePositiveIntegerId(audienceIdText);

  if (audienceIdText !== null && audienceId === null) {
    await interaction.editReply({
      content:
        "The selected event audience is invalid. Choose one from the autocomplete list.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const selectedPublicationChannel = interaction.options.getChannel(
    "publication-channel",
  );

  let publicationChannelId: string | null = null;

  if (selectedPublicationChannel) {
    const channel = await interaction.guild.channels.fetch(
      selectedPublicationChannel.id,
    );

    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.isSendable()
    ) {
      await interaction.editReply({
        content: "The selected template publication channel is unavailable.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());

    const permissions = channel.permissionsFor(botMember);

    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ];

    if (
      requiredPermissions.some((permission) => !permissions.has(permission))
    ) {
      await interaction.editReply({
        content:
          "The bot does not currently have all required event-posting permissions in that publication channel.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    publicationChannelId = channel.id;
  }

  /*
   * Generation always needs a concrete publication destination, even for
   * manual templates. A null source destination is valid only when the guild
   * has a default which generation can snapshot later.
   */
  if (publicationChannelId === null && !configuration.attendanceChannelId) {
    await interaction.editReply({
      content:
        "This server has no default attendance/publication channel. Choose `publication-channel` for this template or configure a guild default with `/setup configure` first.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const publicationMode =
    interaction.options.getString("publication-mode") ?? "manual";

  const result = await createEventTemplate({
    guildDatabaseId: configuration.guildId,

    eventTypeId,

    audienceId,

    roleRequestPresetId: interaction.options.getInteger("role-preset-id"),

    name: interaction.options.getString("name", true),

    description: interaction.options.getString("description"),

    timezone:
      interaction.options.getString("timezone")?.trim() ||
      configuration.timezone,

    localStartTime: interaction.options.getString("local-time"),

    durationMinutes: interaction.options.getInteger("duration-minutes") ?? 60,

    signupsEnabled: interaction.options.getBoolean("signups") ?? true,

    attendanceCloseMinutesBefore:
      interaction.options.getInteger("close-minutes-before") ?? 60,

    showDetailedDeadline:
      interaction.options.getBoolean("detailed-deadline") ?? false,

    publicationMode,

    publishMinutesBeforeStart: interaction.options.getInteger(
      "publish-minutes-before-start",
    ),

    publicationChannelId,

    createdByUserId: interaction.user.id,
  });

  switch (result.kind) {
    case "created": {
      await interaction.editReply({
        content: [
          `✅ Created event template **${result.template.name}** (#${result.template.id}).`,
          `**Status:** Active`,
          `**Timezone:** ${result.template.timezone}`,
          `**Normal local start:** ${
            result.template.localStartTime ?? "Not configured"
          }`,
          `**Duration:** ${result.template.durationMinutes} minutes`,
          `**Publication:** ${formatPublicationMode(result.template.publicationMode)}`,
          `**Publication channel:** ${
            result.template.publicationChannelId
              ? `<#${result.template.publicationChannelId}>`
              : "Guild default at generation"
          }`,
          "",
          `Use \`/template show template-id:${result.template.id}\` to inspect the complete reusable definition.`,
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: configuration.guildId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.create",

        outcome: "success",

        summary: `Created event template "${result.template.name}" (#${result.template.id}).`,

        targetType: "event_template",

        targetId: String(result.template.id),

        details: {
          eventTypeId: result.template.eventTypeId,

          audienceId: result.template.audienceId,

          roleRequestPresetId: result.template.roleRequestPresetId,

          publicationMode: result.template.publicationMode,
        },
      });

      return;
    }

    case "guild_not_found":
      await interaction.editReply({
        content:
          "This server's stored configuration changed while the command was being processed. Run `/setup initialise` and try again.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "event_type_unavailable":
      await interaction.editReply({
        content: "That event type is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "audience_unavailable":
      await interaction.editReply({
        content: "That event audience is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "preset_unavailable":
      await interaction.editReply({
        content: "That role-request preset is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatCreateValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function editTemplate(
  interaction: CachedCommandInteraction,
  configuration: GuildConfiguration,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const eventTypeText = interaction.options.getString("event-type");

  let eventTypeId: number | undefined;

  if (eventTypeText !== null) {
    const parsed = parsePositiveIntegerId(eventTypeText);

    if (parsed === null) {
      await interaction.editReply({
        content:
          "The selected event type is invalid. Choose one from the autocomplete list.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    eventTypeId = parsed;
  }

  const regionText = interaction.options.getString("region");

  const clearRegion = interaction.options.getBoolean("clear-region") ?? false;

  if (regionText !== null && clearRegion) {
    await interaction.editReply({
      content:
        "Choose either a replacement region or `clear-region:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  let audienceId: number | null | undefined;

  if (clearRegion) {
    audienceId = null;
  } else if (regionText !== null) {
    const parsed = parsePositiveIntegerId(regionText);

    if (parsed === null) {
      await interaction.editReply({
        content:
          "The selected event audience is invalid. Choose one from the autocomplete list.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    audienceId = parsed;
  }

  const rolePresetId = interaction.options.getInteger("role-preset-id");

  const clearRolePreset =
    interaction.options.getBoolean("clear-role-preset") ?? false;

  if (rolePresetId !== null && clearRolePreset) {
    await interaction.editReply({
      content:
        "Choose either a replacement role-request preset or `clear-role-preset:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const description = interaction.options.getString("description");

  const clearDescription =
    interaction.options.getBoolean("clear-description") ?? false;

  if (description !== null && clearDescription) {
    await interaction.editReply({
      content:
        "Choose either a replacement description or `clear-description:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const localTime = interaction.options.getString("local-time");

  const clearLocalTime =
    interaction.options.getBoolean("clear-local-time") ?? false;

  if (localTime !== null && clearLocalTime) {
    await interaction.editReply({
      content:
        "Choose either a replacement local time or `clear-local-time:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const publishMinutes = interaction.options.getInteger(
    "publish-minutes-before-start",
  );

  const clearPublishSchedule =
    interaction.options.getBoolean("clear-publish-schedule") ?? false;

  if (publishMinutes !== null && clearPublishSchedule) {
    await interaction.editReply({
      content:
        "Choose either a replacement publication offset or `clear-publish-schedule:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const selectedPublicationChannel = interaction.options.getChannel(
    "publication-channel",
  );

  const clearPublicationChannel =
    interaction.options.getBoolean("clear-publication-channel") ?? false;

  if (selectedPublicationChannel !== null && clearPublicationChannel) {
    await interaction.editReply({
      content:
        "Choose either a replacement publication channel or `clear-publication-channel:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  let publicationChannelId: string | null | undefined;

  if (clearPublicationChannel) {
    if (!configuration.attendanceChannelId) {
      await interaction.editReply({
        content:
          "This server has no default attendance/publication channel, so the template's fixed publication channel cannot be cleared.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    publicationChannelId = null;
  } else if (selectedPublicationChannel) {
    const channel = await interaction.guild.channels.fetch(
      selectedPublicationChannel.id,
    );

    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.isSendable()
    ) {
      await interaction.editReply({
        content: "The selected template publication channel is unavailable.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());

    const permissions = channel.permissionsFor(botMember);

    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ];

    if (
      requiredPermissions.some((permission) => !permissions.has(permission))
    ) {
      await interaction.editReply({
        content:
          "The bot does not currently have all required event-posting permissions in that publication channel.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    publicationChannelId = channel.id;
  }

  const result = await editEventTemplate({
    guildDatabaseId: configuration.guildId,

    templateId,

    eventTypeId,

    audienceId,

    roleRequestPresetId: clearRolePreset ? null : (rolePresetId ?? undefined),

    name: interaction.options.getString("name") ?? undefined,

    description: clearDescription ? null : (description ?? undefined),

    timezone: interaction.options.getString("timezone")?.trim() || undefined,

    localStartTime: clearLocalTime ? null : (localTime ?? undefined),

    durationMinutes:
      interaction.options.getInteger("duration-minutes") ?? undefined,

    signupsEnabled: interaction.options.getBoolean("signups") ?? undefined,

    attendanceCloseMinutesBefore:
      interaction.options.getInteger("close-minutes-before") ?? undefined,

    showDetailedDeadline:
      interaction.options.getBoolean("detailed-deadline") ?? undefined,

    publicationMode:
      interaction.options.getString("publication-mode") ?? undefined,

    publishMinutesBeforeStart: clearPublishSchedule
      ? null
      : (publishMinutes ?? undefined),

    publicationChannelId,
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content: [
          `✅ Updated event template **${result.template.name}** (#${result.template.id}).`,
          "",
          "Existing generated events were not changed.",
          `Use \`/template show template-id:${result.template.id}\` to inspect the updated reusable definition.`,
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: configuration.guildId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.edit",

        outcome: "success",

        summary: `Edited event template "${result.template.name}" (#${result.template.id}).`,

        targetType: "event_template",

        targetId: String(result.template.id),

        details: {
          eventTypeId: result.template.eventTypeId,

          audienceId: result.template.audienceId,

          roleRequestPresetId: result.template.roleRequestPresetId,

          publicationMode: result.template.publicationMode,
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Event template **${result.template.name}** (#${result.template.id}) already has that core configuration. No changes were made.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "template_not_found":
      await interaction.editReply({
        content: `Event template #${templateId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "event_type_unavailable":
      await interaction.editReply({
        content: "That event type is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "audience_unavailable":
      await interaction.editReply({
        content: "That event audience is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "preset_unavailable":
      await interaction.editReply({
        content: "That role-request preset is not available for this server.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatEditValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function listTemplates(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const includeInactive =
    interaction.options.getBoolean("include-inactive") ?? false;

  const allTemplates = await listEventTemplates(guildDatabaseId);

  const templates = includeInactive
    ? allTemplates
    : allTemplates.filter((template) => template.active);

  if (templates.length === 0) {
    await interaction.editReply({
      content: includeInactive
        ? "This server has no event templates."
        : "This server has no active event templates. Use `/template list include-inactive:true` to inspect inactive templates.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const lines = [
    includeInactive ? "## Event templates" : "## Active event templates",

    "Use `/template show template-id:<id>` to inspect a complete template definition.",

    "",
  ];

  for (const template of templates) {
    lines.push(
      `• **${template.name}** (#${template.id})${
        template.active ? "" : " — inactive"
      }`,
    );

    lines.push(
      `  Event type ${formatNamedSource(
        template.eventTypeName,
        template.eventTypeId,
      )} • ${template.timezone}${
        template.localStartTime ? ` • ${template.localStartTime}` : ""
      }`,
    );

    if (template.roleRequestPresetId !== null) {
      lines.push(
        `  Role-request preset ${formatNamedSource(
          template.roleRequestPresetName,
          template.roleRequestPresetId,
        )}`,
      );
    }
  }

  await sendEphemeralText(interaction, lines.join("\n"));
}

async function showTemplate(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const result = await getEventTemplate({
    guildDatabaseId,

    templateId,
  });

  if (result.kind === "template_not_found") {
    await interaction.editReply({
      content: `Event template #${templateId} was not found in this server.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  await sendEphemeralText(interaction, formatTemplateDetails(result.template));
}

async function setTemplateActive(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const active = interaction.options.getBoolean("active", true);

  const result = await setEventTemplateActive({
    guildDatabaseId,

    templateId,

    active,
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content: result.template.active
          ? [
              `✅ Event template **${result.template.name}** (#${result.template.id}) is now active.`,
              "",
              "It may be used for future event generation.",
              "Existing generated events remain unchanged.",
            ].join("\n")
          : [
              `✅ Event template **${result.template.name}** (#${result.template.id}) is now inactive.`,
              "",
              "It can no longer generate new events.",
              "Its reusable definition and existing generated events are unchanged.",
            ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.active.set",

        outcome: "success",

        summary: `Set event template "${result.template.name}" (#${result.template.id}) active=${result.template.active}.`,

        targetType: "event_template",

        targetId: String(result.template.id),

        details: {
          active: result.template.active,
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Event template **${result.template.name}** (#${result.template.id}) is already ${
          result.template.active ? "active" : "inactive"
        }. No changes were made.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "template_not_found":
      await interaction.editReply({
        content: `Event template #${templateId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

function formatTemplateDetails(template: EventTemplateDetail): string {
  const lines = [
    `## ${template.name} (#${template.id})${
      template.active ? "" : " — inactive"
    }`,

    template.description
      ? template.description
      : "_No description configured._",

    "",

    `**Event type:** ${formatNamedSource(
      template.eventTypeName,
      template.eventTypeId,
    )}`,

    `**Region / audience:** ${
      template.audienceId === null
        ? "None"
        : formatNamedSource(template.audienceName, template.audienceId)
    }`,

    `**Role-request preset:** ${
      template.roleRequestPresetId === null
        ? "None"
        : formatNamedSource(
            template.roleRequestPresetName,
            template.roleRequestPresetId,
          )
    }`,

    `**Timezone:** ${template.timezone}`,
    `**Normal local start:** ${template.localStartTime ?? "Not configured"}`,
    `**Duration:** ${template.durationMinutes} minutes`,
    `**Signups:** ${template.signupsEnabled ? "Enabled" : "Disabled"}`,
  ];

  if (template.signupsEnabled) {
    lines.push(
      `**Signup close:** ${template.attendanceCloseMinutesBefore} minutes before start`,
      `**Detailed signup deadline:** ${
        template.showDetailedDeadline ? "Yes" : "No"
      }`,
    );
  }

  lines.push(
    `**Publication:** ${formatPublicationMode(template.publicationMode)}`,
  );

  if (
    template.publicationMode === "scheduled" &&
    template.publishMinutesBeforeStart !== null
  ) {
    lines.push(
      `**Automatic publication:** ${template.publishMinutesBeforeStart} minutes before start`,
    );
  }

  lines.push(
    `**Publication channel:** ${
      template.publicationChannelId
        ? `Fixed — <#${template.publicationChannelId}>`
        : "Guild default at generation"
    }`,

    "",

    "### Ping roles",
  );

  if (template.pingRoles.length === 0) {
    lines.push("None");
  } else {
    for (const role of template.pingRoles) {
      lines.push(`• ${role.roleNameSnapshot} (<@&${role.discordRoleId}>)`);
    }
  }

  lines.push("", "### Organiser defaults");

  if (template.organiserDefaults.length === 0) {
    lines.push("None");
  } else {
    for (const organiser of template.organiserDefaults) {
      lines.push(
        `• **${formatOrganiserSlot(organiser.slot)}:** ${organiser.displayNameSnapshot} (<@${organiser.discordUserId}>)`,
      );
    }
  }

  lines.push("", "### Reminder definitions");

  if (template.reminders.length === 0) {
    lines.push("None");
  } else {
    for (const reminder of template.reminders) {
      lines.push(
        `• #${reminder.id} • ${formatReminderTiming(reminder.timingReference)} • ${reminder.minutesBefore} minutes before`,
      );

      lines.push(`  ${reminder.message}`);

      lines.push(
        `  Channel: ${
          reminder.channelId
            ? `Fixed — <#${reminder.channelId}>`
            : "Generated event publication destination"
        }`,
      );

      lines.push(
        `  Ping event roles: ${reminder.pingEventRoles ? "Yes" : "No"}`,
      );
    }
  }

  return lines.join("\n");
}

function formatNamedSource(
  name: string | null | undefined,
  id: number,
): string {
  return name ? `${name} (#${id})` : `#${id}`;
}

function formatCreateValidationError(
  reason: TemplateCreateValidationReason,
): string {
  switch (reason) {
    case "invalid_name":
      return "The template name is invalid. Use a non-empty name of no more than 150 characters.";

    case "invalid_timezone":
      return "The template timezone is invalid. Choose one from the autocomplete list.";

    case "invalid_local_start_time":
      return "The normal local start time must use 24-hour `HH:mm` format.";

    case "invalid_duration":
      return "The template duration must be a positive whole number of minutes.";

    case "invalid_attendance_close_offset":
      return "The signup-close offset must be zero or a positive whole number.";

    case "invalid_publication_mode":
      return "The template publication mode is invalid.";

    case "invalid_publication_offset":
      return "Scheduled publication requires a positive `publish-minutes-before-start` value, and manual/immediate publication must not supply one.";

    case "publication_not_before_signup_close":
      return "Automatic publication must occur before signup closing for a signup-enabled template.";

    case "invalid_publication_channel":
      return "The template publication channel is invalid.";

    case "preset_requires_role_requests":
      return "The selected event type has role requests disabled, so it cannot use a role-request preset.";
  }
}

function formatEditValidationError(
  reason: TemplateEditValidationReason,
): string {
  if (reason === "no_changes_requested") {
    return "No template changes were supplied.";
  }

  if (reason === "signup_close_requires_signups") {
    return "Signups cannot be disabled while the template still contains signup-close reminder definitions. Clear or replace those reminders first.";
  }

  return formatCreateValidationError(reason);
}

function formatPublicationMode(value: string): string {
  switch (value) {
    case "manual":
      return "Manual";

    case "scheduled":
      return "Scheduled";

    case "immediate":
      return "Immediate";

    default:
      return value;
  }
}

function formatOrganiserSlot(value: "primary" | "backup"): string {
  return value === "primary" ? "Primary" : "Backup";
}

function formatReminderTiming(value: "event_start" | "signup_close"): string {
  return value === "event_start" ? "Event start" : "Signup close";
}

function parsePositiveIntegerId(value: string): number | null {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function sendEphemeralText(
  interaction: CachedCommandInteraction,
  text: string,
): Promise<void> {
  const chunks = splitText(text, 1_800);

  const [firstChunk, ...remainingChunks] = chunks;

  await interaction.editReply({
    content: firstChunk ?? "",

    allowedMentions: {
      parse: [],
    },
  });

  for (const chunk of remainingChunks) {
    await interaction.followUp({
      content: chunk,

      flags: MessageFlags.Ephemeral,

      allowedMentions: {
        parse: [],
      },
    });
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];

  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());

    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
