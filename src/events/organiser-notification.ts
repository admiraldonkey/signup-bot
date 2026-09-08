import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
} from "discord.js";
import { isDiscordErrorCode } from "../discord/discord-errors.js";
import type {
  OrganiserAssignmentSlot,
  OrganiserResponseAction,
} from "../organisers/organiser-types.js";

import { formatOrganiserSlot } from "./organiser-formatting.js";

export type {
  OrganiserAssignmentSlot,
  OrganiserResponseAction,
} from "../organisers/organiser-types.js";

export type OrganiserNotificationDelivery = "dm" | "admin_channel" | "failed";

export function buildOrganiserResponseCustomId(
  assignmentId: number,
  action: OrganiserResponseAction,
): string {
  return `organiser:${assignmentId}:${action}`;
}

export function parseOrganiserResponseCustomId(customId: string): {
  assignmentId: number;
  action: OrganiserResponseAction;
} | null {
  const match = /^organiser:(\d+):(confirm|decline)$/.exec(customId);

  if (!match) {
    return null;
  }

  const assignmentId = Number(match[1]);

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return null;
  }

  return {
    assignmentId,

    action: match[2] as OrganiserResponseAction,
  };
}

function buildOrganiserResponseButtons(
  assignmentId: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildOrganiserResponseCustomId(assignmentId, "confirm"))
      .setLabel("Confirm")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(buildOrganiserResponseCustomId(assignmentId, "decline"))
      .setLabel("Decline")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
}

export async function sendOrganiserAssignmentNotification(input: {
  guild: Guild;

  assignmentId: number;

  eventId: number;

  eventName: string;

  discordUserId: string;

  slot: OrganiserAssignmentSlot;

  eventAdminChannelId: string | null;

  organiserDmsEnabled: boolean;

  eventMessageUrl?: string | null;
}): Promise<OrganiserNotificationDelivery> {
  const slotLabel = formatOrganiserSlot(input.slot);

  const dmContent = [
    `You have been assigned as the **${slotLabel}** for **${input.eventName}** (#${input.eventId}).`,

    "",

    "Please confirm whether you can organise this event.",

    input.eventMessageUrl ? `Event message: ${input.eventMessageUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  /*
   * DM is the preferred delivery method when enabled for this server.
   *
   * When organiser DMs are disabled, do not fetch the member or attempt a DM
   * at all. Delivery proceeds directly to the configured Event Administration
   * channel.
   */
  if (input.organiserDmsEnabled) {
    try {
      const member = await input.guild.members.fetch(input.discordUserId);

      await member.send({
        content: dmContent,

        components: [buildOrganiserResponseButtons(input.assignmentId)],
      });

      return "dm";
    } catch {
      /*
       * DM failure is expected for members who disable server DMs.
       * Fall through to the private administration channel.
       */
    }
  }

  if (!input.eventAdminChannelId) {
    return "failed";
  }

  try {
    const channel = await input.guild.channels.fetch(input.eventAdminChannelId);

    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      !channel.isSendable()
    ) {
      return "failed";
    }

    const deliveryExplanation = input.organiserDmsEnabled
      ? `The bot could not deliver a DM to <@${input.discordUserId}>.`
      : "Direct organiser DMs are disabled for this server.";

    await channel.send({
      content: [
        `||<@${input.discordUserId}>||`,

        "",

        "⚠️ **Organiser confirmation required**",

        deliveryExplanation,

        "",

        `They have been assigned as the **${slotLabel}** for **${input.eventName}** (#${input.eventId}).`,

        input.eventMessageUrl
          ? `Event message: ${input.eventMessageUrl}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),

      components: [buildOrganiserResponseButtons(input.assignmentId)],

      /*
       * Explicitly permit only the assigned user mention.
       */
      allowedMentions: {
        parse: [],

        users: [input.discordUserId],
      },
    });

    return "admin_channel";
  } catch (error: unknown) {
    /*
     * The configured Event Administration channel may have been deleted after
     * it was saved. That is a known unusable destination rather than a
     * transient delivery failure.
     */
    if (isDiscordErrorCode(error, 10003)) {
      return "failed";
    }

    /*
     * Do not classify unexpected Discord/network failures as a
     * permanently unusable configuration. Callers can then apply the
     * appropriate retry or authoritative-state handling.
     */
    throw error;
  }
}

export function buildOrganiserCoverClaimCustomId(eventId: number): string {
  return `organiser-cover:${eventId}`;
}

export function parseOrganiserCoverClaimCustomId(customId: string): {
  eventId: number;
} | null {
  const match = /^organiser-cover:(\d+)$/.exec(customId);

  if (!match) {
    return null;
  }

  const eventId = Number(match[1]);

  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    return null;
  }

  return {
    eventId,
  };
}

export type OrganiserPendingWarningDelivery = {
  channelId: string;
  messageId: string;
} | null;

export async function sendOrganiserPendingWarning(input: {
  guild: Guild;

  eventAdminChannelId: string | null;

  eventId: number;

  eventName: string;

  discordUserId: string;

  slot: OrganiserAssignmentSlot;

  responseDeadlineAt: Date;
}): Promise<OrganiserPendingWarningDelivery> {
  if (!input.eventAdminChannelId) {
    return null;
  }

  try {
    const channel = await input.guild.channels.fetch(input.eventAdminChannelId);

    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      !channel.isSendable()
    ) {
      return null;
    }

    const deadlineTimestamp = Math.floor(
      input.responseDeadlineAt.getTime() / 1000,
    );

    const warningMessage = await channel.send({
      content: [
        "⚠️ **Organiser response warning**",

        "",

        `<@${input.discordUserId}> has not yet confirmed as the **${formatOrganiserSlot(
          input.slot,
        )}** for **${input.eventName}** (#${input.eventId}).`,

        `Response deadline: <t:${deadlineTimestamp}:F> (<t:${deadlineTimestamp}:R>)`,
      ].join("\n"),

      /*
       * Show the member mention but do not generate another ping.
       */
      allowedMentions: {
        parse: [],
      },
    });

    return {
      channelId: channel.id,

      messageId: warningMessage.id,
    };
  } catch (error: unknown) {
    /*
     * The configured Event Administration channel may have been deleted
     * before it was fetched or while the warning send was in flight.
     *
     * Discord has explicitly told us that this destination no longer exists,
     * so retrying the scheduled warning against the same channel is useless.
     */
    if (isDiscordErrorCode(error, 10003)) {
      return null;
    }

    /*
     * Unexpected Discord/network failures may be temporary. Preserve them so
     * the scheduler can apply its normal retry/backoff behaviour.
     */
    throw error;
  }
}

export type CoverRequestDelivery = "pinged" | "posted_without_ping" | "failed";

type OrganiserCoverMessageInput = {
  guild: Guild;

  eventId: number;

  eventName: string;

  eventAdminChannelId: string | null;

  eventOrganiserRoleId: string | null;

  heading: string;

  description: string;
};

async function sendOrganiserCoverMessage(
  input: OrganiserCoverMessageInput,
): Promise<CoverRequestDelivery> {
  if (!input.eventAdminChannelId || !input.eventOrganiserRoleId) {
    return "failed";
  }

  try {
    const [channel, role] = await Promise.all([
      input.guild.channels.fetch(input.eventAdminChannelId),

      input.guild.roles.fetch(input.eventOrganiserRoleId),
    ]);

    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      !channel.isSendable() ||
      !role
    ) {
      return "failed";
    }

    const botMember =
      input.guild.members.me ?? (await input.guild.members.fetchMe());

    const permissions = channel.permissionsFor(botMember);

    const canPingRole =
      role.mentionable || permissions.has(PermissionFlagsBits.MentionEveryone);

    await channel.send({
      content: [
        canPingRole ? `<@&${role.id}>` : `**${role.name}**`,

        "",

        input.heading,

        "",

        input.description,

        "An eligible Event Organiser can claim responsibility below.",
      ].join("\n"),

      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildOrganiserCoverClaimCustomId(input.eventId))
            .setLabel("Claim Event")
            .setEmoji("🫡")
            .setStyle(ButtonStyle.Primary),
        ),
      ],

      allowedMentions: canPingRole
        ? {
            parse: [],

            roles: [role.id],
          }
        : {
            parse: [],
          },
    });

    return canPingRole ? "pinged" : "posted_without_ping";
  } catch (error: unknown) {
    /*
     * A deleted Event Administration channel is a permanently unusable
     * destination rather than a transient scheduler failure.
     */
    if (isDiscordErrorCode(error, 10003)) {
      return "failed";
    }

    /*
     * Unexpected Discord/network failures may be temporary.
     */
    throw error;
  }
}

export async function sendOrganiserCoverRequest(input: {
  guild: Guild;

  eventId: number;

  eventName: string;

  eventAdminChannelId: string | null;

  eventOrganiserRoleId: string | null;
}): Promise<CoverRequestDelivery> {
  return sendOrganiserCoverMessage({
    ...input,

    heading: "🚨 **Event organiser cover required**",

    description: `**${input.eventName}** (#${input.eventId}) no longer has an available assigned organiser.`,
  });
}

export async function sendOrganiserMissingAtStartAlert(input: {
  guild: Guild;

  eventId: number;

  eventName: string;

  eventAdminChannelId: string | null;

  eventOrganiserRoleId: string | null;
}): Promise<CoverRequestDelivery> {
  return sendOrganiserCoverMessage({
    ...input,

    heading: "🚨 **Event has started without an organiser**",

    description: `**${input.eventName}** (#${input.eventId}) has started and still has no confirmed organiser.`,
  });
}
