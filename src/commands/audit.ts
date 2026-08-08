import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

export async function handleAuditCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Audit commands can only be used inside a Discord server.",

      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "recent") {
    await showRecentAuditEntries(interaction);

    return;
  }

  throw new Error(`Unknown audit subcommand: ${subcommand}`);
}

async function showRecentAuditEntries(
  interaction: CachedInteraction,
): Promise<void> {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await writeAuditLog({
      guildId: configuration.guildId,

      guild: interaction.guild,

      actorUserId: interaction.user.id,

      action: "command.denied",

      outcome: "denied",

      summary: "Denied command attempt: /audit recent.",

      targetType: "command",

      targetId: "/audit recent",
    });

    await interaction.editReply(
      "You need the configured Event Admin role " +
        "or the Manage Server permission to view the audit trail.",
    );

    return;
  }

  const limit = interaction.options.getInteger("limit") ?? 10;

  const user = interaction.options.getUser("user");

  const outcome = interaction.options.getString("outcome");

  const filters = [
    eq(auditLogs.guildId, configuration.guildId),

    user ? eq(auditLogs.actorUserId, user.id) : undefined,

    outcome ? eq(auditLogs.outcome, outcome) : undefined,
  ];

  const entries = await db
    .select({
      id: auditLogs.id,

      actorUserId: auditLogs.actorUserId,

      action: auditLogs.action,

      outcome: auditLogs.outcome,

      summary: auditLogs.summary,

      targetType: auditLogs.targetType,

      targetId: auditLogs.targetId,

      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  if (entries.length === 0) {
    await interaction.editReply("No audit entries match those filters.");

    return;
  }

  const lines = entries.map((entry) => {
    const timestamp = Math.floor(entry.createdAt.getTime() / 1000);

    const actor = entry.actorUserId ? `<@${entry.actorUserId}>` : "System";

    const target =
      entry.targetType && entry.targetId
        ? ` • ${entry.targetType} \`${entry.targetId}\``
        : "";

    return [
      `${formatAuditOutcome(entry.outcome)} **${entry.action}**`,
      `<t:${timestamp}:f> • ${actor}${target}`,
      truncate(entry.summary, 250),
    ].join("\n");
  });

  const embed = new EmbedBuilder()
    .setTitle("Recent audit activity")
    .setDescription(lines.join("\n\n"))
    .setFooter({
      text: `Showing ${entries.length} most recent matching entr${entries.length === 1 ? "y" : "ies"}.`,
    })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}

function formatAuditOutcome(outcome: string): string {
  switch (outcome) {
    case "success":
      return "✅";

    case "denied":
      return "⛔";

    case "failure":
      return "❌";

    default:
      return "•";
  }
}

function truncate(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }

  return text.slice(0, length - 1) + "…";
}
