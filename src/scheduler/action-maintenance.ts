import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { scheduledActions } from "../db/schema.js";

export async function markAttendanceCloseCompleted(
  eventId: number,
  completedAt = new Date(),
): Promise<void> {
  await db
    .update(scheduledActions)
    .set({
      status: "completed",

      lockedAt: null,

      completedAt,

      lastError: null,

      updatedAt: completedAt,
    })
    .where(
      and(
        eq(scheduledActions.eventId, eventId),
        eq(scheduledActions.actionKey, "close_attendance"),
        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    );
}

export async function scheduleAttendanceClose(
  eventId: number,
  dueAt: Date,
): Promise<void> {
  const now = new Date();

  await db
    .insert(scheduledActions)
    .values({
      eventId,

      actionKey: "close_attendance",

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

export async function scheduleEventCompletion(
  eventId: number,
  dueAt: Date,
): Promise<void> {
  const now = new Date();

  await db
    .insert(scheduledActions)
    .values({
      eventId,

      actionKey: "complete_event",

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

export async function cancelEventScheduledActions(
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
      ),
    );
}
