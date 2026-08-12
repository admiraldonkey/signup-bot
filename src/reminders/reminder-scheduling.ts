import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
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
     * Signup-close reminders only make sense while:
     *
     * - signups exist
     * - there is an actual signup-close timestamp
     * - attendance remains open.
     *
     * Manual early closure therefore invalidates a future
     * signup-close reminder. Natural expiry is still handled by
     * the scheduler so missed reminders can be classified correctly
     */
    const signupReminderInvalid =
      reminder.timingReference === "signup_close" &&
      (!event.signupsEnabled ||
        !event.attendanceClosesAt ||
        event.status !== "open");

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
