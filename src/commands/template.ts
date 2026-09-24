import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
} from "discord.js";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { writeAuditLog } from "../audit/audit-log.js";
import {
  addEventTemplateReminder,
  createEventTemplate,
  editEventTemplate,
  editEventTemplateReminder,
  getEventTemplate,
  listEventTemplates,
  removeEventTemplateReminder,
  replaceEventTemplateOrganiserDefaults,
  replaceEventTemplatePingRoles,
  replaceEventTemplateReminders,
  setEventTemplateActive,
  type CreateEventTemplateResult,
  type EditEventTemplateResult,
  type EventTemplateDetail,
  type EventTemplateReminderInvalidReason,
  type ReplaceEventTemplateOrganiserDefaultsResult,
  type ReplaceEventTemplatePingRolesResult,
} from "../templates/event-template-admin-service.js";
import {
  publishStoredEvent,
  type EventPublicationFailureReason,
} from "../events/event-publication.js";

import {
  generateEventFromTemplate,
  type InvalidEventTemplateReason,
  type InvalidTemplateOccurrenceReason,
} from "../templates/event-template-generation-service.js";

import { parseEventDateTime } from "../time/event-date-time.js";

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

type TemplatePingRoleValidationReason = Extract<
  ReplaceEventTemplatePingRolesResult,
  {
    kind: "invalid_input";
  }
>["reason"];

type TemplateOrganiserValidationReason = Extract<
  ReplaceEventTemplateOrganiserDefaultsResult,
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

    case "generate":
      await generateTemplateOccurrence(interaction, configuration);

      return;

    case "edit":
      await editTemplate(interaction, configuration);

      return;

    case "set-ping-roles":
      await setTemplatePingRoles(interaction, configuration.guildId);

      return;

    case "set-organisers":
      await setTemplateOrganisers(interaction, configuration);

      return;

    case "reminder-add":
      await addTemplateReminder(interaction, configuration.guildId);

      return;

    case "reminder-edit":
      await editTemplateReminder(interaction, configuration.guildId);

      return;

    case "reminder-remove":
      await removeTemplateReminder(interaction, configuration.guildId);

      return;

    case "reminder-clear":
      await clearTemplateReminders(interaction, configuration.guildId);

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

async function generateTemplateOccurrence(
  interaction: CachedCommandInteraction,
  configuration: GuildConfiguration,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const dateText = interaction.options.getString("date", true).trim();

  const timeOverride = interaction.options.getString("time")?.trim() || null;

  /*
   * We need the reusable local-time metadata before entering the generator.
   *
   * The inspected updatedAt revision is passed into generation so a concurrent
   * template mutation cannot silently combine old occurrence timing with a new
   * source snapshot.
   */
  const templateResult = await getEventTemplate({
    guildDatabaseId: configuration.guildId,

    templateId,
  });

  if (templateResult.kind === "template_not_found") {
    await replyTemplateNotFound(interaction, templateId);

    return;
  }

  const template = templateResult.template;

  if (!template.active) {
    await interaction.editReply({
      content: `Event template **${template.name}** (#${template.id}) is inactive and cannot generate events.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const timeText = timeOverride ?? template.localStartTime;

  if (!timeText) {
    await interaction.editReply({
      content: [
        `Event template **${template.name}** (#${template.id}) has no default local start time.`,
        "",
        "Supply the `time` option for this occurrence or configure `local-time` with `/template edit`.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const parsedStart = parseEventDateTime(dateText, timeText, template.timezone);

  if (!parsedStart.ok) {
    await interaction.editReply({
      content: `The occurrence date or time is invalid: ${parsedStart.error}`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const generationResult = await generateEventFromTemplate({
    guildDatabaseId: configuration.guildId,

    templateId: template.id,

    startsAt: parsedStart.value.toJSDate(),

    generatedByUserId: interaction.user.id,

    expectedTemplateUpdatedAt: template.updatedAt,
  });

  if (generationResult.kind !== "generated") {
    await interaction.editReply({
      content: formatTemplateGenerationFailure(generationResult),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  let publication: {
    eventId: number;

    eventName: string;

    messageUrl: string;

    primaryOrganiserNotification: "dm" | "admin_channel" | "failed" | null;
  } | null = null;

  let publicationFailure: string | null = null;

  /*
   * The generation transaction has already committed before this block.
   *
   * Discord publication must therefore remain a post-commit side effect.
   * If it fails, retain the generated event as an unpublished draft rather
   * than deleting authoritative state behind the administrator's back.
   */
  if (generationResult.requiresImmediatePublication) {
    try {
      const result = await publishStoredEvent(
        interaction.guild,
        generationResult.event.id,
      );

      if (result.ok) {
        publication = result;
      } else {
        publicationFailure = formatImmediatePublicationFailure(result.reason);
      }
    } catch (error) {
      publicationFailure =
        error instanceof Error
          ? error.message
          : "The generated event could not be published.";
    }
  }

  const startsUnix = Math.floor(
    generationResult.event.startsAt.getTime() / 1000,
  );

  const scheduledPublicationAt =
    generationResult.publicationMode === "scheduled" &&
    template.publishMinutesBeforeStart !== null
      ? parsedStart.value
          .minus({
            minutes: template.publishMinutesBeforeStart,
          })
          .toJSDate()
      : null;

  const lines = [
    generationResult.requiresImmediatePublication && publication
      ? `✅ Generated and published **${generationResult.event.name}** from template **${template.name}** (#${template.id}).`
      : `✅ Generated **${generationResult.event.name}** from template **${template.name}** (#${template.id}).`,

    "",

    `**Event ID:** ${generationResult.event.id}`,

    `**Event type:** ${template.eventTypeName ?? `#${template.eventTypeId}`}`,

    `**Region:** ${
      template.audienceId === null
        ? "None"
        : (template.audienceName ?? `#${template.audienceId}`)
    }`,

    `**Scheduled as:** ${parsedStart.value.toFormat(
      "dd LLL yyyy, HH:mm ZZZZ",
    )}`,

    `**Timezone:** \`${template.timezone}\``,

    `**Your local time:** <t:${startsUnix}:F>`,
  ];

  if (generationResult.event.signupsEnabled) {
    const closesAt = generationResult.event.attendanceClosesAt;

    if (!closesAt) {
      throw new Error(
        "Generated signup event did not return its attendance closing time.",
      );
    }

    const closesUnix = Math.floor(closesAt.getTime() / 1000);

    lines.push(
      "**Signups:** Enabled",

      `**Attendance closes:** <t:${closesUnix}:F> (<t:${closesUnix}:R>)`,
    );
  } else {
    lines.push("**Signups:** Disabled");
  }

  if (publication) {
    lines.push(
      "**Publication:** Published immediately",

      `**Event message:** ${publication.messageUrl}`,
    );
  } else if (publicationFailure) {
    lines.push(
      "",
      `⚠️ **Immediate publication failed:** ${publicationFailure}`,
      "",
      "The generated event remains stored as an unpublished event.",
      `Retry publication with \`/event publish event-id:${generationResult.event.id}\`.`,
    );
  } else if (scheduledPublicationAt) {
    const publicationUnix = Math.floor(scheduledPublicationAt.getTime() / 1000);

    lines.push(
      `**Publication:** <t:${publicationUnix}:F> (<t:${publicationUnix}:R>)`,

      `**Manual override:** \`/event publish event-id:${generationResult.event.id}\` can publish it earlier.`,
    );
  } else {
    lines.push(
      "**Publication:** Manual",

      `**Publish:** \`/event publish event-id:${generationResult.event.id}\``,
    );
  }

  await interaction.editReply({
    content: lines.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event_template.generate",

    outcome: "success",

    summary: `Generated event "${generationResult.event.name}" (#${generationResult.event.id}) from template "${template.name}" (#${template.id}).`,

    targetType: "event",

    targetId: String(generationResult.event.id),

    details: {
      templateId: template.id,

      startsAt: generationResult.event.startsAt.toISOString(),

      publicationMode: generationResult.publicationMode,

      immediatePublication: generationResult.requiresImmediatePublication
        ? publication
          ? "published"
          : "failed"
        : null,

      publicationFailure,

      messageUrl: publication?.messageUrl ?? null,
    },
  });
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

async function setTemplatePingRoles(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const clear = interaction.options.getBoolean("clear") ?? false;

  const selectedRoles = [
    interaction.options.getRole("ping-role-1"),
    interaction.options.getRole("ping-role-2"),
    interaction.options.getRole("ping-role-3"),
    interaction.options.getRole("ping-role-4"),
  ].filter((role): role is Role => role !== null);

  if (clear && selectedRoles.length > 0) {
    await interaction.editReply({
      content:
        "Choose either replacement ping roles or `clear:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (!clear && selectedRoles.length === 0) {
    await interaction.editReply({
      content:
        "Select at least one replacement ping role, or use `clear:true` to remove all template ping roles.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const roleIds = selectedRoles.map((role) => role.id);

  if (new Set(roleIds).size !== roleIds.length) {
    await interaction.editReply({
      content: "Each replacement ping role must be selected only once.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const invalidRoles = selectedRoles.filter(
    (role) => role.id === interaction.guild.id || role.managed,
  );

  if (invalidRoles.length > 0) {
    await interaction.editReply({
      content: [
        "One or more selected ping roles cannot be used:",
        "",
        ...invalidRoles.map((role) => `• ${role.name}`),
        "",
        "Do not select `@everyone` or roles managed by Discord integrations.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const result = await replaceEventTemplatePingRoles({
    guildDatabaseId,

    templateId,

    pingRoles: clear
      ? []
      : selectedRoles.map((role) => ({
          discordRoleId: role.id,

          roleNameSnapshot: role.name,
        })),
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content:
          result.pingRoles.length === 0
            ? `✅ Cleared all ping roles from event template #${templateId}.`
            : [
                `✅ Replaced the ping roles for event template #${templateId}.`,
                "",
                ...result.pingRoles.map(
                  (role) => `• <@&${role.discordRoleId}>`,
                ),
                "",
                "Existing generated events were not changed.",
              ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.ping_roles.replace",

        outcome: "success",

        summary: `Replaced ping roles for event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          pingRoleIds: result.pingRoles.map((role) => role.discordRoleId),
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Event template #${templateId} already has that ping-role set. No changes were made.`,

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

    case "invalid_input":
      await interaction.editReply({
        content: formatPingRoleValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function setTemplateOrganisers(
  interaction: CachedCommandInteraction,
  configuration: GuildConfiguration,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const clear = interaction.options.getBoolean("clear") ?? false;

  const primaryUser = interaction.options.getUser("primary-organiser");

  const backupUser = interaction.options.getUser("backup-organiser");

  if (clear && (primaryUser || backupUser)) {
    await interaction.editReply({
      content: "Choose either organiser defaults or `clear:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (!clear && !primaryUser && !backupUser) {
    await interaction.editReply({
      content:
        "Select a primary organiser, or use `clear:true` to remove all organiser defaults.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (backupUser && !primaryUser) {
    await interaction.editReply({
      content:
        "A backup organiser can only be selected when a primary organiser is also supplied.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (primaryUser?.bot || backupUser?.bot) {
    await interaction.editReply({
      content: "Bot accounts cannot be configured as template organisers.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (primaryUser && backupUser && primaryUser.id === backupUser.id) {
    await interaction.editReply({
      content: "The primary and backup organiser must be different members.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  let primaryMember: GuildMember | null = null;

  let backupMember: GuildMember | null = null;

  if (primaryUser) {
    try {
      primaryMember = await interaction.guild.members.fetch(primaryUser.id);
    } catch {
      await interaction.editReply({
        content:
          "The selected primary organiser could not be resolved as a current server member.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }
  }

  if (backupUser) {
    try {
      backupMember = await interaction.guild.members.fetch(backupUser.id);
    } catch {
      await interaction.editReply({
        content:
          "The selected backup organiser could not be resolved as a current server member.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }
  }

  if (
    configuration.eventOrganiserRoleId &&
    primaryMember &&
    !primaryMember.roles.cache.has(configuration.eventOrganiserRoleId)
  ) {
    await interaction.editReply({
      content:
        "The selected primary organiser does not have the configured Event Organiser role.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (
    configuration.eventOrganiserRoleId &&
    backupMember &&
    !backupMember.roles.cache.has(configuration.eventOrganiserRoleId)
  ) {
    await interaction.editReply({
      content:
        "The selected backup organiser does not have the configured Event Organiser role.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const organiserDefaults = clear
    ? []
    : [
        ...(primaryMember
          ? [
              {
                slot: "primary" as const,

                discordUserId: primaryMember.id,

                displayNameSnapshot: primaryMember.displayName,
              },
            ]
          : []),

        ...(backupMember
          ? [
              {
                slot: "backup" as const,

                discordUserId: backupMember.id,

                displayNameSnapshot: backupMember.displayName,
              },
            ]
          : []),
      ];

  const result = await replaceEventTemplateOrganiserDefaults({
    guildDatabaseId: configuration.guildId,

    templateId,

    organiserDefaults,
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content:
          result.organiserDefaults.length === 0
            ? `✅ Cleared all organiser defaults from event template #${templateId}.`
            : [
                `✅ Replaced organiser defaults for event template #${templateId}.`,
                "",
                ...result.organiserDefaults.map(
                  (organiser) =>
                    `• **${formatOrganiserSlot(
                      organiser.slot,
                    )}:** <@${organiser.discordUserId}>`,
                ),
                "",
                "Existing generated events were not changed.",
              ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: configuration.guildId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.organisers.replace",

        outcome: "success",

        summary: `Replaced organiser defaults for event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          primaryOrganiserUserId:
            result.organiserDefaults.find(
              (organiser) => organiser.slot === "primary",
            )?.discordUserId ?? null,

          backupOrganiserUserId:
            result.organiserDefaults.find(
              (organiser) => organiser.slot === "backup",
            )?.discordUserId ?? null,
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Event template #${templateId} already has those organiser defaults. No changes were made.`,

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

    case "invalid_input":
      await interaction.editReply({
        content: formatOrganiserValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function addTemplateReminder(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const selectedChannel = interaction.options.getChannel("channel");

  let channelId: string | null = null;

  if (selectedChannel) {
    const resolvedChannelId = await resolveTemplateReminderChannel(
      interaction,
      selectedChannel.id,
    );

    if (resolvedChannelId === null) {
      return;
    }

    channelId = resolvedChannelId;
  }

  const result = await addEventTemplateReminder({
    guildDatabaseId,

    templateId,

    reminder: {
      timingReference: interaction.options.getString("timing-reference", true),

      minutesBefore: interaction.options.getInteger("minutes-before", true),

      message: interaction.options.getString("message", true),

      channelId,

      pingEventRoles:
        interaction.options.getBoolean("ping-event-roles") ?? false,
    },
  });

  switch (result.kind) {
    case "created":
      await interaction.editReply({
        content: [
          `✅ Added reminder #${result.reminder.id} to event template #${templateId}.`,
          "",
          `**Timing:** ${formatReminderTiming(result.reminder.timingReference)}`,
          `**Offset:** ${result.reminder.minutesBefore} minutes before`,
          `**Message:** ${result.reminder.message}`,
          `**Channel:** ${
            result.reminder.channelId
              ? `<#${result.reminder.channelId}>`
              : "Generated event publication destination"
          }`,
          `**Ping event roles:** ${
            result.reminder.pingEventRoles ? "Yes" : "No"
          }`,
          "",
          "Existing generated events were not changed.",
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.reminder.add",

        outcome: "success",

        summary: `Added reminder #${result.reminder.id} to event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          reminderId: result.reminder.id,

          timingReference: result.reminder.timingReference,

          minutesBefore: result.reminder.minutesBefore,

          channelId: result.reminder.channelId,

          pingEventRoles: result.reminder.pingEventRoles,
        },
      });

      return;

    case "template_not_found":
      await replyTemplateNotFound(interaction, templateId);

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatTemplateReminderValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function editTemplateReminder(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const reminderId = interaction.options.getInteger("reminder-id", true);

  const selectedChannel = interaction.options.getChannel("channel");

  const clearChannel = interaction.options.getBoolean("clear-channel") ?? false;

  if (selectedChannel !== null && clearChannel) {
    await interaction.editReply({
      content:
        "Choose either a replacement reminder channel or `clear-channel:true`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  let channelId: string | null | undefined;

  if (clearChannel) {
    channelId = null;
  } else if (selectedChannel) {
    const resolvedChannelId = await resolveTemplateReminderChannel(
      interaction,
      selectedChannel.id,
    );

    if (resolvedChannelId === null) {
      return;
    }

    channelId = resolvedChannelId;
  }

  const result = await editEventTemplateReminder({
    guildDatabaseId,

    templateId,

    reminderId,

    timingReference:
      interaction.options.getString("timing-reference") ?? undefined,

    minutesBefore:
      interaction.options.getInteger("minutes-before") ?? undefined,

    message: interaction.options.getString("message") ?? undefined,

    channelId,

    pingEventRoles:
      interaction.options.getBoolean("ping-event-roles") ?? undefined,
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content: [
          `✅ Updated reminder #${result.reminder.id} for event template #${templateId}.`,
          "",
          `**Timing:** ${formatReminderTiming(
            result.reminder.timingReference,
          )}`,
          `**Offset:** ${result.reminder.minutesBefore} minutes before`,
          `**Message:** ${result.reminder.message}`,
          `**Channel:** ${
            result.reminder.channelId
              ? `<#${result.reminder.channelId}>`
              : "Generated event publication destination"
          }`,
          `**Ping event roles:** ${
            result.reminder.pingEventRoles ? "Yes" : "No"
          }`,
          "",
          "Existing generated events were not changed.",
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.reminder.edit",

        outcome: "success",

        summary: `Edited reminder #${result.reminder.id} for event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          reminderId: result.reminder.id,

          timingReference: result.reminder.timingReference,

          minutesBefore: result.reminder.minutesBefore,

          channelId: result.reminder.channelId,

          pingEventRoles: result.reminder.pingEventRoles,
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Reminder #${result.reminder.id} already has that reusable configuration. No changes were made.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "template_not_found":
      await replyTemplateNotFound(interaction, templateId);

      return;

    case "reminder_not_found":
      await interaction.editReply({
        content: `Reminder #${reminderId} was not found on event template #${templateId}.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatTemplateReminderValidationError(result.reason),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function removeTemplateReminder(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const reminderId = interaction.options.getInteger("reminder-id", true);

  const result = await removeEventTemplateReminder({
    guildDatabaseId,

    templateId,

    reminderId,
  });

  switch (result.kind) {
    case "removed":
      await interaction.editReply({
        content: [
          `✅ Removed reminder #${result.reminderId} from event template #${templateId}.`,
          "",
          "Existing generated events and their reminder instances were not changed.",
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.reminder.remove",

        outcome: "success",

        summary: `Removed reminder #${result.reminderId} from event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          reminderId: result.reminderId,
        },
      });

      return;

    case "template_not_found":
      await replyTemplateNotFound(interaction, templateId);

      return;

    case "reminder_not_found":
      await interaction.editReply({
        content: `Reminder #${reminderId} was not found on event template #${templateId}.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function clearTemplateReminders(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const templateId = interaction.options.getInteger("template-id", true);

  const result = await replaceEventTemplateReminders({
    guildDatabaseId,

    templateId,

    reminders: [],
  });

  switch (result.kind) {
    case "updated":
      await interaction.editReply({
        content: [
          `✅ Cleared all reminder definitions from event template #${templateId}.`,
          "",
          "Existing generated events and their reminder instances were not changed.",
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "event_template.reminders.clear",

        outcome: "success",

        summary: `Cleared reminder definitions from event template #${templateId}.`,

        targetType: "event_template",

        targetId: String(templateId),

        details: {
          reminderCount: 0,
        },
      });

      return;

    case "unchanged":
      await interaction.editReply({
        content: `Event template #${templateId} already has no reminder definitions. No changes were made.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "template_not_found":
      await replyTemplateNotFound(interaction, templateId);

      return;

    case "invalid_input":
      /*
       * An empty replacement has no invalid reminder fields, but keep the
       * service result handled exhaustively.
       */
      await interaction.editReply({
        content: formatTemplateReminderValidationError(result.reason),

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

function formatTemplateGenerationFailure(
  result: Exclude<
    Awaited<ReturnType<typeof generateEventFromTemplate>>,
    {
      kind: "generated";
    }
  >,
): string {
  switch (result.kind) {
    case "template_not_found":
      return "That event template was not found in this server.";

    case "template_inactive":
      return "That event template is inactive and cannot generate events.";

    case "template_changed":
      return [
        "The template changed while this occurrence was being prepared.",
        "",
        "Run `/template generate` again so the occurrence uses one consistent template revision.",
      ].join("\n");

    case "guild_not_configured":
      return "This server no longer has the configuration required to generate events.";

    case "event_type_unavailable":
      return "The template's configured event type is no longer available.";

    case "audience_unavailable":
      return "The template's configured region or audience is no longer available.";

    case "missing_publication_channel":
      return "The template does not currently resolve to a usable event publication channel.";

    case "invalid_template":
      return formatInvalidTemplateGenerationReason(
        result.reason,
        result.reminderId,
      );

    case "invalid_occurrence":
      return formatInvalidTemplateOccurrenceReason(result.reason);

    case "preset_application_failed":
      return [
        "The configured role-request preset could not be applied.",
        "",
        `Reason: \`${result.result.kind}\``,
        "",
        "No event was created because template generation was rolled back.",
      ].join("\n");
  }
}

function formatInvalidTemplateGenerationReason(
  reason: InvalidEventTemplateReason,
  reminderId?: number,
): string {
  switch (reason) {
    case "invalid_timezone":
      return "The template has an invalid timezone. Edit the template before generating an event.";

    case "invalid_duration":
      return "The template has an invalid event duration.";

    case "invalid_attendance_close_offset":
      return "The template has an invalid attendance-close offset.";

    case "invalid_publication_mode":
      return "The template has an invalid publication mode.";

    case "invalid_publication_offset":
      return "The template has an invalid scheduled-publication offset.";

    case "publication_not_before_signup_close":
      return "The template would publish the event at or after its signup deadline.";

    case "backup_without_primary":
      return "The template has a backup organiser without a primary organiser.";

    case "invalid_organiser_slot":
      return "The template contains an invalid organiser-default slot.";

    case "invalid_reminder_timing_reference":
      return reminderId
        ? `Template reminder #${reminderId} has an invalid timing reference.`
        : "The template contains a reminder with an invalid timing reference.";

    case "signup_close_reminder_without_signups":
      return reminderId
        ? `Template reminder #${reminderId} is relative to signup close, but the template does not use signups.`
        : "The template contains a signup-close reminder but does not use signups.";

    case "empty_reminder_message":
      return reminderId
        ? `Template reminder #${reminderId} has an empty message.`
        : "The template contains a reminder with an empty message.";
  }
}

function formatInvalidTemplateOccurrenceReason(
  reason: InvalidTemplateOccurrenceReason,
): string {
  switch (reason) {
    case "invalid_start":
      return "The resolved occurrence start time is invalid.";

    case "start_not_future":
      return "The generated event must start in the future.";

    case "signup_close_not_future":
      return [
        "The generated event's signup deadline would already have passed.",
        "",
        "Choose a later occurrence or reduce the template's attendance-close offset.",
      ].join("\n");
  }
}

function formatImmediatePublicationFailure(
  reason: EventPublicationFailureReason,
): string {
  switch (reason) {
    case "not-found":
      return "the newly-generated event could not be found for publication";

    case "already-published":
      return "the event is already published";

    case "inactive":
      return "the generated event is no longer active";

    case "event-started":
      return "the generated event has already started";

    case "signup-closed":
      return "the generated event's signup deadline has already passed";
  }
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

  if (reason === "recurrence_requires_local_start_time") {
    return "The template local start time cannot be cleared while a recurrence series exists. Recurring occurrences require a reusable local start time.";
  }

  if (reason === "active_recurrence_disallows_immediate_publication") {
    return [
      "This template has an active recurrence and cannot use Immediate publication.",
      "",
      "Recurring occurrences are generated in advance, so Immediate publication could expose multiple future events at once.",
      "",
      "Use Manual or Scheduled publication, or deactivate the recurrence before changing the template to Immediate publication.",
    ].join("\n");
  }

  return formatCreateValidationError(reason);
}

function formatPingRoleValidationError(
  reason: TemplatePingRoleValidationReason,
): string {
  switch (reason) {
    case "invalid_discord_role_id":
      return "One of the selected ping roles has an invalid Discord role ID.";

    case "invalid_role_name":
      return "One of the selected ping roles has an invalid readable role name.";

    case "duplicate_discord_role":
      return "The replacement ping-role set contains the same Discord role more than once.";
  }
}

function formatOrganiserValidationError(
  reason: TemplateOrganiserValidationReason,
): string {
  switch (reason) {
    case "invalid_slot":
      return "The organiser-default set contains an unsupported organiser slot.";

    case "invalid_discord_user_id":
      return "One of the organiser defaults has an invalid Discord user ID.";

    case "invalid_display_name":
      return "One of the organiser defaults has an invalid display-name snapshot.";

    case "duplicate_slot":
      return "The organiser-default set contains the same organiser slot more than once.";

    case "duplicate_discord_user":
      return "The same Discord member cannot occupy both organiser slots.";

    case "backup_requires_primary":
      return "A backup organiser requires a primary organiser.";
  }
}

function formatTemplateReminderValidationError(
  reason: EventTemplateReminderInvalidReason | "no_changes_requested",
): string {
  switch (reason) {
    case "invalid_timing_reference":
      return "The reminder timing reference is invalid.";

    case "invalid_minutes_before":
      return "The reminder offset must be zero or a positive whole number of minutes.";

    case "invalid_message":
      return "The reminder message cannot be blank.";

    case "invalid_channel_id":
      return "The reminder channel is invalid.";

    case "signup_close_requires_signups":
      return "A signup-close reminder requires signups to be enabled on the template.";

    case "no_changes_requested":
      return "No reminder changes were supplied.";
  }
}

async function resolveTemplateReminderChannel(
  interaction: CachedCommandInteraction,
  channelId: string,
): Promise<string | null> {
  const channel = await interaction.guild.channels.fetch(channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isSendable()
  ) {
    await interaction.editReply({
      content: "The selected reminder channel is unavailable.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  const botMember =
    interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  if (
    !permissions.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages)
  ) {
    await interaction.editReply({
      content:
        "The bot cannot view and send messages in the selected reminder channel.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  return channel.id;
}

async function replyTemplateNotFound(
  interaction: CachedCommandInteraction,
  templateId: number,
): Promise<void> {
  await interaction.editReply({
    content: `Event template #${templateId} was not found in this server.`,

    allowedMentions: {
      parse: [],
    },
  });
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
