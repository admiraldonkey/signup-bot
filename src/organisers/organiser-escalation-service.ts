import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  eventOrganiserAssignments,
  events,
  guildSettings,
  scheduledActions,
} from "../db/schema.js";
import {
  buildOrganiserCoverRequestActionKey,
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
} from "./organiser-scheduling.js";

export type OrganiserEscalationTrigger = "declined" | "timed_out";

type OrganiserEscalationEvent = {
  id: number;

  name: string;

  guildDatabaseId: number;

  eventAdminChannelId: string | null;

  organiserDmsEnabled: boolean;
};

export type AdvanceOrganiserEscalationResult =
  | {
      kind: "backup_activated";

      event: OrganiserEscalationEvent;

      assignment: {
        id: number;

        discordUserId: string;

        responseDeadlineAt: Date;
      };
    }
  | {
      kind: "cover_queued";

      event: OrganiserEscalationEvent;
    }
  | {
      kind: "already_resolved";
    }
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    };

/**
 * Advances organiser ownership after an assignment has failed.
 *
 * This operation owns the authoritative PostgreSQL transition:
 *
 * - activate a dormant backup when one is available; or
 * - queue a general cover request when no backup remains.
 *
 * Discord notification, presentation and auditing remain the caller's
 * responsibility.
 */
export async function advanceOrganiserEscalation(input: {
  eventId: number;

  failedAssignmentId: number;

  trigger: OrganiserEscalationTrigger;
}): Promise<AdvanceOrganiserEscalationResult> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      guildDatabaseId: events.ownerGuildId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,

      organisersEnabled: guildSettings.organisersEnabled,

      organiserDmsEnabled: guildSettings.organiserDmsEnabled,

      backupResponseMinutes: guildSettings.organiserBackupResponseMinutes,

      warningMinutesBefore: guildSettings.organiserWarningMinutesBefore,
    })
    .from(events)
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, input.eventId))
    .limit(1);

  if (!event) {
    return {
      kind: "event_inactive",
    };
  }

  if (!event.organisersEnabled) {
    return {
      kind: "organisers_disabled",
    };
  }

  if (event.status === "cancelled" || event.status === "completed") {
    return {
      kind: "event_inactive",
    };
  }

  /*
   * An administrator, cover claim or another escalation may already have
   * restored organiser ownership between the original failure and this work.
   */
  const [activeAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (activeAssignment) {
    return {
      kind: "already_resolved",
    };
  }

  const [backup] = await db
    .select({
      id: eventOrganiserAssignments.id,

      discordUserId: eventOrganiserAssignments.discordUserId,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.slot, "backup"),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "pending"),

        isNull(eventOrganiserAssignments.activatedAt),
      ),
    )
    .limit(1);

  if (backup) {
    /*
     * The initial reads are useful fast checks but may become stale before
     * activation. Lock the specific dormant backup first, then the event row
     * which acts as the shared organiser-ownership ordering boundary.
     */
    const activationResult = await db.transaction(async (transaction) => {
      const [featureSettings] = await transaction
        .select({
          organisersEnabled: guildSettings.organisersEnabled,
        })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, event.guildDatabaseId))
        .limit(1)
        .for("share");

      if (!featureSettings?.organisersEnabled) {
        return {
          kind: "organisers_disabled",
        } as const;
      }
      const [lockedBackup] = await transaction
        .select({
          id: eventOrganiserAssignments.id,

          discordUserId: eventOrganiserAssignments.discordUserId,
        })
        .from(eventOrganiserAssignments)
        .where(
          and(
            eq(eventOrganiserAssignments.id, backup.id),

            eq(eventOrganiserAssignments.eventId, event.id),

            eq(eventOrganiserAssignments.slot, "backup"),

            eq(eventOrganiserAssignments.isCurrent, true),

            eq(eventOrganiserAssignments.status, "pending"),

            isNull(eventOrganiserAssignments.activatedAt),
          ),
        )
        .limit(1)
        .for("update");

      if (!lockedBackup) {
        return {
          kind: "already_resolved",
        } as const;
      }

      const [lockedEvent] = await transaction
        .select({
          status: events.status,
        })
        .from(events)
        .where(eq(events.id, event.id))
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

      /*
       * Ignore the dormant backup itself while checking whether another
       * active organiser won ownership while this escalation was waiting.
       */
      const [conflictingAssignment] = await transaction
        .select({
          id: eventOrganiserAssignments.id,
        })
        .from(eventOrganiserAssignments)
        .where(
          and(
            eq(eventOrganiserAssignments.eventId, event.id),

            ne(eventOrganiserAssignments.id, lockedBackup.id),

            eq(eventOrganiserAssignments.isCurrent, true),

            isNotNull(eventOrganiserAssignments.activatedAt),

            inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
          ),
        )
        .limit(1);

      if (conflictingAssignment) {
        return {
          kind: "already_resolved",
        } as const;
      }

      const activatedAt = new Date();

      const responseDeadlineAt = calculateOrganiserResponseDeadline(
        activatedAt,
        event.backupResponseMinutes,
      );

      const actionValues = buildOrganiserResponseActionValues({
        eventId: event.id,

        assignmentId: lockedBackup.id,

        activatedAt,

        responseDeadlineAt,

        warningMinutesBefore: event.warningMinutesBefore,
      });

      const [updated] = await transaction
        .update(eventOrganiserAssignments)
        .set({
          activatedAt,

          responseDeadlineAt,

          updatedAt: activatedAt,
        })
        .where(
          and(
            eq(eventOrganiserAssignments.id, lockedBackup.id),

            eq(eventOrganiserAssignments.isCurrent, true),

            eq(eventOrganiserAssignments.status, "pending"),

            isNull(eventOrganiserAssignments.activatedAt),
          ),
        )
        .returning({
          id: eventOrganiserAssignments.id,
        });

      if (!updated) {
        return {
          kind: "already_resolved",
        } as const;
      }

      await transaction.insert(scheduledActions).values(actionValues);

      return {
        kind: "activated",

        assignmentId: updated.id,

        discordUserId: lockedBackup.discordUserId,

        responseDeadlineAt,
      } as const;
    });

    if (activationResult.kind === "organisers_disabled") {
      return {
        kind: "organisers_disabled",
      };
    }

    if (activationResult.kind === "event_inactive") {
      return {
        kind: "event_inactive",
      };
    }

    if (activationResult.kind === "already_resolved") {
      return {
        kind: "already_resolved",
      };
    }

    return {
      kind: "backup_activated",

      event: {
        id: event.id,

        name: event.name,

        guildDatabaseId: event.guildDatabaseId,

        eventAdminChannelId: event.eventAdminChannelId,

        organiserDmsEnabled: event.organiserDmsEnabled,
      },

      assignment: {
        id: activationResult.assignmentId,

        discordUserId: activationResult.discordUserId,

        responseDeadlineAt: activationResult.responseDeadlineAt,
      },
    };
  }

  /*
   * No dormant backup remains. Before queuing general cover, lock the source
   * failure and event ownership boundary so concurrent resolution cannot
   * create unnecessary cover work.
   */
  const expectedFailedStatus =
    input.trigger === "declined" ? "declined" : "timed_out";

  const queueResult = await db.transaction(async (transaction) => {
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
      .where(eq(guildSettings.guildId, event.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!featureSettings?.organisersEnabled) {
      return {
        kind: "organisers_disabled",
      } as const;
    }
    const [lockedFailedAssignment] = await transaction
      .select({
        id: eventOrganiserAssignments.id,
      })
      .from(eventOrganiserAssignments)
      .where(
        and(
          eq(eventOrganiserAssignments.id, input.failedAssignmentId),

          eq(eventOrganiserAssignments.eventId, event.id),

          eq(eventOrganiserAssignments.status, expectedFailedStatus),
        ),
      )
      .limit(1)
      .for("update");

    if (!lockedFailedAssignment) {
      return {
        kind: "already_resolved",
      } as const;
    }

    const [lockedEvent] = await transaction
      .select({
        status: events.status,
      })
      .from(events)
      .where(eq(events.id, event.id))
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

    const [currentActiveAssignment] = await transaction
      .select({
        id: eventOrganiserAssignments.id,
      })
      .from(eventOrganiserAssignments)
      .where(
        and(
          eq(eventOrganiserAssignments.eventId, event.id),

          eq(eventOrganiserAssignments.isCurrent, true),

          isNotNull(eventOrganiserAssignments.activatedAt),

          inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
        ),
      )
      .limit(1);

    if (currentActiveAssignment) {
      return {
        kind: "already_resolved",
      } as const;
    }

    const now = new Date();

    await transaction
      .insert(scheduledActions)
      .values({
        eventId: event.id,

        actionKey: buildOrganiserCoverRequestActionKey(
          input.failedAssignmentId,
        ),

        dueAt: now,

        status: "pending",

        attemptCount: 0,

        lockedAt: null,

        completedAt: null,

        lastError: null,

        updatedAt: now,
      })
      .onConflictDoNothing();

    return {
      kind: "queued",
    } as const;
  });

  if (queueResult.kind === "organisers_disabled") {
    return {
      kind: "organisers_disabled",
    };
  }

  if (queueResult.kind === "event_inactive") {
    return {
      kind: "event_inactive",
    };
  }

  if (queueResult.kind === "already_resolved") {
    return {
      kind: "already_resolved",
    };
  }

  return {
    kind: "cover_queued",

    event: {
      id: event.id,

      name: event.name,

      guildDatabaseId: event.guildDatabaseId,

      eventAdminChannelId: event.eventAdminChannelId,

      organiserDmsEnabled: event.organiserDmsEnabled,
    },
  };
}
