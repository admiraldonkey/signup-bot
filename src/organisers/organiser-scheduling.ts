import { and, eq, inArray, like, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { scheduledActions } from "../db/schema.js";

export const ORGANISER_WARNING_ACTION_PREFIX = "organiser_warning:";

export const ORGANISER_TIMEOUT_ACTION_PREFIX = "organiser_timeout:";

export const ORGANISER_COVER_REQUEST_ACTION_PREFIX = "organiser_cover_request:";

export function buildOrganiserWarningActionKey(assignmentId: number): string {
  return `${ORGANISER_WARNING_ACTION_PREFIX}${assignmentId}`;
}

export function buildOrganiserTimeoutActionKey(assignmentId: number): string {
  return `${ORGANISER_TIMEOUT_ACTION_PREFIX}${assignmentId}`;
}

export function buildOrganiserCoverRequestActionKey(
  sourceAssignmentId: number,
): string {
  return `${ORGANISER_COVER_REQUEST_ACTION_PREFIX}${sourceAssignmentId}`;
}

export function calculateOrganiserResponseDeadline(
  activatedAt: Date,
  responseMinutes: number,
): Date {
  return new Date(activatedAt.getTime() + responseMinutes * 60_000);
}

export function buildOrganiserResponseActionValues(input: {
  eventId: number;

  assignmentId: number;

  activatedAt: Date;

  responseDeadlineAt: Date;

  warningMinutesBefore: number;
}) {
  const actions = [
    {
      eventId: input.eventId,

      actionKey: buildOrganiserTimeoutActionKey(input.assignmentId),

      dueAt: input.responseDeadlineAt,

      status: "pending" as const,

      attemptCount: 0,

      lockedAt: null,

      completedAt: null,

      lastError: null,

      updatedAt: input.activatedAt,
    },
  ];

  if (input.warningMinutesBefore > 0) {
    const warningAt = new Date(
      input.responseDeadlineAt.getTime() - input.warningMinutesBefore * 60_000,
    );

    /*
     * Do not create a warning which was already due when the
     * assignment became active.
     */
    if (warningAt > input.activatedAt) {
      actions.unshift({
        eventId: input.eventId,

        actionKey: buildOrganiserWarningActionKey(input.assignmentId),

        dueAt: warningAt,

        status: "pending" as const,

        attemptCount: 0,

        lockedAt: null,

        completedAt: null,

        lastError: null,

        updatedAt: input.activatedAt,
      });
    }
  }

  return actions;
}

export async function cancelOrganiserResponseActions(
  eventId: number,
  assignmentId: number,
): Promise<void> {
  const now = new Date();

  await db
    .update(scheduledActions)
    .set({
      status: "cancelled",

      lockedAt: null,

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.eventId, eventId),

        inArray(scheduledActions.actionKey, [
          buildOrganiserWarningActionKey(assignmentId),

          buildOrganiserTimeoutActionKey(assignmentId),
        ]),

        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    );
}

export async function cancelAllOrganiserEscalationActions(
  eventId: number,
): Promise<void> {
  const now = new Date();

  await db
    .update(scheduledActions)
    .set({
      status: "cancelled",

      lockedAt: null,

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.eventId, eventId),

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

export async function queueOrganiserCoverRequest(
  eventId: number,
  sourceAssignmentId: number,
): Promise<void> {
  const now = new Date();

  await db
    .insert(scheduledActions)
    .values({
      eventId,

      actionKey: buildOrganiserCoverRequestActionKey(sourceAssignmentId),

      dueAt: now,

      status: "pending",

      attemptCount: 0,

      lockedAt: null,

      completedAt: null,

      lastError: null,

      updatedAt: now,
    })
    /*
     * One failed assignment should only create one cover request.
     */
    .onConflictDoNothing();
}
