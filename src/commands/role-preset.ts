import {
  ChannelType,
  type ChatInputCommandInteraction,
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
  addPresetRequestGroup,
  addPresetRoleOption,
  createRoleRequestPreset,
} from "../role-requests/role-request-preset-admin-service.js";

import {
  getRoleRequestPresetDetails,
  listRoleRequestPresets,
  type RoleRequestPresetDetails,
} from "../role-requests/role-request-preset-query-service.js";
import {
  applyRoleRequestPresetToEvent,
  type InvalidRoleRequestPresetReason,
} from "../role-requests/role-request-preset-service.js";

type CachedCommandInteraction = ChatInputCommandInteraction<"cached">;

export async function handleRolePresetCommand(
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
      await createPreset(interaction, configuration.guildId);

      return;

    case "list":
      await listPresets(interaction, configuration.guildId);

      return;

    case "show":
      await showPreset(interaction, configuration.guildId);

      return;

    case "option-add":
      await addPresetOption(interaction, configuration.guildId);

      return;

    case "group-add":
      await addPresetGroup(interaction, configuration.guildId);

      return;

    case "apply":
      await applyPreset(interaction, configuration.guildId);

      return;

    default:
      throw new Error(`Unknown role-preset subcommand: ${subcommand}`);
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
    const command = `/role-preset ${subcommand}`;

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
        commandName: "role-preset",

        subcommand,
      },
    });

    await interaction.editReply({
      content:
        "You need the configured Event Admin role or the Manage Server permission to manage role-request presets.",

      allowedMentions: {
        parse: [],
      },
    });

    return null;
  }

  return configuration;
}

async function createPreset(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const name = interaction.options.getString("name", true);

  const description = interaction.options.getString("description");

  const result = await createRoleRequestPreset({
    guildDatabaseId,

    name,

    description,

    createdByUserId: interaction.user.id,
  });

  switch (result.kind) {
    case "created": {
      await interaction.editReply({
        content: [
          `✅ Created role-request preset **${result.preset.name}** (#${result.preset.id}).`,

          result.preset.description
            ? `**Description:** ${result.preset.description}`
            : "**Description:** None",

          "",
          "The preset currently contains no role options or request groups.",
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "role_preset.create",

        outcome: "success",

        summary: `Created role-request preset "${result.preset.name}" (#${result.preset.id}).`,

        targetType: "role_request_preset",

        targetId: String(result.preset.id),

        details: {
          name: result.preset.name,

          description: result.preset.description,
        },
      });

      return;
    }

    case "name_conflict":
      await interaction.editReply({
        content: `A role-request preset named **${result.name}** already exists in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content:
          "The preset name is invalid. Use a non-empty name of no more than 100 characters.",

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "guild_not_found":
      await interaction.editReply({
        content:
          "This server's stored configuration changed while the command was being processed. Run `/setup initialise` and try again.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function addPresetOption(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const presetId = interaction.options.getInteger("preset-id", true);

  const displayName = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const restrictionText =
    interaction.options.getString("restriction") ?? "open";

  if (restrictionText !== "open" && restrictionText !== "qualified_only") {
    await interaction.editReply({
      content: "The preset role-request restriction is invalid.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  /*
   * Capture the narrowed domain value before asynchronous service work.
   */
  const requestRestriction: "open" | "qualified_only" = restrictionText;

  const capacity = interaction.options.getInteger("capacity");

  const qualifiedRoles = getSelectedRoles(interaction, [
    "qualified-role-1",
    "qualified-role-2",
    "qualified-role-3",
    "qualified-role-4",
  ]);

  const supervisedRoles = getSelectedRoles(interaction, [
    "supervised-role-1",
    "supervised-role-2",
    "supervised-role-3",
    "supervised-role-4",
  ]);

  const overlappingRole = qualifiedRoles.find((qualified) =>
    supervisedRoles.some((supervised) => supervised.id === qualified.id),
  );

  if (overlappingRole) {
    await interaction.editReply({
      content: `**${overlappingRole.name}** cannot be both fully qualified and supervision-required for the same preset role option.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const allQualificationRoles = [...qualifiedRoles, ...supervisedRoles];

  if (allQualificationRoles.some((role) => role.id === interaction.guild.id)) {
    await interaction.editReply({
      content: "`@everyone` cannot be used as a preset qualification role.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (
    requestRestriction === "qualified_only" &&
    allQualificationRoles.length === 0
  ) {
    await interaction.editReply({
      content:
        "A `Qualified only` preset role option must have at least one configured qualification role.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const result = await addPresetRoleOption({
    guildDatabaseId,

    presetId,

    displayName,

    description,

    requestRestriction,

    capacity,

    qualificationRoles: [
      ...qualifiedRoles.map((role) => ({
        discordRoleId: role.id,

        roleNameSnapshot: role.name,

        qualificationLevel: "qualified",
      })),

      ...supervisedRoles.map((role) => ({
        discordRoleId: role.id,

        roleNameSnapshot: role.name,

        qualificationLevel: "supervision_required",
      })),
    ],
  });

  switch (result.kind) {
    case "added": {
      await interaction.editReply({
        content: [
          `✅ Added role option **${result.option.displayName}** (#${result.option.id}) to preset #${result.option.presetId}.`,

          "",
          `**Key:** \`${result.option.key}\``,

          `**Restriction:** ${
            result.option.requestRestriction === "qualified_only"
              ? "Qualified only"
              : "Open"
          }`,

          `**Capacity:** ${
            result.option.capacity === null
              ? "Unlimited"
              : result.option.capacity
          }`,

          `**Fully qualified roles:** ${
            qualifiedRoles.length > 0
              ? qualifiedRoles.map((role) => `<@&${role.id}>`).join(", ")
              : "None configured"
          }`,

          `**Supervision-required roles:** ${
            supervisedRoles.length > 0
              ? supervisedRoles.map((role) => `<@&${role.id}>`).join(", ")
              : "None configured"
          }`,
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "role_preset.option.add",

        outcome: "success",

        summary: `Added role option "${result.option.displayName}" (#${result.option.id}) to role-request preset #${result.option.presetId}.`,

        targetType: "role_request_preset_option",

        targetId: String(result.option.id),

        details: {
          presetId: result.option.presetId,

          key: result.option.key,

          requestRestriction: result.option.requestRestriction,

          capacity: result.option.capacity,

          qualifiedRoleIds: qualifiedRoles.map((role) => role.id),

          supervisedRoleIds: supervisedRoles.map((role) => role.id),
        },
      });

      return;
    }

    case "preset_not_found":
      await interaction.editReply({
        content: `Role-request preset #${presetId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "key_conflict":
      await interaction.editReply({
        content: `Preset #${presetId} already has a role option with the logical key \`${result.key}\`. Choose a more distinct name.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatPresetOptionValidationError(
          result.reason,
          result.discordRoleId,
        ),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function addPresetGroup(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const presetId = interaction.options.getInteger("preset-id", true);

  const name = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const presetOptionIds = [
    interaction.options.getInteger("role-1", true),

    interaction.options.getInteger("role-2"),

    interaction.options.getInteger("role-3"),

    interaction.options.getInteger("role-4"),

    interaction.options.getInteger("role-5"),

    interaction.options.getInteger("role-6"),

    interaction.options.getInteger("role-7"),

    interaction.options.getInteger("role-8"),

    interaction.options.getInteger("role-9"),

    interaction.options.getInteger("role-10"),
  ].filter((value): value is number => value !== null);

  const duplicateOptionId = findDuplicateNumber(presetOptionIds);

  if (duplicateOptionId !== null) {
    await interaction.editReply({
      content: `Role option #${duplicateOptionId} was selected more than once. Each option can appear only once in a preset request group.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const openBefore = interaction.options.getInteger(
    "open-minutes-before-start",
  );

  const openAfter = interaction.options.getInteger("open-minutes-after-start");

  if (openBefore !== null && openAfter !== null) {
    await interaction.editReply({
      content:
        "Choose either `open-minutes-before-start` or `open-minutes-after-start`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const closeBefore = interaction.options.getInteger(
    "close-minutes-before-start",
  );

  const closeAfter = interaction.options.getInteger(
    "close-minutes-after-start",
  );

  if (closeBefore !== null && closeAfter !== null) {
    await interaction.editReply({
      content:
        "Choose either `close-minutes-before-start` or `close-minutes-after-start`, not both.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  /*
   * The event-level stored representation uses signed offsets:
   *
   *  60 = T-60
   *   0 = T
   * -10 = T+10
   */
  const openMinutesBeforeStart =
    openBefore ?? (openAfter !== null ? -openAfter : 60);

  const closeMinutesBeforeStart =
    closeBefore ?? (closeAfter !== null ? -closeAfter : 0);

  if (openMinutesBeforeStart <= closeMinutesBeforeStart) {
    await interaction.editReply({
      content: `The role-request group must open before it closes. The supplied window would be ${formatRelativeOffset(
        openMinutesBeforeStart,
      )} → ${formatRelativeOffset(closeMinutesBeforeStart)}.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  /*
   * Read the current preset definition for friendly command validation and
   * display names.
   *
   * addPresetRequestGroup() repeats the authoritative ownership/activity
   * validation under the preset FOR UPDATE lock, so this read is a UX layer,
   * not a race-sensitive source of truth.
   */
  const presetResult = await getRoleRequestPresetDetails({
    guildDatabaseId,

    presetId,
  });

  if (presetResult.kind === "not_found") {
    await interaction.editReply({
      content: `Role-request preset #${presetId} was not found in this server.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const activeOptionById = new Map(
    presetResult.preset.options
      .filter((option) => option.active)
      .map((option) => [option.id, option]),
  );

  const unavailableOptionId = presetOptionIds.find(
    (optionId) => !activeOptionById.has(optionId),
  );

  if (unavailableOptionId !== undefined) {
    await interaction.editReply({
      content: `Role option #${unavailableOptionId} is not an active option in preset #${presetId}. Use \`/role-preset show preset-id:${presetId}\` to check the available option IDs.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const orderedOptions = presetOptionIds.map((optionId) => {
    const option = activeOptionById.get(optionId);

    if (!option) {
      throw new Error(
        `Preset option #${optionId} disappeared after validation.`,
      );
    }

    return option;
  });

  const notifyRole = interaction.options.getRole("notify-role");

  if (notifyRole?.id === interaction.guild.id) {
    await interaction.editReply({
      content:
        "`@everyone` cannot be used as a preset request-group notification role.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const selectedChannel = interaction.options.getChannel("channel");

  let explicitChannelId: string | null = null;

  if (selectedChannel !== null) {
    /*
     * Re-fetch the explicitly selected destination so validation uses the
     * guild's current Discord state rather than only interaction-resolved
     * data.
     */
    const channel = await interaction.guild.channels.fetch(selectedChannel.id);

    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.isSendable()
    ) {
      await interaction.editReply({
        content: "The selected preset role-request channel is unavailable.",

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
          "The bot does not currently have all required posting permissions in that preset role-request channel.",

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    if (
      notifyRole &&
      !notifyRole.mentionable &&
      !permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
      await interaction.editReply({
        content: `The bot cannot currently mention **${notifyRole.name}** in that explicit preset channel.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    explicitChannelId = channel.id;
  }

  /*
   * If there is no explicit channel, do not inspect the guild's current
   * default here.
   *
   * Null is meaningful preset state: resolve and snapshot the guild default
   * when this preset is applied to an event.
   *
   * Consequently an unmentionable notification role is also not rejected
   * here when the eventual destination is unknown. Publication validates the
   * snapshotted combination again when the group actually opens.
   */
  const requiresPositiveSignup =
    interaction.options.getBoolean("requires-signup") ?? false;

  const result = await addPresetRequestGroup({
    guildDatabaseId,

    presetId,

    name,

    description,

    presetOptionIds,

    channelId: explicitChannelId,

    notifyRole: notifyRole
      ? {
          discordRoleId: notifyRole.id,

          roleNameSnapshot: notifyRole.name,
        }
      : null,

    requiresPositiveSignup,

    openMinutesBeforeStart,

    closeMinutesBeforeStart,
  });

  switch (result.kind) {
    case "added": {
      await interaction.editReply({
        content: [
          `✅ Added request group **${result.group.name}** (#${result.group.id}) to preset #${result.group.presetId}.`,

          "",

          `**Channel:** ${
            result.group.channelId
              ? `<#${result.group.channelId}>`
              : "Guild default at application"
          }`,

          `**Notification role:** ${
            result.group.notifyRoleId
              ? `<@&${result.group.notifyRoleId}>${
                  result.group.notifyRoleNameSnapshot
                    ? ` (${result.group.notifyRoleNameSnapshot})`
                    : ""
                }`
              : "None"
          }`,

          `**Requires positive signup:** ${
            result.group.requiresPositiveSignup ? "Yes" : "No"
          }`,

          `**Window:** ${formatRelativeOffset(
            result.group.openMinutesBeforeStart,
          )} → ${formatRelativeOffset(result.group.closeMinutesBeforeStart)}`,

          `**Role options:** ${orderedOptions
            .map((option) => `${option.displayName} (#${option.id})`)
            .join(", ")}`,
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "role_preset.group.add",

        outcome: "success",

        summary: `Added request group "${result.group.name}" (#${result.group.id}) to role-request preset #${result.group.presetId}.`,

        targetType: "role_request_preset_group",

        targetId: String(result.group.id),

        details: {
          presetId: result.group.presetId,

          presetOptionIds: [...result.group.presetOptionIds],

          channelId: result.group.channelId,

          notifyRoleId: result.group.notifyRoleId,

          requiresPositiveSignup: result.group.requiresPositiveSignup,

          openMinutesBeforeStart: result.group.openMinutesBeforeStart,

          closeMinutesBeforeStart: result.group.closeMinutesBeforeStart,
        },
      });

      return;
    }

    case "preset_not_found":
      await interaction.editReply({
        content: `Role-request preset #${presetId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_input":
      await interaction.editReply({
        content: formatPresetGroupValidationError(
          result.reason,
          presetId,
          result.presetOptionId,
          result.discordRoleId,
        ),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function applyPreset(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const presetId = interaction.options.getInteger("preset-id", true);

  const eventId = interaction.options.getInteger("event-id", true);

  /*
   * All race-sensitive validation belongs to the application service.
   *
   * It locks the target event, reads the preset under its shared mutation
   * fence and atomically creates the complete event-level snapshot together
   * with its durable scheduler actions.
   */
  const result = await applyRoleRequestPresetToEvent({
    guildDatabaseId,

    eventId,

    presetId,

    appliedByUserId: interaction.user.id,
  });

  switch (result.kind) {
    case "applied": {
      await interaction.editReply({
        content: [
          `✅ Applied role-request preset #${result.presetId} to event #${result.eventId}.`,

          "",

          `**Snapshotted role options:** ${formatCount(
            result.eventRoleOptionIds.length,
            "role option",
          )}`,

          result.eventRoleOptionIds
            .map((optionId) => `#${optionId}`)
            .join(", "),

          "",

          `**Request groups created:** ${formatCount(
            result.roleRequestGroupIds.length,
            "request group",
          )}`,

          result.roleRequestGroupIds.map((groupId) => `#${groupId}`).join(", "),

          "",

          "The event now owns an independent snapshot of this preset. Later preset changes will not alter this event.",

          "Role-request messages are not posted by this command itself; scheduled group openings are handled by the event scheduler.",

          "",

          `Use \`/event role-option-list event-id:${result.eventId}\` and \`/event role-group-list event-id:${result.eventId}\` to inspect the event-level snapshot.`,
        ].join("\n"),

        allowedMentions: {
          parse: [],
        },
      });

      await writeAuditLog({
        guildId: guildDatabaseId,

        guild: interaction.guild,

        actorUserId: interaction.user.id,

        action: "role_preset.apply",

        outcome: "success",

        summary: `Applied role-request preset #${result.presetId} to event #${result.eventId}.`,

        targetType: "event",

        targetId: String(result.eventId),

        details: {
          presetId: result.presetId,

          eventRoleOptionIds: [...result.eventRoleOptionIds],

          roleRequestGroupIds: [...result.roleRequestGroupIds],
        },
      });

      return;
    }

    case "event_not_found":
      await interaction.editReply({
        content: `Event #${eventId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "event_terminal":
      await interaction.editReply({
        content: `Event #${eventId} is ${result.status} and cannot accept a role-request preset.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "role_requests_disabled":
      await interaction.editReply({
        content: `Event #${eventId}'s event type has role requests disabled.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "preset_not_found":
      await interaction.editReply({
        content: `Role-request preset #${presetId} was not found in this server.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "preset_inactive":
      await interaction.editReply({
        content: `Role-request preset #${presetId} is inactive and cannot be applied.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "already_applied":
      await interaction.editReply({
        content: `Role-request preset #${presetId} has already been applied to event #${eventId}.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "missing_default_channel":
      await interaction.editReply({
        content: `Preset group #${result.presetGroupId} uses the guild default role-request channel, but no default role-request channel is configured.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "signup_required":
      await interaction.editReply({
        content: `Preset group #${result.presetGroupId} requires a positive signup, but event #${eventId} has signups disabled.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "role_option_conflict":
      await interaction.editReply({
        content: `Event #${eventId} already has a role option with the logical key \`${result.key}\`.`,

        allowedMentions: {
          parse: [],
        },
      });

      return;

    case "invalid_preset":
      await interaction.editReply({
        content: formatInvalidPresetApplicationError(
          result.reason,

          presetId,

          result.presetOptionId,

          result.presetGroupId,
        ),

        allowedMentions: {
          parse: [],
        },
      });

      return;
  }
}

async function listPresets(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const includeInactive =
    interaction.options.getBoolean("include-inactive") ?? false;

  const presets = await listRoleRequestPresets({
    guildDatabaseId,

    includeInactive,
  });

  if (presets.length === 0) {
    await interaction.editReply({
      content: includeInactive
        ? "This server has no role-request presets."
        : "This server has no active role-request presets.",

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const lines = [
    includeInactive
      ? "## Role-request presets"
      : "## Active role-request presets",

    "",
  ];

  for (const preset of presets) {
    lines.push(
      `• **${preset.name}** (#${preset.id})${
        preset.active ? "" : " — inactive"
      }`,
    );

    lines.push(
      `  ${formatCount(
        preset.activeOptionCount,
        "active option",
      )}, ${formatCount(preset.activeGroupCount, "active group")}`,
    );

    if (preset.description) {
      lines.push(`  ${truncate(preset.description, 300)}`);
    }
  }

  await sendEphemeralText(interaction, lines.join("\n"));
}

async function showPreset(
  interaction: CachedCommandInteraction,
  guildDatabaseId: number,
): Promise<void> {
  const presetId = interaction.options.getInteger("preset-id", true);

  const result = await getRoleRequestPresetDetails({
    guildDatabaseId,

    presetId,
  });

  if (result.kind === "not_found") {
    await interaction.editReply({
      content: `Role-request preset #${presetId} was not found in this server.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  await sendEphemeralText(interaction, formatPresetDetails(result.preset));
}

function findDuplicateNumber(values: readonly number[]): number | null {
  const seen = new Set<number>();

  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }

    seen.add(value);
  }

  return null;
}

function formatInvalidPresetApplicationError(
  reason: InvalidRoleRequestPresetReason,

  presetId: number,

  presetOptionId?: number,

  presetGroupId?: number,
): string {
  switch (reason) {
    case "no_active_options":
      return `Role-request preset #${presetId} has no active role options.`;

    case "no_active_groups":
      return `Role-request preset #${presetId} has no active request groups.`;

    case "invalid_request_restriction":
      return presetOptionId
        ? `Preset role option #${presetOptionId} has an invalid request restriction.`
        : `Role-request preset #${presetId} contains an invalid request restriction.`;

    case "missing_qualification_roles":
      return presetOptionId
        ? `Preset role option #${presetOptionId} is qualified-only but has no qualification roles.`
        : `Role-request preset #${presetId} contains a qualified-only option with no qualification roles.`;

    case "invalid_qualification_level":
      return presetOptionId
        ? `Preset role option #${presetOptionId} contains an invalid qualification level.`
        : `Role-request preset #${presetId} contains an invalid qualification level.`;

    case "group_option_outside_preset":
      if (presetGroupId && presetOptionId) {
        return `Preset group #${presetGroupId} references role option #${presetOptionId} outside preset #${presetId}.`;
      }

      return `Role-request preset #${presetId} contains a request-group option mapping outside the preset.`;

    case "active_group_without_active_options":
      return presetGroupId
        ? `Preset group #${presetGroupId} has no active role options.`
        : `Role-request preset #${presetId} contains an active request group with no active role options.`;

    case "invalid_group_window":
      return presetGroupId
        ? `Preset group #${presetGroupId} does not open before it closes.`
        : `Role-request preset #${presetId} contains an invalid request-group window.`;
  }
}

function formatPresetGroupValidationError(
  reason:
    | "invalid_name"
    | "no_options"
    | "invalid_option_id"
    | "duplicate_option"
    | "option_not_found_or_inactive"
    | "invalid_channel_id"
    | "invalid_notify_role_id"
    | "invalid_notify_role_name"
    | "everyone_notify_role"
    | "invalid_open_offset"
    | "invalid_close_offset"
    | "invalid_group_window",

  presetId: number,

  presetOptionId?: number,

  discordRoleId?: string,
): string {
  switch (reason) {
    case "invalid_name":
      return "The request-group name is invalid. Use a non-empty name of no more than 100 characters.";

    case "no_options":
      return "A preset request group must contain at least one role option.";

    case "invalid_option_id":
      return presetOptionId
        ? `Role option #${presetOptionId} is not a valid preset option ID.`
        : "One of the supplied preset role-option IDs is invalid.";

    case "duplicate_option":
      return presetOptionId
        ? `Role option #${presetOptionId} was selected more than once. Each option can appear only once in a preset request group.`
        : "A preset role option was selected more than once.";

    case "option_not_found_or_inactive":
      return presetOptionId
        ? `Role option #${presetOptionId} is not an active option in preset #${presetId}. Use \`/role-preset show preset-id:${presetId}\` to check the available option IDs.`
        : `One or more supplied role options are not active options in preset #${presetId}.`;

    case "invalid_channel_id":
      return "The explicit preset role-request channel ID is invalid.";

    case "invalid_notify_role_id":
      return "The preset notification-role ID is invalid.";

    case "invalid_notify_role_name":
      return discordRoleId
        ? `The stored name for notification role <@&${discordRoleId}> is invalid.`
        : "The preset notification-role name is invalid.";

    case "everyone_notify_role":
      return "`@everyone` cannot be used as a preset request-group notification role.";

    case "invalid_open_offset":
      return "The preset request-group opening offset is invalid.";

    case "invalid_close_offset":
      return "The preset request-group closing offset is invalid.";

    case "invalid_group_window":
      return "The preset request group must open before it closes.";
  }
}

function formatPresetDetails(preset: RoleRequestPresetDetails): string {
  const optionNameById = new Map(
    preset.options.map((option) => [option.id, option.displayName]),
  );

  const lines: string[] = [
    `## ${preset.name} (#${preset.id})`,

    `**Status:** ${preset.active ? "Active" : "Inactive"}`,

    `**Description:** ${
      preset.description ? truncate(preset.description, 500) : "None"
    }`,

    "",
    "### Role options",
  ];

  if (preset.options.length === 0) {
    lines.push("No role options configured.");
  } else {
    for (const option of preset.options) {
      lines.push(
        `• **${option.displayName}** (#${option.id})${
          option.active ? "" : " — inactive"
        }`,
      );

      lines.push(
        `  Key: \`${option.key}\` | Restriction: ${formatRequestRestriction(
          option.requestRestriction,
        )} | Capacity: ${
          option.capacity === null ? "Unlimited" : option.capacity
        }`,
      );

      if (option.description) {
        lines.push(`  ${truncate(option.description, 300)}`);
      }

      for (const qualification of option.qualificationRoles) {
        lines.push(
          `  ↳ ${formatQualificationLevel(
            qualification.qualificationLevel,
          )}: <@&${qualification.discordRoleId}> (${qualification.roleNameSnapshot})`,
        );
      }
    }
  }

  lines.push("", "### Request groups");

  if (preset.groups.length === 0) {
    lines.push("No request groups configured.");
  } else {
    for (const group of preset.groups) {
      lines.push(
        `• **${group.name}** (#${group.id})${
          group.active ? "" : " — inactive"
        }`,
      );

      lines.push(
        `  Window: ${formatRelativeOffset(
          group.openMinutesBeforeStart,
        )} → ${formatRelativeOffset(group.closeMinutesBeforeStart)}`,
      );

      lines.push(
        `  Channel: ${
          group.channelId
            ? `<#${group.channelId}>`
            : "Guild default at application"
        }`,
      );

      lines.push(
        `  Notify: ${
          group.notifyRoleId
            ? `<@&${group.notifyRoleId}>${
                group.notifyRoleNameSnapshot
                  ? ` (${group.notifyRoleNameSnapshot})`
                  : ""
              }`
            : "None"
        }`,
      );

      lines.push(
        `  Requires positive signup: ${
          group.requiresPositiveSignup ? "Yes" : "No"
        }`,
      );

      const mappedOptions = group.presetOptionIds.map((optionId) => {
        const optionName = optionNameById.get(optionId);

        return optionName
          ? `${optionName} (#${optionId})`
          : `Unknown option (#${optionId})`;
      });

      lines.push(
        `  Options: ${
          mappedOptions.length > 0 ? mappedOptions.join(", ") : "None"
        }`,
      );

      if (group.description) {
        lines.push(`  ${truncate(group.description, 300)}`);
      }
    }
  }

  return lines.join("\n");
}

function getSelectedRoles(
  interaction: CachedCommandInteraction,
  names: readonly string[],
): Role[] {
  const roles = names
    .map((name) => interaction.options.getRole(name))
    .filter((role): role is Role => role !== null);

  /*
   * Duplicate selections within one qualification level are harmless from
   * the command user's point of view, so collapse them before calling the
   * stricter domain service.
   *
   * A role appearing across both levels is rejected explicitly above.
   */
  return [...new Map(roles.map((role) => [role.id, role])).values()];
}

function formatPresetOptionValidationError(
  reason:
    | "invalid_name"
    | "invalid_request_restriction"
    | "invalid_capacity"
    | "invalid_qualification_level"
    | "invalid_qualification_role_id"
    | "invalid_qualification_role_name"
    | "duplicate_qualification_role"
    | "everyone_qualification_role"
    | "missing_qualification_roles",

  discordRoleId?: string,
): string {
  switch (reason) {
    case "invalid_name":
      return "The role-option name is invalid. Use a non-empty name of no more than 100 characters.";

    case "invalid_request_restriction":
      return "The preset role-request restriction is invalid.";

    case "invalid_capacity":
      return "Capacity must be a positive whole number.";

    case "missing_qualification_roles":
      return "A `Qualified only` preset role option must have at least one configured qualification role.";

    case "everyone_qualification_role":
      return "`@everyone` cannot be used as a preset qualification role.";

    case "duplicate_qualification_role":
      return discordRoleId
        ? `Discord role <@&${discordRoleId}> was supplied more than once in the qualification rules.`
        : "A Discord qualification role was supplied more than once.";

    case "invalid_qualification_level":
      return "One of the supplied qualification levels is invalid.";

    case "invalid_qualification_role_id":
      return "One of the supplied qualification-role IDs is invalid.";

    case "invalid_qualification_role_name":
      return "One of the supplied qualification-role names is invalid.";
  }
}

function formatRequestRestriction(value: string): string {
  switch (value) {
    case "open":
      return "Open";

    case "qualified_only":
      return "Qualified only";

    default:
      return value;
  }
}

function formatQualificationLevel(value: string): string {
  switch (value) {
    case "qualified":
      return "Qualified";

    case "supervision_required":
      return "Supervision required";

    default:
      return value;
  }
}

function formatRelativeOffset(minutesBeforeStart: number): string {
  if (minutesBeforeStart === 0) {
    return "T";
  }

  if (minutesBeforeStart > 0) {
    return `T-${minutesBeforeStart}`;
  }

  return `T+${Math.abs(minutesBeforeStart)}`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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

  let current = "";

  for (const line of text.split("\n")) {
    if (line.length > maxLength) {
      if (current) {
        chunks.push(current);

        current = "";
      }

      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }

      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length > maxLength) {
      chunks.push(current);

      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength - 1) + "…";
}
