import { and, asc, eq } from "drizzle-orm";

import { db, type DatabaseTransaction } from "../db/client.js";
import {
  eventAudiences,
  eventTemplateOrganiserDefaults,
  eventTemplatePingRoles,
  eventTemplateReminders,
  eventTemplates,
  eventTypes,
  guildSettings,
} from "../db/schema.js";
import {
  createStoredEventInTransaction,
  type CreateStoredEventResult,
} from "../events/event-creation-service.js";
import { createEventReminderInTransaction } from "../reminders/reminder-creation-service.js";
import {
  calculateReminderDueAt,
  type ReminderTimingReference,
} from "../reminders/reminder-scheduling.js";
import {
  applyRoleRequestPresetToEventInTransaction,
  type ApplyRoleRequestPresetResult,
} from "../role-requests/role-request-preset-service.js";
import { isValidEventTimezone } from "../time/timezones.js";

type TemplatePublicationMode = "manual" | "scheduled" | "immediate";

type CreatedStoredEvent = Extract<
  CreateStoredEventResult,
  {
    kind: "created";
  }
>["event"];

type PresetApplicationFailure = Exclude<
  ApplyRoleRequestPresetResult,
  {
    kind: "applied";
  }
>;

export type InvalidEventTemplateReason =
  | "invalid_timezone"
  | "invalid_duration"
  | "invalid_attendance_close_offset"
  | "invalid_publication_mode"
  | "invalid_publication_offset"
  | "publication_not_before_signup_close"
  | "backup_without_primary"
  | "invalid_organiser_slot"
  | "invalid_reminder_timing_reference"
  | "signup_close_reminder_without_signups"
  | "empty_reminder_message";

export type InvalidTemplateOccurrenceReason =
  | "invalid_start"
  | "start_not_future"
  | "signup_close_not_future";

export type GenerateEventFromTemplateInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * The calling command or future recurrence service resolves the occurrence's
   * local date/time into an absolute instant before entering this persistence
   * boundary.
   */
  startsAt: Date;

  /*
   * Optional optimistic source revision.
   *
   * Discord generation first reads the template to resolve its local
   * occurrence date/time. Passing that inspected revision prevents a
   * concurrent template edit from changing the source between that read and
   * this transaction's FOR SHARE lock.
   */
  expectedTemplateUpdatedAt?: Date;

  generatedByUserId: string;
};

export type GenerateEventFromTemplateResult =
  | {
      kind: "generated";

      templateId: number;

      event: CreatedStoredEvent;

      publicationMode: TemplatePublicationMode;

      /*
       * Immediate publication is deliberately post-commit because Discord
       * posting is an external side effect.
       *
       * A future adapter must call the normal publication service after this
       * generation transaction has committed.
       */
      requiresImmediatePublication: boolean;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "template_inactive";
    }
  | {
      kind: "template_changed";
    }
  | {
      kind: "guild_not_configured";
    }
  | {
      kind: "event_type_unavailable";
    }
  | {
      kind: "audience_unavailable";
    }
  | {
      kind: "missing_publication_channel";
    }
  | {
      kind: "invalid_template";

      reason: InvalidEventTemplateReason;

      reminderId?: number;
    }
  | {
      kind: "invalid_occurrence";

      reason: InvalidTemplateOccurrenceReason;
    }
  | {
      kind: "preset_application_failed";

      result: PresetApplicationFailure;
    };

class PresetApplicationAbortError extends Error {
  public readonly result: PresetApplicationFailure;

  public constructor(result: PresetApplicationFailure) {
    super(
      `Template generation could not apply the configured role-request preset: ${result.kind}.`,
    );

    this.name = "PresetApplicationAbortError";

    this.result = result;
  }
}

/**
 * Generates one ordinary persistent event from the template's current source
 * configuration.
 *
 * All authoritative PostgreSQL state is created inside one transaction.
 * Discord publication is deliberately excluded and must happen after commit.
 */
export async function generateEventFromTemplate(
  input: GenerateEventFromTemplateInput,
): Promise<GenerateEventFromTemplateResult> {
  try {
    return await db.transaction((transaction) =>
      generateEventFromTemplateInTransaction(transaction, input),
    );
  } catch (error) {
    /*
     * Preset application can return a normal domain failure after event,
     * reminder and other snapshot state has already been created inside this
     * transaction.
     *
     * Throwing the internal abort signal is therefore intentional: PostgreSQL
     * must roll the entire generated event back before we convert the failure
     * into a normal generation result.
     */
    if (error instanceof PresetApplicationAbortError) {
      return {
        kind: "preset_application_failed",

        result: error.result,
      };
    }

    throw error;
  }
}

async function generateEventFromTemplateInTransaction(
  transaction: DatabaseTransaction,
  input: GenerateEventFromTemplateInput,
): Promise<GenerateEventFromTemplateResult> {
  /*
   * Template mutation services must take FOR UPDATE on this parent row.
   *
   * FOR SHARE therefore gives generation a stable source aggregate while
   * allowing concurrent readers where safe.
   */
  const [template] = await transaction
    .select({
      id: eventTemplates.id,

      eventTypeId: eventTemplates.eventTypeId,

      audienceId: eventTemplates.audienceId,

      roleRequestPresetId: eventTemplates.roleRequestPresetId,

      name: eventTemplates.name,

      description: eventTemplates.description,

      timezone: eventTemplates.timezone,

      durationMinutes: eventTemplates.durationMinutes,

      signupsEnabled: eventTemplates.signupsEnabled,

      attendanceCloseMinutesBefore: eventTemplates.attendanceCloseMinutesBefore,

      showDetailedDeadline: eventTemplates.showDetailedDeadline,

      publicationMode: eventTemplates.publicationMode,

      publishMinutesBeforeStart: eventTemplates.publishMinutesBeforeStart,

      publicationChannelId: eventTemplates.publicationChannelId,

      active: eventTemplates.active,

      updatedAt: eventTemplates.updatedAt,
    })
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
    };
  }

  if (
    input.expectedTemplateUpdatedAt &&
    template.updatedAt.getTime() !== input.expectedTemplateUpdatedAt.getTime()
  ) {
    return {
      kind: "template_changed",
    };
  }

  if (!template.active) {
    return {
      kind: "template_inactive",
    };
  }

  /*
   * Validate the occurrence itself before doing any generated-event writes.
   */
  if (!Number.isFinite(input.startsAt.getTime())) {
    return {
      kind: "invalid_occurrence",

      reason: "invalid_start",
    };
  }

  const now = new Date();

  if (input.startsAt.getTime() <= now.getTime()) {
    return {
      kind: "invalid_occurrence",

      reason: "start_not_future",
    };
  }

  /*
   * Event type and audience are reusable guild-owned source records.
   *
   * Shared locks prevent a concurrent deactivate/update from changing source
   * validity halfway through this generation snapshot.
   */
  const [eventType] = await transaction
    .select({
      id: eventTypes.id,
    })
    .from(eventTypes)
    .where(
      and(
        eq(eventTypes.id, template.eventTypeId),

        eq(eventTypes.ownerGuildId, input.guildDatabaseId),

        eq(eventTypes.active, true),
      ),
    )
    .limit(1)
    .for("share");

  if (!eventType) {
    return {
      kind: "event_type_unavailable",
    };
  }

  if (template.audienceId !== null) {
    const [audience] = await transaction
      .select({
        id: eventAudiences.id,
      })
      .from(eventAudiences)
      .where(
        and(
          eq(eventAudiences.id, template.audienceId),

          eq(eventAudiences.ownerGuildId, input.guildDatabaseId),

          eq(eventAudiences.active, true),
        ),
      )
      .limit(1)
      .for("share");

    if (!audience) {
      return {
        kind: "audience_unavailable",
      };
    }
  }

  if (!isValidEventTimezone(template.timezone)) {
    return {
      kind: "invalid_template",

      reason: "invalid_timezone",
    };
  }

  if (template.durationMinutes <= 0) {
    return {
      kind: "invalid_template",

      reason: "invalid_duration",
    };
  }

  if (template.attendanceCloseMinutesBefore < 0) {
    return {
      kind: "invalid_template",

      reason: "invalid_attendance_close_offset",
    };
  }

  if (!isTemplatePublicationMode(template.publicationMode)) {
    return {
      kind: "invalid_template",

      reason: "invalid_publication_mode",
    };
  }

  if (
    template.publicationMode === "scheduled" &&
    (template.publishMinutesBeforeStart === null ||
      template.publishMinutesBeforeStart <= 0)
  ) {
    return {
      kind: "invalid_template",

      reason: "invalid_publication_offset",
    };
  }

  if (
    template.publicationMode !== "scheduled" &&
    template.publishMinutesBeforeStart !== null
  ) {
    return {
      kind: "invalid_template",

      reason: "invalid_publication_offset",
    };
  }

  const endsAt = addMinutes(input.startsAt, template.durationMinutes);

  const attendanceClosesAt = template.signupsEnabled
    ? subtractMinutes(
        input.startsAt,

        template.attendanceCloseMinutesBefore,
      )
    : null;

  if (
    attendanceClosesAt !== null &&
    attendanceClosesAt.getTime() <= now.getTime()
  ) {
    return {
      kind: "invalid_occurrence",

      reason: "signup_close_not_future",
    };
  }

  const scheduledPublicationAt =
    template.publicationMode === "scheduled" &&
    template.publishMinutesBeforeStart !== null
      ? subtractMinutes(
          input.startsAt,

          template.publishMinutesBeforeStart,
        )
      : null;

  /*
   * Signup events cannot be scheduled to become public after signups have
   * already closed.
   *
   * A scheduled publication time which is already due is otherwise allowed.
   * Durable scheduler recovery can claim that action immediately, provided the
   * signup deadline itself is still usable.
   */
  if (
    scheduledPublicationAt !== null &&
    attendanceClosesAt !== null &&
    scheduledPublicationAt.getTime() >= attendanceClosesAt.getTime()
  ) {
    return {
      kind: "invalid_template",

      reason: "publication_not_before_signup_close",
    };
  }

  /*
   * Resolve current guild defaults under a shared lock. The resolved
   * publication destination is snapshotted into the generated event and is
   * independent of later /setup changes.
   *
   * organisersEnabled is read under this same stable source snapshot.
   */
  const [settings] = await transaction
    .select({
      organisersEnabled: guildSettings.organisersEnabled,

      defaultAttendanceChannelId: guildSettings.defaultAttendanceChannelId,
    })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, input.guildDatabaseId))
    .limit(1)
    .for("share");

  if (!settings) {
    return {
      kind: "guild_not_configured",
    };
  }

  const publicationChannelId =
    template.publicationChannelId ?? settings.defaultAttendanceChannelId;

  if (publicationChannelId === null) {
    return {
      kind: "missing_publication_channel",
    };
  }

  /*
   * Child mutation must participate in the template-parent FOR UPDATE
   * contract. The parent FOR SHARE above therefore protects these reads as one
   * stable source graph.
   */
  const templatePingRoles = await transaction
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

  const reminderDefinitions = await transaction
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

  const invalidOrganiserSlot = organiserDefaults.find(
    (organiser) => organiser.slot !== "primary" && organiser.slot !== "backup",
  );

  if (invalidOrganiserSlot) {
    return {
      kind: "invalid_template",

      reason: "invalid_organiser_slot",
    };
  }

  const primaryOrganiser = organiserDefaults.find(
    (organiser) => organiser.slot === "primary",
  );

  const backupOrganiser = organiserDefaults.find(
    (organiser) => organiser.slot === "backup",
  );

  if (backupOrganiser && !primaryOrganiser) {
    return {
      kind: "invalid_template",

      reason: "backup_without_primary",
    };
  }

  const resolvedReminders: {
    timingReference: ReminderTimingReference;

    minutesBefore: number;

    message: string;

    channelId: string;

    pingEventRoles: boolean;

    dueAt: Date;
  }[] = [];

  for (const reminder of reminderDefinitions) {
    if (!isReminderTimingReference(reminder.timingReference)) {
      return {
        kind: "invalid_template",

        reason: "invalid_reminder_timing_reference",

        reminderId: reminder.id,
      };
    }

    if (!reminder.message.trim()) {
      return {
        kind: "invalid_template",

        reason: "empty_reminder_message",

        reminderId: reminder.id,
      };
    }

    if (
      reminder.timingReference === "signup_close" &&
      !template.signupsEnabled
    ) {
      return {
        kind: "invalid_template",

        reason: "signup_close_reminder_without_signups",

        reminderId: reminder.id,
      };
    }

    const dueAt = calculateReminderDueAt(
      reminder.timingReference,

      reminder.minutesBefore,

      {
        startsAt: input.startsAt,

        attendanceClosesAt,
      },
    );

    if (dueAt === null) {
      return {
        kind: "invalid_template",

        reason: "signup_close_reminder_without_signups",

        reminderId: reminder.id,
      };
    }

    resolvedReminders.push({
      timingReference: reminder.timingReference,

      minutesBefore: reminder.minutesBefore,

      message: reminder.message,

      channelId: reminder.channelId ?? publicationChannelId,

      pingEventRoles: reminder.pingEventRoles,

      dueAt,
    });
  }

  /*
   * Organiser defaults are optional source configuration.
   *
   * If the guild has disabled the organiser subsystem, deliberately omit these
   * snapshots rather than allowing that optional feature to block generation.
   */
  const shouldSnapshotOrganisers = settings.organisersEnabled;

  const createdEvent = await createStoredEventInTransaction(
    transaction,

    {
      guildDatabaseId: input.guildDatabaseId,

      templateId: template.id,

      eventTypeId: template.eventTypeId,

      audienceId: template.audienceId,

      timezone: template.timezone,

      showDetailedDeadline:
        template.signupsEnabled && template.showDetailedDeadline,

      name: template.name,

      description: template.description,

      startsAt: input.startsAt,

      endsAt,

      signupsEnabled: template.signupsEnabled,

      attendanceClosesAt,

      publishMinutesBeforeStart:
        template.publicationMode === "scheduled"
          ? template.publishMinutesBeforeStart
          : null,

      publicationChannelId,

      scheduledPublicationAt,

      createdByUserId: input.generatedByUserId,

      pingRoles: templatePingRoles.map((role) => ({
        discordRoleId: role.discordRoleId,

        roleName: role.roleNameSnapshot,
      })),

      primaryOrganiser:
        shouldSnapshotOrganisers && primaryOrganiser
          ? {
              discordUserId: primaryOrganiser.discordUserId,

              displayNameSnapshot: primaryOrganiser.displayNameSnapshot,
            }
          : null,

      backupOrganiser:
        shouldSnapshotOrganisers && backupOrganiser
          ? {
              discordUserId: backupOrganiser.discordUserId,

              displayNameSnapshot: backupOrganiser.displayNameSnapshot,
            }
          : null,
    },
  );

  if (createdEvent.kind !== "created") {
    /*
     * We hold guild_settings FOR SHARE and deliberately omit organiser
     * snapshots when the feature is disabled, so this should be unreachable.
     */
    throw new Error(
      "Template generation unexpectedly failed the organiser feature check.",
    );
  }

  for (const reminder of resolvedReminders) {
    await createEventReminderInTransaction(
      transaction,

      {
        eventId: createdEvent.event.id,

        timingReference: reminder.timingReference,

        minutesBefore: reminder.minutesBefore,

        message: reminder.message,

        channelId: reminder.channelId,

        pingEventRoles: reminder.pingEventRoles,

        createdByUserId: input.generatedByUserId,

        dueAt: reminder.dueAt,
      },
    );
  }

  if (template.roleRequestPresetId !== null) {
    const presetResult = await applyRoleRequestPresetToEventInTransaction(
      transaction,

      {
        guildDatabaseId: input.guildDatabaseId,

        eventId: createdEvent.event.id,

        presetId: template.roleRequestPresetId,

        appliedByUserId: input.generatedByUserId,
      },
    );

    if (presetResult.kind !== "applied") {
      /*
       * Returning here would commit the event and any reminder snapshots
       * already created above.
       *
       * Throw instead so the surrounding transaction rolls everything back.
       * The public wrapper converts this into a normal domain result only
       * after rollback.
       */
      throw new PresetApplicationAbortError(presetResult);
    }
  }

  return {
    kind: "generated",

    templateId: template.id,

    event: createdEvent.event,

    publicationMode: template.publicationMode,

    requiresImmediatePublication: template.publicationMode === "immediate",
  };
}

function isTemplatePublicationMode(
  value: string,
): value is TemplatePublicationMode {
  return value === "manual" || value === "scheduled" || value === "immediate";
}

function isReminderTimingReference(
  value: string,
): value is ReminderTimingReference {
  return value === "event_start" || value === "signup_close";
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function subtractMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() - minutes * 60_000);
}
