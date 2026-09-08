import { and, eq, inArray, like, or } from "drizzle-orm";

import { db } from "../db/client.js";

import {
  discordGuilds,
  eventOrganiserAssignments,
  events,
  guildSettings,
  scheduledActions,
} from "../db/schema.js";

import {
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
  calculateOrganiserCoverDeadline,
} from "./organiser-scheduling.js";

type OrganiserSafetyEvent = {
  id: number;

  name: string;

  guildDatabaseId: number;

  discordGuildId: string;

  eventAdminChannelId: string | null;

  eventOrganiserRoleId: string | null;
};

export type OpenOrganiserCoverAtSafetyDeadlineResult =
  | {
      kind: "cover_required";

      event: OrganiserSafetyEvent;

      retiredAssignmentIds: number[];
    }
  | {
      kind: "cover_already_requested";

      event: OrganiserSafetyEvent;

      retiredAssignmentIds: number[];
    }
  | {
      kind: "not_due";
    }
  | {
      kind: "already_resolved";
    }
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_inactive";
    };

/**
 * Applies the authoritative organiser transition at the event-level
 * general-cover safety deadline.
 *
 * If no organiser has confirmed by this point:
 *
 * - current pending primary/backup assignments are retired;
 * - their outstanding response warning/timeout work is cancelled; and
 * - the caller is told whether a general-cover request still needs to
 *   be delivered.
 *
 * Discord delivery, presentation reconciliation and auditing remain the
 * caller's responsibility.
 */
export async function openOrganiserCoverAtSafetyDeadline(input: {
  eventId: number;
}): Promise<OpenOrganiserCoverAtSafetyDeadlineResult> {
  /*
   * Resolve the owning guild before entering the authoritative transaction.
   *
   * Guild ownership does not move between events. The event itself is
   * revalidated and locked inside the transaction before any mutation occurs.
   */
  const [eventIdentity] = await db
    .select({
      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, input.eventId))
    .limit(1);

  if (!eventIdentity) {
    return {
      kind: "event_inactive",
    };
  }

  return db.transaction(async (transaction) => {
    /*
     * Follow the established organiser-feature locking contract.
     *
     * Ordinary organiser mutations take FOR SHARE. Disabling organisers
     * takes FOR UPDATE and therefore serialises against this transition.
     */
    const [featureSettings] = await transaction
      .select({
        organisersEnabled: guildSettings.organisersEnabled,

        organiserCoverBeforeStartMinutes:
          guildSettings.organiserCoverBeforeStartMinutes,

        eventAdminChannelId: guildSettings.eventAdminChannelId,

        eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,
      })
      .from(guildSettings)
      .where(eq(guildSettings.guildId, eventIdentity.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!featureSettings?.organisersEnabled) {
      return {
        kind: "organisers_disabled",
      } as const;
    }

    /*
     * Lock all current unresolved/resolved ownership rows first.
     *
     * Existing timeout/escalation paths acquire assignment ownership before
     * their event lifecycle lock, so retaining that ordering avoids creating
     * an assignment-vs-event lock inversion.
     */
    const currentAssignments = await transaction
      .select({
        id: eventOrganiserAssignments.id,

        slot: eventOrganiserAssignments.slot,

        status: eventOrganiserAssignments.status,
      })
      .from(eventOrganiserAssignments)
      .where(
        and(
          eq(eventOrganiserAssignments.eventId, input.eventId),

          eq(eventOrganiserAssignments.isCurrent, true),

          inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
        ),
      )
      .orderBy(eventOrganiserAssignments.id)
      .for("update");

    /*
     * Now lock the parent lifecycle boundary.
     */
    const [event] = await transaction
      .select({
        id: events.id,

        name: events.name,

        status: events.status,

        publishedAt: events.publishedAt,

        startsAt: events.startsAt,
      })
      .from(events)
      .where(eq(events.id, input.eventId))
      .limit(1)
      .for("update");

    if (
      !event ||
      !event.publishedAt ||
      event.status === "cancelled" ||
      event.status === "completed"
    ) {
      return {
        kind: "event_inactive",
      } as const;
    }

    const now = new Date();

    const coverDeadline = calculateOrganiserCoverDeadline(
      event.startsAt,
      featureSettings.organiserCoverBeforeStartMinutes,
    );

    /*
     * A scheduler worker may have claimed the old action immediately before an
     * administrator moved the event.
     *
     * The current event schedule is authoritative. Do not let stale durable work
     * retire organiser ownership before the newly-calculated safety deadline.
     */
    if (now < coverDeadline) {
      return {
        kind: "not_due",
      } as const;
    }

    /*
     * A confirmed current assignment means organiser ownership has already
     * been successfully resolved. The safety deadline has nothing to do.
     *
     * This includes a claimed general-cover assignment.
     */
    const confirmedAssignment = currentAssignments.find(
      (assignment) => assignment.status === "confirmed",
    );

    if (confirmedAssignment) {
      return {
        kind: "already_resolved",
      } as const;
    }

    /*
     * At the safety deadline we stop waiting for nominated primary/backup
     * organisers.
     *
     * A dormant backup is removed rather than marked timed_out because it
     * may never have been activated or given its own response window.
     */
    const pendingNomineeIds = currentAssignments
      .filter(
        (assignment) =>
          assignment.status === "pending" &&
          (assignment.slot === "primary" || assignment.slot === "backup"),
      )
      .map((assignment) => assignment.id);

    if (pendingNomineeIds.length > 0) {
      await transaction
        .update(eventOrganiserAssignments)
        .set({
          status: "removed",

          isCurrent: false,

          endedAt: now,

          updatedAt: now,
        })
        .where(inArray(eventOrganiserAssignments.id, pendingNomineeIds));
    }

    /*
     * The event-level safety deadline supersedes any remaining nominated
     * organiser warning/timeout work.
     *
     * Do NOT cancel organiser_cover_request actions here. One may already
     * represent an earlier transition into general cover.
     */
    await transaction
      .update(scheduledActions)
      .set({
        status: "cancelled",

        lockedAt: null,

        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledActions.eventId, input.eventId),

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
          ),
        ),
      );

    /*
     * The ordinary escalation path may already have reached general cover,
     * particularly when the backup's normal timeout and this T-15 deadline
     * occur at the same time.
     *
     * Pending/processing/completed cover work therefore counts as an
     * existing cover request and prevents duplicate T-15 delivery.
     *
     * Failed/cancelled work does not count, allowing the safety deadline to
     * make a fresh delivery attempt.
     */
    const [existingCoverRequest] = await transaction
      .select({
        id: scheduledActions.id,
      })
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.eventId, input.eventId),

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

    const resultEvent: OrganiserSafetyEvent = {
      id: event.id,

      name: event.name,

      guildDatabaseId: eventIdentity.guildDatabaseId,

      discordGuildId: eventIdentity.discordGuildId,

      eventAdminChannelId: featureSettings.eventAdminChannelId,

      eventOrganiserRoleId: featureSettings.eventOrganiserRoleId,
    };

    if (existingCoverRequest) {
      return {
        kind: "cover_already_requested",

        event: resultEvent,

        retiredAssignmentIds: pendingNomineeIds,
      } as const;
    }

    return {
      kind: "cover_required",

      event: resultEvent,

      retiredAssignmentIds: pendingNomineeIds,
    } as const;
  });
}
