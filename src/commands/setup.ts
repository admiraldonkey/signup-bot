import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, eventTypes, guildSettings } from "../db/schema.js";

const DEFAULT_EVENT_TYPES = [
  {
    code: "naval",
    name: "Naval",
    description: "Standard naval-based events.",
    roleRequestsEnabled: true,
  },
  {
    code: "linebattle",
    name: "Linebattle",
    description: "Standard land-based regiment events.",
    roleRequestsEnabled: true,
  },
  {
    code: "competition",
    name: "Competition",
    description: "Competitive and tournament-style events.",
    roleRequestsEnabled: true,
  },
] as const;

const REQUIRED_POSTING_PERMISSIONS = [
  {
    permission: PermissionFlagsBits.ViewChannel,
    label: "View Channel",
  },
  {
    permission: PermissionFlagsBits.SendMessages,
    label: "Send Messages",
  },
  {
    permission: PermissionFlagsBits.EmbedLinks,
    label: "Embed Links",
  },
  {
    permission: PermissionFlagsBits.ReadMessageHistory,
    label: "Read Message History",
  },
] as const;

function isSupportedPostingChannel(channel: GuildBasedChannel): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.inGuild() ||
    !interaction.guildId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "You need the Manage Server permission to configure the bot.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  const subcommand = interaction.options.getSubcommand();

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (subcommand === "initialise") {
    await initialiseGuild(interaction);
    return;
  }

  if (subcommand === "configure") {
    await configureGuild(interaction);
    return;
  }

  if (subcommand === "status") {
    await showSetupStatus(interaction);
    return;
  }

  throw new Error(`Unknown setup subcommand: ${subcommand}`);
}

async function initialiseGuild(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const discordGuildId = interaction.guildId;

  if (!discordGuildId) {
    throw new Error("The setup command requires a Discord server.");
  }

  const guildName =
    interaction.guild?.name ?? `Discord server ${discordGuildId}`;

  const configuredGuild = await db.transaction(async (transaction) => {
    const now = new Date();

    const [guild] = await transaction
      .insert(discordGuilds)
      .values({
        discordGuildId,
        name: guildName,
        timezone: "Europe/London",
        enabled: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: discordGuilds.discordGuildId,
        set: {
          name: guildName,
          enabled: true,
          updatedAt: now,
        },
      })
      .returning({
        id: discordGuilds.id,
        name: discordGuilds.name,
      });

    if (!guild) {
      throw new Error("Failed to create or retrieve the guild record.");
    }

    await transaction
      .insert(guildSettings)
      .values({
        guildId: guild.id,
        updatedAt: now,
      })
      .onConflictDoNothing();

    for (const eventType of DEFAULT_EVENT_TYPES) {
      await transaction
        .insert(eventTypes)
        .values({
          ownerGuildId: guild.id,
          code: eventType.code,
          name: eventType.name,
          description: eventType.description,
          roleRequestsEnabled: eventType.roleRequestsEnabled,
          active: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [eventTypes.ownerGuildId, eventTypes.code],
          set: {
            name: eventType.name,
            description: eventType.description,
            roleRequestsEnabled: eventType.roleRequestsEnabled,
            active: true,
            updatedAt: now,
          },
        });
    }

    return guild;
  });

  await interaction.editReply(
    [
      `✅ **${configuredGuild.name}** is configured.`,
      "",
      "Default event types:",
      "• Naval",
      "• Linebattle",
      "• Competition",
      "",
      "Running this command again is safe and will not create duplicates.",
    ].join("\n"),
  );
}

async function configureGuild(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  const discordGuildId = interaction.guildId;

  if (!guild || !discordGuildId) {
    throw new Error("The setup configure command requires a Discord server.");
  }

  /*
   * Confirm that /setup initialise has already created the guild record.
   */
  const [configuredGuild] = await db
    .select({
      id: discordGuilds.id,
      name: discordGuilds.name,
    })
    .from(discordGuilds)
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  if (!configuredGuild) {
    await interaction.editReply(
      "This server has not been initialised. " +
        "Run `/setup initialise` first.",
    );

    return;
  }

  /*
   * Resolve the selected options through the guild itself rather than
   * trusting only the interaction payload.
   */
  const selectedAdminRole = interaction.options.getRole(
    "event-admin-role",
    true,
  );

  const selectedAttendanceChannel = interaction.options.getChannel(
    "attendance-channel",
    true,
  );

  const selectedRoleRequestChannel = interaction.options.getChannel(
    "role-request-channel",
    true,
  );

  const selectedPingRole = interaction.options.getRole("ping-role", true);

  const [
    eventAdminRole,
    attendanceChannel,
    roleRequestChannel,
    pingRole,
    botMember,
  ] = await Promise.all([
    guild.roles.fetch(selectedAdminRole.id),
    guild.channels.fetch(selectedAttendanceChannel.id),
    guild.channels.fetch(selectedRoleRequestChannel.id),
    guild.roles.fetch(selectedPingRole.id),
    guild.members.fetchMe(),
  ]);

  const issues: string[] = [];

  if (!eventAdminRole) {
    issues.push("The selected event-admin role could not be found.");
  }

  if (!pingRole) {
    issues.push("The selected ping role could not be found.");
  }

  if (!attendanceChannel) {
    issues.push("The selected attendance channel could not be found.");
  }

  if (!roleRequestChannel) {
    issues.push("The selected role-request channel could not be found.");
  }

  if (issues.length > 0) {
    await interaction.editReply(
      [
        "❌ The configuration could not be saved:",
        "",
        ...issues.map((issue) => `• ${issue}`),
      ].join("\n"),
    );

    return;
  }

  /*
   * The null checks above allow TypeScript to narrow these values.
   */
  if (
    !eventAdminRole ||
    !pingRole ||
    !attendanceChannel ||
    !roleRequestChannel
  ) {
    throw new Error(
      "Discord configuration values unexpectedly became unavailable.",
    );
  }

  /*
   * The @everyone role has the same ID as the guild.
   */
  if (eventAdminRole.id === guild.id) {
    issues.push("The event-admin role cannot be the `@everyone` role.");
  }

  if (pingRole.id === guild.id) {
    issues.push("The event ping role cannot be the `@everyone` role.");
  }

  if (eventAdminRole.managed) {
    issues.push(
      "The event-admin role is managed by Discord or an integration " +
        "and is not suitable for bot administration.",
    );
  }

  if (pingRole.managed) {
    issues.push(
      "The ping role is managed by Discord or an integration " +
        "and cannot be used as the event notification role.",
    );
  }

  if (!isSupportedPostingChannel(attendanceChannel)) {
    issues.push(
      "The attendance destination must be a text or announcement channel.",
    );
  }

  if (!isSupportedPostingChannel(roleRequestChannel)) {
    issues.push(
      "The role-request destination must be a text or announcement channel.",
    );
  }

  /*
   * Check effective permissions, including channel overwrites.
   */
  for (const [channel, label] of [
    [attendanceChannel, "attendance channel"],
    [roleRequestChannel, "role-request channel"],
  ] as const) {
    const channelPermissions = channel.permissionsFor(botMember);

    const missingPermissions = REQUIRED_POSTING_PERMISSIONS.filter(
      ({ permission }) => !channelPermissions.has(permission),
    ).map(({ label: permissionLabel }) => permissionLabel);

    if (missingPermissions.length > 0) {
      issues.push(
        `The bot is missing these permissions in the ${label}: ` +
          missingPermissions.join(", ") +
          ".",
      );
    }
  }

  /*
   * A role can be pinged if it is publicly mentionable, or if the bot has
   * the channel permission that permits mentioning otherwise restricted
   * roles.
   */
  const attendancePermissions = attendanceChannel.permissionsFor(botMember);

  const botCanMentionPingRole =
    pingRole.mentionable ||
    attendancePermissions.has(PermissionFlagsBits.MentionEveryone);

  if (!botCanMentionPingRole) {
    issues.push(
      `The bot cannot mention ${pingRole.name}. Either make the role ` +
        "mentionable or grant the bot “Mention @everyone, @here, and " +
        "All Roles” in the attendance channel.",
    );
  }

  if (issues.length > 0) {
    await interaction.editReply({
      content: [
        "❌ The configuration was not saved:",
        "",
        ...issues.map((issue) => `• ${issue}`),
      ].join("\n"),
      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const now = new Date();

  await db
    .insert(guildSettings)
    .values({
      guildId: configuredGuild.id,
      eventAdminRoleId: eventAdminRole.id,
      defaultAttendanceChannelId: attendanceChannel.id,
      defaultRoleRequestChannelId: roleRequestChannel.id,
      defaultPingRoleId: pingRole.id,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: {
        eventAdminRoleId: eventAdminRole.id,
        defaultAttendanceChannelId: attendanceChannel.id,
        defaultRoleRequestChannelId: roleRequestChannel.id,
        defaultPingRoleId: pingRole.id,
        updatedAt: now,
      },
    });

  await interaction.editReply({
    content: [
      `✅ **${configuredGuild.name}** has been configured.`,
      "",
      `**Event admins:** <@&${eventAdminRole.id}>`,
      `**Attendance channel:** <#${attendanceChannel.id}>`,
      `**Role-request channel:** <#${roleRequestChannel.id}>`,
      `**Attendance ping:** <@&${pingRole.id}>`,
      "",
      "These are server defaults. Event templates may override them later.",
    ].join("\n"),
    allowedMentions: {
      parse: [],
    },
  });
}

async function showSetupStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const discordGuildId = interaction.guildId;

  if (!discordGuildId) {
    throw new Error("The setup command requires a Discord server.");
  }

  const [guild] = await db
    .select({
      id: discordGuilds.id,
      name: discordGuilds.name,
      timezone: discordGuilds.timezone,
      enabled: discordGuilds.enabled,
    })
    .from(discordGuilds)
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  if (!guild) {
    await interaction.editReply(
      "This server has not been configured. " +
        "Run `/setup initialise` first.",
    );

    return;
  }

  const [settings] = await db
    .select({
      eventAdminRoleId: guildSettings.eventAdminRoleId,
      attendanceChannelId: guildSettings.defaultAttendanceChannelId,
      roleRequestChannelId: guildSettings.defaultRoleRequestChannelId,
      pingRoleId: guildSettings.defaultPingRoleId,
    })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guild.id))
    .limit(1);

  const configuredEventTypes = await db
    .select({
      code: eventTypes.code,
      name: eventTypes.name,
      active: eventTypes.active,
    })
    .from(eventTypes)
    .where(eq(eventTypes.ownerGuildId, guild.id))
    .orderBy(asc(eventTypes.name));

  const eventTypeLines =
    configuredEventTypes.length > 0
      ? configuredEventTypes.map(
          (eventType) =>
            `• ${eventType.name} ` +
            `(\`${eventType.code}\`)` +
            `${eventType.active ? "" : " — disabled"}`,
        )
      : ["• None"];

  const hasCompleteDefaults = Boolean(
    settings?.eventAdminRoleId &&
    settings.attendanceChannelId &&
    settings.roleRequestChannelId &&
    settings.pingRoleId,
  );

  await interaction.editReply({
    content: [
      `**Server:** ${guild.name}`,
      `**Enabled:** ${guild.enabled ? "Yes" : "No"}`,
      `**Timezone:** ${guild.timezone}`,
      `**Default configuration:** ${
        hasCompleteDefaults ? "Complete" : "Incomplete"
      }`,
      "",
      "**Event administration:**",
      `• Admin role: ${
        settings?.eventAdminRoleId
          ? `<@&${settings.eventAdminRoleId}>`
          : "Not set"
      }`,
      `• Attendance channel: ${
        settings?.attendanceChannelId
          ? `<#${settings.attendanceChannelId}>`
          : "Not set"
      }`,
      `• Role-request channel: ${
        settings?.roleRequestChannelId
          ? `<#${settings.roleRequestChannelId}>`
          : "Not set"
      }`,
      `• Ping role: ${
        settings?.pingRoleId ? `<@&${settings.pingRoleId}>` : "Not set"
      }`,
      "",
      "**Event types:**",
      ...eventTypeLines,
    ].join("\n"),
    allowedMentions: {
      parse: [],
    },
  });
}
