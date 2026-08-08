import { ChannelType, EmbedBuilder, type Guild } from "discord.js";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { auditLogs, discordGuilds, guildSettings } from "../db/schema.js";

export type AuditOutcome = "success" | "denied" | "failure";

export interface WriteAuditLogInput {
  guildId: number;

  guild?: Guild | null;

  actorUserId?: string | null;

  action: string;

  outcome: AuditOutcome;

  summary: string;

  targetType?: string | null;

  targetId?: string | null;

  details?: Record<string, unknown> | null;

  /*
   * Used when disabling logging so the final audit message can
   * still be mirrored to the channel that has just been disabled.
   *
   * undefined = use configured channel
   * null      = do not mirror
   * string    = use this explicit channel
   */
  mirrorChannelId?: string | null;
}

export async function writeAuditLog(input: WriteAuditLogInput): Promise<void> {
  let createdAudit:
    | {
        id: number;
        createdAt: Date;
      }
    | undefined;

  try {
    [createdAudit] = await db
      .insert(auditLogs)
      .values({
        guildId: input.guildId,

        actorUserId: input.actorUserId ?? null,

        action: input.action,

        outcome: input.outcome,

        summary: input.summary,

        targetType: input.targetType ?? null,

        targetId: input.targetId ?? null,

        details: input.details ?? null,
      })
      .returning({
        id: auditLogs.id,

        createdAt: auditLogs.createdAt,
      });
  } catch (error) {
    /*
     * An audit-channel problem must never make a successful event
     * operation look like it failed afterwards.
     */
    console.error("Failed to write database audit log:", error);

    return;
  }

  if (!createdAudit || !input.guild) {
    return;
  }

  let logChannelId: string | null;

  if (input.mirrorChannelId !== undefined) {
    logChannelId = input.mirrorChannelId;
  } else {
    const [settings] = await db
      .select({
        logChannelId: guildSettings.botLogChannelId,
      })
      .from(guildSettings)
      .where(eq(guildSettings.guildId, input.guildId))
      .limit(1);

    logChannelId = settings?.logChannelId ?? null;
  }

  if (!logChannelId) {
    return;
  }

  try {
    const channel = await input.guild.channels.fetch(logChannelId);

    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.isSendable()
    ) {
      console.warn(`Audit log channel ${logChannelId} is unavailable.`);

      return;
    }

    const outcomeLabel = formatOutcome(input.outcome);

    const actor = input.actorUserId ? `<@${input.actorUserId}>` : "System";

    const target =
      input.targetType && input.targetId
        ? `${input.targetType} \`${input.targetId}\``
        : "None";

    const embed = new EmbedBuilder()
      .setTitle(`${outcomeLabel} ${input.action}`)
      .addFields(
        {
          name: "Actor",
          value: actor,
          inline: true,
        },

        {
          name: "Target",
          value: target,
          inline: true,
        },

        {
          name: "Summary",
          value: truncate(input.summary, 1000),
          inline: false,
        },
      )
      .setFooter({
        text: `Audit ID: ${createdAudit.id}`,
      })
      .setTimestamp(createdAudit.createdAt);

    await channel.send({
      embeds: [embed],

      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    /*
     * The database record is authoritative.
     * Discord mirroring is merely a convenience.
     */
    console.error("Failed to mirror audit entry to Discord:", error);
  }
}

export async function auditDeniedCommandAttempt(
  guild: Guild,
  actorUserId: string,
  commandName: string,
  subcommand?: string | null,
): Promise<void> {
  const [configuredGuild] = await db
    .select({
      id: discordGuilds.id,
    })
    .from(discordGuilds)
    .where(eq(discordGuilds.discordGuildId, guild.id))
    .limit(1);

  if (!configuredGuild) {
    return;
  }

  const command = subcommand
    ? `/${commandName} ${subcommand}`
    : `/${commandName}`;

  await writeAuditLog({
    guildId: configuredGuild.id,

    guild,

    actorUserId,

    action: "command.denied",

    outcome: "denied",

    summary: `Denied command attempt: ${command}.`,

    targetType: "command",

    targetId: command,

    details: {
      commandName,
      subcommand: subcommand ?? null,
    },
  });
}

function formatOutcome(outcome: AuditOutcome): string {
  switch (outcome) {
    case "success":
      return "✅";

    case "denied":
      return "⛔";

    case "failure":
      return "❌";
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength - 1) + "…";
}
