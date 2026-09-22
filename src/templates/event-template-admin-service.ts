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

export type EventTemplateDetail = EventTemplateRecord & {
  pingRoles: {
    discordRoleId: string;

    roleNameSnapshot: string;

    sortOrder: number;
  }[];

  organiserDefaults: {
    slot: string;

    discordUserId: string;

    displayNameSnapshot: string;
  }[];

  reminders: {
    id: number;

    timingReference: string;

    minutesBefore: number;

    message: string;

    channelId: string | null;

    pingEventRoles: boolean;
  }[];
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
        | "invalid_name"
        | "invalid_timezone"
        | "invalid_local_start_time"
        | "invalid_duration"
        | "invalid_attendance_close_offset"
        | "invalid_publication_mode"
        | "invalid_publication_offset"
        | "publication_not_before_signup_close"
        | "invalid_publication_channel"
        | "preset_requires_role_requests";
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
 * Child collections remain separate authoritative mutations. This keeps
 * template creation usable before ping-role, organiser and reminder editing
 * services are introduced.
 */
export async function createEventTemplate(
  input: CreateEventTemplateInput,
): Promise<CreateEventTemplateResult> {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 150) {
    return {
      kind: "invalid_input",

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
      kind: "invalid_input",

      reason: "invalid_timezone",
    };
  }

  const localStartTime =
    input.localStartTime === null ? null : input.localStartTime.trim();

  if (localStartTime !== null && !isValidLocalStartTime(localStartTime)) {
    return {
      kind: "invalid_input",

      reason: "invalid_local_start_time",
    };
  }

  if (!isPostgresPositiveInteger(input.durationMinutes)) {
    return {
      kind: "invalid_input",

      reason: "invalid_duration",
    };
  }

  if (!isPostgresNonNegativeInteger(input.attendanceCloseMinutesBefore)) {
    return {
      kind: "invalid_input",

      reason: "invalid_attendance_close_offset",
    };
  }

  if (!isTemplatePublicationMode(input.publicationMode)) {
    return {
      kind: "invalid_input",

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
      kind: "invalid_input",

      reason: "invalid_publication_offset",
    };
  }

  if (
    publicationMode !== "scheduled" &&
    input.publishMinutesBeforeStart !== null
  ) {
    return {
      kind: "invalid_input",

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
      kind: "invalid_input",

      reason: "publication_not_before_signup_close",
    };
  }

  let publicationChannelId: string | null = null;

  if (input.publicationChannelId !== null) {
    publicationChannelId = input.publicationChannelId.trim();

    if (publicationChannelId.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_publication_channel",
      };
    }
  }

  const description = normaliseOptionalText(input.description);

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

        name,

        description,

        timezone,

        localStartTime,

        durationMinutes: input.durationMinutes,

        signupsEnabled: input.signupsEnabled,

        attendanceCloseMinutesBefore: input.attendanceCloseMinutesBefore,

        showDetailedDeadline: input.showDetailedDeadline,

        publicationMode,

        publishMinutesBeforeStart: input.publishMinutesBeforeStart,

        publicationChannelId,

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
 * The parent FOR SHARE lock pairs with the FOR UPDATE mutation contract.
 * Future child editing services must lock this parent before changing child
 * rows, so inspection observes one coherent source graph.
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

    const organiserDefaults = await transaction
      .select({
        slot: eventTemplateOrganiserDefaults.slot,

        discordUserId: eventTemplateOrganiserDefaults.discordUserId,

        displayNameSnapshot: eventTemplateOrganiserDefaults.displayNameSnapshot,
      })
      .from(eventTemplateOrganiserDefaults)
      .where(eq(eventTemplateOrganiserDefaults.templateId, template.id));

    organiserDefaults.sort(
      (left, right) =>
        organiserSlotOrder(left.slot) - organiserSlotOrder(right.slot) ||
        left.discordUserId.localeCompare(right.discordUserId),
    );

    const reminders = await transaction
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

function isTemplatePublicationMode(
  value: string,
): value is EventTemplatePublicationMode {
  return value === "manual" || value === "scheduled" || value === "immediate";
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
