import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { events, roleRequestGroups, scheduledActions } from "../db/schema.js";

export const ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX =
  "role_request_group_close:";

function makeRoleRequestGroupCloseActionKey(groupId: number): string {
  return `${ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX}${groupId}`;
}

export async function scheduleRoleRequestGroupClose(
  eventId: number,
  groupId: number,
  dueAt: Date,
): Promise<void> {
  const now = new Date();

  await db
    .insert(scheduledActions)
    .values({
      eventId,

      actionKey: makeRoleRequestGroupCloseActionKey(groupId),

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

export async function markRoleRequestGroupCloseCompleted(
  eventId: number,
  groupId: number,
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

        eq(
          scheduledActions.actionKey,
          makeRoleRequestGroupCloseActionKey(groupId),
        ),

        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    );
}

export async function rescheduleOpenRoleRequestGroupCloses(
  eventId: number,
): Promise<void> {
  const [event] = await db
    .select({
      startsAt: events.startsAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return;
  }

  const groups = await db
    .select({
      id: roleRequestGroups.id,

      closeMinutesBeforeStart: roleRequestGroups.closeMinutesBeforeStart,
    })
    .from(roleRequestGroups)
    .where(
      and(
        eq(roleRequestGroups.eventId, eventId),

        isNull(roleRequestGroups.closedAt),
      ),
    );

  const now = new Date();

  for (const group of groups) {
    /*
     * Positive offset = before start.
     * Negative offset = after start.
     */
    const closesAt = new Date(
      event.startsAt.getTime() - group.closeMinutesBeforeStart * 60_000,
    );

    await db
      .update(roleRequestGroups)
      .set({
        closesAt,

        updatedAt: now,
      })
      .where(eq(roleRequestGroups.id, group.id));

    /*
     * If an edit moves the calculated close into the past, queue it
     * for immediate scheduler processing rather than inventing a new
     * deadline.
     */
    await scheduleRoleRequestGroupClose(
      eventId,
      group.id,
      closesAt <= now ? now : closesAt,
    );
  }
}
