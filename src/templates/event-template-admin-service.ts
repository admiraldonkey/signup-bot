import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventAudiences,
  eventTemplateOrganiserDefaults,
  eventTemplatePingRoles,
  eventTemplateReminders,
  eventTemplates,
  eventTypes,
  roleRequestPresets,
} from "../db/schema.js";
import type { ReminderTimingReference } from "../reminders/reminder-scheduling.js";
import { isValidEventTimezone } from "../time/timezones.js";

export type EventTemplatePublicationMode = "manual" | "scheduled" | "immediate";

export type EventTemplateRecord = {
  id: number;

  ownerGuildId: number;

  eventTypeId: number;

  audienceId: number | null;

  roleRequestPresetId: number | null;

  name: string;

  description: string | null;

  timezone: string;

  localStartTime: string | null;

  durationMinutes: number;

  signupsEnabled: boolean;

  attendanceCloseMinutesBefore: number;

  showDetailedDeadline: boolean;

  publicationMode: string;

  publishMinutesBeforeStart: number | null;

  publicationChannelId: string | null;

  active: boolean;

  createdByUserId: string;

  createdAt: Date;

  updatedAt: Date;
};

export type EventTemplateSummary = {
  id: number;

  name: string;

  eventTypeId: number;

  audienceId: number | null;

  roleRequestPresetId: number | null;

  timezone: string;

  localStartTime: string | null;

  active: boolean;

  updatedAt: Date;
};

export type EventTemplatePingRole = {
  discordRoleId: string;

  roleNameSnapshot: string;

  sortOrder: number;
};

export type EventTemplateOrganiserSlot = "primary" | "backup";

export type EventTemplateOrganiserDefault = {
  slot: EventTemplateOrganiserSlot;

  discordUserId: string;

  displayNameSnapshot: string;
};

export type EventTemplateReminderDefinition = {
  id: number;

  timingReference: ReminderTimingReference;

  minutesBefore: number;

  message: string;

  channelId: string | null;

  pingEventRoles: boolean;
};

export type EventTemplateReminderInput = {
  timingReference: string;

  minutesBefore: number;

  message: string;

  /*
   * null means inherit the generated event's resolved publication
   * destination when an occurrence is generated.
   */
  channelId: string | null;

  pingEventRoles: boolean;
};

export type EventTemplateReminderInvalidReason =
  | "invalid_timing_reference"
  | "invalid_minutes_before"
  | "invalid_message"
  | "invalid_channel_id"
  | "signup_close_requires_signups";

export type EventTemplateDetail = EventTemplateRecord & {
  pingRoles: EventTemplatePingRole[];

  organiserDefaults: EventTemplateOrganiserDefault[];

  reminders: EventTemplateReminderDefinition[];
};

export type CreateEventTemplateInput = {
  guildDatabaseId: number;

  eventTypeId: number;

  audienceId: number | null;

  roleRequestPresetId: number | null;

  name: string;

  description: string | null;

  timezone: string;

  localStartTime: string | null;

  durationMinutes: number;

  signupsEnabled: boolean;

  attendanceCloseMinutesBefore: number;

  showDetailedDeadline: boolean;

  publicationMode: string;

  publishMinutesBeforeStart: number | null;

  publicationChannelId: string | null;

  createdByUserId: string;
};

export type EventTemplateConfigurationInvalidReason =
  | "invalid_name"
  | "invalid_timezone"
  | "invalid_local_start_time"
  | "invalid_duration"
  | "invalid_attendance_close_offset"
  | "invalid_publication_mode"
  | "invalid_publication_offset"
  | "publication_not_before_signup_close"
  | "invalid_publication_channel";

export type CreateEventTemplateResult =
  | {
      kind: "created";

      template: EventTemplateRecord;
    }
  | {
      kind: "guild_not_found";
    }
  | {
      kind: "event_type_unavailable";
    }
  | {
      kind: "audience_unavailable";
    }
  | {
      kind: "preset_unavailable";
    }
  | {
      kind: "invalid_input";

      reason:
        | EventTemplateConfigurationInvalidReason
        | "preset_requires_role_requests";
    };

export type EditEventTemplateInput = {
  guildDatabaseId: number;

  templateId: number;

  eventTypeId?: number;

  /*
   * undefined -> preserve
   * null      -> clear
   */
  audienceId?: number | null;

  /*
   * undefined -> preserve
   * null      -> clear
   */
  roleRequestPresetId?: number | null;

  name?: string;

  /*
   * undefined -> preserve
   * null or blank -> clear
   */
  description?: string | null;

  timezone?: string;

  /*
   * undefined -> preserve
   * null      -> clear
   */
  localStartTime?: string | null;

  durationMinutes?: number;

  signupsEnabled?: boolean;

  attendanceCloseMinutesBefore?: number;

  showDetailedDeadline?: boolean;

  publicationMode?: string;

  /*
   * undefined -> preserve
   * null      -> clear
   */
  publishMinutesBeforeStart?: number | null;

  /*
   * undefined -> preserve
   * null      -> clear
   */
  publicationChannelId?: string | null;
};

export type EditEventTemplateResult =
  | {
      kind: "updated" | "unchanged";

      template: EventTemplateRecord;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "event_type_unavailable";
    }
  | {
      kind: "audience_unavailable";
    }
  | {
      kind: "preset_unavailable";
    }
  | {
      kind: "invalid_input";

      reason:
        | EventTemplateConfigurationInvalidReason
        | "preset_requires_role_requests"
        | "signup_close_requires_signups"
        | "no_changes_requested";
    };

export type ReplaceEventTemplatePingRolesInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * Complete intended collection.
   *
   * Array order becomes the authoritative reusable role order.
   * An empty array explicitly clears all template ping roles.
   */
  pingRoles: {
    discordRoleId: string;

    roleNameSnapshot: string;
  }[];
};

export type ReplaceEventTemplatePingRolesResult =
  | {
      kind: "updated" | "unchanged";

      pingRoles: EventTemplatePingRole[];
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "invalid_input";

      reason:
        | "invalid_discord_role_id"
        | "invalid_role_name"
        | "duplicate_discord_role";
    };

export type ReplaceEventTemplateOrganiserDefaultsInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * Complete intended collection.
   *
   * Valid canonical states are:
   * - []
   * - [primary]
   * - [primary, backup]
   *
   * Input order is not significant.
   */
  organiserDefaults: {
    slot: string;

    discordUserId: string;

    displayNameSnapshot: string;
  }[];
};

export type ReplaceEventTemplateOrganiserDefaultsResult =
  | {
      kind: "updated" | "unchanged";

      organiserDefaults: EventTemplateOrganiserDefault[];
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "invalid_input";

      reason:
        | "invalid_slot"
        | "invalid_discord_user_id"
        | "invalid_display_name"
        | "duplicate_slot"
        | "duplicate_discord_user"
        | "backup_requires_primary";
    };

export type ReplaceEventTemplateRemindersInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * Complete intended reminder collection.
   *
   * Input order is not semantically significant.
   * An empty array explicitly clears all reusable reminder definitions.
   */
  reminders: EventTemplateReminderInput[];
};

export type ReplaceEventTemplateRemindersResult =
  | {
      kind: "updated" | "unchanged";

      reminders: EventTemplateReminderDefinition[];
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "invalid_input";

      reason: EventTemplateReminderInvalidReason;
    };

export type GetEventTemplateInput = {
  guildDatabaseId: number;

  templateId: number;
};

export type GetEventTemplateResult =
  | {
      kind: "found";

      template: EventTemplateDetail;
    }
  | {
      kind: "template_not_found";
    };

export type SetEventTemplateActiveInput = {
  guildDatabaseId: number;

  templateId: number;

  active: boolean;
};

export type SetEventTemplateActiveResult =
  | {
      kind: "updated" | "unchanged";

      template: {
        id: number;

        name: string;

        active: boolean;
      };
    }
  | {
      kind: "template_not_found";
    };

const eventTemplateSelection = {
  id: eventTemplates.id,

  ownerGuildId: eventTemplates.ownerGuildId,

  eventTypeId: eventTemplates.eventTypeId,

  audienceId: eventTemplates.audienceId,

  roleRequestPresetId: eventTemplates.roleRequestPresetId,

  name: eventTemplates.name,

  description: eventTemplates.description,

  timezone: eventTemplates.timezone,

  localStartTime: eventTemplates.localStartTime,

  durationMinutes: eventTemplates.durationMinutes,

  signupsEnabled: eventTemplates.signupsEnabled,

  attendanceCloseMinutesBefore: eventTemplates.attendanceCloseMinutesBefore,

  showDetailedDeadline: eventTemplates.showDetailedDeadline,

  publicationMode: eventTemplates.publicationMode,

  publishMinutesBeforeStart: eventTemplates.publishMinutesBeforeStart,

  publicationChannelId: eventTemplates.publicationChannelId,

  active: eventTemplates.active,

  createdByUserId: eventTemplates.createdByUserId,

  createdAt: eventTemplates.createdAt,

  updatedAt: eventTemplates.updatedAt,
};

/**
 * Creates one reusable template parent.
 *
 * Child collections remain separate authoritative mutations so parent
 * creation does not couple core template configuration to collection-editing
 * workflows.
 */
export async function createEventTemplate(
  input: CreateEventTemplateInput,
): Promise<CreateEventTemplateResult> {
  const configurationResult = normaliseEventTemplateConfiguration({
    name: input.name,

    description: input.description,

    timezone: input.timezone,

    localStartTime: input.localStartTime,

    durationMinutes: input.durationMinutes,

    signupsEnabled: input.signupsEnabled,

    attendanceCloseMinutesBefore: input.attendanceCloseMinutesBefore,

    showDetailedDeadline: input.showDetailedDeadline,

    publicationMode: input.publicationMode,

    publishMinutesBeforeStart: input.publishMinutesBeforeStart,

    publicationChannelId: input.publicationChannelId,
  });

  if (!configurationResult.ok) {
    return {
      kind: "invalid_input",

      reason: configurationResult.reason,
    };
  }

  const configuration = configurationResult.configuration;

  return db.transaction(async (transaction) => {
    /*
     * Return a domain result for an unknown guild rather than relying on a
     * later foreign-key failure.
     */
    const [guild] = await transaction
      .select({
        id: discordGuilds.id,
      })
      .from(discordGuilds)
      .where(eq(discordGuilds.id, input.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!guild) {
      return {
        kind: "guild_not_found",
      } as const;
    }

    /*
     * Source references are guild-owned reusable state.
     *
     * Keep them stable until the template insert commits and reject
     * cross-guild or inactive source records explicitly.
     */
    const [eventType] = await transaction
      .select({
        id: eventTypes.id,

        roleRequestsEnabled: eventTypes.roleRequestsEnabled,
      })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.id, input.eventTypeId),

          eq(eventTypes.ownerGuildId, input.guildDatabaseId),

          eq(eventTypes.active, true),
        ),
      )
      .limit(1)
      .for("share");

    if (!eventType) {
      return {
        kind: "event_type_unavailable",
      } as const;
    }

    if (input.audienceId !== null) {
      const [audience] = await transaction
        .select({
          id: eventAudiences.id,
        })
        .from(eventAudiences)
        .where(
          and(
            eq(eventAudiences.id, input.audienceId),

            eq(eventAudiences.ownerGuildId, input.guildDatabaseId),

            eq(eventAudiences.active, true),
          ),
        )
        .limit(1)
        .for("share");

      if (!audience) {
        return {
          kind: "audience_unavailable",
        } as const;
      }
    }

    if (input.roleRequestPresetId !== null) {
      const [preset] = await transaction
        .select({
          id: roleRequestPresets.id,
        })
        .from(roleRequestPresets)
        .where(
          and(
            eq(roleRequestPresets.id, input.roleRequestPresetId),

            eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),

            eq(roleRequestPresets.active, true),
          ),
        )
        .limit(1)
        .for("share");

      if (!preset) {
        return {
          kind: "preset_unavailable",
        } as const;
      }

      if (!eventType.roleRequestsEnabled) {
        return {
          kind: "invalid_input",

          reason: "preset_requires_role_requests",
        } as const;
      }
    }

    const [template] = await transaction
      .insert(eventTemplates)
      .values({
        ownerGuildId: input.guildDatabaseId,

        eventTypeId: input.eventTypeId,

        audienceId: input.audienceId,

        roleRequestPresetId: input.roleRequestPresetId,

        name: configuration.name,

        description: configuration.description,

        timezone: configuration.timezone,

        localStartTime: configuration.localStartTime,

        durationMinutes: configuration.durationMinutes,

        signupsEnabled: configuration.signupsEnabled,

        attendanceCloseMinutesBefore:
          configuration.attendanceCloseMinutesBefore,

        showDetailedDeadline: configuration.showDetailedDeadline,

        publicationMode: configuration.publicationMode,

        publishMinutesBeforeStart: configuration.publishMinutesBeforeStart,

        publicationChannelId: configuration.publicationChannelId,

        active: true,

        createdByUserId: input.createdByUserId,
      })
      .returning(eventTemplateSelection);

    if (!template) {
      throw new Error("The event template could not be created.");
    }

    return {
      kind: "created",

      template,
    } as const;
  });
}

/**
 * Edits the reusable parent configuration for one template.
 *
 * Omitted fields preserve their current values. Nullable fields use explicit
 * null to clear the stored value.
 *
 * Generation takes FOR SHARE on this parent. Editing takes FOR UPDATE so one
 * generation observes either the complete configuration before this mutation
 * or the complete configuration after it.
 *
 * Child collections are deliberately not changed here.
 */
export async function editEventTemplate(
  input: EditEventTemplateInput,
): Promise<EditEventTemplateResult> {
  if (
    input.eventTypeId === undefined &&
    input.audienceId === undefined &&
    input.roleRequestPresetId === undefined &&
    input.name === undefined &&
    input.description === undefined &&
    input.timezone === undefined &&
    input.localStartTime === undefined &&
    input.durationMinutes === undefined &&
    input.signupsEnabled === undefined &&
    input.attendanceCloseMinutesBefore === undefined &&
    input.showDetailedDeadline === undefined &&
    input.publicationMode === undefined &&
    input.publishMinutesBeforeStart === undefined &&
    input.publicationChannelId === undefined
  ) {
    return {
      kind: "invalid_input",

      reason: "no_changes_requested",
    };
  }

  return db.transaction(async (transaction) => {
    /*
     * This is both the authoritative ownership check and the
     * mutation/generation concurrency boundary.
     *
     * Inactive templates deliberately remain editable.
     */
    const [template] = await transaction
      .select(eventTemplateSelection)
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const eventTypeId = input.eventTypeId ?? template.eventTypeId;

    const audienceId =
      input.audienceId === undefined ? template.audienceId : input.audienceId;

    const roleRequestPresetId =
      input.roleRequestPresetId === undefined
        ? template.roleRequestPresetId
        : input.roleRequestPresetId;

    const configurationResult = normaliseEventTemplateConfiguration({
      name: input.name ?? template.name,

      description:
        input.description === undefined
          ? template.description
          : input.description,

      timezone: input.timezone ?? template.timezone,

      localStartTime:
        input.localStartTime === undefined
          ? template.localStartTime
          : input.localStartTime,

      durationMinutes: input.durationMinutes ?? template.durationMinutes,

      signupsEnabled: input.signupsEnabled ?? template.signupsEnabled,

      attendanceCloseMinutesBefore:
        input.attendanceCloseMinutesBefore ??
        template.attendanceCloseMinutesBefore,

      showDetailedDeadline:
        input.showDetailedDeadline ?? template.showDetailedDeadline,

      publicationMode: input.publicationMode ?? template.publicationMode,

      publishMinutesBeforeStart:
        input.publishMinutesBeforeStart === undefined
          ? template.publishMinutesBeforeStart
          : input.publishMinutesBeforeStart,

      publicationChannelId:
        input.publicationChannelId === undefined
          ? template.publicationChannelId
          : input.publicationChannelId,
    });

    if (!configurationResult.ok) {
      return {
        kind: "invalid_input",

        reason: configurationResult.reason,
      } as const;
    }

    const configuration = configurationResult.configuration;

    /*
     * A signup-close reminder requires a signup-close reference point.
     *
     * Do not allow a core edit to disable signups while such reusable reminder
     * definitions still exist. The administrator can clear or replace those
     * reminders first, then disable signups in a subsequent edit.
     *
     * The template parent is already FOR UPDATE, so a correctly implemented
     * reminder replacement cannot interleave with this check.
     */
    if (input.signupsEnabled !== undefined && !configuration.signupsEnabled) {
      const [signupCloseReminder] = await transaction
        .select({
          id: eventTemplateReminders.id,
        })
        .from(eventTemplateReminders)
        .where(
          and(
            eq(eventTemplateReminders.templateId, template.id),

            eq(eventTemplateReminders.timingReference, "signup_close"),
          ),
        )
        .limit(1);

      if (signupCloseReminder) {
        return {
          kind: "invalid_input",

          reason: "signup_close_requires_signups",
        } as const;
      }
    }

    /*
     * Only newly-requested reusable relationships require their active-state
     * validation here.
     *
     * An unrelated edit remains possible when an existing referenced source
     * was later deactivated, which lets administrators repair stale templates
     * incrementally instead of trapping them behind that stale reference.
     */
    let eventTypeRoleRequestsEnabled: boolean | undefined;

    const needsEventTypeRelationshipCheck =
      input.eventTypeId !== undefined ||
      (input.roleRequestPresetId !== undefined && roleRequestPresetId !== null);

    if (needsEventTypeRelationshipCheck) {
      const eventTypeCondition =
        input.eventTypeId === undefined
          ? and(
              eq(eventTypes.id, eventTypeId),

              eq(eventTypes.ownerGuildId, input.guildDatabaseId),
            )
          : and(
              eq(eventTypes.id, eventTypeId),

              eq(eventTypes.ownerGuildId, input.guildDatabaseId),

              eq(eventTypes.active, true),
            );

      const [eventType] = await transaction
        .select({
          id: eventTypes.id,

          roleRequestsEnabled: eventTypes.roleRequestsEnabled,
        })
        .from(eventTypes)
        .where(eventTypeCondition)
        .limit(1)
        .for("share");

      if (!eventType) {
        return {
          kind: "event_type_unavailable",
        } as const;
      }

      eventTypeRoleRequestsEnabled = eventType.roleRequestsEnabled;
    }

    if (input.audienceId !== undefined && audienceId !== null) {
      const [audience] = await transaction
        .select({
          id: eventAudiences.id,
        })
        .from(eventAudiences)
        .where(
          and(
            eq(eventAudiences.id, audienceId),

            eq(eventAudiences.ownerGuildId, input.guildDatabaseId),

            eq(eventAudiences.active, true),
          ),
        )
        .limit(1)
        .for("share");

      if (!audience) {
        return {
          kind: "audience_unavailable",
        } as const;
      }
    }

    if (
      input.roleRequestPresetId !== undefined &&
      roleRequestPresetId !== null
    ) {
      const [preset] = await transaction
        .select({
          id: roleRequestPresets.id,
        })
        .from(roleRequestPresets)
        .where(
          and(
            eq(roleRequestPresets.id, roleRequestPresetId),

            eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),

            eq(roleRequestPresets.active, true),
          ),
        )
        .limit(1)
        .for("share");

      if (!preset) {
        return {
          kind: "preset_unavailable",
        } as const;
      }
    }

    if (
      (input.eventTypeId !== undefined ||
        input.roleRequestPresetId !== undefined) &&
      roleRequestPresetId !== null &&
      eventTypeRoleRequestsEnabled === false
    ) {
      return {
        kind: "invalid_input",

        reason: "preset_requires_role_requests",
      } as const;
    }

    if (
      eventTemplateConfigurationMatches(
        template,
        configuration,
        eventTypeId,
        audienceId,
        roleRequestPresetId,
      )
    ) {
      return {
        kind: "unchanged",

        template,
      } as const;
    }

    const [updatedTemplate] = await transaction
      .update(eventTemplates)
      .set({
        eventTypeId,

        audienceId,

        roleRequestPresetId,

        name: configuration.name,

        description: configuration.description,

        timezone: configuration.timezone,

        localStartTime: configuration.localStartTime,

        durationMinutes: configuration.durationMinutes,

        signupsEnabled: configuration.signupsEnabled,

        attendanceCloseMinutesBefore:
          configuration.attendanceCloseMinutesBefore,

        showDetailedDeadline: configuration.showDetailedDeadline,

        publicationMode: configuration.publicationMode,

        publishMinutesBeforeStart: configuration.publishMinutesBeforeStart,

        publicationChannelId: configuration.publicationChannelId,

        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventTemplates.id, template.id),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .returning(eventTemplateSelection);

    if (!updatedTemplate) {
      throw new Error(
        `Event template #${template.id} disappeared while its configuration was being edited.`,
      );
    }

    return {
      kind: "updated",

      template: updatedTemplate,
    } as const;
  });
}

/**
 * Replaces the complete reusable ping-role collection for one template.
 *
 * Array order is authoritative and is persisted as contiguous sortOrder
 * values beginning at zero.
 *
 * Generation takes FOR SHARE on the template parent. This mutation takes
 * FOR UPDATE before reading or replacing child rows so generation observes
 * either the complete old collection or the complete new collection.
 *
 * Existing generated events are independent and are never rewritten here.
 */
export async function replaceEventTemplatePingRoles(
  input: ReplaceEventTemplatePingRolesInput,
): Promise<ReplaceEventTemplatePingRolesResult> {
  const normalisedRoles: EventTemplatePingRole[] = [];

  const seenRoleIds = new Set<string>();

  for (const [index, role] of input.pingRoles.entries()) {
    const discordRoleId = role.discordRoleId.trim();

    if (discordRoleId.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_discord_role_id",
      };
    }

    if (seenRoleIds.has(discordRoleId)) {
      return {
        kind: "invalid_input",

        reason: "duplicate_discord_role",
      };
    }

    seenRoleIds.add(discordRoleId);

    const roleNameSnapshot = role.roleNameSnapshot.trim();

    if (roleNameSnapshot.length === 0 || roleNameSnapshot.length > 100) {
      return {
        kind: "invalid_input",

        reason: "invalid_role_name",
      };
    }

    normalisedRoles.push({
      discordRoleId,

      roleNameSnapshot,

      sortOrder: index,
    });
  }

  return db.transaction(async (transaction) => {
    /*
     * Lock the reusable aggregate parent before touching child state.
     *
     * This is the same mutation/generation concurrency boundary used by core
     * edits and lifecycle changes.
     */
    const [template] = await transaction
      .select({
        id: eventTemplates.id,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const existingRoles = await transaction
      .select({
        discordRoleId: eventTemplatePingRoles.discordRoleId,

        roleNameSnapshot: eventTemplatePingRoles.roleNameSnapshot,

        sortOrder: eventTemplatePingRoles.sortOrder,
      })
      .from(eventTemplatePingRoles)
      .where(eq(eventTemplatePingRoles.templateId, template.id))
      .orderBy(
        asc(eventTemplatePingRoles.sortOrder),

        asc(eventTemplatePingRoles.discordRoleId),
      );

    if (eventTemplatePingRolesMatch(existingRoles, normalisedRoles)) {
      return {
        kind: "unchanged",

        pingRoles: existingRoles,
      } as const;
    }

    await transaction
      .delete(eventTemplatePingRoles)
      .where(eq(eventTemplatePingRoles.templateId, template.id));

    if (normalisedRoles.length > 0) {
      await transaction.insert(eventTemplatePingRoles).values(
        normalisedRoles.map((role) => ({
          templateId: template.id,

          discordRoleId: role.discordRoleId,

          roleNameSnapshot: role.roleNameSnapshot,

          sortOrder: role.sortOrder,
        })),
      );
    }

    /*
     * Child collection changes are meaningful template mutations too.
     * Keep the parent timestamp useful for administration/list views.
     */
    await transaction
      .update(eventTemplates)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(eventTemplates.id, template.id));

    return {
      kind: "updated",

      pingRoles: normalisedRoles,
    } as const;
  });
}

/**
 * Replaces the complete reusable organiser-default collection for one
 * template.
 *
 * Input order is not significant. Returned and persisted source state is
 * canonicalised to primary followed by backup.
 *
 * Generation takes FOR SHARE on the template parent. This mutation takes
 * FOR UPDATE before reading or replacing child rows so generation observes
 * either the complete old organiser source state or the complete new state.
 *
 * Existing generated events are independent and are never rewritten here.
 */
export async function replaceEventTemplateOrganiserDefaults(
  input: ReplaceEventTemplateOrganiserDefaultsInput,
): Promise<ReplaceEventTemplateOrganiserDefaultsResult> {
  const normalisedDefaults: EventTemplateOrganiserDefault[] = [];

  const seenSlots = new Set<EventTemplateOrganiserSlot>();

  const seenUserIds = new Set<string>();

  for (const organiser of input.organiserDefaults) {
    const slot = organiser.slot.trim();

    if (!isEventTemplateOrganiserSlot(slot)) {
      return {
        kind: "invalid_input",

        reason: "invalid_slot",
      };
    }

    if (seenSlots.has(slot)) {
      return {
        kind: "invalid_input",

        reason: "duplicate_slot",
      };
    }

    seenSlots.add(slot);

    const discordUserId = organiser.discordUserId.trim();

    if (discordUserId.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_discord_user_id",
      };
    }

    if (seenUserIds.has(discordUserId)) {
      return {
        kind: "invalid_input",

        reason: "duplicate_discord_user",
      };
    }

    seenUserIds.add(discordUserId);

    const displayNameSnapshot = organiser.displayNameSnapshot.trim();

    if (displayNameSnapshot.length === 0 || displayNameSnapshot.length > 100) {
      return {
        kind: "invalid_input",

        reason: "invalid_display_name",
      };
    }

    normalisedDefaults.push({
      slot,

      discordUserId,

      displayNameSnapshot,
    });
  }

  const hasPrimary = normalisedDefaults.some(
    (organiser) => organiser.slot === "primary",
  );

  const hasBackup = normalisedDefaults.some(
    (organiser) => organiser.slot === "backup",
  );

  if (hasBackup && !hasPrimary) {
    return {
      kind: "invalid_input",

      reason: "backup_requires_primary",
    };
  }

  normalisedDefaults.sort(
    (left, right) =>
      organiserSlotOrder(left.slot) - organiserSlotOrder(right.slot),
  );

  return db.transaction(async (transaction) => {
    /*
     * Lock the reusable aggregate parent before touching child state.
     *
     * This is the same mutation/generation concurrency boundary used by
     * core edits, lifecycle changes and ping-role replacement.
     */
    const [template] = await transaction
      .select({
        id: eventTemplates.id,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const existingRows = await transaction
      .select({
        slot: eventTemplateOrganiserDefaults.slot,

        discordUserId: eventTemplateOrganiserDefaults.discordUserId,

        displayNameSnapshot: eventTemplateOrganiserDefaults.displayNameSnapshot,
      })
      .from(eventTemplateOrganiserDefaults)
      .where(eq(eventTemplateOrganiserDefaults.templateId, template.id));

    const existingDefaults: EventTemplateOrganiserDefault[] = existingRows.map(
      (organiser) => ({
        slot: requireEventTemplateOrganiserSlot(organiser.slot),

        discordUserId: organiser.discordUserId,

        displayNameSnapshot: organiser.displayNameSnapshot,
      }),
    );

    existingDefaults.sort(
      (left, right) =>
        organiserSlotOrder(left.slot) - organiserSlotOrder(right.slot) ||
        left.discordUserId.localeCompare(right.discordUserId),
    );

    if (
      eventTemplateOrganiserDefaultsMatch(existingDefaults, normalisedDefaults)
    ) {
      return {
        kind: "unchanged",

        organiserDefaults: existingDefaults,
      } as const;
    }

    await transaction
      .delete(eventTemplateOrganiserDefaults)
      .where(eq(eventTemplateOrganiserDefaults.templateId, template.id));

    if (normalisedDefaults.length > 0) {
      await transaction.insert(eventTemplateOrganiserDefaults).values(
        normalisedDefaults.map((organiser) => ({
          templateId: template.id,

          slot: organiser.slot,

          discordUserId: organiser.discordUserId,

          displayNameSnapshot: organiser.displayNameSnapshot,
        })),
      );
    }

    /*
     * Child collection changes are meaningful template mutations too.
     */
    await transaction
      .update(eventTemplates)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(eventTemplates.id, template.id));

    return {
      kind: "updated",

      organiserDefaults: normalisedDefaults,
    } as const;
  });
}

/**
 * Replaces the complete reusable reminder-definition collection for one
 * template.
 *
 * Input order is not semantically significant. Definitions are canonicalised
 * before comparison and persistence so logically identical replacement
 * requests are idempotent.
 *
 * Generation takes FOR SHARE on the template parent. This mutation takes
 * FOR UPDATE before reading or replacing child rows so generation observes
 * either the complete old reminder source state or the complete new state.
 *
 * Existing generated event reminders are independent and are never rewritten
 * here.
 */
export async function replaceEventTemplateReminders(
  input: ReplaceEventTemplateRemindersInput,
): Promise<ReplaceEventTemplateRemindersResult> {
  const normalisedReminders: NormalisedEventTemplateReminder[] = [];

  for (const reminder of input.reminders) {
    const timingReference = reminder.timingReference.trim();

    if (!isEventTemplateReminderTimingReference(timingReference)) {
      return {
        kind: "invalid_input",

        reason: "invalid_timing_reference",
      };
    }

    if (!isPostgresNonNegativeInteger(reminder.minutesBefore)) {
      return {
        kind: "invalid_input",

        reason: "invalid_minutes_before",
      };
    }

    const message = reminder.message.trim();

    if (message.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_message",
      };
    }

    let channelId: string | null = null;

    if (reminder.channelId !== null) {
      channelId = reminder.channelId.trim();

      if (channelId.length === 0) {
        return {
          kind: "invalid_input",

          reason: "invalid_channel_id",
        };
      }
    }

    normalisedReminders.push({
      timingReference,

      minutesBefore: reminder.minutesBefore,

      message,

      channelId,

      pingEventRoles: reminder.pingEventRoles,
    });
  }

  normalisedReminders.sort(compareEventTemplateReminders);

  return db.transaction(async (transaction) => {
    /*
     * Lock the reusable aggregate parent before validating compatibility or
     * changing child reminder definitions.
     */
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        signupsEnabled: eventTemplates.signupsEnabled,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    if (
      !template.signupsEnabled &&
      normalisedReminders.some(
        (reminder) => reminder.timingReference === "signup_close",
      )
    ) {
      return {
        kind: "invalid_input",

        reason: "signup_close_requires_signups",
      } as const;
    }

    const existingRows = await transaction
      .select({
        id: eventTemplateReminders.id,

        timingReference: eventTemplateReminders.timingReference,

        minutesBefore: eventTemplateReminders.minutesBefore,

        message: eventTemplateReminders.message,

        channelId: eventTemplateReminders.channelId,

        pingEventRoles: eventTemplateReminders.pingEventRoles,
      })
      .from(eventTemplateReminders)
      .where(eq(eventTemplateReminders.templateId, template.id))
      .orderBy(asc(eventTemplateReminders.id));

    const existingReminders: EventTemplateReminderDefinition[] =
      existingRows.map(eventTemplateReminderFromRow);

    if (eventTemplateRemindersMatch(existingReminders, normalisedReminders)) {
      return {
        kind: "unchanged",

        reminders: existingReminders,
      } as const;
    }

    await transaction
      .delete(eventTemplateReminders)
      .where(eq(eventTemplateReminders.templateId, template.id));

    if (normalisedReminders.length > 0) {
      await transaction.insert(eventTemplateReminders).values(
        normalisedReminders.map((reminder) => ({
          templateId: template.id,

          timingReference: reminder.timingReference,

          minutesBefore: reminder.minutesBefore,

          message: reminder.message,

          channelId: reminder.channelId,

          pingEventRoles: reminder.pingEventRoles,
        })),
      );
    }

    const persistedRows = await transaction
      .select({
        id: eventTemplateReminders.id,

        timingReference: eventTemplateReminders.timingReference,

        minutesBefore: eventTemplateReminders.minutesBefore,

        message: eventTemplateReminders.message,

        channelId: eventTemplateReminders.channelId,

        pingEventRoles: eventTemplateReminders.pingEventRoles,
      })
      .from(eventTemplateReminders)
      .where(eq(eventTemplateReminders.templateId, template.id))
      .orderBy(asc(eventTemplateReminders.id));

    const persistedReminders: EventTemplateReminderDefinition[] =
      persistedRows.map(eventTemplateReminderFromRow);

    await transaction
      .update(eventTemplates)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(eventTemplates.id, template.id));

    return {
      kind: "updated",

      reminders: persistedReminders,
    } as const;
  });
}

/**
 * Lists every reusable template owned by one guild.
 *
 * Inactive templates remain visible because lifecycle state is reversible
 * administration, not deletion.
 */
export async function listEventTemplates(
  guildDatabaseId: number,
): Promise<EventTemplateSummary[]> {
  return db
    .select({
      id: eventTemplates.id,

      name: eventTemplates.name,

      eventTypeId: eventTemplates.eventTypeId,

      audienceId: eventTemplates.audienceId,

      roleRequestPresetId: eventTemplates.roleRequestPresetId,

      timezone: eventTemplates.timezone,

      localStartTime: eventTemplates.localStartTime,

      active: eventTemplates.active,

      updatedAt: eventTemplates.updatedAt,
    })
    .from(eventTemplates)
    .where(eq(eventTemplates.ownerGuildId, guildDatabaseId))
    .orderBy(
      asc(eventTemplates.name),

      asc(eventTemplates.id),
    );
}

/**
 * Reads one complete reusable template source graph.
 *
 * The parent FOR SHARE lock pairs with the FOR UPDATE mutation contract used
 * by core and child editing services, so inspection observes one coherent
 * source graph.
 */
export async function getEventTemplate(
  input: GetEventTemplateInput,
): Promise<GetEventTemplateResult> {
  return db.transaction(async (transaction) => {
    const [template] = await transaction
      .select(eventTemplateSelection)
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("share");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const pingRoles = await transaction
      .select({
        discordRoleId: eventTemplatePingRoles.discordRoleId,

        roleNameSnapshot: eventTemplatePingRoles.roleNameSnapshot,

        sortOrder: eventTemplatePingRoles.sortOrder,
      })
      .from(eventTemplatePingRoles)
      .where(eq(eventTemplatePingRoles.templateId, template.id))
      .orderBy(
        asc(eventTemplatePingRoles.sortOrder),

        asc(eventTemplatePingRoles.discordRoleId),
      );

    const organiserDefaultRows = await transaction
      .select({
        slot: eventTemplateOrganiserDefaults.slot,

        discordUserId: eventTemplateOrganiserDefaults.discordUserId,

        displayNameSnapshot: eventTemplateOrganiserDefaults.displayNameSnapshot,
      })
      .from(eventTemplateOrganiserDefaults)
      .where(eq(eventTemplateOrganiserDefaults.templateId, template.id));

    const organiserDefaults: EventTemplateOrganiserDefault[] =
      organiserDefaultRows.map((organiser) => ({
        slot: requireEventTemplateOrganiserSlot(organiser.slot),

        discordUserId: organiser.discordUserId,

        displayNameSnapshot: organiser.displayNameSnapshot,
      }));

    organiserDefaults.sort(
      (left, right) =>
        organiserSlotOrder(left.slot) - organiserSlotOrder(right.slot) ||
        left.discordUserId.localeCompare(right.discordUserId),
    );

    const reminderRows = await transaction
      .select({
        id: eventTemplateReminders.id,

        timingReference: eventTemplateReminders.timingReference,

        minutesBefore: eventTemplateReminders.minutesBefore,

        message: eventTemplateReminders.message,

        channelId: eventTemplateReminders.channelId,

        pingEventRoles: eventTemplateReminders.pingEventRoles,
      })
      .from(eventTemplateReminders)
      .where(eq(eventTemplateReminders.templateId, template.id))
      .orderBy(asc(eventTemplateReminders.id));

    const reminders: EventTemplateReminderDefinition[] = reminderRows.map(
      eventTemplateReminderFromRow,
    );

    return {
      kind: "found",

      template: {
        ...template,

        pingRoles,

        organiserDefaults,

        reminders,
      },
    } as const;
  });
}

/**
 * Activates or deactivates one reusable template.
 *
 * Generation takes FOR SHARE on the same parent row. Lifecycle mutation takes
 * FOR UPDATE so an in-flight generation sees either the complete active state
 * before this change or the complete inactive state after it.
 *
 * Existing generated events are independent and are never rewritten here.
 */
export async function setEventTemplateActive(
  input: SetEventTemplateActiveInput,
): Promise<SetEventTemplateActiveResult> {
  return db.transaction(async (transaction) => {
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        name: eventTemplates.name,

        active: eventTemplates.active,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    if (template.active === input.active) {
      return {
        kind: "unchanged",

        template,
      } as const;
    }

    const [updatedTemplate] = await transaction
      .update(eventTemplates)
      .set({
        active: input.active,

        updatedAt: new Date(),
      })
      .where(eq(eventTemplates.id, template.id))
      .returning({
        id: eventTemplates.id,

        name: eventTemplates.name,

        active: eventTemplates.active,
      });

    if (!updatedTemplate) {
      throw new Error(
        `Event template #${template.id} disappeared while its lifecycle state was being changed.`,
      );
    }

    return {
      kind: "updated",

      template: updatedTemplate,
    } as const;
  });
}

type EventTemplateConfigurationInput = {
  name: string;

  description: string | null;

  timezone: string;

  localStartTime: string | null;

  durationMinutes: number;

  signupsEnabled: boolean;

  attendanceCloseMinutesBefore: number;

  showDetailedDeadline: boolean;

  publicationMode: string;

  publishMinutesBeforeStart: number | null;

  publicationChannelId: string | null;
};

type NormalisedEventTemplateConfiguration = Omit<
  EventTemplateConfigurationInput,
  "publicationMode"
> & {
  publicationMode: EventTemplatePublicationMode;
};

type NormaliseEventTemplateConfigurationResult =
  | {
      ok: true;

      configuration: NormalisedEventTemplateConfiguration;
    }
  | {
      ok: false;

      reason: EventTemplateConfigurationInvalidReason;
    };

function normaliseEventTemplateConfiguration(
  input: EventTemplateConfigurationInput,
): NormaliseEventTemplateConfigurationResult {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 150) {
    return {
      ok: false,

      reason: "invalid_name",
    };
  }

  const timezone = input.timezone.trim();

  if (
    timezone.length === 0 ||
    timezone.length > 64 ||
    !isValidEventTimezone(timezone)
  ) {
    return {
      ok: false,

      reason: "invalid_timezone",
    };
  }

  const localStartTime =
    input.localStartTime === null ? null : input.localStartTime.trim();

  if (localStartTime !== null && !isValidLocalStartTime(localStartTime)) {
    return {
      ok: false,

      reason: "invalid_local_start_time",
    };
  }

  if (!isPostgresPositiveInteger(input.durationMinutes)) {
    return {
      ok: false,

      reason: "invalid_duration",
    };
  }

  if (!isPostgresNonNegativeInteger(input.attendanceCloseMinutesBefore)) {
    return {
      ok: false,

      reason: "invalid_attendance_close_offset",
    };
  }

  if (!isTemplatePublicationMode(input.publicationMode)) {
    return {
      ok: false,

      reason: "invalid_publication_mode",
    };
  }

  const publicationMode = input.publicationMode;

  if (
    publicationMode === "scheduled" &&
    (input.publishMinutesBeforeStart === null ||
      !isPostgresPositiveInteger(input.publishMinutesBeforeStart))
  ) {
    return {
      ok: false,

      reason: "invalid_publication_offset",
    };
  }

  if (
    publicationMode !== "scheduled" &&
    input.publishMinutesBeforeStart !== null
  ) {
    return {
      ok: false,

      reason: "invalid_publication_offset",
    };
  }

  if (
    input.signupsEnabled &&
    publicationMode === "scheduled" &&
    input.publishMinutesBeforeStart !== null &&
    input.publishMinutesBeforeStart <= input.attendanceCloseMinutesBefore
  ) {
    return {
      ok: false,

      reason: "publication_not_before_signup_close",
    };
  }

  let publicationChannelId: string | null = null;

  if (input.publicationChannelId !== null) {
    publicationChannelId = input.publicationChannelId.trim();

    if (publicationChannelId.length === 0) {
      return {
        ok: false,

        reason: "invalid_publication_channel",
      };
    }
  }

  return {
    ok: true,

    configuration: {
      name,

      description: normaliseOptionalText(input.description),

      timezone,

      localStartTime,

      durationMinutes: input.durationMinutes,

      signupsEnabled: input.signupsEnabled,

      attendanceCloseMinutesBefore: input.attendanceCloseMinutesBefore,

      showDetailedDeadline: input.showDetailedDeadline,

      publicationMode,

      publishMinutesBeforeStart: input.publishMinutesBeforeStart,

      publicationChannelId,
    },
  };
}

function eventTemplateConfigurationMatches(
  template: EventTemplateRecord,
  configuration: NormalisedEventTemplateConfiguration,
  eventTypeId: number,
  audienceId: number | null,
  roleRequestPresetId: number | null,
): boolean {
  return (
    template.eventTypeId === eventTypeId &&
    template.audienceId === audienceId &&
    template.roleRequestPresetId === roleRequestPresetId &&
    template.name === configuration.name &&
    template.description === configuration.description &&
    template.timezone === configuration.timezone &&
    template.localStartTime === configuration.localStartTime &&
    template.durationMinutes === configuration.durationMinutes &&
    template.signupsEnabled === configuration.signupsEnabled &&
    template.attendanceCloseMinutesBefore ===
      configuration.attendanceCloseMinutesBefore &&
    template.showDetailedDeadline === configuration.showDetailedDeadline &&
    template.publicationMode === configuration.publicationMode &&
    template.publishMinutesBeforeStart ===
      configuration.publishMinutesBeforeStart &&
    template.publicationChannelId === configuration.publicationChannelId
  );
}

type NormalisedEventTemplateReminder = Omit<
  EventTemplateReminderDefinition,
  "id"
>;

function eventTemplateReminderFromRow(reminder: {
  id: number;

  timingReference: string;

  minutesBefore: number;

  message: string;

  channelId: string | null;

  pingEventRoles: boolean;
}): EventTemplateReminderDefinition {
  return {
    id: reminder.id,

    timingReference: requireEventTemplateReminderTimingReference(
      reminder.timingReference,
    ),

    minutesBefore: reminder.minutesBefore,

    message: reminder.message,

    channelId: reminder.channelId,

    pingEventRoles: reminder.pingEventRoles,
  };
}

function eventTemplateRemindersMatch(
  existing: EventTemplateReminderDefinition[],
  intended: NormalisedEventTemplateReminder[],
): boolean {
  if (existing.length !== intended.length) {
    return false;
  }

  const existingCanonical = existing
    .map(
      (reminder): NormalisedEventTemplateReminder => ({
        timingReference: reminder.timingReference,

        minutesBefore: reminder.minutesBefore,

        message: reminder.message,

        channelId: reminder.channelId,

        pingEventRoles: reminder.pingEventRoles,
      }),
    )
    .sort(compareEventTemplateReminders);

  const intendedCanonical = [...intended].sort(compareEventTemplateReminders);

  return existingCanonical.every((reminder, index) => {
    const other = intendedCanonical[index];

    return (
      other !== undefined &&
      reminder.timingReference === other.timingReference &&
      reminder.minutesBefore === other.minutesBefore &&
      reminder.message === other.message &&
      reminder.channelId === other.channelId &&
      reminder.pingEventRoles === other.pingEventRoles
    );
  });
}

function compareEventTemplateReminders(
  left: NormalisedEventTemplateReminder,
  right: NormalisedEventTemplateReminder,
): number {
  const timingDifference =
    eventTemplateReminderTimingOrder(left.timingReference) -
    eventTemplateReminderTimingOrder(right.timingReference);

  if (timingDifference !== 0) {
    return timingDifference;
  }

  if (left.minutesBefore !== right.minutesBefore) {
    return left.minutesBefore - right.minutesBefore;
  }

  const channelDifference = (left.channelId ?? "").localeCompare(
    right.channelId ?? "",
  );

  if (channelDifference !== 0) {
    return channelDifference;
  }

  const messageDifference = left.message.localeCompare(right.message);

  if (messageDifference !== 0) {
    return messageDifference;
  }

  return Number(left.pingEventRoles) - Number(right.pingEventRoles);
}

function eventTemplateReminderTimingOrder(
  value: ReminderTimingReference,
): number {
  switch (value) {
    case "event_start":
      return 0;

    case "signup_close":
      return 1;
  }
}

function isEventTemplateReminderTimingReference(
  value: string,
): value is ReminderTimingReference {
  return value === "event_start" || value === "signup_close";
}

function requireEventTemplateReminderTimingReference(
  value: string,
): ReminderTimingReference {
  if (isEventTemplateReminderTimingReference(value)) {
    return value;
  }

  throw new Error(
    `Unsupported event-template reminder timing reference "${value}".`,
  );
}

function isTemplatePublicationMode(
  value: string,
): value is EventTemplatePublicationMode {
  return value === "manual" || value === "scheduled" || value === "immediate";
}

function eventTemplatePingRolesMatch(
  left: EventTemplatePingRole[],
  right: EventTemplatePingRole[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((role, index) => {
    const other = right[index];

    return (
      other !== undefined &&
      role.discordRoleId === other.discordRoleId &&
      role.roleNameSnapshot === other.roleNameSnapshot &&
      role.sortOrder === other.sortOrder
    );
  });
}

function eventTemplateOrganiserDefaultsMatch(
  left: EventTemplateOrganiserDefault[],
  right: EventTemplateOrganiserDefault[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((organiser, index) => {
    const other = right[index];

    return (
      other !== undefined &&
      organiser.slot === other.slot &&
      organiser.discordUserId === other.discordUserId &&
      organiser.displayNameSnapshot === other.displayNameSnapshot
    );
  });
}

function isEventTemplateOrganiserSlot(
  value: string,
): value is EventTemplateOrganiserSlot {
  return value === "primary" || value === "backup";
}

function requireEventTemplateOrganiserSlot(
  value: string,
): EventTemplateOrganiserSlot {
  if (isEventTemplateOrganiserSlot(value)) {
    return value;
  }

  throw new Error(`Unsupported event-template organiser slot "${value}".`);
}

function isValidLocalStartTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isPostgresPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function isPostgresNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function normaliseOptionalText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
}

function organiserSlotOrder(slot: string): number {
  switch (slot) {
    case "primary":
      return 0;

    case "backup":
      return 1;

    default:
      return 2;
  }
}
