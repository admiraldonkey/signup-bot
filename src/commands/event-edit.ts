import {
  ChannelType,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  type Role,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { DateTime, IANAZone } from "luxon";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import { eventMessages, eventPingRoles, events } from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import { reschedulePendingEventReminders } from "../reminders/reminder-scheduling.js";
import {
  cancelEventPublication,
  scheduleAttendanceClose,
  scheduleEventCompletion,
  scheduleEventPublication,
} from "../scheduler/action-maintenance.js";
import { rescheduleOpenRoleRequestGroupCloses } from "../role-requests/role-request-scheduling.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

const DATE_FORMAT = "yyyy-MM-dd";

const TIME_FORMAT = "HH:mm";

export async function editEvent(interaction: CachedInteraction): Promise<void> {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return;
  }

  if (!configuration.enabled) {
    await interaction.editReply(
      "Event management is currently disabled for this server.",
    );

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

      summary: "Denied /event edit command attempt.",

      targetType: "command",

      targetId: "/event edit",
    });

    await interaction.editReply(
      "You need the configured Event Admin role or the Manage Server permission.",
    );

    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      description: events.description,

      status: events.status,

      timezone: events.timezone,

      showDetailedDeadline: events.showDetailedDeadline,

      signupsEnabled: events.signupsEnabled,

      startsAt: events.startsAt,

      endsAt: events.endsAt,

      attendanceClosesAt: events.attendanceClosesAt,

      publishedAt: events.publishedAt,

      publishMinutesBeforeStart: events.publishMinutesBeforeStart,

      publicationChannelId: events.publicationChannelId,

      attendanceChannelId: eventMessages.channelId,
    })
    .from(events)
    .leftJoin(
      eventMessages,
      and(
        eq(eventMessages.eventId, events.id),

        eq(eventMessages.kind, "attendance"),

        eq(eventMessages.guildId, configuration.guildId),
      ),
    )
    .where(
      and(
        eq(events.id, eventId),

        eq(events.ownerGuildId, configuration.guildId),
      ),
    )
    .limit(1);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Cancelled or completed events cannot be edited.",
    );

    return;
  }

  const nameOption = interaction.options.getString("name")?.trim() ?? null;

  const descriptionOption =
    interaction.options.getString("description")?.trim() ?? null;

  const clearDescription = interaction.options.getBoolean("clear-description");

  const dateOption = interaction.options.getString("date")?.trim() ?? null;

  const timeOption = interaction.options.getString("time")?.trim() ?? null;

  const timezoneOption =
    interaction.options.getString("timezone")?.trim() ?? null;

  const durationOption = interaction.options.getInteger("duration-minutes");

  const closeOption = interaction.options.getInteger("close-minutes-before");

  const detailedDeadlineOption =
    interaction.options.getBoolean("detailed-deadline");

  const publishMinutesBeforeStartOption = interaction.options.getInteger(
    "publish-minutes-before-start",
  );

  const clearPublishSchedule =
    interaction.options.getBoolean("clear-publish-schedule") ?? false;

  if (publishMinutesBeforeStartOption !== null && clearPublishSchedule) {
    await interaction.editReply(
      "Choose either a new publication schedule or `clear-publish-schedule`, not both.",
    );

    return;
  }

  if (
    event.publishedAt &&
    (publishMinutesBeforeStartOption !== null || clearPublishSchedule)
  ) {
    await interaction.editReply(
      "This event has already been published, so its publication schedule can no longer be changed.",
    );

    return;
  }

  /*
   * Signup-specific settings do not apply to announcement-style
   * events where attendance signups were disabled at creation.
   */
  if (
    !event.signupsEnabled &&
    (closeOption !== null || detailedDeadlineOption !== null)
  ) {
    await interaction.editReply(
      "This event does not use attendance signups, so its signup deadline settings cannot be edited.",
    );

    return;
  }

  const roleOptionNames = [
    "ping-role-1",
    "ping-role-2",
    "ping-role-3",
    "ping-role-4",
  ] as const;

  const selectedRoles = roleOptionNames
    .map((optionName) => interaction.options.getRole(optionName))
    .filter((role): role is Role => role !== null);

  const pingRolesProvided = selectedRoles.length > 0;

  const anyChangeRequested =
    nameOption !== null ||
    descriptionOption !== null ||
    clearDescription === true ||
    dateOption !== null ||
    timeOption !== null ||
    timezoneOption !== null ||
    durationOption !== null ||
    closeOption !== null ||
    detailedDeadlineOption !== null ||
    publishMinutesBeforeStartOption !== null ||
    clearPublishSchedule ||
    pingRolesProvided;

  if (!anyChangeRequested) {
    await interaction.editReply("No changes were supplied.");

    return;
  }

  if (descriptionOption !== null && clearDescription === true) {
    await interaction.editReply(
      "Choose either a new description or `clear-description`, not both.",
    );

    return;
  }

  const targetTimezone = timezoneOption ?? event.timezone;

  if (!IANAZone.isValidZone(targetTimezone)) {
    await interaction.editReply(
      "The supplied timezone is not a valid IANA timezone. Use the autocomplete list.",
    );

    return;
  }

  const currentLocalStart = DateTime.fromJSDate(event.startsAt, {
    zone: event.timezone,
  });

  const hasStartChange =
    dateOption !== null || timeOption !== null || timezoneOption !== null;

  let newStartsAt = event.startsAt;

  if (hasStartChange) {
    const targetDate = dateOption ?? currentLocalStart.toFormat(DATE_FORMAT);

    const targetTime = timeOption ?? currentLocalStart.toFormat(TIME_FORMAT);

    const parsedStart = parseEventDateTime(
      targetDate,
      targetTime,
      targetTimezone,
    );

    if (!parsedStart.ok) {
      await interaction.editReply(parsedStart.error);

      return;
    }

    newStartsAt = parsedStart.value.toJSDate();

    if (newStartsAt <= new Date()) {
      await interaction.editReply(
        "The edited event start time must be in the future.",
      );

      return;
    }
  }

  const timingChangeRequested =
    hasStartChange || durationOption !== null || closeOption !== null;

  if (
    timingChangeRequested &&
    !hasStartChange &&
    event.startsAt <= new Date()
  ) {
    await interaction.editReply(
      "The schedule of an event that has already started cannot be altered unless you provide a new future date/time.",
    );

    return;
  }

  let currentDurationMinutes: number | null = null;

  if (event.endsAt) {
    currentDurationMinutes = Math.round(
      (event.endsAt.getTime() - event.startsAt.getTime()) / 60_000,
    );
  }

  /*
   * If an older/event record has no stored end time, we cannot
   * preserve its duration when moving the start time. Require the
   * admin to supply an explicit duration instead of inventing one.
   */
  if (
    hasStartChange &&
    durationOption === null &&
    currentDurationMinutes === null
  ) {
    await interaction.editReply(
      [
        "This event does not have a stored end time, so its existing duration cannot be preserved.",
        "",
        "When changing its date, time or timezone, also provide `duration-minutes`.",
      ].join("\n"),
    );

    return;
  }

  const newDurationMinutes = durationOption ?? currentDurationMinutes;

  let newEndsAt: Date | null = event.endsAt;

  if (hasStartChange || durationOption !== null) {
    /*
     * At this point newDurationMinutes cannot be null:
     * - durationOption was supplied, or
     * - an existing duration was successfully calculated above.
     */
    if (newDurationMinutes === null) {
      throw new Error("Unable to determine the edited event duration.");
    }

    newEndsAt = new Date(newStartsAt.getTime() + newDurationMinutes * 60_000);
  }

  /*
   * Announcement-style events deliberately have no attendance
   * closing time.
   */
  let newAttendanceClosesAt = event.signupsEnabled
    ? event.attendanceClosesAt
    : null;

  if (event.signupsEnabled) {
    if (closeOption !== null) {
      newAttendanceClosesAt = new Date(
        newStartsAt.getTime() - closeOption * 60_000,
      );
    } else if (hasStartChange && event.attendanceClosesAt) {
      /*
       * Preserve the existing relative signup-close offset when the
       * event moves but the admin did not supply a new one.
       */
      const existingOffsetMinutes = Math.round(
        (event.startsAt.getTime() - event.attendanceClosesAt.getTime()) /
          60_000,
      );

      newAttendanceClosesAt = new Date(
        newStartsAt.getTime() - existingOffsetMinutes * 60_000,
      );
    }
  }

  if (
    event.signupsEnabled &&
    (event.status === "open" || event.status === "scheduled") &&
    newAttendanceClosesAt &&
    newAttendanceClosesAt <= new Date()
  ) {
    await interaction.editReply(
      [
        "The edited signup deadline would already have passed.",
        "",
        "Choose a later event time or a smaller `close-minutes-before` value.",
      ].join("\n"),
    );

    return;
  }

  let newPublishMinutesBeforeStart = event.publishMinutesBeforeStart;

  if (publishMinutesBeforeStartOption !== null) {
    newPublishMinutesBeforeStart = publishMinutesBeforeStartOption;
  }

  if (clearPublishSchedule) {
    newPublishMinutesBeforeStart = null;
  }

  const newScheduledPublicationAt =
    !event.publishedAt && newPublishMinutesBeforeStart !== null
      ? new Date(newStartsAt.getTime() - newPublishMinutesBeforeStart * 60_000)
      : null;

  const publicationTimingAffected =
    !event.publishedAt &&
    (hasStartChange ||
      closeOption !== null ||
      publishMinutesBeforeStartOption !== null ||
      clearPublishSchedule);

  if (
    publicationTimingAffected &&
    newScheduledPublicationAt &&
    newScheduledPublicationAt <= new Date()
  ) {
    await interaction.editReply(
      [
        "The edited publication schedule would already have passed.",
        "",
        "Choose a later event time or a smaller `publish-minutes-before-start` value.",
      ].join("\n"),
    );

    return;
  }

  if (
    publicationTimingAffected &&
    newScheduledPublicationAt &&
    event.signupsEnabled &&
    newAttendanceClosesAt &&
    newScheduledPublicationAt >= newAttendanceClosesAt
  ) {
    await interaction.editReply(
      [
        "The edited publication time would occur after the signup deadline.",
        "",
        "Publication must occur before attendance signups close.",
      ].join("\n"),
    );

    return;
  }

  const uniqueRoles = pingRolesProvided
    ? [...new Map(selectedRoles.map((role) => [role.id, role])).values()]
    : [];

  if (pingRolesProvided) {
    for (const role of uniqueRoles) {
      if (role.id === interaction.guild.id) {
        await interaction.editReply(
          "`@everyone` cannot be used as an event ping role.",
        );

        return;
      }

      if (role.managed) {
        await interaction.editReply(
          `The managed role **${role.name}** cannot be used as an event ping role.`,
        );

        return;
      }
    }

    const publicationChannelId =
      event.attendanceChannelId ??
      event.publicationChannelId ??
      configuration.attendanceChannelId;

    if (!publicationChannelId) {
      await interaction.editReply(
        "No publication channel is available for this event or server.",
      );

      return;
    }

    const channel =
      await interaction.guild.channels.fetch(publicationChannelId);

    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    ) {
      await interaction.editReply(
        "The event's publication channel is no longer available.",
      );

      return;
    }

    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());

    const permissions = channel.permissionsFor(botMember);

    for (const role of uniqueRoles) {
      if (
        !role.mentionable &&
        !permissions.has(PermissionFlagsBits.MentionEveryone)
      ) {
        await interaction.editReply(
          `The bot cannot mention **${role.name}** in the event publication channel.`,
        );

        return;
      }
    }
  }

  const newName = nameOption ?? event.name;

  const newDescription =
    clearDescription === true ? null : (descriptionOption ?? event.description);

  const newDetailedDeadline = event.signupsEnabled
    ? (detailedDeadlineOption ?? event.showDetailedDeadline)
    : false;

  const changedFields: string[] = [];

  if (nameOption !== null) {
    changedFields.push("name");
  }

  if (descriptionOption !== null || clearDescription === true) {
    changedFields.push("description");
  }

  if (dateOption !== null) {
    changedFields.push("date");
  }

  if (timeOption !== null) {
    changedFields.push("time");
  }

  if (timezoneOption !== null) {
    changedFields.push("timezone");
  }

  if (durationOption !== null) {
    changedFields.push("duration");
  }

  if (closeOption !== null) {
    changedFields.push("signup deadline");
  }

  if (detailedDeadlineOption !== null) {
    changedFields.push("deadline display");
  }

  if (publishMinutesBeforeStartOption !== null) {
    changedFields.push("publication schedule");
  }

  if (clearPublishSchedule) {
    changedFields.push("publication schedule removed");
  }

  if (pingRolesProvided) {
    changedFields.push("ping roles");
  }

  const now = new Date();

  /*
   * An unpublished signup event may have automatically reached its
   * old signup deadline and become closed before an admin moves it.
   *
   * If its new deadline is in the future, restore the internal draft
   * state to scheduled. Published events are never implicitly reopened.
   */
  const newStatus =
    !event.publishedAt &&
    event.signupsEnabled &&
    event.status === "closed" &&
    newAttendanceClosesAt &&
    newAttendanceClosesAt > now
      ? ("scheduled" as const)
      : event.status;

  const editApplied = await db.transaction(async (transaction) => {
    const [updatedEvent] = await transaction
      .update(events)
      .set({
        name: newName,

        status: newStatus,

        description: newDescription,

        timezone: targetTimezone,

        startsAt: newStartsAt,

        endsAt: newEndsAt,

        attendanceClosesAt: newAttendanceClosesAt,

        showDetailedDeadline: newDetailedDeadline,

        publishMinutesBeforeStart: newPublishMinutesBeforeStart,

        publicationChannelId: event.publishedAt
          ? event.publicationChannelId
          : (event.publicationChannelId ?? configuration.attendanceChannelId),

        updatedAt: now,
      })
      .where(
        and(
          eq(events.id, event.id),
          eq(events.ownerGuildId, configuration.guildId),

          /*
           * The edit was validated using the lifecycle state read above.
           *
           * If cancellation, completion or another lifecycle transition
           * changes that state before this UPDATE executes, the stale edit
           * must lose rather than overwrite the newer authoritative state.
           */
          eq(events.status, event.status),
        ),
      )
      .returning({
        id: events.id,
      });

    if (!updatedEvent) {
      return false;
    }

    /*
     * Ping-role changes belong to the same edit transaction.
     * Do not apply them if the lifecycle update lost a race.
     */
    if (pingRolesProvided) {
      await transaction
        .delete(eventPingRoles)
        .where(eq(eventPingRoles.eventId, event.id));

      await transaction.insert(eventPingRoles).values(
        uniqueRoles.map((role, index) => ({
          eventId: event.id,
          discordRoleId: role.id,

          roleName: role.name,

          sortOrder: index,
        })),
      );
    }

    return true;
  });

  if (!editApplied) {
    await interaction.editReply(
      `Event #${event.id} changed while the edit command was being processed. No changes were made.`,
    );

    return;
  }

  /*
   * Keep core scheduled actions synchronised.
   *
   * Editing a closed event does NOT implicitly reopen signups.
   */
  if (
    event.signupsEnabled &&
    (newStatus === "open" || newStatus === "scheduled") &&
    newAttendanceClosesAt &&
    (hasStartChange || closeOption !== null)
  ) {
    await scheduleAttendanceClose(event.id, newAttendanceClosesAt);
  }

  if ((hasStartChange || durationOption !== null) && newEndsAt) {
    await scheduleEventCompletion(event.id, newEndsAt);
  }

  if (!event.publishedAt) {
    if (clearPublishSchedule) {
      await cancelEventPublication(event.id);
    } else if (
      newScheduledPublicationAt &&
      (hasStartChange || publishMinutesBeforeStartOption !== null)
    ) {
      await scheduleEventPublication(event.id, newScheduledPublicationAt);
    }
  }

  if (hasStartChange || closeOption !== null) {
    await reschedulePendingEventReminders(event.id);
  }

  if (hasStartChange) {
    await rescheduleOpenRoleRequestGroupCloses(event.id);
  }

  const refreshResult = event.publishedAt
    ? await refreshAttendanceMessage(interaction.guild, event.id)
    : null;

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.edit",

    outcome: "success",

    summary: `Edited "${event.name}" (#${event.id}): ${changedFields.join(", ")}.`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      changedFields,

      startsAt: newStartsAt.toISOString(),

      endsAt: newEndsAt?.toISOString() ?? null,

      attendanceClosesAt: newAttendanceClosesAt?.toISOString() ?? null,

      publishMinutesBeforeStart: newPublishMinutesBeforeStart,

      scheduledPublicationAt: newScheduledPublicationAt?.toISOString() ?? null,

      timezone: targetTimezone,

      pingRoleIds: pingRolesProvided
        ? uniqueRoles.map((role) => role.id)
        : undefined,
    },
  });

  const startTimestamp = Math.floor(newStartsAt.getTime() / 1000);

  const endTimestamp = newEndsAt
    ? Math.floor(newEndsAt.getTime() / 1000)
    : null;

  const localStart = DateTime.fromJSDate(newStartsAt, {
    zone: targetTimezone,
  });

  const response = [
    `✅ **${newName}** (#${event.id}) updated.`,
    "",
    `**Changed:** ${changedFields.join(", ")}`,
    `**Starts:** <t:${startTimestamp}:F> (<t:${startTimestamp}:R>)`,
    newEndsAt && endTimestamp !== null
      ? `**Ends:** <t:${endTimestamp}:t>`
      : "**Ends:** Not specified",
    `**Scheduled as:** ${localStart.toFormat("dd LLL yyyy, HH:mm ZZZZ")}`,
  ];

  if (event.publishedAt && event.signupsEnabled && newStatus === "closed") {
    response.push(
      "",
      "ℹ️ Attendance was already closed and remains closed. Use `/event reopen` if signups should reopen.",
    );
  }

  if (refreshResult && !refreshResult.ok) {
    response.push(
      "",
      "⚠️ The database was updated, but the existing attendance message could not be refreshed.",
    );
  }

  if (!event.publishedAt) {
    if (newScheduledPublicationAt) {
      const publicationTimestamp = Math.floor(
        newScheduledPublicationAt.getTime() / 1000,
      );

      response.push(
        "",
        `🕒 This event remains unpublished and is scheduled to publish <t:${publicationTimestamp}:F> (<t:${publicationTimestamp}:R>).`,
        `Use \`/event publish event-id:${event.id}\` to publish it earlier.`,
      );
    } else {
      response.push(
        "",
        `ℹ️ This event remains unpublished. Use \`/event publish event-id:${event.id}\` when it should go live.`,
      );
    }
  }

  await interaction.editReply({
    content: response.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

type ParsedEventDateTime =
  | {
      ok: true;
      value: DateTime;
    }
  | {
      ok: false;
      error: string;
    };

function parseEventDateTime(
  dateText: string,
  timeText: string,
  timezone: string,
): ParsedEventDateTime {
  const combined = `${dateText} ${timeText}`;

  const parsed = DateTime.fromFormat(
    combined,
    `${DATE_FORMAT} ${TIME_FORMAT}`,
    {
      zone: timezone,

      locale: "en-GB",

      setZone: true,
    },
  );

  if (
    !parsed.isValid ||
    parsed.toFormat(`${DATE_FORMAT} ${TIME_FORMAT}`) !== combined
  ) {
    return {
      ok: false,

      error: "The supplied date/time is invalid. Use `YYYY-MM-DD` and `HH:mm`.",
    };
  }

  /*
   * During the autumn DST transition some local clock times occur
   * twice. Refuse those rather than silently choosing one.
   */
  if (parsed.getPossibleOffsets().length > 1) {
    return {
      ok: false,

      error:
        "That local time is ambiguous because of a daylight-saving transition. Choose a different time.",
    };
  }

  return {
    ok: true,
    value: parsed,
  };
}
