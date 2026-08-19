import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Guild,
} from "discord.js";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  eventRoleOptions,
  events,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequests,
} from "../db/schema.js";

export function buildRoleRequestAddCustomId(
  groupId: number,
  optionId: number,
): string {
  return `role-request:add:${groupId}:${optionId}`;
}

export function buildRoleRequestManageCustomId(eventId: number): string {
  return `role-request:manage:${eventId}`;
}

export function buildRoleRequestWithdrawCustomId(
  eventId: number,
  optionId: number,
): string {
  return `role-request:withdraw:${eventId}:${optionId}`;
}

export async function buildRoleRequestGroupMessagePayload(groupId: number) {
  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      name: roleRequestGroups.name,

      description: roleRequestGroups.description,

      requiresPositiveSignup: roleRequestGroups.requiresPositiveSignup,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,

      eventStartsAt: events.startsAt,

      eventStatus: events.status,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .where(eq(roleRequestGroups.id, groupId))
    .limit(1);

  if (!group) {
    throw new Error(`Role-request group ${groupId} does not exist.`);
  }

  const options = await db
    .select({
      id: eventRoleOptions.id,

      displayName: eventRoleOptions.displayName,

      description: eventRoleOptions.description,

      sortOrder: roleRequestGroupOptions.sortOrder,
    })
    .from(roleRequestGroupOptions)
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequestGroupOptions.eventRoleOptionId),
    )
    .where(
      and(
        eq(roleRequestGroupOptions.groupId, group.id),

        eq(eventRoleOptions.active, true),
      ),
    )
    .orderBy(asc(roleRequestGroupOptions.sortOrder), asc(eventRoleOptions.id));

  const optionIds = options.map((option) => option.id);

  const requests =
    optionIds.length === 0
      ? []
      : await db
          .select({
            optionId: roleRequests.eventRoleOptionId,

            userId: roleRequests.discordUserId,

            createdAt: roleRequests.createdAt,
          })
          .from(roleRequests)
          .where(
            and(
              eq(roleRequests.eventId, group.eventId),

              inArray(roleRequests.eventRoleOptionId, optionIds),
            ),
          )
          .orderBy(asc(roleRequests.createdAt), asc(roleRequests.id));

  const requestsByOption = new Map<number, typeof requests>();

  for (const request of requests) {
    const existing = requestsByOption.get(request.optionId) ?? [];

    existing.push(request);

    requestsByOption.set(request.optionId, existing);
  }

  const now = new Date();

  const groupOpen =
    group.closedAt === null &&
    group.opensAt <= now &&
    group.closesAt > now &&
    group.eventStartsAt > now &&
    group.eventStatus !== "cancelled" &&
    group.eventStatus !== "completed";

  const eventStillManageable =
    group.eventStartsAt > now &&
    group.eventStatus !== "cancelled" &&
    group.eventStatus !== "completed";

  const closeTimestamp = Math.floor(group.closesAt.getTime() / 1000);

  const description = [
    group.description ??
      "Select any roles you would be willing to perform. You may request multiple roles.",

    "",
    "**Requests do not guarantee allocation.**",

    group.requiresPositiveSignup
      ? "You must currently be signed **Attending** or **Tentative** to add a request through this message."
      : null,

    `Requests close: <t:${closeTimestamp}:F> (<t:${closeTimestamp}:R>)`,

    groupOpen ? null : "🔒 **New requests through this message are closed.**",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`${group.name} — ${group.eventName}`)
    .setDescription(description)
    .setFooter({
      text: `Event #${group.eventId} • Request group #${group.id}`,
    });

  for (const option of options.slice(0, 20)) {
    const optionRequests = requestsByOption.get(option.id) ?? [];

    const requestLines = optionRequests
      .slice(0, 15)
      .map((request, index) => `${index + 1}. <@${request.userId}>`);

    if (optionRequests.length > 15) {
      requestLines.push(`+ ${optionRequests.length - 15} more`);
    }

    embed.addFields({
      name: `${option.displayName} (${optionRequests.length})`,

      value:
        requestLines.length > 0 ? requestLines.join("\n") : "No requests yet.",

      inline: false,
    });
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < options.length; index += 5) {
    const rowOptions = options.slice(index, index + 5);

    const row = new ActionRowBuilder<ButtonBuilder>();

    for (const option of rowOptions) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildRoleRequestAddCustomId(group.id, option.id))
          .setLabel(option.displayName.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!groupOpen),
      );
    }

    rows.push(row);
  }

  if (rows.length < 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildRoleRequestManageCustomId(group.eventId))
          .setLabel("Manage My Requests")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!eventStillManageable),
      ),
    );
  }

  return {
    embeds: [embed],

    components: rows,
  };
}

export async function refreshRoleRequestGroupMessage(
  guild: Guild,
  groupId: number,
): Promise<boolean> {
  const [group] = await db
    .select({
      channelId: roleRequestGroups.channelId,

      messageId: roleRequestGroups.messageId,
    })
    .from(roleRequestGroups)
    .where(eq(roleRequestGroups.id, groupId))
    .limit(1);

  if (!group?.messageId) {
    return false;
  }

  const channel = await guild.channels.fetch(group.channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return false;
  }

  let message;

  try {
    message = await channel.messages.fetch(group.messageId);
  } catch {
    return false;
  }

  const payload = await buildRoleRequestGroupMessagePayload(groupId);

  await message.edit({
    ...payload,

    /*
     * Mentions are visible inside the role lists but refreshing the
     * message must never generate new notifications.
     */
    allowedMentions: {
      parse: [],
    },
  });

  return true;
}

export async function refreshRoleRequestMessages(
  guild: Guild,
  eventId: number,
): Promise<void> {
  const groups = await db
    .select({
      id: roleRequestGroups.id,
    })
    .from(roleRequestGroups)
    .where(
      and(
        eq(roleRequestGroups.eventId, eventId),

        isNotNull(roleRequestGroups.messageId),
      ),
    );

  for (const group of groups) {
    await refreshRoleRequestGroupMessage(guild, group.id).catch(
      (error: unknown) => {
        console.error(
          `Failed to refresh role-request group ${group.id}:`,
          error,
        );
      },
    );
  }
}
