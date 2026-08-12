import { and, eq } from "drizzle-orm";

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
  const [assignment] = await db
    .select({
      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.slot, "primary"),

        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    )
    .limit(1);

  return assignment ?? null;
}
