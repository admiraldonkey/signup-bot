import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type Message,
} from "discord.js";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventAudiences,
  eventMessages,
  eventOrganiserAssignments,
  eventPingRoles,
  events,
  eventTypes,
  guildSettings,
  scheduledActions,
} from "../db/schema.js";
import {
  buildAttendanceButtons,
  buildAttendanceEmbed,
  EMPTY_ATTENDANCE_COUNTS,
} from "./attendance-message.js";
import { getPublicOrganiserDisplay } from "./organiser-display.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "./organiser-notification.js";
import {
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
} from "../organisers/organiser-scheduling.js";

export type EventPublicationFailureReason =
  | "not-found"
  | "already-published"
  | "inactive"
  | "event-started"
  | "signup-closed";

export type EventPublicationResult =
  | {
      ok: true;

      eventId: number;

      eventName: string;

      messageUrl: string;

      primaryOrganiserNotification: OrganiserNotificationDelivery | null;
    }
  | {
      ok: false;

      reason: EventPublicationFailureReason;

      eventName: string | null;
    };

export async function publishStoredEvent(
  guild: Guild,
  eventId: number,
): Promise<EventPublicationResult> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      description: events.description,

      timezone: events.timezone,

      showDetailedDeadline: events.showDetailedDeadline,

      startsAt: events.startsAt,

      signupsEnabled: events.signupsEnabled,

      attendanceClosesAt: events.attendanceClosesAt,

      status: events.status,

      publishedAt: events.publishedAt,

      publicationChannelId: events.publicationChannelId,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventTypeName: eventTypes.name,

      audienceName: eventAudiences.name,

      defaultAttendanceChannelId: guildSettings.defaultAttendanceChannelId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,

      organiserPrimaryResponseMinutes:
        guildSettings.organiserPrimaryResponseMinutes,

      organiserWarningMinutesBefore:
        guildSettings.organiserWarningMinutesBefore,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .leftJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
    .leftJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(
      and(
        eq(events.id, eventId),

        eq(discordGuilds.discordGuildId, guild.id),
      ),
    )
    .limit(1);

  if (!event) {
    return {
      ok: false,

      reason: "not-found",

      eventName: null,
    };
  }

  if (event.publishedAt) {
    return {
      ok: false,

      reason: "already-published",

      eventName: event.name,
    };
  }

  if (event.status === "cancelled" || event.status === "completed") {
    return {
      ok: false,

      reason: "inactive",

      eventName: event.name,
    };
  }

  const now = new Date();

  if (event.startsAt <= now) {
    return {
      ok: false,

      reason: "event-started",

      eventName: event.name,
    };
  }

  if (
    event.signupsEnabled &&
    event.attendanceClosesAt &&
    event.attendanceClosesAt <= now
  ) {
    return {
      ok: false,

      reason: "signup-closed",

      eventName: event.name,
    };
  }

  /*
   * Prefer the event's snapshotted publication destination.
   *
   * The guild default remains a fallback for legacy events created
   * before publicationChannelId existed.
   */
  const channelId =
    event.publicationChannelId ?? event.defaultAttendanceChannelId;

  if (!channelId) {
    throw new Error(
      "No attendance/publication channel is configured for this event.",
    );
  }

  const channel = await guild.channels.fetch(channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isSendable()
  ) {
    throw new Error(
      "The event's publication channel is unavailable or cannot receive messages.",
    );
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  if (requiredPermissions.some((permission) => !permissions.has(permission))) {
    throw new Error(
      "The bot is missing one or more required permissions in the event publication channel.",
    );
  }

  const pingRoles = await db
    .select({
      discordRoleId: eventPingRoles.discordRoleId,

      roleName: eventPingRoles.roleName,
    })
    .from(eventPingRoles)
    .where(eq(eventPingRoles.eventId, event.id))
    .orderBy(asc(eventPingRoles.sortOrder));

  for (const pingRole of pingRoles) {
    const role = await guild.roles.fetch(pingRole.discordRoleId);

    if (!role) {
      throw new Error(
        `The configured event ping role "${pingRole.roleName}" no longer exists.`,
      );
    }

    if (
      !role.mentionable &&
      !permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
      throw new Error(
        `The bot cannot mention the event role "${role.name}" in the publication channel.`,
      );
    }
  }

  /*
   * Normally a draft event's primary organiser is still dormant.
   *
   * We nevertheless support an already-active organiser defensively,
   * because older events or future admin operations may create one.
   */
  const activeOrganiser = await getPublicOrganiserDisplay(event.id);

  const [dormantPrimary] = await db
    .select({
      id: eventOrganiserAssignments.id,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.slot, "primary"),

        eq(eventOrganiserAssignments.status, "pending"),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNull(eventOrganiserAssignments.activatedAt),
      ),
    )
    .limit(1);

  /*
   * We want the newly-published message to show the primary
   * organiser immediately, even though activation is not committed
   * until after the Discord message has successfully been sent.
   */
  const organiser =
    activeOrganiser ??
    (dormantPrimary
      ? {
          discordUserId: dormantPrimary.discordUserId,

          status: "pending" as const,
        }
      : null);

  const publishedStatus = event.signupsEnabled
    ? ("open" as const)
    : ("scheduled" as const);

  let sentMessage: Message | null = null;

  try {
    sentMessage = await channel.send({
      content: pingRoles.map((role) => `<@&${role.discordRoleId}>`).join(" "),

      embeds: [
        buildAttendanceEmbed(
          {
            id: event.id,

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

            status: publishedStatus,
          },

          EMPTY_ATTENDANCE_COUNTS,
        ),
      ],

      components: event.signupsEnabled
        ? [buildAttendanceButtons(event.id, EMPTY_ATTENDANCE_COUNTS)]
        : [],

      allowedMentions: {
        parse: [],

        roles: pingRoles.map((role) => role.discordRoleId),
      },
    });

    const publicationTime = new Date();

    const publication = await db.transaction(async (transaction) => {
      /*
       * This conditional update also protects against a manual
       * publication racing the scheduler.
       *
       * Both callers could theoretically send a Discord message,
       * but only one may claim the unpublished event. The loser
       * deletes its extra Discord message below.
       */
      const [publishedEvent] = await transaction
        .update(events)
        .set({
          publishedAt: publicationTime,

          attendanceOpensAt: event.signupsEnabled ? publicationTime : null,

          status: publishedStatus,

          updatedAt: publicationTime,
        })
        .where(
          and(
            eq(events.id, event.id),

            isNull(events.publishedAt),

            inArray(events.status, ["scheduled", "open"]),
          ),
        )
        .returning({
          id: events.id,
        });

      if (!publishedEvent) {
        return {
          claimed: false as const,

          activatedPrimaryAssignmentId: null,
        };
      }

      await transaction.insert(eventMessages).values({
        eventId: event.id,

        guildId: event.guildDatabaseId,

        channelId: channel.id,

        messageId: sentMessage!.id,

        kind: "attendance",
      });

      let activatedPrimaryAssignmentId: number | null = null;

      if (dormantPrimary) {
        const activatedAt = publicationTime;

        const responseDeadlineAt = calculateOrganiserResponseDeadline(
          activatedAt,

          event.organiserPrimaryResponseMinutes ?? 80,
        );

        const [activatedAssignment] = await transaction
          .update(eventOrganiserAssignments)
          .set({
            activatedAt,

            responseDeadlineAt,

            updatedAt: activatedAt,
          })
          .where(
            and(
              eq(eventOrganiserAssignments.id, dormantPrimary.id),

              eq(eventOrganiserAssignments.isCurrent, true),

              eq(eventOrganiserAssignments.status, "pending"),

              isNull(eventOrganiserAssignments.activatedAt),
            ),
          )
          .returning({
            id: eventOrganiserAssignments.id,
          });

        if (activatedAssignment) {
          activatedPrimaryAssignmentId = activatedAssignment.id;

          const actionValues = buildOrganiserResponseActionValues({
            eventId: event.id,

            assignmentId: activatedAssignment.id,

            activatedAt,

            responseDeadlineAt,

            warningMinutesBefore: event.organiserWarningMinutesBefore ?? 15,
          });

          await transaction.insert(scheduledActions).values(actionValues);
        }
      }

      return {
        claimed: true as const,

        activatedPrimaryAssignmentId,
      };
    });

    if (!publication.claimed) {
      await sentMessage.delete().catch((error: unknown) => {
        console.error(
          `Failed to remove duplicate publication message for event ${event.id}:`,
          error,
        );
      });

      const [latest] = await db
        .select({
          publishedAt: events.publishedAt,

          status: events.status,
        })
        .from(events)
        .where(eq(events.id, event.id))
        .limit(1);

      return {
        ok: false,

        reason: latest?.publishedAt ? "already-published" : "inactive",

        eventName: event.name,
      };
    }

    let primaryOrganiserNotification: OrganiserNotificationDelivery | null =
      null;

    if (publication.activatedPrimaryAssignmentId && dormantPrimary) {
      try {
        primaryOrganiserNotification =
          await sendOrganiserAssignmentNotification({
            guild,

            assignmentId: publication.activatedPrimaryAssignmentId,

            eventId: event.id,

            eventName: event.name,

            discordUserId: dormantPrimary.discordUserId,

            slot: "primary",

            eventAdminChannelId: event.eventAdminChannelId,

            eventMessageUrl: sentMessage.url,
          });
      } catch (error) {
        /*
         * Publication has already succeeded and its database transaction
         * has committed.
         *
         * A secondary organiser-notification failure must therefore not
         * cause the successfully-published Discord message to be deleted.
         */
        console.error(
          `Failed to deliver organiser notification for published event ${event.id}:`,
          error,
        );

        primaryOrganiserNotification = "failed";
      }
    }

    return {
      ok: true,

      eventId: event.id,

      eventName: event.name,

      messageUrl: sentMessage.url,

      primaryOrganiserNotification,
    };
  } catch (error) {
    if (sentMessage) {
      await sentMessage.delete().catch((deleteError: unknown) => {
        console.error(
          `Failed to remove partially published event message for event ${event.id}:`,
          deleteError,
        );
      });
    }

    throw error;
  }
}
