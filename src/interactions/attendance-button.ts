import { type ButtonInteraction, MessageFlags } from "discord.js";
import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { attendanceResponses, events } from "../db/schema.js";
import {
  parseAttendanceCustomId,
  type AttendanceStatus,
} from "../events/attendance-message.js";
import {
  getAttendanceEventForInteraction,
  refreshAttendanceMessage,
} from "../events/attendance-refresh.js";

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

  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Attendance buttons can only be used inside a server.",
    );

    return true;
  }

  const event = await getAttendanceEventForInteraction(
    parsed.eventId,
    interaction.guildId,
    interaction.channelId,
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

    scheduleAttendanceRefresh(interaction.guild, event.eventId);

    return true;
  }

  /*
   * Until the scheduler exists, a click after the deadline can
   * perform the overdue state transition itself.
   */
  if (
    (event.attendanceClosesAt && event.attendanceClosesAt <= now) ||
    event.startsAt <= now
  ) {
    await db
      .update(events)
      .set({
        status: "closed",
        updatedAt: now,
      })
      .where(and(eq(events.id, event.eventId), eq(events.status, "open")));

    await interaction.editReply(
      "The attendance deadline for this event has passed.",
    );

    scheduleAttendanceRefresh(interaction.guild, event.eventId);

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

  await interaction.editReply(STATUS_CONFIRMATIONS[parsed.status]);

  scheduleAttendanceRefresh(interaction.guild, event.eventId);

  return true;
}

function scheduleAttendanceRefresh(
  guild: ButtonInteraction<"cached">["guild"],
  eventId: number,
): void {
  const refreshKey = `${guild.id}:${eventId}`;

  if (attendanceRefreshTimers.has(refreshKey)) {
    return;
  }

  const timer = setTimeout(() => {
    attendanceRefreshTimers.delete(refreshKey);

    void refreshAttendanceMessage(guild, eventId).catch((error: unknown) => {
      console.error(
        `Failed to refresh attendance for event ${eventId}:`,
        error,
      );
    });
  }, ATTENDANCE_REFRESH_DELAY_MS);

  timer.unref();

  attendanceRefreshTimers.set(refreshKey, timer);
}
