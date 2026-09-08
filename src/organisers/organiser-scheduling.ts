import { and, eq, inArray, like, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { events, guildSettings, scheduledActions } from "../db/schema.js";

export const ORGANISER_WARNING_ACTION_PREFIX = "organiser_warning:";

export const ORGANISER_TIMEOUT_ACTION_PREFIX = "organiser_timeout:";

export const ORGANISER_COVER_REQUEST_ACTION_PREFIX = "organiser_cover_request:";

export const ORGANISER_COVER_DEADLINE_ACTION_PREFIX =
  "organiser_cover_deadline:";

export const ORGANISER_MISSING_AT_START_ACTION_PREFIX =
  "organiser_missing_at_start:";

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

export function buildOrganiserCoverDeadlineActionKey(eventId: number): string {
  return `${ORGANISER_COVER_DEADLINE_ACTION_PREFIX}${eventId}`;
}

export function buildOrganiserMissingAtStartActionKey(eventId: number): string {
  return `${ORGANISER_MISSING_AT_START_ACTION_PREFIX}${eventId}`;
}

export function calculateOrganiserResponseDeadline(
  activatedAt: Date,
  responseMinutes: number,
): Date {
  return new Date(activatedAt.getTime() + responseMinutes * 60_000);
}

export function calculateOrganiserCoverDeadline(
  startsAt: Date,
  minutesBeforeStart: number,
): Date {
  return new Date(startsAt.getTime() - minutesBeforeStart * 60_000);
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

export function buildOrganiserEventSafetyActionValues(input: {
  eventId: number;

  startsAt: Date;

  coverMinutesBeforeStart: number;

  updatedAt: Date;
}) {
  return [
    {
      eventId: input.eventId,

      actionKey: buildOrganiserCoverDeadlineActionKey(input.eventId),

      dueAt: calculateOrganiserCoverDeadline(
        input.startsAt,
        input.coverMinutesBeforeStart,
      ),

      status: "pending" as const,

      attemptCount: 0,

      lockedAt: null,

      completedAt: null,

      lastError: null,

      updatedAt: input.updatedAt,
    },

    {
      eventId: input.eventId,

      actionKey: buildOrganiserMissingAtStartActionKey(input.eventId),

      dueAt: input.startsAt,

      status: "pending" as const,

      attemptCount: 0,

      lockedAt: null,

      completedAt: null,

      lastError: null,

      updatedAt: input.updatedAt,
    },
  ];
}

export async function rescheduleOrganiserEventSafetyActions(
  eventId: number,
): Promise<void> {
  /*
   * Resolve immutable event ownership before taking the feature/lifecycle
   * locks used by the authoritative reschedule transaction.
   */
  const [eventIdentity] = await db
    .select({
      guildDatabaseId: events.ownerGuildId,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!eventIdentity) {
    return;
  }

  await db.transaction(async (transaction) => {
    /*
     * Follow the same organiser feature-lock contract as the rest of the
     * subsystem.
     *
     * Disabling organisers takes FOR UPDATE on this row, so scheduling and
     * feature disable cannot overtake one another.
     */
    const [settings] = await transaction
      .select({
        organisersEnabled: guildSettings.organisersEnabled,

        organiserCoverBeforeStartMinutes:
          guildSettings.organiserCoverBeforeStartMinutes,
      })
      .from(guildSettings)
      .where(eq(guildSettings.guildId, eventIdentity.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!settings?.organisersEnabled) {
      return;
    }

    /*
     * Serialise against lifecycle changes such as cancellation/completion.
     *
     * If a terminal transition wins first, no organiser actions are
     * resurrected. If this reschedule wins first, that later terminal
     * transition will subsequently cancel them.
     */
    const [event] = await transaction
      .select({
        startsAt: events.startsAt,

        publishedAt: events.publishedAt,

        status: events.status,
      })
      .from(events)
      .where(
        and(
          eq(events.id, eventId),

          eq(events.ownerGuildId, eventIdentity.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("share");

    if (
      !event ||
      !event.publishedAt ||
      event.status === "cancelled" ||
      event.status === "completed"
    ) {
      return;
    }

    const now = new Date();

    const actions = buildOrganiserEventSafetyActionValues({
      eventId,

      startsAt: event.startsAt,

      coverMinutesBeforeStart: settings.organiserCoverBeforeStartMinutes,

      updatedAt: now,
    });

    /*
     * Reset both stable event-level actions to the newly-calculated
     * schedule.
     *
     * This deliberately also revives completed/failed/cancelled instances:
     * moving an event creates a new operational deadline which must be
     * evaluated again.
     *
     * A worker already executing an older attempt is fenced by status /
     * attemptCount ownership in the scheduler, while the safety service
     * itself now rejects a stale action whose recalculated deadline is not
     * yet due.
     */
    for (const action of actions) {
      await transaction
        .insert(scheduledActions)
        .values(action)
        .onConflictDoUpdate({
          target: [scheduledActions.eventId, scheduledActions.actionKey],

          set: {
            dueAt: action.dueAt,

            status: "pending",

            attemptCount: 0,

            lockedAt: null,

            completedAt: null,

            lastError: null,

            updatedAt: now,
          },
        });
    }
  });
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

          like(
            scheduledActions.actionKey,
            `${ORGANISER_COVER_DEADLINE_ACTION_PREFIX}%`,
          ),

          like(
            scheduledActions.actionKey,
            `${ORGANISER_MISSING_AT_START_ACTION_PREFIX}%`,
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
