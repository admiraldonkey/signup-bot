import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventOrganiserAssignments,
  events,
  guildSettings,
} from "../db/schema.js";

export type OrganiserCoverClaimContextResult =
  | {
      kind: "event_unavailable";
    }
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    }
  | {
      kind: "role_not_configured";
    }
  | {
      kind: "eligible";

      event: {
        id: number;

        name: string;

        guildDatabaseId: number;

        eventOrganiserRoleId: string;
      };
    };

export type ClaimEventOrganiserCoverResult =
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    }
  | {
      kind: "active_assignment";
    }
  | {
      kind: "cover_taken";
    }
  | {
      kind: "ownership_lost";
    }
  | {
      kind: "claimed";

      assignmentId: number;
    };

/**
 * Loads the non-authoritative Discord-facing eligibility context for an
 * organiser cover claim.
 *
 * This allows the interaction layer to validate Discord guild membership and
 * the configured Event Organiser role before attempting the authoritative
 * ownership transition.
 */
export async function getOrganiserCoverClaimContext(input: {
  eventId: number;

  discordGuildId: string;
}): Promise<OrganiserCoverClaimContextResult> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      endsAt: events.endsAt,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,

      organisersEnabled: guildSettings.organisersEnabled,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .leftJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, input.eventId))
    .limit(1);

  if (!event || event.discordGuildId !== input.discordGuildId) {
    return {
      kind: "event_unavailable",
    };
  }

  if (!event.organisersEnabled) {
    return {
      kind: "organisers_disabled",
    };
  }

  const now = new Date();

  if (
    event.status === "cancelled" ||
    event.status === "completed" ||
    (event.endsAt !== null && event.endsAt <= now)
  ) {
    return {
      kind: "event_inactive",
    };
  }

  if (!event.eventOrganiserRoleId) {
    return {
      kind: "role_not_configured",
    };
  }

  return {
    kind: "eligible",

    event: {
      id: event.id,

      name: event.name,

      guildDatabaseId: event.guildDatabaseId,

      eventOrganiserRoleId: event.eventOrganiserRoleId,
    },
  };
}

/**
 * Claims active organiser ownership for a cover volunteer.
 *
 * This operation owns the authoritative PostgreSQL transition and its
 * concurrency checks. Discord role validation, presentation and auditing
 * remain the caller's responsibility.
 */
export async function claimEventOrganiserCover(input: {
  eventId: number;

  organiserUserId: string;

  displayNameSnapshot: string;
}): Promise<ClaimEventOrganiserCoverResult> {
  /*
   * Lock the event lifecycle row before checking or creating organiser state.
   * Terminal lifecycle transitions and cover claims therefore share one
   * authoritative ordering boundary.
   */
  const [eventIdentity] = await db
    .select({
      guildDatabaseId: events.ownerGuildId,
    })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);

  if (!eventIdentity) {
    return {
      kind: "event_inactive",
    };
  }
  const claimResult = await db.transaction(async (transaction) => {
    /*
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
      .where(eq(guildSettings.guildId, eventIdentity.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!featureSettings?.organisersEnabled) {
      return {
        kind: "organisers_disabled",
      } as const;
    }
    const [lockedEvent] = await transaction
      .select({
        status: events.status,

        endsAt: events.endsAt,
      })
      .from(events)
      .where(eq(events.id, input.eventId))
      .limit(1)
      .for("update");

    const now = new Date();

    if (
      !lockedEvent ||
      lockedEvent.status === "cancelled" ||
      lockedEvent.status === "completed" ||
      (lockedEvent.endsAt !== null && lockedEvent.endsAt <= now)
    ) {
      return {
        kind: "event_inactive",
      } as const;
    }

    const [activeAssignment] = await transaction
      .select({
        id: eventOrganiserAssignments.id,
      })
      .from(eventOrganiserAssignments)
      .where(
        and(
          eq(eventOrganiserAssignments.eventId, input.eventId),

          eq(eventOrganiserAssignments.isCurrent, true),

          isNotNull(eventOrganiserAssignments.activatedAt),

          inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
        ),
      )
      .limit(1);

    if (activeAssignment) {
      return {
        kind: "active_assignment",
      } as const;
    }

    const [coverAssignment] = await transaction
      .insert(eventOrganiserAssignments)
      .values({
        eventId: input.eventId,

        slot: "cover",

        discordUserId: input.organiserUserId,

        displayNameSnapshot: input.displayNameSnapshot,

        status: "confirmed",

        isCurrent: true,

        assignedByUserId: input.organiserUserId,

        activatedAt: now,

        responseDeadlineAt: null,

        respondedAt: now,

        updatedAt: now,
      })
      /*
       * The partial unique current-cover constraint protects simultaneous
       * Claim Event presses from creating multiple current covers.
       */
      .onConflictDoNothing()
      .returning({
        id: eventOrganiserAssignments.id,
      });

    if (!coverAssignment) {
      return {
        kind: "cover_taken",
      } as const;
    }

    return {
      kind: "created",

      assignmentId: coverAssignment.id,

      createdAt: now,
    } as const;
  });

  if (
    claimResult.kind === "organisers_disabled" ||
    claimResult.kind === "event_inactive" ||
    claimResult.kind === "active_assignment" ||
    claimResult.kind === "cover_taken"
  ) {
    return claimResult;
  }

  /*
   * Preserve the existing defensive second check for a primary or backup
   * assignment which may have been created through another ownership path
   * around the cover transaction.
   */
  const [conflictingAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, input.eventId),

        ne(eventOrganiserAssignments.id, claimResult.assignmentId),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (conflictingAssignment) {
    await db
      .update(eventOrganiserAssignments)
      .set({
        status: "replaced",

        isCurrent: false,

        endedAt: claimResult.createdAt,

        updatedAt: claimResult.createdAt,
      })
      .where(eq(eventOrganiserAssignments.id, claimResult.assignmentId));

    return {
      kind: "ownership_lost",
    };
  }

  return {
    kind: "claimed",

    assignmentId: claimResult.assignmentId,
  };
}
