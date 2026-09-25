import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, type DatabaseTransaction } from "../db/client.js";
import { eventReminders, events, scheduledActions } from "../db/schema.js";

export type ReminderTimingReference = "signup_close" | "event_start";

export function calculateReminderDueAt(
  timingReference: ReminderTimingReference,
  minutesBefore: number,
  event: {
    startsAt: Date;

    attendanceClosesAt: Date | null;
  },
): Date | null {
  const referenceTime =
    timingReference === "event_start"
      ? event.startsAt
      : event.attendanceClosesAt;

  if (!referenceTime) {
    return null;
  }

  return new Date(referenceTime.getTime() - minutesBefore * 60_000);
}

export const REMINDER_ACTION_PREFIX = "event_reminder:";

export function buildReminderActionKey(reminderId: number): string {
  return `${REMINDER_ACTION_PREFIX}${reminderId}`;
}

/**
 * Releases reminders which became due while their parent event was
 * deliberately unpublished.
 *
 * Event publication calls this inside the same transaction which records
 * events.publishedAt.
 *
 * Future reminders retain their existing schedule. Reminders whose useful
 * reference point has already passed are not revived.
 */
export async function resumeDueEventRemindersAfterPublication(
  transaction: DatabaseTransaction,
  eventId: number,
  publishedAt: Date,
): Promise<number> {
  const [event] = await transaction
    .select({
      startsAt: events.startsAt,

      attendanceClosesAt: events.attendanceClosesAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return 0;
  }

  const reminders = await transaction
    .select({
      id: eventReminders.id,

      timingReference: eventReminders.timingReference,

      minutesBefore: eventReminders.minutesBefore,
    })
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.eventId, eventId),

        eq(eventReminders.enabled, true),

        isNull(eventReminders.sentAt),

        isNull(eventReminders.missedAt),
      ),
    );

  const dueReminderIds = reminders
    .filter((reminder) => {
      if (
        reminder.timingReference !== "event_start" &&
        reminder.timingReference !== "signup_close"
      ) {
        return false;
      }

      const referenceTime =
        reminder.timingReference === "event_start"
          ? event.startsAt
          : event.attendanceClosesAt;

      /*
       * Publication cannot rescue a reminder whose useful reference point has
       * already arrived.
       *
       * The parked scheduler action will classify that reminder as missed.
       */
      if (!referenceTime || referenceTime <= publishedAt) {
        return false;
      }

      const dueAt = calculateReminderDueAt(
        reminder.timingReference,

        reminder.minutesBefore,

        event,
      );

      return dueAt !== null && dueAt <= publishedAt;
    })
    .map((reminder) => reminder.id);

  if (dueReminderIds.length === 0) {
    return 0;
  }

  const actionKeys = dueReminderIds.map(buildReminderActionKey);

  /*
   * Publication is an authoritative rescheduling event.
   *
   * A due reminder may currently be:
   *
   * - parked at its useful reference boundary
   * - still processing in a scheduler worker which observed the unpublished
   *   event immediately before publication committed
   *
   * Reset either state to a fresh pending action. Existing scheduler
   * status/attempt fencing prevents the stale worker from completing or
   * re-parking the newly-released action.
   */
  const resumedActions = await transaction
    .update(scheduledActions)
    .set({
      status: "pending",

      dueAt: publishedAt,

      attemptCount: 0,

      lockedAt: null,

      completedAt: null,

      lastError: null,

      updatedAt: publishedAt,
    })
    .where(
      and(
        eq(scheduledActions.eventId, eventId),

        inArray(scheduledActions.actionKey, actionKeys),

        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    )
    .returning({
      id: scheduledActions.id,
    });

  return resumedActions.length;
}

export async function reschedulePendingEventReminders(
  eventId: number,
): Promise<void> {
  const [event] = await db
    .select({
      status: events.status,

      startsAt: events.startsAt,

      signupsEnabled: events.signupsEnabled,

      attendanceClosesAt: events.attendanceClosesAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return;
  }

  const reminders = await db
    .select({
      id: eventReminders.id,

      timingReference: eventReminders.timingReference,

      minutesBefore: eventReminders.minutesBefore,

      sentAt: eventReminders.sentAt,

      missedAt: eventReminders.missedAt,
    })
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.eventId, eventId),

        eq(eventReminders.enabled, true),
      ),
    );

  const now = new Date();

  for (const reminder of reminders) {
    /*
     * A reminder which has already been sent or classified as
     * missed must never be scheduled again.
     */
    if (reminder.sentAt || reminder.missedAt) {
      continue;
    }

    if (
      reminder.timingReference !== "event_start" &&
      reminder.timingReference !== "signup_close"
    ) {
      continue;
    }

    const dueAt = calculateReminderDueAt(
      reminder.timingReference,
      reminder.minutesBefore,
      event,
    );

    const actionKey = buildReminderActionKey(reminder.id);

    /*
     * Signup-close reminders remain valid durable work for unpublished
     * scheduled events.
     *
     * Publication may happen before the reminder becomes due. If the reminder
     * instead becomes due first, the scheduler parks its action until either
     * event publication wakes it or the signup-close reference boundary makes
     * it obsolete.
     *
     * They become invalid when signups are disabled, there is no signup-close
     * timestamp, or attendance has already been closed. Cancelled and
     * completed events are handled separately below.
     */
    const signupReminderInvalid =
      reminder.timingReference === "signup_close" &&
      (!event.signupsEnabled ||
        !event.attendanceClosesAt ||
        event.status === "closed");

    const shouldCancel =
      event.status === "cancelled" ||
      event.status === "completed" ||
      signupReminderInvalid ||
      !dueAt;

    if (shouldCancel) {
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

            eq(scheduledActions.actionKey, actionKey),

            inArray(scheduledActions.status, ["pending", "processing"]),
          ),
        );

      continue;
    }

    /*
     * If the calculated send time has already passed, schedule the
     * action immediately. executeEventReminder() will decide
     * whether it is still useful or has genuinely been missed.
     */
    const effectiveDueAt = dueAt <= now ? now : dueAt;

    await db
      .insert(scheduledActions)
      .values({
        eventId,

        actionKey,

        dueAt: effectiveDueAt,

        status: "pending",

        attemptCount: 0,

        lockedAt: null,

        completedAt: null,

        lastError: null,

        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [scheduledActions.eventId, scheduledActions.actionKey],

        set: {
          dueAt: effectiveDueAt,

          status: "pending",

          attemptCount: 0,

          lockedAt: null,

          completedAt: null,

          lastError: null,

          updatedAt: now,
        },
      });
  }
}
