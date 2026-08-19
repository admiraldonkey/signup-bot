import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  MessageFlags,
} from "discord.js";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  attendanceResponses,
  discordGuilds,
  eventRoleOptionQualificationRoles,
  eventRoleOptions,
  events,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequests,
} from "../db/schema.js";
import {
  buildRoleRequestWithdrawCustomId,
  refreshRoleRequestMessages,
} from "../role-requests/role-request-message.js";

type ParsedRoleRequestInteraction =
  | {
      kind: "add";
      groupId: number;
      optionId: number;
    }
  | {
      kind: "manage";
      eventId: number;
    }
  | {
      kind: "withdraw";
      eventId: number;
      optionId: number;
    };

export async function handleRoleRequestButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseRoleRequestCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  switch (parsed.kind) {
    case "add":
      await handleAddRequest(interaction, parsed.groupId, parsed.optionId);
      return true;

    case "manage":
      await handleManageRequests(interaction, parsed.eventId);
      return true;

    case "withdraw":
      await handleWithdrawRequest(interaction, parsed.eventId, parsed.optionId);
      return true;
  }
}

async function handleAddRequest(
  interaction: ButtonInteraction,
  groupId: number,
  optionId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be submitted inside the event's Discord server.",
    );

    return;
  }

  const [context] = await db
    .select({
      groupId: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      channelId: roleRequestGroups.channelId,

      messageId: roleRequestGroups.messageId,

      requiresPositiveSignup: roleRequestGroups.requiresPositiveSignup,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,

      eventStartsAt: events.startsAt,

      eventStatus: events.status,

      discordGuildId: discordGuilds.discordGuildId,

      optionId: eventRoleOptions.id,

      optionName: eventRoleOptions.displayName,

      requestRestriction: eventRoleOptions.requestRestriction,
    })
    .from(roleRequestGroupOptions)
    .innerJoin(
      roleRequestGroups,
      eq(roleRequestGroups.id, roleRequestGroupOptions.groupId),
    )
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequestGroupOptions.eventRoleOptionId),
    )
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        eq(eventRoleOptions.id, optionId),

        eq(eventRoleOptions.active, true),
      ),
    )
    .limit(1);

  if (!context || context.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This role request is no longer available.");

    return;
  }

  if (
    context.messageId !== interaction.message.id ||
    context.channelId !== interaction.channelId
  ) {
    await interaction.editReply(
      "This button does not belong to the current role-request message.",
    );

    return;
  }

  const now = new Date();

  if (
    context.eventStatus === "cancelled" ||
    context.eventStatus === "completed" ||
    context.eventStartsAt <= now
  ) {
    await interaction.editReply(
      "This event is no longer accepting role requests.",
    );

    return;
  }

  if (context.closedAt || context.opensAt > now || context.closesAt <= now) {
    await interaction.editReply(
      "New requests through this role-request group are closed.",
    );

    return;
  }

  if (context.requiresPositiveSignup) {
    const [signup] = await db
      .select({
        status: attendanceResponses.status,
      })
      .from(attendanceResponses)
      .where(
        and(
          eq(attendanceResponses.eventId, context.eventId),

          eq(attendanceResponses.discordUserId, interaction.user.id),
        ),
      )
      .limit(1);

    if (
      !signup ||
      (signup.status !== "attending" && signup.status !== "tentative")
    ) {
      await interaction.editReply(
        "You need to be signed **Attending** or **Tentative** before requesting roles through this message.",
      );

      return;
    }
  }

  if (context.requestRestriction === "qualified_only") {
    const qualificationRoles = await db
      .select({
        discordRoleId: eventRoleOptionQualificationRoles.discordRoleId,
      })
      .from(eventRoleOptionQualificationRoles)
      .where(
        eq(
          eventRoleOptionQualificationRoles.eventRoleOptionId,
          context.optionId,
        ),
      );

    if (
      qualificationRoles.length === 0 ||
      !qualificationRoles.some((qualification) =>
        interaction.member.roles.cache.has(qualification.discordRoleId),
      )
    ) {
      await interaction.editReply(
        `You do not currently hold a configured qualification role for **${context.optionName}**.`,
      );

      return;
    }
  }

  const nowForInsert = new Date();

  const [created] = await db
    .insert(roleRequests)
    .values({
      eventId: context.eventId,

      discordUserId: interaction.user.id,

      eventRoleOptionId: context.optionId,

      sourceGroupId: context.groupId,

      updatedAt: nowForInsert,
    })
    .onConflictDoNothing()
    .returning({
      id: roleRequests.id,
    });

  if (!created) {
    await interaction.editReply(
      `ℹ️ You are already registered as willing to perform **${context.optionName}**. No changes were made.`,
    );

    return;
  }

  await refreshRoleRequestMessages(interaction.guild, context.eventId);

  await interaction.editReply(
    `✅ You are now listed as willing to perform **${context.optionName}** for **${context.eventName}**.`,
  );
}

async function handleManageRequests(
  interaction: ButtonInteraction,
  eventId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be managed inside the event's Discord server.",
    );

    return;
  }

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      startsAt: events.startsAt,

      status: events.status,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This event is no longer available.");

    return;
  }

  if (
    event.status === "cancelled" ||
    event.status === "completed" ||
    event.startsAt <= new Date()
  ) {
    await interaction.editReply(
      "Role requests for this event can no longer be changed.",
    );

    return;
  }

  const requests = await db
    .select({
      optionId: roleRequests.eventRoleOptionId,

      optionName: eventRoleOptions.displayName,

      createdAt: roleRequests.createdAt,
    })
    .from(roleRequests)
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequests.eventRoleOptionId),
    )
    .where(
      and(
        eq(roleRequests.eventId, event.id),

        eq(roleRequests.discordUserId, interaction.user.id),
      ),
    )
    .orderBy(asc(roleRequests.createdAt), asc(roleRequests.id));

  if (requests.length === 0) {
    await interaction.editReply(
      `You currently have no role requests for **${event.name}**.`,
    );

    return;
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < Math.min(requests.length, 20); index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();

    for (const request of requests.slice(index, index + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildRoleRequestWithdrawCustomId(event.id, request.optionId),
          )
          .setLabel(`Withdraw: ${request.optionName}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
      );
    }

    rows.push(row);
  }

  await interaction.editReply({
    content: [
      `**Your requests — ${event.name}**`,
      "",
      ...requests.map((request) => `• ${request.optionName}`),
      "",
      "Use a button below only if you want to withdraw that request.",
    ].join("\n"),

    components: rows,

    allowedMentions: {
      parse: [],
    },
  });
}

async function handleWithdrawRequest(
  interaction: ButtonInteraction,
  eventId: number,
  optionId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be changed inside the event's Discord server.",
    );

    return;
  }

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      startsAt: events.startsAt,

      status: events.status,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This event is no longer available.");

    return;
  }

  if (
    event.status === "cancelled" ||
    event.status === "completed" ||
    event.startsAt <= new Date()
  ) {
    await interaction.editReply(
      "Role requests for this event can no longer be changed.",
    );

    return;
  }

  const [option] = await db
    .select({
      name: eventRoleOptions.displayName,
    })
    .from(eventRoleOptions)
    .where(
      and(
        eq(eventRoleOptions.id, optionId),

        eq(eventRoleOptions.eventId, event.id),
      ),
    )
    .limit(1);

  if (!option) {
    await interaction.editReply("That role option no longer exists.");

    return;
  }

  const deleted = await db
    .delete(roleRequests)
    .where(
      and(
        eq(roleRequests.eventId, event.id),

        eq(roleRequests.discordUserId, interaction.user.id),

        eq(roleRequests.eventRoleOptionId, optionId),
      ),
    )
    .returning({
      id: roleRequests.id,
    });

  if (deleted.length === 0) {
    await interaction.editReply(
      `You were not currently requesting **${option.name}**.`,
    );

    return;
  }

  await refreshRoleRequestMessages(interaction.guild, event.id);

  await interaction.editReply(
    `✅ Your **${option.name}** request for **${event.name}** has been withdrawn.`,
  );
}

function parseRoleRequestCustomId(
  customId: string,
): ParsedRoleRequestInteraction | null {
  let match = /^role-request:add:(\d+):(\d+)$/.exec(customId);

  if (match) {
    const groupId = Number(match[1]);
    const optionId = Number(match[2]);

    if (
      Number.isSafeInteger(groupId) &&
      groupId > 0 &&
      Number.isSafeInteger(optionId) &&
      optionId > 0
    ) {
      return {
        kind: "add",
        groupId,
        optionId,
      };
    }
  }

  match = /^role-request:manage:(\d+)$/.exec(customId);

  if (match) {
    const eventId = Number(match[1]);

    if (Number.isSafeInteger(eventId) && eventId > 0) {
      return {
        kind: "manage",
        eventId,
      };
    }
  }

  match = /^role-request:withdraw:(\d+):(\d+)$/.exec(customId);

  if (match) {
    const eventId = Number(match[1]);
    const optionId = Number(match[2]);

    if (
      Number.isSafeInteger(eventId) &&
      eventId > 0 &&
      Number.isSafeInteger(optionId) &&
      optionId > 0
    ) {
      return {
        kind: "withdraw",
        eventId,
        optionId,
      };
    }
  }

  return null;
}
