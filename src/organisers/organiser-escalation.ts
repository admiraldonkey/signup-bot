import { type Guild } from "discord.js";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import { db } from "../db/client.js";
import {
  eventOrganiserAssignments,
  events,
  guildSettings,
  scheduledActions,
} from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "../events/organiser-notification.js";
import {
  buildOrganiserCoverRequestActionKey,
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
} from "./organiser-scheduling.js";

export type OrganiserEscalationResult =
  | {
      kind: "backup_activated";

      assignmentId: number;

      notification: OrganiserNotificationDelivery;
    }
  | {
      kind: "cover_queued";
    }
  | {
      kind: "already_resolved";
    }
  | {
      kind: "event_inactive";
    };

export async function escalateAfterFailedOrganiserAssignment(input: {
  guild: Guild;

  eventId: number;

  failedAssignmentId: number;

  trigger: "declined" | "timed_out";
}): Promise<OrganiserEscalationResult> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      guildDatabaseId: events.ownerGuildId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,

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

  if (event.status === "cancelled" || event.status === "completed") {
    return {
      kind: "event_inactive",
    };
  }

  /*
   * An admin may have assigned somebody else during the tiny gap
   * between a decline/timeout and this escalation running.
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
     * The earlier active-assignment and dormant-backup reads are useful fast
     * checks, but either may become stale before activation.
     *
     * First lock the exact dormant backup row we intend to activate. Then
     * acquire the event lifecycle row before changing organiser ownership.
     *
     * Once the event lock is held, re-check whether another active organiser
     * appeared while this escalation was waiting.
     */
    const activationResult = await db.transaction(async (transaction) => {
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

      /*
       * Organiser ownership changes use the event row as their shared
       * ordering boundary.
       */
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
       * A cover claim, manual assignment or another escalation may have
       * resolved organiser ownership after our initial read.
       *
       * Ignore this dormant backup itself when checking for the winner.
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

      /*
       * Start the response clock only after this escalation has actually
       * won organiser ownership.
       */
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

    const notification = await sendOrganiserAssignmentNotification({
      guild: input.guild,

      assignmentId: activationResult.assignmentId,

      eventId: event.id,

      eventName: event.name,

      discordUserId: activationResult.discordUserId,

      slot: "backup",

      eventAdminChannelId: event.eventAdminChannelId,
    });

    await refreshAttendanceMessage(input.guild, event.id).catch(
      (error: unknown) => {
        console.error(
          `Failed to refresh event ${event.id} after backup activation:`,
          error,
        );
      },
    );

    await writeAuditLog({
      guildId: event.guildDatabaseId,

      guild: input.guild,

      actorUserId: null,

      action: "event.organiser.backup.activate",

      outcome: "success",

      summary: `Activated backup organiser assignment #${activationResult.assignmentId} for "${event.name}" (#${event.id}).`,

      targetType: "organiser_assignment",

      targetId: String(activationResult.assignmentId),

      details: {
        trigger: input.trigger,

        failedAssignmentId: input.failedAssignmentId,

        responseDeadlineAt: activationResult.responseDeadlineAt.toISOString(),

        notification,
      },
    });

    return {
      kind: "backup_activated",

      assignmentId: activationResult.assignmentId,

      notification,
    };
  }

  /*
   * The earlier event/assignment reads may become stale before general cover
   * is queued.
   *
   * Lock the failed assignment first so duplicate escalation work for the same
   * failure has a stable ordering point. Then acquire the shared event
   * organiser-ownership lock and re-check whether somebody else resolved the
   * event while this escalation was waiting.
   */
  const expectedFailedStatus =
    input.trigger === "declined" ? "declined" : "timed_out";

  const queueResult = await db.transaction(async (transaction) => {
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

    /*
     * The source failure itself changed or disappeared before this
     * escalation obtained ownership.
     */
    if (!lockedFailedAssignment) {
      return {
        kind: "already_resolved",
      } as const;
    }

    /*
     * All organiser-ownership changes use the event row as their shared
     * lifecycle/concurrency boundary.
     */
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
     * Cover, an administrator, or another organiser flow may have resolved
     * ownership after our initial read.
     */
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
      /*
       * Preserve the existing idempotency guarantee: one failed assignment
       * can create at most one cover-request action.
       */
      .onConflictDoNothing();

    return {
      kind: "queued",
    } as const;
  });

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

  await refreshAttendanceMessage(input.guild, event.id).catch(
    (error: unknown) => {
      console.error(
        `Failed to refresh event ${event.id} before cover escalation:`,
        error,
      );
    },
  );

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild: input.guild,

    actorUserId: null,

    action: "event.organiser.cover.queue",

    outcome: "success",

    summary: `Queued an organiser cover request for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      trigger: input.trigger,

      failedAssignmentId: input.failedAssignmentId,
    },
  });

  return {
    kind: "cover_queued",
  };
}
