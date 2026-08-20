import {
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type GuildMember,
  type Message,
  PermissionFlagsBits,
  type Role,
} from "discord.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  attendanceResponses,
  eventRoleOptionQualificationRoles,
  eventRoleOptions,
  eventTypes,
  events,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequests,
} from "../db/schema.js";
import {
  buildRoleRequestGroupMessagePayload,
  refreshRoleRequestGroupMessage,
} from "../role-requests/role-request-message.js";
import {
  markRoleRequestGroupCloseCompleted,
  scheduleRoleRequestGroupClose,
} from "../role-requests/role-request-scheduling.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

type RequestRestriction = "open" | "qualified_only";

type QualificationLevel = "qualified" | "supervision_required";

type QualificationState =
  | "unrestricted"
  | "qualified"
  | "supervision_required"
  | "unqualified"
  | "member_unavailable";

export async function addEventRoleOption(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedRoleRequestEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!event.roleRequestsEnabled) {
    await interaction.editReply(
      "Role requests are disabled for this event type.",
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Role options cannot be added to a cancelled or completed event.",
    );

    return;
  }

  const name = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const restrictionText =
    interaction.options.getString("restriction") ?? "open";

  if (restrictionText !== "open" && restrictionText !== "qualified_only") {
    await interaction.editReply("The role-request restriction is invalid.");

    return;
  }

  const restriction: RequestRestriction = restrictionText;

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
    await interaction.editReply(
      `**${overlappingRole.name}** cannot be both fully qualified and supervision-required for the same role option.`,
    );

    return;
  }

  const allQualificationRoles = [...qualifiedRoles, ...supervisedRoles];

  if (allQualificationRoles.some((role) => role.id === interaction.guild.id)) {
    await interaction.editReply(
      "`@everyone` cannot be used as a qualification role.",
    );

    return;
  }

  if (restriction === "qualified_only" && allQualificationRoles.length === 0) {
    await interaction.editReply(
      "A `Qualified only` request must have at least one configured qualification role.",
    );

    return;
  }

  const key = makeRoleKey(name);

  const [existing] = await db
    .select({
      id: eventRoleOptions.id,
    })
    .from(eventRoleOptions)
    .where(
      and(
        eq(eventRoleOptions.eventId, event.id),

        eq(eventRoleOptions.key, key),
      ),
    )
    .limit(1);

  if (existing) {
    await interaction.editReply(
      `This event already has a role option with the key \`${key}\`. Choose a more distinct name.`,
    );

    return;
  }

  const [sortRow] = await db
    .select({
      maximum: sql<number>`coalesce(max(${eventRoleOptions.sortOrder}), -1)::int`,
    })
    .from(eventRoleOptions)
    .where(eq(eventRoleOptions.eventId, event.id));

  const sortOrder = (sortRow?.maximum ?? -1) + 1;

  const created = await db.transaction(async (transaction) => {
    const [option] = await transaction
      .insert(eventRoleOptions)
      .values({
        eventId: event.id,

        sourceTemplateRoleOptionId: null,

        key,

        displayName: name,

        description,

        requestRestriction: restriction,

        capacity: null,

        sortOrder,

        active: true,

        updatedAt: new Date(),
      })
      .returning({
        id: eventRoleOptions.id,
      });

    if (!option) {
      throw new Error("The database did not return the created role option.");
    }

    const qualificationValues = [
      ...qualifiedRoles.map((role) => ({
        eventRoleOptionId: option.id,

        discordRoleId: role.id,

        roleNameSnapshot: role.name,

        qualificationLevel: "qualified" as const,
      })),

      ...supervisedRoles.map((role) => ({
        eventRoleOptionId: option.id,

        discordRoleId: role.id,

        roleNameSnapshot: role.name,

        qualificationLevel: "supervision_required" as const,
      })),
    ];

    if (qualificationValues.length > 0) {
      await transaction
        .insert(eventRoleOptionQualificationRoles)
        .values(qualificationValues);
    }

    return option;
  });

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.role_option.add",

    outcome: "success",

    summary: `Added role option "${name}" (#${created.id}) to "${event.name}" (#${event.id}).`,

    targetType: "event_role_option",

    targetId: String(created.id),

    details: {
      eventId: event.id,

      key,

      requestRestriction: restriction,

      qualifiedRoleIds: qualifiedRoles.map((role) => role.id),

      supervisedRoleIds: supervisedRoles.map((role) => role.id),
    },
  });

  await interaction.editReply({
    content: [
      `✅ Added **${name}** to **${event.name}**.`,
      "",
      `**Role option ID:** ${created.id}`,
      `**Key:** \`${key}\``,
      `**Request restriction:** ${
        restriction === "qualified_only" ? "Qualified only" : "Open"
      }`,
      `**Fully qualified roles:** ${
        qualifiedRoles.length > 0
          ? qualifiedRoles.map((role) => `<@&${role.id}>`).join(", ")
          : "None configured"
      }`,
      `**Supervisor-required roles:** ${
        supervisedRoles.length > 0
          ? supervisedRoles.map((role) => `<@&${role.id}>`).join(", ")
          : "None configured"
      }`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function listEventRoleOptions(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedRoleRequestEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const options = await db
    .select({
      id: eventRoleOptions.id,

      key: eventRoleOptions.key,

      displayName: eventRoleOptions.displayName,

      requestRestriction: eventRoleOptions.requestRestriction,

      sortOrder: eventRoleOptions.sortOrder,

      active: eventRoleOptions.active,
    })
    .from(eventRoleOptions)
    .where(eq(eventRoleOptions.eventId, event.id))
    .orderBy(asc(eventRoleOptions.sortOrder), asc(eventRoleOptions.id));

  if (options.length === 0) {
    await interaction.editReply(
      `No role options have been configured for **${event.name}**.`,
    );

    return;
  }

  const qualificationRows = await db
    .select({
      optionId: eventRoleOptionQualificationRoles.eventRoleOptionId,

      roleId: eventRoleOptionQualificationRoles.discordRoleId,

      level: eventRoleOptionQualificationRoles.qualificationLevel,
    })
    .from(eventRoleOptionQualificationRoles)
    .where(
      inArray(
        eventRoleOptionQualificationRoles.eventRoleOptionId,
        options.map((option) => option.id),
      ),
    );

  const lines = options.map((option) => {
    const qualified = qualificationRows
      .filter((row) => row.optionId === option.id && row.level === "qualified")
      .map((row) => `<@&${row.roleId}>`);

    const supervised = qualificationRows
      .filter(
        (row) =>
          row.optionId === option.id && row.level === "supervision_required",
      )
      .map((row) => `<@&${row.roleId}>`);

    return [
      `**#${option.id} — ${option.displayName}**${
        option.active ? "" : " — disabled"
      }`,
      `Key: \`${option.key}\``,
      `Requests: ${
        option.requestRestriction === "qualified_only"
          ? "Qualified only"
          : "Open"
      }`,
      `Qualified: ${
        qualified.length > 0 ? qualified.join(", ") : "None configured"
      }`,
      `Supervisor required: ${
        supervised.length > 0 ? supervised.join(", ") : "None configured"
      }`,
    ].join("\n");
  });

  await interaction.editReply({
    content: [
      `**Role options — ${event.name} (#${event.id})**`,
      "",
      ...lines,
    ].join("\n\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function postRoleRequestGroup(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedRoleRequestEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!event.roleRequestsEnabled) {
    await interaction.editReply(
      "Role requests are disabled for this event type.",
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Role-request groups cannot be posted for a cancelled or completed event.",
    );

    return;
  }

  const name = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const roleOptionIds = [
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

  const uniqueOptionIds = [...new Set(roleOptionIds)];

  const options = await db
    .select({
      id: eventRoleOptions.id,

      displayName: eventRoleOptions.displayName,
    })
    .from(eventRoleOptions)
    .where(
      and(
        eq(eventRoleOptions.eventId, event.id),

        eq(eventRoleOptions.active, true),

        inArray(eventRoleOptions.id, uniqueOptionIds),
      ),
    );

  if (options.length !== uniqueOptionIds.length) {
    await interaction.editReply(
      "One or more supplied role-option IDs do not belong to this event or are inactive. Use `/event role-option-list` first.",
    );

    return;
  }

  /*
   * Preserve the administrator's requested button order rather
   * than whatever order PostgreSQL happened to return.
   */
  const optionById = new Map(options.map((option) => [option.id, option]));

  const orderedOptions = uniqueOptionIds
    .map((id) => optionById.get(id))
    .filter(
      (option): option is (typeof options)[number] => option !== undefined,
    );

  /*
   * Unpublished events cannot yet have normal public signups, so
   * early request groups default to not requiring one.
   *
   * Once published, signup-enabled events retain the existing default.
   */
  const requiresPositiveSignup =
    interaction.options.getBoolean("requires-signup") ??
    (event.signupsEnabled && event.publishedAt !== null);

  if (requiresPositiveSignup && !event.signupsEnabled) {
    await interaction.editReply(
      "This event does not use attendance signups, so this role-request group cannot require an Attending/Tentative signup.",
    );

    return;
  }

  const closeMinutesBeforeOption = interaction.options.getInteger(
    "close-minutes-before-start",
  );

  const closeMinutesAfterOption = interaction.options.getInteger(
    "close-minutes-after-start",
  );

  if (closeMinutesBeforeOption !== null && closeMinutesAfterOption !== null) {
    await interaction.editReply(
      "Choose either `close-minutes-before-start` or `close-minutes-after-start`, not both.",
    );

    return;
  }

  /*
   * The stored offset is signed:
   *
   *  10 = ten minutes before start
   *   0 = at start
   * -10 = ten minutes after start
   */
  const closeMinutesBeforeStart =
    closeMinutesBeforeOption ??
    (closeMinutesAfterOption !== null ? -closeMinutesAfterOption : 0);

  const closesAt = new Date(
    event.startsAt.getTime() - closeMinutesBeforeStart * 60_000,
  );

  if (closesAt <= new Date()) {
    await interaction.editReply(
      "The calculated role-request closing time has already passed.",
    );

    return;
  }

  const selectedChannel = interaction.options.getChannel("channel");

  const channelId = selectedChannel?.id ?? context.roleRequestChannelId;

  if (!channelId) {
    await interaction.editReply(
      "No role-request channel is configured for this server.",
    );

    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isSendable()
  ) {
    await interaction.editReply(
      "The selected role-request channel is unavailable.",
    );

    return;
  }

  const botMember =
    interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  if (requiredPermissions.some((permission) => !permissions.has(permission))) {
    await interaction.editReply(
      "The bot does not have all required posting permissions in that role-request channel.",
    );

    return;
  }

  const notifyRole = interaction.options.getRole("notify-role");

  if (notifyRole?.id === interaction.guild.id) {
    await interaction.editReply(
      "`@everyone` cannot be used as the role-request notification role.",
    );

    return;
  }

  if (
    notifyRole &&
    !notifyRole.mentionable &&
    !permissions.has(PermissionFlagsBits.MentionEveryone)
  ) {
    await interaction.editReply(
      `The bot cannot mention **${notifyRole.name}** in that channel.`,
    );

    return;
  }

  const now = new Date();

  const group = await db.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(roleRequestGroups)
      .values({
        eventId: event.id,

        name,

        description,

        channelId: channel.id,

        messageId: null,

        requiresPositiveSignup,

        opensAt: now,

        closeMinutesBeforeStart,

        closesAt,

        closedAt: null,

        createdByUserId: interaction.user.id,

        updatedAt: now,
      })
      .returning({
        id: roleRequestGroups.id,
      });

    if (!created) {
      throw new Error(
        "The database did not return the created role-request group.",
      );
    }

    await transaction.insert(roleRequestGroupOptions).values(
      orderedOptions.map((option, index) => ({
        groupId: created.id,

        eventRoleOptionId: option.id,

        sortOrder: index,
      })),
    );

    return created;
  });

  let sentMessage: Message | null = null;

  try {
    const payload = await buildRoleRequestGroupMessagePayload(group.id);

    sentMessage = await channel.send({
      content: notifyRole ? `<@&${notifyRole.id}>` : undefined,

      ...payload,

      allowedMentions: {
        parse: [],

        roles: notifyRole ? [notifyRole.id] : [],
      },
    });

    await db
      .update(roleRequestGroups)
      .set({
        messageId: sentMessage.id,

        updatedAt: new Date(),
      })
      .where(eq(roleRequestGroups.id, group.id));

    await scheduleRoleRequestGroupClose(event.id, group.id, closesAt);
  } catch (error) {
    if (sentMessage) {
      await sentMessage.delete().catch(() => {
        // Preserve the original failure.
      });
    }

    await db
      .delete(roleRequestGroups)
      .where(eq(roleRequestGroups.id, group.id))
      .catch(() => {
        // Preserve the original failure.
      });

    throw error;
  }

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.role_group.post",

    outcome: "success",

    summary: `Posted role-request group "${name}" (#${group.id}) for "${event.name}" (#${event.id}).`,

    targetType: "role_request_group",

    targetId: String(group.id),

    details: {
      eventId: event.id,

      channelId: channel.id,

      roleOptionIds: orderedOptions.map((option) => option.id),

      requiresPositiveSignup,

      closeOffsetMinutes: closeMinutesBeforeStart,

      closesAt: closesAt.toISOString(),
    },
  });

  const closeTimestamp = Math.floor(closesAt.getTime() / 1000);

  await interaction.editReply({
    content: [
      `✅ **${name}** has been posted for **${event.name}**.`,
      "",
      `**Request group ID:** ${group.id}`,
      `**Channel:** <#${channel.id}>`,
      `**Roles:** ${orderedOptions
        .map((option) => `${option.displayName} (#${option.id})`)
        .join(", ")}`,
      `**Requires Attending/Tentative signup:** ${
        requiresPositiveSignup ? "Yes" : "No"
      }`,
      `**Close rule:** ${formatRoleRequestCloseOffset(
        closeMinutesBeforeStart,
      )}`,
      `**Closes:** <t:${closeTimestamp}:F> (<t:${closeTimestamp}:R>)`,
      `**Message:** ${sentMessage.url}`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function listRoleRequestGroups(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedRoleRequestEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const groups = await db
    .select({
      id: roleRequestGroups.id,

      name: roleRequestGroups.name,

      channelId: roleRequestGroups.channelId,

      requiresPositiveSignup: roleRequestGroups.requiresPositiveSignup,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closeMinutesBeforeStart: roleRequestGroups.closeMinutesBeforeStart,

      closedAt: roleRequestGroups.closedAt,

      messageId: roleRequestGroups.messageId,
    })
    .from(roleRequestGroups)
    .where(eq(roleRequestGroups.eventId, event.id))
    .orderBy(asc(roleRequestGroups.id));

  if (groups.length === 0) {
    await interaction.editReply(
      `No role-request groups exist for **${event.name}**.`,
    );

    return;
  }

  const now = new Date();

  const lines = groups.map((group) => {
    const closeTimestamp = Math.floor(group.closesAt.getTime() / 1000);

    const status = group.closedAt || group.closesAt <= now ? "Closed" : "Open";

    return [
      `**#${group.id} — ${group.name}**`,
      `${status} • <#${group.channelId}>`,
      `Signup required: ${group.requiresPositiveSignup ? "Yes" : "No"}`,
      `Close rule: ${formatRoleRequestCloseOffset(
        group.closeMinutesBeforeStart,
      )}`,
      `Closes: <t:${closeTimestamp}:F>`,
    ].join("\n");
  });

  await interaction.editReply({
    content: [
      `**Role-request groups — ${event.name} (#${event.id})**`,
      "",
      ...lines,
    ].join("\n\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function closeRoleRequestGroup(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const groupId = interaction.options.getInteger("group-id", true);

  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      name: roleRequestGroups.name,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        eq(events.ownerGuildId, context.guildId),
      ),
    )
    .limit(1);

  if (!group) {
    await interaction.editReply(
      `Role-request group #${groupId} was not found in this server.`,
    );

    return;
  }

  if (group.closedAt) {
    await interaction.editReply(
      `Role-request group #${group.id} is already closed.`,
    );

    return;
  }

  const now = new Date();

  await db
    .update(roleRequestGroups)
    .set({
      closedAt: now,

      updatedAt: now,
    })
    .where(eq(roleRequestGroups.id, group.id));

  await markRoleRequestGroupCloseCompleted(group.eventId, group.id, now);

  await refreshRoleRequestGroupMessage(interaction.guild, group.id);

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.role_group.close",

    outcome: "success",

    summary: `Closed role-request group "${group.name}" (#${group.id}) for "${group.eventName}" (#${group.eventId}).`,

    targetType: "role_request_group",

    targetId: String(group.id),
  });

  await interaction.editReply(
    `🔒 **${group.name}** is now closed for new role requests.`,
  );
}

export async function showEventRoleRequests(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getRoleRequestContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedRoleRequestEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const options = await db
    .select({
      id: eventRoleOptions.id,

      name: eventRoleOptions.displayName,

      restriction: eventRoleOptions.requestRestriction,

      sortOrder: eventRoleOptions.sortOrder,
    })
    .from(eventRoleOptions)
    .where(
      and(
        eq(eventRoleOptions.eventId, event.id),

        eq(eventRoleOptions.active, true),
      ),
    )
    .orderBy(asc(eventRoleOptions.sortOrder), asc(eventRoleOptions.id));

  if (options.length === 0) {
    await interaction.editReply(
      `No role options are configured for **${event.name}**.`,
    );

    return;
  }

  const optionIds = options.map((option) => option.id);

  const qualificationRows = await db
    .select({
      optionId: eventRoleOptionQualificationRoles.eventRoleOptionId,

      roleId: eventRoleOptionQualificationRoles.discordRoleId,

      level: eventRoleOptionQualificationRoles.qualificationLevel,
    })
    .from(eventRoleOptionQualificationRoles)
    .where(
      inArray(eventRoleOptionQualificationRoles.eventRoleOptionId, optionIds),
    );

  const requestRows = await db
    .select({
      optionId: roleRequests.eventRoleOptionId,

      userId: roleRequests.discordUserId,

      createdAt: roleRequests.createdAt,
    })
    .from(roleRequests)
    .where(eq(roleRequests.eventId, event.id))
    .orderBy(asc(roleRequests.createdAt), asc(roleRequests.id));

  const signupRows = event.signupsEnabled
    ? await db
        .select({
          userId: attendanceResponses.discordUserId,

          status: attendanceResponses.status,
        })
        .from(attendanceResponses)
        .where(eq(attendanceResponses.eventId, event.id))
    : [];

  const signupByUserId = new Map(
    signupRows.map((signup) => [signup.userId, signup.status]),
  );

  const positiveSignupRows = signupRows.filter(
    (signup) => signup.status === "attending" || signup.status === "tentative",
  );

  const candidateUserIds = new Set<string>([
    ...requestRows.map((row) => row.userId),

    ...positiveSignupRows.map((row) => row.userId),
  ]);

  const memberByUserId = new Map<string, GuildMember | null>();

  await Promise.all(
    [...candidateUserIds].map(async (userId) => {
      const cached = interaction.guild.members.cache.get(userId);

      if (cached) {
        memberByUserId.set(userId, cached);

        return;
      }

      try {
        memberByUserId.set(
          userId,
          await interaction.guild.members.fetch(userId),
        );
      } catch {
        memberByUserId.set(userId, null);
      }
    }),
  );

  const requestCountByUser = new Map<string, number>();

  for (const request of requestRows) {
    requestCountByUser.set(
      request.userId,
      (requestCountByUser.get(request.userId) ?? 0) + 1,
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`Role requests — ${event.name}`)
    .setDescription(
      [
        `Event ID: **#${event.id}**`,
        "",
        "Requests are listed in the order they were first submitted.",
        "`(n)` beside a member means they have requested `n` other roles for this event.",
        "A request is retained if someone later changes to Not Attending, but is shown as unavailable.",
      ].join("\n"),
    )
    .setFooter({
      text: event.signupsEnabled
        ? "Other eligible members are limited to current Attending/Tentative signups."
        : "This event does not use attendance signups, so no fallback attendee pool is shown.",
    })
    .setTimestamp();

  for (const option of options.slice(0, 25)) {
    const rules = qualificationRows.filter((row) => row.optionId === option.id);

    const optionRequests = requestRows.filter(
      (row) => row.optionId === option.id,
    );

    const requesterIds = new Set(optionRequests.map((row) => row.userId));

    const availableRequests = optionRequests.filter(
      (request) =>
        !event.signupsEnabled ||
        signupByUserId.get(request.userId) !== "not_attending",
    );

    const unavailableRequests = optionRequests.filter(
      (request) =>
        event.signupsEnabled &&
        signupByUserId.get(request.userId) === "not_attending",
    );

    const requestedLines = availableRequests.map((request, index) => {
      const member = memberByUserId.get(request.userId) ?? null;

      const qualification = assessQualification(member, rules);

      const totalRequestCount = requestCountByUser.get(request.userId) ?? 1;

      const otherRequestCount = Math.max(totalRequestCount - 1, 0);

      const signupStatus = signupByUserId.get(request.userId) ?? null;

      return [
        `${index + 1}. <@${request.userId}>`,
        otherRequestCount > 0 ? ` (${otherRequestCount})` : "",
        formatSignupMarker(event.signupsEnabled, signupStatus),
        formatQualificationMarker(qualification),
      ].join("");
    });

    const unavailableLines = unavailableRequests.map((request) => {
      const member = memberByUserId.get(request.userId) ?? null;

      const qualification = assessQualification(member, rules);

      const totalRequestCount = requestCountByUser.get(request.userId) ?? 1;

      const otherRequestCount = Math.max(totalRequestCount - 1, 0);

      return [
        `• <@${request.userId}>`,
        otherRequestCount > 0 ? ` (${otherRequestCount})` : "",
        " 🚫 Not attending",
        formatQualificationMarker(qualification),
      ].join("");
    });

    const eligibleFallback =
      event.signupsEnabled && rules.length > 0
        ? positiveSignupRows
            .filter((signup) => !requesterIds.has(signup.userId))
            .map((signup) => {
              const member = memberByUserId.get(signup.userId) ?? null;

              const qualification = assessQualification(member, rules);

              return {
                userId: signup.userId,

                signupStatus: signup.status,

                member,

                qualification,
              };
            })
            .filter(
              (candidate) =>
                candidate.qualification === "qualified" ||
                candidate.qualification === "supervision_required",
            )
            .sort((a, b) =>
              (a.member?.displayName ?? a.userId).localeCompare(
                b.member?.displayName ?? b.userId,
              ),
            )
        : [];

    const eligibleLines = eligibleFallback.map((candidate) => {
      const otherRequestCount = requestCountByUser.get(candidate.userId) ?? 0;

      return [
        `• <@${candidate.userId}>`,
        otherRequestCount > 0 ? ` (${otherRequestCount})` : "",
        formatSignupMarker(true, candidate.signupStatus),
        formatQualificationMarker(candidate.qualification),
      ].join("");
    });

    const valueParts = [
      "**Available requests:**",
      requestedLines.length > 0 ? requestedLines.join("\n") : "None",
    ];

    if (unavailableLines.length > 0) {
      valueParts.push(
        "",
        "**Currently unavailable:**",
        unavailableLines.join("\n"),
      );
    }

    if (event.signupsEnabled && rules.length > 0) {
      valueParts.push(
        "",
        "**Other eligible signed-up members:**",
        eligibleLines.length > 0 ? eligibleLines.join("\n") : "None",
      );
    }

    embed.addFields({
      name:
        `${option.name} — ` +
        `${availableRequests.length} available` +
        (unavailableRequests.length > 0
          ? ` • ${unavailableRequests.length} unavailable`
          : ""),

      value: truncateEmbedField(valueParts.join("\n")),

      inline: false,
    });
  }

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}

async function getRoleRequestContext(interaction: CachedInteraction) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return null;
  }

  if (!configuration.enabled) {
    await interaction.editReply(
      "Event management is currently disabled for this server.",
    );

    return null;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await interaction.editReply(
      "You need the configured Event Admin role or the Manage Server permission.",
    );

    return null;
  }

  return configuration;
}

async function findOwnedRoleRequestEvent(
  guildDatabaseId: number,
  eventId: number,
) {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      startsAt: events.startsAt,

      status: events.status,

      publishedAt: events.publishedAt,

      signupsEnabled: events.signupsEnabled,

      roleRequestsEnabled: eventTypes.roleRequestsEnabled,
    })
    .from(events)
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .where(
      and(
        eq(events.id, eventId),

        eq(events.ownerGuildId, guildDatabaseId),
      ),
    )
    .limit(1);

  return event ?? null;
}

function getSelectedRoles(
  interaction: CachedInteraction,
  names: readonly string[],
): Role[] {
  const roles = names
    .map((name) => interaction.options.getRole(name))
    .filter((role): role is Role => role !== null);

  return [...new Map(roles.map((role) => [role.id, role])).values()];
}

function makeRoleKey(name: string): string {
  const normalised = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return normalised || `role-${Date.now()}`;
}

function assessQualification(
  member: GuildMember | null,
  rules: {
    roleId: string;

    level: string;
  }[],
): QualificationState {
  if (rules.length === 0) {
    return "unrestricted";
  }

  if (!member) {
    return "member_unavailable";
  }

  if (
    rules.some(
      (rule) =>
        rule.level === "qualified" && member.roles.cache.has(rule.roleId),
    )
  ) {
    return "qualified";
  }

  if (
    rules.some(
      (rule) =>
        rule.level === "supervision_required" &&
        member.roles.cache.has(rule.roleId),
    )
  ) {
    return "supervision_required";
  }

  return "unqualified";
}

function formatQualificationMarker(state: QualificationState): string {
  switch (state) {
    case "qualified":
      return " ✅ Qualified";

    case "supervision_required":
      return " 🟡 Supervisor required";

    case "unqualified":
      return " ⚠️ Not currently qualified";

    case "member_unavailable":
      return " ⚪ Member unavailable";

    case "unrestricted":
      return "";
  }
}

function formatSignupMarker(
  signupsEnabled: boolean,
  status: "attending" | "tentative" | "not_attending" | null,
): string {
  if (!signupsEnabled) {
    return "";
  }

  switch (status) {
    case "attending":
      return " ✅ Attending";

    case "tentative":
      return " ❔ Tentative";

    case "not_attending":
      return " 🚫 Not attending";

    case null:
      return " ⚪ No signup";
  }
}

function formatRoleRequestCloseOffset(offsetMinutes: number): string {
  if (offsetMinutes > 0) {
    return `${offsetMinutes} minute(s) before event start`;
  }

  if (offsetMinutes < 0) {
    return `${Math.abs(offsetMinutes)} minute(s) after event start`;
  }

  return "At event start";
}

function truncateEmbedField(value: string): string {
  if (value.length <= 1024) {
    return value;
  }

  return `${value.slice(0, 1010)}\n…`;
}
