import { db } from "../db/client.js";

import {
  eventOrganiserAssignments,
  eventPingRoles,
  events,
  scheduledActions,
} from "../db/schema.js";

export type EventPingRoleSnapshot = {
  discordRoleId: string;

  roleName: string;
};

export type EventOrganiserSnapshot = {
  discordUserId: string;

  displayNameSnapshot: string;
};

export type CreateStoredEventInput = {
  guildDatabaseId: number;

  templateId: number | null;

  eventTypeId: number;

  audienceId: number | null;

  timezone: string;

  showDetailedDeadline: boolean;

  name: string;

  description: string | null;

  startsAt: Date;

  endsAt: Date;

  signupsEnabled: boolean;

  attendanceClosesAt: Date | null;

  publishMinutesBeforeStart: number | null;

  publicationChannelId: string;

  scheduledPublicationAt: Date | null;

  createdByUserId: string;

  pingRoles: EventPingRoleSnapshot[];

  primaryOrganiser: EventOrganiserSnapshot | null;

  backupOrganiser: EventOrganiserSnapshot | null;
};

export type CreateStoredEventResult = {
  event: {
    id: number;

    timezone: string;

    showDetailedDeadline: boolean;

    name: string;

    startsAt: Date;

    signupsEnabled: boolean;

    attendanceClosesAt: Date | null;
  };
};

/**
 * Creates the authoritative unpublished database representation of an event.
 *
 * Discord option parsing, member/role resolution, publication and user-facing
 * responses belong to the calling adapter.
 *
 * This service deliberately creates organiser assignments as dormant.
 * Organiser responsibility begins only when publishStoredEvent() activates
 * the primary assignment.
 */
export async function createStoredEvent(
  input: CreateStoredEventInput,
): Promise<CreateStoredEventResult> {
  /*
   * These are domain invariants rather than Discord-command validation.
   *
   * Keeping them here protects future callers such as recurring template
   * generation, which will not pass through /event create.
   */
  if (input.backupOrganiser && !input.primaryOrganiser) {
    throw new Error("A backup organiser requires a primary organiser.");
  }

  if (
    input.primaryOrganiser &&
    input.backupOrganiser &&
    input.primaryOrganiser.discordUserId === input.backupOrganiser.discordUserId
  ) {
    throw new Error(
      "The primary and backup organisers must be different users.",
    );
  }

  if (input.signupsEnabled && !input.attendanceClosesAt) {
    throw new Error("A signup event requires an attendance closing time.");
  }

  return db.transaction(async (transaction) => {
    const now = new Date();

    const [event] = await transaction
      .insert(events)
      .values({
        templateId: input.templateId,

        ownerGuildId: input.guildDatabaseId,

        eventTypeId: input.eventTypeId,

        audienceId: input.audienceId,

        timezone: input.timezone,

        showDetailedDeadline: input.showDetailedDeadline,

        name: input.name,

        description: input.description,

        startsAt: input.startsAt,

        endsAt: input.endsAt,

        /*
         * An unpublished event exists internally but attendance has not
         * yet opened to members.
         */
        attendanceOpensAt: null,

        signupsEnabled: input.signupsEnabled,

        attendanceClosesAt: input.attendanceClosesAt,

        roleRequestsOpenAt: null,

        publishedAt: null,

        publishMinutesBeforeStart: input.publishMinutesBeforeStart,

        /*
         * Snapshot the intended publication destination. A later change
         * to guild defaults must not silently move this event.
         */
        publicationChannelId: input.publicationChannelId,

        status: "scheduled",

        createdByUserId: input.createdByUserId,

        updatedAt: now,
      })
      .returning({
        id: events.id,

        timezone: events.timezone,

        showDetailedDeadline: events.showDetailedDeadline,

        name: events.name,

        startsAt: events.startsAt,

        signupsEnabled: events.signupsEnabled,

        attendanceClosesAt: events.attendanceClosesAt,
      });

    if (!event) {
      throw new Error("The database did not return the created event.");
    }

    if (input.pingRoles.length > 0) {
      await transaction.insert(eventPingRoles).values(
        input.pingRoles.map((role, index) => ({
          eventId: event.id,

          discordRoleId: role.discordRoleId,

          roleName: role.roleName,

          sortOrder: index,
        })),
      );
    }

    if (input.primaryOrganiser) {
      const [assignment] = await transaction
        .insert(eventOrganiserAssignments)
        .values({
          eventId: event.id,

          slot: "primary",

          discordUserId: input.primaryOrganiser.discordUserId,

          displayNameSnapshot: input.primaryOrganiser.displayNameSnapshot,

          status: "pending",

          isCurrent: true,

          assignedByUserId: input.createdByUserId,

          /*
           * Organiser responsibility begins when the event becomes
           * public, not when its internal record is created.
           */
          activatedAt: null,

          responseDeadlineAt: null,

          updatedAt: now,
        })
        .returning({
          id: eventOrganiserAssignments.id,
        });

      if (!assignment) {
        throw new Error(
          "The database did not return the primary organiser assignment.",
        );
      }
    }

    if (input.backupOrganiser) {
      await transaction.insert(eventOrganiserAssignments).values({
        eventId: event.id,

        slot: "backup",

        discordUserId: input.backupOrganiser.discordUserId,

        displayNameSnapshot: input.backupOrganiser.displayNameSnapshot,

        status: "pending",

        isCurrent: true,

        assignedByUserId: input.createdByUserId,

        activatedAt: null,

        responseDeadlineAt: null,

        updatedAt: now,
      });
    }

    if (input.scheduledPublicationAt) {
      await transaction.insert(scheduledActions).values({
        eventId: event.id,

        actionKey: "publish_event",

        dueAt: input.scheduledPublicationAt,

        status: "pending",

        attemptCount: 0,

        updatedAt: now,
      });
    }

    if (input.signupsEnabled && input.attendanceClosesAt) {
      await transaction.insert(scheduledActions).values({
        eventId: event.id,

        actionKey: "close_attendance",

        dueAt: input.attendanceClosesAt,

        status: "pending",

        attemptCount: 0,

        updatedAt: now,
      });
    }

    await transaction.insert(scheduledActions).values({
      eventId: event.id,

      actionKey: "complete_event",

      dueAt: input.endsAt,

      status: "pending",

      attemptCount: 0,

      updatedAt: now,
    });

    return {
      event,
    };
  });
}
