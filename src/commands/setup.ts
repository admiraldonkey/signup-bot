import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventAudiences,
  eventTypes,
  guildSettings,
} from "../db/schema.js";
import {
  auditDeniedCommandAttempt,
  writeAuditLog,
} from "../audit/audit-log.js";

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

  if (subcommand === "regions") {
    await configureEventRegions(interaction);
    return;
  }

  if (subcommand === "logging") {
    await configureLogging(interaction);

    return;
  }

  if (subcommand === "logging-disable") {
    await disableLogging(interaction);

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
   * Existing required configuration.
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

  /*
   * New optional configuration.
   *
   * These remain optional so existing servers are not forced to
   * configure the organiser system immediately.
   */
  const selectedEventAdminChannel = interaction.options.getChannel(
    "event-admin-channel",
  );

  const selectedEventOrganiserRole = interaction.options.getRole(
    "event-organiser-role",
  );

  /*
   * Fetch the real Discord objects rather than relying only on
   * slash-command option data.
   */
  const [
    eventAdminRole,
    attendanceChannel,
    roleRequestChannel,
    eventAdminChannel,
    eventOrganiserRole,
    botMember,
  ] = await Promise.all([
    guild.roles.fetch(selectedAdminRole.id),

    guild.channels.fetch(selectedAttendanceChannel.id),

    guild.channels.fetch(selectedRoleRequestChannel.id),

    selectedEventAdminChannel
      ? guild.channels.fetch(selectedEventAdminChannel.id)
      : Promise.resolve(null),

    selectedEventOrganiserRole
      ? guild.roles.fetch(selectedEventOrganiserRole.id)
      : Promise.resolve(null),

    guild.members.fetchMe(),
  ]);

  const issues: string[] = [];

  /*
   * Required values must always resolve.
   */
  if (!eventAdminRole) {
    issues.push("The selected event-admin role could not be found.");
  }

  if (!attendanceChannel) {
    issues.push("The selected attendance channel could not be found.");
  }

  if (!roleRequestChannel) {
    issues.push("The selected role-request channel could not be found.");
  }

  /*
   * Optional values only become errors if the administrator
   * actually supplied the option but Discord could not resolve it.
   */
  if (selectedEventAdminChannel && !eventAdminChannel) {
    issues.push(
      "The selected event-administration channel could not be found.",
    );
  }

  if (selectedEventOrganiserRole && !eventOrganiserRole) {
    issues.push("The selected event-organiser role could not be found.");
  }

  if (issues.length > 0) {
    await interaction.editReply({
      content: [
        "❌ The configuration could not be saved:",
        "",
        ...issues.map((issue) => `• ${issue}`),
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  /*
   * This check primarily helps TypeScript. We already returned
   * above if any required Discord object was unavailable.
   */
  if (!eventAdminRole || !attendanceChannel || !roleRequestChannel) {
    throw new Error(
      "Discord configuration values unexpectedly became unavailable.",
    );
  }

  /*
   * Validate Event Admin role.
   */
  if (eventAdminRole.id === guild.id) {
    issues.push("The event-admin role cannot be the `@everyone` role.");
  }

  if (eventAdminRole.managed) {
    issues.push(
      "The event-admin role is managed by Discord or an integration " +
        "and is not suitable for bot administration.",
    );
  }

  /*
   * Validate optional Event Organiser role.
   *
   * It is perfectly valid for this to be the same role as the
   * Event Admin role if a server wants that arrangement.
   */
  if (eventOrganiserRole) {
    if (eventOrganiserRole.id === guild.id) {
      issues.push("The event-organiser role cannot be the `@everyone` role.");
    }

    if (eventOrganiserRole.managed) {
      issues.push(
        "The event-organiser role is managed by Discord or an integration " +
          "and is not suitable for organiser assignments.",
      );
    }
  }

  /*
   * Validate the existing public posting channels.
   */
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
   * The command definition only offers a normal text channel for
   * event administration. Keep this runtime validation as defence
   * in depth.
   */
  if (eventAdminChannel && !isSupportedPostingChannel(eventAdminChannel)) {
    issues.push("The event-administration destination must be a text channel.");
  }

  /*
   * Check the bot's effective permissions in all configured
   * destinations.
   */
  const channelsToCheck = [
    {
      channel: attendanceChannel,

      label: "attendance channel",
    },
    {
      channel: roleRequestChannel,

      label: "role-request channel",
    },
  ];

  if (eventAdminChannel) {
    channelsToCheck.push({
      channel: eventAdminChannel,

      label: "event-administration channel",
    });
  }

  for (const { channel, label } of channelsToCheck) {
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

  /*
   * The new organiser settings are optional.
   *
   * Using conditional object spreads here is important:
   *
   * - if supplied, save/update them;
   * - if omitted, leave an existing value untouched.
   *
   * That means someone can later run /setup configure merely to
   * change the attendance channel without accidentally deleting
   * the Event Administration channel.
   */
  await db
    .insert(guildSettings)
    .values({
      guildId: configuredGuild.id,

      eventAdminRoleId: eventAdminRole.id,

      defaultAttendanceChannelId: attendanceChannel.id,

      defaultRoleRequestChannelId: roleRequestChannel.id,

      ...(eventAdminChannel
        ? {
            eventAdminChannelId: eventAdminChannel.id,
          }
        : {}),

      ...(eventOrganiserRole
        ? {
            eventOrganiserRoleId: eventOrganiserRole.id,
          }
        : {}),

      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: guildSettings.guildId,

      set: {
        eventAdminRoleId: eventAdminRole.id,

        defaultAttendanceChannelId: attendanceChannel.id,

        defaultRoleRequestChannelId: roleRequestChannel.id,

        ...(eventAdminChannel
          ? {
              eventAdminChannelId: eventAdminChannel.id,
            }
          : {}),

        ...(eventOrganiserRole
          ? {
              eventOrganiserRoleId: eventOrganiserRole.id,
            }
          : {}),

        updatedAt: now,
      },
    });

  /*
   * Build the response dynamically because the two new options
   * are optional.
   */
  const responseLines = [
    `✅ **${configuredGuild.name}** has been configured.`,
    "",
    `**Event admins:** <@&${eventAdminRole.id}>`,
    `**Attendance channel:** <#${attendanceChannel.id}>`,
    `**Role-request channel:** <#${roleRequestChannel.id}>`,
  ];

  if (eventAdminChannel) {
    responseLines.push(
      `**Event administration channel:** <#${eventAdminChannel.id}>`,
    );
  }

  if (eventOrganiserRole) {
    responseLines.push(
      `**Event organiser role:** <@&${eventOrganiserRole.id}>`,
    );
  }

  if (!eventAdminChannel || !eventOrganiserRole) {
    responseLines.push(
      "",
      "Any organiser setting not supplied by this command was left unchanged.",
    );
  }

  responseLines.push(
    "",
    "Ping roles are selected separately for each event.",
    "These channels remain the server defaults and may later be overridden by event templates.",
  );

  await interaction.editReply({
    content: responseLines.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });

  await writeAuditLog({
    guildId: configuredGuild.id,

    guild,

    actorUserId: interaction.user.id,

    action: "setup.configure",

    outcome: "success",

    summary: "Updated the server's event-management configuration.",

    targetType: "guild",

    targetId: guild.id,

    details: {
      eventAdminRoleId: eventAdminRole.id,

      attendanceChannelId: attendanceChannel.id,

      roleRequestChannelId: roleRequestChannel.id,

      eventAdminChannelId: eventAdminChannel?.id,

      eventOrganiserRoleId: eventOrganiserRole?.id,
    },
  });
}

async function configureEventRegions(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const discordGuildId = interaction.guildId;

  if (!discordGuildId) {
    throw new Error("The setup regions command requires a Discord server.");
  }

  const [configuredGuild] = await db
    .select({
      id: discordGuilds.id,
      name: discordGuilds.name,
      timezone: discordGuilds.timezone,
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

  const audiences = [
    {
      code: "eu",
      name: "EU",
      defaultTimezone: "Europe/London",
    },
    {
      code: "na",
      name: "NA",
      defaultTimezone: "America/New_York",
    },
    {
      code: "global",
      // name: "EU & NA / Global",
      name: "EU & NA",
      defaultTimezone: configuredGuild.timezone,
    },
  ] as const;

  const now = new Date();

  await db.transaction(async (transaction) => {
    for (const audience of audiences) {
      await transaction
        .insert(eventAudiences)
        .values({
          ownerGuildId: configuredGuild.id,
          code: audience.code,
          name: audience.name,
          defaultTimezone: audience.defaultTimezone,
          active: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [eventAudiences.ownerGuildId, eventAudiences.code],
          set: {
            name: audience.name,
            defaultTimezone: audience.defaultTimezone,
            active: true,
            updatedAt: now,
          },
        });
    }
  });

  await interaction.editReply({
    content: [
      "✅ Event regions configured.",
      "",
      "**EU**",
      "Default timezone: `Europe/London`",
      "",
      "**NA**",
      "Default timezone: `America/New_York`",
      "",
      // "**EU & NA / Global**",
      "**EU & NA**",
      `Default timezone: \`${configuredGuild.timezone}\``,
      "",
      "Ping roles are selected separately when each event is created.",
      "Event admins can override the regional timezone for individual events.",
    ].join("\n"),
    allowedMentions: {
      parse: [],
    },
  });
  await writeAuditLog({
    guildId: configuredGuild.id,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "setup.regions",

    outcome: "success",

    summary: "Created or refreshed the configured event regions.",

    targetType: "guild",

    targetId: interaction.guildId,
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
      eventAdminChannelId: guildSettings.eventAdminChannelId,
      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,
      botLogChannelId: guildSettings.botLogChannelId,
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

  const configuredAudiences = await db
    .select({
      code: eventAudiences.code,
      name: eventAudiences.name,
      defaultTimezone: eventAudiences.defaultTimezone,
      active: eventAudiences.active,
    })
    .from(eventAudiences)
    .where(eq(eventAudiences.ownerGuildId, guild.id))
    .orderBy(asc(eventAudiences.name));

  const eventTypeLines =
    configuredEventTypes.length > 0
      ? configuredEventTypes.map(
          (eventType) =>
            `• ${eventType.name} ` +
            `(\`${eventType.code}\`)` +
            `${eventType.active ? "" : " — disabled"}`,
        )
      : ["• None"];

  const audienceLines =
    configuredAudiences.length > 0
      ? configuredAudiences.map(
          (audience) =>
            `• ${audience.name}: ` +
            `\`${audience.defaultTimezone}\`` +
            `${audience.active ? "" : " — disabled"}`,
        )
      : ["• Not configured; run `/setup regions`."];

  const hasCompleteDefaults = Boolean(
    settings?.eventAdminRoleId &&
    settings.attendanceChannelId &&
    settings.roleRequestChannelId,
  );

  const eventAdminChannelDisplay = settings?.eventAdminChannelId
    ? `<#${settings.eventAdminChannelId}>`
    : "Not configured";

  const eventOrganiserRoleDisplay = settings?.eventOrganiserRoleId
    ? `<@&${settings.eventOrganiserRoleId}>`
    : "Not configured";

  await interaction.editReply({
    content: [
      `**Server:** ${guild.name}`,
      `**Enabled:** ${guild.enabled ? "Yes" : "No"}`,
      `**Server timezone:** ${guild.timezone}`,
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
      `• Event organiser role: ${eventOrganiserRoleDisplay}`,
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
      `• Event administration channel: ${eventAdminChannelDisplay}`,
      `• Bot log channel: ${
        settings?.botLogChannelId
          ? `<#${settings.botLogChannelId}>`
          : "Disabled"
      }`,
      `• Ping roles: Selected per event`,
      "",
      "**Event regions:**",
      ...audienceLines,
      "",
      "**Event types:**",
      ...eventTypeLines,
    ].join("\n"),
    allowedMentions: {
      parse: [],
    },
  });
}

async function configureLogging(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;

  const discordGuildId = interaction.guildId;

  if (!guild || !discordGuildId) {
    throw new Error("The setup logging command requires a Discord server.");
  }

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

  const selectedChannel = interaction.options.getChannel("channel", true);

  const channel = await guild.channels.fetch(selectedChannel.id);

  if (!channel || !isSupportedPostingChannel(channel)) {
    await interaction.editReply(
      "The audit-log destination must be a text or announcement channel.",
    );

    return;
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  const missingPermissions = REQUIRED_POSTING_PERMISSIONS.filter(
    ({ permission }) => !permissions.has(permission),
  ).map(({ label }) => label);

  if (missingPermissions.length > 0) {
    await interaction.editReply(
      [
        "The audit-log channel could not be configured because the bot is missing:",
        "",
        ...missingPermissions.map((permission) => `• ${permission}`),
      ].join("\n"),
    );

    return;
  }

  const now = new Date();

  await db
    .update(guildSettings)
    .set({
      botLogChannelId: channel.id,

      updatedAt: now,
    })
    .where(eq(guildSettings.guildId, configuredGuild.id));

  await writeAuditLog({
    guildId: configuredGuild.id,

    guild,

    actorUserId: interaction.user.id,

    action: "setup.logging.configure",

    outcome: "success",

    summary: `Configured the bot audit-log channel as #${channel.name}.`,

    targetType: "channel",

    targetId: channel.id,
  });

  await interaction.editReply({
    content: [
      "✅ Audit logging configured.",
      "",
      `**Log channel:** <#${channel.id}>`,
      "",
      "Administrative changes will be stored in PostgreSQL and mirrored here.",
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

async function disableLogging(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;

  const discordGuildId = interaction.guildId;

  if (!guild || !discordGuildId) {
    throw new Error(
      "The setup logging-disable command requires a Discord server.",
    );
  }

  const [configuredGuild] = await db
    .select({
      id: discordGuilds.id,

      name: discordGuilds.name,

      logChannelId: guildSettings.botLogChannelId,
    })
    .from(discordGuilds)
    .leftJoin(guildSettings, eq(guildSettings.guildId, discordGuilds.id))
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  if (!configuredGuild) {
    await interaction.editReply("This server has not been initialised.");

    return;
  }

  if (!configuredGuild.logChannelId) {
    await interaction.editReply(
      "Discord audit-log mirroring is already disabled.",
    );

    return;
  }

  const previousLogChannelId = configuredGuild.logChannelId;

  await db
    .update(guildSettings)
    .set({
      botLogChannelId: null,

      updatedAt: new Date(),
    })
    .where(eq(guildSettings.guildId, configuredGuild.id));

  await writeAuditLog({
    guildId: configuredGuild.id,

    guild,

    actorUserId: interaction.user.id,

    action: "setup.logging.disable",

    outcome: "success",

    summary:
      "Disabled Discord audit-log mirroring. Database auditing remains enabled.",

    targetType: "channel",

    targetId: previousLogChannelId,

    /*
     * Send one final entry to the old log channel.
     */
    mirrorChannelId: previousLogChannelId,
  });

  await interaction.editReply(
    [
      "✅ Discord audit-log mirroring has been disabled.",
      "",
      "Audit entries will continue to be stored in PostgreSQL.",
    ].join("\n"),
  );
}
