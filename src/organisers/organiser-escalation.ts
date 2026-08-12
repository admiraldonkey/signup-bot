import { type Guild } from "discord.js";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

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
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
  queueOrganiserCoverRequest,
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
    const activatedAt = new Date();

    const responseDeadlineAt = calculateOrganiserResponseDeadline(
      activatedAt,
      event.backupResponseMinutes,
    );

    const actionValues = buildOrganiserResponseActionValues({
      eventId: event.id,

      assignmentId: backup.id,

      activatedAt,

      responseDeadlineAt,

      warningMinutesBefore: event.warningMinutesBefore,
    });

    const activated = await db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(eventOrganiserAssignments)
        .set({
          activatedAt,

          responseDeadlineAt,

          updatedAt: activatedAt,
        })
        .where(
          and(
            eq(eventOrganiserAssignments.id, backup.id),

            eq(eventOrganiserAssignments.isCurrent, true),

            eq(eventOrganiserAssignments.status, "pending"),

            isNull(eventOrganiserAssignments.activatedAt),
          ),
        )
        .returning({
          id: eventOrganiserAssignments.id,
        });

      if (!updated) {
        return null;
      }

      await transaction.insert(scheduledActions).values(actionValues);

      return updated;
    });

    if (!activated) {
      return {
        kind: "already_resolved",
      };
    }

    const notification = await sendOrganiserAssignmentNotification({
      guild: input.guild,

      assignmentId: backup.id,

      eventId: event.id,

      eventName: event.name,

      discordUserId: backup.discordUserId,

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

      summary: `Activated backup organiser assignment #${backup.id} for "${event.name}" (#${event.id}).`,

      targetType: "organiser_assignment",

      targetId: String(backup.id),

      details: {
        trigger: input.trigger,

        failedAssignmentId: input.failedAssignmentId,

        responseDeadlineAt: responseDeadlineAt.toISOString(),

        notification,
      },
    });

    return {
      kind: "backup_activated",

      assignmentId: backup.id,

      notification,
    };
  }

  await queueOrganiserCoverRequest(event.id, input.failedAssignmentId);

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
