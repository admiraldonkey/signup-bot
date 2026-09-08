import { type Client } from "discord.js";
import {
  and,
  eq,
  gte,
  inArray,
  like,
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
  ORGANISER_COVER_DEADLINE_ACTION_PREFIX,
  ORGANISER_MISSING_AT_START_ACTION_PREFIX,
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
  cancelAllOrganiserEscalationActions,
} from "../organisers/organiser-scheduling.js";
import { openOrganiserCoverAtSafetyDeadline } from "../organisers/organiser-safety-service.js";
import {
  sendOrganiserCoverRequest,
  sendOrganiserMissingAtStartAlert,
  sendOrganiserPendingWarning,
} from "../events/organiser-notification.js";
import { reconcileOrganiserPendingWarning } from "../events/organiser-warning-reconciliation.js";
import {
  ROLE_REQUEST_GROUP_OPEN_ACTION_PREFIX,
  ROLE_REQUEST_GROUP_CLOSE_ACTION_PREFIX,
  makeRoleRequestGroupOpenActionKey,
} from "../role-requests/role-request-scheduling.js";

import { publishRoleRequestGroup } from "../role-requests/role-request-group-publication.js";
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

    await failExhaustedPendingActions();

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

async function failExhaustedPendingActions(): Promise<void> {
  const now = new Date();

  /*
   * A persisted pending action which has already consumed every permitted
   * attempt must never be claimed again.
   *
   * This can exist after interrupted legacy recovery or inconsistent
   * persisted scheduler state. Repair it proactively rather than leaving
   * an unclaimable pending row behind forever.
   */
  const failed = await db
    .update(scheduledActions)
    .set({
      status: "failed",

      lockedAt: null,

      lastError:
        "Failed without execution because the maximum attempt count had already been reached.",

      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledActions.status, "pending"),

        gte(scheduledActions.attemptCount, MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: scheduledActions.id,
    });

  if (failed.length > 0) {
    console.warn(
      `Failed ${failed.length} pending scheduled action(s) which had already exhausted their allowed attempts.`,
    );
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

      await markActionCompleted(claimedAction.id, claimedAction.attemptCount);
    } catch (error) {
      await handleActionFailure(claimedAction, error);
    }
  }
}

export async function claimAction(actionId: number) {
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

        /*
         * This is the authoritative attempt-limit fence.
         *
         * Even if inconsistent persisted state appears after the scheduler's
         * cleanup/select phase, claimAction() itself must never create attempt
         * MAX_ATTEMPTS + 1.
         */
        lt(scheduledActions.attemptCount, MAX_ATTEMPTS),
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

  if (action.actionKey.startsWith(ORGANISER_COVER_DEADLINE_ACTION_PREFIX)) {
    const actionEventId = parseActionId(
      action.actionKey,
      ORGANISER_COVER_DEADLINE_ACTION_PREFIX,
    );

    /*
     * The event ID is stored both in scheduled_actions.event_id and the
     * stable action key. Treat a disagreement as corrupt durable state rather
     * than silently executing the action against one of the two events.
     */
    if (actionEventId !== action.eventId) {
      throw new Error(
        `Organiser cover-deadline action "${action.actionKey}" belongs to event ${action.eventId}, but its action key refers to event ${actionEventId}.`,
      );
    }

    await executeOrganiserCoverDeadline(client, action.eventId);

    return;
  }

  if (action.actionKey.startsWith(ORGANISER_MISSING_AT_START_ACTION_PREFIX)) {
    const actionEventId = parseActionId(
      action.actionKey,
      ORGANISER_MISSING_AT_START_ACTION_PREFIX,
    );

    if (actionEventId !== action.eventId) {
      throw new Error(
        `Organiser missing-at-start action "${action.actionKey}" belongs to event ${action.eventId}, but its action key refers to event ${actionEventId}.`,
      );
    }

    await executeOrganiserMissingAtStart(client, action.eventId);

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

  if (action.actionKey.startsWith(ROLE_REQUEST_GROUP_OPEN_ACTION_PREFIX)) {
    const groupId = parseActionId(
      action.actionKey,
      ROLE_REQUEST_GROUP_OPEN_ACTION_PREFIX,
    );

    await executeRoleRequestGroupOpen(
      client,
      action.id,
      action.eventId,
      groupId,
      action.attemptCount,
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

      organisersEnabled: guildSettings.organisersEnabled,
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
    !assignment.organisersEnabled ||
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
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        eq(eventOrganiserAssignments.eventId, eventId),

        eq(guildSettings.organisersEnabled, true),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "pending"),

        isNotNull(eventOrganiserAssignments.activatedAt),

        isNotNull(eventOrganiserAssignments.responseDeadlineAt),

        isNull(eventOrganiserAssignments.warningMessageId),

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
    /*
     * A null delivery means the configured Event Administration destination is
     * definitively unavailable rather than temporarily failing.
     *
     * The scheduler action should therefore complete without retrying, but the
     * missed warning must remain visible in the persistent audit trail.
     */
    await writeAuditLog({
      guildId: assignment.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.organiser_warning",

      outcome: "failure",

      summary: `Could not warn that organiser assignment #${assignment.id} for "${assignment.eventName}" is still awaiting confirmation because no usable Event Administration channel was available.`,

      targetType: "organiser_assignment",

      targetId: String(assignment.id),

      details: {
        delivery: "failed",
      },
    });

    console.warn(
      `Organiser warning for assignment ${assignment.id} could not be posted because no usable Event Administration channel was available.`,
    );

    return;
  }

  /*
   * Persist the exact Discord warning which was actually posted.
   *
   * Do not require the assignment to still be pending here. The organiser may
   * have responded while channel.send() was in flight. Recording the Discord
   * location even in that case gives us something concrete to reconcile.
   *
   * The NULL predicate prevents a second execution from replacing an already
   * authoritative warning linkage.
   */
  const [storedWarning] = await db
    .update(eventOrganiserAssignments)
    .set({
      warningChannelId: sent.channelId,

      warningMessageId: sent.messageId,

      updatedAt: new Date(),
    })
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        isNull(eventOrganiserAssignments.warningMessageId),
      ),
    )
    .returning({
      id: eventOrganiserAssignments.id,
    });

  if (!storedWarning) {
    /*
     * Another execution has already established an authoritative warning
     * linkage. Do not claim this send as the live warning.
     *
     * We will add explicit duplicate-cleanup coverage when we exercise this
     * concurrency case.
     */
    return;
  }

  /*
   * Discord send was an external boundary. Re-check after it completes.
   *
   * If the organiser responded, was replaced, or the event became terminal
   * while the warning was being sent, reconcile the just-recorded message
   * rather than leaving a stale pending warning behind.
   */
  const [postSendState] = await db
    .select({
      status: eventOrganiserAssignments.status,

      isCurrent: eventOrganiserAssignments.isCurrent,

      eventStatus: events.status,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .where(eq(eventOrganiserAssignments.id, assignment.id))
    .limit(1);

  if (
    !postSendState ||
    !postSendState.isCurrent ||
    postSendState.status !== "pending" ||
    postSendState.eventStatus === "cancelled" ||
    postSendState.eventStatus === "completed"
  ) {
    await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: assignment.id,
    }).catch((error: unknown) => {
      console.error(
        `Failed to reconcile organiser warning for assignment ${assignment.id} after its state changed during delivery:`,
        error,
      );
    });

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

  let timeoutResult: "timed_out" | "obsolete" | "organisers_disabled" =
    "obsolete";

  try {
    timeoutResult = await db.transaction(async (transaction) => {
      /*
       * Hold a shared feature lock for the authoritative timeout mutation.
       *
       * Other organiser workflows may proceed concurrently, while the
       * exclusive organiser-disable transition must wait for this operation
       * to finish.
       */
      const [featureSettings] = await transaction
        .select({
          organisersEnabled: guildSettings.organisersEnabled,
        })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, assignment.guildDatabaseId))
        .limit(1)
        .for("share");

      if (!featureSettings?.organisersEnabled) {
        return "organisers_disabled" as const;
      }

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
        return "obsolete" as const;
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

      return "timed_out" as const;
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

  if (timeoutResult !== "timed_out") {
    return;
  }

  const guild = await client.guilds.fetch(assignment.discordGuildId);

  await reconcileOrganiserPendingWarning({
    guild,
    assignmentId: assignment.id,
  }).catch((error: unknown) => {
    /*
     * The timeout is already authoritative. Failure to tidy an older Discord
     * warning must not undo the timeout or prevent organiser escalation.
     */
    console.error(
      `Failed to reconcile organiser warning for assignment ${assignment.id} after timeout:`,
      error,
    );
  });

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

async function executeOrganiserCoverDeadline(
  client: Client<true>,
  eventId: number,
): Promise<void> {
  /*
   * Perform the authoritative PostgreSQL transition first.
   *
   * The service is responsible for:
   *
   * - feature/lifecycle locking;
   * - detecting already-confirmed ownership;
   * - retiring unresolved primary/backup assignments;
   * - cancelling their warning/timeout actions; and
   * - detecting an already-existing general-cover request.
   *
   * Discord remains a secondary side effect.
   */
  const transition = await openOrganiserCoverAtSafetyDeadline({
    eventId,
  });

  if (
    transition.kind === "not_due" ||
    transition.kind === "already_resolved" ||
    transition.kind === "organisers_disabled" ||
    transition.kind === "event_inactive"
  ) {
    return;
  }

  /*
   * From this point onwards the database transition, where applicable, has
   * already committed.
   *
   * A transient Discord guild-fetch failure should therefore retry this
   * scheduler action. The safety service is idempotent and will re-read the
   * authoritative state on the next attempt.
   */
  const guild = await client.guilds.fetch(transition.event.discordGuildId);

  /*
   * Retired assignments may have an outstanding administration warning.
   * Reconcile each warning independently so presentation cleanup cannot
   * prevent the more important general-cover escalation.
   */
  await Promise.all(
    transition.retiredAssignmentIds.map(async (assignmentId) => {
      await reconcileOrganiserPendingWarning({
        guild,

        assignmentId,
      }).catch((error: unknown) => {
        console.error(
          `Failed to reconcile organiser warning for assignment ${assignmentId} after event ${eventId} reached its organiser cover deadline:`,
          error,
        );
      });
    }),
  );

  /*
   * The public event message should immediately stop showing the retired
   * nominated organiser.
   *
   * As elsewhere in the scheduler, PostgreSQL state remains authoritative if
   * Discord presentation refresh fails.
   */
  await refreshAttendanceMessage(guild, eventId)
    .then((result) => {
      if (!result.ok) {
        console.warn(
          `Event ${eventId} reached its organiser cover deadline, but its attendance message could not be refreshed: ${result.reason}.`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(
        `Failed to refresh event ${eventId} after its organiser cover deadline:`,
        error,
      );
    });

  /*
   * Ordinary primary/backup escalation may already have opened general
   * cover before the hard T-15 safety deadline.
   *
   * In that case the safety transition may still have retired another
   * unresolved nominee, but another Discord cover request would be noise.
   */
  if (transition.kind === "cover_already_requested") {
    await writeAuditLog({
      guildId: transition.event.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.organiser_cover_deadline",

      outcome: "success",

      summary: `Reached the organiser cover safety deadline for "${transition.event.name}" (#${transition.event.id}); unresolved nominated organisers were retired and general cover had already been requested.`,

      targetType: "event",

      targetId: String(transition.event.id),

      details: {
        retiredAssignmentIds: transition.retiredAssignmentIds,

        coverRequest: "already_requested",
      },
    });

    return;
  }

  /*
   * Fetching the Discord guild crossed an external boundary.
   *
   * The event, organiser feature or ownership state may have changed while
   * that request was in flight, so revalidate immediately before sending a
   * new general-cover request.
   */
  const [currentEvent] = await db
    .select({
      status: events.status,

      publishedAt: events.publishedAt,

      startsAt: events.startsAt,

      organisersEnabled: guildSettings.organisersEnabled,
    })
    .from(events)
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (
    !currentEvent ||
    !currentEvent.organisersEnabled ||
    !currentEvent.publishedAt ||
    currentEvent.startsAt <= new Date() ||
    currentEvent.status === "cancelled" ||
    currentEvent.status === "completed"
  ) {
    return;
  }

  /*
   * A confirmed organiser may have been assigned or may have claimed cover
   * while guilds.fetch() was in flight.
   *
   * Confirmation wins over the stale safety-deadline delivery decision.
   */
  const [confirmedAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "confirmed"),
      ),
    )
    .limit(1);

  if (confirmedAssignment) {
    return;
  }

  /*
   * Ordinary organiser escalation could also have queued or delivered a
   * cover request while the guild fetch was in flight.
   *
   * Re-check that separately so the two escalation paths cannot race into
   * duplicate Discord requests.
   */
  const [existingCoverRequest] = await db
    .select({
      id: scheduledActions.id,
    })
    .from(scheduledActions)
    .where(
      and(
        eq(scheduledActions.eventId, eventId),

        like(
          scheduledActions.actionKey,
          `${ORGANISER_COVER_REQUEST_ACTION_PREFIX}%`,
        ),

        inArray(scheduledActions.status, [
          "pending",
          "processing",
          "completed",
        ]),
      ),
    )
    .limit(1);

  if (existingCoverRequest) {
    return;
  }

  const delivery = await sendOrganiserCoverRequest({
    guild,

    eventId: transition.event.id,

    eventName: transition.event.name,

    eventAdminChannelId: transition.event.eventAdminChannelId,

    eventOrganiserRoleId: transition.event.eventOrganiserRoleId,
  });

  if (delivery === "failed") {
    /*
     * This matches the existing source-assignment cover-request executor:
     * a definitively missing/unusable Discord destination is not helped by
     * scheduler retries against unchanged configuration.
     */
    await writeAuditLog({
      guildId: transition.event.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.organiser_cover_deadline",

      outcome: "failure",

      summary: `Could not request organiser cover for "${transition.event.name}" (#${transition.event.id}) at its safety deadline because the configured Event Administration channel or Event Organiser role is unavailable.`,

      targetType: "event",

      targetId: String(transition.event.id),

      details: {
        retiredAssignmentIds: transition.retiredAssignmentIds,

        delivery,
      },
    });

    console.warn(
      `Organiser cover request for event ${transition.event.id} could not be delivered at its safety deadline because the configured Event Administration channel or Event Organiser role is unavailable.`,
    );

    return;
  }

  await writeAuditLog({
    guildId: transition.event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.organiser_cover_deadline",

    outcome: "success",

    summary: `Reached the organiser cover safety deadline for "${transition.event.name}" (#${transition.event.id}) and requested general organiser cover.`,

    targetType: "event",

    targetId: String(transition.event.id),

    details: {
      retiredAssignmentIds: transition.retiredAssignmentIds,

      delivery,
    },
  });
}

async function executeOrganiserMissingAtStart(
  client: Client<true>,
  eventId: number,
): Promise<void> {
  /*
   * Reuse the authoritative safety transition.
   *
   * Normally T-15 has already retired unresolved nominated organisers.
   * Calling it again makes T+0 robust if the earlier action never reached
   * its database transition.
   */
  const transition = await openOrganiserCoverAtSafetyDeadline({
    eventId,
  });

  if (
    transition.kind === "not_due" ||
    transition.kind === "already_resolved" ||
    transition.kind === "organisers_disabled" ||
    transition.kind === "event_inactive"
  ) {
    return;
  }

  const guild = await client.guilds.fetch(transition.event.discordGuildId);

  /*
   * T+0 may itself have performed the retirement if T-15 never got that
   * far. Clean up any warnings and public presentation in that case.
   */
  if (transition.retiredAssignmentIds.length > 0) {
    await Promise.all(
      transition.retiredAssignmentIds.map(async (assignmentId) => {
        await reconcileOrganiserPendingWarning({
          guild,

          assignmentId,
        }).catch((error: unknown) => {
          console.error(
            `Failed to reconcile organiser warning for assignment ${assignmentId} after event ${eventId} started without an organiser:`,
            error,
          );
        });
      }),
    );

    await refreshAttendanceMessage(guild, eventId)
      .then((result) => {
        if (!result.ok) {
          console.warn(
            `Event ${eventId} started without an organiser, but its attendance message could not be refreshed: ${result.reason}.`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error(
          `Failed to refresh event ${eventId} after it started without an organiser:`,
          error,
        );
      });
  }

  /*
   * guilds.fetch() is an external race boundary.
   *
   * Revalidate the feature, lifecycle, start time and organiser ownership
   * immediately before creating a new urgent Discord notification.
   */
  const [currentEvent] = await db
    .select({
      status: events.status,

      publishedAt: events.publishedAt,

      startsAt: events.startsAt,

      organisersEnabled: guildSettings.organisersEnabled,
    })
    .from(events)
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (
    !currentEvent ||
    !currentEvent.organisersEnabled ||
    !currentEvent.publishedAt ||
    currentEvent.startsAt > new Date() ||
    currentEvent.status === "cancelled" ||
    currentEvent.status === "completed"
  ) {
    return;
  }

  /*
   * An organiser may have claimed cover or been manually confirmed while
   * the guild fetch was in flight.
   */
  const [confirmedAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "confirmed"),
      ),
    )
    .limit(1);

  if (confirmedAssignment) {
    return;
  }

  /*
   * Unlike the T-15 executor, deliberately DO NOT reject this send merely
   * because an earlier cover request exists.
   *
   * This message is the escalation that the event has actually started
   * without anybody taking responsibility.
   */
  const delivery = await sendOrganiserMissingAtStartAlert({
    guild,

    eventId: transition.event.id,

    eventName: transition.event.name,

    eventAdminChannelId: transition.event.eventAdminChannelId,

    eventOrganiserRoleId: transition.event.eventOrganiserRoleId,
  });

  if (delivery === "failed") {
    await writeAuditLog({
      guildId: transition.event.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.organiser_missing_at_start",

      outcome: "failure",

      summary: `Could not alert administrators that "${transition.event.name}" (#${transition.event.id}) started without an organiser because the configured Event Administration channel or Event Organiser role is unavailable.`,

      targetType: "event",

      targetId: String(transition.event.id),

      details: {
        retiredAssignmentIds: transition.retiredAssignmentIds,

        priorCoverState: transition.kind,

        delivery,
      },
    });

    console.warn(
      `Missing-organiser start alert for event ${transition.event.id} could not be delivered because the configured Event Administration channel or Event Organiser role is unavailable.`,
    );

    return;
  }

  await writeAuditLog({
    guildId: transition.event.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.organiser_missing_at_start",

    outcome: "success",

    summary: `Alerted that "${transition.event.name}" (#${transition.event.id}) started without a confirmed organiser.`,

    targetType: "event",

    targetId: String(transition.event.id),

    details: {
      retiredAssignmentIds: transition.retiredAssignmentIds,

      priorCoverState: transition.kind,

      delivery,
    },
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

      startsAt: events.startsAt,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventAdminChannelId: guildSettings.eventAdminChannelId,

      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,

      organisersEnabled: guildSettings.organisersEnabled,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return;
  }

  if (
    !event.organisersEnabled ||
    event.startsAt <= new Date() ||
    event.status === "cancelled" ||
    event.status === "completed"
  ) {
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

      startsAt: events.startsAt,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .innerJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(
      and(
        eq(eventOrganiserAssignments.id, sourceAssignmentId),

        eq(eventOrganiserAssignments.eventId, event.id),

        eq(guildSettings.organisersEnabled, true),

        inArray(eventOrganiserAssignments.status, ["declined", "timed_out"]),

        ne(events.status, "cancelled"),

        ne(events.status, "completed"),
      ),
    )
    .limit(1);

  if (
    !currentSourceAssignment ||
    currentSourceAssignment.startsAt <= new Date()
  ) {
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
    /*
     * The notification boundary uses "failed" only for a definitively
     * unavailable configured destination, such as a deleted Event
     * Administration channel or Event Organiser role.
     *
     * Retrying the same unchanged configuration through scheduler backoff
     * cannot make that delivery succeed, so record the failure and allow the
     * durable action to complete normally.
     */
    await writeAuditLog({
      guildId: event.guildDatabaseId,

      guild,

      actorUserId: null,

      action: "scheduler.organiser_cover_request",

      outcome: "failure",

      summary: `Could not request organiser cover for "${event.name}" (#${event.id}) because the configured Event Administration channel or Event Organiser role is unavailable.`,

      targetType: "event",

      targetId: String(event.id),

      details: {
        sourceAssignmentId,

        delivery,
      },
    });

    console.warn(
      `Organiser cover request for event ${event.id} could not be delivered because the configured Event Administration channel or Event Organiser role is unavailable.`,
    );

    return;
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

async function executeRoleRequestGroupOpen(
  client: Client<true>,
  actionId: number,
  eventId: number,
  groupId: number,
  attemptCount: number,
): Promise<void> {
  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      name: roleRequestGroups.name,

      eventId: roleRequestGroups.eventId,

      eventName: events.name,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        /*
         * The durable action carries its owning event separately from the
         * group ID embedded in the action key.
         *
         * Requiring both to agree treats mismatched durable state as
         * obsolete rather than accidentally publishing another event's
         * group.
         */
        eq(roleRequestGroups.eventId, eventId),
      ),
    )
    .limit(1);

  if (!group) {
    return;
  }

  const guild = await client.guilds.fetch(group.discordGuildId);

  const result = await publishRoleRequestGroup(guild, group.id);

  if (!result.ok) {
    /*
     * These states mean there is no remaining opening work for this
     * particular durable action.
     *
     * Another operation may already have published the group, or the parent
     * event/group may have become terminal while this worker was active.
     */
    if (
      result.reason === "not-found" ||
      result.reason === "already-posted" ||
      result.reason === "inactive"
    ) {
      return;
    }

    /*
     * The durable action may have been claimed using an old dueAt shortly
     * before an event edit moved the group's authoritative opening later.
     *
     * Restore this same action to pending at the current opensAt rather than
     * completing it or treating the edit as a delivery failure.
     *
     * Reset attemptCount because an ordinary schedule edit must not consume
     * the five-attempt failure budget.
     */
    if (result.reason === "not-open-yet") {
      const now = new Date();

      await db
        .update(scheduledActions)
        .set({
          status: "pending",

          dueAt: result.opensAt,

          attemptCount: 0,

          lockedAt: null,

          completedAt: null,

          lastError: null,

          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledActions.id, actionId),

            eq(scheduledActions.eventId, eventId),

            eq(
              scheduledActions.actionKey,
              makeRoleRequestGroupOpenActionKey(groupId),
            ),

            /*
             * Only the worker which still owns this exact processing attempt
             * may reschedule it.
             *
             * If stale recovery or another operation has already replaced
             * this state, this UPDATE affects zero rows and the newer state
             * remains authoritative.
             */
            eq(scheduledActions.status, "processing"),

            eq(scheduledActions.attemptCount, attemptCount),
          ),
        );

      console.log(
        `Rescheduled role-request group ${group.id} opening to ${result.opensAt.toISOString()}.`,
      );

      return;
    }

    /*
     * Once the request window has expired, retrying cannot make the missed
     * opening useful again.
     *
     * Likewise, a deleted/unavailable snapshotted destination must not be
     * silently replaced with the guild's current default channel. The event
     * snapshot remains authoritative.
     *
     * Record either condition and let the outer scheduler loop complete the
     * action normally rather than burning through retry attempts.
     */
    if (
      result.reason === "window-expired" ||
      result.reason === "channel-unavailable"
    ) {
      await writeAuditLog({
        guildId: group.guildDatabaseId,

        guild,

        actorUserId: null,

        action: "scheduler.role_group_open",

        outcome: "failure",

        summary:
          result.reason === "window-expired"
            ? `Could not automatically open role-request group "${group.name}" (#${group.id}) for "${group.eventName}" (#${group.eventId}) because its request window had already expired.`
            : `Could not automatically open role-request group "${group.name}" (#${group.id}) for "${group.eventName}" (#${group.eventId}) because its snapshotted Discord channel was unavailable.`,

        targetType: "role_request_group",

        targetId: String(group.id),

        details:
          result.reason === "channel-unavailable"
            ? {
                reason: result.reason,

                channelId: result.channelId,
              }
            : {
                reason: result.reason,
              },
      });

      console.warn(
        result.reason === "window-expired"
          ? `Role-request group ${group.id} was not opened because its request window had already expired.`
          : `Role-request group ${group.id} was not opened because its snapshotted channel ${result.channelId} was unavailable.`,
      );

      return;
    }

    /*
     * Exhaustiveness guard.
     *
     * If publication gains another permanent result in future, TypeScript
     * should force the scheduler to decide explicitly whether that result is
     * obsolete, retryable, reschedulable or auditable.
     */
    const exhaustiveResult: never = result;

    throw new Error(
      `Unhandled role-request publication result: ${JSON.stringify(
        exhaustiveResult,
      )}`,
    );
  }

  await writeAuditLog({
    guildId: group.guildDatabaseId,

    guild,

    actorUserId: null,

    action: "scheduler.role_group_open",

    outcome: "success",

    summary: `Automatically opened role-request group "${group.name}" (#${group.id}) for "${group.eventName}" (#${group.eventId}).`,

    targetType: "role_request_group",

    targetId: String(group.id),

    details: {
      messageUrl: result.messageUrl,

      notification: result.notification,
    },
  });

  console.log(
    `Opened role-request group ${group.id} for event ${group.eventId}.`,
  );
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

  /*
   * Completion leaves organiser assignment history intact, but any warning
   * belonging to a still-current pending assignment is now obsolete.
   *
   * Query only after completion is authoritative so Discord presentation
   * always follows PostgreSQL state.
   */
  const warnedOrganiserAssignments = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.status, "pending"),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.warningChannelId),

        isNotNull(eventOrganiserAssignments.warningMessageId),
      ),
    );

  for (const assignment of warnedOrganiserAssignments) {
    await reconcileOrganiserPendingWarning({
      guild: completedGuild,

      assignmentId: assignment.id,
    }).catch((error: unknown) => {
      /*
       * Event completion is already authoritative. Failure to tidy an old
       * Discord warning must not undo or misreport the completion.
       */
      console.error(
        `Failed to reconcile organiser warning for assignment ${assignment.id} after event completion:`,
        error,
      );
    });
  }

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

async function markActionCompleted(
  actionId: number,
  attemptCount: number,
): Promise<void> {
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
         * Only the worker which still owns this exact processing attempt
         * may complete the durable action.
         *
         * A newer terminal state may have replaced processing while this
         * worker was executing, or stale recovery may have returned the
         * action to pending and allowed another worker to claim a newer
         * attempt.
         */
        eq(scheduledActions.status, "processing"),

        eq(scheduledActions.attemptCount, attemptCount),
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

          /*
           * A stale worker may finish after this action has already been
           * recovered and claimed for a newer attempt.
           *
           * Processing status alone therefore does not prove ownership. The
           * persisted attempt number must still match the attempt which produced
           * this failure.
           */
          eq(scheduledActions.attemptCount, action.attemptCount),
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

        /*
         * Do not let an older failed attempt reschedule or unlock a newer
         * attempt which now owns this durable action.
         */
        eq(scheduledActions.attemptCount, action.attemptCount),
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
