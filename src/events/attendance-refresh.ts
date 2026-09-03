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
import { getPublicOrganiserDisplay } from "./organiser-display.js";

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

      eventMessageId: eventMessages.id,

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

  const channel = await guild.channels
    .fetch(event.channelId)
    .catch((error: unknown) => {
      /*
       * Discord explicitly reports that the configured channel no longer
       * exists. Treat this the same as a null channel lookup.
       *
       * Other failures remain unexpected and must not be disguised as a
       * deleted-channel/configuration problem.
       */
      if (isUnknownChannelError(error)) {
        return null;
      }

      throw error;
    });

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

  /*
   * Build the current presentation entirely from authoritative database
   * state before deciding whether we are editing the existing Discord
   * message or replacing a deleted one.
   */
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

  const organiser = await getPublicOrganiserDisplay(event.eventId);

  const messagePayload = {
    content: pingRoleContent,

    allowedMentions: {
      /*
       * Refreshes and recovery must preserve visible role mentions without
       * notifying the roles again.
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

          organiser,

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
  };

  /*
   * Normal path: the linked message still exists, so simply refresh it.
   */
  try {
    const message = await channel.messages.fetch(event.messageId);

    await message.edit(messagePayload);

    return {
      ok: true,
      messageUrl: message.url,
    };
  } catch (error: unknown) {
    /*
     * Do not create a replacement for arbitrary Discord/network errors.
     *
     * Automatic recovery is safe only when Discord explicitly tells us that
     * the stored message no longer exists.
     */
    if (!isUnknownMessageError(error)) {
      return {
        ok: false,
        reason: "message-unavailable",
      };
    }
  }

  /*
   * The authoritative event still exists and its destination channel is
   * available, but the linked Discord message has been deleted.
   *
   * Rebuild the presentation in the same channel without replaying event
   * publication or any publication-owned lifecycle behaviour.
   */
  const replacementMessage = await channel.send(messagePayload);

  let claimedReplacement:
    | {
        messageId: string;
      }
    | undefined;

  try {
    [claimedReplacement] = await db
      .update(eventMessages)
      .set({
        messageId: replacementMessage.id,

        deletedAt: null,
      })
      .where(
        and(
          eq(eventMessages.id, event.eventMessageId),

          /*
           * This is the concurrency fence.
           *
           * We may replace only the exact stale message ID which this
           * refresh originally observed.
           */
          eq(eventMessages.messageId, event.messageId),
        ),
      )
      .returning({
        messageId: eventMessages.messageId,
      });
  } catch (error) {
    /*
     * PostgreSQL remains authoritative. If the linkage could not be updated,
     * avoid knowingly leaving behind an untracked duplicate Discord message.
     */
    await replacementMessage.delete().catch((cleanupError: unknown) => {
      console.error(
        `Failed to delete replacement attendance message ${replacementMessage.id} after database recovery failure:`,
        cleanupError,
      );
    });

    throw error;
  }

  /*
   * We successfully swapped the stale Discord ID for our replacement.
   */
  if (claimedReplacement) {
    return {
      ok: true,

      messageUrl: replacementMessage.url,
    };
  }

  /*
   * Another refresh recovered this same deleted message after our initial
   * read but before our conditional update.
   *
   * Its database linkage is now authoritative. Remove our duplicate.
   */
  await replacementMessage.delete().catch((cleanupError: unknown) => {
    console.error(
      `Failed to delete duplicate recovered attendance message ${replacementMessage.id}:`,
      cleanupError,
    );
  });

  const [currentLink] = await db
    .select({
      messageId: eventMessages.messageId,
    })
    .from(eventMessages)
    .where(eq(eventMessages.id, event.eventMessageId))
    .limit(1);

  if (!currentLink || currentLink.messageId === event.messageId) {
    return {
      ok: false,
      reason: "message-unavailable",
    };
  }

  /*
   * Return the winning replacement rather than claiming that our deleted
   * duplicate succeeded.
   */
  try {
    const currentMessage = await channel.messages.fetch(currentLink.messageId);

    return {
      ok: true,

      messageUrl: currentMessage.url,
    };
  } catch {
    return {
      ok: false,
      reason: "message-unavailable",
    };
  }
}

function isUnknownMessageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    (
      error as {
        code?: unknown;
      }
    ).code === 10008
  );
}

function isUnknownChannelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    (
      error as {
        code?: unknown;
      }
    ).code === 10003
  );
}
