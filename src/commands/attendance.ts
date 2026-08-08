import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { and, eq } from "drizzle-orm";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  actualAttendanceRecords,
  attendanceResponses,
  eventAttendanceReports,
  events,
} from "../db/schema.js";
import { formatUserMentions } from "../attendance/format.js";
import {
  handleAttendanceIssuesReport,
  handleAttendanceUserReport,
} from "./attendance-reporting.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

export async function handleAttendanceCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Attendance commands can only be used inside a Discord server.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "record":
      await recordAttendance(interaction);
      return;

    case "add":
      await addAttendee(interaction);
      return;

    case "remove":
      await removeAttendee(interaction);
      return;

    case "compare":
      await compareAttendance(interaction);
      return;

    case "user":
      await handleAttendanceUserReport(interaction);
      return;

    case "issues":
      await handleAttendanceIssuesReport(interaction);
      return;

    default:
      throw new Error(`Unknown attendance subcommand: ${subcommand}`);
  }
}

async function getAuthorisedContext(interaction: CachedInteraction) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply(
      "This server has not been initialised. " +
        "Run `/setup initialise` first.",
    );

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
      "You need the configured Event Admin role " +
        "or the Manage Server permission to manage attendance.",
    );

    return null;
  }

  return configuration;
}

async function findOwnedEvent(guildDatabaseId: number, eventId: number) {
  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      startsAt: events.startsAt,
      status: events.status,
    })
    .from(events)
    .where(
      and(eq(events.id, eventId), eq(events.ownerGuildId, guildDatabaseId)),
    )
    .limit(1);

  return event ?? null;
}

async function recordAttendance(interaction: CachedInteraction): Promise<void> {
  const configuration = await getAuthorisedContext(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const rawAttendees = interaction.options.getString("attendees", true).trim();

  const sourceReference =
    interaction.options.getString("source-reference")?.trim() || null;

  const parsed = parseAttendanceInput(rawAttendees);

  if (!parsed.ok) {
    await interaction.editReply(
      [
        "The attendance list could not be parsed.",
        "",
        parsed.error,
        "",
        "For now, bulk recording accepts only Discord user IDs or raw Discord mention syntax, for example:",
        "`123456789012345678`",
        "`<@123456789012345678>`",
        "",
        "Use `/attendance add` when selecting people individually.",
      ].join("\n"),
    );

    return;
  }

  const resolvedMembers = await Promise.all(
    parsed.userIds.map(async (userId) => {
      try {
        const member = await interaction.guild.members.fetch(userId);

        return {
          userId,
          member,
        };
      } catch {
        return {
          userId,
          member: null,
        };
      }
    }),
  );

  const unresolvedIds = resolvedMembers
    .filter((result) => !result.member)
    .map((result) => result.userId);

  if (unresolvedIds.length > 0) {
    await interaction.editReply(
      [
        "The attendance list was not saved because these IDs could not be resolved as members of this server:",
        "",
        ...unresolvedIds.map((userId) => `• \`${userId}\``),
        "",
        "Correct the list and run the command again.",
      ].join("\n"),
    );

    return;
  }

  const botUsers = resolvedMembers
    .filter((result) => result.member?.user.bot)
    .map((result) => result.member!.displayName);

  if (botUsers.length > 0) {
    await interaction.editReply(
      [
        "The attendance list was not saved because it contains bot accounts:",
        "",
        ...botUsers.map((name) => `• ${name}`),
      ].join("\n"),
    );

    return;
  }

  const now = new Date();

  const attendanceValues = resolvedMembers.map(({ userId, member }) => ({
    eventId,
    discordUserId: userId,

    displayNameSnapshot: member?.displayName ?? null,
  }));

  await db.transaction(async (transaction) => {
    /*
     * /attendance record means:
     * "This is now the authoritative list."
     */
    await transaction
      .delete(actualAttendanceRecords)
      .where(eq(actualAttendanceRecords.eventId, eventId));

    if (attendanceValues.length > 0) {
      await transaction
        .insert(actualAttendanceRecords)
        .values(attendanceValues);
    }

    await transaction
      .insert(eventAttendanceReports)
      .values({
        eventId,

        source: "paste",

        sourceReference,

        recordedByUserId: interaction.user.id,

        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: eventAttendanceReports.eventId,

        set: {
          source: "paste",

          sourceReference,

          recordedByUserId: interaction.user.id,

          updatedAt: now,
        },
      });
  });

  await interaction.editReply({
    content: [
      `✅ Actual attendance for **${event.name}** (#${event.id}) has been recorded.`,
      `**Recorded attendees:** ${attendanceValues.length}`,
      sourceReference
        ? `**Source:** ${sourceReference}`
        : "**Source:** Pasted/manual list",
      "",
      "This replaces any previously recorded actual-attendance list for the event.",
      `Use \`/attendance compare event-id:${event.id}\` to compare it with signups.`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

async function addAttendee(interaction: CachedInteraction): Promise<void> {
  const configuration = await getAuthorisedContext(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const user = interaction.options.getUser("user", true);

  if (user.bot) {
    await interaction.editReply(
      "Bot accounts cannot be recorded as event attendees.",
    );

    return;
  }

  let member;

  try {
    member = await interaction.guild.members.fetch(user.id);
  } catch {
    await interaction.editReply(
      "That user could not be resolved as a current member of this server.",
    );

    return;
  }

  const now = new Date();

  await db.transaction(async (transaction) => {
    await transaction
      .insert(actualAttendanceRecords)
      .values({
        eventId,

        discordUserId: user.id,

        displayNameSnapshot: member.displayName,
      })
      .onConflictDoUpdate({
        target: [
          actualAttendanceRecords.eventId,
          actualAttendanceRecords.discordUserId,
        ],

        set: {
          displayNameSnapshot: member.displayName,
        },
      });

    /*
     * If this is the first actual-attendance entry,
     * also establish that the event has a valid report.
     */
    await transaction
      .insert(eventAttendanceReports)
      .values({
        eventId,

        source: "manual",

        sourceReference: null,

        recordedByUserId: interaction.user.id,

        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: eventAttendanceReports.eventId,

        set: {
          updatedAt: now,
        },
      });
  });

  await interaction.editReply({
    content: `✅ <@${user.id}> is recorded as having attended **${event.name}** (#${event.id}).`,

    allowedMentions: {
      parse: [],
    },
  });
}

async function removeAttendee(interaction: CachedInteraction): Promise<void> {
  const configuration = await getAuthorisedContext(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const [report] = await db
    .select({
      eventId: eventAttendanceReports.eventId,
    })
    .from(eventAttendanceReports)
    .where(eq(eventAttendanceReports.eventId, eventId))
    .limit(1);

  if (!report) {
    await interaction.editReply(
      "Actual attendance has not yet been recorded for this event.",
    );

    return;
  }

  const user = interaction.options.getUser("user", true);

  const deleted = await db
    .delete(actualAttendanceRecords)
    .where(
      and(
        eq(actualAttendanceRecords.eventId, eventId),
        eq(actualAttendanceRecords.discordUserId, user.id),
      ),
    )
    .returning({
      userId: actualAttendanceRecords.discordUserId,
    });

  if (deleted.length === 0) {
    await interaction.editReply({
      content: `<@${user.id}> is not currently recorded as having attended **${event.name}**.`,

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  await db
    .update(eventAttendanceReports)
    .set({
      updatedAt: new Date(),
    })
    .where(eq(eventAttendanceReports.eventId, eventId));

  /*
   * Deliberately keep event_attendance_reports even if this removes
   * the final person. Zero recorded attendees is valid data and is
   * different from "attendance has never been recorded".
   */

  await interaction.editReply({
    content: `✅ <@${user.id}> has been removed from the actual attendance for **${event.name}**.`,

    allowedMentions: {
      parse: [],
    },
  });
}

async function compareAttendance(
  interaction: CachedInteraction,
): Promise<void> {
  const configuration = await getAuthorisedContext(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const [report] = await db
    .select({
      source: eventAttendanceReports.source,

      sourceReference: eventAttendanceReports.sourceReference,

      recordedAt: eventAttendanceReports.recordedAt,

      updatedAt: eventAttendanceReports.updatedAt,
    })
    .from(eventAttendanceReports)
    .where(eq(eventAttendanceReports.eventId, eventId))
    .limit(1);

  if (!report) {
    await interaction.editReply(
      [
        `Actual attendance has not yet been recorded for **${event.name}** (#${event.id}).`,
        "",
        "No comparison has been made. This prevents missing attendance data from being mistaken for mass no-shows.",
      ].join("\n"),
    );

    return;
  }

  const [signupRows, actualRows] = await Promise.all([
    db
      .select({
        userId: attendanceResponses.discordUserId,

        status: attendanceResponses.status,
      })
      .from(attendanceResponses)
      .where(eq(attendanceResponses.eventId, eventId)),

    db
      .select({
        userId: actualAttendanceRecords.discordUserId,
      })
      .from(actualAttendanceRecords)
      .where(eq(actualAttendanceRecords.eventId, eventId)),
  ]);

  const signupByUser = new Map(
    signupRows.map((row) => [row.userId, row.status]),
  );

  const actualUserIds = actualRows.map((row) => row.userId);

  const actualSet = new Set(actualUserIds);

  const attendingIds = signupRows
    .filter((row) => row.status === "attending")
    .map((row) => row.userId);

  const tentativeIds = signupRows
    .filter((row) => row.status === "tentative")
    .map((row) => row.userId);

  const matchedAttending = attendingIds.filter((userId) =>
    actualSet.has(userId),
  );

  const noShows = attendingIds.filter((userId) => !actualSet.has(userId));

  const tentativeAttended = tentativeIds.filter((userId) =>
    actualSet.has(userId),
  );

  const tentativeAbsent = tentativeIds.filter(
    (userId) => !actualSet.has(userId),
  );

  const noResponseWalkIns = actualUserIds.filter(
    (userId) => !signupByUser.has(userId),
  );

  const notAttendingWalkIns = actualUserIds.filter(
    (userId) => signupByUser.get(userId) === "not_attending",
  );

  const sourceLabel =
    report.source === "paste"
      ? "Pasted list"
      : report.source === "manual"
        ? "Manual entry"
        : report.source;

  const sourceDescription = report.sourceReference
    ? `${report.sourceReference} — ${sourceLabel}`
    : sourceLabel;

  const embed = new EmbedBuilder()
    .setTitle(`Attendance comparison — ${event.name}`)
    .setDescription(
      [
        `Event ID: **#${event.id}**`,
        `Actual attendance recorded: **${actualUserIds.length}**`,
        `Signup responses recorded: **${signupRows.length}**`,
      ].join("\n"),
    )
    .addFields(
      {
        name: `✅ Attending & present (${matchedAttending.length})`,

        value: formatUserMentions(matchedAttending),

        inline: false,
      },
      {
        name: `🚫 No-shows (${noShows.length})`,

        value: formatUserMentions(noShows),

        inline: false,
      },
      {
        name: `❔ Tentative & present (${tentativeAttended.length})`,

        value: formatUserMentions(tentativeAttended),

        inline: false,
      },
      {
        name: `🕒 Tentative & absent (${tentativeAbsent.length})`,

        value: formatUserMentions(tentativeAbsent),

        inline: false,
      },
      {
        name: `🚶 Attended with no signup (${noResponseWalkIns.length})`,

        value: formatUserMentions(noResponseWalkIns),

        inline: false,
      },
      {
        name: `↩️ Said Not attending but attended (${notAttendingWalkIns.length})`,

        value: formatUserMentions(notAttendingWalkIns),

        inline: false,
      },
    )
    .setFooter({
      text: `Actual-attendance source: ${sourceDescription}`,
    })
    .setTimestamp(report.updatedAt);

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}

type ParsedAttendanceInput =
  | {
      ok: true;
      userIds: string[];
    }
  | {
      ok: false;
      error: string;
    };

function parseAttendanceInput(input: string): ParsedAttendanceInput {
  const trimmed = input.trim();

  const normalisedEmpty = trimmed.toLowerCase().replace(/\s+/g, " ");

  if (["none", "no attendees", "nobody", "0"].includes(normalisedEmpty)) {
    return {
      ok: true,
      userIds: [],
    };
  }

  /*
   * Convert raw Discord mention syntax into plain IDs.
   */
  const normalised = trimmed.replace(/<@!?(\d{17,20})>/g, "$1");

  const tokens = normalised
    .split(/[\s,;|]+/)
    .map((token) =>
      token
        .replace(/^[•*\-[\](){}]+/, "")
        .replace(/[•*\-[\](){}]+$/, "")
        .trim(),
    )
    .filter(Boolean);

  const invalidTokens = tokens.filter((token) => !/^\d{17,20}$/.test(token));

  if (invalidTokens.length > 0) {
    return {
      ok: false,
      error:
        "The list contains plain names or other text that cannot be matched safely yet.",
    };
  }

  const userIds = [...new Set(tokens)];

  return {
    ok: true,
    userIds,
  };
}
