import { ChannelType, type Guild } from "discord.js";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  attendanceResponses,
  discordGuilds,
  eventAudiences,
  eventMessages,
  events,
  eventTypes,
  eventPingRoles,
} from "../db/schema.js";
import {
  type AttendanceCounts,
  buildAttendanceButtons,
  buildAttendanceEmbed,
  EMPTY_ATTENDANCE_COUNTS,
} from "./attendance-message.js";

export async function getAttendanceCounts(
  eventId: number,
): Promise<AttendanceCounts> {
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

export async function getAttendanceEventForInteraction(
  eventId: number,
  discordGuildId: string,
  discordChannelId: string,
  discordMessageId: string,
) {
  const [event] = await db
    .select({
      eventId: events.id,

      name: events.name,

      description: events.description,

      eventTypeName: eventTypes.name,

      audienceName: eventAudiences.name,

      timezone: events.timezone,

      showDetailedDeadline: events.showDetailedDeadline,

      startsAt: events.startsAt,

      signupsEnabled: events.signupsEnabled,

      attendanceClosesAt: events.attendanceClosesAt,

      status: events.status,

      guildDatabaseId: discordGuilds.id,
    })
    .from(events)
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .leftJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
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
        eq(eventMessages.channelId, discordChannelId),
        eq(eventMessages.messageId, discordMessageId),
        eq(discordGuilds.discordGuildId, discordGuildId),
      ),
    )
    .limit(1);

  return event ?? null;
}

export type AttendanceRefreshResult =
  | {
      ok: true;
      messageUrl: string;
    }
  | {
      ok: false;
      reason: "not-linked" | "channel-unavailable" | "message-unavailable";
    };

export async function refreshAttendanceMessage(
  guild: Guild,
  eventId: number,
): Promise<AttendanceRefreshResult> {
  const [event] = await db
    .select({
      eventId: events.id,

      name: events.name,

      description: events.description,

      eventTypeName: eventTypes.name,

      audienceName: eventAudiences.name,

      timezone: events.timezone,

      showDetailedDeadline: events.showDetailedDeadline,

      startsAt: events.startsAt,

      signupsEnabled: events.signupsEnabled,

      attendanceClosesAt: events.attendanceClosesAt,

      status: events.status,

      channelId: eventMessages.channelId,

      messageId: eventMessages.messageId,
    })
    .from(events)
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .leftJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
    .innerJoin(
      eventMessages,
      and(
        eq(eventMessages.eventId, events.id),
        eq(eventMessages.kind, "attendance"),
      ),
    )
    .innerJoin(discordGuilds, eq(discordGuilds.id, eventMessages.guildId))
    .where(
      and(eq(events.id, eventId), eq(discordGuilds.discordGuildId, guild.id)),
    )
    .limit(1);

  if (!event) {
    return {
      ok: false,
      reason: "not-linked",
    };
  }

  const channel = await guild.channels.fetch(event.channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return {
      ok: false,
      reason: "channel-unavailable",
    };
  }

  let message;

  try {
    message = await channel.messages.fetch(event.messageId);
  } catch {
    return {
      ok: false,
      reason: "message-unavailable",
    };
  }

  const counts = await getAttendanceCounts(event.eventId);

  const pingRoles = await db
    .select({
      discordRoleId: eventPingRoles.discordRoleId,
    })
    .from(eventPingRoles)
    .where(eq(eventPingRoles.eventId, event.eventId))
    .orderBy(asc(eventPingRoles.sortOrder));

  const pingRoleContent = pingRoles
    .map((role) => `<@&${role.discordRoleId}>`)
    .join(" ");

  const attendanceClosed =
    event.status !== "open" ||
    (event.attendanceClosesAt !== null &&
      event.attendanceClosesAt <= new Date());

  await message.edit({
    content: pingRoleContent,

    allowedMentions: {
      /*
       * Keep the visible role mentions without generating a fresh
       * notification merely because an admin edited/refreshed the
       * event.
       */
      parse: [],
    },

    embeds: [
      buildAttendanceEmbed(
        {
          id: event.eventId,

          name: event.name,

          description: event.description,

          eventTypeName: event.eventTypeName,

          audienceName: event.audienceName ?? "Unspecified",

          timezone: event.timezone,

          showDetailedDeadline: event.showDetailedDeadline,

          startsAt: event.startsAt,

          signupsEnabled: event.signupsEnabled,

          attendanceClosesAt: event.attendanceClosesAt,

          status: event.status,
        },
        counts,
      ),
    ],

    components: event.signupsEnabled
      ? [buildAttendanceButtons(event.eventId, counts, attendanceClosed)]
      : [],
  });

  return {
    ok: true,
    messageUrl: message.url,
  };
}
