import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventOrganiserAssignments,
  events,
  guildSettings,
} from "../db/schema.js";
import { cancelOrganiserResponseActions } from "./organiser-scheduling.js";
import type {
  OrganiserAssignmentSlot,
  OrganiserAssignmentStatus,
  OrganiserResponseAction,
} from "./organiser-types.js";

type SavedOrganiserResponse = {
  id: number;

  eventId: number;

  slot: OrganiserAssignmentSlot;

  discordUserId: string;

  eventName: string;

  guildDatabaseId: number;

  discordGuildId: string;
};

export type {
  OrganiserAssignmentStatus,
  OrganiserResponseAction,
} from "./organiser-types.js";

export type RecordOrganiserResponseResult =
  | {
      kind: "assignment_not_found";
    }
  | {
      kind: "wrong_user";
    }
  | {
      kind: "assignment_not_current";
    }
  | {
      kind: "assignment_standby";
    }
  | {
      kind: "already_responded";

      status: OrganiserAssignmentStatus;
    }
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    }
  | {
      kind: "assignment_changed";
    }
  | {
      kind: "saved";

      assignment: SavedOrganiserResponse;
    };

/**
 * Records a confirm/decline response to an active organiser assignment.
 *
 * This operation owns validation of the authoritative assignment state,
 * persistence of the response and cancellation of obsolete response actions.
 *
 * Discord message updates, warning reconciliation, escalation, auditing and
 * user-facing responses remain the caller's responsibility.
 */
export async function recordOrganiserResponse(input: {
  assignmentId: number;

  respondingUserId: string;

  action: OrganiserResponseAction;
}): Promise<RecordOrganiserResponseResult> {
  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      eventId: eventOrganiserAssignments.eventId,

      slot: eventOrganiserAssignments.slot,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,

      isCurrent: eventOrganiserAssignments.isCurrent,

      activatedAt: eventOrganiserAssignments.activatedAt,

      eventName: events.name,

      eventStatus: events.status,

      guildDatabaseId: discordGuilds.id,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(eventOrganiserAssignments.id, input.assignmentId))
    .limit(1);

  if (!assignment) {
    return {
      kind: "assignment_not_found",
    };
  }

  if (input.respondingUserId !== assignment.discordUserId) {
    return {
      kind: "wrong_user",
    };
  }

  if (!assignment.isCurrent) {
    return {
      kind: "assignment_not_current",
    };
  }

  if (!assignment.activatedAt) {
    return {
      kind: "assignment_standby",
    };
  }

  if (assignment.status !== "pending") {
    return {
      kind: "already_responded",

      status: assignment.status,
    };
  }

  if (
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    return {
      kind: "event_inactive",
    };
  }

  const now = new Date();

  const updateValues =
    input.action === "confirm"
      ? {
          status: "confirmed" as const,

          respondedAt: now,

          updatedAt: now,
        }
      : {
          status: "declined" as const,

          isCurrent: false,

          respondedAt: now,

          endedAt: now,

          updatedAt: now,
        };

  /*
   * The initial read provides useful fast validation but may become stale
   * before the response is written.
   *
   * Lock the event lifecycle row first so organiser responses and terminal
   * event transitions have one authoritative ordering boundary.
   */
  const saveResult = await db.transaction(async (transaction) => {
    /*
     * The organiser feature row is the shared ordering boundary between
     * organiser mutations and disabling the organiser subsystem.
     *
     * Hold a shared lock on the organiser feature row for the lifetime of the
     * authoritative mutation.
     *
     * Other organiser workflows may proceed concurrently, while the exclusive
     * organiser-disable transition must wait for this operation to finish.
     */
    const [featureSettings] = await transaction
      .select({
        organisersEnabled: guildSettings.organisersEnabled,
      })
      .from(guildSettings)
      .where(eq(guildSettings.guildId, assignment.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!featureSettings?.organisersEnabled) {
      return {
        kind: "organisers_disabled",
      } as const;
    }

    /*
     * The initial read provides useful fast validation but may become stale
     * before the response is written.
     *
     * Lock the event lifecycle row so organiser responses and terminal event
     * transitions have one authoritative ordering boundary.
     */
    const [lockedEvent] = await transaction
      .select({
        status: events.status,
      })
      .from(events)
      .where(eq(events.id, assignment.eventId))
      .limit(1)
      .for("update");

    if (
      !lockedEvent ||
      lockedEvent.status === "cancelled" ||
      lockedEvent.status === "completed"
    ) {
      return {
        kind: "event_inactive",
      } as const;
    }

    const [updatedAssignment] = await transaction
      .update(eventOrganiserAssignments)
      .set(updateValues)
      .where(
        and(
          eq(eventOrganiserAssignments.id, assignment.id),

          eq(eventOrganiserAssignments.isCurrent, true),

          eq(eventOrganiserAssignments.status, "pending"),

          isNotNull(eventOrganiserAssignments.activatedAt),
        ),
      )
      .returning({
        id: eventOrganiserAssignments.id,
      });

    if (!updatedAssignment) {
      return {
        kind: "assignment_changed",
      } as const;
    }

    return {
      kind: "saved",
    } as const;
  });

  if (saveResult.kind === "organisers_disabled") {
    return {
      kind: "organisers_disabled",
    };
  }

  if (saveResult.kind === "event_inactive") {
    return {
      kind: "event_inactive",
    };
  }

  if (saveResult.kind === "assignment_changed") {
    return {
      kind: "assignment_changed",
    };
  }

  /*
   * The organiser response is now authoritative. Its warning and timeout
   * scheduler work is obsolete.
   */
  await cancelOrganiserResponseActions(assignment.eventId, assignment.id);

  return {
    kind: "saved",

    assignment: {
      id: assignment.id,

      eventId: assignment.eventId,

      slot: assignment.slot,

      discordUserId: assignment.discordUserId,

      eventName: assignment.eventName,

      guildDatabaseId: assignment.guildDatabaseId,

      discordGuildId: assignment.discordGuildId,
    },
  };
}
