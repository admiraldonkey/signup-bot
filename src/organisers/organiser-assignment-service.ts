import { and, eq, inArray, isNotNull, like, or } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  eventOrganiserAssignments,
  events,
  scheduledActions,
} from "../db/schema.js";
import {
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
  cancelOrganiserResponseActions,
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
} from "./organiser-scheduling.js";

export type EditableOrganiserSlot = "primary" | "backup";

export type AssignEventOrganiserResult =
  | {
      kind: "event_not_found";
    }
  | {
      kind: "event_inactive";
    }
  | {
      kind: "backup_requires_primary";
    }
  | {
      kind: "organiser_already_assigned_to_other_slot";
      otherSlot: EditableOrganiserSlot;
    }
  | {
      kind: "organiser_already_current";
    }
  | {
      kind: "assigned";

      event: {
        id: number;
        name: string;
      };

      assignment: {
        id: number;
        activatedAt: Date | null;
      };

      replacedAssignmentIds: number[];
    };

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
 * Creates or replaces the current organiser assignment for an event slot.
 *
 * This operation owns event/assignment validation, authoritative persistence,
 * organiser ownership transitions and response-action scheduling.
 *
 * Discord member/role validation, notification delivery, presentation and
 * auditing remain the caller's responsibility.
 */
export async function assignEventOrganiser(input: {
  guildDatabaseId: number;

  eventId: number;

  slot: EditableOrganiserSlot;

  organiserUserId: string;

  displayNameSnapshot: string;

  assignedByUserId: string;

  primaryResponseMinutes: number;

  warningMinutesBefore: number;
}): Promise<AssignEventOrganiserResult> {
  const event = await findOwnedEvent(input.guildDatabaseId, input.eventId);

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

  if (input.slot === "backup") {
    const currentPrimary = await findCurrentAssignment(event.id, "primary");

    if (
      !currentPrimary ||
      !["pending", "confirmed"].includes(currentPrimary.status)
    ) {
      return {
        kind: "backup_requires_primary",
      };
    }
  }

  const otherSlot: EditableOrganiserSlot =
    input.slot === "primary" ? "backup" : "primary";

  const otherAssignment = await findCurrentAssignment(event.id, otherSlot);

  if (otherAssignment?.discordUserId === input.organiserUserId) {
    return {
      kind: "organiser_already_assigned_to_other_slot",

      otherSlot,
    };
  }

  const existing = await findCurrentAssignment(event.id, input.slot);

  if (
    existing?.discordUserId === input.organiserUserId &&
    (existing.status === "pending" || existing.status === "confirmed")
  ) {
    return {
      kind: "organiser_already_current",
    };
  }

  const now = new Date();

  const shouldActivatePrimary =
    input.slot === "primary" && event.publishedAt !== null;

  const { assignment, replacedAssignmentIds } = await db.transaction(
    async (transaction) => {
      const replacedAssignmentIds: number[] = [];

      if (existing) {
        const replacedAssignments = await transaction
          .update(eventOrganiserAssignments)
          .set({
            status: "replaced",

            isCurrent: false,

            endedAt: now,

            updatedAt: now,
          })
          .where(eq(eventOrganiserAssignments.id, existing.id))
          .returning({
            id: eventOrganiserAssignments.id,
          });

        replacedAssignmentIds.push(
          ...replacedAssignments.map(
            (replacedAssignment) => replacedAssignment.id,
          ),
        );
      }

      /*
       * A newly assigned primary supersedes any currently-active backup or
       * cover organiser. Dormant backups are deliberately retained.
       */
      if (input.slot === "primary") {
        const replacedActivatedAssignments = await transaction
          .update(eventOrganiserAssignments)
          .set({
            status: "replaced",

            isCurrent: false,

            endedAt: now,

            updatedAt: now,
          })
          .where(
            and(
              eq(eventOrganiserAssignments.eventId, event.id),

              eq(eventOrganiserAssignments.isCurrent, true),

              isNotNull(eventOrganiserAssignments.activatedAt),

              inArray(eventOrganiserAssignments.slot, ["backup", "cover"]),
            ),
          )
          .returning({
            id: eventOrganiserAssignments.id,
          });

        replacedAssignmentIds.push(
          ...replacedActivatedAssignments.map(
            (replacedAssignment) => replacedAssignment.id,
          ),
        );

        /*
         * A newly assigned active primary also makes any previous organiser
         * escalation work obsolete.
         */
        await transaction
          .update(scheduledActions)
          .set({
            status: "cancelled",

            lockedAt: null,

            updatedAt: now,
          })
          .where(
            and(
              eq(scheduledActions.eventId, event.id),

              inArray(scheduledActions.status, ["pending", "processing"]),

              or(
                like(
                  scheduledActions.actionKey,
                  `${ORGANISER_WARNING_ACTION_PREFIX}%`,
                ),

                like(
                  scheduledActions.actionKey,
                  `${ORGANISER_TIMEOUT_ACTION_PREFIX}%`,
                ),

                like(
                  scheduledActions.actionKey,
                  `${ORGANISER_COVER_REQUEST_ACTION_PREFIX}%`,
                ),
              ),
            ),
          );
      }

      const activatedAt = shouldActivatePrimary ? now : null;

      const responseDeadlineAt = shouldActivatePrimary
        ? calculateOrganiserResponseDeadline(now, input.primaryResponseMinutes)
        : null;

      const [created] = await transaction
        .insert(eventOrganiserAssignments)
        .values({
          eventId: event.id,

          slot: input.slot,

          discordUserId: input.organiserUserId,

          displayNameSnapshot: input.displayNameSnapshot,

          status: "pending",

          isCurrent: true,

          assignedByUserId: input.assignedByUserId,

          activatedAt,

          responseDeadlineAt,

          updatedAt: now,
        })
        .returning({
          id: eventOrganiserAssignments.id,
        });

      if (!created) {
        throw new Error(
          "The organiser assignment was not returned by the database.",
        );
      }

      if (shouldActivatePrimary) {
        if (!activatedAt || !responseDeadlineAt) {
          throw new Error(
            "The primary organiser activation times were not created.",
          );
        }

        const actions = buildOrganiserResponseActionValues({
          eventId: event.id,

          assignmentId: created.id,

          activatedAt,

          responseDeadlineAt,

          warningMinutesBefore: input.warningMinutesBefore,
        });

        await transaction.insert(scheduledActions).values(actions);
      }

      return {
        assignment: {
          id: created.id,

          activatedAt,
        },

        replacedAssignmentIds,
      };
    },
  );

  return {
    kind: "assigned",

    event: {
      id: event.id,

      name: event.name,
    },

    assignment,

    replacedAssignmentIds,
  };
}

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
  const event = await findOwnedEvent(input.guildDatabaseId, input.eventId);

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

  const assignment = await findCurrentAssignment(event.id, input.slot);

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

    assignment: {
      id: assignment.id,

      discordUserId: assignment.discordUserId,

      activatedAt: assignment.activatedAt,
    },
  };
}

async function findOwnedEvent(guildDatabaseId: number, eventId: number) {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),

        eq(events.ownerGuildId, guildDatabaseId),
      ),
    )
    .limit(1);

  return event ?? null;
}

async function findCurrentAssignment(
  eventId: number,
  slot: EditableOrganiserSlot,
) {
  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,

      activatedAt: eventOrganiserAssignments.activatedAt,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.slot, slot),

        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    )
    .limit(1);

  return assignment ?? null;
}
