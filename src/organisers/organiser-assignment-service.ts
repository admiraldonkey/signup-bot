import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventOrganiserAssignments, events } from "../db/schema.js";
import { cancelOrganiserResponseActions } from "./organiser-scheduling.js";

export type EditableOrganiserSlot = "primary" | "backup";

export type RemoveEventOrganiserResult =
  | {
      kind: "event_not_found";
    }
  | {
      kind: "event_inactive";
    }
  | {
      kind: "assignment_not_found";
    }
  | {
      kind: "removed";

      event: {
        id: number;
        name: string;
      };

      assignment: {
        id: number;
        discordUserId: string;
        activatedAt: Date | null;
      };
    };

/**
 * Removes the current organiser assignment for an event slot.
 *
 * This operation owns the authoritative database transition and cancellation
 * of the assignment's outstanding response actions. Discord presentation,
 * auditing and command responses remain the caller's responsibility.
 */
export async function removeEventOrganiserAssignment(input: {
  guildDatabaseId: number;
  eventId: number;
  slot: EditableOrganiserSlot;
}): Promise<RemoveEventOrganiserResult> {
  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      status: events.status,
    })
    .from(events)
    .where(
      and(
        eq(events.id, input.eventId),
        eq(events.ownerGuildId, input.guildDatabaseId),
      ),
    )
    .limit(1);

  if (!event) {
    return {
      kind: "event_not_found",
    };
  }

  if (event.status === "cancelled" || event.status === "completed") {
    return {
      kind: "event_inactive",
    };
  }

  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
      discordUserId: eventOrganiserAssignments.discordUserId,
      activatedAt: eventOrganiserAssignments.activatedAt,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),
        eq(eventOrganiserAssignments.slot, input.slot),
        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    )
    .limit(1);

  if (!assignment) {
    return {
      kind: "assignment_not_found",
    };
  }

  const now = new Date();

  await db
    .update(eventOrganiserAssignments)
    .set({
      status: "removed",
      isCurrent: false,
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),
        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    );

  await cancelOrganiserResponseActions(event.id, assignment.id);

  return {
    kind: "removed",

    event: {
      id: event.id,
      name: event.name,
    },

    assignment,
  };
}
