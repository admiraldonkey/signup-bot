import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventOrganiserAssignments } from "../db/schema.js";

export type PublicOrganiserStatus =
  | "pending"
  | "confirmed"
  | "declined"
  | "timed_out"
  | "replaced"
  | "removed";

export interface PublicOrganiserDisplay {
  discordUserId: string;

  status: PublicOrganiserStatus;
}

export async function getPublicOrganiserDisplay(
  eventId: number,
): Promise<PublicOrganiserDisplay | null> {
  const assignments = await db
    .select({
      slot: eventOrganiserAssignments.slot,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    );

  if (assignments.length === 0) {
    return null;
  }

  /*
   * Normally only one assignment is active.
   *
   * The explicit precedence provides defensive behaviour if an
   * administrator changes state during an escalation race.
   */
  const priority = {
    primary: 1,
    backup: 2,
    cover: 3,
  } as const;

  const [assignment] = assignments.sort(
    (a, b) => priority[b.slot] - priority[a.slot],
  );

  if (!assignment) {
    return null;
  }

  return {
    discordUserId: assignment.discordUserId,

    status: assignment.status,
  };
}
