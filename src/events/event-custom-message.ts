import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventPingRoles } from "../db/schema.js";

interface EventCustomMessageInput {
  guild: Guild;
  eventId: number;
  eventName: string;
  channelId: string;
  message: string;
  pingEventRoles: boolean;
  hideMentions?: boolean;
}

export async function validateEventMessageDestination(
  guild: Guild,
  eventId: number,
  channelId: string,
  pingEventRoles: boolean,
): Promise<void> {
  const channel = await guild.channels.fetch(channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isSendable()
  ) {
    throw new Error(
      "The selected destination is not an available text or announcement channel.",
    );
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  if (
    !permissions.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages)
  ) {
    throw new Error(
      "The bot does not have permission to view and send messages in that channel.",
    );
  }

  if (!pingEventRoles) {
    return;
  }

  const pingRoles = await loadEventPingRoles(eventId);

  for (const pingRole of pingRoles) {
    const role = await guild.roles.fetch(pingRole.discordRoleId);

    if (!role) {
      throw new Error(
        `The configured event role "${pingRole.roleName}" no longer exists.`,
      );
    }

    if (
      !role.mentionable &&
      !permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
      throw new Error(
        `The bot cannot mention the event role "${role.name}" in that channel.`,
      );
    }
  }
}

export async function sendEventCustomMessage(input: EventCustomMessageInput) {
  await validateEventMessageDestination(
    input.guild,
    input.eventId,
    input.channelId,
    input.pingEventRoles,
  );

  const channel = await input.guild.channels.fetch(input.channelId);

  if (!channel || !channel.isSendable()) {
    throw new Error("The destination channel became unavailable.");
  }

  const pingRoles = input.pingEventRoles
    ? await loadEventPingRoles(input.eventId)
    : [];

  const pingRoleIds = pingRoles.map((role) => role.discordRoleId);

  const roleMentions = pingRoleIds.map((roleId) => `<@&${roleId}>`);

  const roleMentionText =
    roleMentions.length === 0
      ? null
      : input.hideMentions
        ? `||${roleMentions.join(" ")}||`
        : roleMentions.join(" ");

  const content = [roleMentionText, `**${input.eventName}**`, input.message]
    .filter((value): value is string => value !== null)
    .join("\n\n");

  if (content.length > 2000) {
    throw new Error("The final message is too long for Discord.");
  }

  const sentMessage = await channel.send({
    content,

    allowedMentions: {
      parse: [],

      roles: pingRoleIds,
    },
  });

  return {
    messageId: sentMessage.id,

    channelId: sentMessage.channelId,

    url: sentMessage.url,
  };
}

async function loadEventPingRoles(eventId: number) {
  return db
    .select({
      discordRoleId: eventPingRoles.discordRoleId,

      roleName: eventPingRoles.roleName,
    })
    .from(eventPingRoles)
    .where(eq(eventPingRoles.eventId, eventId))
    .orderBy(asc(eventPingRoles.sortOrder));
}
