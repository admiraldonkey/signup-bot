import { and, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "../db/client.js";

import { events, roleRequestGroups, scheduledActions } from "../db/schema.js";

export const ROLE_REQUEST_GROUP_OPEN_ACTION_PREFIX = "role_request_group_open:";

export const ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX =
  "role_request_group_close:";

export function makeRoleRequestGroupOpenActionKey(groupId: number): string {
  return `${ROLE_REQUEST_GROUP_OPEN_ACTION_PREFIX}${groupId}`;
}

export function makeRoleRequestGroupCloseActionKey(groupId: number): string {
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

/**
 * Recalculates event-start-relative timing for every role-request group which
 * has not yet been explicitly closed.
 *
 * Opening semantics deliberately differ from closing semantics:
 *
 * - an unposted group with a non-null opening offset still has a future/planned
 *   opening rule, so both opensAt and its durable open action are rescheduled;
 * - once a group has a Discord message, opensAt describes the opening which
 *   actually occurred and is therefore historical state;
 * - a null opening offset means the group never had an event-start-relative
 *   opening rule, for example an administrator-posted immediate group;
 * - every still-open group retains its relative closing rule.
 *
 * Group rows are locked before the parent event is read/locked. This preserves
 * the role-request subsystem's established group -> event lock ordering and
 * avoids introducing an event -> group deadlock with publication/closure.
 */
export async function rescheduleRoleRequestGroupsForEventStart(
  eventId: number,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    /*
     * Lock relevant groups first.
     *
     * Publication/closure also treat the group as the first authoritative
     * role-request row, so keeping this ordering avoids a competing
     * event->group / group->event lock cycle.
     */
    const groups = await transaction
      .select({
        id: roleRequestGroups.id,

        messageId: roleRequestGroups.messageId,

        openMinutesBeforeStart: roleRequestGroups.openMinutesBeforeStart,

        closeMinutesBeforeStart: roleRequestGroups.closeMinutesBeforeStart,
      })
      .from(roleRequestGroups)
      .where(
        and(
          eq(roleRequestGroups.eventId, eventId),

          isNull(roleRequestGroups.closedAt),
        ),
      )
      .for("update");

    if (groups.length === 0) {
      return;
    }

    /*
     * Read the event only after the group locks have been acquired.
     *
     * FOR SHARE prevents a concurrent event edit from changing startsAt
     * while this transaction is calculating and persisting derived group
     * timing. If another edit already committed, this read sees that newer
     * authoritative value.
     */
    const [event] = await transaction
      .select({
        startsAt: events.startsAt,
      })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1)
      .for("share");

    if (!event) {
      return;
    }

    for (const group of groups) {
      const closesAt = resolveStartRelativeTime(
        event.startsAt,

        group.closeMinutesBeforeStart,
      );

      const shouldRescheduleOpening =
        group.messageId === null && group.openMinutesBeforeStart !== null;

      const opensAt = shouldRescheduleOpening
        ? resolveStartRelativeTime(
            event.startsAt,

            group.openMinutesBeforeStart!,
          )
        : null;

      /*
       * Retain the exact resolved timestamps on the event-level group.
       *
       * If either deadline is already in the past, only the durable
       * scheduled action is clamped to "now". The row itself must still
       * describe the true event-relative rule.
       */
      const [updatedGroup] = await transaction
        .update(roleRequestGroups)
        .set({
          ...(opensAt
            ? {
                opensAt,
              }
            : {}),

          closesAt,

          updatedAt: now,
        })
        .where(
          and(
            eq(roleRequestGroups.id, group.id),

            eq(roleRequestGroups.eventId, eventId),

            isNull(roleRequestGroups.closedAt),
          ),
        )
        .returning({
          id: roleRequestGroups.id,
        });

      /*
       * Defensive race fence. Although FOR UPDATE already serialises normal
       * competing group mutations, do not create fresh scheduler work if
       * this row somehow ceased to qualify.
       */
      if (!updatedGroup) {
        continue;
      }

      await upsertRoleRequestGroupAction(
        transaction,

        eventId,

        makeRoleRequestGroupCloseActionKey(group.id),

        closesAt <= now ? now : closesAt,

        now,
      );

      if (opensAt !== null) {
        await upsertRoleRequestGroupAction(
          transaction,

          eventId,

          makeRoleRequestGroupOpenActionKey(group.id),

          opensAt <= now ? now : opensAt,

          now,
        );
      }
    }
  });
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function resumeDueRoleRequestGroupOpeningsAfterPublication(
  transaction: DatabaseTransaction,
  eventId: number,
  publishedAt: Date,
): Promise<number> {
  /*
   * Only event-relative automatic groups participate in this wake-up.
   *
   * A manually-created immediate group has no relative opening rule and
   * should never be manufactured into scheduled work merely because the main
   * event was published later.
   */
  const dueGroups = await transaction
    .select({
      id: roleRequestGroups.id,
    })
    .from(roleRequestGroups)
    .where(
      and(
        eq(roleRequestGroups.eventId, eventId),

        isNull(roleRequestGroups.messageId),

        isNull(roleRequestGroups.closedAt),

        isNotNull(roleRequestGroups.openMinutesBeforeStart),

        lte(roleRequestGroups.opensAt, publishedAt),

        gt(roleRequestGroups.closesAt, publishedAt),
      ),
    );

  if (dueGroups.length === 0) {
    return 0;
  }

  const actionKeys = dueGroups.map((group) =>
    makeRoleRequestGroupOpenActionKey(group.id),
  );

  /*
   * Event publication is an authoritative rescheduling event.
   *
   * A due role-group opening may currently be:
   *
   * - parked at closesAt while awaiting publication
   * - still processing in another scheduler worker
   *
   * Resetting both states to a fresh pending action fences any stale worker
   * through the scheduler's existing status/attempt ownership predicates.
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

async function upsertRoleRequestGroupAction(
  transaction: DatabaseTransaction,

  eventId: number,

  actionKey: string,

  dueAt: Date,

  now: Date,
): Promise<void> {
  await transaction
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

        /*
         * Moving an event is authoritative rescheduling, not a failed
         * delivery attempt.
         */
        attemptCount: 0,

        lockedAt: null,

        completedAt: null,

        lastError: null,

        updatedAt: now,
      },
    });
}

/*
 * Positive offsets are before event start.
 * Negative offsets are after event start.
 */
function resolveStartRelativeTime(
  startsAt: Date,
  minutesBeforeStart: number,
): Date {
  return new Date(startsAt.getTime() - minutesBeforeStart * 60_000);
}
