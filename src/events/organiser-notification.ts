import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
} from "discord.js";

export type OrganiserResponseAction = "confirm" | "decline";

export type OrganiserNotificationDelivery = "dm" | "admin_channel" | "failed";

export type OrganiserAssignmentSlot = "primary" | "backup" | "cover";

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

function formatSlot(slot: OrganiserAssignmentSlot): string {
  switch (slot) {
    case "primary":
      return "primary organiser";

    case "backup":
      return "backup organiser";

    case "cover":
      return "cover organiser";
  }
}

export async function sendOrganiserAssignmentNotification(input: {
  guild: Guild;

  assignmentId: number;

  eventId: number;

  eventName: string;

  discordUserId: string;

  slot: OrganiserAssignmentSlot;

  eventAdminChannelId: string | null;

  eventMessageUrl?: string | null;
}): Promise<OrganiserNotificationDelivery> {
  const slotLabel = formatSlot(input.slot);

  const dmContent = [
    `You have been assigned as the **${slotLabel}** for **${input.eventName}** (#${input.eventId}).`,

    "",

    "Please confirm whether you can organise this event.",

    input.eventMessageUrl ? `Event message: ${input.eventMessageUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  /*
   * DM is the preferred delivery method.
   */
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

    await channel.send({
      content: [
        `||<@${input.discordUserId}>||`,

        "",

        "⚠️ **Organiser confirmation required**",

        `The bot could not deliver a DM to <@${input.discordUserId}>.`,

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
  } catch (error) {
    console.error(
      `Failed to send organiser assignment fallback for event ${input.eventId}:`,
      error,
    );

    return "failed";
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

export async function sendOrganiserPendingWarning(input: {
  guild: Guild;

  eventAdminChannelId: string | null;

  eventId: number;

  eventName: string;

  discordUserId: string;

  slot: OrganiserAssignmentSlot;

  responseDeadlineAt: Date;
}): Promise<boolean> {
  if (!input.eventAdminChannelId) {
    return false;
  }

  const channel = await input.guild.channels.fetch(input.eventAdminChannelId);

  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    !channel.isSendable()
  ) {
    return false;
  }

  const deadlineTimestamp = Math.floor(
    input.responseDeadlineAt.getTime() / 1000,
  );

  await channel.send({
    content: [
      "⚠️ **Organiser response warning**",

      "",

      `<@${input.discordUserId}> has not yet confirmed as the **${formatSlot(
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

  return true;
}

export type CoverRequestDelivery = "pinged" | "posted_without_ping" | "failed";

export async function sendOrganiserCoverRequest(input: {
  guild: Guild;

  eventId: number;

  eventName: string;

  eventAdminChannelId: string | null;

  eventOrganiserRoleId: string | null;
}): Promise<CoverRequestDelivery> {
  if (!input.eventAdminChannelId || !input.eventOrganiserRoleId) {
    return "failed";
  }

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

      "🚨 **Event organiser cover required**",

      "",

      `**${input.eventName}** (#${input.eventId}) no longer has an available assigned organiser.`,

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
}
