import { type Client } from "discord.js";
import {
  and,
  eq,
  gte,
  inArray,
  lt,
  lte,
  sql,
  isNull,
  isNotNull,
  ne,
} from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";

import { db } from "../db/client.js";
import {
  discordGuilds,
  events,
  scheduledActions,
  eventReminders,
  eventOrganiserAssignments,
  guildSettings,
  roleRequestGroups,
} from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { sendEventCustomMessage } from "../events/event-custom-message.js";
import { REMINDER_ACTION_PREFIX } from "../reminders/reminder-scheduling.js";
import { reschedulePendingEventReminders } from "../reminders/reminder-scheduling.js";
import { escalateAfterFailedOrganiserAssignment } from "../organisers/organiser-escalation.js";
import {
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
  cancelAllOrganiserEscalationActions,
} from "../organisers/organiser-scheduling.js";
import {
  sendOrganiserCoverRequest,
  sendOrganiserPendingWarning,
} from "../events/organiser-notification.js";
import { ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX } from "../role-requests/role-request-scheduling.js";
import {
  refreshRoleRequestGroupMessage,
  refreshRoleRequestMessages,
} from "../role-requests/role-request-message.js";
import { publishStoredEvent } from "../events/event-publication.js";

const POLL_INTERVAL_MS = 15_000;

const STALE_LOCK_AFTER_MS = 5 * 60_000;

const MAX_ACTIONS_PER_TICK = 20;

const MAX_ATTEMPTS = 5;

let schedulerTimer: NodeJS.Timeout | null = null;

let schedulerRunning = false;

export function startEventScheduler(client: Client<true>): void {
  if (schedulerTimer) {
    return;
  }

  console.log("Event scheduler started.");

  /*
   * Run immediately rather than waiting for the first interval.
   */
  void runSchedulerTickSafely(client);

  schedulerTimer = setInterval(() => {
    void runSchedulerTickSafely(client);
  }, POLL_INTERVAL_MS);

  /*
   * The timer itself should not prevent a clean Node shutdown.
   */
  schedulerTimer.unref();
}

export function stopEventScheduler(): void {
  if (!schedulerTimer) {
    return;
  }

  clearInterval(schedulerTimer);

  schedulerTimer = null;

  console.log("Event scheduler stopped.");
}

async function runSchedulerTickSafely(client: Client<true>): Promise<void> {
  /*
   * Prevent overlapping polling cycles if a previous tick takes longer
   * than the normal polling interval.
   */
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;

  try {
    await recoverStaleActions();

    await processDueActions(client);
  } catch (error) {
    console.error("Event scheduler tick failed:", error);
  } finally {
    schedulerRunning = false;
  }
}

async function recoverStaleActions(): Promise<void> {
  const now = new Date();

  const staleBefore = new Date(now.getTime() - STALE_LOCK_AFTER_MS);

  /*
   * A processing action has already consumed an attempt when it was
   * claimed.
   *
   * If that final allowed attempt was interrupted and its lock later
   * becomes stale, recovering it to pending would let claimAction()
   * increment the counter again and execute an impermissible extra
   * attempt.
   *
   * Exhausted stale actions therefore become terminal failures directly.
   */
  const exhausted = await db
    .update(scheduledActions)
    .set({
      status: "failed",

      lockedAt: null,

      lastError:
        "Failed after interrupted processing because the maximum attempt count had already been reached.",

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.status, "processing"),

        lt(scheduledActions.lockedAt, staleBefore),

        gte(scheduledActions.attemptCount, MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: scheduledActions.id,
    });

  /*
   * Stale actions which still have an attempt remaining may safely return
   * to pending. processDueActions() can then claim them normally, which
   * consumes their next attempt.
   */
  const recovered = await db
    .update(scheduledActions)
    .set({
      status: "pending",

      lockedAt: null,

      lastError: "Recovered after interrupted processing.",

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.status, "processing"),

        lt(scheduledActions.lockedAt, staleBefore),

        lt(scheduledActions.attemptCount, MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: scheduledActions.id,
    });

  if (exhausted.length > 0) {
    console.warn(
      `Failed ${exhausted.length} stale scheduled action(s) which had already exhausted their allowed attempts.`,
    );
  }

  if (recovered.length > 0) {
    console.warn(`Recovered ${recovered.length} stale scheduled action(s).`);
  }
}

async function processDueActions(client: Client<true>): Promise<void> {
  const now = new Date();

  const dueActions = await db
    .select({
      id: scheduledActions.id,
    })
    .from(scheduledActions)
    .where(
      and(
        eq(scheduledActions.status, "pending"),
        lte(scheduledActions.dueAt, now),
      ),
    )
    .orderBy(scheduledActions.dueAt)
    .limit(MAX_ACTIONS_PER_TICK);

  for (const dueAction of dueActions) {
    const claimedAction = await claimAction(dueAction.id);

    /*
     * Another process could theoretically have claimed it first.
     * This is mostly future-proofing while you only run one replica.
     */
    if (!claimedAction) {
      continue;
    }

    try {
      await executeAction(client, claimedAction);

      await markActionCompleted(claimedAction.id);
    } catch (error) {
      await handleActionFailure(claimedAction, error);
    }
  }
}

async function claimAction(actionId: number) {
  const now = new Date();

  const [claimedAction] = await db
    .update(scheduledActions)
    .set({
      status: "processing",

      lockedAt: now,

      attemptCount: sql`${scheduledActions.attemptCount} + 1`,

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.id, actionId),
        eq(scheduledActions.status, "pending"),
        lte(scheduledActions.dueAt, now),
      ),
    )
    .returning({
      id: scheduledActions.id,

      eventId: scheduledActions.eventId,

      actionKey: scheduledActions.actionKey,

      attemptCount: scheduledActions.attemptCount,
    });

  return claimedAction ?? null;
}

async function executeAction(
  client: Client<true>,
  action: {
    id: number;
    eventId: number;
    actionKey: string;
    attemptCount: number;
  },
): Promise<void> {
  if (action.actionKey.startsWith(REMINDER_ACTION_PREFIX)) {
    const reminderId = Number(
      action.actionKey.slice(REMINDER_ACTION_PREFIX.length),
    );

    if (!Number.isSafeInteger(reminderId) || reminderId <= 0) {
      throw new Error(`Invalid event reminder action key: ${action.actionKey}`);
    }

    await executeEventReminder(client, action.eventId, reminderId);

    return;
  }

  if (action.actionKey.startsWith(ORGANISER_WARNING_ACTION_PREFIX)) {
    const assignmentId = parseActionId(
      action.actionKey,
      ORGANISER_WARNING_ACTION_PREFIX,
    );

    await executeOrganiserWarning(client, action.eventId, assignmentId);

    return;
  }

  if (action.actionKey.startsWith(ORGANISER_TIMEOUT_ACTION_PREFIX)) {
    const assignmentId = parseActionId(
      action.actionKey,
      ORGANISER_TIMEOUT_ACTION_PREFIX,
    );

    await executeOrganiserTimeout(client, action.eventId, assignmentId);

    return;
  }

  if (action.actionKey.startsWith(ORGANISER_COVER_REQUEST_ACTION_PREFIX)) {
    const sourceAssignmentId = parseActionId(
      action.actionKey,
      ORGANISER_COVER_REQUEST_ACTION_PREFIX,
    );

    await executeOrganiserCoverRequest(
      client,
      action.eventId,
      sourceAssignmentId,
    );

    return;
  }

  if (action.actionKey.startsWith(ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX)) {
    const groupId = parseActionId(
      action.actionKey,
      ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX,
    );

    await executeRoleRequestGroupClose(client, action.eventId, groupId);

    return;
  }

  switch (action.actionKey) {
    case "publish_event":
      await executePublishEvent(client, action.eventId);
      return;

    case "close_attendance":
      await executeCloseAttendance(client, action.eventId);
      return;

    case "complete_event":
      await executeCompleteEvent(client, action.eventId);
      return;

    default:
      throw new Error(`Unknown scheduled action key: ${action.actionKey}`);
  }
}

async function executeOrganiserWarning(
  client: Client<true>,
  eventId: number,
  assignmentId: number,
): Promise<void> {
  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      discordUserId: eventOrganiserAssignments.discordUserId,

      slot: eventOrganiserAssignments.slot,

      status: eventOrganiserAssignments.status,

      isCurrent: eventOrganiserAssignments.isCurrent,

      activatedAt: eventOrganiserAssignments.activatedAt,

      responseDeadlineAt: eventOrganiserAssignments.responseDeadlineAt,

      eventName: events.name,

      eventStatus: events.status,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignmentId),

        eq(eventOrganiserAssignments.eventId, eventId),
      ),
    )
    .limit(1);

  if (!assignment) {
    return;
  }

  if (
    !assignment.isCurrent ||
    assignment.status !== "pending" ||
    !assignment.activatedAt ||
    !assignment.responseDeadlineAt ||
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    return;
  }

  const guild = await client.guilds.fetch(assignment.discordGuildId);

  /*
   * Fetching the guild crosses an external boundary and may take long enough
   * for the organiser assignment or parent event to change.
   *
   * Revalidate immediately before sending the warning so a confirmation,
   * decline, replacement, cancellation or completion which won after our
   * initial SELECT makes this action obsolete.
   */
  const [currentAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "pending"),

        isNotNull(eventOrganiserAssignments.activatedAt),

        isNotNull(eventOrganiserAssignments.responseDeadlineAt),

        ne(events.status, "cancelled"),
        ne(events.status, "completed"),
      ),
    )
    .limit(1);

  if (!currentAssignment) {
    return;
  }

  const sent = await sendOrganiserPendingWarning({
    guild,

    eventAdminChannelId: assignment.eventAdminChannelId,

    eventId,

    eventName: assignment.eventName,

    discordUserId: assignment.discordUserId,

    slot: assignment.slot,

    responseDeadlineAt: assignment.responseDeadlineAt,
  });

  if (!sent) {
    console.warn(
      `Organiser warning for assignment ${assignment.id} could not be posted because no usable Event Administration channel was available.`,
    );

    return;
  }

  await writeAuditLog({
    guildId: assignment.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.organiser_warning",

    outcome: "success",

    summary: `Warned that organiser assignment #${assignment.id} for "${assignment.eventName}" is still awaiting confirmation.`,

    targetType: "organiser_assignment",

    targetId: String(assignment.id),
  });
}

async function executeOrganiserTimeout(
  client: Client<true>,
  eventId: number,
  assignmentId: number,
): Promise<void> {
  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      eventName: events.name,

      eventStatus: events.status,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignmentId),

        eq(eventOrganiserAssignments.eventId, eventId),
      ),
    )
    .limit(1);

  if (!assignment) {
    return;
  }

  if (
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    return;
  }

  let assignmentTimedOut = false;

  try {
    assignmentTimedOut = await db.transaction(async (transaction) => {
      const now = new Date();

      /*
       * Acquire the assignment row first.
       *
       * The predicates preserve the existing protection against an
       * organiser confirming, declining or being replaced while the
       * timeout action is running.
       */
      const [timedOut] = await transaction
        .update(eventOrganiserAssignments)
        .set({
          status: "timed_out",

          isCurrent: false,

          endedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(eventOrganiserAssignments.id, assignment.id),

            eq(eventOrganiserAssignments.eventId, eventId),

            eq(eventOrganiserAssignments.isCurrent, true),

            eq(eventOrganiserAssignments.status, "pending"),

            isNotNull(eventOrganiserAssignments.activatedAt),
          ),
        )
        .returning({
          id: eventOrganiserAssignments.id,
        });

      /*
       * Confirmation, decline or replacement won the assignment race.
       */
      if (!timedOut) {
        return false;
      }

      /*
       * Re-read and lock the parent event after acquiring the assignment.
       *
       * If completion/cancellation won while this timeout was waiting,
       * roll the assignment mutation back. If the event is still active,
       * FOR UPDATE prevents a terminal transition from slipping in before
       * this transaction commits.
       */
      const [currentEvent] = await transaction
        .select({
          status: events.status,
        })
        .from(events)
        .where(eq(events.id, eventId))
        .for("update")
        .limit(1);

      if (
        !currentEvent ||
        currentEvent.status === "cancelled" ||
        currentEvent.status === "completed"
      ) {
        transaction.rollback();
      }

      return true;
    });
  } catch (error) {
    /*
     * rollback() here means the timeout became obsolete because the parent
     * event reached a terminal state while the action was in flight.
     *
     * That is not retryable scheduler failure.
     */
    if (error instanceof TransactionRollbackError) {
      return;
    }

    throw error;
  }

  if (!assignmentTimedOut) {
    return;
  }

  const guild = await client.guilds.fetch(assignment.discordGuildId);

  await writeAuditLog({
    guildId: assignment.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.organiser_timeout",

    outcome: "success",

    summary: `Organiser assignment #${assignment.id} for "${assignment.eventName}" timed out without confirmation.`,

    targetType: "organiser_assignment",

    targetId: String(assignment.id),
  });

  await escalateAfterFailedOrganiserAssignment({
    guild,

    eventId,

    failedAssignmentId: assignment.id,

    trigger: "timed_out",
  });
}

async function executeOrganiserCoverRequest(
  client: Client<true>,
  eventId: number,
  sourceAssignmentId: number,
): Promise<void> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,

      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    return;
  }

  const [sourceAssignment] = await db
    .select({
      status: eventOrganiserAssignments.status,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.id, sourceAssignmentId),

        eq(eventOrganiserAssignments.eventId, event.id),
      ),
    )
    .limit(1);

  if (
    !sourceAssignment ||
    (sourceAssignment.status !== "declined" &&
      sourceAssignment.status !== "timed_out")
  ) {
    return;
  }

  const [activeAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (activeAssignment) {
    return;
  }

  const guild = await client.guilds.fetch(event.discordGuildId);

  /*
   * Fetching the guild crosses an external boundary. The event lifecycle or
   * organiser assignments may change while that request is in flight.
   *
   * Revalidate every prerequisite for requesting cover immediately before
   * sending the Discord notification.
   */
  const [currentSourceAssignment] = await db
    .select({
      status: eventOrganiserAssignments.status,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, sourceAssignmentId),

        eq(eventOrganiserAssignments.eventId, event.id),

        inArray(eventOrganiserAssignments.status, ["declined", "timed_out"]),

        ne(events.status, "cancelled"),
        ne(events.status, "completed"),
      ),
    )
    .limit(1);

  if (!currentSourceAssignment) {
    return;
  }

  /*
   * A replacement organiser may also have been assigned while the Discord
   * guild was being fetched. In that case asking the wider organiser group
   * for cover is now obsolete.
   */
  const [currentActiveAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (currentActiveAssignment) {
    return;
  }

  const delivery = await sendOrganiserCoverRequest({
    guild,

    eventId: event.id,

    eventName: event.name,

    eventAdminChannelId: event.eventAdminChannelId,

    eventOrganiserRoleId: event.eventOrganiserRoleId,
  });

  if (delivery === "failed") {
    throw new Error(
      `Cover request for event ${event.id} could not be delivered. Check the Event Administration channel and Event Organiser role configuration.`,
    );
  }

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.organiser_cover_request",

    outcome: "success",

    summary: `Requested organiser cover for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      sourceAssignmentId,

      delivery,
    },
  });
}

async function executeRoleRequestGroupClose(
  client: Client<true>,
  eventId: number,
  groupId: number,
): Promise<void> {
  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      name: roleRequestGroups.name,

      eventId: roleRequestGroups.eventId,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,

      eventStatus: events.status,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        eq(roleRequestGroups.eventId, eventId),
      ),
    )
    .limit(1);

  if (!group) {
    return;
  }

  /*
   * A terminal parent event makes any outstanding role-request group close
   * action obsolete.
   *
   * The scheduler action itself may complete normally so it is not retried,
   * but there is no longer any live role-request lifecycle to mutate or
   * report as successfully closed.
   */
  if (group.eventStatus === "cancelled" || group.eventStatus === "completed") {
    return;
  }

  if (!group.closedAt) {
    let groupClosed = false;

    try {
      groupClosed = await db.transaction(async (transaction) => {
        const now = new Date();

        /*
         * Acquire the group row first.
         *
         * The closedAt predicate also means another successful close
         * which wins this race makes this scheduler action obsolete.
         */
        const [closedGroup] = await transaction
          .update(roleRequestGroups)
          .set({
            closedAt: now,

            updatedAt: now,
          })
          .where(
            and(
              eq(roleRequestGroups.id, group.id),
              isNull(roleRequestGroups.closedAt),
            ),
          )
          .returning({
            id: roleRequestGroups.id,
          });

        if (!closedGroup) {
          return false;
        }

        /*
         * Re-read and lock the parent event after acquiring the group row.
         *
         * This closes the race between the earlier eventStatus check and
         * the group mutation. If completion/cancellation already won, this
         * SELECT observes it. If the event is still active, FOR UPDATE
         * prevents a terminal lifecycle transition from slipping in before
         * this transaction commits.
         */
        const [currentEvent] = await transaction
          .select({
            status: events.status,
          })
          .from(events)
          .where(eq(events.id, eventId))
          .for("update")
          .limit(1);

        if (
          !currentEvent ||
          currentEvent.status === "cancelled" ||
          currentEvent.status === "completed"
        ) {
          transaction.rollback();
        }

        return true;
      });
    } catch (error) {
      /*
       * rollback() is intentional here: the scheduler discovered that its
       * group close became obsolete while the transaction was in flight.
       */
      if (error instanceof TransactionRollbackError) {
        return;
      }

      throw error;
    }

    if (!groupClosed) {
      return;
    }
  }

  const guild = await client.guilds.fetch(group.discordGuildId);

  await refreshRoleRequestGroupMessage(guild, group.id);

  await writeAuditLog({
    guildId: group.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.role_group_close",

    outcome: "success",

    summary: `Closed role-request group "${group.name}" (#${group.id}) for "${group.eventName}" (#${group.eventId}).`,

    targetType: "role_request_group",

    targetId: String(group.id),
  });

  console.log(
    `Closed role-request group ${group.id} for event ${group.eventId}.`,
  );
}

async function executePublishEvent(
  client: Client<true>,
  eventId: number,
): Promise<void> {
  const event = await loadScheduledEvent(eventId);

  /*
   * The event may have been deleted after the scheduled action
   * was created.
   */
  if (!event) {
    return;
  }

  /*
   * Manual early publication may have beaten this scheduled action.
   *
   * Cancellation/completion also makes publication irrelevant.
   */
  if (
    event.publishedAt ||
    event.status === "cancelled" ||
    event.status === "completed"
  ) {
    return;
  }

  const guild = await client.guilds.fetch(event.discordGuildId);

  const result = await publishStoredEvent(guild, eventId);

  if (!result.ok) {
    /*
     * These states can occur harmlessly because another operation
     * won a race with the scheduler.
     */
    if (
      result.reason === "not-found" ||
      result.reason === "already-published" ||
      result.reason === "inactive"
    ) {
      return;
    }

    /*
     * Retrying after the event start or signup deadline would not
     * make the publication valid again. Complete the scheduler action
     * normally, but leave an audit trail explaining why nothing was
     * published.
     */
    await writeAuditLog({
      guildId: event.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.publish_event",

      outcome: "failure",

      summary:
        result.reason === "event-started"
          ? `Scheduled publication for event #${eventId} was skipped because the event had already started.`
          : `Scheduled publication for event #${eventId} was skipped because its signup deadline had already passed.`,

      targetType: "event",

      targetId: String(eventId),

      details: {
        reason: result.reason,
      },
    });

    console.warn(
      `Scheduled publication for event ${eventId} was skipped: ${result.reason}.`,
    );

    return;
  }

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.publish_event",

    outcome: "success",

    summary: `Automatically published "${result.eventName}" (#${result.eventId}).`,

    targetType: "event",

    targetId: String(result.eventId),

    details: {
      messageUrl: result.messageUrl,

      primaryOrganiserNotification: result.primaryOrganiserNotification,
    },
  });

  console.log(`Automatically published event ${eventId}.`);
}

async function executeCloseAttendance(
  client: Client<true>,
  eventId: number,
): Promise<void> {
  const event = await loadScheduledEvent(eventId);

  if (!event) {
    /*
     * The event may have been deleted. There is nothing left to do,
     * so the action itself may safely complete.
     */
    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    return;
  }

  if (event.status !== "closed") {
    const [closedEvent] = await db
      .update(events)
      .set({
        status: "closed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(events.id, eventId),
          inArray(events.status, ["scheduled", "open"]),
        ),
      )
      .returning({
        id: events.id,
      });

    /*
     * Another lifecycle transition may have won after loadScheduledEvent()
     * read the event but before this conditional UPDATE ran.
     *
     * In that case the scheduler action itself is obsolete and may complete
     * normally, but attendance was not actually closed by this action.
     * Do not refresh Discord, log success or write a success audit.
     */
    if (!closedEvent) {
      return;
    }
  }

  if (event.publishedAt) {
    await refreshEventMessage(client, event.discordGuildId, eventId);
  }

  console.log(`Automatically closed attendance for event ${eventId}.`);

  const guild = await client.guilds.fetch(event.discordGuildId);

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.close_attendance",

    outcome: "success",

    summary: `Automatically closed attendance for event #${eventId}.`,

    targetType: "event",

    targetId: String(eventId),
  });
}

async function executeCompleteEvent(
  client: Client<true>,
  eventId: number,
): Promise<void> {
  const event = await loadScheduledEvent(eventId);

  if (!event) {
    return;
  }

  /*
   * Cancellation remains a final state.
   */
  if (event.status === "cancelled") {
    return;
  }

  if (event.status !== "completed") {
    const [completedEvent] = await db
      .update(events)
      .set({
        status: "completed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(events.id, eventId),
          inArray(events.status, ["scheduled", "open", "closed"]),
        ),
      )
      .returning({
        id: events.id,
      });

    /*
     * Another lifecycle transition may have won after loadScheduledEvent()
     * read the event but before this conditional UPDATE ran.
     *
     * In that case this completion action is now obsolete. The scheduler
     * action itself may finish normally, but this executor must not perform
     * completion cleanup, refresh Discord or claim successful completion.
     */
    if (!completedEvent) {
      return;
    }
  }

  /*
   * Completion makes outstanding attendance-close or publication
   * actions redundant.
   */
  await db
    .update(scheduledActions)
    .set({
      status: "completed",

      lockedAt: null,

      completedAt: new Date(),

      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledActions.eventId, eventId),
        inArray(scheduledActions.actionKey, [
          "close_attendance",
          "publish_event",
        ]),
        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    );

  /*
   * An event which has finished no longer needs organiser warnings,
   * timeouts or cover requests.
   */
  await cancelAllOrganiserEscalationActions(eventId);

  const completedGuild = await client.guilds.fetch(event.discordGuildId);

  await refreshRoleRequestMessages(completedGuild, eventId);

  if (event.publishedAt) {
    await refreshEventMessage(client, event.discordGuildId, eventId);
  }

  console.log(`Marked event ${eventId} as completed.`);

  const guild = completedGuild;

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.complete_event",

    outcome: "success",

    summary: `Automatically marked event #${eventId} as completed.`,

    targetType: "event",

    targetId: String(eventId),
  });
}

async function loadScheduledEvent(eventId: number) {
  const [event] = await db
    .select({
      id: events.id,

      status: events.status,

      publishedAt: events.publishedAt,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  return event ?? null;
}

async function refreshEventMessage(
  client: Client<true>,
  discordGuildId: string,
  eventId: number,
): Promise<void> {
  const guild = await client.guilds.fetch(discordGuildId);

  const result = await refreshAttendanceMessage(guild, eventId);

  /*
   * Database state is authoritative. A deleted Discord message should
   * not leave an event permanently stuck in "open".
   */
  if (!result.ok) {
    console.warn(
      `Event ${eventId} changed state, but its attendance message could not be refreshed: ${result.reason}.`,
    );
  }
}

async function markActionCompleted(actionId: number): Promise<void> {
  const now = new Date();

  await db
    .update(scheduledActions)
    .set({
      status: "completed",

      lockedAt: null,

      completedAt: now,

      lastError: null,

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.id, actionId),

        /*
         * Only the worker which still owns the processing action may
         * complete it.
         *
         * An administrator may have cancelled the action while it was
         * executing, in which case that newer terminal state wins.
         */
        eq(scheduledActions.status, "processing"),
      ),
    );
}

async function handleActionFailure(
  action: {
    id: number;
    eventId: number;
    actionKey: string;
    attemptCount: number;
  },
  error: unknown,
): Promise<void> {
  const errorMessage =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  const now = new Date();

  console.error(
    `Scheduled action ${action.id} (${action.actionKey}) for event ${action.eventId} failed on attempt ${action.attemptCount}:`,
    error,
  );

  if (action.attemptCount >= MAX_ATTEMPTS) {
    await db
      .update(scheduledActions)
      .set({
        status: "failed",

        lockedAt: null,

        lastError: errorMessage,

        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledActions.id, action.id),

          eq(scheduledActions.status, "processing"),
        ),
      );

    return;
  }

  /*
   * Basic increasing retry delay:
   * attempt 1 -> 1 minute
   * attempt 2 -> 2 minutes
   * attempt 3 -> 4 minutes
   * attempt 4 -> 8 minutes
   */
  const retryDelayMinutes = Math.min(2 ** (action.attemptCount - 1), 15);

  const retryAt = new Date(now.getTime() + retryDelayMinutes * 60_000);

  await db
    .update(scheduledActions)
    .set({
      status: "pending",

      dueAt: retryAt,

      lockedAt: null,

      lastError: errorMessage,

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.id, action.id),

        eq(scheduledActions.status, "processing"),
      ),
    );
}

async function executeEventReminder(
  client: Client<true>,
  eventId: number,
  reminderId: number,
): Promise<void> {
  const [reminder] = await db
    .select({
      id: eventReminders.id,

      eventId: eventReminders.eventId,

      message: eventReminders.message,

      channelId: eventReminders.channelId,

      pingEventRoles: eventReminders.pingEventRoles,

      enabled: eventReminders.enabled,

      sentAt: eventReminders.sentAt,

      missedAt: eventReminders.missedAt,

      timingReference: eventReminders.timingReference,

      minutesBefore: eventReminders.minutesBefore,

      eventName: events.name,

      eventStatus: events.status,

      startsAt: events.startsAt,

      attendanceClosesAt: events.attendanceClosesAt,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(eventReminders)
    .innerJoin(events, eq(events.id, eventReminders.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(eventReminders.id, reminderId),

        eq(eventReminders.eventId, eventId),
      ),
    )
    .limit(1);

  if (!reminder) {
    return;
  }

  if (!reminder.enabled || reminder.sentAt || reminder.missedAt) {
    return;
  }

  if (
    reminder.eventStatus === "cancelled" ||
    reminder.eventStatus === "completed"
  ) {
    return;
  }

  const referenceTime =
    reminder.timingReference === "event_start"
      ? reminder.startsAt
      : reminder.timingReference === "signup_close"
        ? reminder.attendanceClosesAt
        : null;

  if (!referenceTime) {
    throw new Error(`Reminder ${reminder.id} has no valid reference time.`);
  }

  const now = new Date();

  /*
   * If the thing the reminder was warning about has already
   * happened, sending it now would be misleading.
   */
  if (referenceTime <= now) {
    await markEventReminderMissed(client, reminder, referenceTime);

    return;
  }

  /*
   * This normally means an admin manually closed signups early.
   * reschedulePendingEventReminders() should already have cancelled
   * the action, but retain this as a defensive check.
   */
  if (
    reminder.timingReference === "signup_close" &&
    reminder.eventStatus !== "open"
  ) {
    return;
  }

  const guild = await client.guilds.fetch(reminder.discordGuildId);

  const sent = await sendEventCustomMessage({
    guild,

    eventId: reminder.eventId,

    eventName: reminder.eventName,

    channelId: reminder.channelId,

    message: reminder.message,

    pingEventRoles: reminder.pingEventRoles,

    hideMentions: true,
  });

  /*
   * Reuse the same `now` declared above. Do not redeclare it here.
   */
  await db
    .update(eventReminders)
    .set({
      sentAt: now,

      updatedAt: now,
    })
    .where(
      and(
        eq(eventReminders.id, reminder.id),

        eq(eventReminders.enabled, true),
      ),
    );

  await writeAuditLog({
    guildId: reminder.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.event_reminder",

    outcome: "success",

    summary: `Sent reminder #${reminder.id} for "${reminder.eventName}" (#${reminder.eventId}).`,

    targetType: "event",

    targetId: String(reminder.eventId),

    details: {
      reminderId: reminder.id,

      channelId: sent.channelId,

      messageId: sent.messageId,
    },
  });

  console.log(`Sent reminder ${reminder.id} for event ${reminder.eventId}.`);
}

async function markEventReminderMissed(
  client: Client<true>,
  reminder: {
    id: number;
    eventId: number;
    eventName: string;
    guildDatabaseId: number;
    discordGuildId: string;
    timingReference: string;
    minutesBefore: number;
  },
  referenceTime: Date,
): Promise<void> {
  const now = new Date();

  const scheduledAt = new Date(
    referenceTime.getTime() - reminder.minutesBefore * 60_000,
  );

  const reason =
    "The reminder remained pending until after its useful reference time had passed.";

  await db
    .update(eventReminders)
    .set({
      missedAt: now,

      missedReason: reason,

      updatedAt: now,
    })
    .where(
      and(
        eq(eventReminders.id, reminder.id),

        isNull(eventReminders.sentAt),

        isNull(eventReminders.missedAt),
      ),
    );

  const remaining = await db
    .select({
      id: eventReminders.id,
    })
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.eventId, reminder.eventId),

        eq(eventReminders.enabled, true),

        isNull(eventReminders.sentAt),

        isNull(eventReminders.missedAt),

        ne(eventReminders.id, reminder.id),
      ),
    );

  /*
   * `client` works here because executeEventReminder() explicitly
   * passes its Discord client into this helper.
   */
  const guild = await client.guilds.fetch(reminder.discordGuildId);

  const scheduledTimestamp = Math.floor(scheduledAt.getTime() / 1000);

  await writeAuditLog({
    guildId: reminder.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.reminder_missed",

    outcome: "failure",

    summary: [
      `Reminder #${reminder.id} for "${reminder.eventName}" (#${reminder.eventId}) was not sent before its useful window ended.`,
      `Scheduled for <t:${scheduledTimestamp}:F>.`,
      `${remaining.length} other unsent reminder(s) remain.`,
      "Use `/event reminder-list` to review them, `/event reminder-add` to schedule another reminder, or `/event announce` to send an immediate message.",
    ].join("\n"),

    targetType: "event",

    targetId: String(reminder.eventId),

    details: {
      reminderId: reminder.id,

      scheduledAt: scheduledAt.toISOString(),

      timingReference: reminder.timingReference,

      remainingReminderCount: remaining.length,
    },
  });

  console.warn(
    `Reminder ${reminder.id} for event ${reminder.eventId} was missed.`,
  );
}

function parseActionId(actionKey: string, prefix: string): number {
  const id = Number(actionKey.slice(prefix.length));

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid scheduled action key: ${actionKey}`);
  }

  return id;
}
