import { type ButtonInteraction, type Message, MessageFlags } from "discord.js";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  attendanceResponses,
  discordGuilds,
  eventAudiences,
  eventMessages,
  events,
  eventTypes,
} from "../db/schema.js";
import {
  type AttendanceCounts,
  type AttendanceStatus,
  buildAttendanceButtons,
  buildAttendanceEmbed,
  EMPTY_ATTENDANCE_COUNTS,
  parseAttendanceCustomId,
} from "../events/attendance-message.js";

/*
 * Message edits are throttled by Discord message ID.
 *
 * If 50 users respond at nearly the same time, their database writes
 * happen immediately but the public message is edited once after the
 * short interval rather than 50 times.
 */
const attendanceRefreshTimers = new Map<string, NodeJS.Timeout>();

const ATTENDANCE_REFRESH_DELAY_MS = 750;

const STATUS_CONFIRMATIONS: Record<AttendanceStatus, string> = {
  attending: "You are marked as **attending**.",
  tentative: "You are marked as **tentative**.",
  not_attending: "You are marked as **not attending**.",
};

export async function handleAttendanceButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseAttendanceCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!interaction.guildId) {
    await interaction.editReply(
      "Attendance buttons can only be used inside a server.",
    );

    return true;
  }

  const event = await findAttendanceEvent(
    parsed.eventId,
    interaction.guildId,
    interaction.message.id,
  );

  if (!event) {
    await interaction.editReply(
      "This attendance message is no longer linked to an active event.",
    );

    return true;
  }

  const now = new Date();

  if (event.status !== "open") {
    await interaction.editReply("Attendance is no longer open for this event.");

    scheduleAttendanceRefresh(
      event.eventId,
      interaction.guildId,
      interaction.message,
    );

    return true;
  }

  if (event.attendanceClosesAt && event.attendanceClosesAt <= now) {
    await interaction.editReply(
      "The attendance deadline for this event has passed.",
    );

    scheduleAttendanceRefresh(
      event.eventId,
      interaction.guildId,
      interaction.message,
    );

    return true;
  }

  await db
    .insert(attendanceResponses)
    .values({
      eventId: event.eventId,
      discordUserId: interaction.user.id,

      sourceGuildId: event.guildDatabaseId,

      status: parsed.status,

      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [attendanceResponses.eventId, attendanceResponses.discordUserId],
      set: {
        sourceGuildId: event.guildDatabaseId,

        status: parsed.status,

        updatedAt: now,
      },
    });

  /*
   * Confirm immediately. The public totals refresh asynchronously,
   * avoiding unnecessary delay for the member pressing the button.
   */
  await interaction.editReply(STATUS_CONFIRMATIONS[parsed.status]);

  scheduleAttendanceRefresh(
    event.eventId,
    interaction.guildId,
    interaction.message,
  );

  return true;
}

async function findAttendanceEvent(
  eventId: number,
  discordGuildId: string,
  discordMessageId: string,
) {
  const [event] = await db
    .select({
      eventId: events.id,
      audienceName: eventAudiences.name,

      timezone: events.timezone,
      showDetailedDeadline: events.showDetailedDeadline,
      name: events.name,
      description: events.description,
      eventTypeName: eventTypes.name,
      startsAt: events.startsAt,

      attendanceClosesAt: events.attendanceClosesAt,

      status: events.status,

      guildDatabaseId: discordGuilds.id,
    })
    .from(events)
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .innerJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
    .innerJoin(
      eventMessages,
      and(
        eq(eventMessages.eventId, events.id),
        eq(eventMessages.kind, "attendance"),
      ),
    )
    .innerJoin(discordGuilds, eq(discordGuilds.id, eventMessages.guildId))
    .where(
      and(
        eq(events.id, eventId),

        eq(eventMessages.messageId, discordMessageId),

        eq(discordGuilds.discordGuildId, discordGuildId),
      ),
    )
    .limit(1);

  return event ?? null;
}

async function getAttendanceCounts(eventId: number): Promise<AttendanceCounts> {
  const rows = await db
    .select({
      status: attendanceResponses.status,

      count: sql<number>`count(*)::int`,
    })
    .from(attendanceResponses)
    .where(eq(attendanceResponses.eventId, eventId))
    .groupBy(attendanceResponses.status);

  const counts: AttendanceCounts = {
    ...EMPTY_ATTENDANCE_COUNTS,
  };

  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return counts;
}

function scheduleAttendanceRefresh(
  eventId: number,
  discordGuildId: string,
  message: Message,
): void {
  /*
   * A refresh is already due for this specific Discord message.
   * Its database query will include all responses committed before it runs.
   */
  if (attendanceRefreshTimers.has(message.id)) {
    return;
  }

  const timer = setTimeout(() => {
    attendanceRefreshTimers.delete(message.id);

    void refreshAttendanceMessage(eventId, discordGuildId, message).catch(
      (error: unknown) => {
        console.error(
          `Failed to refresh attendance message ${message.id}:`,
          error,
        );
      },
    );
  }, ATTENDANCE_REFRESH_DELAY_MS);

  /*
   * This housekeeping timer should not keep Node alive during shutdown.
   */
  timer.unref();

  attendanceRefreshTimers.set(message.id, timer);
}

async function refreshAttendanceMessage(
  eventId: number,
  discordGuildId: string,
  message: Message,
): Promise<void> {
  const event = await findAttendanceEvent(eventId, discordGuildId, message.id);

  if (!event) {
    return;
  }

  const counts = await getAttendanceCounts(eventId);

  const attendanceClosed =
    event.status !== "open" ||
    (event.attendanceClosesAt !== null &&
      event.attendanceClosesAt <= new Date());

  await message.edit({
    embeds: [
      buildAttendanceEmbed(
        {
          id: event.eventId,
          audienceName: event.audienceName,

          timezone: event.timezone,
          showDetailedDeadline: event.showDetailedDeadline,
          name: event.name,
          description: event.description,
          eventTypeName: event.eventTypeName,
          startsAt: event.startsAt,

          attendanceClosesAt: event.attendanceClosesAt,

          status: event.status,
        },
        counts,
      ),
    ],

    components: [
      buildAttendanceButtons(event.eventId, counts, attendanceClosed),
    ],
  });
}
