import { type Client } from "discord.js";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, events, scheduledActions } from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";

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
      ),
    )
    .returning({
      id: scheduledActions.id,
    });

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
  switch (action.actionKey) {
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
    await db
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
      );
  }

  await refreshEventMessage(client, event.discordGuildId, eventId);

  console.log(`Automatically closed attendance for event ${eventId}.`);
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
    await db
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
      );
  }

  /*
   * A completion action makes an outstanding close action redundant.
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
        eq(scheduledActions.actionKey, "close_attendance"),
        inArray(scheduledActions.status, ["pending", "processing"]),
      ),
    );

  await refreshEventMessage(client, event.discordGuildId, eventId);

  console.log(`Marked event ${eventId} as completed.`);
}

async function loadScheduledEvent(eventId: number) {
  const [event] = await db
    .select({
      id: events.id,

      status: events.status,

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
    .where(eq(scheduledActions.id, actionId));
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
      .where(eq(scheduledActions.id, action.id));

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
    .where(eq(scheduledActions.id, action.id));
}
