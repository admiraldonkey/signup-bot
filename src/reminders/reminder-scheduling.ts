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
    })
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.eventId, eventId),

        eq(eventReminders.enabled, true),

        /*
         * sentAt IS NULL without importing isNull can instead
         * be left out here if you prefer and filtered below
         * after selecting sentAt.
         */
      ),
    );

  const now = new Date();

  for (const reminder of reminders) {
    if (reminder.sentAt) {
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

    const signupReminderInvalid =
      reminder.timingReference === "signup_close" && event.status !== "open";

    const shouldCancel =
      event.status === "cancelled" ||
      event.status === "completed" ||
      signupReminderInvalid ||
      !dueAt ||
      dueAt <= now;

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

    await db
      .insert(scheduledActions)
      .values({
        eventId,

        actionKey,

        dueAt,

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
          dueAt,

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
