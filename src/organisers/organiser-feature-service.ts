import { and, eq, inArray, like, or } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  eventOrganiserAssignments,
  events,
  guildSettings,
  scheduledActions,
} from "../db/schema.js";
import {
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
} from "./organiser-scheduling.js";

export type SetGuildOrganisersEnabledResult =
  | {
      kind: "settings_not_found";
    }
  | {
      kind: "updated";

      enabled: boolean;

      previousValue: boolean;

      retiredAssignments: {
        id: number;
        eventId: number;
      }[];

      affectedEventIds: number[];
    };

/**
 * Enables or disables the organiser subsystem for one guild.
 *
 * Disabling organisers is an authoritative state transition:
 *
 * - current organiser assignments are retired but retained as history;
 * - pending/processing organiser scheduler work is cancelled;
 * - the guild-level child settings, such as organiser DM delivery, are left
 *   untouched so they can be reused if organisers are later re-enabled.
 *
 * The guild_settings row is locked so this transition can act as the ordering
 * boundary for organiser feature availability.
 */
export async function setGuildOrganisersEnabled(input: {
  guildDatabaseId: number;

  enabled: boolean;
}): Promise<SetGuildOrganisersEnabledResult> {
  return db.transaction(async (transaction) => {
    const [settings] = await transaction
      .select({
        organisersEnabled: guildSettings.organisersEnabled,
      })
      .from(guildSettings)
      .where(eq(guildSettings.guildId, input.guildDatabaseId))
      .limit(1)
      .for("update");

    if (!settings) {
      return {
        kind: "settings_not_found",
      };
    }

    const previousValue = settings.organisersEnabled;

    const now = new Date();

    if (input.enabled) {
      await transaction
        .update(guildSettings)
        .set({
          organisersEnabled: true,

          updatedAt: now,
        })
        .where(eq(guildSettings.guildId, input.guildDatabaseId));

      return {
        kind: "updated",

        enabled: true,

        previousValue,

        retiredAssignments: [],

        affectedEventIds: [],
      };
    }

    const guildEvents = await transaction
      .select({
        id: events.id,
      })
      .from(events)
      .where(eq(events.ownerGuildId, input.guildDatabaseId));

    const eventIds = guildEvents.map((event) => event.id);

    let retiredAssignments: {
      id: number;
      eventId: number;
    }[] = [];

    if (eventIds.length > 0) {
      /*
       * Preserve organiser history while removing all live ownership.
       *
       * "removed" is used rather than deleting rows because disabling the
       * subsystem is an administrative removal, not an erasure of history.
       */
      retiredAssignments = await transaction
        .update(eventOrganiserAssignments)
        .set({
          status: "removed",

          isCurrent: false,

          endedAt: now,

          updatedAt: now,
        })
        .where(
          and(
            inArray(eventOrganiserAssignments.eventId, eventIds),

            eq(eventOrganiserAssignments.isCurrent, true),
          ),
        )
        .returning({
          id: eventOrganiserAssignments.id,

          eventId: eventOrganiserAssignments.eventId,
        });

      /*
       * No organiser warning, timeout or cover-request work should continue
       * while the parent organiser feature is disabled.
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
            inArray(scheduledActions.eventId, eventIds),

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

              like(
                scheduledActions.actionKey,
                `${ORGANISER_COVER_REQUEST_ACTION_PREFIX}%`,
              ),
            ),
          ),
        );
    }

    await transaction
      .update(guildSettings)
      .set({
        organisersEnabled: false,

        updatedAt: now,
      })
      .where(eq(guildSettings.guildId, input.guildDatabaseId));

    const affectedEventIds = [
      ...new Set(retiredAssignments.map((assignment) => assignment.eventId)),
    ];

    return {
      kind: "updated",

      enabled: false,

      previousValue,

      retiredAssignments,

      affectedEventIds,
    };
  });
}
