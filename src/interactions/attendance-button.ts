import { type ButtonInteraction, MessageFlags } from "discord.js";
import { and, eq, sql } from "drizzle-orm";

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
import { markAttendanceCloseCompleted } from "../scheduler/action-maintenance.js";
import { refreshRoleRequestMessages } from "../role-requests/role-request-message.js";

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

  if (!event.signupsEnabled) {
    await interaction.editReply(
      "Attendance signups are not enabled for this event.",
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

    await markAttendanceCloseCompleted(event.eventId, now);

    await interaction.editReply(
      "The attendance deadline for this event has passed.",
    );

    scheduleAttendanceRefresh(interaction.guild, event.eventId);

    return true;
  }

  /*
   * The earlier event lookup is useful for fast user-facing validation, but
   * it cannot authoritatively protect this write from a concurrent lifecycle
   * change.
   *
   * Couple eligibility and persistence in one PostgreSQL statement instead.
   *
   * FOR UPDATE makes the event row the concurrency boundary. If another
   * transaction closes, cancels, completes or otherwise changes the event
   * before this statement obtains the row lock, PostgreSQL re-evaluates the
   * WHERE conditions against that newer row and the INSERT receives no
   * source row.
   */
  const writeNow = new Date();

  const attendanceWrite = await db.execute(sql`
  WITH "eligible_event" AS (
    SELECT
      ${events.id} AS "event_id"
    FROM ${events}
    WHERE
      ${events.id} = ${event.eventId}
      AND ${events.status} = 'open'
      AND ${events.signupsEnabled} = true
      AND (
        ${events.attendanceClosesAt} IS NULL
        OR ${events.attendanceClosesAt} > ${writeNow}
      )
      AND ${events.startsAt} > ${writeNow}
    FOR UPDATE
  )
  INSERT INTO ${attendanceResponses} (
    "event_id",
    "discord_user_id",
    "source_guild_id",
    "status",
    "updated_at"
  )
  SELECT
    "eligible_event"."event_id",
    ${interaction.user.id},
    ${event.guildDatabaseId},
    ${parsed.status},
    ${writeNow}
  FROM "eligible_event"
  ON CONFLICT (
    "event_id",
    "discord_user_id"
  )
  DO UPDATE SET
    "source_guild_id" =
      EXCLUDED."source_guild_id",
    "status" =
      EXCLUDED."status",
    "updated_at" =
      EXCLUDED."updated_at"
  RETURNING "event_id"
`);

  if (attendanceWrite.rowCount !== 1) {
    /*
     * Eligibility changed after the interaction's initial read.
     *
     * Do not claim success for an attendance response which the authoritative
     * database write rejected.
     */
    await interaction.editReply("Attendance is no longer open for this event.");

    scheduleAttendanceRefresh(interaction.guild, event.eventId);

    return true;
  }

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

    void Promise.all([
      refreshAttendanceMessage(guild, eventId),

      refreshRoleRequestMessages(guild, eventId),
    ]).catch((error: unknown) => {
      console.error(
        `Failed to refresh event ${eventId} after an attendance change:`,
        error,
      );
    });
  }, ATTENDANCE_REFRESH_DELAY_MS);

  timer.unref();

  attendanceRefreshTimers.set(refreshKey, timer);
}
