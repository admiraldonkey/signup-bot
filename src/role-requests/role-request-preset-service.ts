import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";

import {
  eventRoleOptionQualificationRoles,
  eventRoleOptions,
  eventRoleRequestPresetApplications,
  events,
  eventTypes,
  guildSettings,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequestPresetGroupOptions,
  roleRequestPresetGroups,
  roleRequestPresetOptionQualificationRoles,
  roleRequestPresetOptions,
  roleRequestPresets,
  scheduledActions,
} from "../db/schema.js";

import {
  makeRoleRequestGroupCloseActionKey,
  makeRoleRequestGroupOpenActionKey,
} from "./role-request-scheduling.js";

export type InvalidRoleRequestPresetReason =
  | "no_active_options"
  | "no_active_groups"
  | "invalid_request_restriction"
  | "missing_qualification_roles"
  | "invalid_qualification_level"
  | "group_option_outside_preset"
  | "active_group_without_active_options"
  | "invalid_group_window";

export type ApplyRoleRequestPresetInput = {
  guildDatabaseId: number;

  eventId: number;

  presetId: number;

  appliedByUserId: string;
};

export type ApplyRoleRequestPresetResult =
  | {
      kind: "applied";

      eventId: number;

      presetId: number;

      eventRoleOptionIds: number[];

      roleRequestGroupIds: number[];
    }
  | {
      kind: "event_not_found";
    }
  | {
      kind: "event_terminal";

      status: "cancelled" | "completed";
    }
  | {
      kind: "role_requests_disabled";
    }
  | {
      kind: "preset_not_found";
    }
  | {
      kind: "preset_inactive";
    }
  | {
      kind: "already_applied";
    }
  | {
      kind: "missing_default_channel";

      presetGroupId: number;
    }
  | {
      kind: "signup_required";

      presetGroupId: number;
    }
  | {
      kind: "role_option_conflict";

      key: string;
    }
  | {
      kind: "invalid_preset";

      reason: InvalidRoleRequestPresetReason;

      presetOptionId?: number;

      presetGroupId?: number;
    };

type RequestRestriction = "open" | "qualified_only";

type QualificationLevel = "qualified" | "supervision_required";

class RoleOptionConflictError extends Error {
  public readonly key: string;

  public constructor(key: string) {
    super(`Event role-option key "${key}" already exists.`);

    this.name = "RoleOptionConflictError";

    this.key = key;
  }
}

/**
 * Copies one reusable role-request preset into an existing event.
 *
 * The preset is a source for a snapshot only. Once this transaction commits,
 * runtime role-request behaviour is driven entirely by the event-level rows
 * created here.
 *
 * Discord validation and posting remain outside this service.
 *
 * The durable scheduler actions required to realise the copied group
 * lifecycle are authoritative PostgreSQL state, so they are created inside
 * the same transaction as the event-level snapshot.
 */
export async function applyRoleRequestPresetToEvent(
  input: ApplyRoleRequestPresetInput,
): Promise<ApplyRoleRequestPresetResult> {
  try {
    return await db.transaction(
      async (transaction): Promise<ApplyRoleRequestPresetResult> => {
        /*
         * startsAt, signupsEnabled and lifecycle state all affect the
         * snapshot we are about to create.
         *
         * Lock the event so /event edit cannot change those authoritative
         * values halfway through application.
         */
        const [event] = await transaction
          .select({
            id: events.id,

            startsAt: events.startsAt,

            signupsEnabled: events.signupsEnabled,

            status: events.status,

            roleRequestsEnabled: eventTypes.roleRequestsEnabled,
          })
          .from(events)
          .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
          .where(
            and(
              eq(events.id, input.eventId),

              eq(events.ownerGuildId, input.guildDatabaseId),
            ),
          )
          .limit(1)
          .for("update");

        if (!event) {
          return {
            kind: "event_not_found",
          };
        }

        if (event.status === "cancelled" || event.status === "completed") {
          return {
            kind: "event_terminal",

            status: event.status,
          };
        }

        if (!event.roleRequestsEnabled) {
          return {
            kind: "role_requests_disabled",
          };
        }

        /*
         * Preset mutation services should take FOR UPDATE on this same
         * parent row.
         *
         * FOR SHARE therefore gives application a stable source snapshot
         * while allowing multiple readers where safe.
         */
        const [preset] = await transaction
          .select({
            id: roleRequestPresets.id,

            active: roleRequestPresets.active,
          })
          .from(roleRequestPresets)
          .where(
            and(
              eq(roleRequestPresets.id, input.presetId),

              eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),
            ),
          )
          .limit(1)
          .for("share");

        if (!preset) {
          return {
            kind: "preset_not_found",
          };
        }

        if (!preset.active) {
          return {
            kind: "preset_inactive",
          };
        }

        /*
         * If this preset has already been applied, report idempotently before
         * treating its already-created role-option keys as conflicts.
         */
        const [existingApplication] = await transaction
          .select({
            eventId: eventRoleRequestPresetApplications.eventId,
          })
          .from(eventRoleRequestPresetApplications)
          .where(
            and(
              eq(eventRoleRequestPresetApplications.eventId, event.id),

              eq(eventRoleRequestPresetApplications.presetId, preset.id),
            ),
          )
          .limit(1);

        if (existingApplication) {
          return {
            kind: "already_applied",
          };
        }

        const presetOptions = await transaction
          .select({
            id: roleRequestPresetOptions.id,

            key: roleRequestPresetOptions.key,

            displayName: roleRequestPresetOptions.displayName,

            description: roleRequestPresetOptions.description,

            requestRestriction: roleRequestPresetOptions.requestRestriction,

            capacity: roleRequestPresetOptions.capacity,

            sortOrder: roleRequestPresetOptions.sortOrder,

            active: roleRequestPresetOptions.active,
          })
          .from(roleRequestPresetOptions)
          .where(eq(roleRequestPresetOptions.presetId, preset.id))
          .orderBy(
            asc(roleRequestPresetOptions.sortOrder),

            asc(roleRequestPresetOptions.id),
          );

        const activePresetOptions = presetOptions.filter(
          (option) => option.active,
        );

        if (activePresetOptions.length === 0) {
          return {
            kind: "invalid_preset",

            reason: "no_active_options",
          };
        }

        for (const option of activePresetOptions) {
          if (!isRequestRestriction(option.requestRestriction)) {
            return {
              kind: "invalid_preset",

              reason: "invalid_request_restriction",

              presetOptionId: option.id,
            };
          }
        }

        const activePresetOptionIds = activePresetOptions.map(
          (option) => option.id,
        );

        const qualificationRows = await transaction
          .select({
            presetOptionId:
              roleRequestPresetOptionQualificationRoles.presetOptionId,

            discordRoleId:
              roleRequestPresetOptionQualificationRoles.discordRoleId,

            roleNameSnapshot:
              roleRequestPresetOptionQualificationRoles.roleNameSnapshot,

            qualificationLevel:
              roleRequestPresetOptionQualificationRoles.qualificationLevel,
          })
          .from(roleRequestPresetOptionQualificationRoles)
          .where(
            inArray(
              roleRequestPresetOptionQualificationRoles.presetOptionId,
              activePresetOptionIds,
            ),
          )
          .orderBy(
            asc(roleRequestPresetOptionQualificationRoles.presetOptionId),

            asc(roleRequestPresetOptionQualificationRoles.discordRoleId),
          );

        for (const qualification of qualificationRows) {
          if (!isQualificationLevel(qualification.qualificationLevel)) {
            return {
              kind: "invalid_preset",

              reason: "invalid_qualification_level",

              presetOptionId: qualification.presetOptionId,
            };
          }
        }

        const qualifiedOptionIds = new Set(
          qualificationRows.map(
            (qualification) => qualification.presetOptionId,
          ),
        );

        const missingQualification = activePresetOptions.find(
          (option) =>
            option.requestRestriction === "qualified_only" &&
            !qualifiedOptionIds.has(option.id),
        );

        if (missingQualification) {
          return {
            kind: "invalid_preset",

            reason: "missing_qualification_roles",

            presetOptionId: missingQualification.id,
          };
        }

        const presetGroups = await transaction
          .select({
            id: roleRequestPresetGroups.id,

            name: roleRequestPresetGroups.name,

            description: roleRequestPresetGroups.description,

            channelId: roleRequestPresetGroups.channelId,

            notifyRoleId: roleRequestPresetGroups.notifyRoleId,

            notifyRoleNameSnapshot:
              roleRequestPresetGroups.notifyRoleNameSnapshot,

            requiresPositiveSignup:
              roleRequestPresetGroups.requiresPositiveSignup,

            openMinutesBeforeStart:
              roleRequestPresetGroups.openMinutesBeforeStart,

            closeMinutesBeforeStart:
              roleRequestPresetGroups.closeMinutesBeforeStart,

            sortOrder: roleRequestPresetGroups.sortOrder,

            active: roleRequestPresetGroups.active,
          })
          .from(roleRequestPresetGroups)
          .where(eq(roleRequestPresetGroups.presetId, preset.id))
          .orderBy(
            asc(roleRequestPresetGroups.sortOrder),

            asc(roleRequestPresetGroups.id),
          );

        const activePresetGroups = presetGroups.filter((group) => group.active);

        if (activePresetGroups.length === 0) {
          return {
            kind: "invalid_preset",

            reason: "no_active_groups",
          };
        }

        const activePresetGroupIds = activePresetGroups.map(
          (group) => group.id,
        );

        const presetGroupMappings = await transaction
          .select({
            groupId: roleRequestPresetGroupOptions.groupId,

            presetOptionId: roleRequestPresetGroupOptions.presetOptionId,

            sortOrder: roleRequestPresetGroupOptions.sortOrder,
          })
          .from(roleRequestPresetGroupOptions)
          .where(
            inArray(
              roleRequestPresetGroupOptions.groupId,
              activePresetGroupIds,
            ),
          )
          .orderBy(
            asc(roleRequestPresetGroupOptions.groupId),

            asc(roleRequestPresetGroupOptions.sortOrder),

            asc(roleRequestPresetGroupOptions.presetOptionId),
          );

        const presetOptionById = new Map(
          presetOptions.map((option) => [option.id, option]),
        );

        for (const mapping of presetGroupMappings) {
          if (!presetOptionById.has(mapping.presetOptionId)) {
            return {
              kind: "invalid_preset",

              reason: "group_option_outside_preset",

              presetGroupId: mapping.groupId,

              presetOptionId: mapping.presetOptionId,
            };
          }
        }

        const activePresetOptionIdSet = new Set(activePresetOptionIds);

        /*
         * A mapping to an inactive option is intentionally omitted from new
         * occurrences. This lets an administrator retire one logical option
         * without having to rewrite every group's historical configuration.
         */
        const activeGroupMappings = presetGroupMappings.filter((mapping) =>
          activePresetOptionIdSet.has(mapping.presetOptionId),
        );

        for (const group of activePresetGroups) {
          if (
            !activeGroupMappings.some((mapping) => mapping.groupId === group.id)
          ) {
            return {
              kind: "invalid_preset",

              reason: "active_group_without_active_options",

              presetGroupId: group.id,
            };
          }

          if (group.requiresPositiveSignup && !event.signupsEnabled) {
            return {
              kind: "signup_required",

              presetGroupId: group.id,
            };
          }

          const opensAt = resolveStartRelativeTime(
            event.startsAt,

            group.openMinutesBeforeStart,
          );

          const closesAt = resolveStartRelativeTime(
            event.startsAt,

            group.closeMinutesBeforeStart,
          );

          if (opensAt.getTime() >= closesAt.getTime()) {
            return {
              kind: "invalid_preset",

              reason: "invalid_group_window",

              presetGroupId: group.id,
            };
          }
        }

        let defaultRoleRequestChannelId: string | null = null;

        if (activePresetGroups.some((group) => group.channelId === null)) {
          /*
           * Take a shared lock while resolving the server default so a
           * concurrent /setup configure update cannot change the value
           * halfway through this snapshot transaction.
           */
          const [settings] = await transaction
            .select({
              defaultRoleRequestChannelId:
                guildSettings.defaultRoleRequestChannelId,
            })
            .from(guildSettings)
            .where(eq(guildSettings.guildId, input.guildDatabaseId))
            .limit(1)
            .for("share");

          defaultRoleRequestChannelId =
            settings?.defaultRoleRequestChannelId ?? null;
        }

        const resolvedGroups = [];

        for (const group of activePresetGroups) {
          const channelId = group.channelId ?? defaultRoleRequestChannelId;

          if (channelId === null) {
            return {
              kind: "missing_default_channel",

              presetGroupId: group.id,
            };
          }

          resolvedGroups.push({
            ...group,

            channelId,

            opensAt: resolveStartRelativeTime(
              event.startsAt,

              group.openMinutesBeforeStart,
            ),

            closesAt: resolveStartRelativeTime(
              event.startsAt,

              group.closeMinutesBeforeStart,
            ),
          });
        }

        /*
         * Check for an ordinary existing key conflict before claiming the
         * application marker.
         *
         * The event row lock serialises this service against another
         * application to the same event. The INSERT below still uses
         * conflict handling as the final database-enforced race boundary
         * against other event-role-option writers.
         */
        const existingRoleOptions = await transaction
          .select({
            key: eventRoleOptions.key,
          })
          .from(eventRoleOptions)
          .where(
            and(
              eq(eventRoleOptions.eventId, event.id),

              inArray(
                eventRoleOptions.key,
                activePresetOptions.map((option) => option.key),
              ),
            ),
          )
          .orderBy(asc(eventRoleOptions.id));

        const existingRoleOption = existingRoleOptions[0];

        if (existingRoleOption) {
          return {
            kind: "role_option_conflict",

            key: existingRoleOption.key,
          };
        }

        /*
         * Claim the provenance/idempotency row before creating the snapshot.
         *
         * If anything later fails, the surrounding PostgreSQL transaction
         * rolls this row back together with every copied child row.
         */
        const [application] = await transaction
          .insert(eventRoleRequestPresetApplications)
          .values({
            eventId: event.id,

            presetId: preset.id,

            appliedByUserId: input.appliedByUserId,
          })
          .onConflictDoNothing({
            target: [
              eventRoleRequestPresetApplications.eventId,

              eventRoleRequestPresetApplications.presetId,
            ],
          })
          .returning({
            eventId: eventRoleRequestPresetApplications.eventId,
          });

        if (!application) {
          return {
            kind: "already_applied",
          };
        }

        const now = new Date();

        const insertedEventOptions = await transaction
          .insert(eventRoleOptions)
          .values(
            activePresetOptions.map((option) => ({
              eventId: event.id,

              sourceTemplateRoleOptionId: null,

              sourceRoleRequestPresetOptionId: option.id,

              key: option.key,

              displayName: option.displayName,

              description: option.description,

              requestRestriction: option.requestRestriction,

              capacity: option.capacity,

              sortOrder: option.sortOrder,

              active: true,

              updatedAt: now,
            })),
          )
          .onConflictDoNothing({
            target: [eventRoleOptions.eventId, eventRoleOptions.key],
          })
          .returning({
            id: eventRoleOptions.id,

            key: eventRoleOptions.key,

            sourcePresetOptionId:
              eventRoleOptions.sourceRoleRequestPresetOptionId,
          });

        if (insertedEventOptions.length !== activePresetOptions.length) {
          const insertedKeys = new Set(
            insertedEventOptions.map((option) => option.key),
          );

          const conflictedOption = activePresetOptions.find(
            (option) => !insertedKeys.has(option.key),
          );

          throw new RoleOptionConflictError(
            conflictedOption?.key ?? activePresetOptions[0]?.key ?? "unknown",
          );
        }

        const eventOptionIdByPresetOptionId = new Map<number, number>();

        for (const option of insertedEventOptions) {
          if (option.sourcePresetOptionId === null) {
            throw new Error(
              "A preset-derived event role option was returned without its source preset option ID.",
            );
          }

          eventOptionIdByPresetOptionId.set(
            option.sourcePresetOptionId,

            option.id,
          );
        }

        if (qualificationRows.length > 0) {
          await transaction.insert(eventRoleOptionQualificationRoles).values(
            qualificationRows.map((qualification) => ({
              eventRoleOptionId: requireMappedId(
                eventOptionIdByPresetOptionId,

                qualification.presetOptionId,

                "preset option",
              ),

              discordRoleId: qualification.discordRoleId,

              roleNameSnapshot: qualification.roleNameSnapshot,

              qualificationLevel: qualification.qualificationLevel,
            })),
          );
        }

        const insertedGroups = await transaction
          .insert(roleRequestGroups)
          .values(
            resolvedGroups.map((group) => ({
              eventId: event.id,

              sourceRoleRequestPresetGroupId: group.id,

              name: group.name,

              description: group.description,

              channelId: group.channelId,

              messageId: null,

              notifyRoleId: group.notifyRoleId,

              notifyRoleNameSnapshot: group.notifyRoleNameSnapshot,

              requiresPositiveSignup: group.requiresPositiveSignup,

              openMinutesBeforeStart: group.openMinutesBeforeStart,

              opensAt: group.opensAt,

              closeMinutesBeforeStart: group.closeMinutesBeforeStart,

              closesAt: group.closesAt,

              closedAt: null,

              createdByUserId: input.appliedByUserId,

              updatedAt: now,
            })),
          )
          .returning({
            id: roleRequestGroups.id,

            sourcePresetGroupId:
              roleRequestGroups.sourceRoleRequestPresetGroupId,
          });

        if (insertedGroups.length !== resolvedGroups.length) {
          throw new Error(
            "The database did not return every created role-request group.",
          );
        }

        const eventGroupIdByPresetGroupId = new Map<number, number>();

        for (const group of insertedGroups) {
          if (group.sourcePresetGroupId === null) {
            throw new Error(
              "A preset-derived role-request group was returned without its source preset group ID.",
            );
          }

          eventGroupIdByPresetGroupId.set(
            group.sourcePresetGroupId,

            group.id,
          );
        }

        if (activeGroupMappings.length > 0) {
          await transaction.insert(roleRequestGroupOptions).values(
            activeGroupMappings.map((mapping) => ({
              groupId: requireMappedId(
                eventGroupIdByPresetGroupId,

                mapping.groupId,

                "preset group",
              ),

              eventRoleOptionId: requireMappedId(
                eventOptionIdByPresetOptionId,

                mapping.presetOptionId,

                "preset option",
              ),

              sortOrder: mapping.sortOrder,
            })),
          );
        }

        /*
         * Planned preset-derived groups need durable opening and closing
         * work from the moment they become authoritative event state.
         *
         * Creating these actions inside this transaction prevents a process
         * interruption from committing groups without the scheduler work
         * needed to realise their lifecycle.
         *
         * Store the actual resolved timestamps, not the preset offsets.
         * From this point onwards the event-level snapshot is authoritative.
         */
        await transaction.insert(scheduledActions).values(
          resolvedGroups.flatMap((group) => {
            const eventGroupId = requireMappedId(
              eventGroupIdByPresetGroupId,

              group.id,

              "preset group",
            );

            return [
              {
                eventId: event.id,

                actionKey: makeRoleRequestGroupOpenActionKey(eventGroupId),

                dueAt: group.opensAt,
              },

              {
                eventId: event.id,

                actionKey: makeRoleRequestGroupCloseActionKey(eventGroupId),

                dueAt: group.closesAt,
              },
            ];
          }),
        );

        return {
          kind: "applied",

          eventId: event.id,

          presetId: preset.id,

          eventRoleOptionIds: activePresetOptions.map((option) =>
            requireMappedId(
              eventOptionIdByPresetOptionId,

              option.id,

              "preset option",
            ),
          ),

          roleRequestGroupIds: activePresetGroups.map((group) =>
            requireMappedId(
              eventGroupIdByPresetGroupId,

              group.id,

              "preset group",
            ),
          ),
        };
      },
    );
  } catch (error) {
    /*
     * A normal pre-existing key conflict is detected before mutation.
     *
     * This exception covers the narrower race where another writer inserts
     * the same event-role key after that check but before our INSERT.
     * Throwing from the transaction ensures the application marker and any
     * partially inserted options are rolled back before this domain result
     * is returned.
     */
    if (error instanceof RoleOptionConflictError) {
      return {
        kind: "role_option_conflict",

        key: error.key,
      };
    }

    throw error;
  }
}

function isRequestRestriction(value: string): value is RequestRestriction {
  return value === "open" || value === "qualified_only";
}

function isQualificationLevel(value: string): value is QualificationLevel {
  return value === "qualified" || value === "supervision_required";
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

function requireMappedId(
  idsBySourceId: Map<number, number>,

  sourceId: number,

  sourceDescription: string,
): number {
  const mappedId = idsBySourceId.get(sourceId);

  if (mappedId === undefined) {
    throw new Error(
      `Could not resolve the event-level ID for ${sourceDescription} #${sourceId}.`,
    );
  }

  return mappedId;
}
