import {
  type ChatInputCommandInteraction,
  MessageFlags,
  type Role,
} from "discord.js";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";

import { writeAuditLog } from "../audit/audit-log.js";

import {
  addPresetRoleOption,
  createRoleRequestPreset,
} from "../role-requests/role-request-preset-admin-service.js";

import {
  getRoleRequestPresetDetails,
  listRoleRequestPresets,
  type RoleRequestPresetDetails,
} from "../role-requests/role-request-preset-query-service.js";

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
