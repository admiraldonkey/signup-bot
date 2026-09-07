import { type Guild } from "discord.js";

import { writeAuditLog } from "../audit/audit-log.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "../events/organiser-notification.js";
import {
  advanceOrganiserEscalation,
  type OrganiserEscalationTrigger,
} from "./organiser-escalation-service.js";

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
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    };

export async function escalateAfterFailedOrganiserAssignment(input: {
  guild: Guild;

  eventId: number;

  failedAssignmentId: number;

  trigger: OrganiserEscalationTrigger;
}): Promise<OrganiserEscalationResult> {
  const transition = await advanceOrganiserEscalation({
    eventId: input.eventId,

    failedAssignmentId: input.failedAssignmentId,

    trigger: input.trigger,
  });
  if (transition.kind === "organisers_disabled") {
    return {
      kind: "organisers_disabled",
    };
  }

  if (transition.kind === "event_inactive") {
    return {
      kind: "event_inactive",
    };
  }

  if (transition.kind === "already_resolved") {
    return {
      kind: "already_resolved",
    };
  }

  if (transition.kind === "backup_activated") {
    const { event, assignment } = transition;

    let notification: OrganiserNotificationDelivery;

    try {
      notification = await sendOrganiserAssignmentNotification({
        guild: input.guild,

        assignmentId: assignment.id,

        eventId: event.id,

        eventName: event.name,

        discordUserId: assignment.discordUserId,

        slot: "backup",

        eventAdminChannelId: event.eventAdminChannelId,

        organiserDmsEnabled: event.organiserDmsEnabled,
      });
    } catch (error: unknown) {
      /*
       * Backup activation and its response actions are already authoritative.
       * Discord transport failure cannot invalidate that database state.
       */
      console.error(
        `Failed to deliver backup organiser notification for assignment ${assignment.id}:`,
        error,
      );

      notification = "failed";
    }

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

      summary: `Activated backup organiser assignment #${assignment.id} for "${event.name}" (#${event.id}).`,

      targetType: "organiser_assignment",

      targetId: String(assignment.id),

      details: {
        trigger: input.trigger,

        failedAssignmentId: input.failedAssignmentId,

        responseDeadlineAt: assignment.responseDeadlineAt.toISOString(),

        notification,
      },
    });

    return {
      kind: "backup_activated",

      assignmentId: assignment.id,

      notification,
    };
  }

  const { event } = transition;

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
